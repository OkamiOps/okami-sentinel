import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { ScanRun } from "@csb/shared";
const environmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-preview-env-"));
process.env.CSB_DATA_DIR = path.join(environmentRoot, "data");
process.env.CODEX_SECURITY_STATE_DIR = path.join(environmentRoot, "state");
const { scanCandidatePreview } = await import("./scan-candidate-preview.js");
after(() => fs.rmSync(environmentRoot, { recursive: true, force: true }));

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-preview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scan = { id: "current", scanDir: root, status: "running", engine: "codex-security", execution: { executionProfile: "portable", profileVersion: "fixture-v1", methodologyRef: "fixture@v1" } } as ScanRun;
  const artifactRoot = path.join(root, "portable-codex-security-artifacts");
  const write = (dir: string, candidates = [candidate("one")]) => {
    const target = path.join(artifactRoot, dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "03-discovery.json"), JSON.stringify({ schemaVersion: 1, stage: "discovery", summary: "Discovery complete", observations: [], candidates }));
    return path.join(target, "03-discovery.json");
  };
  return { root, artifactRoot, scan, write };
}
function candidate(id: string) {
  return { id, category: "authorization", hypothesis: "A caller may read another tenant's record", prerequisites: "An authenticated caller can choose the requested record", expectedImpact: "A protected record from another tenant may be disclosed", anchors: [{ path: "src/route.ts", startLine: 12, endLine: 14, role: "sink", explanation: "Record is loaded using a supplied identifier" }] };
}

test("preview reads accepted current-scan discoveries, deduplicates IDs and refreshes new batches without mutating findings", t => {
  const { scan, root, write } = setup(t);
  const findings = path.join(root, "sentinel-findings.json");
  fs.writeFileSync(findings, '{"findings":[]}');
  write("discovery-001");
  write("validation", [candidate("not-discovery")]);
  assert.deepEqual(scanCandidatePreview(scan, 0), { scanId: "current", measuredAt: new Date(0).toISOString(), provisional: true, candidates: [{ id: "one", category: "authorization", hypothesis: "A caller may read another tenant's record", prerequisites: "An authenticated caller can choose the requested record", expectedImpact: "A protected record from another tenant may be disclosed", anchors: [{ path: "src/route.ts", line: 12, explanation: "Record is loaded using a supplied identifier" }] }] });
  write("discovery-002", [candidate("one"), candidate("two")]);
  write("discovery-review", [candidate("three")]);
  assert.deepEqual(scanCandidatePreview(scan).candidates.map(c => c.id), ["one", "two", "three"]);
  assert.equal(fs.readFileSync(findings, "utf8"), '{"findings":[]}');
  assert.equal(scanCandidatePreview({ ...scan, status: "failed" }).candidates.length, 3);
  assert.equal(scanCandidatePreview({ ...scan, status: "completed" }).candidates.length, 0);
  assert.equal(scanCandidatePreview({ ...scan, scanDir: path.join(root, "other") }).candidates.length, 0);
  assert.equal(scanCandidatePreview({ ...scan, execution: null }).candidates.length, 0);
});

test("preview tolerates missing, malformed, oversized and unaccepted artifacts", t => {
  const { scan, write } = setup(t);
  assert.equal(scanCandidatePreview(scan).candidates.length, 0);
  write("discovery-001");
  fs.writeFileSync(write("discovery-002"), '{"schemaVersion":');
  fs.writeFileSync(write("discovery-003"), " ".repeat(4 * 1024 * 1024 + 1));
  fs.writeFileSync(write("discovery-004"), JSON.stringify({ stage: "discovery", candidates: [candidate("invalid-envelope")] }));
  fs.writeFileSync(write("discovery-005"), JSON.stringify({ schemaVersion: 1, stage: "discovery", summary: "bad", observations: [], candidates: [{ ...candidate("invalid-anchor"), anchors: [{ path: "../secret", startLine: 1, endLine: 1, role: "sink" }] }] }));
  assert.deepEqual(scanCandidatePreview(scan).candidates.map(c => c.id), ["one"]);
});

test("preview refuses symlinked artifact roots, batch directories and files", t => {
  const { scan, root, artifactRoot, write } = setup(t);
  const source = write("discovery-001");
  const other = path.join(root, "other");
  fs.mkdirSync(other);
  fs.copyFileSync(source, path.join(other, "03-discovery.json"));
  fs.symlinkSync(other, path.join(artifactRoot, "discovery-002"));
  const linked = write("discovery-003");
  fs.unlinkSync(linked);
  fs.symlinkSync(source, linked);
  fs.unlinkSync(source);
  assert.equal(scanCandidatePreview(scan).candidates.length, 0);
  fs.renameSync(artifactRoot, path.join(root, "saved-artifacts"));
  fs.symlinkSync(path.join(root, "saved-artifacts"), artifactRoot);
  assert.equal(scanCandidatePreview(scan).candidates.length, 0);
});

test("candidate preview endpoint returns current provisional evidence and 404 for unknown scans", async t => {
  const { root, write, scan } = setup(t);
  const { getDb, upsertRun } = await import("./db.js");
  const { app } = await import("./app.js");
  t.after(() => getDb().close());
  upsertRun({
    ...scan, status: "failed", displayName: "Preview fixture", repositoryPath: root,
    revision: "fixture", model: "fixture", effort: "high", mode: "deep", provider: "fixture",
    authMode: "api-key", scannerVersion: null, recipeHash: null,
    startedAt: "2026-09-11T00:00:00Z", completedAt: "2026-09-11T00:01:00Z", durationMs: 60_000,
    pid: null, source: "benchmark", cost: null,
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
  });
  write("discovery-001");
  const response = await app.request("/scans/current/candidate-preview");
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.scanId, "current");
  assert.equal(value.provisional, true);
  assert.equal(value.candidates.length, 1);
  assert.equal((await app.request("/scans/missing/candidate-preview")).status, 404);
});
