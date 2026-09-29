import assert from "node:assert/strict";
import test from "node:test";
import type { GuardrailRepository, ScanRun } from "@csb/shared";

import { deleteRun, getDb, upsertRun } from "./db.js";
import { upsertGuardrailRepository } from "./gate-store.js";
import { getRunRepositoryKey } from "./auth/repository-key.js";

function minimalRun(id: string, repositoryPath: string | null): ScanRun {
  return {
    id,
    displayName: `Repository key fixture ${id}`,
    repositoryPath,
    revision: "abc123",
    scanDir: "/scan",
    status: "completed",
    model: null,
    effort: null,
    mode: null,
    engine: "codex-security",
    provider: null,
    authMode: null,
    scannerVersion: "fixture",
    recipeHash: "fixture",
    startedAt: "2026-08-11T09:00:00.000Z",
    completedAt: "2026-08-11T09:01:00.000Z",
    durationMs: 60_000,
    cost: null,
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
    source: "benchmark",
    pid: null,
    execution: null,
  };
}

function localGuardrailRepository(repositoryKey: string, repositoryPath: string): GuardrailRepository {
  return {
    repositoryKey,
    repositoryPath,
    source: "local",
    displayName: repositoryKey,
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: null,
    remoteName: null,
    githubConnectionId: null,
    githubInstallationId: null,
    githubRepositoryId: null,
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
  };
}

test("upsertRun sets repository_key on first insert, then keeps it (COALESCE) even after the matching repository disappears", () => {
  const runId = "repo-key-int-test-coalesce";
  const repositoryKey = "local/repo-key-int-test-coalesce-repo";
  const repositoryPath = "/repos/repo-key-int-test-coalesce-repo";

  try {
    upsertGuardrailRepository(localGuardrailRepository(repositoryKey, repositoryPath));

    upsertRun(minimalRun(runId, repositoryPath));
    assert.equal(getRunRepositoryKey(runId), repositoryKey);

    // Resolution would now return null for this path, but the stored key must
    // not be clobbered back to null (or reassigned) by a later upsert of the
    // same run — COALESCE keeps the first-resolved key.
    getDb().prepare("DELETE FROM guardrail_repositories WHERE repository_key = ?").run(repositoryKey);

    upsertRun(minimalRun(runId, repositoryPath));
    assert.equal(getRunRepositoryKey(runId), repositoryKey);
  } finally {
    deleteRun(runId);
    getDb().prepare("DELETE FROM guardrail_repositories WHERE repository_key = ?").run(repositoryKey);
  }
});

test("upsertRun leaves repository_key null while no repository matches, then fills it once the repository is registered", () => {
  const runId = "repo-key-int-test-fill";
  const repositoryKey = "local/repo-key-int-test-fill-repo";
  const repositoryPath = "/repos/repo-key-int-test-fill-repo";

  try {
    upsertRun(minimalRun(runId, repositoryPath));
    assert.equal(getRunRepositoryKey(runId), null);

    upsertGuardrailRepository(localGuardrailRepository(repositoryKey, repositoryPath));

    upsertRun(minimalRun(runId, repositoryPath));
    assert.equal(getRunRepositoryKey(runId), repositoryKey);
  } finally {
    deleteRun(runId);
    getDb().prepare("DELETE FROM guardrail_repositories WHERE repository_key = ?").run(repositoryKey);
  }
});
