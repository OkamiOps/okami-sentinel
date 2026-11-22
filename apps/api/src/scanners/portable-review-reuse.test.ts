import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { ScanRun } from "@csb/shared";
import type { PortableCodexSecurityDossier } from "./portable-codex-security-dossier.js";

const environment = fs.mkdtempSync(path.join(os.tmpdir(), "review-reuse-env-"));
process.env.CSB_DATA_DIR = path.join(environment, "data");
process.env.CODEX_SECURITY_STATE_DIR = path.join(environment, "state");
const { planPortableReviewReuse, restorePortableReviewReuse, writePortableReviewReuse, readPortableReviewReuse,
  sourceReviewCost, reviewReuseSources, REVIEW_REUSE_FILE } = await import("./portable-review-reuse.js");
const { createPortableCodexSecurityDossier, writePortableCodexSecurityDossier } = await import("./portable-codex-security-dossier.js");
const { writePortableCodexSecurityRuntime } = await import("./portable-codex-security-runtime.js");
const { scanAiVerdicts } = await import("./portable-codex-security-verdicts.js");
const { getDb, upsertRun, closeDb } = await import("../db.js");
after(() => { closeDb(); fs.rmSync(environment, { recursive: true, force: true }); });

const anchor = { path: "route.ts", startLine: 2, endLine: 2, role: "sink" as const };
const entry = { path: "route.ts", startLine: 1, endLine: 1, role: "entrypoint" as const };
const sourceText = `function route(req) {\n  return execute(req.query);\n}\n${"unrelated\n".repeat(20)}`;

function fixture(t: test.TestContext, mutate: (d: PortableCodexSecurityDossier) => void = () => {}) {
  const root = fs.mkdtempSync(path.join(environment, "case-"));
  const oldDir = path.join(root, "old");
  const currentDir = path.join(root, "current");
  for (const dir of [oldDir, currentDir]) {
    fs.mkdirSync(path.join(dir, "portable-codex-security-snapshot"), { recursive: true });
    fs.writeFileSync(path.join(dir, "portable-codex-security-snapshot", "route.ts"), sourceText);
  }
  const prior: PortableCodexSecurityDossier = { ...createPortableCodexSecurityDossier(),
    candidates: [{ id: "old-c", category: "injection", anchors: [anchor] }],
    assessments: (["dataflow", "validation"] as const).map(stage => ({
      candidateId: "old-c", stage, status: "confirmed", reason: "untrusted-flow-reaches-sink",
      claim: "Untrusted query reaches execute", evidence: [entry, anchor],
    })) };
  mutate(prior);
  writePortableCodexSecurityDossier(path.join(oldDir, "portable-codex-security-results"), prior);
  const current = { ...createPortableCodexSecurityDossier(), candidates: [{ ...prior.candidates[0]!, id: "new-c" }] };
  const source = { id: "old-scan", scanDir: oldDir, repositoryPath: root, mode: "deep", status: "completed",
    engine: "codex-security", execution: { executionProfile: "portable", profileVersion: "sentinel-codex-security-portable-v1",
      methodologyRef: "sentinel/codex-security-methodology@v1", capabilityCheckId: null, connectionId: null, routeKind: null, protocol: null, authKind: null },
    cost: { estimatedUsd: 6 } } as ScanRun;
  const snapshotRoot = path.join(currentDir, "portable-codex-security-snapshot");
  const plan = () => planPortableReviewReuse(current, snapshotRoot, [source]);
  return { root, oldDir, currentDir, source, prior, current, snapshotRoot, plan };
}

test("unchanged anchors and full citations reuse both assessments, remap ids and expose gated provenance", t => {
  const f = fixture(t);
  const record = f.plan();
  assert.equal(record.totals.reusedCount, 1);
  assert.equal(record.totals.reviewedCount, 0);
  assert.equal(record.totals.estimatedCostAvoidedUsd, 6);
  assert.equal(record.totals.upperBound, true);
  const restored = restorePortableReviewReuse(f.current, f.snapshotRoot, record);
  assert.deepEqual(restored.assessments.map(a => a.candidateId), ["new-c", "new-c"]);
  writePortableReviewReuse(f.currentDir, record);
  assert.equal(fs.statSync(path.join(f.currentDir, REVIEW_REUSE_FILE)).mode & 0o777, 0o600);
  writePortableCodexSecurityDossier(path.join(f.currentDir, "portable-codex-security-results"), restored);
  const response = scanAiVerdicts({ ...f.source, id: "new-scan", scanDir: f.currentDir });
  assert.equal(response.verdicts[0]!.status, "confirmed");
  assert.deepEqual(response.verdicts[0]!.reusedFrom, { scanId: "old-scan", candidateId: "old-c" });
  assert.deepEqual(response.reuse, record.totals);
  assert.throws(() => writePortableReviewReuse(f.currentDir, record), /EEXIST/);
});

