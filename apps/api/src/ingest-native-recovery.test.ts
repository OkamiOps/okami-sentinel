import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ScanRun } from "@csb/shared";

import { deleteRun, getRun, upsertRun } from "./db.js";
import { reconcileRunningScans } from "./ingest.js";

function nativeBenchmarkRun(id: string, scanDir: string, startedAt: string): ScanRun {
  return {
    id,
    displayName: "native recovery fixture",
    repositoryPath: "/repository",
    revision: null,
    scanDir,
    status: "running",
    model: "gpt-5.6-sol",
    effort: "high",
    mode: "standard",
    engine: "codex-security",
    provider: "openai",
    authMode: "chatgpt",
    scannerVersion: null,
    recipeHash: null,
    startedAt,
    completedAt: null,
    durationMs: null,
    cost: {
      estimatedUsd: 0.31,
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 20,
      model: "gpt-5.6-sol",
    },
    severity: { critical: 0, high: 1, medium: 0, low: 0, info: 0, unknown: 0, total: 1 },
    source: "benchmark",
    pid: 99_991,
    execution: null,
  };
}

test("native benchmark recovery closes a stale run without workbench artifacts and preserves persisted evidence", () => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-recovery-stale-"));
  const id = `native-stale-${randomUUID()}`;
  try {
    // A partial write must not erase evidence already persisted in SQLite.
    fs.writeFileSync(path.join(scanDir, "findings.json"), "{not-json");
    upsertRun(nativeBenchmarkRun(id, scanDir, "2026-08-10T10:00:00.000Z"));
    const persistedCost = getRun(id)?.cost;

    reconcileRunningScans();

    const restored = getRun(id);
    assert.equal(restored?.status, "incomplete");
    assert.deepEqual(restored?.severity, {
      critical: 0, high: 1, medium: 0, low: 0, info: 0, unknown: 0, total: 1,
    });
    assert.deepEqual(restored?.cost, persistedCost);
    assert.equal(restored?.pid, null);
  } finally {
    deleteRun(id);
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test("native benchmark recovery keeps a missing-runtime scan running during bootstrap grace", () => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-recovery-grace-"));
  const id = `native-grace-${randomUUID()}`;
  try {
    upsertRun(nativeBenchmarkRun(id, scanDir, new Date().toISOString()));

    reconcileRunningScans();

    assert.equal(getRun(id)?.status, "running");
  } finally {
    deleteRun(id);
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});
