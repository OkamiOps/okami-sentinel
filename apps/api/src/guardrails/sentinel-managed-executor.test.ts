import assert from "node:assert/strict";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";
import type {
  FindingSummary,
  GuardrailRepository,
  ScanRun,
  StartScanRequest,
} from "@csb/shared";

import {
  SentinelManagedExecutor,
  SentinelManagedExecutorError,
  type SentinelManagedExecutorDependencies,
} from "./sentinel-managed-executor.js";
import type {
  MaterializationHandle,
  MaterializedSnapshot,
} from "./snapshot-materializer.js";
import type { AcceptedGateTargetPreview } from "./target-preview.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const SNAPSHOT_ID = `sha256:${"c".repeat(64)}`;
const PRIVATE_HEAD = "/private/managed/gate-1/head";

test("scans only the immutable head path and finalizes v2 before cleanup without leaking it", async () => {
  const order: string[] = [];
  const requests: StartScanRequest[] = [];
  const executionPaths: Array<string | undefined> = [];
  let finalized = "";
  const executor = new SentinelManagedExecutor(dependencies({
    order,
    startScan: async (value, options) => {
      requests.push(structuredClone(value));
      executionPaths.push(options.executionPath);
      return scan("running");
    },
  }));

  const result = await executor.execute({
    gateId: "gate-1",
    repository: repository(),
    preview: preview(),
    hooks: {
      materialized: () => { order.push("materialized"); },
      scanStarted: () => { order.push("scan-started"); },
      finalize: async (value) => {
        order.push("finalized");
        finalized = JSON.stringify(value.artifact);
      },
    },
  });

  assert.equal(executionPaths[0], PRIVATE_HEAD);
  assert.equal(requests[0]?.repositoryPath, `github:991122@${HEAD_SHA}`);
  assert.equal(requests[0]?.remoteRepositoryConfirmed, true);
  assert.deepEqual(requests[0]?.paths, ["src/app.ts"]);
  assert.deepEqual(order, ["materialized", "scan-started", "finalized", "released"]);
  assert.equal(result.artifact.schemaVersion, 2);
  assert.equal(result.artifact.executor, "sentinel-managed");
  assert.equal(result.artifact.resolvedTarget.headSha, HEAD_SHA);
  assert.equal(result.artifact.decision.outcome, "bootstrap");
  assert.equal(result.artifact.decision.githubConclusion, "neutral");
  assert.equal(result.artifact.findings.length, 1);
  assert.equal(finalized.includes(PRIVATE_HEAD), false);
  assert.equal(finalized.includes("/private/managed"), false);
  assert.equal(finalized.includes("/scan/output"), false);
});

test("known unavailable baseline closes as action_required and never produces lifecycle deltas", async () => {
  const executor = new SentinelManagedExecutor(dependencies({
    baselineCandidate: async () => ({ kind: "unavailable", reason: "artifact_not_readable" }),
  }));
  const result = await executor.execute(executionInput());

  assert.equal(result.artifact.decision.outcome, "error");
  assert.equal(result.artifact.decision.githubConclusion, "action_required");
  assert.equal(result.artifact.findings.length, 0);
  assert.match(result.artifact.decision.summary, /^baseline_unavailable:/);
});

test("launches the exact engine, connection, model, effort and mode frozen by the preview", async () => {
  const requests: StartScanRequest[] = [];
  const executor = new SentinelManagedExecutor(dependencies({
    startScan: async (value) => {
      requests.push(structuredClone(value));
      return scan("running");
    },
  }));
  const selectedPreview = preview();
  selectedPreview.scanSelection = {
    engine: "vulnhunter",
    connection: { connectionId: "openrouter", modelSelectionMode: "catalog", modelId: "anthropic/opus" },
    effort: "high",
    mode: "deep",
  };
  await executor.execute({ ...executionInput(), preview: selectedPreview });
  const request = requests[0]!;

  assert.equal(request.engine, "vulnhunter");
  assert.deepEqual(request.connection, selectedPreview.scanSelection.connection);
  assert.equal(request.effort, "high");
  assert.equal(request.mode, "deep");
});