for (const [name, text] of [
  ["assessment citation outside candidate anchor", sourceText.replace("function route(req)", "function route(other)")],
  ["candidate anchor", sourceText.replace("execute(req.query)", "execute(allowed)")],
  ["line shift", `// shifted\n${sourceText}`],
  ["line endings", sourceText.replaceAll("\n", "\r\n")],
] as const) test(`changed ${name} forces review`, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.snapshotRoot, "route.ts"), text);
  assert.equal(f.plan().totals.reusedCount, 0);
});

test("changes outside cited ranges do not invalidate reuse; anchor order is a set", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.snapshotRoot, "route.ts"), sourceText.replaceAll("unrelated", "changed"));
  f.current.candidates[0]!.anchors.push({ ...anchor });
  assert.equal(f.plan().totals.reusedCount, 1);
  f.current.candidates[0]!.category = "authorization";
  assert.equal(f.plan().totals.reusedCount, 0);
});

test("full evidence after excerpt limits is compared", t => {
  const f = fixture(t, d => { for (const a of d.assessments) a.evidence.push({ ...anchor, startLine: 4, endLine: 20 }); });
  const lines = sourceText.split("\n");
  lines[18] = "changed beyond display excerpt";
  fs.writeFileSync(path.join(f.snapshotRoot, "route.ts"), lines.join("\n"));
  assert.equal(f.plan().totals.reusedCount, 0);
});

for (const kind of ["inconclusive", "legacy", "downgraded", "dataflow-legacy", "dataflow-downgraded", "insufficient-evidence", "missingEvidence", "missing-stage"] as const) {
  test(`${kind} is not reusable`, t => {
    const f = fixture(t, d => {
      const a = d.assessments[1]!;
      if (kind === "inconclusive") { a.status = "inconclusive"; a.missingEvidence = ["caller"]; }
      if (kind === "legacy") delete a.claim;
      if (kind === "downgraded") a.evidence = [anchor];
      if (kind === "dataflow-legacy") delete d.assessments[0]!.claim;
      if (kind === "dataflow-downgraded") d.assessments[0]!.evidence = [anchor];
      if (kind === "insufficient-evidence") { a.status = "rejected"; a.reason = kind; }
      if (kind === "missingEvidence") { d.assessments[0]!.missingEvidence = ["caller"]; }
      if (kind === "missing-stage") d.assessments.shift();
    });
    assert.equal(f.plan().totals.reusedCount, 0);
  });
}

test("supported rejection is reusable", t => {
  const f = fixture(t, d => { for (const a of d.assessments) { a.status = "rejected"; a.reason = "sanitized"; } });
  assert.equal(f.plan().candidates[0]!.status, "rejected");
});

test("missing files, symlink files/parents and escaping paths are never evidence", t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.snapshotRoot, "route.ts"));
  assert.equal(f.plan().totals.reusedCount, 0);
  fs.symlinkSync(path.join(f.oldDir, "portable-codex-security-snapshot", "route.ts"), path.join(f.snapshotRoot, "route.ts"));
  assert.equal(f.plan().totals.reusedCount, 0);
  f.current.candidates[0]!.anchors = [{ ...anchor, path: "../route.ts" }];
  assert.equal(f.plan().totals.reusedCount, 0);
});

test("persisted reuse survives source deletion and fails closed on changed evidence or corrupt metadata", t => {
  const f = fixture(t);
  const record = f.plan();
  writePortableReviewReuse(f.currentDir, record);
  fs.rmSync(f.oldDir, { recursive: true });
  const saved = readPortableReviewReuse(f.currentDir)!;
  assert.equal(restorePortableReviewReuse(f.current, f.snapshotRoot, saved).assessments.length, 2);
  fs.writeFileSync(path.join(f.snapshotRoot, "route.ts"), "changed\n");
  assert.throws(() => restorePortableReviewReuse(f.current, f.snapshotRoot, saved), /review_reuse_invalid/);
  fs.writeFileSync(path.join(f.currentDir, REVIEW_REUSE_FILE), "{}");
  assert.throws(() => readPortableReviewReuse(f.currentDir), /review_reuse_invalid/);
});

test("empty dossier and missing sources produce an empty bounded record", t => {
  const f = fixture(t);
  assert.deepEqual(planPortableReviewReuse(createPortableCodexSecurityDossier(), f.snapshotRoot, []).totals,
    { reusedCount: 0, reviewedCount: 0, estimatedCostAvoidedUsd: 0, upperBound: false });
  assert.equal(planPortableReviewReuse(f.current, f.snapshotRoot, [{ ...f.source, scanDir: f.root }]).totals.reusedCount, 0);
});

