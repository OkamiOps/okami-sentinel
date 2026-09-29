import type { EmailErrorCode, EmailProviderKind, EmailSmtpSecurity } from "@csb/shared";
import { redactText } from "../redaction.js";

/** One rendered message, ready to hand to a provider. */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * The outbox row id. Resend receives it as `Idempotency-Key`, and SMTP as the
   * `Message-ID`, so a retry of the same row can never become a second e-mail.
   */
  idempotencyKey: string;
}

export interface EmailSendResult {
  /** The provider's own id when it returns one; SMTP relays often do not. */
  providerMessageId: string | null;
}

/**
 * The only thing the outbox worker, the test button and the account e-mails know
 * about a provider. Both implementations are bounded by a timeout and translate
 * every failure into an `EmailTransportError`.
 */
export interface EmailTransport {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/** How a failure is described in the history and to the administrator. */
export interface EmailFailure {
  code: EmailErrorCode;
  /** Short, already redacted, safe to store and to show. */
  message: string;
  /** False when the same message with the same configuration could still work. */
  permanent: boolean;
}

export class EmailTransportError extends Error implements EmailFailure {
  readonly code: EmailErrorCode;
  readonly permanent: boolean;

  constructor(failure: EmailFailure) {
    super(failure.message);
    this.name = "EmailTransportError";
    this.code = failure.code;
    this.permanent = failure.permanent;
  }
}

/**
 * Whether retrying could ever help. A permanent failure still counts as an
 * attempt in the outbox, so this only decides whether the worker schedules
 * another one.
 */
const PERMANENT: Readonly<Record<EmailErrorCode, boolean>> = Object.freeze({
  not_configured: true,
  auth_rejected: true,
  tls_failed: true,
  sender_not_verified: true,
  recipient_rejected: true,
  message_rejected: true,
  connection_refused: false,
  connection_timeout: false,
  rate_limited: false,
  provider_unavailable: false,
});

const SUMMARY: Readonly<Record<EmailErrorCode, string>> = Object.freeze({
  not_configured: "E-mail is not configured: pick a provider, a sender address and a secret first.",
  auth_rejected: "The provider rejected the credentials.",
  tls_failed: "The secure connection could not be established; check the port and the security mode.",
  connection_refused: "The connection was refused; check the host and the port.",
  connection_timeout: "The provider did not answer in time.",
  sender_not_verified: "The provider does not accept this sender address yet.",
  recipient_rejected: "The provider rejected the recipient address.",
  message_rejected: "The provider rejected the message.",
  rate_limited: "The provider is rate limiting these sends.",
  provider_unavailable: "The provider is unavailable.",
});

/**
 * Builds the one sentence the history stores. The provider's own words are
 * appended when there are any, trimmed to a single short line and pushed
 * through the global redactor, because an SMTP greeting or a JSON error can
 * quote back the username and, on some relays, the credential itself.
 */
export function emailFailure(
  code: EmailErrorCode,
  detail?: string | null,
  /**
   * Overrides the verdict the code implies. A provider can name a permanent-
   * sounding cause and still be saying "not now" — an SMTP 4xx reply does exactly
   * that — and the transport, which saw the reply, knows better than this table.
   */
  permanent?: boolean,
): EmailFailure {
  const cleaned = cleanDetail(detail);
  return {
    code,
    message: cleaned ? `${SUMMARY[code]} (${cleaned})` : SUMMARY[code],
    permanent: permanent ?? PERMANENT[code],
  };
}

export function emailTransportError(code: EmailErrorCode, detail?: string | null): EmailTransportError {
  return new EmailTransportError(emailFailure(code, detail));
}

function cleanDetail(detail: string | null | undefined): string | null {
  if (typeof detail !== "string") return null;
  const oneLine = redactText(detail).replaceAll(/[\s\u0000-\u001F\u007F]+/g, " ").trim();
  if (oneLine.length === 0) return null;
  return oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
}

/** Everything a transport needs, with the secret already read from the vault. */
export interface EmailTransportConfig {
  provider: EmailProviderKind;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  smtp: {
    host: string;
    port: number;
    security: EmailSmtpSecurity;
    username: string | null;
  } | null;
  /** SMTP password or Resend API key. */
  secret: string | null;
  timeoutMs?: number;
}

/** 20 s: long enough for a slow TLS handshake, short enough to free the worker. */
export const EMAIL_TIMEOUT_MS = 20_000;

/**
 * A `From:` header with a display name, folded into nothing dangerous: the name
 * is quoted and any character that could close the quote or start a new header
 * is dropped rather than escaped.
 */
export function formatSender(name: string, address: string): string {
  const safe = name.replaceAll(/["\\\r\n]/g, "").replaceAll(/[\u0000-\u001F\u007F]/g, "").trim();
  return safe ? `"${safe}" <${address}>` : address;
}

export function createEmailTransport(
  config: EmailTransportConfig,
  factories: {
    smtp?: (config: EmailTransportConfig) => EmailTransport;
    resend?: (config: EmailTransportConfig) => EmailTransport;
  } = {},
): EmailTransport {
  if (config.provider === "resend") {
    const build = factories.resend ?? defaultResendFactory;
    return build(config);
  }
  const build = factories.smtp ?? defaultSmtpFactory;
  return build(config);
}

/**
 * Loaded lazily so that a process which never sends e-mail — every scanner
 * worker opens the same database — does not pay for nodemailer's module graph.
 */
function defaultSmtpFactory(config: EmailTransportConfig): EmailTransport {
  return {
    async send(message) {
      const { createSmtpTransport } = await import("./smtp-transport.js");
      return createSmtpTransport(config).send(message);
    },
  };
}

function defaultResendFactory(config: EmailTransportConfig): EmailTransport {
  return {
    async send(message) {
      const { createResendTransport } = await import("./resend-transport.js");
      return createResendTransport(config).send(message);
    },
  };
}
