import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { ScanRun } from "@csb/shared";

const environmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-verdicts-env-"));
process.env.CSB_DATA_DIR = path.join(environmentRoot, "data");
process.env.CODEX_SECURITY_STATE_DIR = path.join(environmentRoot, "state");
const { scanAiVerdicts, gatePortableCodexSecurityVerdicts } = await import("./portable-codex-security-verdicts.js");
const {
  applyPortableCodexSecurityStageArtifact, createPortableCodexSecurityDossier, readPortableCodexSecurityDossier,
  writePortableCodexSecurityDossier,
} = await import("./portable-codex-security-dossier.js");
type Dossier = ReturnType<typeof createPortableCodexSecurityDossier>;
after(() => fs.rmSync(environmentRoot, { recursive: true, force: true }));

const ROUTE = [
  "import { db } from './db';",
  "export function handler(req) {",
  "  const id = req.query.id;",
  "  return db.raw(`select * from users where id = ${id}`);",
  "}",
].join("\n") + "\n";

const candidate = {
  id: "sqli-1", category: "injection", hypothesis: "Query parameter reaches a raw SQL string",
  anchors: [{ path: "src/route.ts", startLine: 3, endLine: 4, role: "sink" as const }],
};

function setup(t: test.TestContext, assessments: Dossier["assessments"]) {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-verdicts-"));
  t.after(() => fs.rmSync(scanDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(scanDir, "portable-codex-security-snapshot", "src"), { recursive: true });
  fs.writeFileSync(path.join(scanDir, "portable-codex-security-snapshot", "src", "route.ts"), ROUTE);
  const dossier: Dossier = { ...createPortableCodexSecurityDossier(), candidates: [candidate], assessments };
  writePortableCodexSecurityDossier(path.join(scanDir, "portable-codex-security-results"), dossier);
  const scan = { id: "scan-1", scanDir, status: "completed", engine: "codex-security",
    execution: { executionProfile: "portable", profileVersion: "fixture-v1", methodologyRef: "fixture@v1" } } as ScanRun;
  return { scan, scanDir, dossier };
}

const entry = { path: "src/route.ts", startLine: 2, endLine: 3, role: "entrypoint" as const, explanation: "Untrusted query id" };
const sink = { path: "src/route.ts", startLine: 4, endLine: 4, role: "sink" as const, explanation: "Interpolated into raw SQL" };

test("cited confirmation from entry to sink stays confirmed with snapshot excerpts", t => {
  const { scan } = setup(t, [{ candidateId: "sqli-1", stage: "validation", status: "confirmed", reason: "untrusted-flow-reaches-sink",
    evidence: [entry, sink], claim: "req.query.id flows unescaped into db.raw on line 4" }]);
  const result = scanAiVerdicts(scan);
  assert.equal(result.available, true);
  assert.deepEqual(result.counts, { confirmed: 1, rejected: 0, inconclusive: 0, downgraded: 0, legacy: 0 });
  const [verdict] = result.verdicts;
  assert.equal(verdict!.status, "confirmed");
  assert.equal(verdict!.claim, "req.query.id flows unescaped into db.raw on line 4");
  assert.deepEqual(verdict!.missingEvidence, []);
  assert.deepEqual(verdict!.citations.map(c => [c.valid, c.excerpt]), [
    [true, "export function handler(req) {\n  const id = req.query.id;"],
    [true, "  return db.raw(`select * from users where id = ${id}`);"],
  ]);
});

test("cited rejection stays rejected", t => {
  const { scan } = setup(t, [{ candidateId: "sqli-1", stage: "validation", status: "rejected", reason: "not-reachable",
    evidence: [{ path: "src/route.ts", startLine: 1, endLine: 1, role: "evidence" }], claim: "Handler is never registered" }]);
  assert.equal(scanAiVerdicts(scan).verdicts[0]!.status, "rejected");
});

test("citation to a nonexistent file or line range is downgraded to inconclusive with what is missing", t => {
  const { scan } = setup(t, [{ candidateId: "sqli-1", stage: "validation", status: "confirmed", reason: "untrusted-flow-reaches-sink",
    evidence: [entry, { ...sink, startLine: 40, endLine: 42 }, { path: "src/ghost.ts", startLine: 1, endLine: 2, role: "evidence" }],
    claim: "Input reaches the sink" }]);
  const result = scanAiVerdicts(scan);
  const [verdict] = result.verdicts;
  assert.equal(verdict!.status, "inconclusive");
  assert.equal(verdict!.proposedStatus, "confirmed");
  assert.equal(verdict!.downgraded, true);
  assert.deepEqual(verdict!.citations.map(c => c.problem ?? "ok"), ["ok", "lines-out-of-range", "file-missing"]);
  assert.deepEqual(verdict!.missingEvidence, [
    { code: "citation-invalid", detail: "src/route.ts:40-42" },
    { code: "citation-invalid", detail: "src/ghost.ts:1-2" },
    { code: "sink-missing" },
  ]);
  assert.deepEqual(result.counts, { confirmed: 0, rejected: 0, inconclusive: 1, downgraded: 1, legacy: 0 });
});

test("confirmation without an entry citation, path escape or claim is inconclusive", t => {
  const { dossier, scanDir } = setup(t, []);
  const gated = gatePortableCodexSecurityVerdicts({ ...dossier, assessments: [{ candidateId: "sqli-1", stage: "validation", status: "confirmed",
    reason: "untrusted-flow-reaches-sink", evidence: [sink, { path: "../outside.ts", startLine: 1, endLine: 1, role: "source" }] }] },
  path.join(scanDir, "portable-codex-security-snapshot"));
  const [verdict] = gated.verdicts;
  assert.equal(verdict!.status, "inconclusive");
  assert.deepEqual(verdict!.citations.map(c => c.problem ?? "ok"), ["ok", "unsafe-path"]);
  assert.deepEqual(verdict!.missingEvidence.map(m => m.code), ["claim-missing", "citation-invalid", "entry-missing"]);
});

test("legacy assessments without a claim are reported as inconclusive and flagged, without mutating the stored dossier", t => {
  const { scan, scanDir } = setup(t, [{ candidateId: "sqli-1", stage: "validation", status: "rejected", reason: "sanitized",
    evidence: [{ path: "src/route.ts", startLine: 4, endLine: 4, role: "control" }] }]);
  const dossierFile = path.join(scanDir, "portable-codex-security-results", "portable-codex-security-dossier.json");
  const before = fs.readFileSync(dossierFile, "utf8");
  const result = scanAiVerdicts(scan);
  assert.deepEqual(result.verdicts[0]!.missingEvidence, [{ code: "claim-missing" }]);
  assert.equal(result.verdicts[0]!.legacy, true);
  assert.equal(result.verdicts[0]!.proposedStatus, "rejected");
  assert.deepEqual(result.counts, { confirmed: 0, rejected: 0, inconclusive: 1, downgraded: 1, legacy: 1 });
  assert.equal(fs.readFileSync(dossierFile, "utf8"), before);
});

test("AI inconclusive verdicts carry their declared missing evidence; undeclared gaps are explicit", t => {
  const declared = setup(t, [{ candidateId: "sqli-1", stage: "dataflow", status: "inconclusive", reason: "insufficient-evidence",
    evidence: [sink], missingEvidence: ["Caller registration for handler"] }]);
  assert.deepEqual(scanAiVerdicts(declared.scan).verdicts[0]!.missingEvidence, [{ code: "ai-declared", detail: "Caller registration for handler" }]);
  const undeclared = gatePortableCodexSecurityVerdicts({ ...declared.dossier, assessments: [
    { candidateId: "sqli-1", stage: "dataflow", status: "inconclusive", reason: "insufficient-evidence", evidence: [sink] }] }, undefined);
  assert.equal(undeclared.snapshotAvailable, false);
  assert.deepEqual(undeclared.verdicts[0]!.missingEvidence, [{ code: "ai-undeclared" }]);
});

test("missing snapshot or assessment never yields a confirmed verdict", t => {
  const { scan, scanDir } = setup(t, [{ candidateId: "sqli-1", stage: "validation", status: "confirmed", reason: "untrusted-flow-reaches-sink",
    evidence: [entry, sink], claim: "flow" }]);
  fs.rmSync(path.join(scanDir, "portable-codex-security-snapshot"), { recursive: true });
  const result = scanAiVerdicts(scan);
  assert.equal(result.snapshotAvailable, false);
  assert.deepEqual(result.verdicts[0]!.missingEvidence, [{ code: "snapshot-unavailable" }]);
  const none = gatePortableCodexSecurityVerdicts({ ...createPortableCodexSecurityDossier(), candidates: [candidate] }, undefined);
  assert.deepEqual(none.verdicts[0]!.missingEvidence, [{ code: "assessment-missing" }]);
});

test("validation artifacts round-trip claim and missingEvidence through the dossier", t => {
  const { scanDir, dossier } = setup(t, []);
  const next = applyPortableCodexSecurityStageArtifact(dossier, { schemaVersion: 1, stage: "validation", summary: "Validated", observations: [],
    assessments: [{ candidateId: "sqli-1", status: "confirmed", reason: "untrusted-flow-reaches-sink", evidence: [entry, sink], claim: "flow" }] });
  const results = path.join(scanDir, "round-trip");
  writePortableCodexSecurityDossier(results, next);
  assert.equal(readPortableCodexSecurityDossier(results)!.assessments[0]!.claim, "flow");
  assert.throws(() => applyPortableCodexSecurityStageArtifact(dossier, { schemaVersion: 1, stage: "validation", summary: "Validated", observations: [],
    assessments: [{ candidateId: "sqli-1", status: "confirmed", reason: "untrusted-flow-reaches-sink", evidence: [entry, sink], claim: 7 }] }));
});

test("verdicts route exposes the gated verdicts and 404s unknown scans", async t => {
  const { scan, scanDir } = setup(t, [{ candidateId: "sqli-1", stage: "validation", status: "confirmed", reason: "untrusted-flow-reaches-sink",
    evidence: [entry, sink], claim: "flow" }]);
  const { getDb, upsertRun } = await import("../db.js");
  const { app } = await import("../app.js");
  t.after(() => getDb().close());
  upsertRun({
    ...scan, displayName: "Verdict fixture", repositoryPath: scanDir,
    revision: "fixture", model: "fixture", effort: "high", mode: "deep", provider: "fixture",
    authMode: "api-key", scannerVersion: null, recipeHash: null,
    startedAt: "2026-09-11T00:00:00Z", completedAt: "2026-09-11T00:01:00Z", durationMs: 60_000,
    pid: null, source: "benchmark", cost: null,
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
  });
  const response = await app.request("/scans/scan-1/verdicts");
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.available, true);
  assert.equal(value.verdicts[0].status, "confirmed");
  assert.equal((await app.request("/scans/missing/verdicts")).status, 404);
});
