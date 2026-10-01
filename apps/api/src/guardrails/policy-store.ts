import type Database from "better-sqlite3";

import { parseGuardrailPolicy } from "@csb/gate-runtime";
import type { GuardrailPolicy } from "@csb/shared";

import { getDb } from "../db.js";
import {
  isGuardrailPolicyPreset,
  type GuardrailPolicyPreset,
} from "./policy-presets.js";

/**
 * Level 2 of the precedence table: the policy a maintainer edits in the Sentinel
 * interface. Level 1 is the repository's own `.csb/guardrails.json`, which this
 * table never holds and never mirrors.
 *
 * The schema is versioned on its own ladder rather than inside
 * `migrateGuardrailsSchema`, for the same reason the actions model is: the only
 * thing it needs from the rest is that `guardrail_repositories` exists, and a
 * version of its own means a later column is an `ALTER`, not a table rebuild.
 */
const POLICY_SCHEMA_VERSION = 1;

const POLICY_SCHEMA_SQL = `
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

export interface StoredRepositoryPolicy {
  policy: GuardrailPolicy;
  preset: GuardrailPolicyPreset;
  updatedAt: string;
  updatedBy: string | null;
}

interface PolicyRow {
  policy_json: string;
  preset: string;
  updated_at: string;
  updated_by: string | null;
}

/** A handle whose schema is known current, so reads do not re-probe every call. */
const migratedHandles = new WeakSet<Database.Database>();

export function ensureRepositoryPolicySchema(database: Database.Database = getDb()): void {
  if (migratedHandles.has(database)) return;
  if (recordedVersion(database) >= POLICY_SCHEMA_VERSION) {
    migratedHandles.add(database);
    return;
  }
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS guardrail_policy_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const from = recordedVersion(database);
    if (from >= POLICY_SCHEMA_VERSION) return;
    database.exec(POLICY_SCHEMA_SQL);
    database.prepare(`
      INSERT OR REPLACE INTO guardrail_policy_schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(POLICY_SCHEMA_VERSION, "repository policy written in the interface", new Date().toISOString());
  })();
  migratedHandles.add(database);
}

export function getRepositoryPolicy(
  repositoryKey: string,
  database: Database.Database = getDb(),
): StoredRepositoryPolicy | null {
  ensureRepositoryPolicySchema(database);
  const row = database.prepare(`
    SELECT policy_json, preset, updated_at, updated_by
    FROM guardrail_repository_policies
    WHERE repository_key = ?
  `).get(repositoryKey) as PolicyRow | undefined;
  if (row === undefined) return null;
  let policy: GuardrailPolicy;
  try {
    policy = parseGuardrailPolicy(JSON.parse(row.policy_json));
  } catch (error) {
    // The row was written through the same parser, so an unreadable one means the
    // database was edited outside the product. Falling to the next level is the
    // only safe answer, but it must be visible in the log rather than silent.
    console.warn(`[csb-api] Stored policy for ${repositoryKey} is unreadable: ${String(error)}`);
    return null;
  }
  return {
    policy,
    preset: isGuardrailPolicyPreset(row.preset) ? row.preset : "custom",
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export function putRepositoryPolicy(
  repositoryKey: string,
  policy: GuardrailPolicy,
  preset: GuardrailPolicyPreset,
  updatedBy: string | null,
  database: Database.Database = getDb(),
  now: string = new Date().toISOString(),
): StoredRepositoryPolicy {
  ensureRepositoryPolicySchema(database);
  if (!isGuardrailPolicyPreset(preset)) throw new Error("guardrail_policy_preset_invalid");
  // The parser is the gate's own, so what is stored is exactly what a gate would
  // accept — a row that evaluates differently from what was shown is not possible.
  const validated = parseGuardrailPolicy(policy);
  database.prepare(`
    INSERT INTO guardrail_repository_policies (
      repository_key, policy_json, preset, schema_version, updated_at, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_key) DO UPDATE SET
      policy_json = excluded.policy_json,
      preset = excluded.preset,
      schema_version = excluded.schema_version,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(repositoryKey, JSON.stringify(validated), preset, validated.schemaVersion, now, updatedBy);
  return { policy: validated, preset, updatedAt: now, updatedBy };
}

export function deleteRepositoryPolicy(
  repositoryKey: string,
  database: Database.Database = getDb(),
): boolean {
  ensureRepositoryPolicySchema(database);
  return database
    .prepare("DELETE FROM guardrail_repository_policies WHERE repository_key = ?")
    .run(repositoryKey).changes > 0;
}

function recordedVersion(database: Database.Database): number {
  const exists = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'guardrail_policy_schema_migrations'",
  ).get() !== undefined;
  if (!exists) return 0;
  const row = database
    .prepare("SELECT max(version) AS version FROM guardrail_policy_schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}
