import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ScannerCapability } from "@csb/shared";

import { SCANS_ROOT } from "./config.js";
import type { ScanLaunchPlan } from "./connections/launch-plan.js";
import { startScan } from "./runner.js";
import { ScanSelectionError } from "./scanners/scan-selection.js";

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

function invalidPortablePlan(scanId: string): ScanLaunchPlan {
  return {
    engine: "codex-security",
    connectionId: "mimo-connection",
    providerKind: "xiaomi",
    routeKind: "mimo-token-plan",
    runnerKind: "agent-session",
    protocol: "openai-chat",
    model: {
      connectionId: "mimo-connection",
      id: "mimo-v2.5",
      displayName: "MiMo V2.5",
      contextWindow: null,
      capabilities: {
        tools: "supported",
        artifactOutput: "supported",
        structuredOutput: "supported",
        boundedExecution: "supported",
        osIsolation: "supported",
        streaming: "supported",
        usage: "supported",
        cancellation: "supported",
      },
      pricing: null,
      discoveredAt: "2026-08-11T17:00:00.000Z",
      source: "provider-api",
    },
    capabilityCheckId: "probe-mimo",
    execution: {
      executionProfile: "portable",
      profileVersion: "wrong-version",
      methodologyRef: "sentinel/codex-security-methodology@v1",
      capabilityCheckId: "probe-mimo",
      connectionId: "mimo-connection",
      routeKind: "mimo-token-plan",
      protocol: "openai-chat",
      authKind: "api-key",
    },
    snapshot: {
      scanId,
      connectionId: "mimo-connection",
      routeKind: "mimo-token-plan",
      modelSelectionMode: "catalog",
      modelId: "mimo-v2.5",
      capabilityCheckId: "probe-mimo",
      executionProfile: "portable",
      profileVersion: "wrong-version",
      methodologyRef: "sentinel/codex-security-methodology@v1",
      protocol: "openai-chat",
      authKind: "api-key",
      capturedAt: "2026-08-11T17:00:00.000Z",
    },
  };
}

test("an invalid Portable plan creates neither output nor a child process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-invalid-launch-"));
  const repositoryPath = path.join(root, "repository");
  const displayName = `portable-invalid-${randomUUID()}`;
  fs.mkdirSync(repositoryPath);
  let children = 0;
  try {
    await assert.rejects(
      startScan({
        repositoryPath,
        displayName,
        engine: "codex-security",
        executionProfilePreference: "portable",
        connection: {
          connectionId: "mimo-connection",
          modelSelectionMode: "catalog",
          modelId: "mimo-v2.5",
        },
      }, {
        dependencies: {
          validateScannerRequest: async () => scanner,
          providerRuntime: {
            launchPlans: { resolve: ({ scanId }) => invalidPortablePlan(scanId) },
            store: {} as never,
            vault: {} as never,
          },
          spawn: () => {
            children += 1;
            throw new Error("must not spawn");
          },
        },
      }),
      (error: unknown) => error instanceof ScanSelectionError &&
        error.code === "provider_runner_unavailable",
    );
    assert.equal(children, 0);
    assert.equal(fs.existsSync(path.join(SCANS_ROOT, displayName)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
