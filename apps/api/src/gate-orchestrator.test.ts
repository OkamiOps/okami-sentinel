import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGateArtifact,
  buildOperationalErrorArtifact,
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
  waitForGate,
  type LocalGateDependencies,
  type LocalGateRequest,
} from "./gate-orchestrator.js";

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
  };
}

interface FakeDeps extends LocalGateDependencies {
  readonly runs: Map<string, GateRun>;
  startScanCalls: number;
  lastScanRequest: StartScanRequest | null;
  cancelledScanId: string | null;
}

function fakeDeps(options: {
  changeSet?: ChangeSet;
  scanStatus?: ScanRun["status"];
  holdScan?: boolean;
} = {}): FakeDeps {
  const runs = new Map<string, GateRun>();
  const events = new Map<string, Parameters<LocalGateDependencies["appendGateEvent"]>[1][]>();
  const repository: GuardrailRepository = {
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
  };
  const completedScan = scan(options.scanStatus ?? "completed");
  const held = new Promise<ScanRun>(() => undefined);

  const deps: FakeDeps = {
    runs,
    startScanCalls: 0,
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
      return true;
    },
    isScanActive: () => true,
    getBaselineScanId: () => null,
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

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}
