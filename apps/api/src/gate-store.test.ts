import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { GateRun, GuardrailRepository } from "@csb/shared";
import {
  appendGateEvent,
  ensureGateSchema,
  getGateRun,
  insertGateRun,
  listGateEvents,
  listGateRuns,
  listGuardrailRepositories,
  updateGateRun,
  upsertGuardrailRepository,
} from "./gate-store.js";

function repositoryFixture(
  overrides: Partial<GuardrailRepository> = {},
): GuardrailRepository {
  return {
    repositoryKey: "github.com/okami/csb",
    repositoryPath: "/workspace/csb",
    displayName: "Codex Security Benchmark",
    defaultBranch: "main",
    remoteOwner: "okami",
    remoteName: "csb",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
    ...overrides,
  };
}

function gateRunFixture(overrides: Partial<GateRun> = {}): GateRun {
  return {
    id: "gate-1",
    repositoryKey: "github.com/okami/csb",
    repositoryPath: "/workspace/csb",
    source: "local",
    baseRef: "main",
    headRef: "HEAD",
    pullRequestNumber: null,
    scanId: null,
    status: "queued",
    outcome: null,
    policyVersion: 1,
    baselineCommit: null,
    artifactPath: null,
    error: null,
    startedAt: "2026-08-07T09:00:00Z",
    completedAt: null,
    estimatedUsd: 0,
    ...overrides,
  };
}

test("persists repositories and gate runs without changing scan tables", () => {
  const db = new Database(":memory:");

  try {
    ensureGateSchema(db);
    upsertGuardrailRepository(repositoryFixture(), db);
    insertGateRun(gateRunFixture(), db);

    assert.equal(
      listGuardrailRepositories(db)[0]?.repositoryKey,
      "github.com/okami/csb",
    );
    assert.equal(getGateRun("gate-1", db)?.status, "queued");

    updateGateRun(
      "gate-1",
      {
        status: "completed",
        outcome: "pass",
        completedAt: "2026-08-07T10:00:00Z",
      },
      db,
    );
    assert.equal(getGateRun("gate-1", db)?.outcome, "pass");

    appendGateEvent(
      "gate-1",
      {
        sequence: 1,
        type: "status",
        payload: { status: "completed" },
        createdAt: "2026-08-07T10:00:00Z",
      },
      db,
    );
    assert.deepEqual(
      listGateEvents("gate-1", db).map((event) => event.sequence),
      [1],
    );

    assert.deepEqual(
      db
        .prepare(
          "SELECT count(*) count FROM sqlite_master WHERE name = 'runs'",
        )
        .get(),
      { count: 0 },
    );
  } finally {
    db.close();
  }
});

test("creates only the additive gate schema and expected index", () => {
  const db = new Database(":memory:");

  try {
    ensureGateSchema(db);
    const objects = db
      .prepare(
        `SELECT name, type
         FROM sqlite_master
         WHERE name IN (
           'guardrail_repositories',
           'gate_runs',
           'gate_runs_by_repository_started',
           'gate_events'
         )
         ORDER BY name`,
      )
      .all();

    assert.deepEqual(objects, [
      { name: "gate_events", type: "table" },
      { name: "gate_runs", type: "table" },
      { name: "gate_runs_by_repository_started", type: "index" },
      { name: "guardrail_repositories", type: "table" },
    ]);
  } finally {
    db.close();
  }
});

test("maps repository booleans and remote status explicitly and derives the newest gate", () => {
  const db = new Database(":memory:");

  try {
    upsertGuardrailRepository(
      repositoryFixture({
        repositoryKey: "local/csb",
        remoteOwner: null,
        remoteName: null,
        enabled: false,
      }),
      db,
    );
    upsertGuardrailRepository(repositoryFixture(), db);
    insertGateRun(gateRunFixture(), db);
    insertGateRun(
      gateRunFixture({
        id: "gate-2",
        status: "completed",
        outcome: "warning",
        startedAt: "2026-08-07T11:00:00Z",
        completedAt: "2026-08-07T11:10:00Z",
      }),
      db,
    );

    const repositories = listGuardrailRepositories(db);
    const local = repositories.find(
      (repository) => repository.repositoryKey === "local/csb",
    );
    const remote = repositories.find(
      (repository) => repository.repositoryKey === "github.com/okami/csb",
    );

    assert.equal(local?.enabled, false);
    assert.equal(local?.githubStatus, "not_configured");
    assert.equal(local?.lastGateId, null);
    assert.equal(remote?.enabled, true);
    assert.equal(remote?.githubStatus, "not_checked");
    assert.equal(remote?.lastGateId, "gate-2");
  } finally {
    db.close();
  }
});

