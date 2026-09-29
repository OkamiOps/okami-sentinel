/**
 * Everything both runtimes need to agree on about e-mail: the provider preset
 * table the Settings screen fills its form from, the settings shape the API
 * returns (never a secret, only `secretConfigured`), the outbox history entry
 * and the five interface locales.
 */

export type EmailProviderKind = "smtp" | "resend";

/**
 * `tls` is implicit TLS on 465, `starttls` upgrades a plaintext 587 connection,
 * and `none` exists only for a relay reachable inside the same private network.
 */
export type EmailSmtpSecurity = "tls" | "starttls" | "none";

export type EmailPresetId =
  | "resend"
  | "hostinger"
  | "zoho"
  | "zoho-eu"
  | "gmail"
  | "microsoft365"
  | "custom";

/** What the administrator has to type into the SMTP username field. */
export type EmailUsernameHint =
  /** The provider requires one fixed literal, carried in `username`. */
  | "fixed"
  /** The sending mailbox's own address. */
  | "mailbox"
  /** Only the administrator knows; the form asks for it without a suggestion. */
  | "unknown";

/** What the administrator has to paste into the password field. */
export type EmailSecretHint = "api-key" | "app-password" | "password";

export interface EmailProviderPreset {
  id: EmailPresetId;
  /** The provider kind the preset configures. */
  provider: EmailProviderKind;
  /** `null` where the administrator supplies the value (custom SMTP, Resend API). */
  host: string | null;
  port: number | null;
  security: EmailSmtpSecurity | null;
  /** The literal username the provider demands, when it demands one. */
  username: string | null;
  usernameHint: EmailUsernameHint;
  secretHint: EmailSecretHint;
}

/**
 * Ports and security modes come from each provider's published SMTP endpoint.
 * `resend` is the SMTP front door of the same account whose API key the
 * `resend-api` preset uses directly, which is why its username is the literal
 * `resend` and its password is the API key.
 */
export const EMAIL_PROVIDER_PRESETS: readonly EmailProviderPreset[] = Object.freeze([
  Object.freeze({
    id: "resend", provider: "smtp", host: "smtp.resend.com", port: 465, security: "tls",
    username: "resend", usernameHint: "fixed", secretHint: "api-key",
  }),
  Object.freeze({
    id: "hostinger", provider: "smtp", host: "smtp.hostinger.com", port: 465, security: "tls",
    username: null, usernameHint: "mailbox", secretHint: "password",
  }),
  Object.freeze({
    id: "zoho", provider: "smtp", host: "smtp.zoho.com", port: 465, security: "tls",
    username: null, usernameHint: "mailbox", secretHint: "password",
  }),
  Object.freeze({
    id: "zoho-eu", provider: "smtp", host: "smtp.zoho.eu", port: 465, security: "tls",
    username: null, usernameHint: "mailbox", secretHint: "password",
  }),
  Object.freeze({
    id: "gmail", provider: "smtp", host: "smtp.gmail.com", port: 465, security: "tls",
    username: null, usernameHint: "mailbox", secretHint: "app-password",
  }),
  Object.freeze({
    id: "microsoft365", provider: "smtp", host: "smtp.office365.com", port: 587, security: "starttls",
    username: null, usernameHint: "mailbox", secretHint: "password",
  }),
  Object.freeze({
    id: "custom", provider: "smtp", host: null, port: null, security: null,
    username: null, usernameHint: "unknown", secretHint: "password",
  }),
]) as readonly EmailProviderPreset[];

export function emailProviderPreset(id: string): EmailProviderPreset | null {
  return EMAIL_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** The administrator's saved configuration, with the secret reduced to a flag. */
export interface EmailSettings {
  provider: EmailProviderKind;
  enabled: boolean;
  fromName: string;
  fromAddress: string | null;
  replyTo: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: EmailSmtpSecurity;
  smtpUsername: string | null;
  /** True once an SMTP password or a Resend API key is in the vault. */
  secretConfigured: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface EmailSettingsResponse {
  settings: EmailSettings;
  presets: readonly EmailProviderPreset[];
  /** `null` in local mode, where e-mails cannot carry absolute links. */
  publicOrigin: string | null;
}

export type EmailOutboxStatus = "queued" | "sending" | "sent" | "failed" | "cancelled";

/** One outbox row as the history screen sees it: never the rendered bodies. */
export interface EmailDelivery {
  id: string;
  event: string;
  toAddress: string;
  locale: string;
  subject: string;
  status: EmailOutboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  providerMessageId: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface EmailDeliveriesResponse {
  deliveries: EmailDelivery[];
}

/**
 * Why a send failed, in terms an administrator can act on. `permanent` says
 * whether retrying the same message with the same configuration could ever
 * succeed; the outbox worker still counts a permanent failure as an attempt.
 */
export type EmailErrorCode =
  | "not_configured"
  | "auth_rejected"
  | "tls_failed"
  | "connection_refused"
  | "connection_timeout"
  | "sender_not_verified"
  | "recipient_rejected"
  | "message_rejected"
  | "rate_limited"
  | "provider_unavailable";

/** The outcome of `POST /email/test`, shown next to the button. */
export interface EmailTestResult {
  ok: boolean;
  /** Where the test went, once an address could be resolved. */
  to: string | null;
  code: EmailErrorCode | null;
  message: string | null;
  providerMessageId: string | null;
}

export const USER_LOCALES = ["pt-BR", "en", "es", "de", "fr"] as const;
export type UserLocale = (typeof USER_LOCALES)[number];
export const DEFAULT_USER_LOCALE: UserLocale = "pt-BR";

export function isUserLocale(value: unknown): value is UserLocale {
  return typeof value === "string" && (USER_LOCALES as readonly string[]).includes(value);
}
