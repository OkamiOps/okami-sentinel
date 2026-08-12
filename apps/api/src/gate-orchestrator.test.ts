import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGateArtifact,
  buildGateArtifactV2,
  buildOperationalErrorArtifact,
  buildScanLineage,
  defaultGuardrailPolicy,
  evaluateGate,
} from "@csb/gate-core";
import type {
  ChangeSet,
  FindingSummary,
  GateArtifact,
  GateRun,
  GuardrailRepository,
  ScanRun,
  StartScanRequest,
} from "@csb/shared";

import {
  cancelGate,
  startLocalGate,
  startRemoteManagedGate,
  waitForGate,
  type LocalGateDependencies,
  type LocalGateRequest,
  type RemoteManagedGateDependencies,
} from "./gate-orchestrator.js";
import type { AcceptedGateTargetPreview } from "./guardrails/target-preview.js";
import type { SentinelManagedExecutionResult } from "./guardrails/sentinel-managed-executor.js";

function changeSet(paths: string[]): ChangeSet {
  return {
    baseRef: "main",
    headRef: "HEAD",
    baseSha: "base123",
    headSha: "head456",
    files: paths.map((path) => ({
      status: "modified",
      path,
      previousPath: null,
      additions: null,
      deletions: null,
    })),
    scanPaths: paths,
    scopeMode: "changed",
    fallbackReason: null,
  };
}

function request(): LocalGateRequest {
  return {
    repositoryKey: "github.com/okami/csb",
    baseRef: "main",
    headRef: "HEAD",
  };
}

function scan(status: ScanRun["status"]): ScanRun {
  return {
    id: "scan-1",
    displayName: "Codex Security Benchmark",
    repositoryPath: "/workspace/csb",
    revision: "head456",
    scanDir: "/workspace/scan-1",
    status,
    model: "gpt-5.6-sol",
    effort: "high",
    mode: "standard",
    engine: "codex-security",
    provider: "openai",
    authMode: "chatgpt",
    scannerVersion: null,
    recipeHash: null,
    startedAt: "2026-08-07T10:00:00.000Z",
    completedAt: status === "running" ? null : "2026-08-07T10:01:00.000Z",
    durationMs: status === "running" ? null : 60_000,
    cost: null,
    severity: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
      unknown: 0,
      total: 0,
    },
    source: "benchmark",
    pid: null,
    execution: null,
  };
}

interface FakeDeps extends LocalGateDependencies {
  readonly runs: Map<string, GateRun>;
  startScanCalls: number;
  githubBaselineCalls: number;
  lastScanRequest: StartScanRequest | null;
  cancelledScanId: string | null;
}

