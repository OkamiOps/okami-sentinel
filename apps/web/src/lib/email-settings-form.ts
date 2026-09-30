import {
  EMAIL_PROVIDER_PRESETS,
  emailProviderPreset,
  type EmailPresetId,
  type EmailProviderKind,
  type EmailProviderPreset,
  type EmailSettings,
  type EmailSmtpSecurity,
} from "@csb/shared";
import type { EmailSettingsInput } from "./email-api.js";

/**
 * The form's own state. Every text field is a string — including the port, so a
 * half-typed number is not silently coerced to `NaN` — and `secret` is empty
 * whenever the administrator has not typed a replacement, which is exactly the
 * case where `PUT /email/settings` must not receive the field at all.
 */
export interface EmailSettingsDraft {
  provider: EmailProviderKind;
  presetId: EmailPresetId;
  enabled: boolean;
  fromName: string;
  fromAddress: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: EmailSmtpSecurity;
  smtpUsername: string;
  secret: string;
}

/** Which field an error code from the API belongs to; `null` is form-level. */
export type EmailSettingsField =
  | "provider" | "enabled" | "fromName" | "fromAddress" | "replyTo"
  | "smtpHost" | "smtpPort" | "smtpSecurity" | "smtpUsername" | "secret";

const FIELD_BY_CODE: Readonly<Record<string, EmailSettingsField>> = Object.freeze({
  provider_invalid: "provider",
  enabled_invalid: "enabled",
  from_name_invalid: "fromName",
  from_address_invalid: "fromAddress",
  from_address_required: "fromAddress",
  reply_to_invalid: "replyTo",
  smtp_host_invalid: "smtpHost",
  smtp_host_required: "smtpHost",
  smtp_port_invalid: "smtpPort",
  smtp_port_required: "smtpPort",
  smtp_security_invalid: "smtpSecurity",
  smtp_username_invalid: "smtpUsername",
  secret_invalid: "secret",
  secret_required: "secret",
});

export function emailSettingsField(code: string | null): EmailSettingsField | null {
  return code === null ? null : FIELD_BY_CODE[code] ?? null;
}

/**
 * Every error code the four `/email` routes can name. The screen translates a
 * code only when it is on this list: an unknown one falls back to a generic
 * sentence instead of asking the catalogue for a key that does not exist.
 */
export const EMAIL_ERROR_CODES: readonly string[] = Object.freeze([
  ...Object.keys(FIELD_BY_CODE),
  "secret_storage_unavailable",
  "no_recipient_address",
  "email_not_configured",
]);

export function isEmailErrorCode(code: string | null): boolean {
  return code !== null && EMAIL_ERROR_CODES.includes(code);
}

/** Only the SMTP presets can fill a host, and only they belong in the select. */
export function smtpPresets(presets: readonly EmailProviderPreset[] = EMAIL_PROVIDER_PRESETS): readonly EmailProviderPreset[] {
  return presets.filter((preset) => preset.provider === "smtp");
}

/**
 * Which preset the stored configuration corresponds to. A saved row carries no
 * preset id — the design stores the resolved host, port and security — so the
 * select has to be recovered from them, and anything unrecognised is `custom`
 * rather than a preset that would silently rewrite the host on the next save.
 */
export function detectPresetId(
  settings: Pick<EmailSettings, "smtpHost" | "smtpPort" | "smtpSecurity">,
  presets: readonly EmailProviderPreset[] = EMAIL_PROVIDER_PRESETS,
): EmailPresetId {
  if (!settings.smtpHost) return "custom";
  const match = smtpPresets(presets).find((preset) =>
    preset.host !== null
    && preset.host === settings.smtpHost
    && preset.port === settings.smtpPort
    && preset.security === settings.smtpSecurity);
  return match?.id ?? "custom";
}

export function draftFromSettings(
  settings: EmailSettings,
  presets: readonly EmailProviderPreset[] = EMAIL_PROVIDER_PRESETS,
): EmailSettingsDraft {
  return {
    provider: settings.provider,
    presetId: detectPresetId(settings, presets),
    enabled: settings.enabled,
    fromName: settings.fromName,
    fromAddress: settings.fromAddress ?? "",
    replyTo: settings.replyTo ?? "",
    smtpHost: settings.smtpHost ?? "",
    smtpPort: settings.smtpPort === null ? "" : String(settings.smtpPort),
    smtpSecurity: settings.smtpSecurity,
    smtpUsername: settings.smtpUsername ?? "",
    // A stored secret never comes back from the API, so the field starts empty
    // and staying empty is what keeps it.
    secret: "",
  };
}

/**
 * Applying a preset fills the three transport fields it knows, and the username
 * only when the provider demands a fixed literal (Resend's `resend`). A preset
 * whose username is the sending mailbox must not overwrite what the
 * administrator typed, and `custom` clears nothing at all: switching to it is a
 * decision to edit the current values by hand.
 */
export function applyPreset(draft: EmailSettingsDraft, presetId: EmailPresetId): EmailSettingsDraft {
  const preset = emailProviderPreset(presetId);
  if (!preset) return draft;
  const next: EmailSettingsDraft = { ...draft, presetId };
  if (preset.host !== null) next.smtpHost = preset.host;
  if (preset.port !== null) next.smtpPort = String(preset.port);
  if (preset.security !== null) next.smtpSecurity = preset.security;
  if (preset.username !== null) next.smtpUsername = preset.username;
  return next;
}

/** A port the API will accept, or `null` when the field is empty or not a port. */
export function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * The body for `PUT /email/settings`. The SMTP transport fields are sent only
 * for the SMTP provider — sending a host while the Resend API is selected would
 * store a transport nothing reads — and `secret` is omitted unless a
 * replacement was typed, which is how the stored one survives a save.
 *
 * An unparseable port is still sent as a string so the API names the field
 * instead of the screen inventing its own rule; `NaN` would be silently
 * dropped by `JSON.stringify`, which is the one outcome that hides the mistake.
 */
export function settingsPayload(draft: EmailSettingsDraft): EmailSettingsInput {
  const payload: EmailSettingsInput = {
    provider: draft.provider,
    enabled: draft.enabled,
    fromName: draft.fromName.trim(),
    fromAddress: draft.fromAddress.trim() || null,
    replyTo: draft.replyTo.trim() || null,
  };
  if (draft.provider === "smtp") {
    payload.smtpHost = draft.smtpHost.trim() || null;
    payload.smtpPort = draft.smtpPort.trim() ? parsePort(draft.smtpPort) ?? draft.smtpPort.trim() : null;
    payload.smtpSecurity = draft.smtpSecurity;
    payload.smtpUsername = draft.smtpUsername.trim() || null;
  }
  if (draft.secret) payload.secret = draft.secret;
  return payload;
}

/**
 * Whether the test button can do anything yet. The API refuses a test with no
 * sender and no transport with `email_not_configured`; saying so before the
 * request keeps the administrator from reading a provider error that is really
 * an empty form.
 */
export function canSendTest(settings: EmailSettings): boolean {
  if (!settings.fromAddress) return false;
  if (settings.provider === "resend") return settings.secretConfigured;
  if (!settings.smtpHost || settings.smtpPort === null) return false;
  // An internal relay with no username needs no secret; any other SMTP does.
  return settings.smtpUsername === null || settings.secretConfigured;
}
