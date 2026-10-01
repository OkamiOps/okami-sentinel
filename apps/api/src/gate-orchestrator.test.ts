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
  reconcileGateWithLinkedScan,
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

function highFinding(): FindingSummary {
  return {
    findingId: "finding-1",
    occurrenceId: null,
    title: "Stored XSS",
    severity: "high",
    confidence: "high",
    ruleId: "CWE-79",
    summary: null,
    primaryPath: "src/report.ts:88",
    fingerprints: ["sha256:stable-xss"],
    category: "Stored cross-site scripting",
    cwe: ["CWE-79"],
  };
}

interface FakeDeps extends LocalGateDependencies {
  readonly runs: Map<string, GateRun>;
  startScanCalls: number;
  githubBaselineCalls: number;
  lastScanRequest: StartScanRequest | null;
  cancelledScanId: string | null;
  /** Every gate the orchestrator asked to notify about, in order. */
  readonly notified: GateRun[];
  /** Every repository whose baseline projection the orchestrator refreshed. */
  readonly baselineRefreshes: string[];
}

function fakeDeps(options: {
  changeSet?: ChangeSet;
  githubBaseline?: GateArtifact | null;
  githubBaselineError?: Error;
  remoteReady?: boolean;
  scanStatus?: ScanRun["status"];
  holdScan?: boolean;
  scanActive?: boolean;
  /** Makes the notification throw, which must not cost the gate its decision. */
  notifyThrows?: boolean;
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

  const notified: GateRun[] = [];
  const baselineRefreshes: string[] = [];
  const deps: FakeDeps = {
    runs,
    notified,
    startScanCalls: 0,
    githubBaselineCalls: 0,
    lastScanRequest: null,
    cancelledScanId: null,
    baselineRefreshes,
    refreshBaselineState: (repositoryKey) => { baselineRefreshes.push(repositoryKey); },
    notifyOutcome: (gate) => {
      notified.push(gate);
      if (options.notifyThrows) throw new Error("the outbox is unwritable");
    },
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
    isScanActive: () => options.scanActive ?? true,
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
  let checkoutValidationRequested = false;
  deps.resolveChangeSet = async (input) => {
    checkoutValidationRequested = input.requireMatchingCheckout === true;
    return changeSet([]);
  };
  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);

  assert.equal(checkoutValidationRequested, true);
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
  assert.equal(deps.lastScanRequest?.effort, "low");
  assert.equal(deps.lastScanRequest?.mode, "standard");
  assert.equal(deps.lastScanRequest?.maxCostUsd, 18);
  assert.equal(deps.runs.get(gate.id)?.costCeilingUsd, 18);
  assert.equal(deps.runs.get(gate.id)?.estimatedUsd, 0);
});

test("records engine failure as error instead of pass", async () => {
  const deps = fakeDeps({ scanStatus: "failed" });
  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);

  assert.equal(deps.runs.get(gate.id)?.outcome, "error");
});

test("a terminal gate is notified once, with the persisted outcome", async () => {
  const deps = fakeDeps();
  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);

  // Once, not once per emitted event, and with the row as it was stored — that
  // decision is the only thing the reader of the message will be able to open.
  assert.equal(deps.notified.length, 1);
  assert.equal(deps.notified[0]!.id, gate.id);
  assert.equal(deps.notified[0]!.status, "completed");
  assert.equal(deps.notified[0]!.outcome, deps.runs.get(gate.id)?.outcome);
  assert.equal(deps.notified[0]!.completedAt, deps.runs.get(gate.id)?.completedAt);

  // An operational failure is a terminal transition too.
  const failing = fakeDeps({ scanStatus: "failed" });
  const errored = await startLocalGate(request(), failing);
  await waitForGate(errored.id);
  assert.equal(failing.notified.length, 1);
  assert.equal(failing.notified[0]!.status, "error");
  assert.equal(failing.notified[0]!.outcome, "error");

  // And a gate that decided without a scan.
  const empty = fakeDeps({ changeSet: changeSet([]) });
  const unchanged = await startLocalGate(request(), empty);
  await waitForGate(unchanged.id);
  assert.deepEqual(empty.notified.map((run) => run.outcome), ["no_changes"]);
});

