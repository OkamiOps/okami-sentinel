import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type {
  GitHubMonitorActionsRun,
  GitHubMonitorEvent,
  GitHubMonitorEventStatus,
  GitHubMonitorRule,
} from "@csb/shared";

import { getDb } from "../db.js";

interface RuleRow {
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
  checkout_mode: string;
  enabled: number;
  revision: number;
  baseline_initialized_at: string | null;
  last_polled_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
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

interface ActionsRunRow {
  id: string;
  rule_id: string;
  repository_key: string;
  workflow_run_id: string;
  name: string;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  url: string;
  created_at: string;
  updated_at: string;
}

export type GitHubMonitorRuleCreate = Omit<GitHubMonitorRule,
  "id" | "revision" | "baselineInitializedAt" | "lastPolledAt" | "lastError" | "createdAt" | "updatedAt">;

export interface GitHubMonitorRulePatch {
  executor?: GitHubMonitorRule["executor"];
  scanner?: GitHubMonitorRule["scanner"];
  costCeilingUsd?: number | null;
  dailyCostCeilingUsd?: number | null;
  followBranches?: string[];
  checkoutMode?: GitHubMonitorRule["checkoutMode"];
  enabled?: boolean;
}

export interface GitHubMonitorEventCreate extends Omit<GitHubMonitorEvent,
  "id" | "status" | "gateId" | "reason" | "error" | "dispatchedAt" | "completedAt"> {
  status?: GitHubMonitorEventStatus;
  gateId?: string | null;
  reason?: string | null;
  error?: string | null;
  dispatchedAt?: string | null;
  completedAt?: string | null;
}

export interface GitHubMonitorEventPatch {
  status?: GitHubMonitorEventStatus;
  gateId?: string | null;
  reason?: string | null;
  error?: string | null;
  dispatchedAt?: string | null;
  completedAt?: string | null;
}

/** SQLite persistence kept independent from gate schema migration history. */
export function ensureGitHubMonitorSchema(database: Database.Database = getDb()): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS github_monitor_rules (
      id TEXT PRIMARY KEY,
      repository_key TEXT NOT NULL UNIQUE,
      connection_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      executor TEXT NOT NULL DEFAULT 'sentinel-managed',
      scanner_json TEXT,
      cost_ceiling_usd REAL,
      daily_cost_ceiling_usd REAL,
      follow_branches_json TEXT NOT NULL,
      checkout_mode TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      baseline_initialized_at TEXT,
      last_polled_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (checkout_mode IN ('none', 'fetch', 'pull')),
      CHECK (executor IN ('sentinel-managed', 'github-actions')),
      CHECK (enabled IN (0, 1)),
      CHECK (revision >= 1),
      CHECK (cost_ceiling_usd IS NULL OR cost_ceiling_usd > 0),
      CHECK (daily_cost_ceiling_usd IS NULL OR daily_cost_ceiling_usd > 0)
    );

    CREATE TABLE IF NOT EXISTS github_monitor_events (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      repository_key TEXT NOT NULL,
      rule_revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_ref TEXT,
      head_ref TEXT NOT NULL,
      pull_request_number INTEGER,
      title TEXT,
      gate_id TEXT,
      cost_ceiling_usd REAL,
      reason TEXT,
      error TEXT,
      detected_at TEXT NOT NULL,
      dispatched_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (rule_id) REFERENCES github_monitor_rules(id) ON DELETE CASCADE,
      CHECK (kind IN ('pull_request', 'push')),
      CHECK (status IN ('observed', 'queued', 'dispatching', 'launched', 'skipped', 'failed')),
      CHECK (length(head_sha) = 40),
      CHECK (pull_request_number IS NULL OR pull_request_number > 0),
      UNIQUE (repository_key, head_sha, rule_revision)
    );
    CREATE INDEX IF NOT EXISTS github_monitor_events_by_rule_status
      ON github_monitor_events(rule_id, status, detected_at ASC);
    CREATE INDEX IF NOT EXISTS github_monitor_events_by_repository_day
      ON github_monitor_events(repository_key, detected_at DESC);

