import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ScanRun } from "@csb/shared";

test("scan APIs merge SAST evidence, retain origin, filter findings and expose status", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-sast-api-"));
  const keys = ["CSB_DATA_DIR", "CODEX_SECURITY_STATE_DIR"] as const;
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  process.env.CSB_DATA_DIR = path.join(root, "data");
  process.env.CODEX_SECURITY_STATE_DIR = path.join(root, "state");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  const { getDb, upsertRun } = await import("../db.js");
  const { app } = await import("../app.js");
  const { runOpengrep } = await import("./opengrep.js");
  t.after(() => { getDb().close(); fs.rmSync(root, { recursive: true, force: true }); });
  const scanDir = path.join(root, "scan");
  fs.mkdirSync(scanDir);
  const rules = path.join(root, "rules.json");
  fs.writeFileSync(rules, "{}");
  await runOpengrep(scanDir, scanDir, {
    enabled: true, binary: fileURLToPath(new URL("./fixtures/fake-opengrep.mjs", import.meta.url)), rules: [rules], timeoutMs: 5000,
  });
  fs.writeFileSync(path.join(scanDir, "findings.json"), JSON.stringify({ findings: [{ findingId: "ai-one", title: "AI evidence", severity: "high" }] }));
  upsertRun({
    id: "sast-scan", displayName: "SAST fixture", repositoryPath: "/fixture", revision: "main", scanDir,
    status: "incomplete", engine: "codex-security", model: "fixture", effort: "high", mode: "standard",
    provider: "fixture", authMode: null, scannerVersion: null, recipeHash: null, source: "benchmark", pid: null, execution: null,
    startedAt: "2026-09-07T10:00:00Z", completedAt: "2026-09-07T10:01:00Z", durationMs: 60000, cost: null,
    severity: { critical: 0, high: 1, medium: 0, low: 0, info: 0, unknown: 0, total: 1 },
  } satisfies ScanRun);
  const get = async (url: string) => {
    const response = await app.request(url);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const scan = await get("/scans/sast-scan");
  assert.equal(scan.scan.sast.status, "completed");
  assert.equal(scan.scan.sast.count, 1);
  assert.deepEqual(scan.findings.map((finding: { origin: { kind: string } }) => finding.origin.kind), ["ai", "sast"]);
  assert.equal((await get("/scans/sast-scan/findings")).total, 2);
  const sast = await get("/scans/sast-scan/findings?origin=sast");
  assert.equal(sast.total, 1);
  assert.equal((await get("/scans/sast-scan/findings?origin=ai")).total, 1);
  assert.equal((await get("/scans/sast-scan/findings?origin=sast&severity=low")).total, 0);
  assert.equal((await get(`/scans/sast-scan/findings/${sast.findings[0].findingId}`)).finding.origin.tool, "opengrep");
  assert.equal((await get("/scans/sast-scan/regression")).findings.length, 2);
  const report = await get("/scans/sast-scan/report");
  assert.equal(report.findings.length, 2);
  assert.equal(report.scan.sast.count, 1);
  assert.equal((await app.request("/scans/sast-scan/findings/missing")).status, 404);
});
