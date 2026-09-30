import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { getDb } from "../db.js";
import {
  GITHUB_ACTIONS_SCHEMA_SQL,
  MAX_BRANCH_PATTERNS,
  gitHubActionEventTargetIdentity,
} from "./schema.js";

/**
 * Steps run strictly above the recorded version, so a column added later reaches
 * a database that already recorded an earlier one. Version 1 mints the tables and
 * carries the monitor rules over; version 2 adds `migration_note`.
 *
 * SQLite cannot add a `CHECK` through `ALTER TABLE`, so the two constraints
 * introduced with version 2 — `json_array_length(branch_patterns_json) BETWEEN 1
 * AND 20` and the `migration_note` length cap — guard freshly created databases
 * only. On an upgraded database the same bounds are the store's validation
 * (`assertBranchPatterns`) and the migration's own `clampBranchPatterns`. Adding
 * them for real would mean rebuilding the table, which is not worth a lock on a
 * live database for an invariant two code paths already keep.
 */
export const GITHUB_ACTIONS_SCHEMA_VERSION = 2;

/** The ceiling a rule that was never activated inherits, disabled, so it cannot spend. */
const MIGRATED_COST_CEILING_USD = 1;

/**
 * Statuses the legacy dispatcher could still have acted on. An event of an
 * abandoned revision in one of these was permanently dead
 * (`github-monitor/service.ts:354`) and must not come back to life.
 */
const NON_TERMINAL_STATUSES = new Set(["observed", "queued", "dispatching"]);

/** A handle whose schema is known current, so reads do not re-probe on every call. */
const migratedHandles = new WeakSet<Database.Database>();

export interface MonitorRuleMigrationResult {
  /** Actions created out of monitor rules: two per migrated rule. */
  actions: number;
  /** Monitor events carried over, with their gate and dates. */
  events: number;
  /** Legacy rows that produced nothing: a dangling repository, or a collapsed event identity. */
  skipped: number;
}

