import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScanRun } from "@csb/shared";
import { appendCliLog, cliLogPath } from "./activity.js";
import { scanAnalysisMetrics } from "./scan-analysis-metrics.js";

test("analysis metrics count immutable scope, complete batches and unique rejected writes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-metrics-"));
  const snapshot = path.join(root, "portable-codex-security-snapshot");
  const artifact = path.join(root, "portable-codex-security-artifacts", "discovery-001");
  fs.mkdirSync(snapshot); fs.mkdirSync(artifact, { recursive: true });
  fs.writeFileSync(path.join(snapshot, "index.ts"), "one\ntwo\n");
  fs.writeFileSync(path.join(snapshot, "empty.ts"), "");
  fs.writeFileSync(path.join(artifact, "03-discovery.json"), JSON.stringify({ stage: "discovery", candidates: [{ id: "one" }] }));
  fs.mkdirSync(path.join(root, "portable-codex-security-artifacts", "discovery-002"));
  t.after(() => { fs.rmSync(root, { recursive: true }); fs.rmSync(cliLogPath(root), { force: true }); });
  const event = { type: "tool", name: "results.write", phase: "result", callId: "one", ok: false };
  for (const value of [event, event, { ...event, phase: "consumed" }, { ...event, callId: "read", name: "workspace.read" }, { type: "usage", usage: { reasoningTokens: 7 } }]) appendCliLog(root, `[stdout] ${JSON.stringify(value)}`);
  const scan = { scanDir: root, engine: "codex-security", mode: "deep", execution: { executionProfile: "portable" }, startedAt: new Date(0).toISOString(), completedAt: new Date(10_000).toISOString(), usage: { outputTokens: 100 } } as ScanRun;
  const metrics = scanAnalysisMetrics(scan, 20_000);
  assert.equal(metrics.files, 2); assert.equal(metrics.lines, 2); assert.equal(metrics.bytes, 8);
  assert.equal(metrics.batchesCompleted, 1); assert.equal(metrics.batchesTotal, 1);
  assert.equal(metrics.candidates, 1); assert.equal(metrics.rejections, 1); assert.equal(metrics.reasoningTokens, 7);
  assert.equal(metrics.outputTokensPerSecond, 10);
});

test("missing legacy evidence is unavailable instead of zero", () => {
  const metrics = scanAnalysisMetrics({ scanDir: path.join(os.tmpdir(), 'missing-metrics-' + Date.now()), startedAt: new Date().toISOString() } as ScanRun);
  assert.equal(metrics.files, null); assert.equal(metrics.batchesTotal, null);
  assert.equal(metrics.candidates, null); assert.equal(metrics.rejections, null); assert.equal(metrics.reasoningTokens, null);
});
