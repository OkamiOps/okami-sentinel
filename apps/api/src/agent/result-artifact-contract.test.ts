import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT,
  PORTABLE_ARTIFACT_STAGES,
  type PortableArtifactPath,
  normalizeResultArtifactInput,
  resultArtifactContentSchema,
  resultArtifactPathSchema,
} from "./result-artifact-contract.js";
import { createPortableCodexSecurityDossier } from "../scanners/portable-codex-security-dossier.js";
import { createPortableCodexSecurityReportShards } from "../scanners/portable-codex-security-report-shards.js";
import { MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT } from "../scanners/mantis-report-contract.js";

test("Portable uses an object tool argument while other artifact contracts retain strings", () => {
  assert.equal(resultArtifactContentSchema(PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT).type, "object");
  for (const contract of [undefined, "vulnhunter-report-v1", MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT] as const) {
    assert.deepEqual(resultArtifactContentSchema(contract), { type: "string", minLength: 1 });
    assert.deepEqual(resultArtifactPathSchema(contract), { type: "string", minLength: 1 });
  }
  assert.deepEqual(resultArtifactPathSchema(PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT), {
    type: "string",
    enum: ["01-inventory.json", "02-threat-model.json", "03-discovery.json", "04-dataflow.json", "05-validation.json", "sentinel-findings.json"],
  });
});

test("Portable object content preserves source characters without bypassing stage validation", () => {
  const artifact = {
    schemaVersion: 1,
    stage: "inventory",
    summary: 'Source contains "quotes", a \\ path, and a newline\nfollowed by ```json.',
    observations: [],
  };
  const normalized = normalizeResultArtifactInput({ path: "01-inventory.json", content: artifact },
    PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT);
  assert.notEqual(normalized, null);
  assert.deepEqual(JSON.parse(normalized!.content as string), artifact);
  assert.equal(normalizeResultArtifactInput({
    path: "03-discovery.json", content: artifact,
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT), null);
  assert.equal(normalizeResultArtifactInput({
    path: "01-inventory.json", content: { ...artifact, schemaVersion: 99 },
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT), null);
});

test("Portable schema declares every stage field and nested evidence instead of an opaque object", () => {
  const schema = resultArtifactContentSchema(PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(properties).sort(), [
    "assessments", "candidates", "coverage", "findings", "observations", "schemaVersion", "scope", "stage", "summary",
  ]);
  const itemKeys = (name: string) => Object.keys(
    (properties[name]!.items as Record<string, unknown>).properties as Record<string, unknown>,
  ).sort();
  assert.deepEqual(itemKeys("candidates"), [
    "anchors", "attacker", "category", "controlHypothesis", "expectedImpact", "hypothesis", "id", "prerequisites",
  ]);
  assert.deepEqual(itemKeys("assessments"), ["candidateId", "evidence", "reason", "status"]);
  assert.deepEqual(itemKeys("findings"), [
    "anchors", "candidateId", "category", "confidence", "cwe", "id", "impact", "remediation",
    "rootCause", "severity", "severityRationale", "summary", "title",
  ]);
  const inspect = (node: Record<string, unknown>) => {
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      const children = node.properties as Record<string, Record<string, unknown>>;
      assert.ok(Object.keys(children).length > 0, "opaque object loses fields on provider projection");
      for (const child of Object.values(children)) inspect(child);
    }
    if (node.type === "array") inspect(node.items as Record<string, unknown>);
  };
  inspect(schema);
  const candidate = properties.candidates!.items as { properties: Record<string, Record<string, unknown>> };
  const anchor = candidate.properties.anchors!.items as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(Object.keys(anchor.properties).sort(), ["endLine", "explanation", "path", "role", "startLine"]);
  assert.deepEqual(anchor.required, ["path", "startLine", "endLine", "role"]);
});

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
  let detail: unknown;
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
  }, (nextIssue, nextDetail) => { issue = nextIssue; detail = nextDetail; });

  assert.equal(normalized, null);
  assert.equal(issue, "report-candidate-assessment-inconclusive");
  assert.deepEqual(detail, { kind: "assessment-contract", field: "assessments", candidateId: candidate.id, code: "assessment-inconclusive" });
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

