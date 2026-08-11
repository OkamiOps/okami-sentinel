import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ScanRun } from "@csb/shared";

import { app } from "./app.js";
import { deleteRun, getRun, upsertRun } from "./db.js";
import { reconcileRunningScans, refreshRunFromDisk } from "./ingest.js";
import {
  writePortableCodexSecurityPricing,
  writeScannerPricingQuote,
} from "./model-pricing.js";
import { refreshOpenRouterPricing } from "./openrouter-pricing.js";
import { withProgress } from "./progress.js";
import { resolveScannerPricingQuote } from "./provider-pricing.js";
import {
  writeMantisRuntime,
  type MantisRuntimeState,
} from "./scanners/mantis-runtime.js";
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

function mantisRun(id: string, scanDir: string): ScanRun {
  return {
    ...portableRun(id, scanDir),
    displayName: "Mantis recovery fixture",
    status: "completed",
    model: "MiniMax-M3",
    engine: "mantis",
    provider: "minimax",
    authMode: "api-key",
    scannerVersion: "sentinel-mantis-http",
    execution: null,
    connection: {
      connectionId: "minimax-connection",
      routeKind: "minimax-token-plan",
      protocol: "anthropic-messages",
      authKind: "api-key",
      capabilityCheckId: null,
    },
    launchSelection: {
      modelSelectionMode: "catalog",
      modelId: "MiniMax-M3",
      paths: [],
    },
  };
}

function writeMantisRecoveryArtifacts(scanDir: string): void {
  const state: MantisRuntimeState = {
    engine: "mantis",
    status: "completed",
    stage: "report",
    stageLabel: "Complete",
    percent: 100,
    detail: "12 reportable findings normalized",
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT,
    completedAt: STARTED_AT,
    snapshotId: "content:mantis-recovery",
    sourceRef: "sentinel-mantis-http",
    findings: 1,
    usage: {
      reported: true,
      inputTokensKnown: true,
      cachedInputTokensKnown: false,
      cacheWriteInputTokensKnown: false,
      outputTokensKnown: true,
      maximumInputTokensPerRequest: 64_706,
      inputTokens: 1_899_206,
      cachedInputTokens: 1_212_800,
      cacheWriteInputTokens: 0,
      outputTokens: 24_962,
    },
    error: null,
  };
  writeMantisRuntime(scanDir, state);
  fs.writeFileSync(path.join(scanDir, "findings.json"), JSON.stringify({
    findings: [{ severity: "high" }],
  }), { mode: 0o600 });
  writeScannerPricingQuote(scanDir, resolveScannerPricingQuote({
    connectionId: "minimax-connection",
    providerKind: "minimax",
    routeKind: "minimax-token-plan",
    protocol: "anthropic-messages",
    modelId: "MiniMax-M3",
    modelPricing: null,
    capturedAt: STARTED_AT,
  }));
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

test("scan routes rehydrate terminal Portable cost before returning every read surface", async () => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-route-refresh-"));
  const id = `portable-route-refresh-${Date.now()}-${Math.random()}`;
  try {
    writeRecoveryArtifacts(scanDir, runtime());
    upsertRun(portableRun(id, scanDir));
    await refreshOpenRouterPricing(
      async () => new Response(JSON.stringify({
        data: [{
          id: "openai/test",
          pricing: { prompt: "0.000001", completion: "0.000002" },
        }],
      }), { status: 200 }),
      Date.now(),
    );

    const detailResponse = await app.request(`/scans/${id}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { scan: ScanRun };
    assert.equal(detail.scan.status, "completed");
    assert.equal(detail.scan.cost?.estimatedUsd, 0.004);

    const ledgerResponse = await app.request("/scans");
    assert.equal(ledgerResponse.status, 200);
    const ledger = await ledgerResponse.json() as { scans: ScanRun[] };
    assert.equal(ledger.scans.find((scan) => scan.id === id)?.cost?.estimatedUsd, 0.004);

    const metricsResponse = await app.request("/metrics/summary");
    assert.equal(metricsResponse.status, 200);
    const metrics = await metricsResponse.json() as { recent: ScanRun[] };
    assert.equal(metrics.recent.find((scan) => scan.id === id)?.cost?.estimatedUsd, 0.004);

    upsertRun(portableRun(id, scanDir));
    const reportResponse = await app.request(`/scans/${id}/report`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json() as { scan: ScanRun };
    assert.equal(report.scan.cost?.estimatedUsd, 0.004);

    upsertRun(portableRun(id, scanDir));
    const compareResponse = await app.request("/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanIds: [id, id] }),
    });
    assert.equal(compareResponse.status, 200);
    const comparison = await compareResponse.json() as { scans: ScanRun[] };
    assert.equal(comparison.scans[0]?.cost?.estimatedUsd, 0.004);
  } finally {
    deleteRun(id);
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test("all read surfaces rehydrate terminal Mantis cost through the shared engine dispatcher", async () => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-route-refresh-"));
  const id = `mantis-route-refresh-${Date.now()}-${Math.random()}`;
  try {
    writeMantisRecoveryArtifacts(scanDir);
    upsertRun(mantisRun(id, scanDir));
    await refreshOpenRouterPricing(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      Date.now(),
    );

    const expectedUsd = 0.5997162;
    const detail = await (await app.request(`/scans/${id}`)).json() as { scan: ScanRun };
    assert.equal(detail.scan.cost?.estimatedUsd, expectedUsd);
    assert.equal(detail.scan.cost?.estimateKind, "upper-bound");

    upsertRun(mantisRun(id, scanDir));
    const ledger = await (await app.request("/scans")).json() as { scans: ScanRun[] };
    assert.equal(ledger.scans.find((scan) => scan.id === id)?.cost?.estimatedUsd, expectedUsd);

    upsertRun(mantisRun(id, scanDir));
    const metrics = await (await app.request("/metrics/summary")).json() as { recent: ScanRun[] };
    assert.equal(metrics.recent.find((scan) => scan.id === id)?.cost?.estimatedUsd, expectedUsd);

    upsertRun(mantisRun(id, scanDir));
    const report = await (await app.request(`/scans/${id}/report`)).json() as { scan: ScanRun };
    assert.equal(report.scan.cost?.estimatedUsd, expectedUsd);

    upsertRun(mantisRun(id, scanDir));
    const comparison = await (await app.request("/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanIds: [id, id] }),
    })).json() as { scans: ScanRun[] };
    assert.equal(comparison.scans[0]?.cost?.estimatedUsd, expectedUsd);
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
