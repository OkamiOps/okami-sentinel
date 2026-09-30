/**
 * The DDL of the actions model, in one place because two modules need it and
 * neither may import the other: `store.ts` exposes `ensureGitHubActionsSchema`,
 * which runs the monitor-rule migration, and the migration must be able to
 * create the tables it writes into when it is invoked on its own.
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (repository_key, trigger_kind, name),
    CHECK (trigger_kind IN ('pull_request', 'push')),
    CHECK (executor IN ('sentinel-managed', 'github-actions')),
    CHECK (enabled IN (0, 1)),
    CHECK (revision >= 1),
    CHECK (cost_ceiling_usd > 0),
    CHECK (daily_cost_ceiling_usd IS NULL OR daily_cost_ceiling_usd > 0),
    CHECK (length(name) BETWEEN 1 AND 80)
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
