import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  migrateMonitorRulesToActions,
  rollbackGitHubActionsMigration,
} from "./migrate-monitor-rules.js";
import { listGitHubActionEvents, listGitHubActions, patchGitHubAction } from "./store.js";

const SHA_PR = "a".repeat(40);
const SHA_PUSH = "b".repeat(40);
const SHA_STALE = "c".repeat(40);
const SHA_STALE_DONE = "d".repeat(40);

/** The shape production still carries: one rule per repository, both event kinds. */
function legacyDb(options: {
  costCeilingUsd?: number | null;
  followBranches?: string[];
} = {}): Database.Database {
  const costCeilingUsd = options.costCeilingUsd === undefined ? 3 : options.costCeilingUsd;
  const followBranches = options.followBranches ?? ["main"];
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
      NULL, @cost_ceiling_usd, 9, @follow_branches_json,
      'none', 1, 4, '2026-09-20T08:00:00.000Z', '2026-09-29T08:00:00.000Z',
      NULL, '2026-09-01T08:00:00.000Z', '2026-09-29T08:00:00.000Z'
    )
  `).run({ cost_ceiling_usd: costCeilingUsd, follow_branches_json: JSON.stringify(followBranches) });
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

test("leaves a queued event from an abandoned revision out of the live queue", () => {
  const db = legacyDb();
  // The legacy dispatcher skipped any event whose rule_revision had moved on
  // (github-monitor/service.ts:354), so a rule at revision 4 carries dead queued
  // rows from 1..3. Rewriting them to the live revision would pay for commits the
  // operator abandoned weeks ago.
  db.exec(`
    INSERT INTO github_monitor_events (
      id, rule_id, repository_key, rule_revision, kind, status, head_sha, base_ref,
      head_ref, pull_request_number, target_identity, title, gate_id, cost_ceiling_usd,
      reason, error, detected_at, dispatched_at, completed_at
    ) VALUES
      ('event-stale', 'rule-1', 'github:1', 2, 'pull_request', 'queued', '${SHA_STALE}', 'main',
       'feature/old', 3, 'legacy', 'Old', NULL, 3,
       NULL, NULL, '2026-09-10T09:00:00.000Z', NULL, NULL),
      ('event-stale-done', 'rule-1', 'github:1', 2, 'pull_request', 'launched', '${SHA_STALE_DONE}', 'main',
       'feature/older', 2, 'legacy', 'Older', 'g0', 3,
       NULL, NULL, '2026-09-09T09:00:00.000Z', '2026-09-09T09:00:01.000Z', '2026-09-09T09:20:00.000Z');
  `);
  assert.deepEqual(migrateMonitorRulesToActions(db, "2026-09-30T12:00:00.000Z"),
    { actions: 2, events: 4, skipped: 0 });
  const events = listGitHubActionEvents({ repositoryKeys: ["github:1"], limit: 50 }, db);

  const stale = events.find((event) => event.id === "event-stale")!;
  assert.equal(stale.status, "superseded");
  assert.equal(stale.reason, "migrated_stale_revision");
  assert.equal(stale.completedAt, "2026-09-30T12:00:00.000Z");

  // A terminal event of an abandoned revision is history, and history survives.
  const staleDone = events.find((event) => event.id === "event-stale-done")!;
  assert.equal(staleDone.status, "launched");
  assert.equal(staleDone.gateId, "g0");
  assert.equal(staleDone.completedAt, "2026-09-09T09:20:00.000Z");

  // The current revision's own rows are untouched.
  assert.equal(events.find((event) => event.id === "event-push")!.status, "observed");
  assert.equal(
    listGitHubActionEvents({ repositoryKeys: ["github:1"], statuses: ["queued"] }, db).length,
    0,
  );
});

test("clamps a rule that follows more branches than an action may hold", () => {
  const followBranches = Array.from({ length: 25 }, (_, index) => `release/${index}`);
  const db = legacyDb({ followBranches });
  assert.deepEqual(migrateMonitorRulesToActions(db), { actions: 2, events: 2, skipped: 0 });
  for (const action of listGitHubActions({ repositoryKey: "github:1" }, db)) {
    assert.equal(action.branchPatterns.length, 20);
    assert.deepEqual(action.branchPatterns, followBranches.slice(0, 20));
    // An action that fails its own validation could never be edited again, so it
    // must not also be firing.
    assert.equal(action.enabled, false);
    assert.match(action.migrationNote!, /^migrated_pattern_overflow:/);
    assert.match(action.migrationNote!, /release\/20/);
    assert.match(action.migrationNote!, /release\/24/);
  }
});

test("migrates a rule that follows no branch as disabled", () => {
  const db = legacyDb({ followBranches: [] });
  migrateMonitorRulesToActions(db);
  for (const action of listGitHubActions({ repositoryKey: "github:1" }, db)) {
    assert.deepEqual(action.branchPatterns, ["*"]);
    assert.equal(action.enabled, false);
    assert.equal(action.migrationNote, "migrated_pattern_missing");
  }
});

test("taking the branch patterns over clears the migration note", () => {
  const db = legacyDb({ followBranches: [] });
  migrateMonitorRulesToActions(db);
  const action = listGitHubActions({ repositoryKey: "github:1" }, db)[0]!;
  assert.equal(patchGitHubAction(action.id, { name: "Renamed" }, db)!.migrationNote, "migrated_pattern_missing");
  assert.equal(patchGitHubAction(action.id, { branchPatterns: ["main"] }, db)!.migrationNote, null);
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

test("rolls the rename back so a downgraded release finds its rules again", () => {
  const db = legacyDb();
  migrateMonitorRulesToActions(db);
  // Rolling the API back makes ensureGitHubMonitorSchema recreate these empty on
  // its first call; the poller would then find zero rules and stop firing in
  // silence while the real ones sat in the _migrated tables.
  db.exec(`
    CREATE TABLE github_monitor_rules (id TEXT PRIMARY KEY);
    CREATE TABLE github_monitor_events (id TEXT PRIMARY KEY);
  `);

  const result = rollbackGitHubActionsMigration(db);
  assert.deepEqual(result, {
    restored: [
      "github_monitor_rules",
      "github_monitor_events",
      "github_monitor_actions_runs",
      "github_monitor_poll_leases",
    ],
    discardedActions: 2,
    discardedEvents: 2,
    discardedDeliveries: 0,
  });
  assert.ok(!tableExists(db, "github_monitor_rules_migrated"));
  assert.ok(!tableExists(db, "github_actions"));
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS total FROM github_monitor_rules").get() as { total: number }).total,
    1,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS total FROM github_monitor_events").get() as { total: number }).total,
    2,
  );

  // The forward migration must then be able to run again from scratch.
  assert.deepEqual(migrateMonitorRulesToActions(db), { actions: 2, events: 2, skipped: 0 });
});

test("rolling back a database that was never migrated changes nothing", () => {
  const db = legacyDb();
  assert.deepEqual(rollbackGitHubActionsMigration(db), {
    restored: [],
    discardedActions: 0,
    discardedEvents: 0,
    discardedDeliveries: 0,
  });
  assert.ok(tableExists(db, "github_monitor_rules"));
});

test("leaves a rule whose repository is gone out of the new model", () => {
  const db = legacyDb();
  db.exec("DELETE FROM guardrail_repositories");
  assert.deepEqual(migrateMonitorRulesToActions(db), { actions: 0, events: 0, skipped: 3 });
  assert.equal(listGitHubActions({}, db).length, 0);
});
