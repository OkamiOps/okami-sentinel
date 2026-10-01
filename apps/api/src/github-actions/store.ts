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
  WebhookDeliveryCompletion,
  WebhookDeliveryRecord,
} from "@csb/shared";

import { getDb } from "../db.js";
import { markRepositoryBaselineStale } from "../guardrails/baseline-state.js";
import {
  migrateMonitorRulesToActions,
  type MonitorRuleMigrationResult,
} from "./migrate-monitor-rules.js";
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

/** The note the migration leaves on an action whose patterns it had to invent. */
const PATTERNS_INVENTED_NOTE = "migrated_pattern_missing";

/**
 * A rule that followed no branch could not be stored as `[]`, so the migration
 * wrote `*` — the most permissive pattern in the language, chosen by nobody. Such
 * an action must not be enabled until a person names the branches; setting
 * `branchPatterns` is what clears the note. `migrated_pattern_overflow` does not
 * count: those patterns were the operator's own, only fewer.
 *
 * Exported for the Actions screen (task 1.5), which should refuse with this before
 * the store has to throw.
 */
export function gitHubActionNeedsBranchPatternReview(action: GitHubAction): boolean {
  return action.migrationNote === PATTERNS_INVENTED_NOTE;
}

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
  include_forks: number;
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
  observed_at: string | null;
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
export function ensureGitHubActionsSchema(
  database: Database.Database = getDb(),
): MonitorRuleMigrationResult {
  return migrateMonitorRulesToActions(database);
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
      last_error, migration_note, include_forks, created_at, updated_at
    ) VALUES (
      @id, @repository_key, @name, @trigger_kind, @branch_patterns_json, @executor,
      @connection_id, @installation_id, @repository_id, @scanner_json,
      @cost_ceiling_usd, @daily_cost_ceiling_usd, @enabled, 1,
      NULL, @created_by, NULL, NULL,
      NULL, NULL, @include_forks, @created_at, @updated_at
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
    include_forks: input.includeForks ? 1 : 0,
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

/**
 * `repositoryKeys` is the caller's scope and is pushed **into** the query: filtering
 * a page after the limit would drop exactly the rows the caller may read and report
 * a short page as the end of the list. An empty array is a real answer — a member
 * with no grant sees nothing — and must not be confused with "no filter".
 */
export function listGitHubActions(
  filter: {
    repositoryKey?: string | null;
    repositoryKeys?: readonly string[] | null;
    enabledOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
  database: Database.Database = getDb(),
): GitHubAction[] {
  ensureGitHubActionsSchema(database);
  const clauses: string[] = [];
  const parameters: Record<string, unknown> = {};
  if (filter.repositoryKey !== undefined && filter.repositoryKey !== null) {
    clauses.push("repository_key = @repository_key");
    parameters.repository_key = filter.repositoryKey;
  }
  if (filter.repositoryKeys !== undefined && filter.repositoryKeys !== null) {
    if (filter.repositoryKeys.length === 0) return [];
    const names = filter.repositoryKeys.map((_, index) => `@scope_${index}`);
    clauses.push(`repository_key IN (${names.join(", ")})`);
    for (const [index, key] of filter.repositoryKeys.entries()) parameters[`scope_${index}`] = key;
  }
  if (filter.enabledOnly === true) clauses.push("enabled = 1");
  let sql = `SELECT * FROM github_actions${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY repository_key ASC, name ASC, trigger_kind ASC, id ASC`;
  if (filter.limit !== undefined) {
    sql += " LIMIT @limit OFFSET @offset";
    parameters.limit = filter.limit;
    parameters.offset = filter.offset ?? 0;
  }
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
  if (next.enabled && patch.branchPatterns === undefined && gitHubActionNeedsBranchPatternReview(current)) {
    throw new Error("github_action_branch_patterns_unreviewed");
  }
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
      include_forks = @include_forks,
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
    include_forks: next.includeForks ? 1 : 0,
    revision: bumpsRevision ? current.revision + 1 : current.revision,
    baseline_initialized_at: bumpsRevision ? null : current.baselineInitializedAt,
    // The note explains what the migration had to change about the patterns; once
    // an operator sets them, there is nothing left to explain.
    migration_note: patch.branchPatterns === undefined ? current.migrationNote : null,
    updated_at: now,
  }));
  // What a scan is run *with* decides what a baseline can be compared to, so
  // changing the model, the effort or the mode retires the baseline built with the
  // old one. Nothing is blocked meanwhile: the next merge on the protected branch
  // rebuilds it, and a pull request without a comparable baseline is still judged.
  if (JSON.stringify(current.scanner) !== JSON.stringify(next.scanner)) {
    markRepositoryBaselineStale(current.repositoryKey, "scan_lineage", database, now);
  }
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
        title, gate_id, cost_ceiling_usd, reason, error, detected_at, observed_at,
        dispatched_at, completed_at
      ) VALUES (
        @id, @action_id, @repository_key, @action_revision, @origin, @delivery_id, @kind,
        @status, @head_sha, @base_ref, @head_ref, @pull_request_number, @target_identity,
        @title, @gate_id, @cost_ceiling_usd, @reason, @error, @detected_at, @observed_at,
        NULL, NULL
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
      observed_at: input.observedAt,
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
    /** Rows to skip, so an activity screen can page without a cursor. */
    offset?: number;
    /**
     * A screen reads the newest first; a queue is drained oldest first, and with
     * the default order a limit would hide exactly the rows the drain wants
     * (M-6).
     */
    order?: "newest" | "oldest";
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
  parameters.offset = Math.max(0, Math.min(Math.trunc(filter.offset ?? 0), 100_000));
  const direction = filter.order === "oldest" ? "ASC" : "DESC";
  const sql = `SELECT * FROM github_action_events${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY detected_at ${direction}, id ${direction} LIMIT @limit OFFSET @offset`;
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
    /**
     * Only events whose own change is strictly older than this are cancelled, so a
     * delivery that arrives late can never cancel the newer head it missed. Leave
     * it out for `pull_request_closed`, where the whole queue is obsolete whatever
     * its order.
     */
    beforeObservedAt?: string;
    /**
     * The event this supersession is on behalf of. GitHub's clocks have one-second
     * resolution, so two heads can share one; insertion order then breaks the tie,
     * in one direction only, and exactly one of the two survives. An id that is
     * not there degrades to the strict clock comparison rather than matching
     * everything.
     */
    beforeEventId?: string;
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
  if (input.beforeObservedAt !== undefined) {
    parameters.before_observed_at = input.beforeObservedAt;
    if (input.beforeEventId === undefined) {
      clauses.push("COALESCE(observed_at, detected_at) < @before_observed_at");
    } else {
      parameters.before_event_id = input.beforeEventId;
      clauses.push(`(
        COALESCE(observed_at, detected_at) < @before_observed_at
        OR (
          COALESCE(observed_at, detected_at) = @before_observed_at
          AND rowid < (SELECT rowid FROM github_action_events WHERE id = @before_event_id)
        )
      )`);
    }
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
 * The newest change already on the books for one target of one action, by the
 * payload's own clock where there was one. A delivery older than this is a replay
 * or an out-of-order arrival: it must create nothing and cancel nothing, because
 * whatever it describes has already been overtaken.
 */
export function newestObservedEventAt(
  input: { actionId: string; pullRequestNumber?: number; headRef?: string },
  database: Database.Database = getDb(),
): string | null {
  ensureGitHubActionsSchema(database);
  if (input.pullRequestNumber === undefined && input.headRef === undefined) {
    throw new Error("github_action_supersede_scope_required");
  }
  const clauses = ["action_id = @action_id"];
  const parameters: Record<string, unknown> = { action_id: input.actionId };
  if (input.pullRequestNumber !== undefined) {
    clauses.push("pull_request_number = @pull_request_number");
    parameters.pull_request_number = input.pullRequestNumber;
  }
  if (input.headRef !== undefined) {
    clauses.push("head_ref = @head_ref");
    parameters.head_ref = shortBranchName(input.headRef);
  }
  const row = database.prepare(`
    SELECT MAX(COALESCE(observed_at, detected_at)) AS newest
    FROM github_action_events WHERE ${clauses.join(" AND ")}
  `).get(parameters) as { newest: string | null } | undefined;
  return row?.newest ?? null;
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

/**
 * Reasons a `skipped` row does not mean "this commit has been dealt with": the
 * refusal was about this process, not about the change. Kept in step with
 * `TRANSIENT_DISPATCH_CODES` in `dispatch.ts`, which no longer terminates them —
 * this covers the rows a release that did left behind.
 */
const TRANSIENT_SKIP_REASONS = ["server_draining"];

/**
 * Whether any event of this action already carries this commit, at any revision
 * and in any status but a transient refusal. The reconciliation asks before
 * creating: a commit the action has already seen — even one it skipped because
 * the head had moved — is not a commit a webhook missed, and creating an event
 * for it is how a safety net turns into a second scanner.
 */
export function hasGitHubActionEventForHeadSha(
  actionId: string,
  headSha: string,
  database: Database.Database = getDb(),
): boolean {
  ensureGitHubActionsSchema(database);
  const placeholders = TRANSIENT_SKIP_REASONS.map(() => "?").join(",");
  const row = database.prepare(`
    SELECT 1 FROM github_action_events
    WHERE action_id = ? AND head_sha = ?
      AND NOT (status = 'skipped' AND reason IN (${placeholders}))
    LIMIT 1
  `).get(actionId, headSha, ...TRANSIENT_SKIP_REASONS);
  return row !== undefined;
}

/**
 * The event a gate belongs to. `check_run.rerequested` carries the gate id as the
 * check's `external_id`, and this is how that id becomes an action again — scoped
 * by the caller to the connection and the repository, never by the id alone.
 */
export function findGitHubActionEventByGateId(
  gateId: string,
  database: Database.Database = getDb(),
): GitHubActionEvent | null {
  ensureGitHubActionsSchema(database);
  const row = database.prepare(`
    SELECT * FROM github_action_events WHERE gate_id = ?
    ORDER BY detected_at DESC, rowid DESC LIMIT 1
  `).get(gateId) as EventRow | undefined;
  return row ? rowToEvent(row) : null;
}

/**
 * Nothing is deleted when GitHub takes a repository out of an installation: the
 * operator's actions stay, disabled, with the reason on the row. Disabling is not
 * observational, so the revision is left alone — re-enabling must not forget the
 * baseline and rescan the open queue.
 */
export function disableGitHubActionsForRepository(
  repositoryKey: string,
  reason: string,
  database: Database.Database = getDb(),
  now: string = new Date().toISOString(),
): number {
  ensureGitHubActionsSchema(database);
  return database.prepare(`
    UPDATE github_actions SET enabled = 0, last_error = @reason, updated_at = @now
    WHERE repository_key = @repository_key AND enabled = 1
  `).run({ repository_key: repositoryKey, reason, now }).changes;
}

/** The same, for every repository of an installation that was deleted or suspended. */
export function disableGitHubActionsForInstallation(
  installationId: string,
  reason: string,
  database: Database.Database = getDb(),
  now: string = new Date().toISOString(),
): number {
  ensureGitHubActionsSchema(database);
  return database.prepare(`
    UPDATE github_actions SET enabled = 0, last_error = @reason, updated_at = @now
    WHERE installation_id = @installation_id AND enabled = 1
  `).run({ installation_id: installationId, reason, now }).changes;
}

/**
 * Turns a queued event into a reservation against the **repository's** UTC-day
 * budget, in one statement: the ceiling is reserved before the scan starts, so two
 * dispatches racing cannot both fit under a cap that only one of them has room
 * for. `null` means the day is spent, the revision moved, the action was disabled
 * or another caller won the row — it stays `queued` and the next window may
 * dispatch it.
 *
 * The sum is over every action of the repository, and the cap is the dispatching
 * action's own `daily_cost_ceiling_usd`. That is the ruling on what a daily
 * ceiling means: "this repository may reserve at most $X today". One rule became
 * two actions at the migration, and this is what keeps the pair inside the single
 * ceiling the rule had instead of giving each a full bucket. The cost of the
 * choice is explicit: an action with a small daily cap can be starved by a
 * sibling that spent the repository's day.
 */
export function reserveGitHubActionEventDispatch(
  input: {
    eventId: string;
    actionId: string;
    /** The repository whose day is being spent; the events carry it too. */
    repositoryKey: string;
    actionRevision: number;
    dayStart: string;
    dayEnd: string;
    costCeilingUsd: number;
    dailyCostCeilingUsd: number;
    at: string;
  },
  database: Database.Database = getDb(),
): GitHubActionEvent | null {
  ensureGitHubActionsSchema(database);
  const updated = database.transaction(() => database.prepare(`
    UPDATE github_action_events SET
      status = 'dispatching',
      reason = NULL,
      error = NULL,
      dispatched_at = @at
    WHERE id = @event_id
      AND action_id = @action_id
      AND status = 'queued'
      AND action_revision = @action_revision
      AND EXISTS (
        SELECT 1 FROM github_actions
        WHERE id = @action_id AND enabled = 1 AND revision = @action_revision
      )
      AND (
        SELECT COALESCE(SUM(cost_ceiling_usd), 0)
        FROM github_action_events
        WHERE repository_key = @repository_key
          AND status IN ('dispatching', 'launched', 'failed')
          AND dispatched_at >= @day_start AND dispatched_at < @day_end
      ) + @cost_ceiling_usd <= @daily_cost_ceiling_usd
  `).run({
    event_id: input.eventId,
    action_id: input.actionId,
    repository_key: input.repositoryKey,
    action_revision: input.actionRevision,
    day_start: input.dayStart,
    day_end: input.dayEnd,
    cost_ceiling_usd: input.costCeilingUsd,
    daily_cost_ceiling_usd: input.dailyCostCeilingUsd,
    at: input.at,
  }))();
  if (updated.changes !== 1) return null;
  return getGitHubActionEvent(input.eventId, database);
}

/**
 * A process died after reserving a paid dispatch. The reservation stays spent for
 * the day — the scan may well have started — and the event becomes terminal
 * instead of being retried blindly. `exceptEventIds` are the dispatches this
 * process is running right now, which are not orphans.
 */
export function failOrphanedGitHubActionDispatches(
  now: string,
  options: { exceptEventIds?: readonly string[] } = {},
  database: Database.Database = getDb(),
): number {
  ensureGitHubActionsSchema(database);
  const live = options.exceptEventIds ?? [];
  const placeholders = live.map((_, index) => `@live_${index}`);
  const parameters: Record<string, unknown> = { now };
  live.forEach((id, index) => { parameters[`live_${index}`] = id; });
  return database.prepare(`
    UPDATE github_action_events SET
      status = 'failed',
      error = 'automatic_dispatch_uncertain',
      completed_at = COALESCE(completed_at, @now)
    WHERE status = 'dispatching'
      ${live.length === 0 ? "" : `AND id NOT IN (${placeholders.join(",")})`}
  `).run(parameters).changes;
}

/**
 * What a **repository** has reserved in one UTC day, across every action it has.
 * Cost ceilings are reservations, so a new automatic launch cannot overspend the
 * daily cap, and the cap belongs to the repository (see
 * `reserveGitHubActionEventDispatch`) — which is also why the daily-cost alert is
 * keyed by repository and not by action.
 */
export function reservedGitHubActionCostForUtcDay(
  repositoryKey: string,
  dayStart: string,
  dayEnd: string,
  database: Database.Database = getDb(),
): number {
  ensureGitHubActionsSchema(database);
  const row = database.prepare(`
    SELECT COALESCE(SUM(cost_ceiling_usd), 0) AS total
    FROM github_action_events
    WHERE repository_key = ?
      AND status IN ('dispatching', 'launched', 'failed')
      AND dispatched_at >= ? AND dispatched_at < ?
  `).get(repositoryKey, dayStart, dayEnd) as { total: number };
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

/**
 * The second half of the claim: the row was inserted before any work, so the
 * delivery id was taken and a concurrent duplicate lost; this writes what the work
 * turned out to be. A row that is not there is not recreated — it was rolled back
 * with the work it describes.
 */
export function completeWebhookDelivery(
  deliveryId: string,
  patch: WebhookDeliveryCompletion,
  database: Database.Database = getDb(),
): void {
  ensureGitHubActionsSchema(database);
  database.prepare(`
    UPDATE github_webhook_deliveries SET
      repository_key = @repository_key,
      installation_id = @installation_id,
      head_sha = @head_sha,
      outcome = @outcome,
      reason = @reason,
      matched_action_ids_json = @matched_action_ids_json,
      event_ids_json = @event_ids_json,
      duration_ms = @duration_ms
    WHERE delivery_id = @delivery_id
  `).run({
    delivery_id: deliveryId,
    repository_key: patch.repositoryKey,
    installation_id: patch.installationId,
    head_sha: patch.headSha,
    outcome: patch.outcome,
    reason: patch.reason,
    matched_action_ids_json: JSON.stringify(patch.matchedActionIds),
    event_ids_json: JSON.stringify(patch.eventIds),
    duration_ms: patch.durationMs,
  });
}

export function listWebhookDeliveries(
  limit: number,
  database: Database.Database = getDb(),
  offset = 0,
): WebhookDeliveryRecord[] {
  ensureGitHubActionsSchema(database);
  const rows = database.prepare(`
    SELECT * FROM github_webhook_deliveries ORDER BY received_at DESC, delivery_id DESC
    LIMIT ? OFFSET ?
  `).all(
    Math.max(1, Math.min(limit, 500)),
    Math.max(0, Math.min(Math.trunc(offset), 100_000)),
  ) as DeliveryRow[];
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

/**
 * How many events the reconciliation had to recover in a window, which is the
 * complement of the delivery counts above: events it created are events no
 * webhook brought. The Integration screen shows both numbers side by side.
 */
export function countReconciledEventsSince(
  isoTimestamp: string,
  database: Database.Database = getDb(),
): number {
  ensureGitHubActionsSchema(database);
  const row = database.prepare(`
    SELECT COUNT(*) AS total FROM github_action_events
    WHERE origin = 'reconciliation' AND detected_at >= ?
  `).get(isoTimestamp) as { total: number };
  return Number(row.total) || 0;
}

/**
 * The last moment a connection proved its webhook secret. A delivery is recorded
 * only after its signature verified, so the newest row for the connection is
 * exactly that moment — the evidence the readiness checklist needs, since a
 * secret that is present but wrong is indistinguishable from a right one until a
 * delivery arrives.
 */
export function lastVerifiedWebhookDeliveryAt(
  connectionId: string,
  database: Database.Database = getDb(),
): string | null {
  ensureGitHubActionsSchema(database);
  const row = database.prepare(`
    SELECT MAX(received_at) AS last FROM github_webhook_deliveries WHERE connection_id = ?
  `).get(connectionId) as { last: string | null } | undefined;
  return row?.last ?? null;
}

/**
 * Records that this connection's webhook secret was stored now. The value stays in
 * the vault; only the instant is kept, and only so a verified delivery cannot vouch
 * for the secret it replaced (ruling N-2). One row per connection: a rotation
 * overwrites the previous instant, because only the current secret matters.
 */
export function recordWebhookSecretStored(
  connectionId: string,
  storedAt: string | null = new Date().toISOString(),
  database: Database.Database = getDb(),
): void {
  ensureGitHubActionsSchema(database);
  // `null` removes the row, which is what a rollback needs: a connection whose
  // secret predates the log has no row, and writing the epoch instead would
  // silently validate every old proof.
  if (storedAt === null) {
    database.prepare("DELETE FROM github_webhook_secret_rotations WHERE connection_id = ?")
      .run(connectionId);
    return;
  }
  database.prepare(`
    INSERT INTO github_webhook_secret_rotations (connection_id, stored_at)
    VALUES (@connection_id, @stored_at)
    ON CONFLICT(connection_id) DO UPDATE SET stored_at = excluded.stored_at
  `).run({ connection_id: connectionId, stored_at: storedAt });
}

/**
 * When this connection's current webhook secret was stored, or `null` when no
 * rotation was ever recorded — a secret written by the manifest exchange before the
 * log existed. `null` must not read as "rotated at the epoch" or as "rotated now":
 * the first would validate everything and the second would invalidate a secret that
 * demonstrably works.
 */
export function webhookSecretStoredAt(
  connectionId: string,
  database: Database.Database = getDb(),
): string | null {
  ensureGitHubActionsSchema(database);
  const row = database.prepare(`
    SELECT stored_at FROM github_webhook_secret_rotations WHERE connection_id = ?
  `).get(connectionId) as { stored_at: string } | undefined;
  return row?.stored_at ?? null;
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
    includeForks: row.include_forks === 1,
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
    observedAt: row.observed_at,
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
    // Opting a fork in changes which pull requests the action sees, so the open
    // queue must not be charged retroactively for the ones it now covers.
    includeForks: action.includeForks,
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
