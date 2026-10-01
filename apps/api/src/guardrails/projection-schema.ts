/**
 * The DDL of the two tables the Guardrails list reads alongside the registry: the
 * policy a maintainer saved, and the baseline projection.
 *
 * It lives in a module that imports nothing so three callers can share it without a
 * cycle: `policy-store` and `baseline-state` own their own version ladders, and
 * `migrateGuardrailsSchema` creates both tables as part of the guardrails schema —
 * because `listGuardrailRepositoryRows` joins them, and a `LEFT JOIN` against a
 * table that does not exist is not a null row, it is an error.
 */
export const REPOSITORY_POLICY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS guardrail_repository_policies (
    repository_key TEXT PRIMARY KEY REFERENCES guardrail_repositories(repository_key) ON DELETE CASCADE,
    policy_json TEXT NOT NULL,
    preset TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT,
    CHECK (preset IN ('block-critical-high', 'block-critical', 'warn-only', 'custom'))
  );
`;

export const REPOSITORY_BASELINE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS guardrail_repository_baselines (
    repository_key TEXT PRIMARY KEY REFERENCES guardrail_repositories(repository_key) ON DELETE CASCADE,
    state TEXT NOT NULL,
    gate_id TEXT,
    commit_sha TEXT,
    protected_branch TEXT,
    scan_lineage_hash TEXT,
    built_at TEXT,
    stale_reason TEXT,
    requested_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK (state IN ('absent', 'building', 'ready', 'stale'))
  );
`;
