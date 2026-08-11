import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import type {
  ConnectionSecretBundle,
  CredentialVault,
} from "./credentials/credential-vault.js";
import type { ScannerCapability } from "@csb/shared";

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

class FakeWorkerChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 97531;
}

const scanner: ScannerCapability = {
  engine: "codex-security",
  name: "Codex Security",
  enabled: true,
  available: true,
  maturity: "stable",
  reason: null,
  sourceUrl: "https://github.com/openai/codex-security",
  authModes: [],
  models: [],
  efforts: [],
  modes: ["standard"],
  stageCount: 6,
  writesTarget: false,
  executesGeneratedCode: false,
};

test("Portable Codex Security completes a local API-key HTTP route through launch, worker, reconciliation, and redaction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-e2e-"));
  const stateRoot = path.join(root, "state");
  const repositoryPath = path.join(root, "repository");
  const secret = "e2e-private-api-key";
  const baseUrl = "https://e2e.private.invalid/v1";
  const logs: string[] = [];
  const startedState = process.env.CODEX_SECURITY_STATE_DIR;
  const database = new Database(":memory:");
  let runId: string | undefined;
  let runDir: string | undefined;

  try {
    // The production modules read this only once, at import time. Keeping the
    // test state entirely under its private temp root makes startScan real
    // without ever invoking a real worker or provider.
    process.env.CODEX_SECURITY_STATE_DIR = stateRoot;
    const [
      { createProviderRuntime },
      { startScan },
      { getRun, deleteRun },
      { runPortableCodexSecurity },
      { readPortableCodexSecurityWorkerConfiguration },
      { PORTABLE_CODEX_SECURITY_STAGES },
    ] = await Promise.all([
      import("./provider-runtime.js"),
      import("./runner.js"),
      import("./db.js"),
      import("./scanners/portable-codex-security-http-runner.js"),
      import("./scanners/portable-codex-security-worker.js"),
      import("./scanners/portable-codex-security-profile.js"),
    ]);

    fs.mkdirSync(path.join(repositoryPath, "src"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(repositoryPath, "src", "auth.ts"),
      "export function loadAccount(id: string) {\n  return database.accounts.findUnique({ where: { id } });\n}\n",
      { mode: 0o600 },
    );

    const vault = new MemoryVault();
    const runtime = createProviderRuntime({
      database,
      vault,
      routeDependencies: {
        http: {
          // This is the fresh full-probe result produced by a fake local
          // AgentSession boundary; no endpoint is contacted in this E2E.
          probeSession: async () => completeProbeMeasurement(),
        },
      },
    });
    const connection = await runtime.connections.create({
      name: "E2E custom HTTP",
      providerKind: "custom",
      routeKind: "custom-openai-compatible",
      transport: "http-inference",
      authKind: "api-key",
      protocol: "openai-chat",
      modelSelectionMode: "catalog",
      secret: { apiKey: secret, baseUrl },
    });
    runtime.store.replaceModels(connection.id, [model(connection.id)]);
    const probe = await runtime.connections.probe(connection.id, {
      connectionId: connection.id,
      modelSelectionMode: "catalog",
      modelId: "e2e-model",
    });
    assert.equal(probe?.report.status, "passed");
    assert.equal(probe?.report.capabilities.cancellation, "supported");

    const selection = {
      connectionId: connection.id,
      modelSelectionMode: "catalog" as const,
      modelId: "e2e-model",
    };
    const preview = runtime.compatibility.resolve({
      engine: "codex-security",
      selection,
      executionProfilePreference: "auto",
    });
    assert.equal(preview.eligible, true);
    assert.equal(preview.selectedProfile, "portable");
    assert.equal(preview.capabilityCheckId, probe?.report.id);

    const child = new FakeWorkerChild();
    let workerConfigPath: string | undefined;
    let workerEnvironment: NodeJS.ProcessEnv | undefined;
    const run = await startScan({
      repositoryPath,
      displayName: `portable-e2e-${Date.now()}`,
      engine: "codex-security",
      mode: "standard",
      executionProfilePreference: "portable",
      connection: selection,
    }, {
      dependencies: {
        validateScannerRequest: async () => scanner,
        providerRuntime: runtime,
        environment: { OPENAI_API_KEY: "must-not-cross-worker-boundary" },
        spawn: (_command, args, options) => {
          workerConfigPath = args[1];
          workerEnvironment = options.env;
          return child as unknown as ChildProcess;
        },
      },
    });
    runId = run.id;
    runDir = run.scanDir;

    assert.ok(workerConfigPath);
    assert.equal(fs.statSync(workerConfigPath).mode & 0o777, 0o600);
    const workerConfig = readPortableCodexSecurityWorkerConfiguration(workerConfigPath);
    const serializedConfig = fs.readFileSync(workerConfigPath, "utf8");
    assert.equal(serializedConfig.includes(secret), false);
    assert.equal(serializedConfig.includes(baseUrl), false);
    assert.equal(JSON.stringify(workerEnvironment).includes(secret), false);
    assert.equal(workerEnvironment?.OPENAI_API_KEY, undefined);

    const createdStages: string[] = [];
    const execution = await runPortableCodexSecurity(workerConfig, {
      getSnapshot: (scanId) => runtime.store.getSnapshot(scanId),
      getConnection: (connectionId) => runtime.store.get(connectionId),
      getModel: (connectionId, modelId) => runtime.store.getModel(connectionId, modelId),
      getLatestCapabilityCheck: (connectionId, modelId, protocol) =>
        runtime.store.getLatestCapabilityCheck(connectionId, modelId, protocol),
      vault,
      log: (line) => logs.push(line),
      createSession: async (input) => {
        const stage = String(input.spec.instructions.match(/stage "([a-z-]+)"/)?.[1]);
        createdStages.push(stage);
        const artifact = PORTABLE_CODEX_SECURITY_STAGES.find((item) => item.id === stage)?.artifact;
        assert.ok(artifact, `stage ${stage} must have an artifact`);
        fs.writeFileSync(
          path.join(input.spec.artifactRoot, artifact),
          JSON.stringify(stage === "report"
            ? { schemaVersion: 1, stage: "report", findings: [portableFinding()] }
            : { schemaVersion: 1, stage, summary: `${stage} completed`, observations: [] }),
          { mode: 0o600 },
        );
        return completedStageSession(stage, artifact!);
      },
    });

    assert.equal(execution.runtime.status, "completed");
    assert.equal(execution.runtime.percent, 100);
    assert.deepEqual(createdStages, PORTABLE_CODEX_SECURITY_STAGES.map((stage) => stage.id));
    assert.deepEqual(execution.runtime.usage, {
      reported: true,
      inputTokensKnown: true,
      cachedInputTokensKnown: true,
      cacheWriteInputTokensKnown: true,
      outputTokensKnown: true,
      inputTokens: 18,
      cachedInputTokens: 6,
      cacheWriteInputTokens: 12,
      outputTokens: 24,
    });

    child.emit("close", 0);
    const reconciled = getRun(run.id);
    assert.equal(reconciled?.status, "completed");
    assert.equal(reconciled?.severity.high, 1);
    assert.equal(reconciled?.severity.total, 1);
    assert.equal(reconciled?.cost, null, "unpriced model telemetry must not invent a cost");
    assert.deepEqual(reconciled?.execution, run.execution);
    assert.deepEqual(reconciled?.launchSelection, {
      modelSelectionMode: "catalog",
      modelId: "e2e-model",
      paths: [],
    });

    const publicFiles = [
      workerConfigPath,
      path.join(run.scanDir, "portable-codex-security-runtime.json"),
      path.join(run.scanDir, "findings.json"),
      path.join(run.scanDir, "portable-codex-security-pricing.json"),
    ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
    assert.equal(publicFiles.includes(secret), false);
    assert.equal(publicFiles.includes(baseUrl), false);
    assert.equal(logs.join("\n").includes(secret), false);
    assert.equal(logs.join("\n").includes(baseUrl), false);
  } finally {
    if (runId !== undefined) {
      const { deleteRun } = await import("./db.js");
      deleteRun(runId);
    }
    if (runDir !== undefined) removeUnlocked(runDir);
    database.close();
    if (startedState === undefined) delete process.env.CODEX_SECURITY_STATE_DIR;
    else process.env.CODEX_SECURITY_STATE_DIR = startedState;
    removeUnlocked(root);
  }
});

