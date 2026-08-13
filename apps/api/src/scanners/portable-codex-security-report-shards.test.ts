import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  PortableCodexSecurityDossier,
} from "./portable-codex-security-dossier.js";
import {
  PORTABLE_CODEX_SECURITY_REPORT_SHARD_MAX_CANDIDATES,
  assemblePortableCodexSecurityReportShards,
  createPortableCodexSecurityReportShards,
  writePortableCodexSecurityReportShards,
  type PortableCodexSecurityReportShardArtifact,
} from "./portable-codex-security-report-shards.js";
import { validatePortableCodexSecurityReportCoverage } from "./portable-codex-security-dossier.js";

const anchor = {
  path: "src/routes/search.ts",
  startLine: 1,
  endLine: 1,
  role: "sink" as const,
};

function dossierWith65ConfirmedAnd2Rejected(): PortableCodexSecurityDossier {
  const candidates = Array.from({ length: 67 }, (_, index) => ({
    id: `candidate-${String(index + 1).padStart(3, "0")}`,
    category: "injection",
    anchors: [anchor],
  }));
  return {
    schemaVersion: 1,
    stageSummaries: [],
    candidates,
    assessments: candidates.map((candidate, index) => ({
      candidateId: candidate.id,
      stage: "validation" as const,
      status: index < 65 ? "confirmed" as const : "rejected" as const,
      reason: index < 65 ? "untrusted-flow-reaches-sink" : "not-vulnerable",
      evidence: [anchor],
    })),
    scope: {
      inspected: ["src/routes/search.ts"],
      unexamined: [{ path: "generated", reason: "out-of-scope" }],
    },
  };
}

function validShardReport(
  shard: ReturnType<typeof createPortableCodexSecurityReportShards>[number],
): PortableCodexSecurityReportShardArtifact {
  return {
    schemaVersion: 1,
    stage: "report",
    findings: shard.dossier.candidates.map((candidate, index) => ({
      // Every independent page deliberately restarts this local sequence.
      id: `PCS-${String(index + 1).padStart(3, "0")}`,
      candidateId: candidate.id,
      title: "Untrusted search value reaches a sensitive query sink",
      severity: "high" as const,
      confidence: "high" as const,
      category: candidate.category,
      summary: "The request-controlled search value reaches the query construction path without an effective control.",
      rootCause: "The query construction path accepts the request value without binding it to a safe parameterized operation.",
      impact: "An attacker could alter the intended query behavior and access data outside the expected result set.",
      remediation: "Use parameterized query construction and reject request values that are not valid for the intended search operation.",
      anchors: [{ ...anchor, explanation: "The pinned sink accepts the request-controlled value in the query construction path." }],
    })),
  };
}

test("Portable report shards retain every confirmed candidate and assemble deterministic full coverage", () => {
  const dossier = dossierWith65ConfirmedAnd2Rejected();

  const shards = createPortableCodexSecurityReportShards(dossier);

  assert.equal(shards.length, 5);
  assert.ok(shards.every((shard) => shard.dossier.candidates.length <= PORTABLE_CODEX_SECURITY_REPORT_SHARD_MAX_CANDIDATES));
  assert.deepEqual(
    shards.flatMap((shard) => shard.dossier.candidates.map((candidate) => candidate.id)),
    dossier.candidates.slice(0, 65).map((candidate) => candidate.id),
  );
  const report = assemblePortableCodexSecurityReportShards(
    dossier,
    shards.map((shard) => ({ shard, report: validShardReport(shard) })),
  );

  assert.equal(report.findings.length, 65);
  assert.equal(new Set(report.findings.map((finding) => finding.id)).size, 65);
  assert.equal(report.findings.some((finding) => finding.id === "PCS-001"), false);
  assert.equal(report.coverage.candidates.length, 67);
  assert.deepEqual(report.coverage.inspected, dossier.scope.inspected);
  assert.deepEqual(
    report.coverage.candidates.slice(-2).map((coverage) => ({
      id: coverage.candidateId,
      disposition: coverage.disposition,
      reason: coverage.reason,
    })),
    [
      { id: "candidate-066", disposition: "rejected", reason: "not-vulnerable" },
      { id: "candidate-067", disposition: "rejected", reason: "not-vulnerable" },
    ],
  );
  assert.doesNotThrow(() => validatePortableCodexSecurityReportCoverage(report, dossier));
});

test("Portable report assembly derives a verified zero report when every candidate was rejected", () => {
  const dossier = dossierWith65ConfirmedAnd2Rejected();
  dossier.assessments = dossier.assessments.map((assessment) => ({
    ...assessment,
    status: "rejected" as const,
    reason: "not-vulnerable",
  }));

  const shards = createPortableCodexSecurityReportShards(dossier);
  assert.equal(shards.length, 1);
  assert.deepEqual(shards[0]!.candidateIds, []);

  const report = assemblePortableCodexSecurityReportShards(dossier, [{
    shard: shards[0]!,
    report: { schemaVersion: 1, stage: "report", findings: [] },
  }]);
  assert.deepEqual(report.findings, []);
  assert.equal(report.coverage.candidates.length, 67);
  assert.ok(report.coverage.candidates.every((entry) => entry.disposition === "rejected"));
});

test("Portable report shards fail closed instead of exceeding the 16-candidate page bound", () => {
  const dossier = dossierWith65ConfirmedAnd2Rejected();

  assert.throws(
    () => createPortableCodexSecurityReportShards(dossier, { maxShards: 4 }),
    /bounded shard execution budget/i,
  );
});

test("Portable report shard assembly never writes a final report when one page is invalid", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-report-shards-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dossier = dossierWith65ConfirmedAnd2Rejected();
  const shards = createPortableCodexSecurityReportShards(dossier);
  const pages = shards.map((shard) => ({ shard, report: validShardReport(shard) }));
  pages[0] = {
    ...pages[0]!,
    report: {
      ...pages[0]!.report,
      findings: [],
    },
  };

  assert.throws(
    () => writePortableCodexSecurityReportShards(root, dossier, pages),
    /reported coverage is missing its finding/i,
  );
  assert.equal(fs.existsSync(path.join(root, "sentinel-findings.json")), false);
});

test("Portable report shard assembly writes exactly one mode-0600 final report", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-report-shards-final-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dossier = dossierWith65ConfirmedAnd2Rejected();
  const shards = createPortableCodexSecurityReportShards(dossier);

  const report = writePortableCodexSecurityReportShards(
    root,
    dossier,
    shards.map((shard) => ({ shard, report: validShardReport(shard) })),
  );

  assert.equal(report.findings.length, 65);
  assert.deepEqual(fs.readdirSync(root), ["sentinel-findings.json"]);
  assert.equal(fs.statSync(path.join(root, "sentinel-findings.json")).mode & 0o777, 0o600);
});
