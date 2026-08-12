import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyPortableCodexSecurityStageArtifact,
  createPortableCodexSecurityDossier,
  validatePortableCodexSecurityReportCoverage,
} from "./portable-codex-security-dossier.js";
import {
  assertPortableCodexSecurityDossierAnchors,
  assertPortableCodexSecurityReportAnchors,
} from "./portable-codex-security-worker-support.js";

const anchor = {
  path: "src/routes/profile.ts",
  startLine: 18,
  endLine: 18,
  role: "sink",
};

test("Portable coverage dossier carries bounded candidates and stage assessments into report validation", () => {
  let dossier = createPortableCodexSecurityDossier();
  dossier = applyPortableCodexSecurityStageArtifact(dossier, {
    schemaVersion: 1,
    stage: "inventory",
    summary: "Inventory complete",
    observations: [],
    scope: { inspected: ["src/routes"], unexamined: [] },
  });
  dossier = applyPortableCodexSecurityStageArtifact(dossier, {
    schemaVersion: 1,
    stage: "discovery",
    summary: "Candidate discovery complete",
    observations: [],
    scope: { inspected: ["src/routes/profile.ts"], unexamined: [] },
    candidates: [{
      id: "candidate-profile-query",
      category: "authorization",
      anchors: [anchor],
    }],
  });
  dossier = applyPortableCodexSecurityStageArtifact(dossier, {
    schemaVersion: 1,
    stage: "dataflow",
    summary: "Trace complete",
    observations: [],
    scope: { inspected: ["src/routes/profile.ts"], unexamined: [] },
    assessments: [{
      candidateId: "candidate-profile-query",
      status: "confirmed",
      reason: "untrusted-flow-reaches-sink",
      evidence: [anchor],
    }],
  });
  dossier = applyPortableCodexSecurityStageArtifact(dossier, {
    schemaVersion: 1,
    stage: "validation",
    summary: "Validation complete",
    observations: [],
    scope: { inspected: ["src/routes/profile.ts"], unexamined: [] },
    assessments: [{
      candidateId: "candidate-profile-query",
      status: "confirmed",
      reason: "control-not-present",
      evidence: [anchor],
    }],
  });

  assert.equal(dossier.candidates.length, 1);
  assert.equal(dossier.assessments.length, 2);
  assert.deepEqual(dossier.stageSummaries, [
    { stage: "inventory", summary: "Inventory complete" },
    { stage: "discovery", summary: "Candidate discovery complete" },
    { stage: "dataflow", summary: "Trace complete" },
    { stage: "validation", summary: "Validation complete" },
  ]);
  assert.deepEqual(dossier.scope.inspected, ["src/routes", "src/routes/profile.ts"]);

  assert.doesNotThrow(() => validatePortableCodexSecurityReportCoverage({
    schemaVersion: 1,
    stage: "report",
    findings: [{
      id: "PCS-001",
      candidateId: "candidate-profile-query",
      title: "Missing ownership check on profile query",
      severity: "high",
      confidence: "high",
      category: "authorization",
      summary: "The profile endpoint accepts an account identifier without checking the caller ownership.",
      rootCause: "The account query is reached without an authorization predicate tied to the caller.",
      impact: "An authenticated caller may retrieve another account profile through a crafted identifier.",
      remediation: "Bind the query to the authenticated account and enforce an ownership check before data access.",
      anchors: [{ ...anchor, explanation: "The account lookup is the unprotected sensitive sink." }],
    }],
    coverage: {
      inspected: ["src/routes", "src/routes/profile.ts"],
      unexamined: [],
      candidates: [{
        candidateId: "candidate-profile-query",
        disposition: "reported",
        reason: "control-not-present",
        evidence: [anchor],
      }],
    },
  }, dossier));
});

test("Portable coverage dossier retains prior stage summaries and accepts only identical duplicate candidates", () => {
  let dossier = createPortableCodexSecurityDossier();
  dossier = applyPortableCodexSecurityStageArtifact(dossier, {
    schemaVersion: 1,
    stage: "inventory",
    summary: "Inventory recorded trust boundaries without copying source text.",
    observations: [],
  });
  dossier = applyPortableCodexSecurityStageArtifact(dossier, {
    schemaVersion: 1,
    stage: "threat-model",
    summary: "Threat model prioritised entrypoints and sensitive data operations.",
    observations: [],
  });
  dossier = applyPortableCodexSecurityStageArtifact(dossier, {
    schemaVersion: 1,
    stage: "discovery",
    summary: "Discovery added one authorization candidate.",
    observations: [],
    candidates: [{ id: "candidate-profile-query", category: "authorization", anchors: [anchor] }],
  });
  dossier = applyPortableCodexSecurityStageArtifact(dossier, {
    schemaVersion: 1,
    stage: "dataflow",
    summary: "Dataflow received the carried candidate and found no new ids.",
    observations: [],
    candidates: [{ id: "candidate-profile-query", category: "authorization", anchors: [anchor] }],
  });

  assert.deepEqual(dossier.stageSummaries.slice(0, 2), [
    { stage: "inventory", summary: "Inventory recorded trust boundaries without copying source text." },
    { stage: "threat-model", summary: "Threat model prioritised entrypoints and sensitive data operations." },
  ]);
  assert.equal(dossier.candidates.length, 1);
  assert.throws(
    () => applyPortableCodexSecurityStageArtifact(dossier, {
      schemaVersion: 1,
      stage: "validation",
      summary: "Validation attempted a conflicting candidate id.",
      observations: [],
      candidates: [{ id: "candidate-profile-query", category: "injection", anchors: [anchor] }],
    }),
    /candidate id conflicts/i,
  );
});

