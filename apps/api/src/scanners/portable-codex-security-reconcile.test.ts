import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ScanRun } from "@csb/shared";

import { portableCodexSecurityPricingPath } from "../model-pricing.js";
import { progressForStatus } from "../progress.js";
import {
  refreshPortableCodexSecurityRunFromDisk,
} from "./portable-codex-security-reconcile.js";
import {
  writePortableCodexSecurityRuntime,
  type PortableCodexSecurityRuntimeState,
} from "./portable-codex-security-runtime.js";

const CAPTURED_AT = "2026-08-11T17:00:00.000Z";

function run(scanDir: string): ScanRun {
  return {
    id: "portable-run",
    displayName: "Portable fixture",
    repositoryPath: "/repository",
    revision: null,
    scanDir,
    status: "running",
    model: "mimo-v2.5",
    effort: null,
    mode: "standard",
    engine: "codex-security",
    provider: "xiaomi",
    authMode: null,
    scannerVersion: "sentinel-codex-security-portable-v1",
    recipeHash: "a".repeat(64),
    startedAt: CAPTURED_AT,
    completedAt: null,
    durationMs: null,
    cost: null,
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
    source: "benchmark",
    pid: 91_339,
    execution: {
      executionProfile: "portable",
      profileVersion: "sentinel-codex-security-portable-v1",
      methodologyRef: "sentinel/codex-security-methodology@v1",
      capabilityCheckId: "capability-mimo",
      connectionId: "mimo-connection",
      routeKind: "mimo-token-plan",
      protocol: "openai-chat",
      authKind: "api-key",
    },
  };
}

function runtime(
  patch: Partial<PortableCodexSecurityRuntimeState> = {},
): PortableCodexSecurityRuntimeState {
  return {
    engine: "codex-security",
    executionProfile: "portable",
    profileVersion: "sentinel-codex-security-portable-v1",
    methodologyRef: "sentinel/codex-security-methodology@v1",
    status: "completed",
    stage: "report",
    stageLabel: "Complete",
    percent: 100,
    detail: "1 reportable finding normalized",
    startedAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    completedAt: CAPTURED_AT,
    snapshotId: "content:fixture",
    sourceRef: "sentinel-codex-security-portable-v1",
    findings: 1,
    usage: {
      reported: true,
      inputTokensKnown: true,
      cachedInputTokensKnown: true,
      cacheWriteInputTokensKnown: true,
      outputTokensKnown: true,
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000_000,
    },
    error: null,
    errorCode: null,
    ...patch,
  };
}

function writeFrozenPricing(scanDir: string, pricing: object | null): void {
  fs.writeFileSync(portableCodexSecurityPricingPath(scanDir), JSON.stringify({
    schemaVersion: 1,
    pricing,
  }), { mode: 0o600 });
}

const frozenPricing = {
  currency: "USD",
  capturedAt: CAPTURED_AT,
  modelId: "mimo-v2.5",
  inputUsdPerMillionTokens: 2,
  cachedInputUsdPerMillionTokens: 0.5,
  cacheWriteInputUsdPerMillionTokens: null,
  outputUsdPerMillionTokens: 4,
};

test("reconciles completed Portable runtime from disk with findings, frozen cost, and progress", () => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-reconcile-"));
  try {
    writePortableCodexSecurityRuntime(scanDir, runtime());
    fs.writeFileSync(path.join(scanDir, "findings.json"), JSON.stringify({
      findings: [{ severity: { level: "high" } }],
    }));
    writeFrozenPricing(scanDir, frozenPricing);

    const refreshed = refreshPortableCodexSecurityRunFromDisk(run(scanDir));
    assert.equal(refreshed.status, "completed");
    assert.equal(refreshed.pid, null);
    assert.equal(refreshed.severity.high, 1);
    assert.equal(refreshed.severity.total, 1);
    assert.equal(refreshed.cost?.estimatedUsd, 6);
    assert.equal(refreshed.cost?.cacheWriteInputUsd, undefined);
    assert.deepEqual(refreshed.cost?.pricingSnapshot, {
      currency: "USD",
      capturedAt: CAPTURED_AT,
      inputUsdPerMillionTokens: 2,
      cachedInputUsdPerMillionTokens: 0.5,
      cacheWriteInputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: 4,
    });
    assert.equal(refreshed.progress?.percent, 100);
    assert.deepEqual(refreshed.execution, run(scanDir).execution);
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test("failed Portable runtime keeps valid findings as incomplete and never prices partial or unpriced usage", () => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-reconcile-failure-"));
  try {
    writePortableCodexSecurityRuntime(scanDir, runtime({
      status: "failed",
      completedAt: CAPTURED_AT,
      usage: {
        reported: true,
        inputTokensKnown: true,
        cachedInputTokensKnown: false,
        outputTokensKnown: false,
        inputTokens: 20,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    }));
    fs.writeFileSync(path.join(scanDir, "findings.json"), JSON.stringify({
      findings: [{ severity: { level: "medium" } }],
    }));
    writeFrozenPricing(scanDir, frozenPricing);

    const incomplete = refreshPortableCodexSecurityRunFromDisk(run(scanDir));
    assert.equal(incomplete.status, "incomplete");
    assert.equal(incomplete.cost, null);

    fs.writeFileSync(path.join(scanDir, "findings.json"), JSON.stringify({ findings: [] }));
    writeFrozenPricing(scanDir, null);
    const failed = refreshPortableCodexSecurityRunFromDisk(run(scanDir));
    assert.equal(failed.status, "failed");
    assert.equal(failed.cost, null);
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test("progressForStatus recovers Portable stage telemetry directly from disk after restart", () => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-progress-"));
  try {
    writePortableCodexSecurityRuntime(scanDir, runtime({
      status: "running",
      stage: "validation",
      stageLabel: "Static falsification and calibration",
      percent: 72,
      completedAt: null,
    }));

    const progress = progressForStatus("running", scanDir, "standard", CAPTURED_AT);
    assert.equal(progress?.phase, "validation");
    assert.equal(progress?.percent, 72);
    assert.equal(progress?.itemsTotal, 6);
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});
