import {
  createTransport,
  type NodemailerError,
  type SMTPTransportOptions,
  type Transporter,
} from "nodemailer";
import type { EmailErrorCode } from "@csb/shared";
import {
  EMAIL_TIMEOUT_MS,
  emailFailure,
  EmailTransportError,
  emailTransportError,
  formatSender,
  type EmailFailure,
  type EmailMessage,
  type EmailSendResult,
  type EmailTransport,
  type EmailTransportConfig,
} from "./transport.js";

/** Keeps the header valid whatever the outbox id looks like. */
const MESSAGE_ID_TOKEN = /[^A-Za-z0-9._-]/g;

export type SmtpTransporterFactory = (options: SMTPTransportOptions) => Pick<
  Transporter<{ messageId?: string }>,
  "sendMail"
>;

export function smtpTransportOptions(config: EmailTransportConfig): SMTPTransportOptions {
  const smtp = config.smtp;
  if (smtp === null) throw emailTransportError("not_configured");
  const timeout = config.timeoutMs ?? EMAIL_TIMEOUT_MS;
  return {
    host: smtp.host,
    port: smtp.port,
    // Implicit TLS on 465; STARTTLS is *required*, never opportunistic, so a
    // relay that silently drops the upgrade fails instead of sending the
    // credentials in the clear. `none` is the documented private-relay escape.
    secure: smtp.security === "tls",
    requireTLS: smtp.security === "starttls",
    ignoreTLS: smtp.security === "none",
    auth: smtp.username ? { user: smtp.username, pass: config.secret ?? "" } : undefined,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export function createSmtpTransport(
  config: EmailTransportConfig,
  factory: SmtpTransporterFactory = (options) => createTransport(options),
): EmailTransport {
  const options = smtpTransportOptions(config);
  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const transporter = factory(options);
      try {
        const info = await transporter.sendMail({
          from: formatSender(config.fromName, config.fromAddress),
          to: message.to,
          replyTo: config.replyTo ?? undefined,
          subject: message.subject,
          text: message.text,
          html: message.html,
          // SMTP has no idempotency header, so the outbox id becomes the
          // Message-ID: a retried row keeps the identity the relay already saw.
          messageId: `<${message.idempotencyKey.replaceAll(MESSAGE_ID_TOKEN, "-")}@${senderDomain(config.fromAddress)}>`,
        });
        return { providerMessageId: info?.messageId ?? null };
      } catch (error) {
        throw new EmailTransportError(mapSmtpError(error));
      }
    },
  };
}

function senderDomain(address: string): string {
  return address.split("@").at(-1) || "localhost";
}

/**
 * Nodemailer's own code names the cause; the reply code decides whether it is
 * final. Those are two different questions and conflating them loses mail: a
 * greylisting relay answers `451` to `RCPT TO`, a busy one `450` to `MAIL FROM`
 * and a throttled one `454` to `AUTH`, and all three arrive as the same
 * `EENVELOPE`/`EAUTH` codes a genuine 5xx rejection uses. So the cause is
 * classified first, and then a 4xx reply — SMTP's own word for "not now" —
 * overrides the verdict to transient, whatever the cause turned out to be.
 */
export function mapSmtpError(error: unknown): EmailFailure {
  const failure = error as NodemailerError | undefined;
  const detail = failure?.response ?? failure?.message ?? null;
  const reply = failure?.responseCode;
  // Only a 4xx reply is an override. A 5xx one, or no reply at all, leaves the
  // cause's own verdict standing, so an unreachable host stays retryable and a
  // refused credential stays permanent.
  const transient = typeof reply === "number" && reply >= 400 && reply < 500 ? false : undefined;
  return emailFailure(smtpErrorCode(failure, detail), detail, transient);
}

function smtpErrorCode(failure: NodemailerError | undefined, detail: string | null): EmailErrorCode {
  const code = failure?.code ?? "";
  const reply = failure?.responseCode;

  if (code === "EAUTH" || code === "ENOAUTH" || reply === 535 || reply === 530) return "auth_rejected";
  if (code === "ETLS" || code === "EREQUIRETLS" || isTlsFailure(failure)) return "tls_failed";
  if (failure?.errno === -61 || code === "ECONNREFUSED" || /ECONNREFUSED/.test(detail ?? "")) {
    return "connection_refused";
  }
  if (code === "ETIMEDOUT" || /timed? ?out/i.test(detail ?? "")) return "connection_timeout";
  if (code === "EDNS" || /ENOTFOUND|EAI_AGAIN/.test(detail ?? "")) return "connection_refused";
  if (code === "EENVELOPE") return envelopeCode(failure);
  if (code === "EMESSAGE" || code === "EMAXRECIPIENTS") return "message_rejected";
  if (reply === 550 || reply === 553 || reply === 554) return "message_rejected";
  return "provider_unavailable";
}

function envelopeCode(failure: NodemailerError | undefined): EmailErrorCode {
  const command = failure?.command ?? "";
  if (command === "MAIL FROM" || /sender|from address|not verified|not allowed to send/i.test(failure?.response ?? "")) {
    return "sender_not_verified";
  }
  if (command === "RCPT TO" || (failure?.rejected?.length ?? 0) > 0) return "recipient_rejected";
  return "message_rejected";
}

function isTlsFailure(failure: NodemailerError | undefined): boolean {
  const text = `${failure?.code ?? ""} ${failure?.message ?? ""} ${failure?.response ?? ""}`;
  return /ERR_TLS|ERR_SSL|wrong version number|self[- ]signed|certificate|SSL routines|STARTTLS/i.test(text);
}