    CREATE TABLE IF NOT EXISTS github_monitor_actions_runs (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      repository_key TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      event TEXT NOT NULL,
      head_branch TEXT,
      head_sha TEXT NOT NULL,
      status TEXT NOT NULL,
      conclusion TEXT,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (rule_id) REFERENCES github_monitor_rules(id) ON DELETE CASCADE,
      UNIQUE (rule_id, workflow_run_id)
    );
    CREATE INDEX IF NOT EXISTS github_monitor_actions_runs_by_rule_updated
      ON github_monitor_actions_runs(rule_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS github_monitor_poll_leases (
      rule_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (rule_id) REFERENCES github_monitor_rules(id) ON DELETE CASCADE
    );
  `);
  const columns = new Set((database.prepare("PRAGMA table_info(github_monitor_rules)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("executor")) {
    database.exec("ALTER TABLE github_monitor_rules ADD COLUMN executor TEXT NOT NULL DEFAULT 'sentinel-managed'");
  }
}

export function createGitHubMonitorRule(
  input: GitHubMonitorRuleCreate,
  database: Database.Database = getDb(),
  now = new Date().toISOString(),
  id = randomUUID(),
): GitHubMonitorRule {
  ensureGitHubMonitorSchema(database);
  database.prepare(`
    INSERT INTO github_monitor_rules (
      id, repository_key, connection_id, installation_id, repository_id, executor,
      scanner_json, cost_ceiling_usd, daily_cost_ceiling_usd, follow_branches_json,
      checkout_mode, enabled, revision, baseline_initialized_at, last_polled_at,
      last_error, created_at, updated_at
    ) VALUES (
      @id, @repository_key, @connection_id, @installation_id, @repository_id, @executor,
      @scanner_json, @cost_ceiling_usd, @daily_cost_ceiling_usd, @follow_branches_json,
      @checkout_mode, @enabled, 1, NULL, NULL, NULL, @created_at, @updated_at
    )
  `).run(ruleCreateParams(input, id, now));
  return getGitHubMonitorRule(id, database)!;
}

export function getGitHubMonitorRule(
  id: string,
  database: Database.Database = getDb(),
): GitHubMonitorRule | null {
  ensureGitHubMonitorSchema(database);
  const row = database.prepare("SELECT * FROM github_monitor_rules WHERE id = ?").get(id) as RuleRow | undefined;
  return row ? rowToRule(row) : null;
}

export function getGitHubMonitorRuleByRepository(
  repositoryKey: string,
  database: Database.Database = getDb(),
): GitHubMonitorRule | null {
  ensureGitHubMonitorSchema(database);
  const row = database.prepare("SELECT * FROM github_monitor_rules WHERE repository_key = ?").get(repositoryKey) as RuleRow | undefined;
  return row ? rowToRule(row) : null;
}

export function listGitHubMonitorRules(
  repositoryKey: string | null = null,
  database: Database.Database = getDb(),
): GitHubMonitorRule[] {
  ensureGitHubMonitorSchema(database);
  const rows = repositoryKey === null
    ? database.prepare("SELECT * FROM github_monitor_rules ORDER BY updated_at DESC, id DESC").all()
    : database.prepare("SELECT * FROM github_monitor_rules WHERE repository_key = ? ORDER BY updated_at DESC, id DESC").all(repositoryKey);
  return (rows as RuleRow[]).map(rowToRule);
}

export function patchGitHubMonitorRule(
  id: string,
  patch: GitHubMonitorRulePatch,
  database: Database.Database = getDb(),
  now = new Date().toISOString(),
): GitHubMonitorRule | null {
  const current = getGitHubMonitorRule(id, database);
  if (current === null) return null;
  const next: GitHubMonitorRule = {
    ...current,
    ...(patch.executor !== undefined ? { executor: patch.executor } : {}),
    ...(patch.scanner !== undefined ? { scanner: patch.scanner } : {}),
    ...(patch.costCeilingUsd !== undefined ? { costCeilingUsd: patch.costCeilingUsd } : {}),
    ...(patch.dailyCostCeilingUsd !== undefined ? { dailyCostCeilingUsd: patch.dailyCostCeilingUsd } : {}),
    ...(patch.followBranches !== undefined ? { followBranches: patch.followBranches } : {}),
    ...(patch.checkoutMode !== undefined ? { checkoutMode: patch.checkoutMode } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  };
  const changed = JSON.stringify(ruleComparable(current)) !== JSON.stringify(ruleComparable(next));
  if (!changed) return current;
  const revision = current.revision + 1;
  database.prepare(`
    UPDATE github_monitor_rules SET
      scanner_json = @scanner_json,
      executor = @executor,
      cost_ceiling_usd = @cost_ceiling_usd,
      daily_cost_ceiling_usd = @daily_cost_ceiling_usd,
      follow_branches_json = @follow_branches_json,
      checkout_mode = @checkout_mode,
      enabled = @enabled,
      revision = @revision,
      baseline_initialized_at = NULL,
      last_error = NULL,
      updated_at = @updated_at
    WHERE id = @id
  `).run({
    id,
    scanner_json: serializeScanner(next.scanner),
    executor: next.executor,
    cost_ceiling_usd: next.costCeilingUsd,
    daily_cost_ceiling_usd: next.dailyCostCeilingUsd,
    follow_branches_json: JSON.stringify(next.followBranches),
    checkout_mode: next.checkoutMode,
    enabled: next.enabled ? 1 : 0,
    revision,
    updated_at: now,
  });
  return getGitHubMonitorRule(id, database);
}

export function recordGitHubMonitorPoll(
  id: string,
  options: { error: string | null; initializeBaseline?: boolean },
  database: Database.Database = getDb(),
  now = new Date().toISOString(),
): void {
  ensureGitHubMonitorSchema(database);
  database.prepare(`
    UPDATE github_monitor_rules SET
      last_polled_at = @now,
      last_error = @error,
      baseline_initialized_at = CASE
        WHEN @initialize = 1 AND baseline_initialized_at IS NULL THEN @now
        ELSE baseline_initialized_at
      END,
      updated_at = @now
    WHERE id = @id
  `).run({ id, now, error: options.error, initialize: options.initializeBaseline ? 1 : 0 });
}

/** Returns null if this repository/SHA/rule revision was already observed. */
export function createGitHubMonitorEvent(
  input: GitHubMonitorEventCreate,
  database: Database.Database = getDb(),
  id = randomUUID(),
): GitHubMonitorEvent | null {
  ensureGitHubMonitorSchema(database);
  const result = database.prepare(`
    INSERT OR IGNORE INTO github_monitor_events (
      id, rule_id, repository_key, rule_revision, kind, status, head_sha,
      base_ref, head_ref, pull_request_number, title, gate_id, cost_ceiling_usd,
      reason, error, detected_at, dispatched_at, completed_at
    ) VALUES (
      @id, @rule_id, @repository_key, @rule_revision, @kind, @status, @head_sha,
      @base_ref, @head_ref, @pull_request_number, @title, @gate_id, @cost_ceiling_usd,
      @reason, @error, @detected_at, @dispatched_at, @completed_at
    )
  `).run(eventCreateParams(input, id));
  if (result.changes !== 1) return null;
  return getGitHubMonitorEvent(id, database)!;
}

export function getGitHubMonitorEvent(
  id: string,
  database: Database.Database = getDb(),
): GitHubMonitorEvent | null {
  ensureGitHubMonitorSchema(database);
  const row = database.prepare("SELECT * FROM github_monitor_events WHERE id = ?").get(id) as EventRow | undefined;
  return row ? rowToEvent(row) : null;
}

export function listGitHubMonitorEvents(
  filter: { ruleId?: string; repositoryKey?: string; statuses?: GitHubMonitorEventStatus[]; limit?: number } = {},
  database: Database.Database = getDb(),
): GitHubMonitorEvent[] {
  ensureGitHubMonitorSchema(database);
  const clauses: string[] = [];
  const parameters: Record<string, unknown> = {};
  if (filter.ruleId) { clauses.push("rule_id = @rule_id"); parameters.rule_id = filter.ruleId; }
  if (filter.repositoryKey) { clauses.push("repository_key = @repository_key"); parameters.repository_key = filter.repositoryKey; }
  if (filter.statuses?.length) {
    const placeholders = filter.statuses.map((_, index) => `@status_${index}`);
    clauses.push(`status IN (${placeholders.join(",")})`);
    filter.statuses.forEach((status, index) => { parameters[`status_${index}`] = status; });
  }
  const safeLimit = Math.max(1, Math.min(filter.limit ?? 100, 500));
  parameters.limit = safeLimit;
  const sql = `SELECT * FROM github_monitor_events${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY detected_at DESC, id DESC LIMIT @limit`;
  return (database.prepare(sql).all(parameters) as EventRow[]).map(rowToEvent);
}

export function patchGitHubMonitorEvent(
  id: string,
  patch: GitHubMonitorEventPatch,
  database: Database.Database = getDb(),
): GitHubMonitorEvent | null {
  ensureGitHubMonitorSchema(database);
  const assignments: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.status !== undefined) { assignments.push("status = @status"); params.status = patch.status; }
  if (patch.gateId !== undefined) { assignments.push("gate_id = @gate_id"); params.gate_id = patch.gateId; }
  if (patch.reason !== undefined) { assignments.push("reason = @reason"); params.reason = patch.reason; }
  if (patch.error !== undefined) { assignments.push("error = @error"); params.error = patch.error; }
  if (patch.dispatchedAt !== undefined) { assignments.push("dispatched_at = @dispatched_at"); params.dispatched_at = patch.dispatchedAt; }
  if (patch.completedAt !== undefined) { assignments.push("completed_at = @completed_at"); params.completed_at = patch.completedAt; }
  if (!assignments.length) return getGitHubMonitorEvent(id, database);
  database.prepare(`UPDATE github_monitor_events SET ${assignments.join(", ")} WHERE id = @id`).run(params);
  return getGitHubMonitorEvent(id, database);
}

export function upsertGitHubMonitorActionsRun(
  value: GitHubMonitorActionsRun,
  database: Database.Database = getDb(),
): void {
  ensureGitHubMonitorSchema(database);
  database.prepare(`
    INSERT INTO github_monitor_actions_runs (
      id, rule_id, repository_key, workflow_run_id, name, event, head_branch,
      head_sha, status, conclusion, url, created_at, updated_at
    ) VALUES (
      @id, @rule_id, @repository_key, @workflow_run_id, @name, @event, @head_branch,
      @head_sha, @status, @conclusion, @url, @created_at, @updated_at
    ) ON CONFLICT(rule_id, workflow_run_id) DO UPDATE SET
      name = excluded.name,
      event = excluded.event,
      head_branch = excluded.head_branch,
      head_sha = excluded.head_sha,
      status = excluded.status,
      conclusion = excluded.conclusion,
      url = excluded.url,
      updated_at = excluded.updated_at
  `).run(actionsRunParams(value));
}

export function listGitHubMonitorActionsRuns(
  filter: { ruleId?: string; repositoryKey?: string; limit?: number } = {},
  database: Database.Database = getDb(),
): GitHubMonitorActionsRun[] {
  ensureGitHubMonitorSchema(database);
  const clauses: string[] = [];
  const parameters: Record<string, unknown> = {};
  if (filter.ruleId) { clauses.push("rule_id = @rule_id"); parameters.rule_id = filter.ruleId; }
  if (filter.repositoryKey) { clauses.push("repository_key = @repository_key"); parameters.repository_key = filter.repositoryKey; }
  parameters.limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
  const sql = `SELECT * FROM github_monitor_actions_runs${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT @limit`;
  return (database.prepare(sql).all(parameters) as ActionsRunRow[]).map(rowToActionsRun);
}

/** Cost ceilings are reservations, so a new automatic launch cannot overspend the daily cap. */
export function reservedGitHubMonitorCostForUtcDay(
  ruleId: string,
  dayStart: string,
  dayEnd: string,
  database: Database.Database = getDb(),
): number {
  ensureGitHubMonitorSchema(database);
  const row = database.prepare(`
    SELECT COALESCE(SUM(cost_ceiling_usd), 0) AS total
    FROM github_monitor_events
    WHERE rule_id = ?
      AND status IN ('dispatching', 'launched', 'failed')
      AND dispatched_at >= ? AND dispatched_at < ?
  `).get(ruleId, dayStart, dayEnd) as { total: number };
  return Number(row.total) || 0;
}

/** Claims a rule polling lease across processes sharing the SQLite volume. */
export function acquireGitHubMonitorPollLease(
  ruleId: string,
  ownerId: string,
  expiresAt: string,
  now: string,
  database: Database.Database = getDb(),
): boolean {
  ensureGitHubMonitorSchema(database);
  const result = database.prepare(`
    INSERT INTO github_monitor_poll_leases (rule_id, owner_id, expires_at)
    VALUES (@rule_id, @owner_id, @expires_at)
    ON CONFLICT(rule_id) DO UPDATE SET
      owner_id = excluded.owner_id,
      expires_at = excluded.expires_at
    WHERE github_monitor_poll_leases.expires_at <= @now
  `).run({ rule_id: ruleId, owner_id: ownerId, expires_at: expiresAt, now });
  return result.changes === 1;
}

export function renewGitHubMonitorPollLease(
  ruleId: string, ownerId: string, expiresAt: string, now: string,
  database: Database.Database = getDb(),
): boolean {
  const result = database.prepare(`UPDATE github_monitor_poll_leases SET expires_at = ?
    WHERE rule_id = ? AND owner_id = ? AND expires_at > ?`).run(expiresAt, ruleId, ownerId, now);
  return result.changes === 1;
}

export function releaseGitHubMonitorPollLease(
  ruleId: string,
  ownerId: string,
  database: Database.Database = getDb(),
): void {
  ensureGitHubMonitorSchema(database);
  database.prepare("DELETE FROM github_monitor_poll_leases WHERE rule_id = ? AND owner_id = ?").run(ruleId, ownerId);
}

/** Atomically changes a queued event into a daily-budget reservation. */
export function reserveGitHubMonitorEventDispatch(
  input: { eventId: string; ruleId: string; ruleRevision: number; dayStart: string; dayEnd: string; costCeilingUsd: number; dailyCostCeilingUsd: number; at: string },
  database: Database.Database = getDb(),
): GitHubMonitorEvent | null {
  ensureGitHubMonitorSchema(database);
  const updated = database.transaction(() => database.prepare(`
    UPDATE github_monitor_events SET
      status = 'dispatching',
      reason = NULL,
      error = NULL,
      dispatched_at = @at
    WHERE id = @event_id
      AND rule_id = @rule_id
      AND status = 'queued'
      AND rule_revision = @rule_revision
      AND EXISTS (
        SELECT 1 FROM github_monitor_rules
        WHERE id = @rule_id AND enabled = 1 AND revision = @rule_revision
      )
      AND (
        SELECT COALESCE(SUM(cost_ceiling_usd), 0)
        FROM github_monitor_events
        WHERE rule_id = @rule_id
          AND status IN ('dispatching', 'launched', 'failed')
          AND dispatched_at >= @day_start AND dispatched_at < @day_end
      ) + @cost_ceiling_usd <= @daily_cost_ceiling_usd
  `).run({
    event_id: input.eventId,
    rule_id: input.ruleId,
    rule_revision: input.ruleRevision,
    day_start: input.dayStart,
    day_end: input.dayEnd,
    cost_ceiling_usd: input.costCeilingUsd,
    daily_cost_ceiling_usd: input.dailyCostCeilingUsd,
    at: input.at,
  }))();
  if (updated.changes !== 1) return null;
  return getGitHubMonitorEvent(input.eventId, database);
}

/**
 * A process died after reserving a paid dispatch. A live lease protects active
 * work; an orphan becomes terminal and remains a cost reservation for the day.
 */
export function reconcileOrphanedGitHubMonitorDispatches(
  now: string,
  database: Database.Database = getDb(),
): number {
  ensureGitHubMonitorSchema(database);
  const result = database.prepare(`
    UPDATE github_monitor_events SET
      status = 'failed',
      error = 'automatic_dispatch_uncertain',
      completed_at = COALESCE(completed_at, @now)
    WHERE status = 'dispatching'
      AND NOT EXISTS (
        SELECT 1 FROM github_monitor_poll_leases leases
        WHERE leases.rule_id = github_monitor_events.rule_id
          AND leases.expires_at > @now
      )
  `).run({ now });
  return result.changes;
}

function ruleCreateParams(input: GitHubMonitorRuleCreate, id: string, now: string) {
  return {
    id,
    repository_key: input.repositoryKey,
    connection_id: input.connectionId,
    installation_id: input.installationId,
    repository_id: input.repositoryId,
    executor: input.executor,
    scanner_json: serializeScanner(input.scanner),
    cost_ceiling_usd: input.costCeilingUsd,
    daily_cost_ceiling_usd: input.dailyCostCeilingUsd,
    follow_branches_json: JSON.stringify(input.followBranches),
    checkout_mode: input.checkoutMode,
    enabled: input.enabled ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
}

function eventCreateParams(input: GitHubMonitorEventCreate, id: string) {
  return {
    id,
    rule_id: input.ruleId,
    repository_key: input.repositoryKey,
    rule_revision: input.ruleRevision,
    kind: input.kind,
    status: input.status ?? "queued",
    head_sha: input.headSha,
    base_ref: input.baseRef,
    head_ref: input.headRef,
    pull_request_number: input.pullRequestNumber,
    title: input.title,
    gate_id: input.gateId ?? null,
    cost_ceiling_usd: input.costCeilingUsd,
    reason: input.reason ?? null,
    error: input.error ?? null,
    detected_at: input.detectedAt,
    dispatched_at: input.dispatchedAt ?? null,
    completed_at: input.completedAt ?? null,
  };
}

function actionsRunParams(value: GitHubMonitorActionsRun) {
  return {
    id: value.id,
    rule_id: value.ruleId,
    repository_key: value.repositoryKey,
    workflow_run_id: value.workflowRunId,
    name: value.name,
    event: value.event,
    head_branch: value.headBranch,
    head_sha: value.headSha,
    status: value.status,
    conclusion: value.conclusion,
    url: value.url,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  };
}

function rowToRule(row: RuleRow): GitHubMonitorRule {
  return {
    id: row.id,
    repositoryKey: row.repository_key,
    connectionId: row.connection_id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    executor: executor(row.executor),
    scanner: parseScanner(row.scanner_json),
    costCeilingUsd: row.cost_ceiling_usd,
    dailyCostCeilingUsd: row.daily_cost_ceiling_usd,
    followBranches: parseBranches(row.follow_branches_json),
    checkoutMode: checkoutMode(row.checkout_mode),
    enabled: row.enabled === 1,
    revision: row.revision,
    baselineInitializedAt: row.baseline_initialized_at,
    lastPolledAt: row.last_polled_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEvent(row: EventRow): GitHubMonitorEvent {
  return {
    id: row.id,
    ruleId: row.rule_id,
    repositoryKey: row.repository_key,
    ruleRevision: row.rule_revision,
    kind: eventKind(row.kind),
    status: eventStatus(row.status),
    headSha: row.head_sha,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    pullRequestNumber: row.pull_request_number,
    title: row.title,
    gateId: row.gate_id,
    costCeilingUsd: row.cost_ceiling_usd,
    reason: row.reason,
    error: row.error,
    detectedAt: row.detected_at,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
  };
}

function rowToActionsRun(row: ActionsRunRow): GitHubMonitorActionsRun {
  return {
    id: row.id,
    ruleId: row.rule_id,
    repositoryKey: row.repository_key,
    workflowRunId: row.workflow_run_id,
    name: row.name,
    event: row.event,
    headBranch: row.head_branch,
    headSha: row.head_sha,
    status: row.status,
    conclusion: row.conclusion,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeScanner(value: GitHubMonitorRule["scanner"]): string | null {
  return value === null ? null : JSON.stringify(value);
}

function parseScanner(value: string | null): GitHubMonitorRule["scanner"] {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as GitHubMonitorRule["scanner"];
    if (parsed?.engine !== "codex-security") throw new Error("invalid scanner");
    return parsed;
  } catch {
    throw new Error("github_monitor_state_invalid");
  }
}

function parseBranches(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("invalid branches");
    return parsed;
  } catch {
    throw new Error("github_monitor_state_invalid");
  }
}

function checkoutMode(value: string): GitHubMonitorRule["checkoutMode"] {
  if (value === "none" || value === "fetch" || value === "pull") return value;
  throw new Error("github_monitor_state_invalid");
}

function executor(value: string): GitHubMonitorRule["executor"] {
  if (value === "sentinel-managed" || value === "github-actions") return value;
  throw new Error("github_monitor_state_invalid");
}

function eventKind(value: string): GitHubMonitorEvent["kind"] {
  if (value === "pull_request" || value === "push") return value;
  throw new Error("github_monitor_state_invalid");
}

function eventStatus(value: string): GitHubMonitorEventStatus {
  if (["observed", "queued", "dispatching", "launched", "skipped", "failed"].includes(value)) {
    return value as GitHubMonitorEventStatus;
  }
  throw new Error("github_monitor_state_invalid");
}

function ruleComparable(rule: GitHubMonitorRule) {
  return {
    executor: rule.executor,
    scanner: rule.scanner,
    costCeilingUsd: rule.costCeilingUsd,
    dailyCostCeilingUsd: rule.dailyCostCeilingUsd,
    followBranches: rule.followBranches,
    checkoutMode: rule.checkoutMode,
    enabled: rule.enabled,
  };
}
