import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  CURRENT_GUARDRAILS_SCHEMA_VERSION,
  migrateGuardrailsSchema,
} from "./guardrails-migrations.js";

test("migrates every legacy guardrail row atomically and idempotently", () => {
  const database = new Database(":memory:");
  try {
    createLegacyGuardrailsFixture(database);
    migrateGuardrailsSchema(database);
    migrateGuardrailsSchema(database);

    assert.equal(column(database, "guardrail_repositories", "repository_path").notnull, 0);
    assert.equal(column(database, "gate_runs", "repository_path").notnull, 0);
    assert.deepEqual(
      database.prepare(`
        SELECT repository_key, repository_path, source, default_executor,
               github_connection_id, github_installation_id, github_repository_id
        FROM guardrail_repositories
      `).all(),
      [{
        repository_key: "local:fixture",
        repository_path: "/fixture/repository",
        source: "local",
        default_executor: "sentinel-managed",
        github_connection_id: null,
        github_installation_id: null,
        github_repository_id: null,
      }],
    );
    assert.deepEqual(
      database.prepare(`
        SELECT id, repository_path, source, executor, resolved_base_sha,
               resolved_head_sha, policy_sha, workflow_run_id,
               materialization_state, scan_lineage_hash, artifact_schema_version
        FROM gate_runs
      `).all(),
      [{
        id: "gate-legacy",
        repository_path: "/fixture/repository",
        source: "local",
        executor: "sentinel-managed",
        resolved_base_sha: null,
        resolved_head_sha: null,
        policy_sha: null,
        workflow_run_id: null,
        materialization_state: "not_required",
        scan_lineage_hash: null,
        artifact_schema_version: 1,
      }],
    );
    assert.deepEqual(rowCounts(database), {
      repositories: 1,
      gates: 1,
      events: 1,
      baselines: 1,
      attempts: 1,
    });
    assert.deepEqual(
      database.prepare("SELECT * FROM gate_events").all(),
      [{
        gate_id: "gate-legacy",
        sequence: 1,
        type: "done",
        payload_json: '{"status":"completed"}',
        created_at: NOW,
      }],
    );
    assert.deepEqual(
      database.prepare("SELECT * FROM github_baselines").all(),
      [{
        repository_key: "local:fixture",
        workflow_run_id: "run-legacy",
        head_sha: "head-sha",
        artifact_path: "/fixture/baseline.json",
        fetched_at: NOW,
      }],
    );
    assert.deepEqual(
      database.prepare("SELECT * FROM gate_publication_attempts").all(),
      [{
        id: "attempt-legacy",
        gate_id: "gate-legacy",
        status: "published",
        error: null,
        created_at: NOW,
      }],
    );
    assert.deepEqual(
      database.prepare("SELECT version FROM guardrail_schema_migrations ORDER BY version").all(),
      [{ version: CURRENT_GUARDRAILS_SCHEMA_VERSION }],
    );
  } finally {
    database.close();
  }
});