test("uses the frozen manual ceiling and omits maxCostUsd when the preview has no ceiling", async () => {
  const requests: StartScanRequest[] = [];
  const executor = new SentinelManagedExecutor(dependencies({
    startScan: async (value) => {
      requests.push(structuredClone(value));
      return scan("running");
    },
  }));
  const manual = preview();
  manual.costBudget = {
    source: "manual", maxCostUsd: 7.5, kind: "estimated_ceiling", requestInFlightMayExceed: true,
  };
  await executor.execute({ ...executionInput(), preview: manual });
  assert.equal(requests[0]?.maxCostUsd, 7.5);

  const none = preview();
  none.costBudget = { source: "none", maxCostUsd: null, kind: "none", requestInFlightMayExceed: false };
  await executor.execute({ ...executionInput(), preview: none });
  assert.equal("maxCostUsd" in requests[1]!, false);
});

test("partial submodule or LFS coverage cannot publish success", async () => {
  const executor = new SentinelManagedExecutor(dependencies({
    handle: materialization({
      submodules: ["vendor/private-sdk"],
      lfsPointers: ["assets/model.bin"],
    }),
  }));
  const result = await executor.execute(executionInput());

  assert.equal(result.artifact.coverage.status, "partial");
  assert.equal(result.artifact.decision.outcome, "error");
  assert.equal(result.artifact.decision.githubConclusion, "action_required");
});

test("cancellation after materialization releases the private lease and does not finalize", async () => {
  const order: string[] = [];
  const controller = new AbortController();
  const executor = new SentinelManagedExecutor(dependencies({
    order,
    startScan: async () => {
      controller.abort();
      return scan("running");
    },
  }));
  let finalized = false;

  await assert.rejects(
    executor.execute({
      ...executionInput(),
      signal: controller.signal,
      hooks: {
        materialized: () => { order.push("materialized"); },
        scanStarted: () => { order.push("scan-started"); },
        finalize: async () => {
          finalized = true;
        },
      },
    }),
    (error: unknown) => error instanceof SentinelManagedExecutorError
      && error.code === "managed_cancelled",
  );
  assert.equal(finalized, false);
  assert.equal(order.at(-1), "released");
});

function executionInput() {
  return {
    gateId: "gate-1",
    repository: repository(),
    preview: preview(),
    hooks: {
      materialized: () => undefined,
      scanStarted: () => undefined,
      finalize: async () => undefined,
    },
  };
}

function dependencies(overrides: {
  order?: string[];
  handle?: MaterializationHandle;
  startScan?: SentinelManagedExecutorDependencies["startScan"];
  baselineCandidate?: SentinelManagedExecutorDependencies["baselineCandidate"];
} = {}): SentinelManagedExecutorDependencies {
  const handle = overrides.handle ?? materialization();
  const release = handle.release;
  handle.release = async () => {
    overrides.order?.push("released");
    await release();
  };
  return {
    materializer: { materialize: async () => handle },
    startScan: overrides.startScan ?? (async () => scan("running")),
    waitForScan: async () => scan("completed"),
    readFindings: () => [finding()],
    readTriage: () => new Map(),
    baselineCandidate: overrides.baselineCandidate ?? (async () => ({ kind: "absent" })),
    now: () => "2026-08-12T12:00:00.000Z",
  };
}

function materialization(
  headOverrides: Partial<MaterializedSnapshot> = {},
): MaterializationHandle {
  const base = snapshot("/private/managed/gate-1/base", "0".repeat(64));
  const head = snapshot(PRIVATE_HEAD, "1".repeat(64));
  return {
    leaseId: "lease-1",
    identity: SNAPSHOT_ID,
    base,
    head: { ...head, ...headOverrides },
    release: async () => undefined,
  };
}

