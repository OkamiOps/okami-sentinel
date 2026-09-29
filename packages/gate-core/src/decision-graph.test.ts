import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChangeSet,
  GateFindingDelta,
  GateDecision,
} from "@csb/shared";
import {
  buildDecisionGraph,
  type EvaluateGateResult,
} from "./index.js";

function changeSet(): ChangeSet {
  return {
    baseRef: "main",
    headRef: "HEAD",
    baseSha: "base-sha",
    headSha: "head-sha",
    files: [{
      status: "modified",
      path: "src/report.ts",
      previousPath: null,
      additions: 1,
      deletions: 0,
    }],
    scanPaths: ["src/report.ts"],
    scopeMode: "changed",
    fallbackReason: null,
  };
}

function delta(overrides: Partial<GateFindingDelta> = {}): GateFindingDelta {
  return {
    findingId: "finding-1",
    occurrenceId: null,
    title: "Stored XSS",
    severity: "high",
    confidence: "high",
    ruleId: "CWE-79",
    summary: null,
    primaryPath: "src/report.ts:88",
    fingerprints: ["sha256:stable-xss"],
    category: "Stored cross-site scripting",
    cwe: ["CWE-79"],
    identity: "fp:sha256:stable-xss",
    lifecycle: "reopened",
    triage: { status: "unreviewed", note: null, updatedAt: null },
    exception: null,
    sourceScanId: "scan-current",
    ...overrides,
  };
}

function decision(overrides: Partial<EvaluateGateResult["decision"]> = {}): EvaluateGateResult["decision"] {
  return {
    outcome: "blocked",
    summary: "1 blocking policy violation(s).",
    violations: [{
      findingIdentity: "fp:sha256:stable-xss",
      ruleIndex: 1,
      decision: "block",
      reason: "high/reopened",
    }],
    warnings: [],
    exceptionsApplied: [],
    githubConclusion: "failure",
    ...overrides,
  };
}

test("builds five causal nodes for the primary blocking violation", () => {
  const finding = delta();
  const graph = buildDecisionGraph(changeSet(), [finding], decision());

  assert.deepEqual(
    graph.nodes.map((node) => node.kind),
    ["changeset", "surface", "signal", "rule", "verdict"],
  );
  assert.equal(graph.nodes[2]?.value, "Stored XSS reaberto");
  assert.equal(graph.nodes[4]?.value, "BLOCKED");
  assert.equal(graph.selectedNodeId, graph.nodes[2]?.id);
});

test("does not invent a surface when evidence is absent", () => {
  const finding = delta({ category: null, primaryPath: null });
  const graph = buildDecisionGraph(
    changeSet(),
    [finding],
    decision({
      outcome: "pass",
      summary: "No policy violations.",
      violations: [],
      githubConclusion: "success",
    }),
  );

  assert.equal(graph.nodes[1]?.value, "Não determinado");
  assert.equal(graph.nodes[1]?.tone, "neutral");
});

test("prefers a blocking violation over warnings and other deltas", () => {
  const unrelated = delta({
    findingId: "finding-warning",
    identity: "fp:warning",
    title: "Persistent issue",
    lifecycle: "persistent",
  });
  const blocking = delta();
  const gateDecision: Omit<GateDecision, "decisionGraph"> = decision({
    warnings: [{
      findingIdentity: "fp:warning",
      ruleIndex: 2,
      decision: "review",
      reason: "high/persistent",
    }],
  });

  const graph = buildDecisionGraph(changeSet(), [unrelated, blocking], gateDecision);

  assert.equal(graph.nodes[2]?.findingIdentity, blocking.identity);
  assert.equal(graph.nodes[2]?.value, "Stored XSS reaberto");
});

test("redacts every node string the scanner can reach", () => {
  const leaking = delta({
    title: "Credencial exposta no token:",
    lifecycle: "new",
    category: "/home/runner/app",
    confidence: "/Users/marcos/private",
  });
  const graph = buildDecisionGraph(
    changeSet(),
    [leaking],
    decision({
      violations: [{
        findingIdentity: leaking.identity,
        ruleIndex: 1,
        decision: "block",
        reason: "high/new",
      }],
    }),
  );

  assert.equal(graph.nodes[1]?.value, "[LOCAL_PATH]");
  assert.equal(graph.nodes[2]?.value, "Credencial exposta no [REDACTED]");
  assert.equal(graph.nodes[2]?.detail, "high · [LOCAL_PATH]");
  for (const node of graph.nodes) {
    assert.equal(node.value.trim().length > 0, true, node.id);
    assert.equal(node.label.trim().length > 0, true, node.id);
  }
});

test("falls back to a determinate surface when the evidence is blank", () => {
  const graph = buildDecisionGraph(changeSet(), [delta({ category: "", primaryPath: "" })], decision());

  assert.equal(graph.nodes[1]?.value, "Não determinado");
  assert.equal(graph.nodes[1]?.tone, "neutral");
  assert.equal(graph.nodes[1]?.detail, null);
});

test("falls back to the first non-fixed delta without inventing a rule", () => {
  const fixed = delta({ identity: "fp:fixed", lifecycle: "fixed", title: "Fixed issue" });
  const current = delta({ identity: "fp:current", lifecycle: "new", title: "Current issue" });
  const graph = buildDecisionGraph(
    changeSet(),
    [fixed, current],
    decision({
      outcome: "pass",
      summary: "No policy violations.",
      violations: [],
      warnings: [],
      githubConclusion: "success",
    }),
  );

  assert.equal(graph.nodes[2]?.findingIdentity, current.identity);
  assert.equal(graph.nodes[3]?.findingIdentity, null);
  assert.equal(graph.nodes[3]?.tone, "neutral");
});
