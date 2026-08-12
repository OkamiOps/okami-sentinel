import type Database from "better-sqlite3";

export const CURRENT_GUARDRAILS_SCHEMA_VERSION = 4;

export type GuardrailsMigrationStep =
  | "repositories_rebuilt"
  | "gates_rebuilt"
  | "metadata_created"
  | "repository_executor_added"
  | "actions_dispatches_added";

export interface GuardrailsMigrationHooks {
  afterStep?(step: GuardrailsMigrationStep): void;
}

export function migrateGuardrailsSchema(
  database: Database.Database,
  hooks: GuardrailsMigrationHooks = {},
): void {
  database.pragma("foreign_keys = ON");
  if (schemaIsCurrent(database)) return;
  const migrate = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS guardrail_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const versionRow = database
      .prepare("SELECT max(version) AS version FROM guardrail_schema_migrations")
      .get() as { version: number | null };
    const currentVersion = versionRow.version ?? 0;

    if (currentVersion < 2) {
      rebuildRepositories(database);
      hooks.afterStep?.("repositories_rebuilt");
      rebuildGateRuns(database);
      hooks.afterStep?.("gates_rebuilt");
      ensureMetadataTables(database);
      hooks.afterStep?.("metadata_created");
    }

    ensureFinalRepositoryTable(database);
    ensureFinalGateRunTable(database);
    ensureMetadataTables(database);
    if (currentVersion < 3) {
      ensureRepositoryDefaultExecutor(database);
      hooks.afterStep?.("repository_executor_added");
    }
    if (currentVersion < 4) {
      hooks.afterStep?.("actions_dispatches_added");
    }
    database.prepare(`
      INSERT OR REPLACE INTO guardrail_schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(
      CURRENT_GUARDRAILS_SCHEMA_VERSION,
      "github actions dispatch reconciliation",
      new Date().toISOString(),
    );
  });
  migrate.immediate();
}

function schemaIsCurrent(database: Database.Database): boolean {
  if (!tableExists(database, "guardrail_schema_migrations")) return false;
  const row = database
    .prepare("SELECT max(version) AS version FROM guardrail_schema_migrations")
    .get() as { version: number | null };
  return (row.version ?? 0) >= CURRENT_GUARDRAILS_SCHEMA_VERSION
    && tableColumns(database, "guardrail_repositories").has("default_executor")
    && tableExists(database, "github_actions_dispatches");
}

function rebuildRepositories(database: Database.Database): void {
  if (!tableExists(database, "guardrail_repositories")) {
    ensureFinalRepositoryTable(database);
    return;
  }
  database.exec(`DROP TABLE IF EXISTS guardrail_repositories_v2`);
  createRepositoryTable(database, "guardrail_repositories_v2");
  database.exec(`
    INSERT INTO guardrail_repositories_v2 (
      repository_key, repository_path, source, display_name, default_branch, default_executor,
      remote_owner, remote_name, github_connection_id,
      github_installation_id, github_repository_id, enabled, policy_path,
      created_at, updated_at
    )
    SELECT
      repository_key, repository_path, 'local', display_name, default_branch, 'sentinel-managed',
      remote_owner, remote_name, NULL, NULL, NULL, enabled, policy_path,
      created_at, updated_at
    FROM guardrail_repositories
  `);
  database.exec(`
    DROP TABLE guardrail_repositories;
    ALTER TABLE guardrail_repositories_v2 RENAME TO guardrail_repositories;
  `);
}

function rebuildGateRuns(database: Database.Database): void {
  if (!tableExists(database, "gate_runs")) {
    ensureFinalGateRunTable(database);
    return;
  }
  const columns = tableColumns(database, "gate_runs");
  const existing = (name: string, fallback: string): string => columns.has(name) ? name : fallback;
  database.exec(`DROP TABLE IF EXISTS gate_runs_v2`);
  createGateRunTable(database, "gate_runs_v2");
  database.exec(`
    INSERT INTO gate_runs_v2 (
      id, repository_key, repository_path, source, executor, base_ref, head_ref,
      resolved_base_sha, resolved_head_sha, policy_sha, pull_request_number,
      workflow_run_id, materialization_state, scan_lineage_hash,
      artifact_schema_version, scan_id, status, outcome, policy_version,
      baseline_commit, artifact_path, publish_status, publish_error,
      published_at, error, estimated_usd, started_at, completed_at
    )
    SELECT
      id, repository_key, repository_path, 'local', 'sentinel-managed',
      base_ref, head_ref, NULL, NULL, NULL, pull_request_number, NULL,
      'not_required', NULL, 1, scan_id, status, outcome, policy_version,
      baseline_commit, artifact_path,
      ${existing("publish_status", "'not_configured'")},
      ${existing("publish_error", "NULL")},
      ${existing("published_at", "NULL")},
      error, estimated_usd, started_at, completed_at
    FROM gate_runs
  `);
  database.exec(`
    DROP TABLE gate_runs;
    ALTER TABLE gate_runs_v2 RENAME TO gate_runs;
  `);
  createGateRunIndexes(database);
}

function ensureFinalRepositoryTable(database: Database.Database): void {
  if (!tableExists(database, "guardrail_repositories")) {
    createRepositoryTable(database, "guardrail_repositories");
  }
}

function ensureFinalGateRunTable(database: Database.Database): void {
  if (!tableExists(database, "gate_runs")) {
    createGateRunTable(database, "gate_runs");
  }
  createGateRunIndexes(database);
}

function createRepositoryTable(database: Database.Database, table: string): void {
  assertInternalTableName(table);
  database.exec(`
    CREATE TABLE ${table} (
      repository_key TEXT PRIMARY KEY,
      repository_path TEXT,
      source TEXT NOT NULL,
      display_name TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      default_executor TEXT NOT NULL DEFAULT 'sentinel-managed',
      remote_owner TEXT,
      remote_name TEXT,
      github_connection_id TEXT,
      github_installation_id TEXT,
      github_repository_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      policy_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (source IN ('local', 'github')),
      CHECK (default_executor IN ('sentinel-managed', 'github-actions')),
      CHECK (source = 'github' OR default_executor = 'sentinel-managed'),
      CHECK (
        (source = 'local' AND repository_path IS NOT NULL
          AND github_connection_id IS NULL
          AND github_installation_id IS NULL
          AND github_repository_id IS NULL)
        OR
        (source = 'github' AND repository_path IS NULL
          AND github_connection_id IS NOT NULL
          AND github_installation_id IS NOT NULL
          AND github_repository_id IS NOT NULL)
      )
    )
  `);
}

function ensureRepositoryDefaultExecutor(database: Database.Database): void {
  if (tableColumns(database, "guardrail_repositories").has("default_executor")) return;
  database.exec(`DROP TABLE IF EXISTS guardrail_repositories_v3`);
  createRepositoryTable(database, "guardrail_repositories_v3");
  database.exec(`
    INSERT INTO guardrail_repositories_v3 (
      repository_key, repository_path, source, display_name, default_branch,
      default_executor, remote_owner, remote_name, github_connection_id,
      github_installation_id, github_repository_id, enabled, policy_path,
      created_at, updated_at
    )
    SELECT
      repository_key, repository_path, source, display_name, default_branch,
      'sentinel-managed', remote_owner, remote_name, github_connection_id,
      github_installation_id, github_repository_id, enabled, policy_path,
      created_at, updated_at
    FROM guardrail_repositories;
    DROP TABLE guardrail_repositories;
    ALTER TABLE guardrail_repositories_v3 RENAME TO guardrail_repositories;
  `);
}

function createGateRunTable(database: Database.Database, table: string): void {
  assertInternalTableName(table);
  database.exec(`
    CREATE TABLE ${table} (
      id TEXT PRIMARY KEY,
      repository_key TEXT NOT NULL,
      repository_path TEXT,
      source TEXT NOT NULL,
      executor TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      head_ref TEXT NOT NULL,
      resolved_base_sha TEXT,
      resolved_head_sha TEXT,
      policy_sha TEXT,
      pull_request_number INTEGER,
      workflow_run_id TEXT,
      materialization_state TEXT NOT NULL,
      scan_lineage_hash TEXT,
      artifact_schema_version INTEGER NOT NULL,
      scan_id TEXT,
      status TEXT NOT NULL,
      outcome TEXT,
      policy_version INTEGER NOT NULL,
      baseline_commit TEXT,
      artifact_path TEXT,
      publish_status TEXT NOT NULL DEFAULT 'not_configured',
      publish_error TEXT,
      published_at TEXT,
      error TEXT,
      estimated_usd REAL NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK (source IN ('local', 'github')),
      CHECK (executor IN ('sentinel-managed', 'github-actions')),
      CHECK (source = 'github' OR executor = 'sentinel-managed'),
      CHECK (
        (source = 'local' AND repository_path IS NOT NULL)
        OR (source = 'github' AND repository_path IS NULL)
      ),
      CHECK (materialization_state IN (
        'not_required', 'queued', 'materializing', 'ready', 'released', 'failed'
      )),
      CHECK (artifact_schema_version >= 1)
    )
  `);
}

function createGateRunIndexes(database: Database.Database): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS gate_runs_by_repository_started
      ON gate_runs(repository_key, started_at DESC);
    CREATE INDEX IF NOT EXISTS gate_runs_by_workflow_run
      ON gate_runs(workflow_run_id)
      WHERE workflow_run_id IS NOT NULL;
  `);
}

function ensureMetadataTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS gate_events (
      gate_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (gate_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS github_baselines (
      repository_key TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gate_publication_attempts (
      id TEXT PRIMARY KEY,
      gate_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gate_publication_attempts_by_gate
      ON gate_publication_attempts(gate_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS github_app_connections (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      app_slug TEXT NOT NULL,
      client_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS github_app_installations (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      account_login TEXT NOT NULL,
      account_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (connection_id) REFERENCES github_app_connections(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS github_app_installations_by_connection
      ON github_app_installations(connection_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS github_installation_repositories (
      repository_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      is_private INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (installation_id) REFERENCES github_app_installations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS github_installation_repositories_by_installation
      ON github_installation_repositories(installation_id, owner, name);

    CREATE TABLE IF NOT EXISTS materialization_leases (
      id TEXT PRIMARY KEY,
      gate_id TEXT NOT NULL,
      repository_key TEXT NOT NULL,
      snapshot_identity TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT,
      FOREIGN KEY (gate_id) REFERENCES gate_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_key) REFERENCES guardrail_repositories(repository_key) ON DELETE CASCADE,
      CHECK (state IN ('queued', 'materializing', 'ready', 'released', 'failed'))
    );
    CREATE INDEX IF NOT EXISTS materialization_leases_by_gate
      ON materialization_leases(gate_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS github_actions_artifacts (
      id TEXT PRIMARY KEY,
      gate_id TEXT NOT NULL,
      repository_key TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL,
      workflow_run_attempt INTEGER NOT NULL,
      artifact_name TEXT NOT NULL,
      artifact_digest TEXT NOT NULL,
      artifact_schema_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      validated_at TEXT,
      FOREIGN KEY (gate_id) REFERENCES gate_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_key) REFERENCES guardrail_repositories(repository_key) ON DELETE CASCADE,
      CHECK (workflow_run_attempt > 0),
      CHECK (artifact_schema_version >= 1),
      CHECK (status IN ('pending', 'validated', 'rejected'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS github_actions_artifacts_by_run_attempt
      ON github_actions_artifacts(repository_key, workflow_run_id, workflow_run_attempt, artifact_name);

    CREATE TABLE IF NOT EXISTS github_actions_dispatches (
      gate_id TEXT PRIMARY KEY,
      repository_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      workflow_path TEXT NOT NULL,
      workflow_ref TEXT NOT NULL,
      release_sha TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      protected_branch TEXT NOT NULL,
      expected_run_name TEXT NOT NULL,
      expected_head_sha TEXT NOT NULL,
      state TEXT NOT NULL,
      workflow_run_id TEXT,
      workflow_run_attempt INTEGER,
      requested_at TEXT NOT NULL,
      dispatched_at TEXT,
      last_polled_at TEXT,
      completed_at TEXT,
      error TEXT,
      FOREIGN KEY (gate_id) REFERENCES gate_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_key) REFERENCES guardrail_repositories(repository_key) ON DELETE CASCADE,
      UNIQUE (repository_key, idempotency_key),
      UNIQUE (workflow_run_id),
      CHECK (target_kind IN ('pull_request', 'compare', 'protected_branch')),
      CHECK (state IN (
        'dispatch_requested', 'dispatch_accepted', 'correlating', 'running',
        'artifact_pending', 'completed', 'failed', 'cancelled'
      )),
      CHECK (workflow_run_attempt IS NULL OR workflow_run_attempt > 0)
    );
    CREATE INDEX IF NOT EXISTS github_actions_dispatches_by_state
      ON github_actions_dispatches(state, requested_at);
  `);
}

function tableExists(database: Database.Database, name: string): boolean {
  return database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) !== undefined;
}

function tableColumns(database: Database.Database, table: string): Set<string> {
  assertInternalTableName(table);
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((entry) => entry.name),
  );
}

function assertInternalTableName(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error("Invalid internal table name");
}
