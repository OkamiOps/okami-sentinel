import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import Database from "better-sqlite3";
import type {
  ModelCapabilities,
  ProviderModel,
  ScannerCapability,
  ScanRun,
} from "@csb/shared";

import type {
  ConnectionSecretBundle,
  CredentialVault,
} from "./credentials/credential-vault.js";
import { deleteRun } from "./db.js";
import { createProviderRuntime } from "./provider-runtime.js";
import { startScan } from "./runner.js";
import { LaunchPlanError } from "./connections/launch-plan.js";

class MemoryVault implements CredentialVault {
  readonly values = new Map<string, ConnectionSecretBundle>();

  async available() { return { available: true, backend: "keychain" as const }; }
  async put(ref: string, value: ConnectionSecretBundle) {
    this.values.set(ref, structuredClone(value));
  }
  async get(ref: string) {
    const value = this.values.get(ref);
    if (value === undefined) throw new Error("credential_not_found");
    return structuredClone(value);
  }
  async delete(ref: string) { this.values.delete(ref); }
}

const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  tools: "unknown",
  artifactOutput: "unknown",
  structuredOutput: "unknown",
  boundedExecution: "unknown",
  osIsolation: "unknown",
  streaming: "unknown",
  usage: "unknown",
  cancellation: "unknown",
};

function scanner(engine: ScannerCapability["engine"]): ScannerCapability {
  return {
    engine,
    name: engine === "mantis" ? "Google Mantis" : "Codex Security",
    enabled: true,
    available: true,
    maturity: engine === "mantis" ? "preview" : "stable",
    reason: null,
    sourceUrl: "https://example.invalid/scanner",
    authModes: [],
    models: [],
    efforts: [],
    modes: ["standard"],
    stageCount: engine === "mantis" ? 9 : 6,
    writesTarget: false,
    executesGeneratedCode: false,
  };
}

function model(connectionId: string, id: string): ProviderModel {
  return {
    connectionId,
    id,
    displayName: id,
    contextWindow: 128_000,
    capabilities: UNKNOWN_CAPABILITIES,
    pricing: null,
    discoveredAt: "2026-08-11T18:00:00.000Z",
    source: "provider-api",
  };
}

function completeProbeMeasurement() {
  return {
    capabilities: {
      tools: "supported" as const,
      artifactOutput: "supported" as const,
      structuredOutput: "supported" as const,
      boundedExecution: "supported" as const,
      usage: "supported" as const,
    },
    limitsEnforced: true,
    agentLoop: {
      workspaceToolRequested: true,
      workspaceToolResultConsumed: true,
      resultsWriteRequested: true,
      artifactProduced: true,
      structuredResultProduced: true,
    },
    runtimeEvidence: {
      authoritativeDeadlineEnforced: true,
      authoritativeCancellationEnforced: true,
      privatePinnedRootsEnforced: true,
      closedToolSurfaceEnforced: true,
    },
  };
}

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

function closeAndRemove(child: ChildProcess, run: Pick<ScanRun, "id" | "scanDir">): void {
  child.emit("close", 0);
  deleteRun(run.id);
  fs.rmSync(run.scanDir, { recursive: true, force: true });
}

