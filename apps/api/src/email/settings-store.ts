import type Database from "better-sqlite3";
import type { EmailProviderKind, EmailSettings, EmailSmtpSecurity } from "@csb/shared";
import { getDb } from "../db.js";

/** The stored configuration, including the vault reference the API never returns. */
export interface EmailSettingsRecord {
  provider: EmailProviderKind;
  enabled: boolean;
  fromName: string;
  fromAddress: string | null;
  replyTo: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: EmailSmtpSecurity;
  smtpUsername: string | null;
  /** Where the SMTP password or Resend API key lives, or `null` when unset. */
  secretRef: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface EmailSettingsRow {
  provider: EmailProviderKind;
  enabled: number;
  from_name: string;
  from_address: string | null;
  reply_to: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: EmailSmtpSecurity;
  smtp_username: string | null;
  secret_ref: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/** What an installation that never opened the screen looks like. */
export const DEFAULT_EMAIL_SETTINGS: Readonly<EmailSettingsRecord> = Object.freeze({
  provider: "smtp",
  enabled: false,
  fromName: "Okami Sentinel",
  fromAddress: null,
  replyTo: null,
  smtpHost: null,
  smtpPort: null,
  smtpSecurity: "tls",
  smtpUsername: null,
  secretRef: null,
  updatedAt: null,
  updatedBy: null,
});

export function getEmailSettings(database: Database.Database = getDb()): EmailSettingsRecord {
  const row = database.prepare("SELECT * FROM email_settings WHERE id = 1").get() as
    EmailSettingsRow | undefined;
  if (row === undefined) return { ...DEFAULT_EMAIL_SETTINGS };
  return {
    provider: row.provider,
    enabled: row.enabled === 1,
    fromName: row.from_name,
    fromAddress: row.from_address,
    replyTo: row.reply_to,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecurity: row.smtp_security,
    smtpUsername: row.smtp_username,
    secretRef: row.secret_ref,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Replaces the singleton row wholesale. The caller has already validated the
 * values and resolved what should happen to the secret, so there is no partial
 * update to reconcile and no way to end up with, say, a `resend` provider still
 * carrying an SMTP host's secret reference.
 */
export function saveEmailSettings(
  settings: Omit<EmailSettingsRecord, "updatedAt" | "updatedBy">,
  actor: string | null,
  now: Date = new Date(),
  database: Database.Database = getDb(),
): EmailSettingsRecord {
  database.prepare(`
    INSERT INTO email_settings (
      id, provider, enabled, from_name, from_address, reply_to,
      smtp_host, smtp_port, smtp_security, smtp_username, secret_ref, updated_at, updated_by
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider, enabled = excluded.enabled, from_name = excluded.from_name,
      from_address = excluded.from_address, reply_to = excluded.reply_to,
      smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port,
      smtp_security = excluded.smtp_security, smtp_username = excluded.smtp_username,
      secret_ref = excluded.secret_ref, updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(
    settings.provider, settings.enabled ? 1 : 0, settings.fromName, settings.fromAddress,
    settings.replyTo, settings.smtpHost, settings.smtpPort, settings.smtpSecurity,
    settings.smtpUsername, settings.secretRef, now.toISOString(), actor,
  );
  return getEmailSettings(database);
}

/**
 * The only shape that may leave the API. The vault reference becomes a boolean:
 * knowing *where* a secret is stored is already more than a client needs, and
 * the reference is what a replacement would have to name.
 */
export function publicEmailSettings(record: EmailSettingsRecord): EmailSettings {
  return {
    provider: record.provider,
    enabled: record.enabled,
    fromName: record.fromName,
    fromAddress: record.fromAddress,
    replyTo: record.replyTo,
    smtpHost: record.smtpHost,
    smtpPort: record.smtpPort,
    smtpSecurity: record.smtpSecurity,
    smtpUsername: record.smtpUsername,
    secretConfigured: record.secretRef !== null,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}
