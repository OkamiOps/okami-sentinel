import assert from "node:assert/strict";
import test from "node:test";

import type { DecisionGraph, GateRun } from "@csb/shared";

import {
  guardrailHref,
  selectDecisionNode,
  selectGate,
} from "./guardrails.js";

function gatesFixture(): GateRun[] {
  return [
    {
      id: "gate-pass",
      repositoryKey: "repo-1",
      repositoryPath: "/tmp/repo-1",
      source: "local",
      baseRef: "main",
      headRef: "feature/pass",
      pullRequestNumber: null,
      scanId: "scan-pass",
      status: "completed",
      outcome: "pass",
      policyVersion: 1,
      baselineCommit: "base-pass",
      artifactPath: "/tmp/gate-pass.json",
      error: null,
      startedAt: "2026-08-07T10:00:00.000Z",
      completedAt: "2026-08-07T10:02:00.000Z",
      estimatedUsd: 0.42,
    },
    {
      id: "gate-blocked",
      repositoryKey: "repo-2",
      repositoryPath: "/tmp/repo-2",
      source: "local",
      baseRef: "main",
      headRef: "feature/blocked",
      pullRequestNumber: null,
      scanId: "scan-blocked",
      status: "completed",
      outcome: "blocked",
      policyVersion: 1,
      baselineCommit: "base-blocked",
      artifactPath: "/tmp/gate-blocked.json",
      error: null,
      startedAt: "2026-08-07T11:00:00.000Z",
      completedAt: "2026-08-07T11:03:00.000Z",
      estimatedUsd: 0.85,
    },
  ];
}

function graphFixture(): DecisionGraph {
  return {
    selectedNodeId: "signal",
    nodes: [
      {
        id: "signal",
        kind: "signal",
        label: "Sinal",
        value: "Finding novo",
        detail: "high",
        tone: "risk",
        findingIdentity: "finding-1",
      },
      {
        id: "rule",
        kind: "rule",
        label: "Regra",
        value: "Bloquear high novo",
        detail: "Regra 1",
        tone: "risk",
        findingIdentity: "finding-1",
      },
    ],
  };
}

test("selects the requested gate or falls back to the first blocked lane", () => {
  assert.equal(selectGate(gatesFixture(), "gate-pass")?.id, "gate-pass");
  assert.equal(selectGate(gatesFixture(), null)?.id, "gate-blocked");
});

test("selects a valid graph node and falls back to the graph default", () => {
  const graph = graphFixture();
  assert.equal(selectDecisionNode(graph, "rule")?.id, "rule");
  assert.equal(
    selectDecisionNode(graph, "missing")?.id,
    graph.selectedNodeId,
  );
});

test("builds a reloadable guardrail URL", () => {
  assert.equal(
    guardrailHref("gate-1", "signal"),
    "/guardrails/gate-1?node=signal",
  );
});