test("a completed gate refreshes the repository's baseline word", async () => {
  const deps = fakeDeps();
  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);
  assert.deepEqual(deps.baselineRefreshes, [gate.repositoryKey]);
});

test("a failed gate refreshes the baseline word, so a build never sticks on building", async () => {
  // `markRepositoryBaselineBuilding` writes `building` before the gate runs. If the
  // gate then errors and nobody recomputes, the projection promises a build nobody
  // is running and the screen never goes back to "absent".
  const deps = fakeDeps({ scanStatus: "failed" });
  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);
  assert.deepEqual(deps.baselineRefreshes, [gate.repositoryKey]);
});

test("a refresh that throws still leaves the gate decided", async () => {
  const deps = fakeDeps();
  deps.refreshBaselineState = () => { throw new Error("the projection is unwritable"); };
  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);
  assert.equal(deps.runs.get(gate.id)?.status, "completed");
});

test("a notification that throws still leaves the gate decided", async () => {
  const deps = fakeDeps({ notifyThrows: true });
  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);

  assert.equal(deps.notified.length, 1);
  // The decision, the artifact and the terminal event all survived the throw.
  assert.equal(deps.runs.get(gate.id)?.status, "completed");
  assert.equal(deps.runs.get(gate.id)?.outcome, "bootstrap");
  assert.equal(deps.runs.get(gate.id)?.artifactPath, "/gates/gate-1/csb-gate-result.json");
  assert.ok((deps.listGateEvents(gate.id)).some((event) => event.type === "done"));
});

test("a cancelled gate reaches the notifier only as a cancellation", async () => {
  const deps = fakeDeps({ holdScan: true });
  const gate = await startLocalGate(request(), deps);
  await until(() => deps.runs.get(gate.id)?.scanId === "scan-1");
  assert.equal(cancelGate(gate.id, deps), true);
  await waitForGate(gate.id);

  assert.equal(deps.runs.get(gate.id)?.status, "cancelled");
  // `cancelGate` emits a terminal event like every other path, so the hook does
  // run; the notifier is what turns a cancellation into no message at all —
  // `gateNotificationEvent` in `email/repository-notifications.test.ts` pins that.
  assert.deepEqual(deps.notified.map((run) => run.status), ["cancelled"]);
  assert.deepEqual(deps.notified.map((run) => run.outcome), [null]);
});

test("cancels the linked scan", async () => {
  const deps = fakeDeps({ holdScan: true });
  const gate = await startLocalGate(request(), deps);
  await until(() => deps.runs.get(gate.id)?.scanId === "scan-1");

  assert.equal(cancelGate(gate.id, deps), true);
  assert.equal(deps.cancelledScanId, "scan-1");
});

test("local gates fail closed instead of using a remote baseline without App authority", async () => {
  const deps = fakeDeps({ githubBaseline: githubBaseline() });
  const gate = await startLocalGate(
    { ...request(), baselineSource: "github" },
    deps,
  );
  await waitForGate(gate.id);

  assert.equal(deps.githubBaselineCalls, 0);
  assert.equal(deps.runs.get(gate.id)?.status, "error");
  assert.equal(deps.runs.get(gate.id)?.outcome, "error");
  assert.equal(deps.runs.get(gate.id)?.error, "github_repository_authority_invalid");
});

test("keeps the local baseline provider intact by default", async () => {
  const deps = fakeDeps({ githubBaseline: githubBaseline() });
  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);

  assert.equal(deps.githubBaselineCalls, 0);
  assert.equal(deps.runs.get(gate.id)?.outcome, "bootstrap");
});