test("round-trips nullable run fields and lists newest runs first", () => {
  const db = new Database(":memory:");

  try {
    const first = gateRunFixture();
    const second = gateRunFixture({
      id: "gate-2",
      source: "github",
      pullRequestNumber: 184,
      scanId: "scan-2",
      status: "completed",
      outcome: "blocked",
      baselineCommit: "abc123",
      artifactPath: "/workspace/csb/gates/gate-2/result.json",
      error: null,
      startedAt: "2026-08-07T11:00:00Z",
      completedAt: "2026-08-07T11:12:00Z",
      estimatedUsd: 4.25,
    });
    insertGateRun(first, db);
    insertGateRun(second, db);

    assert.deepEqual(getGateRun("gate-1", db), first);
    assert.deepEqual(getGateRun("gate-2", db), second);
    assert.deepEqual(
      listGateRuns(null, db).map((run) => run.id),
      ["gate-2", "gate-1"],
    );
    assert.deepEqual(
      listGateRuns("github.com/okami/csb", db).map((run) => run.id),
      ["gate-2", "gate-1"],
    );
  } finally {
    db.close();
  }
});

test("updates only supported mutable gate fields", () => {
  const db = new Database(":memory:");

  try {
    insertGateRun(gateRunFixture(), db);
    updateGateRun(
      "gate-1",
      {
        scanId: "scan-1",
        status: "error",
        outcome: "error",
        baselineCommit: "abc123",
        artifactPath: "/workspace/csb/gates/gate-1/result.json",
        error: "engine failed",
        completedAt: "2026-08-07T10:00:00Z",
        estimatedUsd: 1.5,
        repositoryKey: "attacker-controlled-column",
      } as Parameters<typeof updateGateRun>[1] & {
        repositoryKey: string;
      },
      db,
    );

    const updated = getGateRun("gate-1", db);
    assert.equal(updated?.repositoryKey, "github.com/okami/csb");
    assert.equal(updated?.scanId, "scan-1");
    assert.equal(updated?.status, "error");
    assert.equal(updated?.estimatedUsd, 1.5);
  } finally {
    db.close();
  }
});

test("persists bounded status summaries in sequence order", () => {
  const db = new Database(":memory:");

  try {
    appendGateEvent(
      "gate-1",
      {
        sequence: 2,
        type: "done",
        payload: { status: "completed", outcome: "pass" },
        createdAt: "2026-08-07T10:00:02Z",
      },
      db,
    );
    appendGateEvent(
      "gate-1",
      {
        sequence: 1,
        type: "scan",
        payload: { status: "scanning", scanId: "scan-1", percent: 42 },
        createdAt: "2026-08-07T10:00:01Z",
      },
      db,
    );

    assert.deepEqual(listGateEvents("gate-1", db), [
      {
        sequence: 1,
        type: "scan",
        payload: { status: "scanning", scanId: "scan-1", percent: 42 },
        createdAt: "2026-08-07T10:00:01Z",
      },
      {
        sequence: 2,
        type: "done",
        payload: { status: "completed", outcome: "pass" },
        createdAt: "2026-08-07T10:00:02Z",
      },
    ]);
  } finally {
    db.close();
  }
});

test("rejects scanner logs, oversized summaries and unserializable events", () => {
  const db = new Database(":memory:");
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  try {
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 1,
            type: "scan",
            payload: { logs: "raw scanner output" },
            createdAt: "2026-08-07T10:00:00Z",
          },
          db,
        ),
      /status or progress summary/i,
    );
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 2,
            type: "status",
            payload: { message: "x".repeat(4_097) },
            createdAt: "2026-08-07T10:00:01Z",
          },
          db,
        ),
      /too large/i,
    );
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 3,
            type: "status",
            payload: circular,
            createdAt: "2026-08-07T10:00:02Z",
          },
          db,
        ),
      /serializable/i,
    );
    assert.deepEqual(listGateEvents("gate-1", db), []);
  } finally {
    db.close();
  }
});
