import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScanRun } from "@csb/shared";

test("closing a scan enriches the launch record without creating an official-id record", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-run-identity-"));
  const scanDir = path.join(fixtureRoot, "scan");
  const manifestPath = path.join(scanDir, "scan-manifest.json");
  fs.mkdirSync(scanDir);
  fs.writeFileSync(manifestPath, JSON.stringify({ scan: { id: "official-id" } }));

  try {
    const runner = (await import("./runner.js")) as Record<string, unknown>;
    const refreshAfterClose = runner.refreshAfterClose as
      | ((
          outputDir: string,
          fallback: ScanRun,
          dependencies: {
            readOfficialRun: (id: string) => ScanRun | null;
            refreshByScanDir: (outputDir: string, fallbackId: string) => ScanRun | null;
          },
        ) => ScanRun)
      | undefined;

    assert.equal(typeof refreshAfterClose, "function");

    const fallback: ScanRun = {
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
      recipeHash: null,
      startedAt: "2026-08-08T00:00:00.000Z",
      completedAt: null,
      durationMs: null,
      cost: null,
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
    };
    const official: ScanRun = {
      ...fallback,
      id: "official-id",
      status: "completed",
      completedAt: "2026-08-08T00:05:00.000Z",
      durationMs: 300_000,
      cost: {
        estimatedUsd: 35.18,
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
      },
      severity: {
        critical: 1,
        high: 15,
        medium: 12,
        low: 8,
        info: 2,
        unknown: 0,
        total: 38,
      },
      source: "workbench",
      pid: null,
    };
    const officialReads: string[] = [];
    let directoryRefreshes = 0;

    const refreshed = refreshAfterClose!(scanDir, fallback, {
      readOfficialRun(id) {
        officialReads.push(id);
        return official;
      },
      refreshByScanDir() {
        directoryRefreshes += 1;
        return null;
      },
    });

    assert.deepEqual(officialReads, ["official-id"]);
    assert.equal(directoryRefreshes, 0);
    assert.equal(refreshed.id, "launch-id");
    assert.equal(refreshed.source, "benchmark");
    assert.equal(refreshed.cost?.estimatedUsd, 35.18);
    assert.equal(refreshed.severity.total, 38);
  } finally {
    fs.unlinkSync(manifestPath);
    fs.rmdirSync(scanDir);
    fs.rmdirSync(fixtureRoot);
  }
});