test("does not classify an identical finding from another checkout as reopened", async () => {
  const deps = fakeDeps();
  const baseline = { ...scan("completed"), id: "baseline", scanDir: "/workspace/csb/baseline" };
  const foreignHistorical = {
    ...scan("completed"),
    id: "foreign-history",
    repositoryPath: "/workspace/other-repository",
    scanDir: "/workspace/other-repository/history",
  };
  const captured = { artifact: null as GateArtifact | null };
  deps.getBaselineScanId = () => baseline.id;
  deps.getScan = (id) => id === baseline.id ? baseline : id === "scan-1" ? scan("completed") : null;
  deps.listScans = () => [foreignHistorical];
  deps.readFindings = (scanDir) =>
    scanDir === "/workspace/scan-1" || scanDir === foreignHistorical.scanDir ? [highFinding()] : [];
  deps.writeArtifact = (_id, candidate) => {
    captured.artifact = candidate;
    return "/gates/gate-1/csb-gate-result.json";
  };

  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);

  assert.equal(captured.artifact?.findings[0]?.lifecycle, "new");
});

test("keeps same-checkout historical findings eligible for reopened lifecycle", async () => {
  const deps = fakeDeps();
  const baseline = { ...scan("completed"), id: "baseline", scanDir: "/workspace/csb/baseline" };
  const localHistorical = {
    ...scan("completed"),
    id: "local-history",
    repositoryPath: "/workspace/csb",
    scanDir: "/workspace/csb/history",
  };
  const captured = { artifact: null as GateArtifact | null };
  deps.getBaselineScanId = () => baseline.id;
  deps.getScan = (id) => id === baseline.id ? baseline : id === "scan-1" ? scan("completed") : null;
  deps.listScans = () => [localHistorical];
  deps.readFindings = (scanDir) =>
    scanDir === "/workspace/scan-1" || scanDir === localHistorical.scanDir ? [highFinding()] : [];
  deps.writeArtifact = (_id, candidate) => {
    captured.artifact = candidate;
    return "/gates/gate-1/csb-gate-result.json";
  };

  const gate = await startLocalGate(request(), deps);
  await waitForGate(gate.id);

  assert.equal(captured.artifact?.findings[0]?.lifecycle, "reopened");
});

test("skips unreadable historical scans instead of failing a fresh gate", async () => {
  const deps = fakeDeps();
  const removed = {
    ...scan("completed"),
    id: "removed-history",
    repositoryPath: "/workspace/csb",
    scanDir: "/workspace/csb/removed",
  };
  deps.listScans = () => [removed];
  deps.readFindings = (scanDir) => {
    if (scanDir === removed.scanDir) throw new Error("ENOENT: findings ausentes");
    return [];
  };

  const logged = captureServerErrors();
  try {
    const gate = await startLocalGate(request(), deps);
    await waitForGate(gate.id);
    assert.equal(deps.runs.get(gate.id)?.status, "completed");
    assert.equal(deps.runs.get(gate.id)?.outcome, "bootstrap");
  } finally {
    logged.restore();
  }
  assert.equal(logged.messages.length, 1);
  assert.match(logged.messages[0] ?? "", /removed-history/);
});

test("fails the gate when the current scan findings cannot be read", async () => {
  const deps = fakeDeps();
  deps.readFindings = (scanDir) => {
    if (scanDir === "/workspace/scan-1") throw new Error("ENOENT: findings ausentes");
    return [];
  };

  const logged = captureServerErrors();
  try {
    const gate = await startLocalGate(request(), deps);
    await waitForGate(gate.id);
  } finally {
    logged.restore();
  }
  assert.equal(deps.runs.get("gate-1")?.status, "error");
  assert.equal(deps.runs.get("gate-1")?.outcome, "error");
});

test("records a terminal gate error when failure recording collapses", async () => {
  const deps = fakeDeps({ scanStatus: "failed" });
  deps.buildOperationalErrorArtifact = () => {
    throw new Error("artifact_build_failed");
  };

  const logged = captureServerErrors();
  try {
    const gate = await startLocalGate(request(), deps);
    await waitForGate(gate.id);
  } finally {
    logged.restore();
  }
  const gate = deps.runs.get("gate-1");
  assert.equal(gate?.status, "error");
  assert.equal(gate?.outcome, "error");
  assert.equal(gate?.error, "gate_failure_unrecorded");
  assert.equal(gate?.completedAt, "2026-08-07T10:00:00.000Z");
});