test("adds a default executor without losing an existing v2 remote enrollment", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE guardrail_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO guardrail_schema_migrations VALUES (
        2, 'remote repositories and GateArtifact v2', '${NOW}'
      );
      CREATE TABLE guardrail_repositories (
        repository_key TEXT PRIMARY KEY,
        repository_path TEXT,
        source TEXT NOT NULL,
        display_name TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        remote_owner TEXT,
        remote_name TEXT,
        github_connection_id TEXT,
        github_installation_id TEXT,
        github_repository_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        policy_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO guardrail_repositories VALUES (
        'github:991122', NULL, 'github', 'OkamiOps/private-sentinel', 'main',
        'OkamiOps', 'private-sentinel', 'connection-1', '77', '991122', 1,
        '.csb/guardrails.json', '${NOW}', '${NOW}'
      );
    `);

    migrateGuardrailsSchema(database);

    assert.deepEqual(database.prepare(`
      SELECT repository_key, source, repository_path, default_executor,
             github_connection_id, github_installation_id, github_repository_id
      FROM guardrail_repositories
    `).all(), [{
      repository_key: "github:991122",
      source: "github",
      repository_path: null,
      default_executor: "sentinel-managed",
      github_connection_id: "connection-1",
      github_installation_id: "77",
      github_repository_id: "991122",
    }]);
    assert.throws(
      () => database.prepare(
        "UPDATE guardrail_repositories SET source = 'local', default_executor = 'github-actions'",
      ).run(),
      /constraint/i,
    );
  } finally {
    database.close();
  }
});

test("rolls the complete migration back when a rebuild step fails", () => {
  const database = new Database(":memory:");
  try {
    createLegacyGuardrailsFixture(database);
    assert.throws(
      () => migrateGuardrailsSchema(database, {
        afterStep(step) {
          if (step === "repositories_rebuilt") throw new Error("injected migration failure");
        },
      }),
      /injected migration failure/,
    );

    assert.equal(column(database, "guardrail_repositories", "repository_path").notnull, 1);
    assert.equal(column(database, "gate_runs", "repository_path").notnull, 1);
    assert.deepEqual(rowCounts(database), {
      repositories: 1,
      gates: 1,
      events: 1,
      baselines: 1,
      attempts: 1,
    });
    assert.equal(tableExists(database, "guardrail_schema_migrations"), false);
    assert.equal(tableExists(database, "guardrail_repositories_v2"), false);
  } finally {
    database.close();
  }
});

test("keeps remote metadata tables, indexes and foreign keys after reopening", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-guardrails-migration-"));
  const databasePath = path.join(root, "guardrails.sqlite3");
  try {
    const first = new Database(databasePath);
    migrateGuardrailsSchema(first);
    first.prepare(`
      INSERT INTO github_app_connections (
        id, app_id, app_slug, client_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("connection-1", "101", "okami-sentinel", "Iv1.client", "ready", NOW, NOW);
    first.prepare(`
      INSERT INTO github_app_installations (
        id, connection_id, account_login, account_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("installation-1", "connection-1", "OkamiOps", "Organization", "ready", NOW, NOW);
    first.close();

    const reopened = new Database(databasePath);
    reopened.pragma("foreign_keys = ON");
    migrateGuardrailsSchema(reopened);
    assert.deepEqual(
      reopened.prepare("SELECT id, connection_id FROM github_app_installations").all(),
      [{ id: "installation-1", connection_id: "connection-1" }],
    );
    assert.equal(indexExists(reopened, "gate_runs_by_repository_started"), true);
    assert.equal(indexExists(reopened, "github_installation_repositories_by_installation"), true);
    assert.equal(
      (reopened.prepare("PRAGMA foreign_key_list(github_app_installations)").all() as unknown[]).length,
      1,
    );
    assert.throws(
      () => reopened.prepare(`
        INSERT INTO github_app_installations (
          id, connection_id, account_login, account_type, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("installation-bad", "missing", "Nobody", "User", "ready", NOW, NOW),
      /foreign key/i,
    );
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const NOW = "2026-08-12T12:00:00.000Z";

function createLegacyGuardrailsFixture(database: Database.Database): void {
  database.exec(`
    CREATE TABLE guardrail_repositories (
      repository_key TEXT PRIMARY KEY,
      repository_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      remote_owner TEXT,
      remote_name TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      policy_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE gate_runs (
      id TEXT PRIMARY KEY,
      repository_key TEXT NOT NULL,
      repository_path TEXT NOT NULL,
      source TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      head_ref TEXT NOT NULL,
      pull_request_number INTEGER,
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
      completed_at TEXT
    );
    CREATE INDEX gate_runs_by_repository_started
      ON gate_runs(repository_key, started_at DESC);
    CREATE TABLE gate_events (
      gate_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (gate_id, sequence)
    );
    CREATE TABLE github_baselines (
      repository_key TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE gate_publication_attempts (
      id TEXT PRIMARY KEY,
      gate_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX gate_publication_attempts_by_gate
      ON gate_publication_attempts(gate_id, created_at DESC);

    INSERT INTO guardrail_repositories VALUES (
      'local:fixture', '/fixture/repository', 'Fixture', 'main',
      'OkamiOps', 'fixture', 1, '.csb/guardrails.json', '${NOW}', '${NOW}'
    );
    INSERT INTO gate_runs VALUES (
      'gate-legacy', 'local:fixture', '/fixture/repository', 'github',
      'main', 'feature', 7, 'scan-legacy', 'completed', 'blocked', 1,
      'base-sha', '/fixture/gate.json', 'published', NULL, '${NOW}', NULL,
      1.25, '${NOW}', '${NOW}'
    );
    INSERT INTO gate_events VALUES (
      'gate-legacy', 1, 'done', '{"status":"completed"}', '${NOW}'
    );
    INSERT INTO github_baselines VALUES (
      'local:fixture', 'run-legacy', 'head-sha', '/fixture/baseline.json', '${NOW}'
    );
    INSERT INTO gate_publication_attempts VALUES (
      'attempt-legacy', 'gate-legacy', 'published', NULL, '${NOW}'
    );
  `);
}

function column(database: Database.Database, table: string, name: string): { notnull: number } {
  const result = database.prepare(`PRAGMA table_info(${table})`).all()
    .find((value) => (value as { name: string }).name === name) as { notnull: number } | undefined;
  assert.ok(result, `${table}.${name} must exist`);
  return result;
}

function rowCounts(database: Database.Database): Record<string, number> {
  const count = (table: string): number =>
    (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    repositories: count("guardrail_repositories"),
    gates: count("gate_runs"),
    events: count("gate_events"),
    baselines: count("github_baselines"),
    attempts: count("gate_publication_attempts"),
  };
}

function tableExists(database: Database.Database, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function indexExists(database: Database.Database, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) !== undefined;
}
