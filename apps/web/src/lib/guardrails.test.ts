import assert from "node:assert/strict";
import test from "node:test";

import type { DecisionGraph, GateArtifact, GateRun, GuardrailPolicy } from "@csb/shared";

import {
  editorStateFromPolicy,
  guardrailFindingBranches,
  guardrailHref,
  policyFromEditor,
  selectGuardrailFindingNode,
  selectDecisionNode,
  selectGate,
  validatePolicyEditor,
} from "./guardrails.js";

function largeArtifactFixture(count: number): GateArtifact {
  return {
    findings: Array.from({ length: count }, (_, index) => ({
      findingId: `finding-${index}`,
      occurrenceId: null,
      title: `Finding ${index}`,
      severity: index % 2 === 0 ? "critical" : "high",
      confidence: "high",
      ruleId: "rule",
      summary: null,
      primaryPath: `src/module-${index % 137}.ts`,
      fingerprints: [],
      category: "security",
      cwe: [],
      identity: `identity-${index}`,
      lifecycle: "new",
      triage: "unreviewed",
      exception: null,
      sourceScanId: "scan-1",
    })),
    decision: { decisionGraph: graphFixture() },
  } as unknown as GateArtifact;
}

function gatesFixture(): GateRun[] {
  return [
    {
      id: "gate-pass",
      repositoryKey: "repo-1",
      repositoryPath: "/tmp/repo-1",
      source: "local",
      executor: "sentinel-managed",
      baseRef: "main",
      headRef: "feature/pass",
      resolvedBaseSha: null,
      resolvedHeadSha: null,
      policySha: null,
      pullRequestNumber: null,
      workflowRunId: null,
      materializationState: "not_required",
      scanLineageHash: null,
      artifactSchemaVersion: 1,
      scanId: "scan-pass",
      status: "completed",
      outcome: "pass",
      policyVersion: 1,
      baselineCommit: "base-pass",
      artifactPath: "/tmp/gate-pass.json",
      publishStatus: "waiting",
      publishError: null,
      publishedAt: null,
      error: null,
      startedAt: "2026-08-07T10:00:00.000Z",
      completedAt: "2026-08-07T10:02:00.000Z",
      costCeilingUsd: 18,
      estimatedUsd: 0.42,
    },
    {
      id: "gate-blocked",
      repositoryKey: "repo-2",
      repositoryPath: "/tmp/repo-2",
      source: "local",
      executor: "sentinel-managed",
      baseRef: "main",
      headRef: "feature/blocked",
      resolvedBaseSha: null,
      resolvedHeadSha: null,
      policySha: null,
      pullRequestNumber: null,
      workflowRunId: null,
      materializationState: "not_required",
      scanLineageHash: null,
      artifactSchemaVersion: 1,
      scanId: "scan-blocked",
      status: "completed",
      outcome: "blocked",
      policyVersion: 1,
      baselineCommit: "base-blocked",
      artifactPath: "/tmp/gate-blocked.json",
      publishStatus: "waiting",
      publishError: null,
      publishedAt: null,
      error: null,
      startedAt: "2026-08-07T11:00:00.000Z",
      completedAt: "2026-08-07T11:03:00.000Z",
      costCeilingUsd: 18,
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

function policyFixture(): GuardrailPolicy {
  return {
    schemaVersion: 1,
    protectedBranches: ["main", "release"],
    scope: { mode: "changed", maxChangedPaths: 50, fallback: "repository" },
    scan: {
      model: "gpt-5.6-sol",
      effort: "high",
      mode: "standard",
      maxCostUsd: 18,
    },
    rules: [
      { severity: ["critical"], lifecycle: ["new", "reopened"], decision: "block" },
      { severity: ["high"], lifecycle: ["persistent"], decision: "review" },
    ],
  };
}

function editorFixture() {
  return editorStateFromPolicy(policyFixture());
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

test("groups one thousand guardrail findings into stable file branches without dropping nodes", () => {
  const artifact = largeArtifactFixture(1_000);
  const branches = guardrailFindingBranches(artifact);
  assert.equal(branches.length, 137);
  assert.equal(branches.flatMap((branch) => branch.findings).length, 1_000);
  assert.equal(new Set(branches.flatMap((branch) => branch.findings.map((item) => item.node.id))).size, 1_000);
  assert.equal(selectGuardrailFindingNode(artifact, "finding:identity-999")?.findingIdentity, "identity-999");
});

test("builds a reloadable guardrail URL", () => {
  assert.equal(
    guardrailHref("gate-1", "signal"),
    "/guardrails/gate-1?node=signal",
  );
});

test("serializes the visual editor without changing rule order", () => {
  const policy = policyFixture();
  assert.deepEqual(policyFromEditor(editorStateFromPolicy(policy)).rules, policy.rules);
});

test("rejects an invalid cost before calling the API", () => {
  assert.deepEqual(validatePolicyEditor({ ...editorFixture(), maxCostUsd: 0 }), {
    field: "maxCostUsd",
    message: "O envelope deve ser maior que US$ 0.",
  });
});
