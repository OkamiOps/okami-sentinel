import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChangeSet,
  FindingSummary,
  FindingTriage,
  GuardrailException,
  Severity,
} from "@csb/shared";
import {
  classifyGateFindings,
  defaultGuardrailPolicy,
  evaluateGate,
  findingIdentity,
  type EvaluateGateInput,
} from "./index.js";

function finding(fingerprint: string, severity: Severity): FindingSummary {
  return {
    findingId: `run-${fingerprint}`,
    occurrenceId: null,
    title: "Stored XSS",
    severity,
    confidence: "high",
    ruleId: "CWE-79",
    summary: null,
    primaryPath: "src/report.ts:88",
    fingerprints: [`sha256:${fingerprint}`],
    category: "Stored cross-site scripting",
    cwe: ["CWE-79"],
  };
}

function changeSet(files: ChangeSet["files"]): ChangeSet {
  return {
    baseRef: "main",
    headRef: "HEAD",
    baseSha: "base-sha",
    headSha: "head-sha",
    files,
    scanPaths: files.map((file) => file.path),
    scopeMode: "changed",
    fallbackReason: null,
  };
}

function input(overrides: Partial<EvaluateGateInput> = {}): EvaluateGateInput {
  return {
    policy: defaultGuardrailPolicy(),
    branch: "main",
    changeSet: changeSet([
      {
        status: "modified",
        path: "src/report.ts",
        previousPath: null,
        additions: 1,
        deletions: 0,
      },
    ]),
    currentFindings: [],
    baselineFindings: [],
    historicalFindings: [],
    triageByIdentity: new Map(),
    exceptions: [],
    sourceScanId: "scan-current",
    baselineScanId: "scan-baseline",
    now: "2026-08-07T00:00:00Z",
    ...overrides,
  };
}

test("returns no_changes without a scan", () => {
  const result = evaluateGate(input({ changeSet: changeSet([]) }));
  assert.equal(result.decision.outcome, "no_changes");
  assert.equal(result.deltas.length, 0);
});

test("returns bootstrap when no baseline exists", () => {
  const result = evaluateGate(input({ baselineFindings: null, baselineScanId: null }));
  assert.equal(result.decision.outcome, "bootstrap");
  assert.equal(result.decision.githubConclusion, "neutral");
});

test("turns a known unavailable or incompatible baseline into action_required", () => {
  for (const baseline of [
    { kind: "unavailable" as const, reason: "artifact unavailable" },
    { kind: "incompatible" as const, reason: "scanner lineage mismatch" },
  ]) {
    const result = evaluateGate(input({
      currentFindings: [finding("stable-xss", "high")],
      baseline,
    }));

    assert.equal(result.decision.outcome, "error");
    assert.equal(result.decision.githubConclusion, "action_required");
    assert.deepEqual(result.deltas, []);
  }
});

test("only a comparable baseline can emit fixed lifecycle", () => {
  const high = finding("stable-xss", "high");
  const result = evaluateGate(input({
    currentFindings: [],
    baseline: {
      kind: "comparable",
      findings: [high],
      scanId: "scan-baseline",
    },
  }));

  assert.equal(result.deltas[0]?.lifecycle, "fixed");
});

test("classifies bootstrap observations as new even when history matches", () => {
  const high = finding("stable-xss", "high");
  const result = evaluateGate(input({
    currentFindings: [high],
    baselineFindings: null,
    historicalFindings: [high],
    baselineScanId: null,
  }));
  assert.equal(result.deltas[0]?.lifecycle, "new");
});

test("public classifier treats bootstrap observations as new", () => {
  const high = finding("stable-xss", "high");
  const result = classifyGateFindings(input({
    currentFindings: [high],
    baselineFindings: null,
    historicalFindings: [high],
    baselineScanId: null,
  }));
  assert.equal(result[0]?.lifecycle, "new");
});

test("blocks a reopened high finding", () => {
  const high = finding("stable-xss", "high");
  const result = evaluateGate(input({ currentFindings: [high], baselineFindings: [], historicalFindings: [high] }));
  assert.equal(result.deltas[0]?.lifecycle, "reopened");
  assert.equal(result.decision.outcome, "blocked");
  assert.equal(result.decision.githubConclusion, "failure");
});

test("warns for a persistent high finding", () => {
  const high = finding("stable-xss", "high");
  const result = evaluateGate(input({ currentFindings: [high], baselineFindings: [high] }));
  assert.equal(result.deltas[0]?.lifecycle, "persistent");
  assert.equal(result.decision.outcome, "warning");
});

test("does not block an active exception", () => {
  const high = finding("stable-xss", "high");
  const exceptions: GuardrailException[] = [{
    findingIdentity: findingIdentity(high),
    reason: "Migration window",
    owner: "marcos",
    createdAt: "2026-08-01T00:00:00Z",
    expiresAt: "2026-08-30T00:00:00Z",
    branches: ["main"],
    ruleIndexes: [],
  }];
  const result = evaluateGate(input({
    currentFindings: [high],
    baselineFindings: [],
    historicalFindings: [high],
    exceptions,
    now: "2026-08-07T00:00:00Z",
  }));
  assert.equal(result.decision.outcome, "pass");
  assert.equal(result.decision.exceptionsApplied.length, 1);
});

