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
import { deleteRun } from "./db.js";
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
    runnerKind: "agent-session",
    protocol: "openai-chat",
    model,
    capabilityCheckId: "probe-mimo",
    execution: {
      executionProfile: "portable",
      profileVersion: "sentinel-codex-security-portable-v1",
      methodologyRef: "sentinel/codex-security-methodology@v1",
      capabilityCheckId: "probe-mimo",
      connectionId: connection.id,
      routeKind: "mimo-token-plan",
      protocol: "openai-chat",
      authKind: "api-key",
    },
    snapshot: {
      scanId,
      connectionId: connection.id,
      routeKind: "mimo-token-plan",
      modelSelectionMode: "catalog",
      modelId: model.id,
      capabilityCheckId: "probe-mimo",
      executionProfile: "portable",
      profileVersion: "sentinel-codex-security-portable-v1",
      methodologyRef: "sentinel/codex-security-methodology@v1",
      protocol: "openai-chat",
      authKind: "api-key",
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
  return child;
}

test("startScan dispatches only the Portable worker for a resolved Portable Codex plan", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-codex-mimo-"));
  const repositoryPath = path.join(root, "repository");
  fs.mkdirSync(repositoryPath);
  const displayName = `codex-mimo-${randomUUID()}`;
  let selectedPlan: ScanLaunchPlan | null = null;
  let vaultReads = 0;
  const launches: Array<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    child: ChildProcess;
  }> = [];
  let runId: string | null = null;

  try {
    const run = await startScan({
        repositoryPath,
        displayName,
        engine: "codex-security",
        executionProfilePreference: "portable",
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
          spawn: (command, args, options) => {
            const child = fakeChild();
            launches.push({ command, args: [...args], env: { ...options.env }, child });
            return child;
          },
          environment: {
            PATH: "/private/portable-worker-bin",
            HOME: "/private/portable-worker-home",
            MIMO_API_KEY: "mimo-api-key-must-not-reach-worker",
            MIMO_BASE_URL: "https://private.mimo.example/v1",
            CUSTOM_TOKEN: "custom-token-must-not-reach-worker",
            NODE_OPTIONS: "--require /private/untrusted-hook.cjs",
          },
        },
      });
    runId = run.id;

    assert.equal(vaultReads, 0);
    assert.equal(run.authMode, null);
    assert.equal(run.cost, null);
    assert.deepEqual(run.execution, selectedPlan!.execution);
    assert.match(run.recipeHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(launches.length, 1);
    const launch = launches[0]!;
    assert.doesNotMatch(launch.command, /(?:^|\/)npx$/);
    assert.doesNotMatch(launch.args.join(" "), /@openai\/codex-security/);
    assert.match(launch.args[0] ?? "", /portable-codex-security-worker\.ts$/);
    const configPath = launch.args[1];
    assert.equal(typeof configPath, "string");
    const config = JSON.parse(fs.readFileSync(configPath!, "utf8")) as Record<string, unknown>;
    const text = JSON.stringify({ config, args: launch.args, env: launch.env });
    assert.deepEqual(Object.keys(config).sort(), [
      "limits", "mode", "outputDir", "paths", "providerPlan", "repositoryPath", "sourceRef",
    ]);
    assert.equal(config.mode, "standard");
    assert.deepEqual(config.paths, []);
    assert.equal(fs.statSync(configPath!).mode & 0o077, 0);
    for (const secret of [
      "mimo-api-key-must-not-reach-worker",
      "https://private.mimo.example/v1",
      "custom-token-must-not-reach-worker",
    ]) {
      assert.equal(text.includes(secret), false);
    }
    for (const key of ["MIMO_API_KEY", "MIMO_BASE_URL", "CUSTOM_TOKEN", "NODE_OPTIONS"] as const) {
      assert.equal(launch.env[key], undefined, `${key} must not reach the Portable worker`);
    }
    launch.child.emit("close", 0);
  } finally {
    if (runId !== null) deleteRun(runId);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
