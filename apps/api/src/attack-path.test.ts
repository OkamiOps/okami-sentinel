import assert from "node:assert/strict";
import test from "node:test";
import type { FindingDetail } from "@csb/shared";
import { normalizeAttackPath } from "./attack-path.js";

function finding(overrides: Partial<FindingDetail> = {}): FindingDetail {
  return {
    findingId: "finding-1",
    occurrenceId: "occ-1",
    title: "Stored script reaches report writer",
    severity: "high",
    confidence: "high",
    ruleId: "xss.report",
    summary: "Stored markup reaches document.write.",
    primaryPath: "src/export.ts",
    fingerprints: ["sha256:one"],
    category: "Stored cross-site scripting",
    cwe: ["CWE-79"],
    attackPath: {
      evidenceRefs: ["source-1", "root_control-2", "sink-3"],
      dataflow: { summary: "Source reaches sink", outcome: "Script execution" },
      reachability: { attacker: "tenant member", preconditions: "Victim opens report" },
      impact: { level: "high", why: "Same-origin execution" },
      likelihood: { level: "high", why: "Reachable write" },
      limitations: ["Victim interaction is required"],
    },
    attackPathModel: null,
    codeEvidence: [
      { id: "source-1", role: "source", label: "Writable field", path: "src/input.ts", startLine: 10, endLine: 12, code: "save(input)", language: "typescript", explanation: "Attacker-controlled source" },
      { id: "root_control-2", role: "root_control", label: "Missing encoding", path: "src/export.ts", startLine: 20, endLine: 22, code: "return `<td>${value}</td>`", language: "typescript", explanation: "Closest control" },
      { id: "sink-3", role: "sink", label: "Document writer", path: "src/export.ts", startLine: 40, endLine: 40, code: "document.write(html)", language: "typescript", explanation: "Protected sink" },
    ],
    remediation: null,
    locations: null,
    taxonomy: null,
    rootCause: null,
    validation: { method: "source/sink trace", summary: "Validated statically" },
    preventiveControls: null,
    remediationTests: null,
    severityRationale: null,
    confidenceRationale: null,
    ...overrides,
  };
}

test("normalizes resolved evidence in declared order", () => {
  const model = normalizeAttackPath(finding());
  assert.equal(model?.status, "validated");
  assert.deepEqual(model?.lanes[0]?.nodes.map((node) => node.id), [
    "primary:attacker",
    "source-1",
    "root_control-2",
    "sink-3",
    "primary:outcome",
  ]);
  assert.equal(model?.lanes[0]?.nodes[1]?.evidenceState, "proven");
});

test("renders missing references as explicit gaps", () => {
  const raw = finding();
  const attack = raw.attackPath as { evidenceRefs: string[] };
  attack.evidenceRefs = ["source-1", "missing-control", "sink-3"];
  const model = normalizeAttackPath(raw);
  assert.equal(model?.status, "partial");
  assert.equal(model?.lanes[0]?.nodes[2]?.evidenceState, "missing");
});

test("uses code evidence when attackPath is absent", () => {
  const model = normalizeAttackPath(finding({ attackPath: null, validation: null }));
  assert.equal(model?.status, "partial");
  assert.equal(model?.lanes[0]?.id, "primary");
});

test("returns null when neither path nor evidence exists", () => {
  assert.equal(
    normalizeAttackPath(finding({ attackPath: null, codeEvidence: [], validation: null })),
    null,
  );
});

test("maps unknown roles to evidence", () => {
  const raw = finding({
    attackPath: null,
    validation: null,
    codeEvidence: [{ id: "odd-1", role: "custom_role", path: "src/a.ts" }],
  });
  assert.equal(normalizeAttackPath(raw)?.lanes[0]?.nodes[0]?.kind, "evidence");
});

test("produces stable ids across repeated normalization", () => {
  const first = normalizeAttackPath(finding());
  const second = normalizeAttackPath(finding());
  assert.deepEqual(
    first?.lanes[0]?.nodes.map((node) => node.id),
    second?.lanes[0]?.nodes.map((node) => node.id),
  );
});

test("normalizes explicit alternative paths without synthesizing lanes", () => {
  const raw = finding();
  raw.attackPath = {
    ...(raw.attackPath as Record<string, unknown>),
    paths: [
      { id: "write-path", label: "Write path", evidenceRefs: ["source-1", "sink-3"] },
      { id: "control-path", label: "Control path", evidenceRefs: ["root_control-2", "sink-3"] },
    ],
  };
  assert.deepEqual(
    normalizeAttackPath(raw)?.lanes.map((lane) => lane.id),
    ["write-path", "control-path"],
  );
});