test("blocks when the matching exception is expired", () => {
  const high = finding("stable-xss", "high");
  const exceptions: GuardrailException[] = [{
    findingIdentity: findingIdentity(high),
    reason: "Expired window",
    owner: "marcos",
    createdAt: "2026-07-01T00:00:00Z",
    expiresAt: "2026-07-31T00:00:00Z",
    branches: ["main"],
    ruleIndexes: [],
  }];
  const result = evaluateGate(input({
    currentFindings: [high],
    baselineFindings: [],
    historicalFindings: [high],
    exceptions,
    now: "2026-08-07T00:00:00Z",
  }));
  assert.equal(result.decision.outcome, "blocked");
  assert.equal(result.decision.exceptionsApplied.length, 0);
});

test("keeps false-positive findings in the artifact without blocking", () => {
  const high = finding("stable-xss", "high");
  const result = evaluateGate(input({
    currentFindings: [high],
    baselineFindings: [],
    triageByIdentity: new Map([[findingIdentity(high), {
      status: "false_positive",
      note: "Reviewed",
      updatedAt: "2026-08-07T00:00:00Z",
    }]]),
  }));
  assert.equal(result.deltas.length, 1);
  assert.equal(result.decision.outcome, "pass");
});

test("isolates default triage from later evaluations", () => {
  const high = finding("stable-xss", "high");
  const first = evaluateGate(input({
    currentFindings: [high],
    baselineFindings: [],
    historicalFindings: [high],
  }));
  assert.equal(first.decision.outcome, "blocked");

  first.deltas[0]!.triage.status = "false_positive";
  try {
    const second = evaluateGate(input({
      currentFindings: [high],
      baselineFindings: [],
      historicalFindings: [high],
    }));
    assert.equal(second.deltas[0]?.triage.status, "unreviewed");
    assert.equal(second.decision.outcome, "blocked");
  } finally {
    first.deltas[0]!.triage.status = "unreviewed";
  }
});

test("isolates provided triage from returned-output mutation", () => {
  const high = finding("stable-xss", "high");
  const triage: FindingTriage = {
    status: "confirmed",
    note: "Reviewed",
    updatedAt: "2026-08-07T00:00:00Z",
  };
  const gateInput = input({
    currentFindings: [high],
    baselineFindings: [],
    historicalFindings: [high],
    triageByIdentity: new Map([[findingIdentity(high), triage]]),
  });
  const first = evaluateGate(gateInput);

  first.deltas[0]!.triage.status = "false_positive";

  assert.equal(triage.status, "confirmed");
  assert.equal(evaluateGate(gateInput).decision.outcome, "blocked");
});

test("isolates exception objects and target arrays from returned-output mutation", () => {
  const high = finding("stable-xss", "high");
  const exception: GuardrailException = {
    findingIdentity: findingIdentity(high),
    reason: "Migration window",
    owner: "marcos",
    createdAt: "2026-08-01T00:00:00Z",
    expiresAt: "2026-08-30T00:00:00Z",
    branches: ["main"],
    ruleIndexes: [],
  };
  const gateInput = input({
    currentFindings: [high],
    baselineFindings: [],
    historicalFindings: [high],
    exceptions: [exception],
  });
  const first = evaluateGate(gateInput);
  const returnedException = first.deltas[0]!.exception!;

  returnedException.reason = "Changed outside the evaluator";
  returnedException.branches.length = 0;
  returnedException.ruleIndexes.push(99);

  assert.equal(exception.reason, "Migration window");
  assert.deepEqual(exception.branches, ["main"]);
  assert.deepEqual(exception.ruleIndexes, []);
  assert.equal(evaluateGate(gateInput).decision.outcome, "pass");
});

test("isolates finding arrays from input and later evaluations", () => {
  const current = finding("stable-xss", "high");
  const historical = finding("stable-xss", "high");
  const policy = defaultGuardrailPolicy();
  policy.rules = [{ severity: ["high"], lifecycle: ["reopened"], decision: "block" }];
  const gateInput = input({
    policy,
    currentFindings: [current],
    baselineFindings: [],
    historicalFindings: [historical],
  });
  const first = evaluateGate(gateInput);
  assert.equal(first.decision.outcome, "blocked");

  first.deltas[0]!.fingerprints.splice(0, first.deltas[0]!.fingerprints.length, "sha256:changed");
  first.deltas[0]!.cwe.splice(0, first.deltas[0]!.cwe.length, "CWE-999");

  const second = evaluateGate(gateInput);
  assert.deepEqual(current.fingerprints, ["sha256:stable-xss"]);
  assert.deepEqual(current.cwe, ["CWE-79"]);
  assert.deepEqual(second.deltas[0]?.fingerprints, ["sha256:stable-xss"]);
  assert.deepEqual(second.deltas[0]?.cwe, ["CWE-79"]);
  assert.equal(second.deltas[0]?.lifecycle, "reopened");
  assert.equal(second.decision.outcome, "blocked");
});

test("retains baseline scan provenance for fixed findings", () => {
  const high = finding("stable-xss", "high");
  const result = evaluateGate(input({
    currentFindings: [],
    baselineFindings: [high],
    sourceScanId: "scan-current",
    baselineScanId: "scan-baseline",
  }));
  assert.equal(result.deltas[0]?.lifecycle, "fixed");
  assert.equal(result.deltas[0]?.sourceScanId, "scan-baseline");
});
