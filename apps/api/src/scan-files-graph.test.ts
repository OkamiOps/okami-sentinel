import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { ScanRun } from "@csb/shared";
const environmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-files-graph-"));
process.env.CSB_DATA_DIR = path.join(environmentRoot, "data");
process.env.CODEX_SECURITY_STATE_DIR = path.join(environmentRoot, "state");
const { scanFilesGraph } = await import("./scan-files-graph.js");
const { managedGraphCacheKey } = await import("./graphify/managed-graph.js");
after(() => fs.rmSync(environmentRoot, { recursive: true, force: true }));

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(environmentRoot, "scan-"));
  const revision = `content:${"a".repeat(64)}`;
  const snapshot = path.join(root, "portable-codex-security-snapshot");
  fs.mkdirSync(snapshot);
  for (const file of ["a.ts", "b.ts", "isolated.ts"]) fs.writeFileSync(path.join(snapshot, file), "private source content");
  fs.writeFileSync(path.join(snapshot, ".portable-codex-security-snapshot-id"), revision);
  fs.writeFileSync(path.join(root, "graphify-status.json"), JSON.stringify({ status: "ready" }));
  const cache = path.join(process.env.CSB_DATA_DIR!, "graphify-cache");
  fs.mkdirSync(cache, { recursive: true });
  const graphFile = path.join(cache, `${managedGraphCacheKey(revision)}.json`);
  const graph = { nodes: [{ id: "a", source_file: "a.ts" }, { id: "a2", source_file: "a.ts" }, { id: "b", source_file: "b.ts" }, { id: "escape", source_file: "../secret" }], edges: [
    { source: "a", target: "b", confidence: "EXTRACTED" }, { source: "a2", target: "b", confidence: "EXTRACTED" },
    { source: "b", target: "a", confidence: "EXTRACTED" }, { source: "a", target: "a2", confidence: "EXTRACTED" },
    { source: "a", target: "b", confidence: "INFERRED" }, { source: "escape", target: "b", confidence: "EXTRACTED" },
  ] };
  fs.writeFileSync(graphFile, JSON.stringify(graph));
  t.after(() => { if (fs.existsSync(graphFile)) fs.unlinkSync(graphFile); });
  const scan = { id: path.basename(root), scanDir: root, revision, engine: "codex-security", execution: { executionProfile: "portable", profileVersion: "fixture-v1", methodologyRef: "fixture@v1" }, repositoryPath: "/never-read-live-checkout" } as ScanRun;
  return { scan, root, snapshot, graphFile };
}

test("file graph aggregates only extracted cross-file edges and includes isolated immutable files", t => {
  const { scan } = setup(t);
  const result = scanFilesGraph(scan);
  assert.deepEqual(result, { status: "ready", snapshot: scan.revision, files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "isolated.ts" }], edges: [{ source: "a.ts", target: "b.ts", count: 2 }, { source: "b.ts", target: "a.ts", count: 1 }] });
  assert.equal(JSON.stringify(result).includes("private source content"), false);
});

test("missing, malformed and oversized artifacts stay unavailable without generating graphs", t => {
  const { scan, graphFile } = setup(t);
  fs.writeFileSync(graphFile, "{");
  assert.equal(scanFilesGraph(scan).status, "unavailable");
  fs.writeFileSync(graphFile, " ".repeat(32 * 1024 * 1024 + 1));
  assert.equal(scanFilesGraph(scan).status, "unavailable");
  fs.unlinkSync(graphFile);
  assert.equal(scanFilesGraph(scan).status, "unavailable");
  assert.equal(fs.existsSync(graphFile), false);
  assert.equal(scanFilesGraph({ ...scan, engine: "mantis" }).reason, "unsupported_scan");
});

test("refuses mismatched snapshot identity and symlinked graph or snapshot", t => {
  const { scan, root, graphFile, snapshot } = setup(t);
  const marker = path.join(snapshot, ".portable-codex-security-snapshot-id");
  fs.writeFileSync(marker, "another-snapshot");
  assert.equal(scanFilesGraph(scan).reason, "snapshot_mismatch");
  fs.writeFileSync(marker, scan.revision!);
  const saved = path.join(root, "saved-graph.json");
  fs.renameSync(graphFile, saved); fs.symlinkSync(saved, graphFile);
  assert.equal(scanFilesGraph(scan).status, "unavailable");
  fs.unlinkSync(graphFile); fs.renameSync(saved, graphFile);
  const savedSnapshot = path.join(root, "saved-snapshot");
  fs.renameSync(snapshot, savedSnapshot); fs.symlinkSync(savedSnapshot, snapshot);
  assert.equal(scanFilesGraph(scan).status, "unavailable");
});

test("files graph endpoint returns pinned references and 404 for unknown scans", async t => {
  const { scan, root } = setup(t);
  const { getDb, upsertRun } = await import("./db.js");
  const { app } = await import("./app.js");
  t.after(() => getDb().close());
  upsertRun({ ...scan, status: "failed", displayName: "Files fixture", repositoryPath: root,
    model: "fixture", effort: "high", mode: "deep", provider: "fixture", authMode: "api-key", scannerVersion: null, recipeHash: null,
    startedAt: "2026-09-11T00:00:00Z", completedAt: "2026-09-11T00:01:00Z", durationMs: 60_000,
    pid: null, source: "benchmark", cost: null, severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
  });
  const response = await app.request(`/scans/${scan.id}/files-graph`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).files.length, 3);
  assert.equal((await app.request("/scans/missing/files-graph")).status, 404);
});
