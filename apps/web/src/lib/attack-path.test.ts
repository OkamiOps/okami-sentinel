import assert from "node:assert/strict";
import test from "node:test";
import type { AttackPathModel } from "@csb/shared";
import {
  attackPathHref,
  getAttackPathSelection,
  getAttackPathStageItems,
} from "./attack-path.js";

const model: AttackPathModel = {
  status: "validated",
  summary: "Source reaches sink.",
  preconditions: null,
  limitations: [],
  impact: { level: "high", rationale: null },
  likelihood: { level: "medium", rationale: null },
  warnings: [],
  lanes: [
    {
      id: "primary",
      label: "Primary path",
      nodes: [
        { id: "attacker", kind: "attacker", label: "Attacker", summary: null, evidenceState: "inferred", evidenceRef: null, location: null, code: null, language: null, explanation: null },
        { id: "source", kind: "source", label: "Source", summary: null, evidenceState: "proven", evidenceRef: "source", location: { path: "src/input.ts", startLine: 1, endLine: 2 }, code: "input", language: "typescript", explanation: null },
        { id: "entry", kind: "entrypoint", label: "Entry", summary: null, evidenceState: "proven", evidenceRef: "entry", location: null, code: null, language: null, explanation: null },
        { id: "control", kind: "control", label: "Control", summary: null, evidenceState: "missing", evidenceRef: "control", location: null, code: null, language: null, explanation: null },
        { id: "sink", kind: "sink", label: "Sink", summary: null, evidenceState: "proven", evidenceRef: "sink", location: null, code: null, language: null, explanation: null },
        { id: "outcome", kind: "outcome", label: "Outcome", summary: null, evidenceState: "inferred", evidenceRef: null, location: null, code: null, language: null, explanation: null },
      ],
    },
  ],
};

test("selects the first proven node by default", () => {
  const selected = getAttackPathSelection(model);
  assert.equal(selected.lane.id, "primary");
  assert.equal(selected.node?.id, "source");
});

test("falls back safely when the requested lane or node does not exist", () => {
  const selected = getAttackPathSelection(model, "missing", "also-missing");
  assert.equal(selected.lane.id, "primary");
  assert.equal(selected.node?.id, "source");
});

test("builds a stable explorer deep link", () => {
  assert.equal(
    attackPathHref({
      scanId: "current scan",
      findingId: "finding/1",
      evidenceScanId: "baseline scan",
      laneId: "primary",
      nodeId: "sink",
    }),
    "/scans/current%20scan/findings/finding%2F1/path?evidenceScan=baseline+scan&lane=primary&node=sink",
  );
});

test("compacts a long path without hiding its beginning or outcome", () => {
  const items = getAttackPathStageItems(model.lanes[0]!, true);
  assert.deepEqual(
    items.map((item) => item.type === "node" ? item.node.id : `+${item.count}`),
    ["attacker", "source", "+1", "control", "sink", "outcome"],
  );
});
