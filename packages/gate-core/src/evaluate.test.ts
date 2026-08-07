import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChangeSet,
  FindingSummary,
  GuardrailException,
  Severity,
} from "@csb/shared";
import {
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
  const result = evaluateGate(input({ baselineFindings: null }));
  assert.equal(result.decision.outcome, "bootstrap");
  assert.equal(result.decision.githubConclusion, "neutral");
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
