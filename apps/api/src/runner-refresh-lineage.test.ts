import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { ScanRun } from "@csb/shared";

// Other test files create and close scans concurrently. This file must observe
// only its own database when refreshing lineage through refreshAfterClose.
const isolatedData = fs.mkdtempSync(path.join(os.tmpdir(), "csb-runner-refresh-lineage-data-"));
process.env.CSB_DATA_DIR = isolatedData;
after(() => fs.rmSync(isolatedData, { recursive: true, force: true }));

type RefreshAfterClose = (
  outputDir: string,
  fallback: ScanRun,
  dependencies: {
    readOfficialRun: (id: string) => ScanRun | null;
    refreshByScanDir: (outputDir: string, fallbackId: string) => ScanRun | null;
  },
) => ScanRun;

function baseFallback(scanDir: string): ScanRun {
  return {
    id: "launch-id",
    displayName: "juice-shop-master",
    repositoryPath: "/repo/juice-shop-master",
    revision: null,
    scanDir,
    status: "running",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    mode: "standard",
    engine: "codex-security",
    provider: "openai",
    authMode: "chatgpt",
    scannerVersion: null,
    recipeHash: "fallback-recipe-hash",
    startedAt: "2026-08-08T00:00:00.000Z",
    completedAt: null,
    durationMs: null,
    cost: {
      estimatedUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      model: "gpt-5.6-sol",
    },
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
    pid: 123,
    execution: {
      executionProfile: "native",
      profileVersion: "standard-v1",
      methodologyRef: "security-change-gate",
      capabilityCheckId: null,
      connectionId: "conn-1",
      routeKind: "claude-code-local",
      protocol: "claude-code-cli",
      authKind: "existing-session",
    },
    connection: {
      connectionId: "conn-1",
      routeKind: "claude-code-local",
      protocol: "claude-code-cli",
      authKind: "existing-session",
      capabilityCheckId: null,
    },
  };
}

test("refreshAfterClose keeps launch execution and connection lineage when merging an official workbench record", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-run-refresh-lineage-"));
  const scanDir = path.join(fixtureRoot, "scan");
  const manifestPath = path.join(scanDir, "scan-manifest.json");
  fs.mkdirSync(scanDir);
  fs.writeFileSync(manifestPath, JSON.stringify({ scan: { id: "official-id" } }));

  try {
    const runner = (await import("./runner.js")) as Record<string, unknown>;
    const refreshAfterClose = runner.refreshAfterClose as RefreshAfterClose | undefined;
    assert.equal(typeof refreshAfterClose, "function");

    const fallback = baseFallback(scanDir);
    // The official workbench record has no notion of the managed launch's
    // execution/connection lineage or mode, mirroring workbenchRowToScanRun.
    const official: ScanRun = {
      ...fallback,
      id: "official-id",
      status: "completed",
      completedAt: "2026-08-08T00:05:00.000Z",
      durationMs: 300_000,
      mode: null,
      source: "workbench",
      pid: null,
      execution: null,
      connection: undefined,
      cost: {
        estimatedUsd: 35.18,
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
      },
    };

    const refreshed = refreshAfterClose!(scanDir, fallback, {
      readOfficialRun: () => official,
      refreshByScanDir: () => null,
    });

    assert.equal(refreshed.id, "launch-id");
    assert.deepEqual(refreshed.execution, fallback.execution);
    assert.deepEqual(refreshed.connection, fallback.connection);
    assert.equal(refreshed.mode, fallback.mode);
    // The official record's actual computed cost stays authoritative.
    assert.deepEqual(refreshed.cost, official.cost);
  } finally {
    fs.unlinkSync(manifestPath);
    fs.rmdirSync(scanDir);
    fs.rmdirSync(fixtureRoot);
  }
});

test("refreshAfterClose keeps launch execution and connection lineage when merging a by-scan-dir record", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-run-refresh-lineage-bydir-"));
  const scanDir = path.join(fixtureRoot, "scan");
  fs.mkdirSync(scanDir);
  // No scan-manifest.json, forcing the by-scan-dir merge branch.

  try {
    const runner = (await import("./runner.js")) as Record<string, unknown>;
    const refreshAfterClose = runner.refreshAfterClose as RefreshAfterClose | undefined;
    assert.equal(typeof refreshAfterClose, "function");

    const fallback = baseFallback(scanDir);
    const byDir: ScanRun = {
      ...fallback,
      status: "completed",
      completedAt: "2026-08-08T00:05:00.000Z",
      durationMs: 300_000,
      execution: null,
      connection: undefined,
    };

    let directoryRefreshes = 0;
    const refreshed = refreshAfterClose!(scanDir, fallback, {
      readOfficialRun: () => null,
      refreshByScanDir: (dir, fallbackId) => {
        directoryRefreshes += 1;
        assert.equal(dir, scanDir);
        assert.equal(fallbackId, fallback.id);
        return byDir;
      },
    });

    assert.equal(directoryRefreshes, 1);
    assert.equal(refreshed.id, "launch-id");
    assert.deepEqual(refreshed.execution, fallback.execution);
    assert.deepEqual(refreshed.connection, fallback.connection);
  } finally {
    fs.rmdirSync(scanDir);
    fs.rmdirSync(fixtureRoot);
  }
});
