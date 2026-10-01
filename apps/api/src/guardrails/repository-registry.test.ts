import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";
import type { GateRun, GuardrailRepository } from "@csb/shared";

import {
  deleteGuardrailRepository,
  ensureGateSchema,
  getGuardrailRepository,
  insertGateRun,
  listGuardrailRepositoryRows,
  patchGuardrailRepository,
  upsertGuardrailRepository,
} from "../gate-store.js";
import { createGitHubAction, ensureGitHubActionsSchema } from "../github-actions/store.js";
import { defaultToImmediateTransactions } from "../sqlite.js";
import {
  backfillRepositoryBaselines,
  ensureRepositoryBaselineSchema,
  getRepositoryBaselineState,
  refreshRepositoryBaselineState,
} from "./baseline-state.js";
import { policyForPreset } from "./policy-presets.js";
import { ensureRepositoryPolicySchema, putRepositoryPolicy } from "./policy-store.js";
import {
  MAX_ENROLLED_REPOSITORIES_PER_REQUEST,
  parseEnrollGuardrailRepositoriesRequest,
  RepositorySourceInputError,
} from "./repository-source-adapter.js";

const SHA = "a".repeat(40);

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  defaultToImmediateTransactions(db);
  ensureGateSchema(db);
  ensureGitHubActionsSchema(db);
  ensureRepositoryPolicySchema(db);
  ensureRepositoryBaselineSchema(db);
  db.pragma("foreign_keys = ON");
  return db;
}

function repository(overrides: Partial<GuardrailRepository> = {}): GuardrailRepository {
  return {
    repositoryKey: "github:1",
    repositoryPath: null,
    source: "github",
    displayName: "OkamiOps/sentinel",
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: "OkamiOps",
    remoteName: "sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "1",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
    ...overrides,
  };
}

function gate(overrides: Partial<GateRun> = {}): GateRun {
  return {
    id: "gate-1",
    repositoryKey: "github:1",
    repositoryPath: null,
    source: "github",
    executor: "sentinel-managed",
    baseRef: "main",
    headRef: "main",
    resolvedBaseSha: SHA,
    resolvedHeadSha: SHA,
    policySha: SHA,
    policySource: "repository_file",
    pullRequestNumber: null,
    workflowRunId: null,
    materializationState: "released",
    scanLineageHash: "sha256:1",
    artifactSchemaVersion: 2,
    scanId: null,
    status: "completed",
    outcome: "bootstrap",
    policyVersion: 1,
    baselineCommit: null,
    artifactPath: "gate-1/csb-gate-result.json",
    publishStatus: "not_configured",
    publishError: null,
    publishedAt: null,
    error: null,
    startedAt: "2026-10-01T10:00:00.000Z",
    completedAt: "2026-10-01T10:05:00.000Z",
    costCeilingUsd: 2,
    estimatedUsd: 1,
    ...overrides,
  };
}

test("enrols three repositories in one request", () => {
  const request = parseEnrollGuardrailRepositoriesRequest({
    source: "github",
    connectionId: "connection-1",
    installationId: "77",
    repositoryIds: ["1", "2", "3"],
    defaultExecutor: "sentinel-managed",
  });
  assert.equal(request.source, "github");
  assert.deepEqual(request.source === "github" ? request.repositoryIds : [], ["1", "2", "3"]);
});

test("the legacy single-repositoryId body is a one-element batch", () => {
  const request = parseEnrollGuardrailRepositoriesRequest({
    source: "github",
    connectionId: "connection-1",
    installationId: "77",
    repositoryId: "9",
    defaultExecutor: "sentinel-managed",
  });
  assert.deepEqual(request.source === "github" ? request.repositoryIds : [], ["9"]);
});

test("refuses a batch above fifty", () => {
  const repositoryIds = Array.from(
    { length: MAX_ENROLLED_REPOSITORIES_PER_REQUEST + 1 },
    (_, index) => String(index + 1),
  );
  assert.throws(
    () => parseEnrollGuardrailRepositoriesRequest({
      source: "github",
      connectionId: "connection-1",
      installationId: "77",
      repositoryIds,
      defaultExecutor: "sentinel-managed",
    }),
    (error: unknown) => error instanceof RepositorySourceInputError
      && error.code === "too_many_repositories",
  );
});

