import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChangeSet,
  GateArtifact,
  GateFindingDelta,
} from "@csb/shared";
import {
  buildGateArtifact,
  buildOperationalErrorArtifact,
  defaultGuardrailPolicy,
  parseGateArtifact,
  type BuildGateArtifactInput,
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

function finding(): GateFindingDelta {
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
  };
}

function artifactInput(): BuildGateArtifactInput {
  const findingDelta = finding();
  return {
    gateId: "gate-1",
    repository: {
      key: "github.com/okami/security-benchmark",
      owner: "okami",
      name: "security-benchmark",
      defaultBranch: "main",
    },
    source: "local",
    changeSet: changeSet(),
    policy: defaultGuardrailPolicy(),
    scan: {
      id: "scan-current",
      cost: {
        estimatedUsd: 1.25,
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 0,
        outputTokens: 50,
        model: "gpt-5.6-sol",
      },
      status: "completed",
    },
    baselineCommit: "base-sha",
    evaluation: {
      deltas: [findingDelta],
      decision: {
        outcome: "blocked",
        summary: "1 blocking policy violation(s).",
        violations: [{
          findingIdentity: findingDelta.identity,
          ruleIndex: 1,
          decision: "block",
          reason: "high/reopened",
        }],
        warnings: [],
        exceptionsApplied: [],
        githubConclusion: "failure",
      },
    },
    versions: { gateCore: "0.1.0", scanner: "1.2.3" },
    createdAt: "2026-08-07T12:00:00.000Z",
  };
}

function cloneArtifact(): Record<string, unknown> {
  return structuredClone(buildGateArtifact(artifactInput())) as unknown as Record<string, unknown>;
}

test("creates a schema v1 artifact without a local path", () => {
  const input = artifactInput() as BuildGateArtifactInput & {
    repositoryPath: string;
    artifactPath: string;
  };
  input.repositoryPath = "/Users/marcos/private-repository";
  input.artifactPath = "/Users/marcos/private-artifact.json";

  const artifact = buildGateArtifact(input);

  assert.equal(artifact.schemaVersion, 1);
  assert.equal(JSON.stringify(artifact).includes("/Users/"), false);
  assert.equal(artifact.decision.decisionGraph.nodes.length, 5);
  assert.deepEqual(Object.keys(artifact.repository), ["key", "owner", "name", "defaultBranch"]);
});

test("rejects an absolute local path in finding evidence", () => {
  const input = artifactInput();
  input.evaluation.deltas[0]!.primaryPath = "/Users/marcos/private-repository/src/report.ts:88";

  assert.throws(() => buildGateArtifact(input), /caminho absoluto local/);
});

test("requires publishable repository and commit identities", () => {
  assert.throws(
    () => buildGateArtifact({ ...artifactInput(), repository: { ...artifactInput().repository, key: " " } }),
    /repository\.key/,
  );
  assert.throws(
    () => buildGateArtifact({ ...artifactInput(), repository: { ...artifactInput().repository, name: "" } }),
    /repository\.name/,
  );
  assert.throws(
    () => buildGateArtifact({ ...artifactInput(), changeSet: { ...changeSet(), baseSha: "" } }),
    /changeSet\.baseSha/,
  );
  assert.throws(
    () => buildGateArtifact({ ...artifactInput(), changeSet: { ...changeSet(), headSha: " " } }),
    /changeSet\.headSha/,
  );
});

test("creates an action_required artifact for an operational failure", () => {
  const { evaluation: _evaluation, ...envelope } = artifactInput();
  const artifact = buildOperationalErrorArtifact({
    ...envelope,
    operationalSummary: "scanner unavailable",
  });

  assert.equal(artifact.decision.outcome, "error");
  assert.equal(artifact.decision.githubConclusion, "action_required");
  assert.equal(artifact.decision.decisionGraph.nodes.at(-1)?.value, "ERROR");
  assert.deepEqual(artifact.findings, []);
});

