import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type {
  GitHubAction,
  GitHubActionCreate,
  GitHubActionEvent,
  GitHubActionEventCreate,
  GitHubActionEventOrigin,
  GitHubActionEventPatch,
  GitHubActionEventStatus,
  GitHubActionPatch,
  GitHubActionTargetIdentity,
  GitHubActionTriggerKind,
  WebhookDeliveryRecord,
} from "@csb/shared";

import { getDb } from "../db.js";
import { migrateMonitorRulesToActions } from "./migrate-monitor-rules.js";
import {
  MAX_BRANCH_PATTERNS,
  WEBHOOK_DELIVERY_PRUNE_EVERY,
  WEBHOOK_DELIVERY_RETENTION,
  shortBranchName,
} from "./schema.js";

export {
  gitHubActionEventTargetIdentity,
  rerunTargetIdentity,
  shortBranchName,
} from "./schema.js";

const STATE_INVALID = "github_action_state_invalid";

interface ActionRow {
  id: string;
  repository_key: string;
  name: string;
  trigger_kind: string;
  branch_patterns_json: string;
  executor: string;
  connection_id: string;
  installation_id: string;
  repository_id: string;
  scanner_json: string | null;
  cost_ceiling_usd: number;
  daily_cost_ceiling_usd: number | null;
  enabled: number;
  revision: number;
  baseline_initialized_at: string | null;
  created_by: string | null;
  last_event_at: string | null;
  last_reconciled_at: string | null;
  last_error: string | null;
  migration_note: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  action_id: string;
  repository_key: string;
  action_revision: number;
  origin: string;
  delivery_id: string | null;
  kind: string;
  status: string;
  head_sha: string;
  base_ref: string | null;
  head_ref: string;
  pull_request_number: number | null;
  target_identity: string;
  title: string | null;
  gate_id: string | null;
  cost_ceiling_usd: number | null;
  reason: string | null;
  error: string | null;
  detected_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
}

interface DeliveryRow {
  delivery_id: string;
  connection_id: string;
  event: string;
  action: string | null;
  repository_key: string | null;
  installation_id: string | null;
  head_sha: string | null;
  outcome: string;
  reason: string | null;
  matched_action_ids_json: string;
  event_ids_json: string;
  received_at: string;
  duration_ms: number | null;
}

/**
 * Creating the tables *is* version 1 of the actions migration, so a cold boot on
 * the production database needs nothing else: the rules that existed become
 * actions in the same transaction that mints the schema.
 */
export function ensureGitHubActionsSchema(database: Database.Database = getDb()): void {
  migrateMonitorRulesToActions(database);
}

export function createGitHubAction(
  input: GitHubActionCreate,
  database: Database.Database = getDb(),
  now: string = new Date().toISOString(),
  id: string = randomUUID(),
): GitHubAction {
  ensureGitHubActionsSchema(database);
  assertBranchPatterns(input.branchPatterns);
  withNameConflictAsError(() => database.prepare(`
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
      NULL, @created_by, NULL, NULL,
      NULL, NULL, @created_at, @updated_at
    )
  `).run({
    id,
    repository_key: input.repositoryKey,
    name: input.name,
    trigger_kind: input.triggerKind,
    branch_patterns_json: JSON.stringify(input.branchPatterns),
    executor: input.executor,
    connection_id: input.connectionId,
    installation_id: input.installationId,
    repository_id: input.repositoryId,
    scanner_json: input.scanner === null ? null : JSON.stringify(input.scanner),
    cost_ceiling_usd: input.costCeilingUsd,
    daily_cost_ceiling_usd: input.dailyCostCeilingUsd,
    enabled: input.enabled ? 1 : 0,
    created_by: input.createdBy,
    created_at: now,
    updated_at: now,
  }));
  return getGitHubAction(id, database)!;
}

export function getGitHubAction(
  id: string,
  database: Database.Database = getDb(),
): GitHubAction | null {
  ensureGitHubActionsSchema(database);
  const row = database.prepare("SELECT * FROM github_actions WHERE id = ?").get(id) as ActionRow | undefined;
  return row ? rowToAction(row) : null;
}