test("Portable report rejects a verified-zero claim when a carried candidate is not explicitly rejected", () => {
  let dossier = createPortableCodexSecurityDossier();
  dossier = applyPortableCodexSecurityStageArtifact(dossier, {
    schemaVersion: 1,
    stage: "discovery",
    summary: "Candidate discovery complete",
    observations: [],
    scope: { inspected: ["src/routes/profile.ts"], unexamined: [] },
    candidates: [{ id: "candidate-profile-query", category: "authorization", anchors: [anchor] }],
  });

  assert.throws(
    () => validatePortableCodexSecurityReportCoverage({
      schemaVersion: 1,
      stage: "report",
      findings: [],
      coverage: {
        inspected: ["src/routes/profile.ts"],
        unexamined: [],
        candidates: [],
      },
    }, dossier),
    /candidate coverage is incomplete/i,
  );
});

test("Portable report cannot erase a candidate confirmed by the validation stage", () => {
  let dossier = createPortableCodexSecurityDossier();
  dossier = applyPortableCodexSecurityStageArtifact(dossier, {
    schemaVersion: 1,
    stage: "discovery",
    summary: "Candidate discovery recorded one repository-backed authorization target.",
    observations: [],
    scope: { inspected: ["src/routes/profile.ts"], unexamined: [] },
    candidates: [{ id: "candidate-profile-query", category: "authorization", anchors: [anchor] }],
  });
  dossier = applyPortableCodexSecurityStageArtifact(dossier, {
    schemaVersion: 1,
    stage: "validation",
    summary: "Validation confirmed the missing authorization control.",
    observations: [],
    assessments: [{
      candidateId: "candidate-profile-query",
      status: "confirmed",
      reason: "control-not-present",
      evidence: [anchor],
    }],
  });

  assert.throws(
    () => validatePortableCodexSecurityReportCoverage({
      schemaVersion: 1,
      stage: "report",
      findings: [],
      coverage: {
        inspected: ["src/routes/profile.ts"],
        unexamined: [],
        candidates: [{
          candidateId: "candidate-profile-query",
          disposition: "rejected",
          reason: "not-vulnerable",
          evidence: [anchor],
        }],
      },
    }, dossier),
    /confirmed candidate must be reported/i,
  );
});

test("Portable coverage anchors must resolve to regular pinned source lines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-coverage-anchors-"));
  try {
    fs.mkdirSync(path.join(root, "src", "routes"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "routes", "profile.ts"), "const profile = true;\n");
    const sourceDossier = applyPortableCodexSecurityStageArtifact(createPortableCodexSecurityDossier(), {
      schemaVersion: 1,
      stage: "discovery",
      summary: "Candidate discovery recorded a repository-backed authorization target.",
      observations: [],
      candidates: [{ id: "candidate-profile-query", category: "authorization", anchors: [
        { ...anchor, startLine: 99, endLine: 99 },
      ] }],
    });
    assert.throws(
      () => assertPortableCodexSecurityDossierAnchors(root, sourceDossier),
      /stage_evidence_incomplete/i,
    );

    const validDossier = applyPortableCodexSecurityStageArtifact(createPortableCodexSecurityDossier(), {
      schemaVersion: 1,
      stage: "discovery",
      summary: "Candidate discovery recorded a repository-backed authorization target.",
      observations: [],
      scope: { inspected: ["src/routes/profile.ts"], unexamined: [] },
      candidates: [{ id: "candidate-profile-query", category: "authorization", anchors: [
        { ...anchor, startLine: 1, endLine: 1 },
      ] }],
    });
    const rejectedDossier = applyPortableCodexSecurityStageArtifact(validDossier, {
      schemaVersion: 1,
      stage: "validation",
      summary: "Validation rejected the candidate using repository-backed evidence.",
      observations: [],
      assessments: [{
        candidateId: "candidate-profile-query",
        status: "rejected",
        reason: "not-vulnerable",
        evidence: [{ ...anchor, startLine: 1, endLine: 1 }],
      }],
    });
    const report = validatePortableCodexSecurityReportCoverage({
      schemaVersion: 1,
      stage: "report",
      findings: [],
      coverage: {
        inspected: ["src/routes/profile.ts"],
        unexamined: [],
        candidates: [{
          candidateId: "candidate-profile-query",
          disposition: "rejected",
          reason: "not-vulnerable",
          evidence: [{ ...anchor, path: "src/routes/missing.ts", startLine: 1, endLine: 1 }],
        }],
      },
    }, rejectedDossier);
    assert.throws(
      () => assertPortableCodexSecurityReportAnchors(root, report),
      /stage_evidence_incomplete/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Portable anchor validation is byte bounded and checks the remaining deadline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-anchor-budget-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "large.ts"), Buffer.alloc(1_048_577, 97));
    const dossier = applyPortableCodexSecurityStageArtifact(createPortableCodexSecurityDossier(), {
      schemaVersion: 1,
      stage: "discovery",
      summary: "Candidate discovery recorded a bounded source target.",
      observations: [],
      candidates: [{
        id: "candidate-large-file",
        category: "validation",
        anchors: [{ ...anchor, path: "src/large.ts", startLine: 1, endLine: 1 }],
      }],
    });
    assert.throws(
      () => assertPortableCodexSecurityDossierAnchors(root, dossier),
      /stage_evidence_incomplete/i,
    );

    fs.writeFileSync(path.join(root, "src", "large.ts"), "const bounded = true;\n");
    assert.throws(
      () => assertPortableCodexSecurityDossierAnchors(root, dossier, () => 0),
      /agent_time_limit/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
