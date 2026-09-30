import type Database from "better-sqlite3";
import type { EmailSettingsRecord } from "./settings-store.js";
import type { EmailTransportConfig } from "./transport.js";
import { getEmailSettings } from "./settings-store.js";
import type { EmailCredentialStore } from "../credentials/system-email-credential-store.js";

/** The transport configuration a complete record implies, or `null` when it is not complete. */
export function transportConfigFor(
  record: EmailSettingsRecord,
  secret: string | null,
): EmailTransportConfig | null {
  if (record.fromAddress === null) return null;
  if (record.provider === "resend") {
    if (secret === null) return null;
    return {
      provider: "resend", fromName: record.fromName, fromAddress: record.fromAddress,
      replyTo: record.replyTo, smtp: null, secret,
    };
  }
  if (record.smtpHost === null || record.smtpPort === null) return null;
  // Authless relay: a username is what makes a password necessary.
  if (record.smtpUsername !== null && secret === null) return null;
  return {
    provider: "smtp", fromName: record.fromName, fromAddress: record.fromAddress,
    replyTo: record.replyTo, secret,
    smtp: {
      host: record.smtpHost, port: record.smtpPort,
      security: record.smtpSecurity, username: record.smtpUsername,
    },
  };
}

/**
 * The provider the outbox should send through right now: the stored record, its
 * secret read out of the vault, and the two reasons there may be none — the
 * global switch is off, or the configuration is incomplete. Both are answers,
 * not failures: a worker that treated "not configured yet" as a send failure
 * would burn every message's attempts in the minutes before an administrator
 * finishes filling the form.
 */
export type ActiveEmailTransport =
  | { status: "ready"; config: EmailTransportConfig }
  | { status: "disabled" }
  | { status: "not_configured" }
  | { status: "secret_unavailable" };

export async function activeEmailTransportConfig(
  secrets: EmailCredentialStore,
  database: Database.Database,
): Promise<ActiveEmailTransport> {
  const record = getEmailSettings(database);
  if (!record.enabled) return { status: "disabled" };
  let secret: string | null = null;
  if (record.secretRef !== null) {
    try {
      secret = (await secrets.get(record.secretRef))?.secret ?? null;
    } catch {
      return { status: "secret_unavailable" };
    }
  }
  const config = transportConfigFor(record, secret);
  return config === null ? { status: "not_configured" } : { status: "ready", config };
}
