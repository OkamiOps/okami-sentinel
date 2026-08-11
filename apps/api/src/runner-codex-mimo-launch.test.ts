import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type {
  ModelCapabilities,
  ProviderModel,
  ScannerCapability,
} from "@csb/shared";

import type { StoredProviderConnection } from "./connections-store.js";
import type { ScanLaunchPlan } from "./connections/launch-plan.js";
import { deleteRun } from "./db.js";
import { startScan } from "./runner.js";

const capabilities: ModelCapabilities = {
  tools: "supported",
  artifactOutput: "supported",
  structuredOutput: "supported",
  boundedExecution: "supported",
  osIsolation: "supported",
  streaming: "supported",
  usage: "supported",
  cancellation: "supported",
};

const scanner: ScannerCapability = {
  engine: "codex-security",
  name: "Codex Security",
  enabled: true,
  available: true,
  maturity: "stable",
  reason: null,
  sourceUrl: "https://github.com/openai/codex-security",
  authModes: [{ id: "api-key", available: true, reason: null }],
  models: [],
  efforts: ["high"],
  modes: ["standard"],
  stageCount: 6,
  writesTarget: false,
  executesGeneratedCode: false,
};

const model: ProviderModel = {
  connectionId: "mimo-connection",
  id: "mimo-v2.5",
  displayName: "MiMo V2.5",
  contextWindow: 262_144,
  capabilities,
  pricing: null,
  discoveredAt: "2026-08-11T12:00:00.000Z",
  source: "provider-api",
};

const connection: StoredProviderConnection = {
  id: "mimo-connection",
  scopeId: "local",
  name: "MiMo Token Plan",
  providerKind: "xiaomi",
  routeKind: "mimo-token-plan",
  transport: "http-inference",
  authKind: "api-key",
  protocol: "openai-chat",
  status: "ready",
  credentialRef: "connection/mimo-connection",
  modelSelectionMode: "catalog",
  defaultModelId: null,
  lastTestedAt: "2026-08-11T12:00:00.000Z",
  lastModelSyncAt: "2026-08-11T12:00:00.000Z",
  modelCatalogStale: false,
  display: {
    providerLabel: "Xiaomi MiMo",
    routeLabel: "Token Plan",
    secretConfigured: true,
    endpointConfigured: true,
    endpointKind: "preset",
  },
};

function plan(scanId: string): ScanLaunchPlan {
  return {
    engine: "codex-security",
    connectionId: connection.id,
    providerKind: "xiaomi",
    routeKind: "mimo-token-plan",
    runnerKind: "codex-security-contract",
    protocol: "openai-chat",
    model,
    capabilityCheckId: null,
    scannerAuthMode: "api-key",
    snapshot: {
      scanId,
      connectionId: connection.id,
      routeKind: "mimo-token-plan",
      modelSelectionMode: "catalog",
      modelId: model.id,
      capabilityCheckId: null,
      capturedAt: "2026-08-11T12:00:00.000Z",
    },
  };
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 91_338,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  queueMicrotask(() => child.emit("close", 0));
  return child;
}

test("startScan launches the exact MiMo Responses bridge without exposing the Token Plan key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-codex-mimo-"));
  const repositoryPath = path.join(root, "repository");
  fs.mkdirSync(repositoryPath);
  const displayName = `codex-mimo-${randomUUID()}`;
  let selectedPlan: ScanLaunchPlan | null = null;
  const launches: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];

  const run = await startScan({
    repositoryPath,
    displayName,
    engine: "codex-security",
    connection: {
      connectionId: connection.id,
      modelSelectionMode: "catalog",
      modelId: model.id,
    },
  }, {
    dependencies: {
      validateScannerRequest: async () => scanner,
      providerRuntime: {
        launchPlans: {
          resolve: ({ scanId }) => {
            selectedPlan = plan(scanId);
            return selectedPlan;
          },
        },
        store: {
          get: () => connection,
          getSnapshot: () => selectedPlan!.snapshot,
          getModel: () => model,
        },
        vault: {
          available: async () => ({ available: true, backend: "keychain" }),
          put: async () => undefined,
          get: async () => ({
            apiKey: "tp-runner-secret",
            baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
          }),
          delete: async () => undefined,
        },
      },
      spawn: (_command, args, options) => {
        launches.push({ args: [...args], env: { ...options.env } });
        return fakeChild();
      },
    },
  });

  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(run.provider, "xiaomi");
    assert.equal(run.authMode, "api-key");
    assert.equal(run.model, "mimo-v2.5");
    assert.equal(launches.length, 1);
    assert.equal(launches[0]?.env.MIMO_API_KEY, "tp-runner-secret");
    assert.equal(launches[0]?.env.OPENAI_API_KEY, "tp-runner-secret");
    assert.equal(launches[0]?.args.includes("model_provider=\"mimo\""), true);
    assert.equal(launches[0]?.args.includes("model_providers.mimo.wire_api=\"responses\""), true);
    assert.equal(JSON.stringify(launches[0]?.args).includes("tp-runner-secret"), false);
  } finally {
    deleteRun(run.id);
    fs.rmSync(run.scanDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
