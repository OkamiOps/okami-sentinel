import assert from "node:assert/strict";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";
import type { GateArtifactV2, GateRun, GuardrailRepository } from "@csb/shared";

import type {
  CreateGitHubActionsDispatchResult,
  GitHubActionsArtifactMetadata,
  GitHubActionsDispatchMetadata,
  GitHubActionsDispatchUpdate,
  GateRunUpdate,
} from "../gate-store.js";
import type { ActionsArtifactImporter } from "./actions-artifact-importer.js";
import {
  GitHubActionsExecutor,
  type GitHubActionsExecutorStore,
  type GitHubActionsRemote,
  type GitHubActionsRemoteArtifact,
  type GitHubActionsRemoteRun,
} from "./github-actions-executor.js";
import type { AcceptedGateTargetPreview } from "./target-preview.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const RELEASE = "c".repeat(40);

test("persists dispatch_requested before the API call and deduplicates an idempotency key", async () => {
  const fixture = executorFixture();
  let persistedBeforeRemote = false;
  fixture.remote.dispatchWorkflow = async ({ dispatch }) => {
    persistedBeforeRemote = fixture.store.dispatches.has(dispatch.gateId)
      && fixture.store.gates.has(dispatch.gateId);
    fixture.calls.dispatch += 1;
  };

  const first = await fixture.executor.start({
    repository: fixture.repository,
    preview: fixture.preview,
    idempotencyKey: "request-idempotency-000001",
  });
  const second = await fixture.executor.start({
    repository: fixture.repository,
    preview: fixture.preview,
    idempotencyKey: "request-idempotency-000001",
  });

  assert.equal(persistedBeforeRemote, true);
  assert.equal(first.id, second.id);
  assert.equal(fixture.calls.dispatch, 1);
  assert.equal(fixture.store.dispatches.get(first.id)?.state, "dispatch_accepted");
});

test("an ambiguous dispatch timeout never causes a second remote dispatch", async () => {
  const fixture = executorFixture();
  const unavailable = Object.assign(new Error("network details"), { code: "github_unavailable" });
  fixture.remote.dispatchWorkflow = async () => {
    fixture.calls.dispatch += 1;
    throw unavailable;
  };

  const first = await fixture.executor.start({
    repository: fixture.repository,
    preview: fixture.preview,
    idempotencyKey: "request-idempotency-000002",
  });
  const second = await fixture.executor.start({
    repository: fixture.repository,
    preview: fixture.preview,
    idempotencyKey: "request-idempotency-000002",
  });

  assert.equal(first.id, second.id);
  assert.equal(fixture.calls.dispatch, 1);
  assert.equal(fixture.store.dispatches.get(first.id)?.state, "dispatch_requested");
  assert.equal(fixture.store.dispatches.get(first.id)?.error, "actions_dispatch_unknown");
});

test("correlates by gate run-name and imports only after reserving the persisted run artifact", async () => {
  const fixture = executorFixture();
  const gate = await fixture.executor.start({
    repository: fixture.repository,
    preview: fixture.preview,
    idempotencyKey: "request-idempotency-000003",
  });
  const title = `CSB gate ${gate.id} · ${HEAD}`;
  const run: GitHubActionsRemoteRun = {
    id: "7001",
    attempt: 1,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    displayTitle: title,
    createdAt: "2026-08-12T12:00:05.000Z",
  };
  const artifact: GitHubActionsRemoteArtifact = {
    id: "9001",
    name: "csb-gate-artifact-v2",
    digest: `sha256:${"d".repeat(64)}`,
    expired: false,
    workflowRunId: run.id,
  };
  fixture.remote.listWorkflowRuns = async () => [run];
  fixture.remote.getWorkflowRun = async () => run;
  fixture.remote.listWorkflowArtifacts = async () => [artifact];
  fixture.remote.downloadWorkflowArtifact = async () => {
    assert.equal(fixture.store.artifacts.has("github-actions:9001"), true);
    fixture.calls.download += 1;
    return new Uint8Array([1, 2, 3]);
  };
  fixture.remote.countGateChecks = async () => 1;

  const completed = await fixture.executor.reconcileGate(gate.id);

  assert.equal(completed?.status, "completed");
  assert.equal(completed?.workflowRunId, "7001");
  assert.equal(completed?.publishStatus, "published");
  assert.equal(fixture.calls.download, 1);
  assert.equal(fixture.store.dispatches.get(gate.id)?.state, "completed");
});

test("a restarted executor resumes every persisted non-terminal dispatch", async () => {
  const fixture = executorFixture();
  const gate = await fixture.executor.start({
    repository: fixture.repository,
    preview: fixture.preview,
    idempotencyKey: "request-idempotency-000004",
  });
  fixture.remote.listWorkflowRuns = async () => [];

  const reconciled = await fixture.executor.reconcilePending();
  assert.deepEqual(reconciled.map((value) => value.id), [gate.id]);
  assert.equal(fixture.store.dispatches.get(gate.id)?.state, "correlating");
});