function model(connectionId: string) {
  return {
    connectionId,
    id: "e2e-model",
    displayName: "E2E Model",
    contextWindow: 128_000,
    capabilities: unknownCapabilities(),
    pricing: null,
    discoveredAt: "2026-08-11T18:00:00.000Z",
    source: "provider-api" as const,
  };
}

function unknownCapabilities() {
  return {
    tools: "unknown" as const,
    artifactOutput: "unknown" as const,
    structuredOutput: "unknown" as const,
    boundedExecution: "unknown" as const,
    osIsolation: "unknown" as const,
    streaming: "unknown" as const,
    usage: "unknown" as const,
    cancellation: "unknown" as const,
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

function portableFinding() {
  return {
    id: "PCS-E2E-1",
    title: "Authorization predicate is absent",
    severity: "high",
    confidence: "high",
    category: "Authorization",
    remediation: "Require ownership verification before loading an account.",
    summary: "The selected account is loaded without an ownership predicate.",
    anchors: [{
      path: "src/auth.ts",
      startLine: 2,
      endLine: 2,
      role: "sink",
      explanation: "The account lookup consumes the caller-controlled identifier.",
    }],
  };
}

function completedStageSession(stage: string, artifact: string) {
  return {
    async *run() {
      yield { type: "tool", phase: "requested", callId: "read", name: "workspace.read" } as const;
      yield { type: "tool", phase: "consumed", callId: "read", name: "workspace.read" } as const;
      yield { type: "tool", phase: "requested", callId: "write", name: "results.write" } as const;
      yield {
        type: "usage",
        usage: {
          inputTokens: 3,
          cachedInputTokens: 1,
          cacheWriteInputTokens: 2,
          outputTokens: 4,
          reasoningTokens: 0,
        },
      } as const;
      yield { type: "artifact", path: artifact, bytes: 32 } as const;
      yield {
        type: "completion",
        text: null,
        structured: { stage, artifact, status: "completed", summary: `${stage} completed` },
      } as const;
    },
    async cancel() { return { remote: false }; },
  };
}

function removeUnlocked(root: string): void {
  if (!fs.existsSync(root)) return;
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function unlock(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) unlock(target);
    if (!entry.isSymbolicLink()) fs.chmodSync(target, entry.isDirectory() ? 0o700 : 0o600);
  }
  fs.chmodSync(root, 0o700);
}
