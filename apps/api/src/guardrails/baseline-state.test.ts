import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { defaultToImmediateTransactions } from "../sqlite.js";
import {
  ensureRepositoryBaselineSchema,
  getRepositoryBaselineState,
  markRepositoryBaselineBuilding,
  markRepositoryBaselineStale,
  refreshRepositoryBaselineState,
  type BaselineCandidate,
  type BaselineStateDependencies,
} from "./baseline-state.js";

const SHA_FIRST = "a".repeat(40);
const SHA_SECOND = "b".repeat(40);

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  defaultToImmediateTransactions(db);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO guardrail_repositories VALUES ('github:1')").run();
  ensureRepositoryBaselineSchema(db);
  return db;
}

function candidate(overrides: Partial<BaselineCandidate> = {}): BaselineCandidate {
  return {
    gateId: "gate-1",
    commitSha: SHA_FIRST,
    protectedBranch: "main",
    scanLineageHash: "sha256:1",
    builtAt: "2026-10-01T10:00:00.000Z",
    incompatibleReason: null,
    ...overrides,
  };
}

function deps(
  database: Database.Database,
  found: BaselineCandidate | null,
  options: { protectedBranch?: string | null; now?: string } = {},
): BaselineStateDependencies {
  return {
    database,
    now: () => options.now ?? "2026-10-01T12:00:00.000Z",
    protectedBranch: () => options.protectedBranch === undefined ? "main" : options.protectedBranch,
    findBaselineCandidate: () => found,
  };
}

test("an enrolled repository starts absent", () => {
  const db = memoryDb();
  const state = getRepositoryBaselineState("github:1", db);
  assert.equal(state.state, "absent");
  assert.equal(state.gateId, null);
  assert.equal(state.commitSha, null);
  assert.equal(state.staleReason, null);
});

test("a repository that is not enrolled reads absent without inserting a row", () => {
  const db = memoryDb();
  const state = refreshRepositoryBaselineState("github:absent", deps(db, candidate()));
  assert.equal(state.state, "absent");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS total FROM guardrail_repository_baselines").get() as { total: number }).total,
    0,
  );
});

test("a completed protected-branch gate makes it ready", () => {
  const db = memoryDb();
  const state = refreshRepositoryBaselineState("github:1", deps(db, candidate()));
  assert.equal(state.state, "ready");
  assert.equal(state.gateId, "gate-1");
  assert.equal(state.commitSha, SHA_FIRST);
  assert.equal(state.protectedBranch, "main");
  assert.equal(state.scanLineageHash, "sha256:1");
  assert.equal(state.builtAt, "2026-10-01T10:00:00.000Z");
  assert.equal(state.staleReason, null);
  assert.deepEqual(getRepositoryBaselineState("github:1", db), state);
});

test("a newer protected-branch gate replaces the baseline", () => {
  const db = memoryDb();
  refreshRepositoryBaselineState("github:1", deps(db, candidate()));
  const state = refreshRepositoryBaselineState("github:1", deps(db, candidate({
    gateId: "gate-2",
    commitSha: SHA_SECOND,
    builtAt: "2026-10-01T11:00:00.000Z",
  })));
  assert.equal(state.state, "ready");
  assert.equal(state.gateId, "gate-2");
  assert.equal(state.commitSha, SHA_SECOND);
});

test("a failed protected-branch gate does not make it ready", () => {
  const db = memoryDb();
  // The production candidate rule never returns an errored gate, so "no candidate"
  // is exactly what a failed baseline run looks like here.
  const state = refreshRepositoryBaselineState("github:1", deps(db, null));
  assert.equal(state.state, "absent");
  assert.equal(state.gateId, null);
});

test("a lineage change makes it stale", () => {
  const db = memoryDb();
  const state = refreshRepositoryBaselineState("github:1", deps(db, candidate({
    incompatibleReason: "scan_lineage",
  })));
  assert.equal(state.state, "stale");
  assert.equal(state.staleReason, "scan_lineage");
  // The commit that went stale stays visible: the screen says which one it was.
  assert.equal(state.commitSha, SHA_FIRST);
});

