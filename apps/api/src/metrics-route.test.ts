import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScanRun } from "@csb/shared";

test("repeated dashboard requests do not reopen terminal scan artifacts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-metrics-route-"));
  process.env.CSB_DATA_DIR = path.join(root, "data");
  process.env.CODEX_SECURITY_STATE_DIR = path.join(root, "state");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  const { getDb, upsertRun } = await import("./db.js");
  const { app } = await import("./app.js");
  t.after(() => { getDb().close(); fs.rmSync(root, { recursive: true, force: true }); });
  const scanDir = path.join(root, "terminal");
  fs.mkdirSync(scanDir);
  fs.writeFileSync(path.join(scanDir, "findings.json"), JSON.stringify({ findings: [{ findingId: "finding", title: "Fixture", severity: "high", category: "Validation" }] }));
  upsertRun({
    id: "terminal", displayName: "Metrics fixture", repositoryPath: "/fixture", revision: "main", scanDir,
    status: "completed", engine: "codex-security", model: "fixture", effort: "high", mode: "standard",
    provider: "fixture", authMode: null, scannerVersion: null, recipeHash: null, source: "benchmark", pid: null, execution: null,
    startedAt: "2026-09-07T10:00:00Z", completedAt: "2026-09-07T10:01:00Z", durationMs: 60000, cost: null,
    severity: { critical: 0, high: 1, medium: 0, low: 0, info: 0, unknown: 0, total: 1 },
  } satisfies ScanRun);
  assert.equal((await app.request("/metrics/summary")).status, 200);
  const exists = fs.existsSync;
  const readFile = fs.readFileSync;
  const inspected: string[] = [];
  t.mock.method(fs, "existsSync", (file: fs.PathLike) => {
    if (String(file).startsWith(scanDir)) inspected.push(String(file));
    return exists(file);
  });
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).startsWith(scanDir)) inspected.push(String(args[0]));
    return readFile(...args);
  });
  for (let index = 0; index < 3; index++) {
    const response = await app.request("/metrics/summary");
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.totalScans, 1);
    assert.equal(body.severity.high, 1);
  }
  assert.deepEqual(inspected, []);
});
