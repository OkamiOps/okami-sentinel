import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import type { ScanRun } from "@csb/shared";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-server-recovery-"));
process.env.CSB_DATA_DIR = path.join(root, "data");
process.env.CODEX_SECURITY_STATE_DIR = path.join(root, "state");

const { closeDb, getRun, upsertRun } = await import("./db.js");
const { interruptActiveRunsAfterServerRestart, refreshRunFromDisk } = await import("./ingest.js");
const { writeMantisRuntime } = await import("./scanners/mantis-runtime.js");

after(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeMantisSidecar(
  scanDir: string,
  startedAt: string,
  completedAt: string | null,
  status: "running" | "completed" = "running",
): void {
  writeMantisRuntime(scanDir, {
    engine: "mantis",
    status,
    stage: status === "completed" ? "report" : "researcher",
    stageLabel: status === "completed" ? "Complete" : "Research",
    percent: status === "completed" ? 100 : 31,
    detail: "container worker sidecar",
    startedAt,
    updatedAt: completedAt ?? startedAt,
    completedAt,
    snapshotId: null,
    sourceRef: "sentinel-mantis-http",
    findings: 0,
    usage: {
      reported: false,
      inputTokensKnown: false,
      cachedInputTokensKnown: false,
      cacheWriteInputTokensKnown: false,
      outputTokensKnown: false,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
    },
    error: null,
  });
}

test("server restart seals a running sidecar and preserves a completed sidecar", () => {
  const scanDir = path.join(root, "mantis-hard-kill");
  const completedAt = new Date().toISOString();
  const startedAt = new Date(Date.parse(completedAt) - 10_000).toISOString();
  const run: ScanRun = {
    id: "mantis-hard-kill",
    displayName: "Mantis hard kill",
    repositoryPath: "/repos/project",
    revision: null,
    scanDir,
    status: "running",
    model: "gpt-5.6-sol",
    effort: "high",
    mode: "standard",
    engine: "mantis",
    provider: "openai",
    authMode: "api-key",
    scannerVersion: "sentinel-mantis-http",
    recipeHash: "a".repeat(64),
    startedAt,
    completedAt: null,
    durationMs: null,
    cost: null,
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
    source: "benchmark",
    pid: 17,
    execution: null,
    progress: {
      percent: 31,
      phase: "discovery",
      phaseLabel: "Research",
      detail: "old container worker",
      unit: "stages",
      itemsCompleted: 2,
      itemsTotal: 9,
    },
  };
  writeMantisSidecar(scanDir, startedAt, null);
  upsertRun(run);

  assert.equal(interruptActiveRunsAfterServerRestart(new Date(completedAt)), 1);
  const restored = getRun(run.id);
  assert.equal(restored?.status, "incomplete");
  assert.equal(restored?.completedAt, completedAt);
  assert.equal(restored?.durationMs, 10_000);
  assert.equal(restored?.pid, null);
  assert.equal(restored?.progress ?? null, null);

  for (let i = 0; i < 2; i++) {
    const reread = refreshRunFromDisk(run.id);
    assert.equal(reread?.status, "incomplete");
    assert.equal(reread?.completedAt, completedAt);
    assert.equal(reread?.durationMs, 10_000);
    assert.equal(reread?.progress ?? null, null);
  }

  const completeDir = path.join(root, "mantis-completed-before-kill");
  const completeId = "mantis-completed-before-kill";
  const completedSidecarAt = new Date(Date.parse(completedAt) + 1_000).toISOString();
  writeMantisSidecar(completeDir, startedAt, completedSidecarAt, "completed");
  upsertRun({ ...run, id: completeId, scanDir: completeDir, progress: null });

  assert.equal(interruptActiveRunsAfterServerRestart(new Date(completedSidecarAt)), 1);
  for (let i = 0; i < 2; i++) {
    const reread = refreshRunFromDisk(completeId);
    assert.equal(reread?.status, "completed");
    assert.equal(reread?.completedAt, completedSidecarAt);
    assert.equal(reread?.durationMs, 11_000);
  }
});
