import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { describeUserAgent } from "@csb/shared";
import type { UserRecord } from "../auth/user-store.js";
import { localeOf, resolveUserEmailAddress } from "./address.js";
import { enqueueEmail } from "./enqueue.js";
import type { EmailMessageDataMap } from "./templates.js";

/**
 * The account events, which every user receives and nobody can switch off: a
 * lock, a password change, a sign-in from somewhere new. They are security
 * notices, not notifications, which is why there is no subscription to consult
 * and why failing to queue one must never be allowed to fail the thing it is
 * reporting — a login that succeeded stays successful even if the alert about it
 * could not be written.
 */
export type AccountEventKind = "account.locked" | "account.password_changed" | "account.new_login";

/**
 * How far back a familiar (address, browser) pair is remembered, and therefore
 * how long a device can go unused before it looks new again.
 */
export const NEW_LOGIN_HISTORY_DAYS = 90;

/**
 * Whether this sign-in deserves an alert: the account has signed in before, and
 * this (address, browser) pair is in none of its sessions from the window.
 *
 * The very first sign-in of an account never alerts — there is nothing to compare
 * it to, and telling someone their brand-new account was just used by them is
 * noise. "Previous session" means any session ever, so an account whose last
 * sign-in predates the window is recognised as an old account rather than a new
 * one, and its return does produce the alert.
 *
 * Must be asked *before* the new session is written, or it would find itself.
 */
export function isUnfamiliarLogin(
  database: Database.Database,
  userId: string,
  input: { ip: string | null; userAgent: string | null; now: Date },
): boolean {
  const ever = database.prepare("SELECT 1 FROM sessions WHERE user_id = ? LIMIT 1").get(userId);
  if (ever === undefined) return false;
  const since = new Date(input.now.getTime() - NEW_LOGIN_HISTORY_DAYS * 24 * 3_600_000).toISOString();
  const rows = database.prepare("SELECT ip, user_agent FROM sessions WHERE user_id = ? AND created_at >= ?")
    .all(userId, since) as Array<{ ip: string | null; user_agent: string | null }>;
  // The same truncation `createSession` applies, so a 300-character agent is
  // compared against what was actually stored and not against its full form.
  const ip = input.ip?.slice(0, 64) ?? null;
  const browser = describeUserAgent(input.userAgent?.slice(0, 300) ?? null);
  return !rows.some((row) => row.ip === ip && describeUserAgent(row.user_agent) === browser);
}

/** The browser summary the alert shows, the same one the session list shows. */
export function loginBrowser(userAgent: string | null): string | null {
  return describeUserAgent(userAgent?.slice(0, 300) ?? null);
}

/** At most one new-sign-in alert per account per hour, whatever happens. */
export const NEW_LOGIN_MIN_INTERVAL_MS = 3_600_000;

/**
 * The dedupe reference for a new sign-in: the UTC day, and a digest of the
 * (address, browser) pair.
 *
 * A digest rather than the values themselves, for two reasons. The pair is
 * partly client-chosen — a user agent is whatever the caller typed — so it must
 * not decide the length or the shape of a key that has a UNIQUE index on it. And
 * a `dedupe_key` is a column an administrator's tooling may end up reading,
 * which is no place for a recipient's address.
 *
 * Per day, so the same laptop on a dynamic address cannot alert twice on Tuesday
 * but a genuinely new Wednesday still does.
 */
export function newLoginReference(input: { ip: string | null; userAgent: string | null; now: Date }): string {
  const digest = createHash("sha256")
    .update(`${input.ip ?? ""}\n${loginBrowser(input.userAgent) ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `${input.now.toISOString().slice(0, 10)}.${digest}`;
}

/**
 * Queues `account.new_login`, twice guarded against being a nuisance.
 *
 * The unique key stops the same device on the same day producing a second
 * message, and the hourly cap stops a caller that varies its user agent — which
 * it is free to do — turning a security alert into a way to fill someone's inbox.
 * Dropping the fifth alert in an hour costs nothing: the first one already said
 * "someone is signing in from somewhere new", and Minha conta lists the rest.
 */
export function notifyNewLogin(
  database: Database.Database,
  user: UserRecord,
  input: { ip: string | null; userAgent: string | null; now: Date },
): void {
  try {
    const since = new Date(input.now.getTime() - NEW_LOGIN_MIN_INTERVAL_MS).toISOString();
    const recent = database.prepare(`
      SELECT 1 FROM email_outbox
       WHERE user_id = ? AND event = 'account.new_login' AND created_at >= ?
       LIMIT 1
    `).get(user.id, since);
    if (recent !== undefined) return;
  } catch (error) {
    // Unreadable outbox: the enqueue below will fail the same way and report it.
    void error;
  }
  notifyAccountEvent(database, user, {
    kind: "account.new_login",
    data: { at: input.now, ip: input.ip, browser: loginBrowser(input.userAgent) },
    reference: newLoginReference(input),
    now: input.now,
  });
}

/**
 * Queues one account event, or gives up quietly. Every failure path — no address
 * on file, e-mail switched off, a duplicate, a broken vault — ends here rather
 * than in the caller, because the caller is a login or a password change and the
 * notification is the least important thing it is doing.
 */
export function notifyAccountEvent<K extends AccountEventKind>(
  database: Database.Database,
  user: UserRecord,
  event: { kind: K; data: EmailMessageDataMap[K]; reference: string; now: Date },
): void {
  try {
    const to = resolveUserEmailAddress(user);
    if (to === null) return;
    enqueueEmail(database, {
      event: event.kind,
      dedupeKey: `account.${user.id}.${event.kind.slice("account.".length)}.${event.reference}`,
      userId: user.id,
      toAddress: to,
      locale: localeOf(user),
      data: event.data,
      // The event's own time, not the wall clock: `created_at` is what the
      // hourly cap and the history are read against, and a notification queued
      // for a login must agree with the login about when it happened.
      now: event.now,
    });
  } catch (error) {
    // Named by event and account, never by address or body.
    console.warn(
      `[csb-api] Could not queue ${event.kind} for ${user.id}: `
        + `${error instanceof Error ? error.message : "unknown_error"}`,
    );
  }
}