function fakeDeps(options: {
  changeSet?: ChangeSet;
  githubBaseline?: GateArtifact | null;
  githubBaselineError?: Error;
  remoteReady?: boolean;
  scanStatus?: ScanRun["status"];
  holdScan?: boolean;
} = {}): FakeDeps {
  const runs = new Map<string, GateRun>();
  const events = new Map<string, Parameters<LocalGateDependencies["appendGateEvent"]>[1][]>();
  const repository: GuardrailRepository = {
    repositoryKey: "github.com/okami/csb",
    repositoryPath: "/workspace/csb",
    source: "local",
    displayName: "Codex Security Benchmark",
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: options.remoteReady === false ? null : "okami",
    remoteName: options.remoteReady === false ? null : "csb",
    githubConnectionId: null,
    githubInstallationId: null,
    githubRepositoryId: null,
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
  };
  const completedScan = scan(options.scanStatus ?? "completed");
  let releaseHeld: ((value: ScanRun) => void) | null = null;
  const held = new Promise<ScanRun>((resolve) => {
    releaseHeld = resolve;
  });

  const deps: FakeDeps = {
    runs,
    startScanCalls: 0,
    githubBaselineCalls: 0,
    lastScanRequest: null,
    cancelledScanId: null,
    createGateId: () => "gate-1",
    now: () => "2026-08-07T10:00:00.000Z",
    getRepository: () => repository,
    insertGateRun: (run) => runs.set(run.id, structuredClone(run)),
    updateGateRun: (id, updates) => {
      const current = runs.get(id);
      if (current) runs.set(id, { ...current, ...updates });
    },
    getGateRun: (id) => runs.get(id) ?? null,
    listGateEvents: (id) => events.get(id) ?? [],
    appendGateEvent: (id, event) => events.set(id, [...(events.get(id) ?? []), event]),
    readPolicy: () => defaultGuardrailPolicy(),
    resolveChangeSet: async () => options.changeSet ?? changeSet(["src/a.ts"]),
    startScan: async (scanRequest) => {
      deps.startScanCalls += 1;
      deps.lastScanRequest = scanRequest;
      return scan("running");
    },
    waitForScan: async () => options.holdScan ? held : completedScan,
    cancelScan: (id) => {
      deps.cancelledScanId = id;
      releaseHeld?.({ ...completedScan, status: "cancelled" });
      return true;
    },
    isScanActive: () => true,
    getBaselineScanId: () => null,
    githubBaselineProvider: {
      getBaseline: async () => {
        deps.githubBaselineCalls += 1;
        if (options.githubBaselineError) throw options.githubBaselineError;
        return options.githubBaseline ?? null;
      },
    },
    getScan: (id) => id === "scan-1" ? completedScan : null,
    listScans: () => [],
    readFindings: () => [] as FindingSummary[],
    readTriage: () => new Map(),
    readExceptions: () => [],
    evaluateGate,
    buildGateArtifact,
    buildOperationalErrorArtifact,
    writeArtifact: (_id, artifact) => {
      assert.equal((artifact as GateArtifact).gateId, "gate-1");
      return "/gates/gate-1/csb-gate-result.json";
    },
  };
  return deps;
}

function githubBaseline(headSha = "remote-head"): GateArtifact {
  return buildGateArtifact({
    gateId: "github-gate",
    repository: {
      key: "github.com/okami/csb",
      owner: "okami",
      name: "csb",
      defaultBranch: "main",
    },
    source: "github",
    changeSet: {
      ...changeSet(["src/a.ts"]),
      headRef: headSha,
      headSha,
    },
    policy: defaultGuardrailPolicy(),
    scan: { id: "github-scan", cost: null, status: "completed" },
    baselineCommit: null,
    evaluation: {
      deltas: [],
      decision: {
        outcome: "bootstrap",
        summary: "Baseline initialized with 0 finding(s).",
        violations: [],
        warnings: [],
        exceptionsApplied: [],
        githubConclusion: "neutral",
      },
    },
    versions: { gateCore: "0.1.0", scanner: "gpt-5.6-sol" },
    createdAt: "2026-08-07T09:00:00.000Z",
  });
}

test("finishes no_changes without starting a scan", async () => {
  const deps = fakeDeps({ changeSet: changeSet([]) });
  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);

  assert.equal(deps.startScanCalls, 0);
  assert.equal(deps.runs.get(gate.id)?.outcome, "no_changes");
});

test("passes changed paths and cost envelope to the scanner", async () => {
  const deps = fakeDeps({
    changeSet: changeSet(["src/a.ts", "src/b.ts"]),
  });
  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);

  assert.deepEqual(deps.lastScanRequest?.paths, ["src/a.ts", "src/b.ts"]);
  assert.equal(deps.lastScanRequest?.maxCostUsd, 18);
});

test("records engine failure as error instead of pass", async () => {
  const deps = fakeDeps({ scanStatus: "failed" });
  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);

  assert.equal(deps.runs.get(gate.id)?.outcome, "error");
});

test("cancels the linked scan", async () => {
  const deps = fakeDeps({ holdScan: true });
  const gate = await startLocalGate(request(), deps);
  await until(() => deps.runs.get(gate.id)?.scanId === "scan-1");

  assert.equal(cancelGate(gate.id, deps), true);
  assert.equal(deps.cancelledScanId, "scan-1");
});