export function listGitHubActions(
  filter: { repositoryKey?: string | null; enabledOnly?: boolean } = {},
  database: Database.Database = getDb(),
): GitHubAction[] {
  ensureGitHubActionsSchema(database);
  const clauses: string[] = [];
  const parameters: Record<string, unknown> = {};
  if (filter.repositoryKey !== undefined && filter.repositoryKey !== null) {
    clauses.push("repository_key = @repository_key");
    parameters.repository_key = filter.repositoryKey;
  }
  if (filter.enabledOnly === true) clauses.push("enabled = 1");
  const sql = `SELECT * FROM github_actions${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY repository_key ASC, name ASC, trigger_kind ASC, id ASC`;
  return (database.prepare(sql).all(parameters) as ActionRow[]).map(rowToAction);
}

/**
 * Editing what an action observes bumps `revision` and forgets the baseline, so
 * the next reconciliation records the open pull requests as observed instead of
 * charging for a backlog nobody asked to rescan. Renaming it, or changing a
 * ceiling or the enabled flag, observes exactly the same commits and does not.
 */
export function patchGitHubAction(
  id: string,
  patch: GitHubActionPatch,
  database: Database.Database = getDb(),
  now: string = new Date().toISOString(),
): GitHubAction | null {
  ensureGitHubActionsSchema(database);
  const current = getGitHubAction(id, database);
  if (current === null) return null;
  const next: GitHubAction = { ...current, ...patch };
  // An action stored before this bound existed, or enabled in the same patch that
  // empties its patterns, would present as healthy while matching nothing.
  if (patch.branchPatterns !== undefined || next.enabled) assertBranchPatterns(next.branchPatterns);
  if (JSON.stringify(comparable(current)) === JSON.stringify(comparable(next))) return current;
  const bumpsRevision = JSON.stringify(observational(current)) !== JSON.stringify(observational(next));
  withNameConflictAsError(() => database.prepare(`
    UPDATE github_actions SET
      name = @name,
      trigger_kind = @trigger_kind,
      branch_patterns_json = @branch_patterns_json,
      executor = @executor,
      connection_id = @connection_id,
      installation_id = @installation_id,
      repository_id = @repository_id,
      scanner_json = @scanner_json,
      cost_ceiling_usd = @cost_ceiling_usd,
      daily_cost_ceiling_usd = @daily_cost_ceiling_usd,
      enabled = @enabled,
      revision = @revision,
      baseline_initialized_at = @baseline_initialized_at,
      last_error = NULL,
      migration_note = @migration_note,
      updated_at = @updated_at
    WHERE id = @id
  `).run({
    id,
    name: next.name,
    trigger_kind: next.triggerKind,
    branch_patterns_json: JSON.stringify(next.branchPatterns),
    executor: next.executor,
    connection_id: next.connectionId,
    installation_id: next.installationId,
    repository_id: next.repositoryId,
    scanner_json: next.scanner === null ? null : JSON.stringify(next.scanner),
    cost_ceiling_usd: next.costCeilingUsd,
    daily_cost_ceiling_usd: next.dailyCostCeilingUsd,
    enabled: next.enabled ? 1 : 0,
    revision: bumpsRevision ? current.revision + 1 : current.revision,
    baseline_initialized_at: bumpsRevision ? null : current.baselineInitializedAt,
    // The note explains what the migration had to change about the patterns; once
    // an operator sets them, there is nothing left to explain.
    migration_note: patch.branchPatterns === undefined ? current.migrationNote : null,
    updated_at: now,
  }));
  return getGitHubAction(id, database);
}

export function deleteGitHubAction(
  id: string,
  database: Database.Database = getDb(),
): boolean {
  ensureGitHubActionsSchema(database);
  return database.prepare("DELETE FROM github_actions WHERE id = ?").run(id).changes === 1;
}

export function recordGitHubActionReconciliation(
  id: string,
  options: { error: string | null; initializeBaseline?: boolean },
  database: Database.Database = getDb(),
  now: string = new Date().toISOString(),
): void {
  ensureGitHubActionsSchema(database);
  database.prepare(`
    UPDATE github_actions SET
      last_reconciled_at = @now,
      last_error = @error,
      baseline_initialized_at = CASE
        WHEN @initialize = 1 AND baseline_initialized_at IS NULL THEN @now
        ELSE baseline_initialized_at
      END,
      updated_at = @now
    WHERE id = @id
  `).run({ id, now, error: options.error, initialize: options.initializeBaseline ? 1 : 0 });
}

