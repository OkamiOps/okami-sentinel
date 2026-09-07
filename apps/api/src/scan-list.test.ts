import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import type { ScanRun } from "@csb/shared";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-scan-list-"));
process.env.CSB_DATA_DIR = path.join(root, "data");
process.env.CODEX_SECURITY_STATE_DIR = path.join(root, "state");
const { getDb, upsertRun, hideRun } = await import("./db.js");
const { listActiveRuns, listRunPage, parseScanListOptions } = await import("./scan-list.js");
const { app } = await import("./app.js");
after(() => { getDb().close(); fs.rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { getDb().exec("DELETE FROM runs; DELETE FROM hidden_runs"); });

function fixture(id: string, changes: Partial<ScanRun> = {}): ScanRun {
  return {
    id, displayName: `Scan ${id}`, scanDir: path.join(root, id), repositoryPath: "/repo",
    revision: "main", status: "completed", engine: "codex-security", model: "test-model",
    effort: "high", mode: "standard", provider: "test", authMode: "api-key",
    scannerVersion: null, recipeHash: null, startedAt: "2026-09-07T10:00:00Z",
    completedAt: "2026-09-07T10:01:00Z", durationMs: 60_000, pid: null,
    source: "benchmark", cost: null, execution: null,
    severity: { critical: 0, high: 1, medium: 0, low: 0, info: 0, unknown: 0, total: 1 },
    ...changes,
  };
}

test("scan pagination validates bounds and preserves the legacy no-query contract", () => {
  assert.equal(parseScanListOptions({}), null);
  assert.deepEqual(parseScanListOptions({ status: "active" }), { limit: 25, offset: 0, status: "active", query: "" });
  const invalid: Array<Record<string, string>> = [{ limit: "0" }, { limit: "101" }, { offset: "-1" }, { offset: "1.5" }, { status: "oops" }, { limit: "NaN" }];
  for (const query of invalid) {
    assert.throws(() => parseScanListOptions(query));
  }
});

test("ledger pagination keeps stable pages, global filtered totals, and hidden rows out", () => {
  for (let i = 0; i < 31; i++) upsertRun(fixture(`record-${String(i).padStart(2, "0")}`, {
    cost: { estimatedUsd: 2, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1 },
  }));
  upsertRun(fixture("archived", { status: "failed" }));
  upsertRun(fixture("hidden")); hideRun("hidden");
  const first = listRunPage({ limit: 25, offset: 0, status: "active", query: "" });
  const next = listRunPage({ limit: 25, offset: 25, status: "active", query: "" });
  assert.equal(first.scans.length, 25);
  assert.equal(next.scans.length, 6);
  assert.equal(new Set([...first.scans, ...next.scans].map((run) => run.id)).size, 31);
  assert.equal(first.total, 31);
  assert.deepEqual(first.summary, { evidence: 31, costUsd: 62, costIsUpperBound: false, archivedCount: 1 });
  assert.deepEqual(next.summary, first.summary);
  assert.equal(listRunPage({ limit: 25, offset: 100, status: "active", query: "" }).offset, 25);
});

test("ledger search is literal and case-insensitive, including accented names", () => {
  upsertRun(fixture("match", { displayName: "AÇÃO 100%_'" }));
  upsertRun(fixture("other", { displayName: "other", status: "failed" }));
  assert.deepEqual(listRunPage({ limit: 25, offset: 0, status: "all", query: "ação 100%_'" }).scans.map((run) => run.id), ["match"]);
  assert.equal(listRunPage({ limit: 25, offset: 0, status: "all", query: "' OR 1=1 --" }).total, 0);
});

test("ledger summaries preserve unavailable and upper-bound prices across pages", () => {
  upsertRun(fixture("local", { engine: "mantis", authMode: "existing-session", cost: { estimatedUsd: 99, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 } }));
  assert.equal(listRunPage({ limit: 1, offset: 0, status: "all", query: "" }).summary.costUsd, null);
  upsertRun(fixture("priced", { cost: { estimatedUsd: 3, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, estimateKind: "upper-bound" } }));
  const page = listRunPage({ limit: 1, offset: 1, status: "all", query: "" });
  assert.equal(page.summary.costUsd, 3);
  assert.equal(page.summary.costIsUpperBound, true);
});

test("active endpoint returns only active visible scans with a large terminal history", async () => {
  getDb().transaction(() => {
    for (let i = 0; i < 1000; i++) upsertRun(fixture(`history-${i}`));
    upsertRun(fixture("live", { status: "running", startedAt: new Date().toISOString() }));
    upsertRun(fixture("queued", { status: "queued", startedAt: new Date().toISOString() }));
    upsertRun(fixture("hidden-live", { status: "running" })); hideRun("hidden-live");
  })();
  assert.deepEqual(listActiveRuns().map((run) => run.id).sort(), ["live", "queued"]);
  const response = await app.request("/scans/active");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).scans.map((run: ScanRun) => run.id).sort(), ["live", "queued"]);
  assert.equal((await app.request("/scans?limit=101")).status, 400);
});

test("scan catalog returns distinct visible filter names without loading full history", async () => {
  getDb().transaction(() => {
    for (let index = 0; index < 1000; index++) {
      upsertRun(fixture(`history-${index}`, { displayName: `Repository ${index % 10}`, scanDir: path.join(root, "absent-artifacts", String(index)) }));
    }
    upsertRun(fixture("hidden", { displayName: "Hidden repository" }));
    hideRun("hidden");
    upsertRun(fixture("accented", { displayName: "Ação 100%_'" }));
    upsertRun(fixture("empty", { displayName: "" }));
  })();
  const response = await app.request("/scans/catalog");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { total: 1002, repositories: ["Ação 100%_'", ...Array.from({ length: 10 }, (_, index) => `Repository ${index}`)] });
  assert.ok(JSON.stringify(body).length < 500, "The filter payload must not grow with repeated scans");
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM runs WHERE status = 'completed'").get() as { count: number }).count, 1003);
});
