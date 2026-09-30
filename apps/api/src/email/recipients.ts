import type Database from "better-sqlite3";
import type { RepositoryRole, UserLocale } from "@csb/shared";
import { getDb } from "../db.js";
import { localeOf, resolveUserEmailAddress } from "./address.js";

/**
 * Who a notification may reach, asked of the database rather than of a session.
 *
 * A session's principal is a snapshot taken when the request arrived; a
 * notification is sent minutes or hours later, possibly by a worker with no
 * request at all. Access is therefore re-read here, and re-read again by the
 * worker right before the send — the design asks for exactly that.
 */

export interface EmailRecipient {
  userId: string;
  toAddress: string;
  locale: UserLocale;
}

interface RecipientRow {
  id: string;
  email: string | null;
  username: string;
  locale: string | null;
}

function toRecipients(rows: RecipientRow[]): EmailRecipient[] {
  const recipients: EmailRecipient[] = [];
  for (const row of rows) {
    const toAddress = resolveUserEmailAddress(row);
    // No address on file is not an error: Minha conta shows the warning, and the
    // event is not worth an outbox row nobody could ever deliver.
    if (toAddress === null) continue;
    recipients.push({ userId: row.id, toAddress, locale: localeOf(row) });
  }
  return recipients;
}

/**
 * Every active administrator with an address. The audience for operational
 * alerts, and the whole audience for a scan that belongs to no repository.
 */
export function adminRecipients(database: Database.Database = getDb()): EmailRecipient[] {
  return toRecipients(database.prepare(`
    SELECT id, email, username, locale FROM users
     WHERE status = 'active' AND is_admin = 1
     ORDER BY username
  `).all() as RecipientRow[]);
}

/**
 * Everyone who can see `repositoryKey` and has an address: every active
 * administrator, plus every active account with any grant on it. Any grant is
 * `viewer` or above by construction, so the role does not have to be compared.
 *
 * One statement, and `UNION` rather than two queries, so a repository shared with
 * two hundred people is still one round trip and cannot return the same
 * administrator twice.
 */
export function repositoryRecipients(
  repositoryKey: string | null,
  database: Database.Database = getDb(),
): EmailRecipient[] {
  if (repositoryKey === null) return adminRecipients(database);
  return toRecipients(database.prepare(`
    SELECT id, email, username, locale FROM users
     WHERE status = 'active'
       AND (is_admin = 1 OR id IN (SELECT user_id FROM repository_grants WHERE repository_key = ?))
     ORDER BY username
  `).all(repositoryKey) as RecipientRow[]);
}

/**
 * Whether this account, right now, still sees this repository. The question the
 * worker asks before it hands a queued repository message to the provider: a
 * grant removed while the message waited must stop it, and the design says the
 * subscription row itself survives in case the access comes back.
 */
export function userSeesRepository(
  userId: string,
  repositoryKey: string,
  database: Database.Database = getDb(),
): boolean {
  const user = database.prepare("SELECT is_admin, status FROM users WHERE id = ?")
    .get(userId) as { is_admin: number; status: string } | undefined;
  if (user === undefined || user.status !== "active") return false;
  if (user.is_admin === 1) return true;
  return database.prepare("SELECT 1 FROM repository_grants WHERE user_id = ? AND repository_key = ?")
    .get(userId, repositoryKey) !== undefined;
}

/** The caller's own grant on a repository, or `null` when they have none. */
export function userRepositoryRole(
  userId: string,
  repositoryKey: string,
  database: Database.Database = getDb(),
): RepositoryRole | null {
  const row = database.prepare("SELECT role FROM repository_grants WHERE user_id = ? AND repository_key = ?")
    .get(userId, repositoryKey) as { role: RepositoryRole } | undefined;
  return row?.role ?? null;
}
