import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { EmailDelivery, EmailOutboxStatus, UserLocale } from "@csb/shared";
import { getDb } from "../db.js";

/** How many rows the history screen shows; the design fixes the number. */
export const EMAIL_DELIVERY_HISTORY_LIMIT = 200;

export interface EmailOutboxInsert {
  event: string;
  /** `gate.<gateId>.<event>`, `scan.<scanId>.<event>` or `account.<userId>.<event>.<ref>`. */
  dedupeKey: string;
  /**
   * The subscription scope this message belongs to: a repository key, or `ops`.
   * `null` for account messages, which nobody can lose access to. The worker
   * re-reads it to confirm the recipient still qualifies.
   */
  scope?: string | null;
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
 * The row-level primitive. Callers that have an event and want a message go
 * through `enqueueEmail` in `enqueue.ts`, which renders the body and honours the
 * global switch; this function is what that one, and the synchronous test send,
 * write with.
 *
 * Meant to be called inside the transaction of the event that produced it, which
 * is why the database handle is a parameter.
 */
export function insertOutboxRow(
  input: EmailOutboxInsert,
  now: Date = new Date(),
  database: Database.Database = getDb(),
): string | null {
  const id = `out_${nanoid(16)}`;
  const result = database.prepare(`
    INSERT INTO email_outbox (
      id, event, dedupe_key, scope, user_id, to_address, locale, subject, html, text,
      status, attempts, next_attempt_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `).run(
    id, input.event, input.dedupeKey, input.scope ?? null, input.userId, input.toAddress, input.locale,
    input.subject, input.html, input.text, input.status ?? "queued", input.attempts ?? 0,
    input.nextAttemptAt ?? now.toISOString(), now.toISOString(),
  );
  return result.changes === 1 ? id : null;
}

/**
 * The kinds whose rendered body contains a live single-use credential: the invite
 * and reset links. `user_invites` keeps only the hash of those tokens, so an
 * outbox row that keeps the cleartext one would be the weakest copy of it in the
 * database — and it would outlive the delivery by up to ninety days.
 */
export const LINK_BEARING_EMAIL_EVENTS: readonly string[] = Object.freeze(["account.invite", "account.reset"]);

const LINK_BEARING_LIST = LINK_BEARING_EMAIL_EVENTS.map((event) => `'${event}'`).join(", ");

/**
 * Empties the bodies of a row that will never be sent again, when those bodies
 * carry a token. Everything the history shows — recipient, kind, status, attempts,
 * error, times — is untouched; only the two columns nothing renders are cleared.
 * A message that may still be retried keeps its body, because that body is what
 * the retry sends.
 */
function dropLinkBody(id: string, database: Database.Database): void {
  database.prepare(`
    UPDATE email_outbox SET html = '', text = ''
     WHERE id = ? AND event IN (${LINK_BEARING_LIST})
  `).run(id);
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
  dropLinkBody(id, database);
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
  if (nextAttemptAt === null) dropLinkBody(id, database);
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

/** What the worker needs to send a row and to decide whether it still should. */
export interface EmailOutboxClaim {
  id: string;
  event: string;
  /** The repository key or `ops` the message belongs to; `null` for account mail. */
  scope: string | null;
  userId: string | null;
  toAddress: string;
  locale: string;
  subject: string;
  html: string;
  text: string;
  /** Attempts already recorded, before the one about to happen. */
  attempts: number;
}

/**
 * `sending` means "a worker has this row right now". After a crash or a SIGKILL
 * nobody has it, so these are the rows a starting worker has to decide about —
 * losing a notification because the process restarted is exactly what the outbox
 * exists to prevent. The decision itself is the worker's, because it is the one
 * that owns the retry policy.
 */
export function listInterruptedEmails(
  createdBefore: Date,
  database: Database.Database = getDb(),
): Array<{ id: string; event: string; attempts: number }> {
  // `createdBefore` is the caller's own start time. A `sending` row younger than
  // that was claimed by something still running — `POST /email/test` writes its row
  // already `sending` and resolves it inside a request that can take twenty
  // seconds — so it is nobody's to recover.
  return database.prepare(
    "SELECT id, event, attempts FROM email_outbox WHERE status = 'sending' AND created_at < ? ORDER BY created_at, id",
  ).all(createdBefore.toISOString()) as Array<{ id: string; event: string; attempts: number }>;
}

/**
 * Cancels the link-bearing messages whose link has expired, and empties their
 * bodies. A provider that was off for three days leaves invites in the queue that
 * would arrive with a dead token: an administrator reissuing the invite is the
 * only thing that can help, and the history says which ones need it.
 */
export function expireLinkBearingEmails(
  createdBefore: Date,
  reason: string,
  database: Database.Database = getDb(),
): number {
  // Asked before it is done. The worker runs this every five seconds, for the whole
  // life of the process, and on an installation that never enabled e-mail there is
  // never a row to cancel — but the `UPDATE` would still take the WAL writer lock
  // every five seconds, on the same file as the scan and gate hot paths. The read
  // uses the same predicate, so the ordering guarantee is unchanged: a dead token
  // is still cancelled before any provider is consulted.
  const pending = database.prepare(`
    SELECT 1 FROM email_outbox
     WHERE event IN (${LINK_BEARING_LIST})
       AND status IN ('queued', 'sending')
       AND created_at < ?
     LIMIT 1
  `).get(createdBefore.toISOString());
  if (pending === undefined) return 0;
  return database.prepare(`
    UPDATE email_outbox
       SET status = 'cancelled', next_attempt_at = NULL, last_error = ?, html = '', text = ''
     WHERE event IN (${LINK_BEARING_LIST})
       AND status IN ('queued', 'sending')
       AND created_at < ?
  `).run(reason, createdBefore.toISOString()).changes;
}

/**
 * Takes up to `limit` due rows in one IMMEDIATE transaction, so two workers — the
 * API and, one day, a second process on the same file — cannot both hold the same
 * row: the write lock is taken before the `SELECT`, not after it.
 *
 * `account.test` never appears here. That row is written already `sending` by the
 * settings screen, which sends it itself and resolves it in the same request.
 */
export function claimDueEmails(
  limit: number,
  now: Date = new Date(),
  database: Database.Database = getDb(),
): EmailOutboxClaim[] {
  return database.transaction((): EmailOutboxClaim[] => {
    const rows = database.prepare(`
      SELECT id, event, scope, user_id, to_address, locale, subject, html, text, attempts
        FROM email_outbox
       WHERE status = 'queued'
         AND event <> 'account.test'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY next_attempt_at IS NULL DESC, next_attempt_at, created_at, id
       LIMIT ?
    `).all(now.toISOString(), Math.max(0, limit)) as Array<{
      id: string; event: string; scope: string | null; user_id: string | null; to_address: string;
      locale: string; subject: string; html: string; text: string; attempts: number;
    }>;
    if (rows.length === 0) return [];
    const claim = database.prepare("UPDATE email_outbox SET status = 'sending' WHERE id = ? AND status = 'queued'");
    return rows
      .filter((row) => claim.run(row.id).changes === 1)
      .map((row) => ({
        id: row.id, event: row.event, scope: row.scope, userId: row.user_id,
        toAddress: row.to_address, locale: row.locale, subject: row.subject,
        html: row.html, text: row.text, attempts: row.attempts,
      }));
  }).immediate();
}

/**
 * A message whose recipient no longer qualifies — the account is gone, disabled,
 * or lost the access the event was about. Not a failure: nothing went wrong, the
 * message simply must not be sent, and the reason stays readable in the history.
 */
export function markEmailCancelled(
  id: string,
  reason: string,
  database: Database.Database = getDb(),
): void {
  database.prepare(`
    UPDATE email_outbox
       SET status = 'cancelled', next_attempt_at = NULL, last_error = ?
     WHERE id = ?
  `).run(reason, id);
  dropLinkBody(id, database);
}

/**
 * Retention: a delivered or cancelled message older than the window is history
 * nobody reads, and its `html` still holds the invite link it carried. `queued`,
 * `sending` and `failed` rows are never touched — a failure is a thing an
 * administrator still has to see.
 */
export function deleteFinishedEmailsBefore(
  before: Date,
  database: Database.Database = getDb(),
): number {
  return database.prepare(`
    DELETE FROM email_outbox
     WHERE status IN ('sent', 'cancelled')
       AND COALESCE(sent_at, created_at) < ?
  `).run(before.toISOString()).changes;
}