test("a collapsed gate failure never rejects the launched task", async () => {
  const deps = fakeDeps({ scanStatus: "failed" });
  deps.buildOperationalErrorArtifact = () => {
    throw new Error("artifact_build_failed");
  };
  const persist = deps.updateGateRun;
  deps.updateGateRun = (id, updates) => {
    if (updates.status === "error") throw new Error("gate_store_unavailable");
    persist(id, updates);
  };

  const logged = captureServerErrors();
  let settled = false;
  try {
    const gate = await startLocalGate(request(), deps);
    await waitForGate(gate.id);
    settled = true;
  } finally {
    logged.restore();
  }
  assert.equal(settled, true);
  assert.equal(deps.runs.get("gate-1")?.status, "scanning");
});

function captureServerErrors(): { messages: string[]; restore(): void } {
  const messages: string[] = [];
  const original = console.error;
  console.error = (message: unknown) => {
    messages.push(String(message));
  };
  return {
    messages,
    restore: () => {
      console.error = original;
    },
  };
}

test("rejects github baseline selection when the repository has no ready remote", async () => {
  const deps = fakeDeps({ remoteReady: false });

  await assert.rejects(
    () => startLocalGate({ ...request(), baselineSource: "github" }, deps),
    /remoto GitHub não está pronto/,
  );
  assert.equal(deps.githubBaselineCalls, 0);
  assert.equal(deps.runs.size, 0);
});

test("legacy github baseline requests cannot bypass missing App enrollment", async () => {
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

  assert.equal(deps.githubBaselineCalls, 0);
  assert.equal(deps.runs.get(gate.id)?.status, "error");
  assert.equal(deps.runs.get(gate.id)?.outcome, "error");
  assert.equal(deps.runs.get(gate.id)?.error, "github_repository_authority_invalid");
});

test("the managed path notifies once too, and a throwing notifier keeps the decision", async () => {
  const succeeded = remoteDeps();
  const gate = await startRemoteManagedGate(remotePreview(), succeeded.deps);
  await waitForGate(gate.id);
  assert.deepEqual(succeeded.notified.map((run) => [run.status, run.outcome]), [["completed", "bootstrap"]]);

  // The same, with a notifier that throws: the managed decision is already
  // durable when the hook runs, and must stay that way.
  const throwing = remoteDeps({ notifyThrows: true });
  const second = await startRemoteManagedGate(remotePreview(), throwing.deps);
  await waitForGate(second.id);
  assert.equal(throwing.runs.get(second.id)?.status, "completed");
  assert.equal(throwing.runs.get(second.id)?.outcome, "bootstrap");
  assert.equal(throwing.runs.get(second.id)?.publishStatus, "published");
  assert.equal(throwing.notified.length, 1);

  // And an executor that fails outright is an error the subscribers hear about.
  const failing = remoteDeps({ execute: async () => { throw new Error("managed executor died"); } });
  const third = await startRemoteManagedGate(remotePreview(), failing.deps);
  await waitForGate(third.id);
  assert.deepEqual(failing.notified.map((run) => [run.status, run.outcome]), [["error", "error"]]);
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
  assert.equal(gate.costCeilingUsd, 18);
  assert.equal(gate.estimatedUsd, 0);
  assert.deepEqual(calls, ["execute", "write", "publish", "comment"]);
  const completed = runs.get(gate.id)!;
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome, "bootstrap");
  assert.equal(completed.publishStatus, "published");
  assert.equal(completed.materializationState, "released");
  assert.equal(completed.repositoryPath, null);
  assert.equal(JSON.stringify(completed).includes("/private/managed"), false);
});

test("a completed managed gate refreshes the repository's baseline word", async () => {
  const { deps, baselineRefreshes } = remoteDeps();
  const gate = await startRemoteManagedGate(remotePreview(), deps);
  await waitForGate(gate.id);
  assert.deepEqual(baselineRefreshes, [gate.repositoryKey]);
});