test("uses the github provider only when github baseline is requested and a remote is ready", async () => {
  const deps = fakeDeps({ githubBaseline: githubBaseline() });
  const gate = await startLocalGate(
    { ...request(), baselineSource: "github" },
    deps,
  );
  await waitForGate(gate.id);

  assert.equal(deps.githubBaselineCalls, 1);
  assert.equal(deps.runs.get(gate.id)?.baselineCommit, "remote-head");
  assert.equal(deps.runs.get(gate.id)?.outcome, "pass");
});

test("keeps the local baseline provider intact by default", async () => {
  const deps = fakeDeps({ githubBaseline: githubBaseline() });
  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);

  assert.equal(deps.githubBaselineCalls, 0);
  assert.equal(deps.runs.get(gate.id)?.outcome, "bootstrap");
});

test("rejects github baseline selection when the repository has no ready remote", async () => {
  const deps = fakeDeps({ remoteReady: false });

  await assert.rejects(
    () => startLocalGate({ ...request(), baselineSource: "github" }, deps),
    /remoto GitHub não está pronto/,
  );
  assert.equal(deps.githubBaselineCalls, 0);
  assert.equal(deps.runs.size, 0);
});

test("turns unavailable github baseline history into an operational error", async () => {
  const deps = fakeDeps({
    githubBaselineError: new Error(
      "histórico encontrado, mas o artifact de baseline não está disponível",
    ),
  });
  const gate = await startLocalGate(
    { ...request(), baselineSource: "github" },
    deps,
  );
  await waitForGate(gate.id);

  assert.equal(deps.githubBaselineCalls, 1);
  assert.equal(deps.runs.get(gate.id)?.status, "error");
  assert.equal(deps.runs.get(gate.id)?.outcome, "error");
  assert.match(deps.runs.get(gate.id)?.error ?? "", /histórico encontrado/);
});

test("remote managed gate persists frozen identity before execution and publishes only after artifact v2", async () => {
  const { deps, runs, calls } = remoteDeps();
  const gate = await startRemoteManagedGate(remotePreview(), deps);
  await waitForGate(gate.id);

  assert.equal(gate.repositoryPath, null);
  assert.equal(gate.resolvedBaseSha, "a".repeat(40));
  assert.equal(gate.resolvedHeadSha, "b".repeat(40));
  assert.equal(gate.policySha, "a".repeat(40));
  assert.equal(gate.artifactSchemaVersion, 2);
  assert.deepEqual(calls, ["execute", "write", "publish"]);
  const completed = runs.get(gate.id)!;
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome, "bootstrap");
  assert.equal(completed.publishStatus, "published");
  assert.equal(completed.materializationState, "released");
  assert.equal(completed.repositoryPath, null);
  assert.equal(JSON.stringify(completed).includes("/private/managed"), false);
});

test("remote managed gate cancellation aborts the executor and linked scan", async () => {
  let rejectExecution: ((error: Error) => void) | null = null;
  const held = new Promise<SentinelManagedExecutionResult>((_resolve, reject) => {
    rejectExecution = reject;
  });
  const { deps, runs } = remoteDeps({ execute: async (input) => {
    await input.hooks.scanStarted(scan("running"));
    input.signal?.addEventListener("abort", () => {
      rejectExecution?.(new Error("managed_cancelled"));
    }, { once: true });
    return held;
  } });
  const gate = await startRemoteManagedGate(remotePreview(), deps);
  await until(() => runs.get(gate.id)?.scanId === "scan-1");

  assert.equal(cancelGate(gate.id, deps), true);
  await waitForGate(gate.id);
  assert.equal(runs.get(gate.id)?.status, "cancelled");
  assert.equal(runs.get(gate.id)?.artifactPath, null);
});

