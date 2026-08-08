import assert from "node:assert/strict";
import test from "node:test";
import type { FindingSummary, Severity } from "@csb/shared";
import { buildFindingDiff, compareScans } from "./compare.js";

function finding(id: string, severity: Severity): FindingSummary {
  return {
    findingId: id,
    occurrenceId: null,
    title: `Finding ${id}`,
    severity,
    confidence: "high",
    ruleId: `rule-${id}`,
    summary: `Summary ${id}`,
    primaryPath: `src/${id}.ts`,
    fingerprints: [id],
    category: "test",
    cwe: ["CWE-79"],
  };
}

test("reports observed coverage without claiming that an absent finding was resolved", () => {
  const result = buildFindingDiff(
    "baseline",
    "candidate",
    new Map([
      ["baseline", [finding("baseline-only", "high"), finding("changed", "medium"), finding("same", "low")]],
      ["candidate", [finding("candidate-only", "critical"), finding("changed", "high"), finding("same", "low")]],
    ]),
  );

  assert.deepEqual(result.counts, {
    candidate_only: 1,
    baseline_only: 1,
    both: 1,
    severity_changed: 1,
  });
  assert.deepEqual(result.findings.map((item) => item.change), [
    "candidate_only",
    "severity_changed",
    "baseline_only",
    "both",
  ]);
  assert.equal(result.findings[0].candidate?.primaryPath, "src/candidate-only.ts");
  assert.equal(result.findings[2].candidate, null);
  assert.equal(result.findings[2].baseline?.primaryPath, "src/baseline-only.ts");
  assert.equal(result.findings[1].baseline?.severity, "medium");
  assert.equal(result.findings[1].candidate?.severity, "high");
});

test("accepts up to six scan slots before resolving their ids", () => {
  assert.throws(
    () => compareScans(Array.from({ length: 7 }, (_, index) => `missing-${index}`)),
    /Selecione de 2 a 6 scans/,
  );
  assert.throws(
    () => compareScans(Array.from({ length: 6 }, (_, index) => `missing-${index}`)),
    /Scan não encontrado: missing-0/,
  );
});