test("Portable discovery distinguishes candidate array shape failures without echoing payload content", () => {
  const context = {
    dossier: createPortableCodexSecurityDossier(),
    requireDiscoveryCandidateContext: true,
  } as const;
  const base = {
    schemaVersion: 1,
    stage: "discovery",
    summary: "Discovery recorded a repository-backed candidate review.",
    observations: [],
  };
  const cases = [
    {
      content: ["provider-secret-payload"],
      expected: { field: "payload", expected: "object", actualType: "array" },
    },
    {
      content: base,
      expected: { field: "candidates", expected: "array", actualType: "missing", limit: 100 },
    },
    {
      content: { ...base, candidates: "provider-secret-candidates" },
      expected: { field: "candidates", expected: "array", actualType: "string", limit: 100 },
    },
    {
      content: { ...base, candidates: Array.from({ length: 101 }, () => "provider-secret-candidate") },
      expected: { field: "candidates", expected: "array", actualType: "array", count: 101, limit: 100 },
    },
  ] as const;

  for (const { content, expected } of cases) {
    let issue: unknown;
    let detail: unknown;
    assert.equal(normalizeResultArtifactInput({ path: "03-discovery.json", content },
      PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, undefined, context, (nextIssue, nextDetail) => {
        issue = nextIssue;
        detail = nextDetail;
      }), null);
    assert.equal(issue, "stage-candidates-invalid");
    assert.deepEqual(detail, { kind: "candidate-contract", reason: "array-or-limit", ...expected });
    assert.doesNotMatch(JSON.stringify(detail), /provider-secret/);
  }
});

