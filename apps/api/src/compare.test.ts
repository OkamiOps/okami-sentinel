import assert from "node:assert/strict";
import test from "node:test";
import type { FindingSummary, Severity } from "@csb/shared";
import { buildFindingDiff } from "./compare.js";

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

test("builds an evidence diff with introduced, resolved and severity changes", () => {
  const result = buildFindingDiff(
    "baseline",
    "candidate",
    new Map([
      ["baseline", [finding("resolved", "high"), finding("changed", "medium"), finding("same", "low")]],
      ["candidate", [finding("introduced", "critical"), finding("changed", "high"), finding("same", "low")]],
    ]),
  );

  assert.deepEqual(result.counts, {
    introduced: 1,
    resolved: 1,
    persistent: 1,
    severity_changed: 1,
  });
  assert.deepEqual(result.findings.map((item) => item.change), [
    "introduced",
    "severity_changed",
    "resolved",
    "persistent",
  ]);
  assert.equal(result.findings[0].candidate?.primaryPath, "src/introduced.ts");
  assert.equal(result.findings[1].baseline?.severity, "medium");
  assert.equal(result.findings[1].candidate?.severity, "high");
});