function snapshot(snapshotPath: string, digest: string): MaterializedSnapshot {
  return {
    path: snapshotPath,
    identity: `sha256:${digest}`,
    entries: [{
      path: "src/app.ts",
      type: "file",
      mode: 0o400,
      size: 20,
      digest: `sha256:${digest}`,
    }],
    fileCount: 1,
    submodules: [],
    lfsPointers: [],
  };
}

function repository(): GuardrailRepository {
  return {
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    displayName: "OkamiOps/private-sentinel",
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: "OkamiOps",
    remoteName: "private-sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "991122",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
  };
}

function preview(): AcceptedGateTargetPreview {
  const policy = defaultGuardrailPolicy();
  return {
    previewIdentity: "preview-1",
    expiresAt: "2026-08-12T12:10:00.000Z",
    repositoryKey: "github:991122",
    executor: "sentinel-managed",
    target: { kind: "pull_request", number: 7 },
    resolvedTarget: {
      baseRef: "main",
      headRef: "refs/pull/7/head",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      policySha: BASE_SHA,
      pullRequestNumber: 7,
    },
    policySource: "base",
    policySha: BASE_SHA,
    policyPath: ".csb/guardrails.json",
    protectedBranches: ["main"],
    exceptionsCount: 0,
    executorCapability: { ready: true, code: "ready" },
    scanPlan: {
      scopeMode: "changed",
      maxChangedPaths: 50,
      fallback: "repository",
      model: policy.scan.model,
      effort: policy.scan.effort,
      mode: policy.scan.mode,
    },
    costBudget: {
      source: "policy",
      maxCostUsd: policy.scan.maxCostUsd,
      kind: "estimated_ceiling",
      requestInFlightMayExceed: true,
    },
    publication: { eligible: true, protectedBranch: "main", reason: "protected_branch" },
    policy,
    exceptions: [],
    repositoryAuthority: {
      connectionId: "connection-1",
      installationId: "77",
      repositoryId: "991122",
    },
  };
}

function scan(status: ScanRun["status"]): ScanRun {
  return {
    id: "scan-1",
    displayName: "private-sentinel",
    repositoryPath: `github:991122@${HEAD_SHA}`,
    revision: `content:${"f".repeat(64)}`,
    scanDir: "/scan/output",
    status,
    model: "MiniMax-M3",
    effort: null,
    mode: "standard",
    engine: "codex-security",
    provider: "minimax",
    authMode: null,
    scannerVersion: "sentinel-codex-security-portable-v1",
    recipeHash: "e".repeat(64),
    startedAt: "2026-08-12T12:00:00.000Z",
    completedAt: status === "running" ? null : "2026-08-12T12:01:00.000Z",
    durationMs: status === "running" ? null : 60_000,
    cost: null,
    severity: {
      critical: 0,
      high: 1,
      medium: 0,
      low: 0,
      info: 0,
      unknown: 0,
      total: 1,
    },
    source: "benchmark",
    pid: null,
    execution: {
      executionProfile: "portable",
      profileVersion: "sentinel-codex-security-portable-v1",
      methodologyRef: "sentinel/codex-security-methodology@v1",
      capabilityCheckId: "probe-1",
      connectionId: "minimax-1",
      routeKind: "minimax-token-plan",
      protocol: "anthropic-messages",
      authKind: "api-key",
    },
    connection: {
      connectionId: "minimax-1",
      routeKind: "minimax-token-plan",
      protocol: "anthropic-messages",
      authKind: "api-key",
      capabilityCheckId: "probe-1",
    },
  };
}

function finding(): FindingSummary {
  return {
    findingId: "PCS-001",
    occurrenceId: "occ-1",
    title: "SQL injection in authentication query",
    severity: "high",
    confidence: "high",
    ruleId: "sql-injection",
    summary: "User input reaches a SQL query without parameter binding.",
    primaryPath: "src/app.ts:10:12",
    fingerprints: [`sha256:${"9".repeat(64)}`],
    category: "injection",
    cwe: ["CWE-89"],
  };
}
