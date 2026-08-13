import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT,
  normalizeResultArtifactInput,
} from "./result-artifact-contract.js";
import { createPortableCodexSecurityReportShards } from "../scanners/portable-codex-security-report-shards.js";
import { MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT } from "../scanners/mantis-report-contract.js";

test("VulnHunter reports return a closed evidence repair reason before artifact I/O", (t) => {
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vulnhunter-report-repair-"));
  t.after(() => fs.rmSync(snapshotRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(snapshotRoot, "app.ts"), "one\ntwo");
  const finding = {
    id: "VULN-001",
    title: "Untrusted input reaches a sensitive operation",
    severity: "High",
    confidence: "high",
    cwe: ["CWE-20"],
    summary: "An externally controlled value reaches a security-sensitive operation.",
    rootCause: "The trust boundary lacks a required server-side validation control.",
    entryPoint: "The application accepts the value from an external request.",
    dataFlow: "request input to application handler to sensitive operation",
    impact: "An attacker can cross the intended security boundary with crafted input.",
    remediation: "Validate the value against a strict server-owned policy before use.",
    severityRationale: "The path is statically reachable and crosses a security boundary.",
    validation: {
      summary: "Static inspection confirmed the source-to-operation path.",
      limitations: ["Static inspection only; target code was not executed."],
    },
    evidence: [{
      path: "app.ts",
      startLine: 1,
      endLine: 3,
      role: "sink",
      explanation: "The sensitive operation consumes the unvalidated value.",
    }],
  };
  let issue: unknown;
  let detail: unknown;
  assert.equal(normalizeResultArtifactInput({
    path: "sentinel-findings.json",
    content: JSON.stringify({ schemaVersion: 1, findings: [finding] }),
  }, "vulnhunter-report-v1", snapshotRoot, undefined, (nextIssue, nextDetail) => {
    issue = nextIssue;
    detail = nextDetail;
  }), null);
  assert.equal(issue, "vulnhunter-report-invalid");
  assert.deepEqual(detail, { kind: "vulnhunter-report", reason: "evidence" });

  finding.evidence[0]!.endLine = 2;
  assert.notEqual(normalizeResultArtifactInput({
    path: "sentinel-findings.json",
    content: JSON.stringify({ schemaVersion: 1, findings: [finding] }),
  }, "vulnhunter-report-v1", snapshotRoot), null);
});

test("Mantis reports reject an unpinned locator with closed repair coordinates", (t) => {
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-report-anchor-"));
  t.after(() => fs.rmSync(snapshotRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(snapshotRoot, "routes"));
  fs.writeFileSync(path.join(snapshotRoot, "routes", "redirect.ts"), "one\ntwo\n");
  const finding = {
    id: "MANTIS-1",
    title: "Unvalidated redirect can cross the trust boundary",
    severity: "high",
    remediation: "Validate the destination against a strict server-owned allowlist.",
    code_paths: ["routes/redirect.ts"],
  };
  let issue: unknown;
  let repair: unknown;
  assert.equal(normalizeResultArtifactInput({
    path: "report.json",
    content: JSON.stringify({ schemaVersion: 1, engine: "mantis", stage: "report", findings: [finding] }),
  }, MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT, snapshotRoot, undefined, (nextIssue, detail) => {
    issue = nextIssue;
    repair = detail;
  }), null);
  assert.equal(issue, "mantis-report-invalid");
  assert.deepEqual(repair, { kind: "mantis-report", reason: "locator", findingIndex: 0, locatorIndex: 0 });

  finding.code_paths = ["routes/redirect.ts:1-2"];
  assert.notEqual(normalizeResultArtifactInput({
    path: "report.json",
    content: JSON.stringify({ schemaVersion: 1, engine: "mantis", stage: "report", findings: [finding] }),
  }, MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT, snapshotRoot), null);
});

test("generic JSON artifacts reject truncation and canonicalize a complete retry", () => {
  assert.equal(normalizeResultArtifactInput({
    path: "stage.json",
    content: '{"schemaVersion":1,"summary":"truncated',
  }, undefined), null);

  assert.deepEqual(normalizeResultArtifactInput({
    path: "stage.json",
    content: "```json\n{\"schemaVersion\":1,\"summary\":\"complete\"}\n```",
  }, undefined), {
    path: "stage.json",
    content: '{"schemaVersion":1,"summary":"complete"}',
  });
});

test("Portable stage artifacts validate the declared path and stage before I/O", () => {
  const wrongStage = JSON.stringify({
    schemaVersion: 1,
    stage: "discovery",
    summary: "wrong stage",
    observations: [],
  });
  assert.equal(normalizeResultArtifactInput({
    path: "01-inventory.json",
    content: wrongStage,
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT), null);

  const valid = {
    schemaVersion: 1,
    stage: "inventory",
    summary: "complete",
    observations: [],
  };
  assert.deepEqual(normalizeResultArtifactInput({
    path: "01-inventory.json",
    content: JSON.stringify(valid),
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT), {
    path: "01-inventory.json",
    content: JSON.stringify(valid),
  });
});

test("Portable inventory canonicalizes provider detail at the declared virtual root", () => {
  const providerInventory = {
    schemaVersion: 1,
    stage: "inventory",
    summary: "Inventory covered the immutable repository root and its trust boundaries.",
    observations: [
      { id: "inventory-framework", detail: "Framework and runtime metadata inspected." },
    ],
    scope: {
      inspected: [".", "./src/", "src"],
      unexamined: [
        "generated/",
        { path: "vendor/", reason: "third-party code", note: "Narrative provider detail." },
      ],
      trustBoundaries: ["HTTP", "database"],
    },
    candidates: [{
      id: "narrative-boundary",
      category: "trust-boundary",
      anchors: [],
    }],
    trustBoundaries: ["HTTP entrypoints", "database access"],
  };

  assert.deepEqual(normalizeResultArtifactInput({
    path: "01-inventory.json",
    content: JSON.stringify(providerInventory),
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT), {
    path: "01-inventory.json",
    content: JSON.stringify({
      schemaVersion: 1,
      stage: "inventory",
      summary: providerInventory.summary,
      observations: [],
      scope: {
        inspected: [".", "src"],
        unexamined: [
          { path: "generated", reason: "insufficient-evidence" },
          { path: "vendor", reason: "insufficient-evidence" },
        ],
      },
    }),
  });
});

test("Portable validation rejects an inconclusive carried candidate before artifact I/O", () => {
  const candidate = {
    id: "candidate-authz",
    category: "authorization",
    anchors: [{ path: "routes/auth.ts", startLine: 1, endLine: 1, role: "source" as const }],
  };
  let issue: unknown;
  const normalized = normalizeResultArtifactInput({
    path: "05-validation.json",
    content: JSON.stringify({
      schemaVersion: 1,
      stage: "validation",
      summary: "Static validation could not reach a decisive result.",
      observations: [],
      assessments: [{
        candidateId: candidate.id,
        status: "inconclusive",
        reason: "insufficient-evidence",
        evidence: candidate.anchors,
      }],
    }),
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, undefined, {
    dossier: {
      schemaVersion: 1,
      stageSummaries: [],
      candidates: [candidate],
      assessments: [],
      scope: { inspected: ["."], unexamined: [] },
    },
  }, (nextIssue) => { issue = nextIssue; });

  assert.equal(normalized, null);
  assert.equal(issue, "report-candidate-assessment-inconclusive");
});

test("Portable discovery rejects an anchor beyond the pinned snapshot before artifact I/O", (t) => {
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portable-stage-anchor-"));
  t.after(() => fs.rmSync(snapshotRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(snapshotRoot, "config"));
  fs.writeFileSync(path.join(snapshotRoot, "config", "unsafe.yml"), "unsafe: true\n");

  let diagnostic: unknown;
  assert.equal(normalizeResultArtifactInput({
    path: "03-discovery.json",
    content: JSON.stringify({
      schemaVersion: 1,
      stage: "discovery",
      summary: "Discovery located a candidate with a source anchor.",
      observations: [],
      candidates: [{
        id: "candidate-unsafe-config",
        category: "runtime-configuration",
        anchors: [{
          path: "config/unsafe.yml",
          startLine: 1,
          endLine: 2,
          role: "source",
        }],
      }],
    }),
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, snapshotRoot, undefined, (_issue, detail) => {
    diagnostic = detail;
  }), null);
  assert.deepEqual(diagnostic, {
    kind: "anchor-ranges-out-of-bounds",
    violations: [{
      path: "config/unsafe.yml",
      requestedStartLine: 1,
      requestedEndLine: 2,
      maxLine: 1,
    }],
  });
});

test("Portable discovery returns a closed candidate-contract repair reason", () => {
  let issue: unknown;
  let detail: unknown;
  assert.equal(normalizeResultArtifactInput({
    path: "03-discovery.json",
    content: JSON.stringify({
      schemaVersion: 1,
      stage: "discovery",
      summary: "Discovery recorded a repository-backed candidate.",
      observations: [],
      candidates: [{
        id: "candidate-auth",
        category: "authorization",
        anchors: [],
        description: "provider-specific extra field",
      }],
    }),
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, undefined, undefined, (candidateIssue, candidateDetail) => {
    issue = candidateIssue;
    detail = candidateDetail;
  }), null);
  assert.equal(issue, "stage-candidates-invalid");
  assert.deepEqual(detail, { kind: "candidate-contract", reason: "entry-keys", itemIndex: 0 });
});

test("Portable report rejects incomplete carried-candidate coverage before artifact I/O", (t) => {
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portable-report-coverage-"));
  t.after(() => fs.rmSync(snapshotRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(snapshotRoot, "index.ts"), "export const value = 1;\n");

  let issue: unknown;
  assert.equal(normalizeResultArtifactInput({
    path: "sentinel-findings.json",
    content: JSON.stringify({
      schemaVersion: 1,
      stage: "report",
      findings: [],
      coverage: { inspected: ["index.ts"], unexamined: [], candidates: [] },
    }),
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, snapshotRoot, {
    dossier: {
      schemaVersion: 1,
      stageSummaries: [],
      candidates: [{
        id: "candidate-index",
        category: "authorization",
        anchors: [{ path: "index.ts", startLine: 1, endLine: 1, role: "source" }],
      }],
      assessments: [],
      scope: { inspected: ["index.ts"], unexamined: [] },
    },
  }, (_issue) => { issue = _issue; }), null);
  assert.equal(issue, "report-coverage-candidate-missing");
});

test("Portable report shard accepts findings-only output and derives page coverage before artifact I/O", (t) => {
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portable-report-shard-pre-io-"));
  t.after(() => fs.rmSync(snapshotRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(snapshotRoot, "index.ts"), "export const value = 1;\n");
  const anchor = { path: "index.ts", startLine: 1, endLine: 1, role: "sink" as const };
  const dossier = {
    schemaVersion: 1 as const,
    stageSummaries: [],
    candidates: [{ id: "candidate-index", category: "authorization", anchors: [anchor] }],
    assessments: [{
      candidateId: "candidate-index",
      stage: "validation" as const,
      status: "confirmed" as const,
      reason: "control-not-present",
      evidence: [anchor],
    }],
    scope: { inspected: ["index.ts"], unexamined: [] },
  };
  const shard = createPortableCodexSecurityReportShards(dossier)[0]!;

  const normalized = normalizeResultArtifactInput({
    path: "sentinel-findings.json",
    content: JSON.stringify({
      schemaVersion: 1,
      stage: "report",
      findings: [{
        id: "PCS-001",
        candidateId: "candidate-index",
        title: "Missing authorization control on protected operation",
        severity: "high",
        confidence: "high",
        category: "authorization",
        summary: "The protected operation reaches sensitive data without binding access to the authenticated caller.",
        rootCause: "The sensitive operation does not enforce an authorization predicate for the authenticated identity.",
        impact: "An authenticated attacker could access data outside the intended authorization boundary.",
        remediation: "Bind the sensitive operation to the authenticated identity and reject unauthorized callers before access.",
        anchors: [{ ...anchor, explanation: "The pinned operation reaches the sensitive access without an authorization control." }],
      }],
    }),
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, snapshotRoot, {
    dossier: shard.dossier,
    reportShard: shard,
  });

  assert.ok(normalized !== null);
  const canonical = JSON.parse(String(normalized.content));
  assert.notEqual(canonical.findings[0].id, "PCS-001");
  assert.match(canonical.findings[0].id, /^PCS-[A-F0-9]{24}$/);
  assert.deepEqual(canonical.coverage.candidates, [{
    candidateId: "candidate-index",
    disposition: "reported",
    reason: "control-not-present",
    evidence: [anchor],
  }]);
});

test("Portable report never accepts an informational coverage statement as a vulnerability", () => {
  assert.equal(normalizeResultArtifactInput({
    path: "sentinel-findings.json",
    content: JSON.stringify({
      schemaVersion: 1,
      stage: "report",
      findings: [{
        id: "PCS-COVERAGE",
        candidateId: "candidate-coverage",
        title: "No security findings emitted",
        severity: "info",
        confidence: "high",
        category: "coverage",
        summary: "This is a coverage statement and not a reportable vulnerability.",
        rootCause: "No root cause exists because this is not a security finding.",
        impact: "No security impact exists because this is not a vulnerability.",
        remediation: "Do not emit coverage statements as security findings.",
        anchors: [{
          path: "src/index.ts",
          startLine: 1,
          endLine: 1,
          role: "evidence",
          explanation: "Coverage statements belong in the coverage section.",
        }],
      }],
      coverage: {
        inspected: ["src"],
        unexamined: [],
        candidates: [{
          candidateId: "candidate-coverage",
          disposition: "reported",
          reason: "not-vulnerable",
          evidence: [{ path: "src/index.ts", startLine: 1, endLine: 1, role: "evidence" }],
        }],
      },
    }),
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT), null);
});