test("keeps a persisted managed decision completed when cleanup fails afterwards", async () => {
  const execution = remoteExecutionResult();
  const { deps, runs, events } = remoteDeps({ execute: async (input) => {
    await input.hooks.materialized(`sha256:${"c".repeat(64)}`);
    await input.hooks.scanStarted(scan("running"));
    await input.hooks.finalize(execution);
    throw new Error("snapshot_cleanup_failed");
  } });

  const logged = captureServerErrors();
  try {
    const gate = await startRemoteManagedGate(remotePreview(), deps);
    await waitForGate(gate.id);
  } finally {
    logged.restore();
  }

  const completed = runs.get("managed-gate-1");
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.outcome, "bootstrap");
  assert.equal(completed?.error, null);
  assert.equal(completed?.artifactPath, "/gates/managed-gate-1/csb-gate-result.json");
  assert.equal(events.get("managed-gate-1")?.some((event) => event.type === "error"), false);
  assert.equal(events.get("managed-gate-1")?.at(-1)?.type, "done");
  assert.equal(logged.messages.length, 1);
});

test("a comment failure leaves the gate completed", async () => {
  const { deps, runs } = remoteDeps({
    publishComment: async () => ({
      status: "failed",
      reason: "github_permission_missing",
      alert: true,
    }),
  });
  const gate = await startRemoteManagedGate(remotePreview(), deps);
  await waitForGate(gate.id);
  assert.equal(runs.get(gate.id)?.status, "completed");
  assert.equal(runs.get(gate.id)?.publishStatus, "published");
  assert.equal(runs.get(gate.id)?.error, null);
});

test("a comment that throws leaves the gate completed", async () => {
  const { deps, runs } = remoteDeps({
    publishComment: async () => { throw new Error("the comment client exploded"); },
  });
  const logged = captureServerErrors();
  let gate;
  try {
    gate = await startRemoteManagedGate(remotePreview(), deps);
    await waitForGate(gate.id);
  } finally {
    logged.restore();
  }
  assert.equal(runs.get(gate.id)?.status, "completed");
  assert.equal(runs.get(gate.id)?.error, null);
});

test("a refusal the publisher has already announced raises no second alert", async () => {
  const { deps, runs } = remoteDeps({
    publishComment: async () => ({
      status: "failed",
      reason: "github_permission_missing",
      alert: false,
    }),
  });
  const gate = await startRemoteManagedGate(remotePreview(), deps);
  await waitForGate(gate.id);
  assert.equal(runs.get(gate.id)?.status, "completed");
});