test("the same repository named twice is one row, not a duplicate report", () => {
  const request = parseEnrollGuardrailRepositoriesRequest({
    source: "github",
    connectionId: "connection-1",
    installationId: "77",
    repositoryIds: ["4", "4", "5"],
    defaultExecutor: "sentinel-managed",
  });
  assert.deepEqual(request.source === "github" ? request.repositoryIds : [], ["4", "5"]);
});

test("refuses an empty batch and a non-numeric repository id", () => {
  for (const repositoryIds of [[], ["not-a-number"], ["0"]]) {
    assert.throws(() => parseEnrollGuardrailRepositoriesRequest({
      source: "github",
      connectionId: "connection-1",
      installationId: "77",
      repositoryIds,
      defaultExecutor: "sentinel-managed",
    }));
  }
});

test("disables a repository without deleting it", () => {
  const db = memoryDb();
  upsertGuardrailRepository(repository(), db);
  insertGateRun(gate(), db);

  const patched = patchGuardrailRepository("github:1", { enabled: false }, db);
  assert.equal(patched?.enabled, false);
  // The gates stay readable: disabling stops dispatch, it does not erase history.
  assert.equal(listGuardrailRepositoryRows(db)[0]?.lastGate?.gateId, "gate-1");
});

test("the default executor and the comment toggle are editable, and nothing else is", () => {
  const db = memoryDb();
  upsertGuardrailRepository(repository(), db);
  assert.equal(
    patchGuardrailRepository("github:1", { defaultExecutor: "github-actions" }, db)?.defaultExecutor,
    "github-actions",
  );
  patchGuardrailRepository("github:1", { prCommentEnabled: false }, db);
  assert.equal(listGuardrailRepositoryRows(db)[0]?.prCommentEnabled, false);
  assert.equal(listGuardrailRepositoryRows(db)[0]?.prCommentDetail, "detailed");
});

test("the projection is backfilled for a repository enrolled before it existed", () => {
  // The baseline table arrives in a later release than the registry. A repository
  // that already merged on its protected branch paid for that scan; if the new table
  // started empty the screen would say "sem baseline" and ask for the money again.
  const db = memoryDb();
  upsertGuardrailRepository(repository(), db);
  insertGateRun(gate(), db);
  db.prepare("DELETE FROM guardrail_repository_baselines").run();

  assert.equal(backfillRepositoryBaselines(db), 1);

  assert.equal(getRepositoryBaselineState("github:1", db).state, "ready");
  assert.equal(getRepositoryBaselineState("github:1", db).gateId, "gate-1");
  // A second pass is a no-op: the row now exists, decided.
  assert.equal(backfillRepositoryBaselines(db), 0);
});

test("patching an unknown repository reports it rather than inventing one", () => {
  const db = memoryDb();
  assert.equal(patchGuardrailRepository("github:absent", { enabled: false }, db), null);
  assert.equal(getGuardrailRepository("github:absent", db), null);
});

test("deleting a repository takes its gates, policy and baseline with it", () => {
  const db = memoryDb();
  upsertGuardrailRepository(repository(), db);
  insertGateRun(gate(), db);
  putRepositoryPolicy("github:1", policyForPreset("warn-only", ["main"]), "warn-only", null, db);
  refreshRepositoryBaselineState("github:1", {
    database: db,
    protectedBranch: () => "main",
    findBaselineCandidate: () => ({
      gateId: "gate-1",
      commitSha: SHA,
      protectedBranch: "main",
      scanLineageHash: "sha256:1",
      builtAt: "2026-10-01T10:05:00.000Z",
      incompatibleReason: null,
    }),
    hasRunningBuild: () => false,
  });

  assert.equal(deleteGuardrailRepository("github:1", db), true);
  assert.deepEqual(listGuardrailRepositoryRows(db), []);
  for (const table of [
    "gate_runs",
    "guardrail_repository_policies",
    "guardrail_repository_baselines",
  ]) {
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total,
      0,
      table,
    );
  }
  // Idempotent: a second delete reports that there was nothing left.
  assert.equal(deleteGuardrailRepository("github:1", db), false);
});

