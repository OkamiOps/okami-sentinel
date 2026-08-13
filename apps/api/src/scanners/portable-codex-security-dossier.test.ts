import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyPortableCodexSecurityStageArtifact,
  createPortableCodexSecurityDossier,
  normalizePortableCodexSecurityStageArtifact,
  validatePortableCodexSecurityReportCoverage,
} from "./portable-codex-security-dossier.js";
import {
  assertPortableCodexSecurityDossierAnchors,
  assertPortableCodexSecurityReportAnchors,
  createPortableCodexSecurityAnchorValidationCache,
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

test("Portable dataflow discards provider candidates while retaining assessments for carried ids", () => {
  const dossier = applyPortableCodexSecurityStageArtifact(createPortableCodexSecurityDossier(), {
    schemaVersion: 1,
    stage: "discovery",
    summary: "Discovery recorded one repository-backed authorization candidate.",
    observations: [],
    candidates: [{ id: "candidate-profile-query", category: "authorization", anchors: [anchor] }],
  });
  const providerShapedDataflow = {
    schemaVersion: 1,
    stage: "dataflow",
    summary: "Dataflow traced the carried authorization candidate to its sensitive sink.",
    observations: [],
    candidates: [{ id: 7, category: { malformed: true }, anchors: "not-an-anchor-list" }],
    assessments: [{
      candidateId: "candidate-profile-query",
      status: "confirmed",
      reason: "untrusted-flow-reaches-sink",
      evidence: [anchor],
    }],
  };

  const normalized = normalizePortableCodexSecurityStageArtifact(
    "04-dataflow.json",
    providerShapedDataflow,
  );
  assert.ok(normalized !== null);
  assert.equal("candidates" in normalized, false);

  const next = applyPortableCodexSecurityStageArtifact(dossier, normalized);
  assert.deepEqual(next.candidates, dossier.candidates);
  assert.equal(next.assessments.length, 1);
  assert.equal(next.assessments[0]?.candidateId, "candidate-profile-query");

  assert.equal(normalizePortableCodexSecurityStageArtifact("03-discovery.json", {
    ...providerShapedDataflow,
    stage: "discovery",
  }), null);
});

test("Portable coverage dossier keeps candidate creation exclusive to discovery", () => {
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
  const next = applyPortableCodexSecurityStageArtifact(dossier, {
    schemaVersion: 1,
    stage: "validation",
    summary: "Validation received a redundant provider candidate outside discovery.",
    observations: [],
    candidates: [{ id: "candidate-profile-query", category: "injection", anchors: [anchor] }],
  });
  assert.deepEqual(next.candidates, dossier.candidates);
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

test("Portable report identifies a confirmed candidate omitted from coverage", () => {
  const reportAnchor = { ...anchor, role: "sink" as const };
  const dossier = {
    schemaVersion: 1 as const,
    stageSummaries: [],
    candidates: [{ id: "candidate-profile-query", category: "authorization", anchors: [reportAnchor] }],
    assessments: [{
      candidateId: "candidate-profile-query",
      stage: "validation" as const,
      status: "confirmed" as const,
      reason: "control-not-present" as const,
      evidence: [reportAnchor],
    }],
    scope: { inspected: ["src/routes/profile.ts"], unexamined: [] },
  };

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
    (error: unknown) => {
      assert.equal(
        (error as { issue?: unknown }).issue,
        "report-coverage-candidate-missing",
      );
      return true;
    },
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

test("Portable Deep validation accepts evidence distributed across more than 256 pinned files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-deep-anchor-universe-"));
  try {
    const candidates = Array.from({ length: 300 }, (_, index) => {
      const relativePath = `src/deep/file-${String(index).padStart(3, "0")}.ts`;
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `export const value${index} = true;\n`);
      return {
        id: `candidate-deep-${index}`,
        category: "deep-coverage",
        anchors: [{
          path: relativePath,
          startLine: 1,
          endLine: 1,
          role: "sink" as const,
          explanation: "Pinned repository evidence for the Deep coverage universe.",
        }],
      };
    });
    const cache = createPortableCodexSecurityAnchorValidationCache();
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const artifact = {
        schemaVersion: 1 as const,
        stage: "discovery" as const,
        summary: "Deep discovery retained repository-backed candidates for this server-owned page.",
        observations: [],
        candidates: candidates.slice(offset, offset + 100),
      };
      assert.notEqual(
        normalizePortableCodexSecurityStageArtifact("03-discovery.json", artifact, root),
        null,
      );
      const dossier = applyPortableCodexSecurityStageArtifact(createPortableCodexSecurityDossier(), artifact);
      assert.doesNotThrow(() => assertPortableCodexSecurityDossierAnchors(root, dossier, undefined, cache));
    }
    assert.equal(cache.lineCounts.size, 300);
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

test("Portable pre-I/O anchor validation rejects a symlink swapped before descriptor open", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-anchor-swap-"));
  const source = path.join(root, "src", "candidate.ts");
  const replacement = path.join(root, "src", "replacement.ts");
  const mutableFs = fs as unknown as {
    openSync: typeof fs.openSync;
    readFileSync: typeof fs.readFileSync;
  };
  const originalOpen = mutableFs.openSync;
  const originalRead = mutableFs.readFileSync;
  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "const safe = true;\n");
    fs.writeFileSync(replacement, "const replacement = true;\n");
    const artifact = {
      schemaVersion: 1,
      stage: "discovery",
      summary: "Candidate discovery recorded an anchored source file.",
      observations: [],
      candidates: [{
        id: "candidate-swap",
        category: "validation",
        anchors: [{ path: "src/candidate.ts", startLine: 1, endLine: 1, role: "source" }],
      }],
    };
    assert.notEqual(
      normalizePortableCodexSecurityStageArtifact("03-discovery.json", artifact, root),
      null,
    );

    let swapped = false;
    let readAttempted = false;
    mutableFs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      if (!swapped && args[0] === source) {
        swapped = true;
        fs.unlinkSync(source);
        fs.symlinkSync(replacement, source);
      }
      return originalOpen(...args);
    }) as typeof fs.openSync;
    mutableFs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === source) readAttempted = true;
      return originalRead(...args);
    }) as typeof fs.readFileSync;

    assert.equal(
      normalizePortableCodexSecurityStageArtifact("03-discovery.json", artifact, root),
      null,
    );
    assert.equal(swapped, true);
    assert.equal(readAttempted, false);
  } finally {
    mutableFs.openSync = originalOpen;
    mutableFs.readFileSync = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