test("a protected-branch change makes it stale", () => {
  const db = memoryDb();
  const state = refreshRepositoryBaselineState(
    "github:1",
    deps(db, candidate(), { protectedBranch: "trunk" }),
  );
  assert.equal(state.state, "stale");
  assert.equal(state.staleReason, "protected_branch");
});

test("a merge after staleness rebuilds it", () => {
  const db = memoryDb();
  refreshRepositoryBaselineState("github:1", deps(db, candidate()));
  markRepositoryBaselineStale("github:1", "scan_lineage", db);
  assert.equal(getRepositoryBaselineState("github:1", db).state, "stale");
  // The same gate is still the newest one, so nothing was rebuilt yet.
  assert.equal(refreshRepositoryBaselineState("github:1", deps(db, candidate())).state, "stale");

  const rebuilt = refreshRepositoryBaselineState("github:1", deps(db, candidate({
    gateId: "gate-2",
    commitSha: SHA_SECOND,
    builtAt: "2026-10-01T13:00:00.000Z",
  })));
  assert.equal(rebuilt.state, "ready");
  assert.equal(rebuilt.staleReason, null);
  assert.equal(rebuilt.gateId, "gate-2");
});

test("marking a repository with no baseline stale leaves it absent", () => {
  const db = memoryDb();
  const state = markRepositoryBaselineStale("github:1", "scan_lineage", db);
  assert.equal(state.state, "absent");
  assert.equal(state.staleReason, null);
});

test("the button marks it building and the gate resolves it", () => {
  const db = memoryDb();
  const building = markRepositoryBaselineBuilding("github:1", "2026-10-01T12:30:00.000Z", db);
  assert.equal(building.state, "building");
  assert.equal(building.requestedAt, "2026-10-01T12:30:00.000Z");
  // Nothing finished yet, so a refresh must not drop back to absent and lose the
  // fact that a paid run is in flight.
  assert.equal(refreshRepositoryBaselineState("github:1", deps(db, null)).state, "building");

  const resolved = refreshRepositoryBaselineState("github:1", deps(db, candidate()));
  assert.equal(resolved.state, "ready");
  assert.equal(resolved.requestedAt, null);
});

test("pressing the button over a ready baseline keeps the commit it replaces visible", () => {
  const db = memoryDb();
  refreshRepositoryBaselineState("github:1", deps(db, candidate()));
  const building = markRepositoryBaselineBuilding("github:1", "2026-10-01T12:30:00.000Z", db);
  assert.equal(building.state, "building");
  assert.equal(building.commitSha, SHA_FIRST);
  assert.equal(building.gateId, "gate-1");
});

test("refreshing twice with no change writes the same row", () => {
  const db = memoryDb();
  const first = refreshRepositoryBaselineState("github:1", deps(db, candidate()));
  const second = refreshRepositoryBaselineState(
    "github:1",
    deps(db, candidate(), { now: "2026-10-01T23:00:00.000Z" }),
  );
  assert.deepEqual(second, first);
});

test("the schema migration runs twice with no effect", () => {
  const db = memoryDb();
  refreshRepositoryBaselineState("github:1", deps(db, candidate()));
  ensureRepositoryBaselineSchema(db);
  ensureRepositoryBaselineSchema(db);
  assert.equal(getRepositoryBaselineState("github:1", db).state, "ready");
});

test("removing the repository takes its baseline with it", () => {
  const db = memoryDb();
  refreshRepositoryBaselineState("github:1", deps(db, candidate()));
  db.prepare("DELETE FROM guardrail_repositories WHERE repository_key = 'github:1'").run();
  assert.equal(getRepositoryBaselineState("github:1", db).state, "absent");
});

test("a repository with no protected branch has no baseline to be stale about", () => {
  const db = memoryDb();
  const state = refreshRepositoryBaselineState(
    "github:1",
    deps(db, null, { protectedBranch: null }),
  );
  assert.equal(state.state, "absent");
});