test("deleting a repository takes its actions and their events with it", () => {
  const db = memoryDb();
  upsertGuardrailRepository(repository(), db);
  createGitHubAction({
    repositoryKey: "github:1", name: "Push", triggerKind: "push", branchPatterns: ["main"],
    connectionId: "connection-1", installationId: "77", repositoryId: "1",
    executor: "sentinel-managed", scanner: null, costCeilingUsd: 2,
    dailyCostCeilingUsd: null, enabled: true, includeForks: false, createdBy: "u1",
  }, db);
  deleteGuardrailRepository("github:1", db);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS total FROM github_actions").get() as { total: number }).total,
    0,
  );
});

test("lists repositories with baseline, action count and last verdict in one call", () => {
  const db = memoryDb();
  upsertGuardrailRepository(repository(), db);
  for (const name of ["PR", "Push"]) {
    createGitHubAction({
      repositoryKey: "github:1",
      name,
      triggerKind: name === "PR" ? "pull_request" : "push",
      branchPatterns: ["main"],
      connectionId: "connection-1", installationId: "77", repositoryId: "1",
      executor: "sentinel-managed", scanner: null, costCeilingUsd: 2,
      dailyCostCeilingUsd: null, enabled: true, includeForks: false, createdBy: "u1",
    }, db);
  }
  createGitHubAction({
    repositoryKey: "github:1", name: "Release", triggerKind: "push", branchPatterns: ["release/**"],
    connectionId: "connection-1", installationId: "77", repositoryId: "1",
    executor: "sentinel-managed", scanner: null, costCeilingUsd: 2,
    dailyCostCeilingUsd: null, enabled: false, includeForks: false, createdBy: "u1",
  }, db);
  insertGateRun(gate(), db);
  refreshRepositoryBaselineState("github:1", {
    database: db,
    protectedBranch: () => "main",
    findBaselineCandidate: () => ({
      gateId: "gate-1",
      commitSha: SHA,
      protectedBranch: "main",
      scanLineageHash: "sha256:1",
      builtAt: "2026-10-01T10:05:00.000Z",
      incompatibleReason: null,
    }),
    hasRunningBuild: () => false,
  });

  const row = listGuardrailRepositoryRows(db)[0]!;
  assert.equal(row.baseline.state, "ready");
  assert.equal(row.baseline.commitSha, SHA);
  // The disabled one does not count: the number answers "what is switched on".
  assert.equal(row.enabledActionCount, 2);
  assert.deepEqual(row.lastGate, {
    gateId: "gate-1",
    outcome: "bootstrap",
    completedAt: "2026-10-01T10:05:00.000Z",
  });
  assert.equal(row.policySource, "repository_file");
});

test("the list names the policy level from the last gate, then from what is saved", () => {
  const db = memoryDb();
  upsertGuardrailRepository(repository(), db);
  // Nothing has run and nothing is saved: the product default decides.
  assert.equal(listGuardrailRepositoryRows(db)[0]?.policySource, "default");

  putRepositoryPolicy("github:1", policyForPreset("warn-only", ["main"]), "warn-only", null, db);
  assert.equal(listGuardrailRepositoryRows(db)[0]?.policySource, "sentinel");

  // A gate that ran under the repository's own file is the only local evidence
  // that level 1 exists, and it outranks the saved policy.
  insertGateRun(gate({ policySource: "repository_file" }), db);
  assert.equal(listGuardrailRepositoryRows(db)[0]?.policySource, "repository_file");
});

test("a repository with no baseline row reads absent rather than missing", () => {
  const db = memoryDb();
  upsertGuardrailRepository(repository(), db);
  const row = listGuardrailRepositoryRows(db)[0]!;
  assert.equal(row.baseline.state, "absent");
  assert.equal(row.baseline.repositoryKey, "github:1");
  assert.equal(row.lastGate, null);
  assert.equal(row.enabledActionCount, 0);
});

test("the list costs the same whether there is one repository or many", () => {
  const count = (repositories: number): number => {
    const db = memoryDb();
    for (let index = 1; index <= repositories; index += 1) {
      upsertGuardrailRepository(repository({
        repositoryKey: `github:${index}`,
        githubRepositoryId: String(index),
        displayName: `OkamiOps/repo-${index}`,
      }), db);
    }
    let statements = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => { statements += 1; return prepare(sql); }) as typeof db.prepare;
    assert.equal(listGuardrailRepositoryRows(db).length, repositories);
    return statements;
  };
  // The N+1 this route exists to remove: reading ten repositories must not prepare
  // nine more statements than reading one.
  assert.equal(count(10), count(1));
});
