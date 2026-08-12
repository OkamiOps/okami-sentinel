import assert from "node:assert/strict";
import test from "node:test";

import type { GuardrailRepository } from "@csb/shared";

import {
  initialGuardrailTargetDraft,
  preflightFingerprint,
  targetFromDraft,
} from "./guardrails-target.js";

test("a remote target never resolves an implicit HEAD", () => {
  const repository = remoteRepository();
  const draft = {
    ...initialGuardrailTargetDraft(repository),
    kind: "compare" as const,
    baseRef: "main",
    headRef: "HEAD",
  };

  assert.equal(targetFromDraft(repository, draft), null);
});

test("GitHub pull request and compare drafts produce exact targets", () => {
  const repository = remoteRepository();
  assert.deepEqual(targetFromDraft(repository, {
    ...initialGuardrailTargetDraft(repository),
    kind: "pull_request",
    pullRequestNumber: "42",
  }), { kind: "pull_request", number: 42 });
  assert.deepEqual(targetFromDraft(repository, {
    ...initialGuardrailTargetDraft(repository),
    kind: "compare",
    baseRef: "main",
    headRef: "feature/guardrail",
  }), { kind: "compare", baseRef: "main", headRef: "feature/guardrail" });
});

test("a local comparison may resolve HEAD and keeps workspace authority explicit", () => {
  const repository = localRepository();
  const draft = initialGuardrailTargetDraft(repository);
  assert.deepEqual(targetFromDraft(repository, draft), {
    kind: "compare",
    baseRef: "main",
    headRef: "HEAD",
  });
});

test("changing target facts invalidates the accepted preview fingerprint", () => {
  const repository = remoteRepository();
  const initial = { kind: "pull_request" as const, number: 42 };
  const changed = { kind: "pull_request" as const, number: 43 };
  assert.notEqual(
    preflightFingerprint(repository.repositoryKey, "github-actions", initial),
    preflightFingerprint(repository.repositoryKey, "github-actions", changed),
  );
  assert.notEqual(
    preflightFingerprint(repository.repositoryKey, "github-actions", initial),
    preflightFingerprint(repository.repositoryKey, "sentinel-managed", initial),
  );
});

function remoteRepository(): GuardrailRepository {
  return {
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    displayName: "OkamiOps/sentinel",
    defaultBranch: "main",
    defaultExecutor: "github-actions",
    remoteOwner: "OkamiOps",
    remoteName: "sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "991122",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "ready",
  };
}

function localRepository(): GuardrailRepository {
  return {
    ...remoteRepository(),
    repositoryKey: "local:fixture",
    repositoryPath: "/fixture/repository",
    source: "local",
    displayName: "Fixture",
    defaultExecutor: "sentinel-managed",
    remoteOwner: null,
    remoteName: null,
    githubConnectionId: null,
    githubInstallationId: null,
    githubRepositoryId: null,
    githubStatus: "not_configured",
  };
}