function remoteDeps(overrides: {
  execute?: RemoteManagedGateDependencies["execute"];
} = {}): {
  deps: RemoteManagedGateDependencies;
  runs: Map<string, GateRun>;
  calls: string[];
} {
  const runs = new Map<string, GateRun>();
  const events = new Map<string, Parameters<RemoteManagedGateDependencies["appendGateEvent"]>[1][]>();
  const calls: string[] = [];
  const result = remoteExecutionResult();
  const deps: RemoteManagedGateDependencies = {
    createGateId: () => "managed-gate-1",
    now: () => "2026-08-12T12:00:00.000Z",
    getRepository: () => remoteRepository(),
    insertGateRun: (run) => runs.set(run.id, structuredClone(run)),
    updateGateRun: (id, updates) => {
      const current = runs.get(id);
      if (current) runs.set(id, { ...current, ...updates });
    },
    getGateRun: (id) => runs.get(id) ?? null,
    listGateEvents: (id) => events.get(id) ?? [],
    appendGateEvent: (id, event) => events.set(id, [...(events.get(id) ?? []), event]),
    execute: overrides.execute ?? (async (input) => {
      calls.push("execute");
      await input.hooks.materialized(`sha256:${"c".repeat(64)}`);
      await input.hooks.scanStarted(scan("running"));
      await input.hooks.finalize(result);
      return result;
    }),
    cancelScan: () => true,
    writeArtifact: (_id, artifact) => {
      calls.push("write");
      assert.equal(artifact.schemaVersion, 2);
      return "/gates/managed-gate-1/csb-gate-result.json";
    },
    publishCheck: async ({ artifact }) => {
      calls.push("publish");
      assert.equal(artifact.schemaVersion, 2);
      return "created";
    },
  };
  return { deps, runs, calls };
}

function remoteRepository(): GuardrailRepository {
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

function remotePreview(): AcceptedGateTargetPreview {
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
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      policySha: "a".repeat(40),
      pullRequestNumber: 7,
    },
    policySource: "base",
    policySha: "a".repeat(40),
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

function remoteExecutionResult(): SentinelManagedExecutionResult {
  const policy = defaultGuardrailPolicy();
  const change = {
    baseRef: "main",
    headRef: "refs/pull/7/head",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    files: [{
      status: "modified" as const,
      path: "src/a.ts",
      previousPath: null,
      additions: null,
      deletions: null,
    }],
    scanPaths: ["src/a.ts"],
    scopeMode: "changed" as const,
    fallbackReason: null,
  };
  const artifact = buildGateArtifactV2({
    gateId: "managed-gate-1",
    repository: {
      id: "github:991122",
      key: "github:991122",
      owner: "OkamiOps",
      name: "private-sentinel",
      defaultBranch: "main",
      locator: { kind: "github", repositoryId: "991122", owner: "OkamiOps", name: "private-sentinel" },
    },
    source: "github",
    executor: "sentinel-managed",
    target: { kind: "pull_request", number: 7 },
    resolvedTarget: remotePreview().resolvedTarget,
    policySource: "base",
    changeSet: change,
    policy,
    scan: { id: "scan-1", cost: null, status: "completed" },
    baselineCommit: null,
    evaluation: {
      deltas: [],
      decision: {
        outcome: "bootstrap",
        summary: "Baseline initialized with 0 finding(s).",
        violations: [],
        warnings: [],
        exceptionsApplied: [],
        githubConclusion: "neutral",
      },
    },
    lineage: buildScanLineage({
      engine: "codex-security",
      engineVersion: "portable-v1",
      route: "minimax-token-plan",
      protocol: "anthropic-messages",
      provider: "minimax",
      model: "MiniMax-M3",
      reasoningEffort: "provider-managed",
      methodology: "portable-v1",
      profile: "portable-v1",
      recipeHash: `sha256:${"d".repeat(64)}`,
      sourceRevision: `sha256:${"e".repeat(64)}`,
    }),
    coverage: {
      status: "complete",
      repositoryFileCount: 1,
      inspectedFileCount: 1,
      unexaminedFileCount: 0,
      submodules: [],
      lfsPointers: [],
    },
    snapshot: { identity: `sha256:${"c".repeat(64)}`, materializerVersion: "github-archive-v1" },
    workflowRun: null,
    versions: { gateCore: "0.2.0", scanner: "portable-v1" },
    createdAt: "2026-08-12T12:00:00.000Z",
  });
  return { artifact, changeSet: change, scan: scan("completed"), baseline: { kind: "absent" } };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}