test("startScan probes a ready MiniMax route missing only capability evidence, then launches Mantis", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-probe-mantis-"));
  const repositoryPath = path.join(root, "repository");
  const database = new Database(":memory:");
  const vault = new MemoryVault();
  const probeModels: string[] = [];
  let run: ScanRun | undefined;
  let child: ChildProcess | undefined;

  try {
    fs.mkdirSync(repositoryPath);
    const runtime = createProviderRuntime({
      database,
      vault,
      routeDependencies: {
        http: {
          probeSession: async (input) => {
            probeModels.push(input.model.id);
            return completeProbeMeasurement();
          },
        },
      },
    });
    const connection = await runtime.connections.create({
      name: "MiniMax Token Plan",
      providerKind: "minimax",
      routeKind: "minimax-token-plan",
      transport: "http-inference",
      authKind: "api-key",
      protocol: "anthropic-messages",
      modelSelectionMode: "catalog",
      secret: { apiKey: "minimax-test-token" },
    });
    const selected = model(connection.id, "MiniMax-M3");
    runtime.store.replaceModels(connection.id, [selected]);
    await runtime.connections.inspect(connection.id);

    const selection = {
      connectionId: connection.id,
      modelSelectionMode: "catalog" as const,
      modelId: selected.id,
    };
    const before = runtime.compatibility.resolve({ engine: "mantis", selection });
    assert.deepEqual(before.reasons, ["capability_probe_missing"]);

    let spawned = 0;
    run = await startScan({
      repositoryPath,
      displayName: `auto-probe-mantis-${Date.now()}`,
      engine: "mantis",
      connection: selection,
    }, {
      dependencies: {
        validateScannerRequest: async () => scanner("mantis"),
        providerRuntime: runtime,
        spawn: (command, args) => {
          spawned += 1;
          assert.match(command, /tsx$/);
          assert.match(args[0] ?? "", /mantis-http-worker\.ts$/);
          child = fakeChild(96_001);
          return child;
        },
      },
    });

    assert.equal(spawned, 1);
    assert.deepEqual(probeModels, ["MiniMax-M3"]);
    assert.equal(run.provider, "minimax");
    assert.equal(run.model, "MiniMax-M3");
    assert.equal(runtime.compatibility.resolve({ engine: "mantis", selection }).eligible, true);
  } finally {
    if (run !== undefined && child !== undefined) closeAndRemove(child, run);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startScan probes a custom OpenAI-compatible route and launches Portable Codex Security", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-probe-portable-"));
  const repositoryPath = path.join(root, "repository");
  const database = new Database(":memory:");
  const vault = new MemoryVault();
  let probeCalls = 0;
  let run: ScanRun | undefined;
  let child: ChildProcess | undefined;

  try {
    fs.mkdirSync(repositoryPath);
    const runtime = createProviderRuntime({
      database,
      vault,
      routeDependencies: {
        http: {
          probeSession: async () => {
            probeCalls += 1;
            return completeProbeMeasurement();
          },
        },
      },
    });
    const connection = await runtime.connections.create({
      name: "Custom compatible",
      providerKind: "custom",
      routeKind: "custom-openai-compatible",
      transport: "http-inference",
      authKind: "api-key",
      protocol: "openai-chat",
      modelSelectionMode: "catalog",
      secret: {
        apiKey: "custom-test-token",
        baseUrl: "https://custom.example.invalid/v1",
      },
    });
    const selected = model(connection.id, "custom-model");
    runtime.store.replaceModels(connection.id, [selected]);
    await runtime.connections.inspect(connection.id);

    const selection = {
      connectionId: connection.id,
      modelSelectionMode: "catalog" as const,
      modelId: selected.id,
    };
    assert.deepEqual(
      runtime.compatibility.resolve({
        engine: "codex-security",
        selection,
        executionProfilePreference: "portable",
      }).reasons,
      ["capability_probe_missing"],
    );

    let spawned = 0;
    run = await startScan({
      repositoryPath,
      displayName: `auto-probe-portable-${Date.now()}`,
      engine: "codex-security",
      executionProfilePreference: "portable",
      connection: selection,
    }, {
      dependencies: {
        validateScannerRequest: async () => scanner("codex-security"),
        providerRuntime: runtime,
        spawn: (command, args) => {
          spawned += 1;
          assert.match(command, /tsx$/);
          assert.match(args[0] ?? "", /portable-codex-security-worker\.ts$/);
          child = fakeChild(96_002);
          return child;
        },
      },
    });

    assert.equal(spawned, 1);
    assert.equal(probeCalls, 1);
    assert.equal(run.provider, "custom");
    assert.equal(run.execution?.executionProfile, "portable");
    assert.equal(runtime.compatibility.resolve({
      engine: "codex-security",
      selection,
      executionProfilePreference: "portable",
    }).eligible, true);
  } finally {
    if (run !== undefined && child !== undefined) closeAndRemove(child, run);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startScan refreshes stale capability evidence before launching a HTTP scanner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-probe-stale-"));
  const repositoryPath = path.join(root, "repository");
  const database = new Database(":memory:");
  const vault = new MemoryVault();
  let now = new Date("2026-08-11T10:00:00.000Z");
  let probeCalls = 0;
  let run: ScanRun | undefined;
  let child: ChildProcess | undefined;

  try {
    fs.mkdirSync(repositoryPath);
    const runtime = createProviderRuntime({
      database,
      vault,
      now: () => now,
      routeDependencies: {
        http: {
          probeSession: async () => {
            probeCalls += 1;
            return completeProbeMeasurement();
          },
        },
      },
    });
    const connection = await runtime.connections.create({
      name: "MiniMax stale probe",
      providerKind: "minimax",
      routeKind: "minimax-token-plan",
      transport: "http-inference",
      authKind: "api-key",
      protocol: "anthropic-messages",
      modelSelectionMode: "catalog",
      secret: { apiKey: "minimax-stale-probe-token" },
    });
    const selected = model(connection.id, "MiniMax-M3");
    runtime.store.replaceModels(connection.id, [selected]);
    await runtime.connections.inspect(connection.id);
    const selection = {
      connectionId: connection.id,
      modelSelectionMode: "catalog" as const,
      modelId: selected.id,
    };
    assert.equal((await runtime.connections.probe(connection.id, selection))?.report.status, "passed");
    now = new Date("2026-08-11T11:01:00.000Z");
    assert.deepEqual(
      runtime.compatibility.resolve({ engine: "vulnhunter", selection }).reasons,
      ["capability_probe_stale"],
    );

    run = await startScan({
      repositoryPath,
      displayName: `auto-probe-stale-${Date.now()}`,
      engine: "vulnhunter",
      connection: selection,
    }, {
      dependencies: {
        validateScannerRequest: async () => scanner("vulnhunter"),
        providerRuntime: runtime,
        spawn: (command, args) => {
          assert.match(command, /tsx$/);
          assert.match(args[0] ?? "", /vulnhunter-worker\.ts$/);
          child = fakeChild(96_006);
          return child;
        },
      },
    });

    assert.equal(probeCalls, 2);
    assert.equal(run.provider, "minimax");
  } finally {
    if (run !== undefined && child !== undefined) closeAndRemove(child, run);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed dynamic capability probe has a safe failure and starts no child", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-probe-failed-"));
  const repositoryPath = path.join(root, "repository");
  const database = new Database(":memory:");
  const vault = new MemoryVault();

  try {
    fs.mkdirSync(repositoryPath);
    const runtime = createProviderRuntime({
      database,
      vault,
      routeDependencies: {
        http: { probeSession: async () => ({}) },
      },
    });
    const connection = await runtime.connections.create({
      name: "MiniMax failed probe",
      providerKind: "minimax",
      routeKind: "minimax-token-plan",
      transport: "http-inference",
      authKind: "api-key",
      protocol: "anthropic-messages",
      modelSelectionMode: "catalog",
      secret: { apiKey: "minimax-failed-token" },
    });
    const selected = model(connection.id, "MiniMax-M3");
    runtime.store.replaceModels(connection.id, [selected]);
    await runtime.connections.inspect(connection.id);
    const selection = {
      connectionId: connection.id,
      modelSelectionMode: "catalog" as const,
      modelId: selected.id,
    };
    let spawned = 0;

    await assert.rejects(
      startScan({
        repositoryPath,
        displayName: `auto-probe-failed-${Date.now()}`,
        engine: "mantis",
        connection: selection,
      }, {
        dependencies: {
          validateScannerRequest: async () => scanner("mantis"),
          providerRuntime: runtime,
          spawn: () => {
            spawned += 1;
            return fakeChild(96_003);
          },
        },
      }),
      (error: unknown) => error instanceof LaunchPlanError && error.code === "capability_probe_failed",
    );
    assert.equal(spawned, 0);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startScan does not auto-probe when a non-probe compatibility reason is present", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-probe-reasons-"));
  const repositoryPath = path.join(root, "repository");
  const database = new Database(":memory:");
  const vault = new MemoryVault();

  try {
    fs.mkdirSync(repositoryPath);
    let probes = 0;
    const runtime = createProviderRuntime({
      database,
      vault,
      routeDependencies: {
        http: {
          probeSession: async () => {
            probes += 1;
            return completeProbeMeasurement();
          },
        },
      },
    });
    const connection = await runtime.connections.create({
      name: "MiniMax stale catalog",
      providerKind: "minimax",
      routeKind: "minimax-token-plan",
      transport: "http-inference",
      authKind: "api-key",
      protocol: "anthropic-messages",
      modelSelectionMode: "catalog",
      secret: { apiKey: "minimax-stale-token" },
    });
    const selected = model(connection.id, "MiniMax-M3");
    runtime.store.replaceModels(connection.id, [selected]);
    await runtime.connections.inspect(connection.id);
    runtime.store.markModelCatalogStale(connection.id);
    let spawned = 0;

    await assert.rejects(
      startScan({
        repositoryPath,
        engine: "mantis",
        connection: {
          connectionId: connection.id,
          modelSelectionMode: "catalog",
          modelId: selected.id,
        },
      }, {
        dependencies: {
          validateScannerRequest: async () => scanner("mantis"),
          providerRuntime: runtime,
          spawn: () => {
            spawned += 1;
            return fakeChild(96_004);
          },
        },
      }),
      (error: unknown) => error instanceof LaunchPlanError && error.code === "model_catalog_stale",
    );
    assert.equal(probes, 0);
    assert.equal(spawned, 0);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an aborted request cannot spawn after a late capability probe settles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-probe-abort-"));
  const repositoryPath = path.join(root, "repository");
  const database = new Database(":memory:");
  const vault = new MemoryVault();
  let releaseProbe!: (value: ReturnType<typeof completeProbeMeasurement>) => void;
  let markProbeStarted!: () => void;
  let markProbeSettled!: () => void;
  const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
  const probeSettled = new Promise<void>((resolve) => { markProbeSettled = resolve; });
  const delayedProbe = new Promise<ReturnType<typeof completeProbeMeasurement>>((resolve) => {
    releaseProbe = resolve;
  });
  let observedProbeSignal: AbortSignal | undefined;

  try {
    fs.mkdirSync(repositoryPath);
    const runtime = createProviderRuntime({
      database,
      vault,
      routeDependencies: {
        http: {
          probeSession: async (input) => {
            observedProbeSignal = input.signal;
            markProbeStarted();
            try {
              return await delayedProbe;
            } finally {
              markProbeSettled();
            }
          },
        },
      },
    });
    const connection = await runtime.connections.create({
      name: "MiniMax aborted probe",
      providerKind: "minimax",
      routeKind: "minimax-token-plan",
      transport: "http-inference",
      authKind: "api-key",
      protocol: "anthropic-messages",
      modelSelectionMode: "catalog",
      secret: { apiKey: "minimax-abort-token" },
    });
    const selected = model(connection.id, "MiniMax-M3");
    runtime.store.replaceModels(connection.id, [selected]);
    await runtime.connections.inspect(connection.id);
    const connectionBeforeAbort = runtime.store.get(connection.id);
    assert.ok(connectionBeforeAbort);
    assert.equal(runtime.store.getLatestCapabilityCheck(
      connection.id,
      selected.id,
      "anthropic-messages",
    ), null);
    const controller = new AbortController();
    let spawned = 0;
    const launch = startScan({
      repositoryPath,
      engine: "mantis",
      connection: {
        connectionId: connection.id,
        modelSelectionMode: "catalog",
        modelId: selected.id,
      },
    }, {
      signal: controller.signal,
      dependencies: {
        validateScannerRequest: async () => scanner("mantis"),
        providerRuntime: runtime,
        spawn: () => {
          spawned += 1;
          return fakeChild(96_005);
        },
      },
    });

    await probeStarted;
    controller.abort();
    assert.equal(observedProbeSignal, controller.signal);
    assert.equal(observedProbeSignal?.aborted, true);
    await assert.rejects(
      launch,
      (error: unknown) => error instanceof Error && error.message === "credential_unavailable",
    );
    assert.equal(spawned, 0);

    releaseProbe(completeProbeMeasurement());
    await probeSettled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(spawned, 0);
    assert.equal(runtime.store.getLatestCapabilityCheck(
      connection.id,
      selected.id,
      "anthropic-messages",
    ), null);
    const connectionAfterLateProbe = runtime.store.get(connection.id);
    assert.equal(connectionAfterLateProbe?.status, connectionBeforeAbort.status);
    assert.equal(connectionAfterLateProbe?.lastTestedAt, connectionBeforeAbort.lastTestedAt);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
