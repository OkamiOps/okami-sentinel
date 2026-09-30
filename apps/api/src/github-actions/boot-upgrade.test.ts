/**
 * The upgrade this task performs, on the shape production actually carries: one
 * enabled monitor rule with a queue behind it. Everything here happens in the
 * order `index.ts` does it — migrate once, reconcile orphans, then reconcile —
 * because the order is the guarantee: a store call before the migration would
 * recreate the renamed tables empty and the operator's one live rule would stop
 * firing in silence.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import type { GuardrailRepository } from "@csb/shared";

import { defaultToImmediateTransactions } from "../sqlite.js";
import { dispatchGitHubActionEvent } from "./dispatch.js";
import { reconcileGitHubActions, type GitHubReconcilerDependencies } from "./reconciler.js";
import {
  createGitHubActionEvent,
  disableGitHubActionsForRepository,
  ensureGitHubActionsSchema,
  failOrphanedGitHubActionDispatches,
  getGitHubAction,
  getGitHubActionEvent,
  hasGitHubActionEventForHeadSha,
  listGitHubActionEvents,
  listGitHubActions,
  patchGitHubActionEvent,
  recordGitHubActionReconciliation,
  reserveGitHubActionEventDispatch,
  supersedeQueuedEvents,
} from "./store.js";

const SHA_ANALYSED = "a".repeat(40);
const SHA_QUEUED = "b".repeat(40);
const SHA_NEW = "c".repeat(40);
const NOW = new Date("2026-09-30T12:00:00.000Z");

const enrolled = {
  repositoryKey: "github:1", source: "github", enabled: true, defaultBranch: "main",
  remoteOwner: "okami", remoteName: "sentinel",
  githubConnectionId: "conn-1", githubInstallationId: "inst-1", githubRepositoryId: "1",
} as GuardrailRepository;

/** The production database before this release: rules, events, leases, actions runs. */
function productionDatabase(): Database.Database {
  const db = new Database(":memory:");
  defaultToImmediateTransactions(db);
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
      completed_at TEXT
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
      'rule-1', 'github:1', 'conn-1', 'inst-1', '1', 'sentinel-managed',
      @scanner, 3, 6, '["main"]', 'none', 1, 1, '2026-09-01T00:00:00.000Z',
      '2026-09-30T11:59:00.000Z', NULL, '2026-09-01T00:00:00.000Z', '2026-09-30T11:59:00.000Z'
    )
  `).run({
    scanner: JSON.stringify({
      engine: "codex-security", mode: "standard",
      connection: { connectionId: "provider-1", modelSelectionMode: "runtime-default", modelId: null },
    }),
  });
  const insertEvent = db.prepare(`
    INSERT INTO github_monitor_events (
      id, rule_id, repository_key, rule_revision, kind, status, head_sha, base_ref,
      head_ref, pull_request_number, target_identity, title, gate_id, cost_ceiling_usd,
      reason, error, detected_at, dispatched_at, completed_at
    ) VALUES (
      @id, 'rule-1', 'github:1', @revision, @kind, @status, @head_sha, @base_ref,
      @head_ref, @pull_request_number, @target_identity, NULL, @gate_id, 3,
      NULL, NULL, @detected_at, NULL, NULL
    )
  `);
  // The commit the poller already analysed: history, and a commit that must
  // never be paid for twice.
  insertEvent.run({
    id: "event-launched", revision: 1, kind: "pull_request", status: "launched",
    head_sha: SHA_ANALYSED, base_ref: "main", head_ref: "topic", pull_request_number: 7,
    target_identity: JSON.stringify(["pull_request", 7, SHA_ANALYSED]), gate_id: "gate-1",
    detected_at: "2026-09-28T10:00:00.000Z",
  });
  // The queue the poller left behind, days old.
  insertEvent.run({
    id: "event-queued", revision: 1, kind: "pull_request", status: "queued",
    head_sha: SHA_QUEUED, base_ref: "main", head_ref: "topic", pull_request_number: 7,
    target_identity: JSON.stringify(["pull_request", 7, SHA_QUEUED]), gate_id: null,
    detected_at: "2026-09-27T10:00:00.000Z",
  });
  // An observation of a branch push, also days old.
  insertEvent.run({
    id: "event-observed", revision: 1, kind: "push", status: "observed",
    head_sha: SHA_ANALYSED, base_ref: null, head_ref: "main", pull_request_number: null,
    target_identity: JSON.stringify(["push", "main", SHA_ANALYSED]), gate_id: null,
    detected_at: "2026-09-27T09:00:00.000Z",
  });
  return db;
}

interface UpgradeHarness {
  db: Database.Database;
  deps: GitHubReconcilerDependencies;
  dispatched: string[];
  launches: string[];
  openPullRequests: Array<{ number: number; headRef: string; headSha: string; baseRef: string }>;
  branches: Array<{ name: string; headSha: string }>;
}

function upgraded(): UpgradeHarness {
  const db = productionDatabase();
  // Exactly what `index.ts` calls, exactly once, before anything reads the model.
  const migration = ensureGitHubActionsSchema(db);
  assert.deepEqual(
    { actions: migration.actions, events: migration.events },
    { actions: 2, events: 3 },
  );
  const dispatched: string[] = [];
  const launches: string[] = [];
  const openPullRequests = [
    { number: 7, headRef: "topic", headSha: SHA_NEW, baseRef: "main" },
  ];
  const branches = [{ name: "main", headSha: SHA_ANALYSED }];
  const harness: UpgradeHarness = {
    db, dispatched, launches, openPullRequests, branches,
    deps: {
      now: () => NOW,
      listActions: () => listGitHubActions({}, db),
      getRepository: (key) => (key === enrolled.repositoryKey ? enrolled : null),
      readRepositoryJson: async (_repository, resourcePath) => (resourcePath.startsWith("/pulls")
        ? openPullRequests.map((pull) => ({
          number: pull.number, title: "t", draft: false, updated_at: "2026-09-30T11:00:00.000Z",
          base: { ref: pull.baseRef, repo: { id: 1 } },
          head: { ref: pull.headRef, sha: pull.headSha, repo: { id: 1 } },
        }))
        : branches.map((branch) => ({ name: branch.name, commit: { sha: branch.headSha } }))),
      createEvent: (input) => createGitHubActionEvent(input, db),
      hasEventForHeadSha: (actionId, headSha) => hasGitHubActionEventForHeadSha(actionId, headSha, db),
      supersede: (input) => supersedeQueuedEvents(input, db, NOW.toISOString()),
      listQueuedEvents: (actionId) => listGitHubActionEvents({ actionId, statuses: ["queued"] }, db),
      patchEvent: (id, patch) => { patchGitHubActionEvent(id, patch, db); },
      recordReconciliation: (actionId, outcome) => {
        recordGitHubActionReconciliation(actionId, outcome, db, NOW.toISOString());
      },
      dispatch: async (eventId) => {
        dispatched.push(eventId);
        await dispatchGitHubActionEvent(eventId, {
          now: () => NOW,
          getEvent: (id) => getGitHubActionEvent(id, db),
          getAction: (id) => getGitHubAction(id, db),
          getRepository: (key) => (key === enrolled.repositoryKey ? enrolled : null),
          reserve: (input) => reserveGitHubActionEventDispatch(input, db),
          patchEvent: (id, patch) => { patchGitHubActionEvent(id, patch, db); },
          start: async (input) => {
            launches.push(input.event.headSha);
            return { gateId: `gate-${launches.length}`, headSha: input.event.headSha };
          },
        });
      },
      reconcileOrphans: () => failOrphanedGitHubActionDispatches(NOW.toISOString(), {}, db),
      disableActionsForRepository: (key, reason) => { disableGitHubActionsForRepository(key, reason, db); },
      runInTransaction: (work) => db.transaction(work)(),
    },
  };
  return harness;
}

test("the upgrade turns one live rule into two actions and keeps it firing", async () => {
  const harness = upgraded();
  const actions = listGitHubActions({}, harness.db);
  assert.deepEqual(actions.map((action) => `${action.name}:${action.triggerKind}`).sort(),
    ["PR:pull_request", "Push:push"]);
  // Enabled, with its authority, its ceilings, its scanner and its baseline.
  for (const action of actions) {
    assert.equal(action.enabled, true);
    assert.equal(action.costCeilingUsd, 3);
    assert.equal(action.dailyCostCeilingUsd, 6);
    assert.equal(action.connectionId, "conn-1");
    assert.equal(action.installationId, "inst-1");
    assert.equal(action.repositoryId, "1");
    assert.equal(action.baselineInitializedAt, "2026-09-01T00:00:00.000Z");
    assert.equal(action.includeForks, false);
    assert.deepEqual(action.branchPatterns, ["main"]);
  }
  // The legacy tables are renamed, not dropped: the rollback still has its rows.
  const tables = new Set((harness.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all() as Array<{ name: string }>).map((row) => row.name));
  assert.equal(tables.has("github_monitor_rules"), false);
  assert.equal(tables.has("github_monitor_rules_migrated"), true);
  assert.equal(tables.has("github_monitor_events_migrated"), true);
  assert.equal(tables.has("github_monitor_poll_leases_migrated"), true);

  // The history survived, attached to the action of its own kind.
  const pr = actions.find((action) => action.triggerKind === "pull_request")!;
  const push = actions.find((action) => action.triggerKind === "push")!;
  assert.deepEqual(
    listGitHubActionEvents({ actionId: pr.id }, harness.db).map((event) => event.id).sort(),
    ["event-launched", "event-queued"],
  );
  assert.deepEqual(
    listGitHubActionEvents({ actionId: push.id }, harness.db).map((event) => event.id),
    ["event-observed"],
  );
});

test("the first reconciliation after the upgrade resurrects no event and pays for no old commit", async () => {
  const harness = upgraded();
  const outcome = await reconcileGitHubActions(harness.deps);

  // One new commit on the open pull request, and nothing else: the commit the
  // poller had already analysed produces no event at all.
  assert.deepEqual(outcome, { repositories: 1, created: 1, observed: 0, errors: 0 });
  assert.deepEqual(harness.launches, [SHA_NEW]);

  // The three-day-old queue is retired instead of dispatched.
  const stale = getGitHubActionEvent("event-queued", harness.db)!;
  assert.ok(["skipped", "superseded"].includes(stale.status), `stale queue became ${stale.status}`);
  assert.equal(stale.gateId, null);
  assert.equal(harness.dispatched.includes("event-queued"), false);

  // And the analysed commit is still analysed exactly once.
  const analysed = listGitHubActionEvents({}, harness.db)
    .filter((event) => event.headSha === SHA_ANALYSED && event.gateId !== null);
  assert.equal(analysed.length, 1);
});

test("a second cycle with nothing moved creates nothing and dispatches nothing", async () => {
  const harness = upgraded();
  await reconcileGitHubActions(harness.deps);
  const before = harness.launches.length;
  const outcome = await reconcileGitHubActions(harness.deps);
  assert.deepEqual(outcome, { repositories: 1, created: 0, observed: 0, errors: 0 });
  assert.equal(harness.launches.length, before, "a quiet cycle costs nothing");
});

test("running the boot migration twice changes nothing", async () => {
  const harness = upgraded();
  const again = ensureGitHubActionsSchema(harness.db);
  assert.deepEqual(again, { actions: 0, events: 0, skipped: 0 });
  assert.equal(listGitHubActions({}, harness.db).length, 2);
});

test("the poller is gone from the source tree", () => {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(fs.existsSync(path.join(source, "github-monitor")), false,
    "apps/api/src/github-monitor must not exist");
  const offenders: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      // This file names them to forbid them.
      if (full === fileURLToPath(import.meta.url)) continue;
      // Comments naming the old world are history; only live code counts.
      const content = fs.readFileSync(full, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      if (/from\s+"[^"]*github-monitor\/[^"]*"/.test(content)
        || /\b(startPolling|stopPolling|GitHubMonitorService|ensureGitHubMonitorSchema)\b/.test(content)) {
        offenders.push(path.relative(source, full));
      }
    }
  };
  walk(source);
  assert.deepEqual(offenders, []);
});