interface LegacyRuleRow {
  id: string;
  repository_key: string;
  connection_id: string;
  installation_id: string;
  repository_id: string;
  executor: string;
  scanner_json: string | null;
  cost_ceiling_usd: number | null;
  daily_cost_ceiling_usd: number | null;
  follow_branches_json: string;
  enabled: number;
  revision: number;
  baseline_initialized_at: string | null;
  last_polled_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface LegacyEventRow {
  id: string;
  rule_id: string;
  repository_key: string;
  rule_revision: number;
  kind: string;
  status: string;
  head_sha: string;
  base_ref: string | null;
  head_ref: string;
  pull_request_number: number | null;
  title: string | null;
  gate_id: string | null;
  cost_ceiling_usd: number | null;
  reason: string | null;
  error: string | null;
  detected_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
}

const LEGACY_TABLES = [
  "github_monitor_rules",
  "github_monitor_events",
  "github_monitor_actions_runs",
  "github_monitor_poll_leases",
];

/**
 * One monitor rule watched pull requests and pushes at once, with a single set of
 * followed branches and an optional ceiling. Two actions say the same thing and
 * can then diverge. The legacy tables are renamed rather than dropped, so a
 * rollback keeps the rows; phase 5 removes them.
 */
export function migrateMonitorRulesToActions(
  database: Database.Database = getDb(),
  now: string = new Date().toISOString(),
): MonitorRuleMigrationResult {
  if (alreadyMigrated(database)) return { actions: 0, events: 0, skipped: 0 };
  const result = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS github_actions_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const from = recordedVersion(database);
    if (from >= GITHUB_ACTIONS_SCHEMA_VERSION) return { actions: 0, events: 0, skipped: 0 };
    database.exec(GITHUB_ACTIONS_SCHEMA_SQL);
    let carried: MonitorRuleMigrationResult = { actions: 0, events: 0, skipped: 0 };
    if (from < 1) {
      carried = carryMonitorRulesOver(database, now);
      renameLegacyTables(database);
    }
    if (from < 2) {
      // A fresh database already has it from the DDL above; one created by the
      // previous release does not, and short-circuiting on version 1 would leave
      // every insert failing on a column that never appeared.
      addColumnIfMissing(database, "github_actions", "migration_note", "TEXT");
    }
    database.prepare(`
      INSERT OR REPLACE INTO github_actions_schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(GITHUB_ACTIONS_SCHEMA_VERSION, "actions model with migration notes", now);
    return carried;
  }).immediate();
  migratedHandles.add(database);
  return result;
}

/**
 * Undoes the rename so a release rolled back to the poller finds its rules where
 * it left them. Without it, `ensureGitHubMonitorSchema` recreates the four tables
 * *empty* on its first call and the operator's automation stops firing in silence.
 *
 * It discards the actions model, which is the meaning of rolling back to a schema
 * that had none: actions created after the migration, their events and the
 * delivery log go, and the counts say how many. It therefore refuses outright
 * unless at least one `_migrated` table is still there to restore — after phase 5
 * removes them this procedure has expired, and running it would destroy the
 * automation it exists to protect with nothing to fall back on.
 */
export function rollbackGitHubActionsMigration(
  database: Database.Database = getDb(),
): {
  restored: string[];
  discardedActions: number;
  discardedEvents: number;
  discardedDeliveries: number;
} {
  return database.transaction(() => {
    // Before any DROP: nothing to restore means nothing to roll back to.
    if (!LEGACY_TABLES.some((table) => tableExists(database, `${table}_migrated`))) {
      throw new Error("github_actions_rollback_unavailable");
    }
    const discardedActions = countRows(database, "github_actions");
    const discardedEvents = countRows(database, "github_action_events");
    const discardedDeliveries = countRows(database, "github_webhook_deliveries");
    const restored: string[] = [];
    for (const table of LEGACY_TABLES) {
      const source = `${table}_migrated`;
      if (!tableExists(database, source)) continue;
      // Whatever the rolled-back release recreated is empty and in the way.
      database.exec(`DROP TABLE IF EXISTS ${table}`);
      database.exec(`ALTER TABLE ${source} RENAME TO ${table}`);
      restored.push(table);
    }
    database.exec(`
      DROP TABLE IF EXISTS github_action_events;
      DROP TABLE IF EXISTS github_actions;
      DROP TABLE IF EXISTS github_webhook_deliveries;
      DROP TABLE IF EXISTS github_actions_schema_migrations;
    `);
    migratedHandles.delete(database);
    return { restored, discardedActions, discardedEvents, discardedDeliveries };
  }).immediate();
}

/**
 * Read-only probe so the schema guard on every store call does not open a write
 * transaction once the migration is behind us, memoized per handle so the two
 * probes are not re-prepared on every read either.
 */
function alreadyMigrated(database: Database.Database): boolean {
  if (migratedHandles.has(database)) return true;
  if (!tableExists(database, "github_actions_schema_migrations")) return false;
  if (recordedVersion(database) < GITHUB_ACTIONS_SCHEMA_VERSION) return false;
  migratedHandles.add(database);
  return true;
}

/** The forward path for a column: every later one follows this shape. */
function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((entry) => entry.name),
  );
  if (columns.has(column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function countRows(database: Database.Database, table: string): number {
  if (!tableExists(database, table)) return 0;
  return (database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;
}

function recordedVersion(database: Database.Database): number {
  const row = database
    .prepare("SELECT max(version) AS version FROM github_actions_schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}

function carryMonitorRulesOver(
  database: Database.Database,
  now: string,
): MonitorRuleMigrationResult {
  if (!tableExists(database, "github_monitor_rules")) {
    return { actions: 0, events: 0, skipped: 0 };
  }
  const legacyEvents = tableExists(database, "github_monitor_events");
  const rules = database.prepare("SELECT * FROM github_monitor_rules").all() as LegacyRuleRow[];
  const insertAction = database.prepare(`
    INSERT INTO github_actions (
      id, repository_key, name, trigger_kind, branch_patterns_json, executor,
      connection_id, installation_id, repository_id, scanner_json,
      cost_ceiling_usd, daily_cost_ceiling_usd, enabled, revision,
      baseline_initialized_at, created_by, last_event_at, last_reconciled_at,
      last_error, migration_note, created_at, updated_at
    ) VALUES (
      @id, @repository_key, @name, @trigger_kind, @branch_patterns_json, @executor,
      @connection_id, @installation_id, @repository_id, @scanner_json,
      @cost_ceiling_usd, @daily_cost_ceiling_usd, @enabled, 1,
      @baseline_initialized_at, NULL, NULL, @last_reconciled_at,
      @last_error, @migration_note, @created_at, @updated_at
    )
  `);
  const insertEvent = database.prepare(`
    INSERT OR IGNORE INTO github_action_events (
      id, action_id, repository_key, action_revision, origin, delivery_id, kind,
      status, head_sha, base_ref, head_ref, pull_request_number, target_identity,
      title, gate_id, cost_ceiling_usd, reason, error, detected_at, dispatched_at,
      completed_at
    ) VALUES (
      @id, @action_id, @repository_key, 1, 'reconciliation', NULL, @kind,
      @status, @head_sha, @base_ref, @head_ref, @pull_request_number, @target_identity,
      @title, @gate_id, @cost_ceiling_usd, @reason, @error, @detected_at, @dispatched_at,
      @completed_at
    )
  `);
  const repositoryExists = database.prepare(
    "SELECT 1 FROM guardrail_repositories WHERE repository_key = ?",
  );

  let actions = 0;
  let events = 0;
  let skipped = 0;
  for (const rule of rules) {
    const rows = legacyEvents
      ? database.prepare(
        "SELECT * FROM github_monitor_events WHERE rule_id = ? ORDER BY detected_at ASC, id ASC",
      ).all(rule.id) as LegacyEventRow[]
      : [];
    if (repositoryExists.get(rule.repository_key) === undefined) {
      skipped += 1 + rows.length;
      continue;
    }
    const withoutCeiling = rule.cost_ceiling_usd === null || rule.cost_ceiling_usd <= 0;
    const patterns = clampBranchPatterns(rule.follow_branches_json);
    const actionIds = new Map<string, string>();
    for (const [triggerKind, name] of [["pull_request", "PR"], ["push", "Push"]] as const) {
      const id = randomUUID();
      insertAction.run({
        id,
        repository_key: rule.repository_key,
        name,
        trigger_kind: triggerKind,
        branch_patterns_json: JSON.stringify(patterns.patterns),
        executor: rule.executor,
        connection_id: rule.connection_id,
        installation_id: rule.installation_id,
        repository_id: rule.repository_id,
        scanner_json: rule.scanner_json,
        cost_ceiling_usd: withoutCeiling ? MIGRATED_COST_CEILING_USD : rule.cost_ceiling_usd,
        daily_cost_ceiling_usd: rule.daily_cost_ceiling_usd,
        enabled: withoutCeiling || patterns.note !== null ? 0 : rule.enabled,
        baseline_initialized_at: rule.baseline_initialized_at,
        last_reconciled_at: rule.last_polled_at,
        last_error: withoutCeiling ? "migrated_without_ceiling" : rule.last_error,
        migration_note: patterns.note,
        created_at: rule.created_at,
        updated_at: now,
      });
      actionIds.set(triggerKind, id);
      actions += 1;
    }
    for (const row of rows) {
      const actionId = actionIds.get(row.kind);
      if (actionId === undefined) {
        skipped += 1;
        continue;
      }
      // Every migrated event lands at action_revision 1, which is the new action's
      // live revision. A non-terminal event of a revision the legacy dispatcher had
      // already abandoned would therefore be picked up and paid for; it ends here
      // instead, with its history intact and its place in the queue gone.
      const abandoned = row.rule_revision !== rule.revision && NON_TERMINAL_STATUSES.has(row.status);
      const inserted = insertEvent.run({
        id: row.id,
        action_id: actionId,
        repository_key: row.repository_key,
        kind: row.kind,
        status: abandoned ? "superseded" : row.status,
        head_sha: row.head_sha,
        base_ref: row.base_ref,
        head_ref: row.head_ref,
        pull_request_number: row.pull_request_number,
        target_identity: migratedTargetIdentity(row),
        title: row.title,
        gate_id: row.gate_id,
        cost_ceiling_usd: row.cost_ceiling_usd,
        reason: abandoned ? "migrated_stale_revision" : row.reason,
        error: row.error,
        detected_at: row.detected_at,
        dispatched_at: row.dispatched_at,
        completed_at: abandoned ? row.completed_at ?? now : row.completed_at,
      });
      if (inserted.changes === 1) events += 1;
      else skipped += 1;
    }
    for (const actionId of actionIds.values()) {
      database.prepare(`
        UPDATE github_actions SET last_event_at = (
          SELECT max(detected_at) FROM github_action_events WHERE action_id = @action_id
        ) WHERE id = @action_id
      `).run({ action_id: actionId });
    }
  }
  return { actions, events, skipped };
}

/**
 * The legacy identity was a JSON tuple; the new one is the readable key the
 * webhook handler and the reconciliation both mint. Recomputing it with the same
 * function keeps one formula in the product instead of two eras of keys in the
 * same column. A legacy pull-request row without a number could not be keyed the
 * new way at all, so it is keyed as the push it effectively was.
 */
function migratedTargetIdentity(row: LegacyEventRow): string {
  const kind = row.kind === "pull_request" && row.pull_request_number !== null ? "pull_request" : "push";
  return gitHubActionEventTargetIdentity({
    kind,
    headSha: row.head_sha,
    headRef: row.head_ref,
    pullRequestNumber: row.pull_request_number,
  });
}

/**
 * The legacy validator allowed fifty followed branches; an action holds twenty.
 * Migrating twenty-five would create a row that fails its own validation, which an
 * operator could then never rename, re-ceiling or even disable through the
 * interface — frozen and firing. The extras are dropped into a note the screen can
 * read, and the action arrives disabled so the operator decides what survives.
 */
function clampBranchPatterns(followBranchesJson: string): { patterns: string[]; note: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(followBranchesJson);
  } catch {
    parsed = [];
  }
  const patterns = (Array.isArray(parsed) ? parsed : [])
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (patterns.length === 0) {
    return { patterns: ["*"], note: "migrated_pattern_missing" };
  }
  if (patterns.length <= MAX_BRANCH_PATTERNS) return { patterns, note: null };
  const dropped = patterns.slice(MAX_BRANCH_PATTERNS);
  const note = `migrated_pattern_overflow: ${dropped.join(", ")}`;
  return {
    patterns: patterns.slice(0, MAX_BRANCH_PATTERNS),
    note: note.length <= 500 ? note : `${note.slice(0, 497)}...`,
  };
}

function renameLegacyTables(database: Database.Database): void {
  for (const table of LEGACY_TABLES) {
    const target = `${table}_migrated`;
    if (!tableExists(database, table) || tableExists(database, target)) continue;
    database.exec(`ALTER TABLE ${table} RENAME TO ${target}`);
  }
}

function tableExists(database: Database.Database, name: string): boolean {
  return database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) !== undefined;
}
