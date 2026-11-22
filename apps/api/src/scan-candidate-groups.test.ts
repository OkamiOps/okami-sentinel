import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { ScanRun } from "@csb/shared";
const environmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-groups-env-"));
process.env.CSB_DATA_DIR = path.join(environmentRoot, "data");
process.env.CODEX_SECURITY_STATE_DIR = path.join(environmentRoot, "state");
const { scanCandidateGroups } = await import("./scan-candidate-groups.js");
const { applyPortableCandidateGrouping, writePortableCandidateGrouping } = await import("./scanners/portable-codex-security-candidate-groups.js");
const { createPortableCodexSecurityDossier, writePortableCodexSecurityDossier } = await import("./scanners/portable-codex-security-dossier.js");
after(() => fs.rmSync(environmentRoot, { recursive: true, force: true }));

function candidate(id: string, category = "authorization") {
  return {
    id, category, hypothesis: `Pass ${id} found a missing tenant check.`, attacker: "authenticated" as const,
    controlHypothesis: "The tenant check is missing.",
    anchors: [{ path: "src/orders.ts", startLine: 12, endLine: 14, role: "control" as const }],
  };
}

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-groups-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scan = { id: "grouped", scanDir: root, status: "completed", engine: "codex-security", execution: { executionProfile: "portable", profileVersion: "fixture-v1", methodologyRef: "fixture@v1" } } as ScanRun;
  const discovered = { ...createPortableCodexSecurityDossier(), candidates: [candidate("a"), candidate("b"), candidate("c", "injection")] };
  const { dossier, grouping } = applyPortableCandidateGrouping(discovered);
  return { root, scan, dossier, grouping };
}

test("groups expose members and share the representative's decisive verdict", t => {
  const { root, scan, dossier, grouping } = setup(t);
  const resultsDir = path.join(root, "portable-codex-security-results");
  writePortableCandidateGrouping(resultsDir, grouping);
  writePortableCodexSecurityDossier(resultsDir, { ...dossier, assessments: [
    { candidateId: "a", stage: "dataflow", status: "confirmed", reason: "control-not-present", evidence: [{ path: "src/orders.ts", startLine: 12, endLine: 14, role: "control" as const }] },
    { candidateId: "a", stage: "validation", status: "rejected", reason: "not-vulnerable", evidence: [{ path: "src/orders.ts", startLine: 12, endLine: 14, role: "control" as const }] },
    { candidateId: "c", stage: "validation", status: "confirmed", reason: "untrusted-flow-reaches-sink", evidence: [{ path: "src/orders.ts", startLine: 12, endLine: 14, role: "control" as const }] },
  ] });
  const value = scanCandidateGroups(scan);
  assert.equal(value.recorded, true);
  assert.equal(value.candidates, 3);
  assert.equal(value.reviewed, 2);
  assert.deepEqual(value.groups.map(group => [group.representativeId, group.memberIds, group.verdict]), [
    ["a", ["a", "b"], { status: "inconclusive", stage: "validation", reason: "not-vulnerable" }],
  ]);
  assert.deepEqual(value.groups[0]!.members[1], { id: "b", category: "authorization", hypothesis: "Pass b found a missing tenant check.", anchors: [{ path: "src/orders.ts", startLine: 12, endLine: 14, role: "control" }] });
});

test("a group shares its representative's cited verdict as decided", t => {
  const { root, scan, dossier, grouping } = setup(t);
  const resultsDir = path.join(root, "portable-codex-security-results");
  const snapshotFile = path.join(root, "portable-codex-security-snapshot", "src", "orders.ts");
  fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
  fs.writeFileSync(snapshotFile, Array.from({ length: 20 }, (_, line) => `const line${line + 1} = ${line + 1};`).join("\n"));
  writePortableCandidateGrouping(resultsDir, grouping);
  writePortableCodexSecurityDossier(resultsDir, { ...dossier, assessments: [
    { candidateId: "a", stage: "validation", status: "rejected", reason: "not-vulnerable", claim: "The tenant check on these lines scopes every order read.", evidence: [{ path: "src/orders.ts", startLine: 12, endLine: 14, role: "control" as const }] },
  ] });
  assert.deepEqual(scanCandidateGroups(scan).groups.map(group => group.verdict), [{ status: "rejected", stage: "validation", reason: "not-vulnerable" }]);
});

test("a running scan shows recorded groups as pending before AI review finishes", t => {
  const { root, scan, grouping } = setup(t);
  writePortableCandidateGrouping(path.join(root, "portable-codex-security-artifacts"), grouping);
  const value = scanCandidateGroups({ ...scan, status: "running" });
  assert.equal(value.recorded, true);
  assert.equal(value.reviewed, null);
  assert.deepEqual(value.groups.map(group => group.verdict.status), ["pending"]);
});

test("scans that predate grouping, other engines and tampered files report no grouping", t => {
  const { root, scan, dossier } = setup(t);
  const resultsDir = path.join(root, "portable-codex-security-results");
  writePortableCodexSecurityDossier(resultsDir, dossier);
  const legacy = { scanId: "grouped", recorded: false, rule: null, candidates: null, reviewed: null, groups: [] };
  assert.deepEqual(scanCandidateGroups(scan), legacy);
  assert.deepEqual(scanCandidateGroups({ ...scan, engine: "mantis" }), legacy);
  assert.deepEqual(scanCandidateGroups({ ...scan, scanDir: path.join(root, "missing") }), legacy);
  fs.writeFileSync(path.join(resultsDir, "portable-codex-security-candidate-groups.json"), JSON.stringify({ schemaVersion: 1, rule: "same-category-attacker-primary-anchor-v1", groups: [{ representativeId: "a", memberIds: ["b", "a"], members: [] }] }));
  assert.deepEqual(scanCandidateGroups(scan), legacy);
});

test("candidate groups endpoint answers for known scans and 404 for unknown scans", async t => {
  const { root, scan } = setup(t);
  const { getDb, upsertRun } = await import("./db.js");
  const { app } = await import("./app.js");
  t.after(() => getDb().close());
  upsertRun({
    ...scan, displayName: "Groups fixture", repositoryPath: root,
    revision: "fixture", model: "fixture", effort: "high", mode: "deep", provider: "fixture",
    authMode: "api-key", scannerVersion: null, recipeHash: null,
    startedAt: "2026-09-11T00:00:00Z", completedAt: "2026-09-11T00:01:00Z", durationMs: 60_000,
    pid: null, source: "benchmark", cost: null,
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
  });
  const response = await app.request("/scans/grouped/candidate-groups");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).recorded, false);
  assert.equal((await app.request("/scans/missing/candidate-groups")).status, 404);
});
