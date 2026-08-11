import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ScanRun } from "@csb/shared";

import { deleteRun, getRun, upsertRun } from "./db.js";
import { reconcileRunningScans, refreshRunFromDisk } from "./ingest.js";
import { writePortableCodexSecurityPricing } from "./model-pricing.js";
import { withProgress } from "./progress.js";
import {
  writePortableCodexSecurityRuntime,
  type PortableCodexSecurityRuntimeState,
} from "./scanners/portable-codex-security-runtime.js";

const STARTED_AT = "2026-08-11T18:00:00.000Z";

function portableRun(id: string, scanDir: string): ScanRun {
  return {
    id,
    displayName: "Portable recovery fixture",
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
    startedAt: STARTED_AT,
    completedAt: null,
    durationMs: null,
    cost: null,
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
    source: "benchmark",
    pid: null,
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
    launchSelection: {
      modelSelectionMode: "catalog",
      modelId: "mimo-v2.5",
      paths: ["src/auth"],
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
    detail: "portable recovery complete",
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT,
    completedAt: STARTED_AT,
    snapshotId: "content:portable-recovery",
    sourceRef: "sentinel-codex-security-portable-v1",
    findings: 1,
    usage: {
      reported: true,
      inputTokensKnown: true,
      cachedInputTokensKnown: true,
      cacheWriteInputTokensKnown: true,
      outputTokensKnown: true,
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 500,
    },
    error: null,
    errorCode: null,
    ...patch,
  };
}

function writeRecoveryArtifacts(scanDir: string, state: PortableCodexSecurityRuntimeState): void {
  writePortableCodexSecurityRuntime(scanDir, state);
  fs.writeFileSync(path.join(scanDir, "findings.json"), JSON.stringify({
    findings: [{ severity: { level: "high" } }],
  }), { mode: 0o600 });
  writePortableCodexSecurityPricing(scanDir, {
    inputUsdPerMillionTokens: 2,
    cachedInputUsdPerMillionTokens: 0.5,
    cacheWriteInputUsdPerMillionTokens: null,
    outputUsdPerMillionTokens: 4,
  }, STARTED_AT, "mimo-v2.5");
}

test("refreshRunFromDisk restores completed Portable stage, findings, frozen cost, and retry selection", () => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-ingest-refresh-"));
  const id = `portable-refresh-${Date.now()}-${Math.random()}`;
  try {
    writeRecoveryArtifacts(scanDir, runtime());
    upsertRun(portableRun(id, scanDir));

    const refreshed = refreshRunFromDisk(id);
    assert.equal(refreshed?.status, "completed");
    assert.equal(refreshed?.progress?.phase, "reporting");
    assert.equal(refreshed?.severity.high, 1);
    assert.equal(refreshed?.cost?.estimatedUsd, 0.004);
    assert.deepEqual(refreshed?.launchSelection, {
      modelSelectionMode: "catalog",
      modelId: "mimo-v2.5",
      paths: ["src/auth"],
    });
    assert.deepEqual(getRun(id)?.launchSelection, refreshed?.launchSelection);
  } finally {
    deleteRun(id);
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test("startup reconciliation preserves Portable failed-stage evidence as incomplete", () => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-ingest-reconcile-"));
  const id = `portable-reconcile-${Date.now()}-${Math.random()}`;
  try {
    writeRecoveryArtifacts(scanDir, runtime({
      status: "failed",
      stage: "validation",
      stageLabel: "Static falsification and calibration",
      percent: 72,
      completedAt: STARTED_AT,
      error: "agent_session_failed",
    }));
    upsertRun(portableRun(id, scanDir));

    reconcileRunningScans();
    const restored = getRun(id);
    assert.equal(restored?.status, "incomplete");
    assert.equal(restored && withProgress(restored).progress?.phase, "validation");
    assert.equal(restored?.severity.high, 1);
    assert.equal(restored?.cost?.estimatedUsd, 0.004);
    assert.deepEqual(restored?.launchSelection, {
      modelSelectionMode: "catalog",
      modelId: "mimo-v2.5",
      paths: ["src/auth"],
    });
  } finally {
    deleteRun(id);
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});
