import type Database from "better-sqlite3";
import { getDb } from "../db.js";

/**
 * `ops_alert_state`: what the installation remembers about each operational
 * condition it has alerted on.
 *
 * Persisted rather than in-memory because the design's noise control is measured
 * in hours — "no máximo um por (evento, alvo) a cada 6 horas enquanto a condição
 * persistir" — and a restart in the middle of a three-hour outage must not start
 * that window over. One row per `(event, target)`, replaced when a new episode
 * begins, so the table stays the size of the installation and not of its history.
 */

export interface OpsAlertState {
  event: string;
  /** What the condition is about: `engine`, a connection id, a gate id. */
  target: string;
  /** When the current episode started; the six-hour window is measured from here. */
  activeSince: string;
  /** When the last alert about this episode went out, or `null` if none has. */
  lastSentAt: string | null;
  /** When the condition ended, or `null` while it persists. */
  resolvedAt: string | null;
}

interface Row {
  event: string;
  target: string;
  active_since: string;
  last_sent_at: string | null;
  resolved_at: string | null;
}

function toState(row: Row): OpsAlertState {
  return {
    event: row.event,
    target: row.target,
    activeSince: row.active_since,
    lastSentAt: row.last_sent_at,
    resolvedAt: row.resolved_at,
  };
}

export function getOpsAlertState(
  event: string,
  target: string,
  database: Database.Database = getDb(),
): OpsAlertState | null {
  const row = database.prepare(
    "SELECT event, target, active_since, last_sent_at, resolved_at FROM ops_alert_state WHERE event = ? AND target = ?",
  ).get(event, target) as Row | undefined;
  return row === undefined ? null : toState(row);
}

/**
 * The targets this installation is still watching for one event. The evaluator
 * reads them to find the conditions that have *ended*: a connection that went
 * back to ready no longer appears in any list of broken ones, so the only record
 * that it was ever broken is this table.
 */
export function listUnresolvedOpsAlerts(
  event: string,
  database: Database.Database = getDb(),
): OpsAlertState[] {
  return (database.prepare(`
    SELECT event, target, active_since, last_sent_at, resolved_at
      FROM ops_alert_state WHERE event = ? AND resolved_at IS NULL ORDER BY target
  `).all(event) as Row[]).map(toState);
}

/**
 * Whether this installation is watching any condition at all, for any event.
 *
 * The evaluator asks before it does anything expensive: with e-mail off and no
 * open episode there is nothing a pass could produce and nothing it could close,
 * so the scanner probe and the per-condition writes are pure cost. One indexed
 * read replaces them.
 */
export function hasUnresolvedOpsAlerts(database: Database.Database = getDb()): boolean {
  return database.prepare("SELECT 1 FROM ops_alert_state WHERE resolved_at IS NULL LIMIT 1")
    .get() !== undefined;
}

export function putOpsAlertState(
  state: OpsAlertState,
  database: Database.Database = getDb(),
): void {
  database.prepare(`
    INSERT INTO ops_alert_state (event, target, active_since, last_sent_at, resolved_at)
    VALUES (@event, @target, @active_since, @last_sent_at, @resolved_at)
    ON CONFLICT(event, target) DO UPDATE SET
      active_since = excluded.active_since,
      last_sent_at = excluded.last_sent_at,
      resolved_at = excluded.resolved_at
  `).run({
    event: state.event,
    target: state.target,
    active_since: state.activeSince,
    last_sent_at: state.lastSentAt,
    resolved_at: state.resolvedAt,
  });
}

/**
 * Drops the closed episodes nobody will read again. A resolved row only exists so
 * the next sample can tell "this is over" from "this never started"; once it is
 * older than the repeat window it can no longer affect either, and the one table
 * next to the outbox without a retention rule would otherwise grow with every gate
 * that ever failed to publish.
 */
export function deleteResolvedOpsAlertsBefore(
  before: Date,
  database: Database.Database = getDb(),
): number {
  return database.prepare(
    "DELETE FROM ops_alert_state WHERE resolved_at IS NOT NULL AND resolved_at < ?",
  ).run(before.toISOString()).changes;
}

/**
 * Forgets a condition nobody was ever told about. A blip that started and ended
 * inside one evaluation window leaves no alert and therefore needs no resolution
 * message and no row.
 */
export function deleteOpsAlertState(
  event: string,
  target: string,
  database: Database.Database = getDb(),
): void {
  database.prepare("DELETE FROM ops_alert_state WHERE event = ? AND target = ?").run(event, target);
}
