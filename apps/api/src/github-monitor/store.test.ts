import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  createGitHubMonitorEvent,
  ensureGitHubMonitorSchema,
} from "./store.js";

const SHA = "a".repeat(40);

test("migrates legacy SHA dedupe without losing events and keeps full target identity idempotent", () => {
  const database = new Database(":memory:");
  try {
    ensureGitHubMonitorSchema(database);
    database.exec(`
      DROP TABLE github_monitor_events;
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
        title TEXT,
        gate_id TEXT,
        cost_ceiling_usd REAL,
        reason TEXT,
        error TEXT,
        detected_at TEXT NOT NULL,
        dispatched_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (rule_id) REFERENCES github_monitor_rules(id) ON DELETE CASCADE,
        UNIQUE (repository_key, head_sha, rule_revision)
      );
      INSERT INTO github_monitor_rules (
        id, repository_key, connection_id, installation_id, repository_id, executor,
        scanner_json, cost_ceiling_usd, daily_cost_ceiling_usd, follow_branches_json,
        checkout_mode, enabled, revision, baseline_initialized_at, last_polled_at,
        last_error, created_at, updated_at
      ) VALUES (
        'rule-1', 'github:acme/sentinel', 'connection-1', 'installation-1', 'repository-1', 'sentinel-managed',
        NULL, 3, 3, '["main"]', 'none', 1, 1, NULL, NULL,
        NULL, '2026-09-22T10:00:00.000Z', '2026-09-22T10:00:00.000Z'
      );
      INSERT INTO github_monitor_events (
        id, rule_id, repository_key, rule_revision, kind, status, head_sha,
        base_ref, head_ref, pull_request_number, title, gate_id, cost_ceiling_usd,
        reason, error, detected_at, dispatched_at, completed_at
      ) VALUES (
        'legacy-event', 'rule-1', 'github:acme/sentinel', 1, 'pull_request', 'launched', '${SHA}',
        'main', 'release-candidate', 10, 'Main promotion', 'gate-legacy', 3,
        NULL, NULL, '2026-09-22T10:00:00.000Z', '2026-09-22T10:00:01.000Z', NULL
      );
    `);

    ensureGitHubMonitorSchema(database);

    const migrated = database.prepare(`
      SELECT id, status, base_ref, head_ref, pull_request_number, gate_id, cost_ceiling_usd, dispatched_at
      FROM github_monitor_events WHERE id = 'legacy-event'
    `).get() as Record<string, unknown>;
    assert.deepEqual(migrated, {
      id: "legacy-event",
      status: "launched",
      base_ref: "main",
      head_ref: "release-candidate",
      pull_request_number: 10,
      gate_id: "gate-legacy",
      cost_ceiling_usd: 3,
      dispatched_at: "2026-09-22T10:00:01.000Z",
    });

    assert.equal(createGitHubMonitorEvent(event({ baseRef: "main", pullRequestNumber: 10 }), database, "same-target"), null);
    const release = createGitHubMonitorEvent(event({ baseRef: "release/1.x", pullRequestNumber: 11 }), database, "release-target");
    assert.equal(release?.id, "release-target");
    assert.equal(createGitHubMonitorEvent(event({ baseRef: "release/1.x", pullRequestNumber: 11 }), database, "release-again"), null);
    const count = database.prepare("SELECT COUNT(*) AS count FROM github_monitor_events").get() as { count: number };
    assert.equal(count.count, 2);
  } finally {
    database.close();
  }
});

function event(input: { baseRef: string; pullRequestNumber: number }) {
  return {
    ruleId: "rule-1",
    repositoryKey: "github:acme/sentinel",
    ruleRevision: 1,
    kind: "pull_request" as const,
    headSha: SHA,
    baseRef: input.baseRef,
    headRef: "release-candidate",
    pullRequestNumber: input.pullRequestNumber,
    title: "Promotion",
    costCeilingUsd: 3,
    detectedAt: "2026-09-22T10:00:00.000Z",
  };
}
