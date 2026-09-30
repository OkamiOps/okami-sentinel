import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { migrateMonitorRulesToActions } from "./migrate-monitor-rules.js";
import { listGitHubActionEvents, listGitHubActions } from "./store.js";

const SHA_PR = "a".repeat(40);
const SHA_PUSH = "b".repeat(40);

/** The shape production still carries: one rule per repository, both event kinds. */
function legacyDb(options: { costCeilingUsd: number | null } = { costCeilingUsd: 3 }): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY);
    CREATE TABLE github_monitor_rules (
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
      updated_at TEXT NOT NULL
    );
    CREATE TABLE github_monitor_events (
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
      target_identity TEXT NOT NULL,
      title TEXT,
      gate_id TEXT,
      cost_ceiling_usd REAL,
      reason TEXT,
      error TEXT,
      detected_at TEXT NOT NULL,
      dispatched_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (rule_id) REFERENCES github_monitor_rules(id) ON DELETE CASCADE
    );
    CREATE TABLE github_monitor_actions_runs (id TEXT PRIMARY KEY);
    CREATE TABLE github_monitor_poll_leases (rule_id TEXT PRIMARY KEY);
    INSERT INTO guardrail_repositories VALUES ('github:1');
  `);
  db.prepare(`
    INSERT INTO github_monitor_rules (
      id, repository_key, connection_id, installation_id, repository_id, executor,
      scanner_json, cost_ceiling_usd, daily_cost_ceiling_usd, follow_branches_json,
      checkout_mode, enabled, revision, baseline_initialized_at, last_polled_at,
      last_error, created_at, updated_at
    ) VALUES (
      'rule-1', 'github:1', 'c1', 'i1', '1', 'sentinel-managed',
      NULL, @cost_ceiling_usd, 9, '["main"]',
      'none', 1, 4, '2026-09-20T08:00:00.000Z', '2026-09-29T08:00:00.000Z',
      NULL, '2026-09-01T08:00:00.000Z', '2026-09-29T08:00:00.000Z'
    )
  `).run({ cost_ceiling_usd: options.costCeilingUsd });
  db.exec(`
    INSERT INTO github_monitor_events (
      id, rule_id, repository_key, rule_revision, kind, status, head_sha, base_ref,
      head_ref, pull_request_number, target_identity, title, gate_id, cost_ceiling_usd,
      reason, error, detected_at, dispatched_at, completed_at
    ) VALUES
      ('event-pr', 'rule-1', 'github:1', 4, 'pull_request', 'launched', '${SHA_PR}', 'main',
       'feature/login', 7, 'legacy', 'Login', 'g1', 3,
       NULL, NULL, '2026-09-28T09:00:00.000Z', '2026-09-28T09:00:01.000Z', '2026-09-28T09:10:00.000Z'),
      ('event-push', 'rule-1', 'github:1', 4, 'push', 'observed', '${SHA_PUSH}', NULL,
       'main', NULL, 'legacy-push', NULL, NULL, NULL,
       'initial_baseline', NULL, '2026-09-28T08:00:00.000Z', NULL, NULL);
  `);
  return db;
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

test("turns one monitor rule into a PR action and a push action", () => {
  const db = legacyDb();
  const result = migrateMonitorRulesToActions(db);
  assert.deepEqual(result, { actions: 2, events: 2, skipped: 0 });
  const actions = listGitHubActions({ repositoryKey: "github:1" }, db);
  assert.deepEqual(
    actions.map((a) => [a.name, a.triggerKind, a.enabled]).sort(),
    [["PR", "pull_request", true], ["Push", "push", true]],
  );
  assert.deepEqual(actions[0]!.branchPatterns, ["main"]);
});

test("copies the authority, the ceilings and the baseline of the rule onto both actions", () => {
  const db = legacyDb();
  migrateMonitorRulesToActions(db);
  for (const action of listGitHubActions({ repositoryKey: "github:1" }, db)) {
    assert.equal(action.connectionId, "c1");
    assert.equal(action.installationId, "i1");
    assert.equal(action.repositoryId, "1");
    assert.equal(action.executor, "sentinel-managed");
    assert.equal(action.costCeilingUsd, 3);
    assert.equal(action.dailyCostCeilingUsd, 9);
    assert.equal(action.baselineInitializedAt, "2026-09-20T08:00:00.000Z");
    assert.equal(action.lastReconciledAt, "2026-09-29T08:00:00.000Z");
    // A rule that was already past its baseline must not have its revision reset
    // into a state where the open pull requests look new.
    assert.equal(action.revision, 1);
    assert.equal(action.lastError, null);
  }
});

test("migrates a rule without a ceiling as disabled", () => {
  const db = legacyDb({ costCeilingUsd: null });
  assert.deepEqual(migrateMonitorRulesToActions(db), { actions: 2, events: 2, skipped: 0 });
  for (const action of listGitHubActions({ repositoryKey: "github:1" }, db)) {
    assert.equal(action.enabled, false);
    assert.equal(action.costCeilingUsd, 1);
    assert.equal(action.lastError, "migrated_without_ceiling");
  }
});

test("preserves the gate id on migrated events", () => {
  const db = legacyDb();
  migrateMonitorRulesToActions(db);
  const events = listGitHubActionEvents({ repositoryKeys: ["github:1"] }, db);
  assert.equal(events.length, 2);
  const pullRequest = events.find((event) => event.id === "event-pr")!;
  assert.equal(pullRequest.gateId, "g1");
  assert.equal(pullRequest.status, "launched");
  assert.equal(pullRequest.origin, "reconciliation");
  assert.equal(pullRequest.deliveryId, null);
  assert.equal(pullRequest.targetIdentity, `pr:7@${SHA_PR}`);
  assert.equal(pullRequest.detectedAt, "2026-09-28T09:00:00.000Z");
  assert.equal(pullRequest.completedAt, "2026-09-28T09:10:00.000Z");

  const push = events.find((event) => event.id === "event-push")!;
  assert.equal(push.targetIdentity, `push:main@${SHA_PUSH}`);
  assert.equal(push.reason, "initial_baseline");

  // Each event hangs off the action of its own kind.
  const actions = listGitHubActions({ repositoryKey: "github:1" }, db);
  const prAction = actions.find((action) => action.triggerKind === "pull_request")!;
  const pushAction = actions.find((action) => action.triggerKind === "push")!;
  assert.equal(pullRequest.actionId, prAction.id);
  assert.equal(push.actionId, pushAction.id);
  assert.equal(prAction.lastEventAt, "2026-09-28T09:00:00.000Z");
  assert.equal(pushAction.lastEventAt, "2026-09-28T08:00:00.000Z");
});

test("renames the legacy tables and is a no-op on the second run", () => {
  const db = legacyDb();
  migrateMonitorRulesToActions(db);
  assert.deepEqual(migrateMonitorRulesToActions(db), { actions: 0, events: 0, skipped: 0 });
  assert.ok(tableExists(db, "github_monitor_rules_migrated"));
  assert.ok(!tableExists(db, "github_monitor_rules"));
  assert.ok(tableExists(db, "github_monitor_events_migrated"));
  assert.ok(tableExists(db, "github_monitor_actions_runs_migrated"));
  assert.ok(tableExists(db, "github_monitor_poll_leases_migrated"));
  assert.equal(listGitHubActions({ repositoryKey: "github:1" }, db).length, 2);
});

test("is a no-op on a database that never had monitor rules", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  assert.deepEqual(migrateMonitorRulesToActions(db), { actions: 0, events: 0, skipped: 0 });
  assert.ok(tableExists(db, "github_actions"));
  assert.ok(tableExists(db, "github_action_events"));
  assert.ok(tableExists(db, "github_webhook_deliveries"));
});

test("leaves a rule whose repository is gone out of the new model", () => {
  const db = legacyDb();
  db.exec("DELETE FROM guardrail_repositories");
  assert.deepEqual(migrateMonitorRulesToActions(db), { actions: 0, events: 0, skipped: 3 });
  assert.equal(listGitHubActions({}, db).length, 0);
});