test("the comment is published after the check, for a pull-request gate", async () => {
  const { deps, calls } = remoteDeps();
  const gate = await startRemoteManagedGate(remotePreview(), deps);
  await waitForGate(gate.id);
  assert.ok(calls.indexOf("comment") > calls.indexOf("publish"));
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
  notifyThrows?: boolean;
  publishComment?: RemoteManagedGateDependencies["publishComment"];
} = {}): {
  deps: RemoteManagedGateDependencies;
  runs: Map<string, GateRun>;
  events: Map<string, Parameters<RemoteManagedGateDependencies["appendGateEvent"]>[1][]>;
  calls: string[];
  notified: GateRun[];
  baselineRefreshes: string[];
} {
  const runs = new Map<string, GateRun>();
  const events = new Map<string, Parameters<RemoteManagedGateDependencies["appendGateEvent"]>[1][]>();
  const calls: string[] = [];
  const notified: GateRun[] = [];
  const baselineRefreshes: string[] = [];
  const result = remoteExecutionResult();
  const deps: RemoteManagedGateDependencies = {
    refreshBaselineState: (repositoryKey) => { baselineRefreshes.push(repositoryKey); },
    notifyOutcome: (gate) => {
      notified.push(gate);
      if (overrides.notifyThrows) throw new Error("the outbox is unwritable");
    },
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
    publishComment: overrides.publishComment ?? (async () => {
      calls.push("comment");
      return { status: "created", commentId: "101" };
    }),
  };
  return { deps, runs, events, calls, notified, baselineRefreshes };
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
    policySource: "repository_file",
    policyInvalidReason: null,
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

test("reconciles a stale scanning gate when its linked scan has failed", () => {
  const deps = fakeDeps({ scanStatus: "failed", scanActive: false });
  deps.runs.set("stale-gate", {
    id: "stale-gate",
    repositoryKey: "github.com/okami/csb",
    repositoryPath: "/workspace/csb",
    source: "local",
    executor: "sentinel-managed",
    baseRef: "main",
    headRef: "HEAD",
    resolvedBaseSha: "base123",
    resolvedHeadSha: "head456",
    policySha: null,
    policySource: null,
    pullRequestNumber: null,
    workflowRunId: null,
    materializationState: "not_required",
    scanLineageHash: null,
    artifactSchemaVersion: 1,
    scanId: "scan-1",
    status: "scanning",
    outcome: null,
    policyVersion: 1,
    baselineCommit: null,
    artifactPath: null,
    publishStatus: "not_configured",
    publishError: null,
    publishedAt: null,
    error: null,
    startedAt: "2026-08-07T10:00:00.000Z",
    completedAt: null,
    costCeilingUsd: 18,
    estimatedUsd: 0,
  });

  const reconciled = reconcileGateWithLinkedScan("stale-gate", deps);

  assert.equal(reconciled?.status, "error");
  assert.equal(reconciled?.outcome, "error");
  assert.equal(reconciled?.error, "linked_scan_failed");
  assert.equal(reconciled?.completedAt, "2026-08-07T10:01:00.000Z");
});

test("fails closed when a completed linked scan lost gate finalization", () => {
  const deps = fakeDeps({ scanStatus: "completed", scanActive: false });
  deps.runs.set("interrupted-gate", {
    id: "interrupted-gate",
    repositoryKey: "github.com/okami/csb",
    repositoryPath: "/workspace/csb",
    source: "local",
    executor: "sentinel-managed",
    baseRef: "main",
    headRef: "HEAD",
    resolvedBaseSha: "base123",
    resolvedHeadSha: "head456",
    policySha: null,
    policySource: null,
    pullRequestNumber: null,
    workflowRunId: null,
    materializationState: "not_required",
    scanLineageHash: null,
    artifactSchemaVersion: 1,
    scanId: "scan-1",
    status: "scanning",
    outcome: null,
    policyVersion: 1,
    baselineCommit: null,
    artifactPath: null,
    publishStatus: "not_configured",
    publishError: null,
    publishedAt: null,
    error: null,
    startedAt: "2026-08-07T10:00:00.000Z",
    completedAt: null,
    costCeilingUsd: 18,
    estimatedUsd: 0,
  });

  const reconciled = reconcileGateWithLinkedScan("interrupted-gate", deps);

  assert.equal(reconciled?.status, "error");
  assert.equal(reconciled?.error, "gate_finalization_interrupted");
});

test("local gates pass explicit routes and selected cost controls to the scanner", async () => {
  for (const costLimit of [{ kind: "manual", maxCostUsd: 3.5 }, { kind: "none" }] as const) {
    const deps = fakeDeps({ changeSet: changeSet(["src/a.ts"]) });
    const selection = { engine: "codex-security" as const, connection: { connectionId: "qa-cli", modelSelectionMode: "runtime-default" as const, modelId: null }, mode: "deep" as const, costLimit };
    const gate = await startLocalGate({ ...request(), scanSelection: selection }, deps);
    await waitForGate(gate.id);
    assert.deepEqual(deps.lastScanRequest?.connection, selection.connection);
    assert.equal(deps.lastScanRequest?.engine, "codex-security");
    assert.equal(deps.lastScanRequest?.model, undefined);
    assert.equal(deps.lastScanRequest?.mode, "deep");
    assert.equal(deps.lastScanRequest?.maxCostUsd, costLimit.kind === "manual" ? 3.5 : undefined);
    assert.equal(gate.costCeilingUsd, costLimit.kind === "manual" ? 3.5 : 0);
  }
});