test("Deep discovery requires a complete read of every server-owned partition path", () => {
  const deepCoverage = {
    index: 0,
    total: 1,
    requiredPaths: ["src/a.ts", "src/b.ts"],
    requiredBytes: { "src/a.ts": 10, "src/b.ts": 20 },
    observedReadPaths: new Set(["src/a.ts"]),
  };
  const input = {
    path: "03-discovery.json",
    content: JSON.stringify({
      schemaVersion: 1,
      stage: "discovery",
      summary: "Partition discovery completed after every assigned file was inspected.",
      observations: [],
      scope: { inspected: ["invented.ts"], unexamined: [{ path: "src/b.ts", reason: "out-of-scope" }] },
      candidates: [{
        id: "provider-local-id",
        category: "authorization",
        anchors: [{ path: "src/a.ts", startLine: 1, endLine: 1, role: "sink" }],
      }],
    }),
  };
  let issue: unknown;
  const context = { dossier: {
    schemaVersion: 1 as const,
    stageSummaries: [],
    candidates: [],
    assessments: [],
    scope: { inspected: [], unexamined: [] },
  }, deepCoverage };
  assert.equal(normalizeResultArtifactInput(
    input,
    PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT,
    undefined,
    context,
    (nextIssue) => { issue = nextIssue; },
  ), null);
  assert.equal(issue, "deep-coverage-incomplete");

  deepCoverage.observedReadPaths.add("src/b.ts");
  const normalized = normalizeResultArtifactInput(
    input,
    PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT,
    undefined,
    context,
  );
  assert.ok(normalized);
  const artifact = JSON.parse(String(normalized!.content)) as {
    scope: { inspected: string[]; unexamined: unknown[] };
    candidates: Array<{ id: string }>;
  };
  assert.deepEqual(artifact.scope, { inspected: ["src/a.ts", "src/b.ts"], unexamined: [] });
  assert.match(artifact.candidates[0]!.id, /^deep-[a-f0-9]{24}$/);
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

  const content = JSON.stringify({
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
    });
  const context = {
    dossier: shard.dossier,
    reportShard: shard,
  };
  const normalized = normalizeResultArtifactInput({
    path: "sentinel-findings.json", content,
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, snapshotRoot, context);

  assert.ok(normalized !== null);
  const calibratedContext = { ...context, requireCalibratedSeverityRationale: true };
  let rationaleRepair: unknown;
  assert.equal(normalizeResultArtifactInput({ path: "sentinel-findings.json", content },
    PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, snapshotRoot, calibratedContext, (_issue, detail) => { rationaleRepair = detail; }), null,
  "a new high finding cannot omit its severity rationale");
  assert.deepEqual(rationaleRepair, { kind: "report-contract", field: "findings[0].severityRationale", code: "text", minChars: 24 });
  const calibrated = JSON.parse(content);
  calibrated.findings[0].severityRationale = "The public operation exposes protected records to ordinary authenticated callers with no additional privilege, supporting high impact and likelihood.";
  assert.notEqual(normalizeResultArtifactInput({ path: "sentinel-findings.json", content: calibrated },
    PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, snapshotRoot, calibratedContext), null);
  assert.deepEqual(normalizeResultArtifactInput({ content },
    PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, snapshotRoot, context), normalized,
  "an omitted path uses only the server-owned report shard destination");
  for (const invalidPath of ["wrong.json", "03-discovery.json", "../sentinel-findings.json", "", null]) {
    assert.equal(normalizeResultArtifactInput({ path: invalidPath, content },
      PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, snapshotRoot, context), null,
    "an explicit invalid path must never be replaced");
  }
  assert.equal(normalizeResultArtifactInput({ content },
    PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, snapshotRoot, { dossier: shard.dossier }), null,
  "missing paths outside report shards must be rejected");
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

test("live Portable discovery requires an explicit, reviewable candidate claim while historical parsing remains permissive", () => {
  const context = {
    dossier: createPortableCodexSecurityDossier(),
    expectedArtifactPath: "03-discovery.json" as const,
    requireDiscoveryCandidateContext: true,
  };
  let issue: unknown;
  const emptyDiscovery = {
    schemaVersion: 1, stage: "discovery", observations: [],
    summary: "The directed source review did not establish any candidate vulnerability.",
    scope: { inspected: ["src/routes.ts"], unexamined: [] },
  };
  assert.equal(normalizeResultArtifactInput({ path: "03-discovery.json", content: emptyDiscovery },
    PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, undefined, context), null, "omitted candidates must not mean zero findings");
  assert.notEqual(normalizeResultArtifactInput({ path: "03-discovery.json", content: { ...emptyDiscovery, candidates: [] } },
    PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, undefined, context), null, "explicit zero remains valid without forcing findings");
  assert.equal(normalizeResultArtifactInput({
    path: "03-discovery.json",
    content: {
      schemaVersion: 1,
      stage: "discovery",
      summary: "Discovery identified an authorization lead for later independent validation.",
      observations: [],
      candidates: [{
        id: "candidate-authorization",
        category: "authorization",
        anchors: [{ path: "src/routes.ts", startLine: 12, endLine: 12, role: "entrypoint" }],
      }],
    },
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, undefined, context, (nextIssue) => { issue = nextIssue; }), null);
  assert.equal(issue, "stage-candidates-invalid");

  const live = {
    schemaVersion: 1,
    stage: "discovery",
    summary: "Discovery identified an authorization lead for later independent validation.",
    observations: [],
    scope: { inspected: ["src/routes.ts"], unexamined: [] },
    candidates: [{
      id: "candidate-authorization",
      category: "authorization",
      hypothesis: "The route may mutate another account without an ownership authorization check.",
      attacker: "authenticated",
      prerequisites: "An authenticated account can invoke the public mutation route with another account identifier.",
      expectedImpact: "A successful bypass could modify data belonging to a different account.",
      controlHypothesis: "The route may lack an ownership control before the state-changing service call.",
      anchors: [{ path: "src/routes.ts", startLine: 12, endLine: 12, role: "entrypoint" }],
    }],
  };
  assert.notEqual(normalizeResultArtifactInput({ path: "03-discovery.json", content: live },
    PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, undefined, context), null);
  assert.notEqual(normalizeResultArtifactInput({ path: "03-discovery.json", content: {
    ...live,
    candidates: [{ id: "historical-candidate", category: "authorization", anchors: live.candidates[0]!.anchors }],
  } }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT), null, "old artifacts remain readable without the live context flag");
});


test("live discovery rejects the real empty placeholder and unsubstantiated scope without rejecting supported zero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-discovery-scope-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/routes.ts"), "export const guarded = true;\n");
    fs.writeFileSync(path.join(root, "src/other.ts"), "export const other = true;\n");
    const context = {
      dossier: createPortableCodexSecurityDossier(),
      expectedArtifactPath: "03-discovery.json" as const,
      requireDiscoveryCandidateContext: true,
      discoveryCoverage: { observedReadPaths: new Set(["src/routes.ts"]) },
    };
    const placeholder = { schemaVersion: 1, stage: "discovery", summary: "placeholder", observations: [], candidates: [] };
    let issue: unknown;
    let detail: unknown;
    const normalize = (content: unknown) => normalizeResultArtifactInput({ path: "03-discovery.json", content },
      PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, root, context, (next, nextDetail) => {
        issue = next;
        detail = nextDetail;
      });
    assert.equal(normalize(placeholder), null);
    assert.equal(issue, "stage-summary-invalid");
    assert.notEqual(normalizeResultArtifactInput({ path: "03-discovery.json", content: placeholder },
      PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, root), null, "archived artifact parsing is unchanged");
    const reviewed = {
      ...placeholder,
      summary: "Reviewed route mutations and found an ownership guard before each state-changing call; no supported candidate remains.",
      scope: { inspected: ["src/routes.ts"], unexamined: [{ path: "src/other.ts", reason: "out-of-scope" }] },
    };
    assert.notEqual(normalize(reviewed), null, "source-supported zero remains valid");
    for (const scope of [undefined, { inspected: [], unexamined: [] }, { inspected: ["."], unexamined: [] },
      { inspected: ["src"], unexamined: [] }, { inspected: ["invented.ts"], unexamined: [] },
      { inspected: ["src/other.ts"], unexamined: [] },
      { inspected: ["src/routes.ts"], unexamined: [{ path: "src/routes.ts", reason: "out-of-scope" }] },
      { inspected: ["src/routes.ts"], unexamined: [{ path: "invented.ts", reason: "out-of-scope" }] }]) {
      assert.equal(normalize({ ...reviewed, scope }), null, `must reject ungrounded scope ${JSON.stringify(scope)}`);
      assert.equal(issue, "stage-scope-invalid");
      assert.deepEqual({ ...(detail as object), scopeIssue: undefined }, {
        scopeIssue: undefined,
        kind: "discovery-review",
        reason: "scope",
        successfulReadPaths: ["src/routes.ts"],
        pathsTruncated: false,
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Portable stage schema fixes the destination, stage and required stage fields", () => {
  for (const [artifactPath, stage] of Object.entries(PORTABLE_ARTIFACT_STAGES)) {
    const context = { dossier: createPortableCodexSecurityDossier(), expectedArtifactPath: artifactPath as PortableArtifactPath };
    assert.deepEqual(resultArtifactPathSchema(PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, context), { type: "string", enum: [artifactPath] });
    const schema = resultArtifactContentSchema(PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, context) as { properties: Record<string, any>; required: string[]; additionalProperties: boolean };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.stage.enum, [stage]);
    assert.ok(schema.required.includes("stage"));
    if (stage === "report") {
      assert.deepEqual(Object.keys(schema.properties), ["schemaVersion", "stage", "findings", "coverage"]);
    } else {
      assert.ok(schema.required.includes("summary"));
      assert.ok(schema.required.includes("observations"));
      assert.equal("findings" in schema.properties, false);
      assert.equal("coverage" in schema.properties, false);
      assert.equal("candidates" in schema.properties, stage === "discovery");
      assert.equal("assessments" in schema.properties, stage === "dataflow" || stage === "validation");
    }
    if (stage === "validation") assert.deepEqual(schema.properties.assessments.items.properties.status.enum, ["confirmed", "rejected"]);
  }
  const liveDiscoverySchema = resultArtifactContentSchema(PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, {
    dossier: createPortableCodexSecurityDossier(),
    expectedArtifactPath: "03-discovery.json",
    requireDiscoveryCandidateContext: true,
  }) as { properties: Record<string, any>; required: string[] };
  assert.ok(liveDiscoverySchema.required.includes("scope"));
  assert.deepEqual(liveDiscoverySchema.properties.candidates.items.required, [
    "id", "category", "hypothesis", "attacker", "prerequisites", "expectedImpact", "controlHypothesis", "anchors",
  ]);
});

test("Portable expected stage rejects an otherwise valid artifact for a different destination", () => {
  let issue: unknown;
  const content = { schemaVersion: 1, stage: "inventory", summary: "Inventory completed.", observations: [] };
  assert.notEqual(normalizeResultArtifactInput({ path: "01-inventory.json", content }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT), null);
  assert.equal(normalizeResultArtifactInput({ path: "01-inventory.json", content }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, undefined,
    { dossier: createPortableCodexSecurityDossier(), expectedArtifactPath: "02-threat-model.json" },
    (value) => { issue = value; }), null);
  assert.equal(issue, "path-or-stage-invalid");
});


test("discovery scope repair identifies the rejected field without modifying candidates or echoing invalid content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-scope-diagnostics-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    for (const file of ["read.ts", "other.ts"]) fs.writeFileSync(path.join(root, "src", file), "export const value = true;\n");
    const context = {
      dossier: createPortableCodexSecurityDossier(), expectedArtifactPath: "03-discovery.json" as const,
      requireDiscoveryCandidateContext: true,
      discoveryCoverage: { observedReadPaths: new Set(["src/read.ts"]) },
    };
    const candidate = {
      id: "ownership-lead", category: "authorization", attacker: "authenticated",
      hypothesis: "Record lookup may not bind ownership to the authenticated caller.",
      prerequisites: "Caller can supply another account record identifier to the lookup.",
      expectedImpact: "Records belonging to another account could be disclosed to the caller.",
      controlHypothesis: "An ownership authorization check may be missing before lookup.",
      anchors: [{ path: "src/read.ts", startLine: 1, endLine: 1, role: "sink" }],
    };
    const artifact = { schemaVersion: 1, stage: "discovery", observations: [], candidates: [candidate],
      summary: "Reviewed the route authorization and persistence controls; the remaining file was not reviewed.",
      scope: { inspected: ["src/read.ts"], unexamined: [{ path: "src/other.ts", reason: "insufficient-evidence" }] } };
    const cases = [
      { scope: { ...artifact.scope, unexamined: [{ path: "src/other.ts", reason: "private arbitrary provider prose" }] }, field: "scope.unexamined[0].reason", code: "invalid-reason" },
      { scope: { ...artifact.scope, unexamined: [{ path: "src", reason: "out-of-scope" }] }, field: "scope.unexamined[0].path", code: "not-regular-file" },
      { scope: { ...artifact.scope, unexamined: [{ path: "missing.ts", reason: "out-of-scope" }] }, field: "scope.unexamined[0].path", code: "path-unavailable" },
      { scope: { ...artifact.scope, unexamined: [{ path: "../outside.ts", reason: "out-of-scope" }] }, field: "scope.unexamined[0].path", code: "invalid-path" },
      { scope: { ...artifact.scope, unexamined: [{ path: "src/read.ts", reason: "out-of-scope" }] }, field: "scope.unexamined[0].path", code: "overlap" },
      { scope: { ...artifact.scope, inspected: ["src/other.ts"] }, field: "scope.inspected[0]", code: "unobserved-read" },
      { scope: { ...artifact.scope, inspected: [] }, field: "scope.inspected", code: "empty-inspected" },
    ];
    for (const entry of cases) {
      const input = { ...artifact, scope: entry.scope };
      const before = JSON.stringify(input);
      let detail: any;
      assert.equal(normalizeResultArtifactInput({ path: "03-discovery.json", content: input },
        PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, root, context, (_issue, repair) => { detail = repair; }), null);
      assert.equal(detail.scopeIssue.field, entry.field);
      assert.equal(detail.scopeIssue.code, entry.code);
      assert.deepEqual(detail.successfulReadPaths, ["src/read.ts"]);
      assert.equal(JSON.stringify(input), before, "rejection must not mutate claims");
      assert.doesNotMatch(JSON.stringify(detail), /private arbitrary provider prose/);
      if (entry.code === "invalid-reason") assert.ok(detail.scopeIssue.allowedReasons.includes("insufficient-evidence"));
    }
    assert.notEqual(normalizeResultArtifactInput({ path: "03-discovery.json", content: artifact },
      PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, root, context), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("projected discovery accepts honest partial source coverage without promoting it to full reads", () => {
  const content = {
    schemaVersion: 1, stage: "discovery", observations: [], candidates: [],
    summary: "Reviewed the supplied source windows; remaining file contents and callers remain unexamined.",
    scope: { inspected: [], unexamined: [{ path: "src/routes.ts", reason: "insufficient-evidence" }] },
  };
  const context = {
    dossier: createPortableCodexSecurityDossier(), requireDiscoveryCandidateContext: true,
    discoveryCoverage: { observedReadPaths: new Set<string>(), projectedSourcePaths: new Set(["src/routes.ts"]) },
  };
  const normalize = (scope: unknown, validationContext = context) => normalizeResultArtifactInput(
    { path: "03-discovery.json", content: { ...content, scope } }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT,
    undefined, validationContext);
  const accepted = normalize(content.scope);
  assert.notEqual(accepted, null);
  assert.deepEqual(JSON.parse(accepted!.content as string).scope, content.scope);
  assert.equal(normalize({ inspected: [], unexamined: [] }), null, "partial coverage cannot disappear");
  assert.equal(normalize({ inspected: ["src/routes.ts"], unexamined: [] }), null, "projected windows are not full reads");
  assert.equal(normalize(content.scope, { ...context, discoveryCoverage: {
    observedReadPaths: new Set(), projectedSourcePaths: new Set(),
  } }), null, "graph metadata alone does not qualify as inspected source");
  assert.notEqual(normalize({ inspected: ["src/routes.ts"], unexamined: [] }, {
    ...context, discoveryCoverage: { ...context.discoveryCoverage, observedReadPaths: new Set(["src/routes.ts"]) },
  }), null, "a real full read can resolve the partial coverage");
});


test("provider discovery schema permits empty inspected exactly when server source excerpts exist", () => {
  for (const [paths, expectedMinimum] of [[[], 1], [["src/routes.ts"], 0]] as const) {
    const schema = resultArtifactContentSchema(PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT, {
      dossier: createPortableCodexSecurityDossier(), expectedArtifactPath: "03-discovery.json",
      requireDiscoveryCandidateContext: true,
      discoveryCoverage: { observedReadPaths: new Set<string>(), projectedSourcePaths: new Set(paths) },
    }) as { properties: Record<string, any> };
    assert.equal(schema.properties.scope.properties.inspected.minItems, expectedMinimum);
  }
});