function executorFixture() {
  const repository = repositoryFixture();
  const preview = previewFixture();
  const gates = new Map<string, GateRun>();
  const dispatches = new Map<string, GitHubActionsDispatchMetadata>();
  const idempotency = new Map<string, string>();
  const artifacts = new Map<string, GitHubActionsArtifactMetadata>();
  const store: GitHubActionsExecutorStore & {
    gates: typeof gates;
    dispatches: typeof dispatches;
    artifacts: typeof artifacts;
  } = {
    gates,
    dispatches,
    artifacts,
    createDispatchGate: (run, dispatch): CreateGitHubActionsDispatchResult => {
      const key = `${dispatch.repositoryKey}:${dispatch.idempotencyKey}`;
      const existingId = idempotency.get(key);
      if (existingId !== undefined) {
        return {
          created: false,
          gate: gates.get(existingId)!,
          dispatch: dispatches.get(existingId)!,
        };
      }
      gates.set(run.id, structuredClone(run));
      dispatches.set(dispatch.gateId, structuredClone(dispatch));
      idempotency.set(key, run.id);
      return { created: true, gate: gates.get(run.id)!, dispatch: dispatches.get(run.id)! };
    },
    getGateRun: (id) => gates.get(id) ?? null,
    getRepository: (key) => key === repository.repositoryKey ? repository : null,
    getDispatch: (id) => dispatches.get(id) ?? null,
    listPendingDispatches: () => [...dispatches.values()].filter((value) =>
      !["completed", "failed", "cancelled"].includes(value.state)),
    updateGateRun: (id, updates: GateRunUpdate) => Object.assign(gates.get(id)!, updates),
    updateDispatch: (id, updates: GitHubActionsDispatchUpdate) =>
      Object.assign(dispatches.get(id)!, updates),
    reserveArtifact: (metadata) => {
      if (artifacts.has(metadata.id)) return "existing";
      artifacts.set(metadata.id, structuredClone(metadata));
      return "created";
    },
  };
  const calls = { dispatch: 0, download: 0 };
  const remote: GitHubActionsRemote = {
    dispatchWorkflow: async () => { calls.dispatch += 1; },
    listWorkflowRuns: async () => [],
    getWorkflowRun: async () => { throw new Error("unexpected"); },
    listWorkflowArtifacts: async () => [],
    downloadWorkflowArtifact: async () => new Uint8Array(),
    countGateChecks: async () => 0,
  };
  const importedArtifact = {
    publication: { eligible: true },
    resolvedTarget: { headSha: HEAD },
  } as GateArtifactV2;
  const importer = {
    import: ({ gateId }: { gateId: string }) => {
      const gate = gates.get(gateId)!;
      Object.assign(gate, {
        status: "completed",
        outcome: "pass",
        artifactPath: "/managed/gates/result.json",
        publishStatus: "waiting",
        completedAt: "2026-08-12T12:05:00.000Z",
      });
      Object.assign(dispatches.get(gateId)!, {
        state: "completed",
        completedAt: "2026-08-12T12:05:00.000Z",
      });
      return { artifact: importedArtifact, applied: true, duplicate: false };
    },
  } as unknown as ActionsArtifactImporter;
  const executor = new GitHubActionsExecutor({
    store,
    remote,
    importer,
    releaseSha: RELEASE,
    createGateId: () => "gate-actions-1",
    now: () => "2026-08-12T12:00:00.000Z",
  });
  return { repository, preview, store, remote, calls, executor };
}

function repositoryFixture(): GuardrailRepository {
  return {
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    displayName: "OkamiOps/private-sentinel",
    defaultBranch: "main",
    defaultExecutor: "github-actions",
    remoteOwner: "OkamiOps",
    remoteName: "private-sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "991122",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "ready",
  };
}

function previewFixture(): AcceptedGateTargetPreview {
  const policy = defaultGuardrailPolicy();
  return {
    previewIdentity: "preview-actions-1",
    expiresAt: "2026-08-12T12:10:00.000Z",
    repositoryKey: "github:991122",
    executor: "github-actions",
    target: { kind: "pull_request", number: 42 },
    resolvedTarget: {
      baseRef: "main",
      headRef: "feature/security",
      baseSha: BASE,
      headSha: HEAD,
      policySha: BASE,
      pullRequestNumber: 42,
    },
    policySource: "base",
    policySha: BASE,
    policyPath: ".csb/guardrails.json",
    protectedBranches: ["main"],
    exceptionsCount: 0,
    executorCapability: { ready: true, code: "ready" },
    scanPlan: {
      scopeMode: policy.scope.mode,
      maxChangedPaths: policy.scope.maxChangedPaths,
      fallback: policy.scope.fallback,
      model: policy.scan.model,
      effort: policy.scan.effort,
      mode: policy.scan.mode,
    },
    costBudget: {
      maxCostUsd: policy.scan.maxCostUsd,
      kind: "estimated_ceiling",
      requestInFlightMayExceed: true,
    },
    publication: {
      eligible: true,
      protectedBranch: "main",
      reason: "protected_branch",
    },
    policy,
    exceptions: [],
    repositoryAuthority: {
      connectionId: "connection-1",
      installationId: "77",
      repositoryId: "991122",
    },
  };
}
