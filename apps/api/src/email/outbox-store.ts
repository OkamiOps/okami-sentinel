import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { EmailDelivery, EmailOutboxStatus, UserLocale } from "@csb/shared";
import { getDb } from "../db.js";

/** How many rows the history screen shows; the design fixes the number. */
export const EMAIL_DELIVERY_HISTORY_LIMIT = 200;

export interface EnqueueEmailInput {
  event: string;
  /** `gate.<gateId>.<event>`, `scan.<scanId>.<event>` or `account.<userId>.<event>.<ref>`. */
  dedupeKey: string;
  userId: string | null;
  toAddress: string;
  locale: UserLocale;
  subject: string;
  html: string;
  text: string;
  /** `queued` for the worker; `sending` when the caller sends it itself. */
  status?: EmailOutboxStatus;
  nextAttemptAt?: string | null;
  attempts?: number;
}

/**
 * Writes one outbox row, or nothing at all when its `dedupe_key` was already
 * used. The `null` return is how the caller learns that this event has already
 * produced an e-mail, which is the whole point of the unique key: the same gate
 * result reaching the same recipient twice must not send twice.
 *
 * Meant to be called inside the transaction of the event that produced it, which
 * is why the database handle is a parameter.
 */
export function enqueueEmail(
  input: EnqueueEmailInput,
  now: Date = new Date(),
  database: Database.Database = getDb(),
): string | null {
  const id = `out_${nanoid(16)}`;
  const result = database.prepare(`
    INSERT INTO email_outbox (
      id, event, dedupe_key, user_id, to_address, locale, subject, html, text,
      status, attempts, next_attempt_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `).run(
    id, input.event, input.dedupeKey, input.userId, input.toAddress, input.locale,
    input.subject, input.html, input.text, input.status ?? "queued", input.attempts ?? 0,
    input.nextAttemptAt ?? now.toISOString(), now.toISOString(),
  );
  return result.changes === 1 ? id : null;
}

export function markEmailSent(
  id: string,
  providerMessageId: string | null,
  now: Date = new Date(),
  database: Database.Database = getDb(),
): void {
  database.prepare(`
    UPDATE email_outbox
       SET status = 'sent', provider_message_id = ?, sent_at = ?, next_attempt_at = NULL, last_error = NULL
     WHERE id = ?
  `).run(providerMessageId, now.toISOString(), id);
}

/**
 * Records an attempt that did not deliver. `nextAttemptAt` is `null` when the
 * message is given up on, which is what turns the row into a terminal `failed`;
 * the error text stays visible in the history either way.
 */
export function markEmailFailed(
  id: string,
  error: string,
  nextAttemptAt: string | null,
  database: Database.Database = getDb(),
): void {
  database.prepare(`
    UPDATE email_outbox
       SET status = ?, attempts = attempts + 1, last_error = ?, next_attempt_at = ?
     WHERE id = ?
  `).run(nextAttemptAt === null ? "failed" : "queued", error, nextAttemptAt, id);
}

/**
 * The history, newest first, without `html` or `text`: the bodies can name a
 * repository, a branch and a link with a token-shaped path, and nothing on the
 * screen renders them.
 */
export function listEmailDeliveries(
  limit: number = EMAIL_DELIVERY_HISTORY_LIMIT,
  database: Database.Database = getDb(),
): EmailDelivery[] {
  const rows = database.prepare(`
    SELECT id, event, to_address, locale, subject, status, attempts,
           next_attempt_at, last_error, provider_message_id, created_at, sent_at
      FROM email_outbox
     ORDER BY created_at DESC, id DESC
     LIMIT ?
  `).all(Math.max(1, Math.min(limit, EMAIL_DELIVERY_HISTORY_LIMIT))) as Array<{
    id: string; event: string; to_address: string; locale: string; subject: string;
    status: EmailOutboxStatus; attempts: number; next_attempt_at: string | null;
    last_error: string | null; provider_message_id: string | null;
    created_at: string; sent_at: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    toAddress: row.to_address,
    locale: row.locale,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    providerMessageId: row.provider_message_id,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  }));
}