test("sanitizes operational details before publication", () => {
  const { evaluation: _evaluation, ...envelope } = artifactInput();
  const artifact = buildOperationalErrorArtifact({
    ...envelope,
    operationalSummary: " scanner\nfailed at /Users/marcos/private/repo and /tmp token=top-secret-value Authorization=Bearer bearer-secret ",
  });
  const serialized = JSON.stringify(artifact);

  assert.equal(serialized.includes("/Users/"), false);
  assert.equal(serialized.includes("/tmp"), false);
  assert.equal(serialized.includes("top-secret-value"), false);
  assert.equal(serialized.includes("bearer-secret"), false);
  assert.equal(artifact.decision.summary.includes("\n"), false);
});

test("parses a complete schema v1 artifact", () => {
  const artifact = buildGateArtifact(artifactInput());

  assert.deepEqual(parseGateArtifact(structuredClone(artifact)), artifact);
});

test("rejects an artifact from a future schema", () => {
  assert.throws(
    () => parseGateArtifact({ ...buildGateArtifact(artifactInput()), schemaVersion: 2 }),
    /GateArtifact schema 2 não suportado/,
  );
});

test("rejects malformed graph nodes and selections", () => {
  const malformedKind = cloneArtifact();
  const kindDecision = malformedKind.decision as Record<string, unknown>;
  const kindGraph = kindDecision.decisionGraph as Record<string, unknown>;
  const kindNodes = kindGraph.nodes as Array<Record<string, unknown>>;
  kindNodes[1]!.kind = "dependency";
  assert.throws(() => parseGateArtifact(malformedKind), /decisionGraph/);

  const malformedSelection = cloneArtifact();
  const selectionDecision = malformedSelection.decision as Record<string, unknown>;
  const selectionGraph = selectionDecision.decisionGraph as Record<string, unknown>;
  selectionGraph.selectedNodeId = "missing";
  assert.throws(() => parseGateArtifact(malformedSelection), /selectedNodeId/);
});

test("rejects malformed nested schema v1 fields", () => {
  const malformedChangeSet = cloneArtifact();
  const parsedChangeSet = malformedChangeSet.changeSet as Record<string, unknown>;
  const files = parsedChangeSet.files as Array<Record<string, unknown>>;
  files[0]!.status = "copied";
  assert.throws(() => parseGateArtifact(malformedChangeSet), /changeSet/);

  const malformedFinding = cloneArtifact();
  const findings = malformedFinding.findings as Array<Record<string, unknown>>;
  findings[0]!.severity = "urgent";
  assert.throws(() => parseGateArtifact(malformedFinding), /findings/);

  const malformedPolicy = cloneArtifact();
  const policy = malformedPolicy.policy as Record<string, unknown>;
  const rules = policy.rules as Array<Record<string, unknown>>;
  rules[0]!.decision = "ignore";
  assert.throws(() => parseGateArtifact(malformedPolicy), /policy/);

  const malformedCost = cloneArtifact();
  const scan = malformedCost.scan as Record<string, unknown>;
  const cost = scan.cost as Record<string, unknown>;
  cost.estimatedUsd = "free";
  assert.throws(() => parseGateArtifact(malformedCost), /scan/);
});

test("rejects unknown publishable fields and invalid timestamps", () => {
  const artifactWithPath = cloneArtifact();
  artifactWithPath.repositoryPath = "/Users/marcos/private-repository";
  assert.throws(() => parseGateArtifact(artifactWithPath), /GateArtifact/);

  const invalidTimestamp = cloneArtifact();
  invalidTimestamp.createdAt = "today";
  assert.throws(() => parseGateArtifact(invalidTimestamp), /createdAt/);
});

test("returns a GateArtifact type after runtime validation", () => {
  const parsed: GateArtifact = parseGateArtifact(buildGateArtifact(artifactInput()));
  assert.equal(parsed.gateId, "gate-1");
});