/**
 * Returns null when this target was already recorded at this revision: the webhook
 * and the reconciliation may both see the same commit, and whoever arrives second
 * loses to the UNIQUE constraint rather than to a read-then-write race.
 */
export function createGitHubActionEvent(
  input: GitHubActionEventCreate,
  database: Database.Database = getDb(),
  id: string = randomUUID(),
): GitHubActionEvent | null {
  ensureGitHubActionsSchema(database);
  try {
    database.prepare(`
      INSERT INTO github_action_events (
        id, action_id, repository_key, action_revision, origin, delivery_id, kind,
        status, head_sha, base_ref, head_ref, pull_request_number, target_identity,
        title, gate_id, cost_ceiling_usd, reason, error, detected_at, dispatched_at,
        completed_at
      ) VALUES (
        @id, @action_id, @repository_key, @action_revision, @origin, @delivery_id, @kind,
        @status, @head_sha, @base_ref, @head_ref, @pull_request_number, @target_identity,
        @title, @gate_id, @cost_ceiling_usd, @reason, @error, @detected_at, NULL,
        NULL
      )
    `).run({
      id,
      action_id: input.actionId,
      repository_key: input.repositoryKey,
      action_revision: input.actionRevision,
      origin: input.origin,
      delivery_id: input.deliveryId,
      kind: input.kind,
      status: input.status ?? "queued",
      head_sha: input.headSha,
      base_ref: input.baseRef,
      head_ref: shortBranchName(input.headRef),
      pull_request_number: input.pullRequestNumber,
      target_identity: input.targetIdentity,
      title: input.title,
      gate_id: input.gateId,
      cost_ceiling_usd: input.costCeilingUsd,
      reason: input.reason,
      error: input.error,
      detected_at: input.detectedAt,
    });
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
  database.prepare(`
    UPDATE github_actions SET last_event_at = @detected_at
    WHERE id = @action_id AND (last_event_at IS NULL OR last_event_at < @detected_at)
  `).run({ action_id: input.actionId, detected_at: input.detectedAt });
  return getGitHubActionEvent(id, database);
}

export function getGitHubActionEvent(
  id: string,
  database: Database.Database = getDb(),
): GitHubActionEvent | null {
  ensureGitHubActionsSchema(database);
  const row = database.prepare("SELECT * FROM github_action_events WHERE id = ?").get(id) as EventRow | undefined;
  return row ? rowToEvent(row) : null;
}

export function patchGitHubActionEvent(
  id: string,
  patch: GitHubActionEventPatch,
  database: Database.Database = getDb(),
): GitHubActionEvent | null {
  ensureGitHubActionsSchema(database);
  const assignments: string[] = [];
  const parameters: Record<string, unknown> = { id };
  if (patch.status !== undefined) { assignments.push("status = @status"); parameters.status = patch.status; }
  if (patch.gateId !== undefined) { assignments.push("gate_id = @gate_id"); parameters.gate_id = patch.gateId; }
  if (patch.reason !== undefined) { assignments.push("reason = @reason"); parameters.reason = patch.reason; }
  if (patch.error !== undefined) { assignments.push("error = @error"); parameters.error = patch.error; }
  if (patch.dispatchedAt !== undefined) {
    assignments.push("dispatched_at = @dispatched_at");
    parameters.dispatched_at = patch.dispatchedAt;
  }
  if (patch.completedAt !== undefined) {
    assignments.push("completed_at = @completed_at");
    parameters.completed_at = patch.completedAt;
  }
  if (assignments.length === 0) return getGitHubActionEvent(id, database);
  database.prepare(`UPDATE github_action_events SET ${assignments.join(", ")} WHERE id = @id`).run(parameters);
  return getGitHubActionEvent(id, database);
}

export function listGitHubActionEvents(
  filter: {
    actionId?: string;
    repositoryKeys?: string[];
    statuses?: GitHubActionEventStatus[];
    limit?: number;
  } = {},
  database: Database.Database = getDb(),
): GitHubActionEvent[] {
  ensureGitHubActionsSchema(database);
  const clauses: string[] = [];
  const parameters: Record<string, unknown> = {};
  if (filter.actionId) { clauses.push("action_id = @action_id"); parameters.action_id = filter.actionId; }
  if (filter.repositoryKeys !== undefined) {
    if (filter.repositoryKeys.length === 0) return [];
    const placeholders = filter.repositoryKeys.map((_, index) => `@repository_key_${index}`);
    clauses.push(`repository_key IN (${placeholders.join(",")})`);
    filter.repositoryKeys.forEach((key, index) => { parameters[`repository_key_${index}`] = key; });
  }
  if (filter.statuses?.length) {
    const placeholders = filter.statuses.map((_, index) => `@status_${index}`);
    clauses.push(`status IN (${placeholders.join(",")})`);
    filter.statuses.forEach((status, index) => { parameters[`status_${index}`] = status; });
  }
  parameters.limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
  const sql = `SELECT * FROM github_action_events${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY detected_at DESC, id DESC LIMIT @limit`;
  return (database.prepare(sql).all(parameters) as EventRow[]).map(rowToEvent);
}

/**
 * A newer commit, or a closed pull request, makes a queued event obsolete before
 * anything was spent on it. Only `queued` events are touched: once a gate is
 * launched the money is gone and the run finishes.
 */
export function supersedeQueuedEvents(
  input: {
    actionId: string;
    pullRequestNumber?: number;
    headRef?: string;
    exceptHeadSha: string;
    reason: "head_superseded" | "pull_request_closed";
  },
  database: Database.Database = getDb(),
  now: string = new Date().toISOString(),
): number {
  ensureGitHubActionsSchema(database);
  const clauses = ["action_id = @action_id", "status = 'queued'", "head_sha != @except_head_sha"];
  const parameters: Record<string, unknown> = {
    action_id: input.actionId,
    except_head_sha: input.exceptHeadSha,
    reason: input.reason,
    now,
  };
  if (input.pullRequestNumber !== undefined) {
    clauses.push("pull_request_number = @pull_request_number");
    parameters.pull_request_number = input.pullRequestNumber;
  }
  if (input.headRef !== undefined) {
    clauses.push("head_ref = @head_ref");
    parameters.head_ref = shortBranchName(input.headRef);
  }
  if (input.pullRequestNumber === undefined && input.headRef === undefined) {
    throw new Error("github_action_supersede_scope_required");
  }
  return database.prepare(`
    UPDATE github_action_events SET
      status = 'superseded',
      reason = @reason,
      completed_at = COALESCE(completed_at, @now)
    WHERE ${clauses.join(" AND ")}
  `).run(parameters).changes;
}

/**
 * The same commit is never paid for twice by the same action. A `superseded` or
 * pre-dispatch `skipped` event never reached a gate, so it does not count; a
 * terminal event that carries a gate id does.
 */
export function hasAnalysedCommit(
  actionId: string,
  headSha: string,
  database: Database.Database = getDb(),
): boolean {
  ensureGitHubActionsSchema(database);
  const row = database.prepare(`
    SELECT 1 FROM github_action_events
    WHERE action_id = @action_id
      AND head_sha = @head_sha
      AND (
        status IN ('dispatching', 'launched')
        OR (status IN ('skipped', 'failed') AND gate_id IS NOT NULL)
      )
    LIMIT 1
  `).get({ action_id: actionId, head_sha: headSha });
  return row !== undefined;
}

/** Cost ceilings are reservations, so a new automatic launch cannot overspend the daily cap. */
export function reservedGitHubActionCostForUtcDay(
  actionId: string,
  dayStart: string,
  dayEnd: string,
  database: Database.Database = getDb(),
): number {
  ensureGitHubActionsSchema(database);
  const row = database.prepare(`
    SELECT COALESCE(SUM(cost_ceiling_usd), 0) AS total
    FROM github_action_events
    WHERE action_id = ?
      AND status IN ('dispatching', 'launched', 'failed')
      AND dispatched_at >= ? AND dispatched_at < ?
  `).get(actionId, dayStart, dayEnd) as { total: number };
  return Number(row.total) || 0;
}

const deliveryInsertsSincePrune = new WeakMap<Database.Database, number>();

/**
 * `deliveryId` is GitHub's own idempotency key, so a redelivery is recognised by
 * the primary key rather than by comparing payloads.
 */
export function recordWebhookDelivery(
  input: WebhookDeliveryRecord,
  database: Database.Database = getDb(),
): "recorded" | "duplicate" {
  ensureGitHubActionsSchema(database);
  const inserted = database.prepare(`
    INSERT OR IGNORE INTO github_webhook_deliveries (
      delivery_id, connection_id, event, action, repository_key, installation_id,
      head_sha, outcome, reason, matched_action_ids_json, event_ids_json,
      received_at, duration_ms
    ) VALUES (
      @delivery_id, @connection_id, @event, @action, @repository_key, @installation_id,
      @head_sha, @outcome, @reason, @matched_action_ids_json, @event_ids_json,
      @received_at, @duration_ms
    )
  `).run({
    delivery_id: input.deliveryId,
    connection_id: input.connectionId,
    event: input.event,
    action: input.action,
    repository_key: input.repositoryKey,
    installation_id: input.installationId,
    head_sha: input.headSha,
    outcome: input.outcome,
    reason: input.reason,
    matched_action_ids_json: JSON.stringify(input.matchedActionIds),
    event_ids_json: JSON.stringify(input.eventIds),
    received_at: input.receivedAt,
    duration_ms: input.durationMs,
  });
  if (inserted.changes !== 1) return "duplicate";
  // A fresh handle starts one short of the interval, so a process that restarts
  // more often than every hundred deliveries still prunes once on its first.
  const since = (deliveryInsertsSincePrune.get(database) ?? WEBHOOK_DELIVERY_PRUNE_EVERY - 1) + 1;
  if (since >= WEBHOOK_DELIVERY_PRUNE_EVERY) {
    deliveryInsertsSincePrune.set(database, 0);
    database.prepare(`
      DELETE FROM github_webhook_deliveries WHERE delivery_id NOT IN (
        SELECT delivery_id FROM github_webhook_deliveries
        ORDER BY received_at DESC LIMIT @retention
      )
    `).run({ retention: WEBHOOK_DELIVERY_RETENTION });
  } else {
    deliveryInsertsSincePrune.set(database, since);
  }
  return "recorded";
}

export function listWebhookDeliveries(
  limit: number,
  database: Database.Database = getDb(),
): WebhookDeliveryRecord[] {
  ensureGitHubActionsSchema(database);
  const rows = database.prepare(`
    SELECT * FROM github_webhook_deliveries ORDER BY received_at DESC, delivery_id DESC LIMIT ?
  `).all(Math.max(1, Math.min(limit, 500))) as DeliveryRow[];
  return rows.map(rowToDelivery);
}

/**
 * The number the Integration screen reads to answer the only question that
 * matters there: are deliveries arriving, and are they being processed.
 */
export function countWebhookDeliveriesSince(
  isoTimestamp: string,
  database: Database.Database = getDb(),
): { processed: number; ignored: number; failed: number } {
  ensureGitHubActionsSchema(database);
  const rows = database.prepare(`
    SELECT outcome, COUNT(*) AS total FROM github_webhook_deliveries
    WHERE received_at >= ? GROUP BY outcome
  `).all(isoTimestamp) as Array<{ outcome: string; total: number }>;
  const counts = { processed: 0, ignored: 0, failed: 0 };
  for (const row of rows) {
    if (row.outcome === "processed" || row.outcome === "ignored" || row.outcome === "failed") {
      counts[row.outcome] = Number(row.total) || 0;
    }
  }
  return counts;
}

function rowToAction(row: ActionRow): GitHubAction {
  return {
    id: row.id,
    repositoryKey: row.repository_key,
    name: row.name,
    triggerKind: triggerKind(row.trigger_kind),
    branchPatterns: parseStringArray(row.branch_patterns_json),
    executor: executor(row.executor),
    connectionId: row.connection_id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    scanner: parseScanner(row.scanner_json),
    costCeilingUsd: row.cost_ceiling_usd,
    dailyCostCeilingUsd: row.daily_cost_ceiling_usd,
    enabled: row.enabled === 1,
    revision: row.revision,
    baselineInitializedAt: row.baseline_initialized_at,
    createdBy: row.created_by,
    lastEventAt: row.last_event_at,
    lastReconciledAt: row.last_reconciled_at,
    lastError: row.last_error,
    migrationNote: row.migration_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEvent(row: EventRow): GitHubActionEvent {
  return {
    id: row.id,
    actionId: row.action_id,
    repositoryKey: row.repository_key,
    actionRevision: row.action_revision,
    origin: origin(row.origin),
    deliveryId: row.delivery_id,
    kind: triggerKind(row.kind),
    status: eventStatus(row.status),
    headSha: row.head_sha,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    pullRequestNumber: row.pull_request_number,
    // The only crossing the brand allows: a stored key was minted on the way in.
    targetIdentity: row.target_identity as GitHubActionTargetIdentity,
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

function rowToDelivery(row: DeliveryRow): WebhookDeliveryRecord {
  return {
    deliveryId: row.delivery_id,
    connectionId: row.connection_id,
    event: row.event,
    action: row.action,
    repositoryKey: row.repository_key,
    installationId: row.installation_id,
    headSha: row.head_sha,
    outcome: deliveryOutcome(row.outcome),
    reason: row.reason,
    matchedActionIds: parseStringArray(row.matched_action_ids_json),
    eventIds: parseStringArray(row.event_ids_json),
    receivedAt: row.received_at,
    durationMs: row.duration_ms,
  };
}

function assertBranchPatterns(value: string[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BRANCH_PATTERNS) {
    throw new Error("github_action_branch_patterns_invalid");
  }
  if (value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error("github_action_branch_patterns_invalid");
  }
}

function parseStringArray(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(STATE_INVALID);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(STATE_INVALID);
  }
  return parsed as string[];
}

function parseScanner(value: string | null): GitHubAction["scanner"] {
  if (value === null) return null;
  let parsed: GitHubAction["scanner"];
  try {
    parsed = JSON.parse(value) as GitHubAction["scanner"];
  } catch {
    throw new Error(STATE_INVALID);
  }
  if (parsed?.engine !== "codex-security") throw new Error(STATE_INVALID);
  return parsed;
}

function triggerKind(value: string): GitHubActionTriggerKind {
  if (value === "pull_request" || value === "push") return value;
  throw new Error(STATE_INVALID);
}

function executor(value: string): GitHubAction["executor"] {
  if (value === "sentinel-managed" || value === "github-actions") return value;
  throw new Error(STATE_INVALID);
}

function origin(value: string): GitHubActionEventOrigin {
  if (value === "webhook" || value === "reconciliation" || value === "manual") return value;
  throw new Error(STATE_INVALID);
}

function eventStatus(value: string): GitHubActionEventStatus {
  if (["observed", "queued", "dispatching", "launched", "skipped", "failed", "superseded"].includes(value)) {
    return value as GitHubActionEventStatus;
  }
  throw new Error(STATE_INVALID);
}

function deliveryOutcome(value: string): WebhookDeliveryRecord["outcome"] {
  if (value === "processed" || value === "ignored" || value === "failed") return value;
  throw new Error(STATE_INVALID);
}

/** Every field a patch may touch: no change to these means no write at all. */
function comparable(action: GitHubAction) {
  return {
    ...observational(action),
    name: action.name,
    costCeilingUsd: action.costCeilingUsd,
    dailyCostCeilingUsd: action.dailyCostCeilingUsd,
    enabled: action.enabled,
  };
}

/** The fields that change *what* the action sees, and therefore its revision. */
function observational(action: GitHubAction) {
  return {
    triggerKind: action.triggerKind,
    branchPatterns: action.branchPatterns,
    executor: action.executor,
    scanner: action.scanner,
    connectionId: action.connectionId,
    installationId: action.installationId,
    repositoryId: action.repositoryId,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

/**
 * After the migration every repository already owns a "PR" and a "Push". An
 * operator retyping either name deserves a conflict, not a SQLite message.
 */
function withNameConflictAsError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (isUniqueViolation(error) && String((error as Error).message).includes("github_actions.name")) {
      throw new Error("github_action_name_taken");
    }
    throw error;
  }
}