test("stage costs take precedence; legacy cost is upper bound and unknown pricing stays unavailable", t => {
  const f = fixture(t);
  assert.deepEqual(sourceReviewCost(f.source, f.prior), { cost: 6, upperBound: true });
  f.source.cost = null;
  assert.equal(f.plan().totals.estimatedCostAvoidedUsd, null);
  const usage = { reported: true, inputTokens: 10, cachedInputTokens: 0, outputTokens: 3 };
  writePortableCodexSecurityRuntime(f.oldDir, {
    engine: "codex-security", executionProfile: "portable", profileVersion: "sentinel-codex-security-portable-v1",
    methodologyRef: "sentinel/codex-security-methodology@v1", status: "completed", stage: "normalize", stageLabel: "Done", percent: 100,
    detail: null, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", completedAt: "2026-01-01T00:01:00.000Z",
    snapshotId: "content:abc", sourceRef: "abc", findings: 1, usage, error: null, errorCode: null,
    reviewStages: { dataflow: { usage, estimatedCostUsd: 1, upperBound: false }, validation: { usage, estimatedCostUsd: 2, upperBound: false } },
  });
  assert.deepEqual(sourceReviewCost(f.source, f.prior), { cost: 3, upperBound: false });
  assert.equal(f.plan().totals.estimatedCostAvoidedUsd, 3);
  const record = f.plan();
  f.prior.candidates.push({ ...f.prior.candidates[0]!, id: "paid-c" });
  f.prior.assessments.push(...f.prior.assessments.map(a => ({ ...a, candidateId: "paid-c" })));
  assert.equal(sourceReviewCost(f.source, f.prior).cost, 1.5);
  writePortableReviewReuse(f.oldDir, { ...record, totals: { ...record.totals, reviewedCount: 1 }, candidates: record.candidates.map(c => ({
    ...c, candidateId: "old-c", assessments: c.assessments.map(a => ({ ...a, candidateId: "old-c" })),
  })) });
  assert.equal(sourceReviewCost(f.source, f.prior).cost, 3, "source reviews already reused are not charged an allocation of paid stage usage");
});

test("source selection uses repository identity, creation order, status, mode and a five-scan cap", t => {
  const f = fixture(t);
  const ids: string[] = [];
  t.after(() => { for (const id of ids) getDb().prepare("DELETE FROM runs WHERE id = ?").run(id); });
  for (let index = 0; index < 9; index++) {
    const id = `source-${index}`;
    ids.push(id);
    upsertRun({ ...f.source, id, displayName: id, severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
      source: "workbench", mode: index === 8 ? "standard" : "deep", status: index === 7 ? "failed" : "completed" });
    getDb().prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(`2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, id);
  }
  const deep = reviewReuseSources("current", f.root, f.currentDir, "deep", "2026-02-01T00:00:00.000Z");
  assert.deepEqual(deep.map(s => s.id), ["source-6", "source-5", "source-4", "source-3", "source-2"]);
  assert.equal(reviewReuseSources("current", f.root, f.currentDir, "standard", "2026-02-01T00:00:00.000Z")[0]!.id, "source-8");
  assert.equal(reviewReuseSources("current", "/other/project", f.currentDir, "deep", "2026-02-01T00:00:00.000Z").length, 0);
  assert.deepEqual(reviewReuseSources("current", f.root, f.currentDir, "deep", "2026-01-03T00:00:00.000Z").map(s => s.id), ["source-1", "source-0"]);
  getDb().prepare("UPDATE runs SET status = 'incomplete' WHERE id = 'source-6'").run();
  assert.equal(reviewReuseSources("current", f.root, f.currentDir, "deep", "2026-02-01T00:00:00.000Z")[0]!.id, "source-5");
  writePortableCodexSecurityRuntime(f.oldDir, {
    engine: "codex-security", executionProfile: "portable", profileVersion: "sentinel-codex-security-portable-v1",
    methodologyRef: "sentinel/codex-security-methodology@v1", status: "incomplete", stage: "validation", stageLabel: "validation", percent: 80,
    detail: null, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", completedAt: null, findings: 0,
    snapshotId: "content:old", sourceRef: "old", error: null, errorCode: null,
    usage: { reported: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    budgetPartial: { stopReason: "budget", spentUsd: 1, maxCostUsd: 1, completed: [],
      interrupted: { stage: "validation", page: null, artifactPath: null }, pending: [{ stage: "validation", page: null, artifactPath: null }] },
  });
  assert.equal(reviewReuseSources("current", f.root, f.currentDir, "deep", "2026-02-01T00:00:00.000Z")[0]!.id, "source-6");
  fs.renameSync(path.join(f.oldDir, "portable-codex-security-results"), path.join(f.oldDir, "retired-results"));
  assert.equal(reviewReuseSources("current", f.root, f.currentDir, "deep", "2026-02-01T00:00:00.000Z").length, 0);
});
