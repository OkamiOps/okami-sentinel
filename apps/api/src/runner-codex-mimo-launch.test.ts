import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ModelCapabilities,
  ProviderModel,
  ScannerCapability,
} from "@csb/shared";

import type { StoredProviderConnection } from "./connections-store.js";
import type { ScanLaunchPlan } from "./connections/launch-plan.js";
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

test("startScan rejects an injected MiMo Codex plan before vault access or spawn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-codex-mimo-"));
  const repositoryPath = path.join(root, "repository");
  fs.mkdirSync(repositoryPath);
  const displayName = `codex-mimo-${randomUUID()}`;
  let selectedPlan: ScanLaunchPlan | null = null;
  let vaultReads = 0;
  let launches = 0;

  try {
    await assert.rejects(
      () => startScan({
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
              get: async () => {
                vaultReads += 1;
                throw new Error("vault must not be read");
              },
              delete: async () => undefined,
            },
          },
          spawn: () => {
            launches += 1;
            throw new Error("scanner must not be spawned");
          },
        },
      }),
      /provider_runner_unavailable/,
    );
    assert.equal(vaultReads, 0);
    assert.equal(launches, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
