import type { GitHubActionTargetIdentity, GitHubActionTriggerKind } from "@csb/shared";

/** 1..20 patterns, the bound the DDL enforces and `assertBranchPatterns` repeats. */
export const MAX_BRANCH_PATTERNS = 20;

/**
 * The shape of the actions model and the key it is deduplicated by, in one place
 * because two modules need both and neither may import the other: `store.ts`
 * exposes `ensureGitHubActionsSchema`, which runs the monitor-rule migration, and
 * the migration must be able to create and key the rows it writes when it is
 * invoked on its own.
 */
export const GITHUB_ACTIONS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS github_actions (
    id TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL REFERENCES guardrail_repositories(repository_key) ON DELETE CASCADE,
    name TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    branch_patterns_json TEXT NOT NULL,
    executor TEXT NOT NULL DEFAULT 'sentinel-managed',
    connection_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    scanner_json TEXT,
    cost_ceiling_usd REAL NOT NULL,
    daily_cost_ceiling_usd REAL,
    enabled INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    baseline_initialized_at TEXT,
    created_by TEXT,
    last_event_at TEXT,
    last_reconciled_at TEXT,
    last_error TEXT,
    migration_note TEXT,
    include_forks INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (repository_key, trigger_kind, name),
    CHECK (trigger_kind IN ('pull_request', 'push')),
    CHECK (executor IN ('sentinel-managed', 'github-actions')),
    CHECK (enabled IN (0, 1)),
    CHECK (include_forks IN (0, 1)),
    CHECK (revision >= 1),
    CHECK (cost_ceiling_usd > 0),
    CHECK (daily_cost_ceiling_usd IS NULL OR daily_cost_ceiling_usd > 0),
    CHECK (length(name) BETWEEN 1 AND 80),
    CHECK (migration_note IS NULL OR length(migration_note) <= 500),
    -- The bound lives in the database, not in one code path: an action that
    -- cannot pass its own validation could never be edited or disabled again.
    CHECK (json_array_length(branch_patterns_json) BETWEEN 1 AND ${MAX_BRANCH_PATTERNS})
  );
  CREATE INDEX IF NOT EXISTS github_actions_by_repository
    ON github_actions(repository_key, trigger_kind, name);
  CREATE INDEX IF NOT EXISTS github_actions_by_enabled
    ON github_actions(enabled, repository_key);

  CREATE TABLE IF NOT EXISTS github_action_events (
    id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL REFERENCES github_actions(id) ON DELETE CASCADE,
    repository_key TEXT NOT NULL,
    action_revision INTEGER NOT NULL,
    origin TEXT NOT NULL,
    delivery_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    base_ref TEXT,
    head_ref TEXT NOT NULL,
    pull_request_number INTEGER,
    target_identity TEXT NOT NULL,
    title TEXT,
    gate_id TEXT,
    cost_ceiling_usd REAL,
    reason TEXT,
    error TEXT,
    detected_at TEXT NOT NULL,
    -- GitHub's own clock for the change that produced this event, so two
    -- deliveries of the same target can be ordered by when the change happened
    -- rather than by when we happened to receive them.
    observed_at TEXT,
    dispatched_at TEXT,
    completed_at TEXT,
    CHECK (origin IN ('webhook', 'reconciliation', 'manual')),
    CHECK (kind IN ('pull_request', 'push')),
    CHECK (status IN ('observed', 'queued', 'dispatching', 'launched', 'skipped', 'failed', 'superseded')),
    CHECK (length(head_sha) = 40),
    CHECK (pull_request_number IS NULL OR pull_request_number > 0),
    UNIQUE (action_id, action_revision, target_identity)
  );
  CREATE INDEX IF NOT EXISTS github_action_events_by_action_status
    ON github_action_events(action_id, status, detected_at ASC);
  CREATE INDEX IF NOT EXISTS github_action_events_by_action_dispatch
    ON github_action_events(action_id, dispatched_at);
  CREATE INDEX IF NOT EXISTS github_action_events_by_pr
    ON github_action_events(action_id, pull_request_number, status);
  CREATE INDEX IF NOT EXISTS github_action_events_by_repository
    ON github_action_events(repository_key, detected_at DESC);

  CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
    delivery_id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    event TEXT NOT NULL,
    action TEXT,
    repository_key TEXT,
    installation_id TEXT,
    head_sha TEXT,
    outcome TEXT NOT NULL,
    reason TEXT,
    matched_action_ids_json TEXT NOT NULL DEFAULT '[]',
    event_ids_json TEXT NOT NULL DEFAULT '[]',
    received_at TEXT NOT NULL,
    duration_ms INTEGER,
    CHECK (outcome IN ('processed', 'ignored', 'failed'))
  );
  CREATE INDEX IF NOT EXISTS github_webhook_deliveries_by_received
    ON github_webhook_deliveries(received_at DESC);
`;

/** The most recent deliveries kept; the excess is pruned in the insert transaction. */
export const WEBHOOK_DELIVERY_RETENTION = 2000;

/**
 * A full-table prune on every delivery would scan the table for nothing: the
 * ceiling is a retention policy, not an invariant. One prune every hundred
 * inserts keeps the overshoot bounded and the hot path a single INSERT.
 */
export const WEBHOOK_DELIVERY_PRUNE_EVERY = 100;

/**
 * The canonical deduplication key of an event, and the only way to obtain the
 * branded type the store accepts. `check_run.rerequested` is the one caller that
 * appends a suffix, through `rerunTargetIdentity`: a person asked for the same
 * commit again, so it must not collide with the automatic event that already ran.
 */
export function gitHubActionEventTargetIdentity(input: {
  kind: GitHubActionTriggerKind;
  headSha: string;
  headRef: string;
  pullRequestNumber?: number | null;
}): GitHubActionTargetIdentity {
  if (input.kind === "pull_request") {
    if (input.pullRequestNumber === null || input.pullRequestNumber === undefined) {
      throw new Error("github_action_event_pull_request_number_required");
    }
    return `pr:${input.pullRequestNumber}@${input.headSha}` as GitHubActionTargetIdentity;
  }
  return `push:${shortBranchName(input.headRef)}@${input.headSha}` as GitHubActionTargetIdentity;
}

export function rerunTargetIdentity(
  base: GitHubActionTargetIdentity,
  checkRunId: string,
): GitHubActionTargetIdentity {
  return `${base}#rerun:${checkRunId}` as GitHubActionTargetIdentity;
}

/**
 * A push payload carries `refs/heads/main` while the branch listing carries
 * `main`. One meaning per column, or a scoped supersede silently matches nothing
 * and the same branch is paid for twice.
 */
export function shortBranchName(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}
