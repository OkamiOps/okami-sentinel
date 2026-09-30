import type Database from "better-sqlite3";
import {
  isNotificationEvent,
  NOTIFICATION_DEFAULTS,
  OPS_NOTIFICATION_SCOPE,
  type NotificationEvent,
} from "@csb/shared";
import { getDb } from "../db.js";

/**
 * `notification_subscriptions` holds only the cells somebody changed. The
 * absence of a row is the design's default for that event, which is why every
 * read goes through here instead of through a `SELECT` that would silently treat
 * "never chosen" as "off".
 */

export interface NotificationSubscriptionRow {
  scope: string;
  event: NotificationEvent;
  enabled: boolean;
}

/** Every stored override for one account, defaults excluded because they are not rows. */
export function listUserSubscriptions(
  userId: string,
  database: Database.Database = getDb(),
): NotificationSubscriptionRow[] {
  return (database.prepare(
    "SELECT scope, event, enabled FROM notification_subscriptions WHERE user_id = ? ORDER BY scope, event",
  ).all(userId) as Array<{ scope: string; event: string; enabled: number }>)
    .filter((row): row is { scope: string; event: NotificationEvent; enabled: number } =>
      isNotificationEvent(row.event))
    .map((row) => ({ scope: row.scope, event: row.event, enabled: row.enabled === 1 }));
}

/**
 * The override map for one account, keyed `<scope>\n<event>`. A newline because
 * neither a repository key nor an event id can contain one, so the composite key
 * cannot be forged by a key that merely looks like two.
 */
export function subscriptionOverrides(
  userId: string,
  database: Database.Database = getDb(),
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const row of listUserSubscriptions(userId, database)) {
    map.set(`${row.scope}\n${row.event}`, row.enabled);
  }
  return map;
}

/** Whether this account wants this event on this scope, defaults applied. */
export function isSubscribed(
  userId: string,
  scope: string,
  event: NotificationEvent,
  database: Database.Database = getDb(),
): boolean {
  const row = database.prepare(
    "SELECT enabled FROM notification_subscriptions WHERE user_id = ? AND scope = ? AND event = ?",
  ).get(userId, scope, event) as { enabled: number } | undefined;
  return row === undefined ? NOTIFICATION_DEFAULTS[event] : row.enabled === 1;
}

/**
 * Writes one cell. A value equal to the default still becomes a row: "I chose
 * this" and "I never looked" are different facts, and only the first one survives
 * a later change to the defaults table.
 */
export function setSubscription(
  userId: string,
  scope: string,
  event: NotificationEvent,
  enabled: boolean,
  database: Database.Database = getDb(),
): void {
  database.prepare(`
    INSERT INTO notification_subscriptions (user_id, scope, event, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, scope, event) DO UPDATE SET enabled = excluded.enabled
  `).run(userId, scope, event, enabled ? 1 : 0);
}

/**
 * Applies a batch atomically. Either the whole screen's change is stored or none
 * of it is: half a matrix is a state the user did not ask for and cannot see.
 */
export function replaceSubscriptions(
  userId: string,
  entries: ReadonlyArray<{ scope: string; event: NotificationEvent; enabled: boolean }>,
  database: Database.Database = getDb(),
): void {
  database.transaction(() => {
    for (const entry of entries) setSubscription(userId, entry.scope, entry.event, entry.enabled, database);
  })();
}

/**
 * The account ids that want `event` on `scope`, out of the candidates given.
 *
 * Asked with the candidate list rather than against the whole `users` table
 * because who *may* receive a repository event is an access question answered
 * elsewhere; this function only applies the preference. One statement per call,
 * so a repository with two hundred viewers is one query and not two hundred.
 */
export function subscribedUserIds(
  candidateUserIds: readonly string[],
  scope: string,
  event: NotificationEvent,
  database: Database.Database = getDb(),
): string[] {
  if (candidateUserIds.length === 0) return [];
  const placeholders = candidateUserIds.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT user_id, enabled FROM notification_subscriptions
     WHERE scope = ? AND event = ? AND user_id IN (${placeholders})
  `).all(scope, event, ...candidateUserIds) as Array<{ user_id: string; enabled: number }>;
  const overrides = new Map(rows.map((row) => [row.user_id, row.enabled === 1]));
  return candidateUserIds.filter((id) => overrides.get(id) ?? NOTIFICATION_DEFAULTS[event]);
}

/** The scope value the operational row uses, re-exported so callers need one import. */
export const OPS_SCOPE = OPS_NOTIFICATION_SCOPE;
