import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChangeSet,
  GateArtifactV2,
  GateFindingDelta,
} from "@csb/shared";
import {
  buildGateArtifact,
  buildGateArtifactV2,
  buildScanLineage,
  defaultGuardrailPolicy,
  selectGateBaseline,
  type BuildGateArtifactInput,
  type BuildGateArtifactV2Input,
} from "./index.js";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);

function changeSet(): ChangeSet {
  return {
    baseRef: "main",
    headRef: "refs/pull/7/head",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
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
    lifecycle: "new",
    triage: { status: "unreviewed", note: null, updatedAt: null },
    exception: null,
    sourceScanId: "scan-baseline",
  };
}

function v2Input(executor: BuildGateArtifactV2Input["executor"] = "sentinel-managed"): BuildGateArtifactV2Input {
  const policy = defaultGuardrailPolicy();
  const delta = finding();
  const protectedChangeSet = changeSet();
  protectedChangeSet.baseRef = "main";
  protectedChangeSet.headRef = "main";
  return {
    gateId: "gate-baseline",
    repository: {
      id: "github:4242",
      key: "github:4242",
      owner: "okami",
      name: "security-benchmark",
      defaultBranch: "main",
      locator: {
        kind: "github",
        repositoryId: "4242",
        owner: "okami",
        name: "security-benchmark",
      },
    },
    source: "github",
    executor,
    target: { kind: "protected_branch", ref: "main" },
    resolvedTarget: {
      baseRef: "main",
      headRef: "main",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      policySha: HEAD_SHA,
      pullRequestNumber: null,
    },
    policySource: "protected_branch",
    changeSet: protectedChangeSet,
    policy,
    scan: { id: "scan-baseline", cost: null, status: "completed" },
    baselineCommit: null,
    evaluation: {
      deltas: [delta],
      decision: {
        outcome: "bootstrap",
        summary: "Baseline initialized.",
        violations: [],
        warnings: [],
        exceptionsApplied: [],
        githubConclusion: "neutral",
      },
    },
    lineage: buildScanLineage({
      engine: "codex-security",
      engineVersion: "1.2.3",
      route: "minimax-token-plan",
      protocol: "anthropic-messages",
      provider: "minimax",
      model: "MiniMax-M3",
      reasoningEffort: "provider-default",
      methodology: "portable-codex-security",
      profile: "deep",
      recipeHash: `sha256:${"a".repeat(64)}`,
      sourceRevision: `sha256:${"b".repeat(64)}`,
    }),
    coverage: {
      status: "complete",
      repositoryFileCount: 20,
      inspectedFileCount: 20,
      unexaminedFileCount: 0,
      submodules: [],
      lfsPointers: [],
    },
    snapshot: {
      identity: `sha256:${"c".repeat(64)}`,
      materializerVersion: "snapshot-v1",
    },
    workflowRun: null,
    versions: { gateCore: "0.2.0", scanner: "1.2.3" },
    createdAt: "2026-08-12T00:00:00.000Z",
  };
}

function context(artifact: GateArtifactV2 = buildGateArtifactV2(v2Input())): {
  repositoryId: string;
  protectedBranch: string | null;
  lineage: GateArtifactV2["lineage"];
  policySchemaVersion: number;
  coverage: GateArtifactV2["coverage"];
} {
  return {
    repositoryId: artifact.repository.id,
    protectedBranch: artifact.publication.protectedBranch,
    lineage: artifact.lineage,
    policySchemaVersion: artifact.policy.schemaVersion,
    coverage: artifact.coverage,
  };
}

test("models absent, unavailable, incompatible and comparable baselines", () => {
  const baseline = buildGateArtifactV2(v2Input());
  assert.equal(selectGateBaseline(context(baseline), { kind: "absent" }).kind, "absent");
  assert.equal(selectGateBaseline(context(baseline), {
    kind: "unavailable",
    reason: "artifact download failed",
  }).kind, "unavailable");
  assert.equal(selectGateBaseline(context(baseline), {
    kind: "artifact",
    artifact: baseline,
  }).kind, "comparable");
});

test("keeps executor differences comparable", () => {
  const baseline = buildGateArtifactV2(v2Input("github-actions"));
  const current = buildGateArtifactV2(v2Input("sentinel-managed"));

  assert.equal(selectGateBaseline(context(current), {
    kind: "artifact",
    artifact: baseline,
  }).kind, "comparable");
});

test("never uses a pull-request artifact as the protected-branch baseline", () => {
  const baseline = buildGateArtifactV2(v2Input());
  const pullRequest = v2Input();
  pullRequest.target = { kind: "pull_request", number: 7 };
  pullRequest.resolvedTarget = {
    ...pullRequest.resolvedTarget,
    headRef: "refs/pull/7/head",
    policySha: pullRequest.resolvedTarget.baseSha,
    pullRequestNumber: 7,
  };
  pullRequest.policySource = "base";
  pullRequest.changeSet = {
    ...pullRequest.changeSet,
    headRef: "refs/pull/7/head",
  };

  const selected = selectGateBaseline(context(baseline), {
    kind: "artifact",
    artifact: buildGateArtifactV2(pullRequest),
  });
  assert.deepEqual(selected, { kind: "incompatible", reason: "publication" });
});

test("rejects v1 and every decision-grade comparability mismatch", () => {
  const baseline = buildGateArtifactV2(v2Input());
  const legacyInput = v2Input();
  const legacy = buildGateArtifact({
    gateId: legacyInput.gateId,
    repository: legacyInput.repository,
    source: legacyInput.source,
    changeSet: legacyInput.changeSet,
    policy: legacyInput.policy,
    scan: legacyInput.scan,
    baselineCommit: legacyInput.baselineCommit,
    evaluation: legacyInput.evaluation,
    versions: legacyInput.versions,
    createdAt: legacyInput.createdAt,
  } as BuildGateArtifactInput);
  assert.equal(selectGateBaseline(context(baseline), {
    kind: "artifact",
    artifact: legacy,
  }).kind, "incompatible");

  const mismatches: Array<[string, ReturnType<typeof context>]> = [
    ["repository", { ...context(baseline), repositoryId: "github:999" }],
    ["branch", { ...context(baseline), protectedBranch: "release" }],
    ["lineage", {
      ...context(baseline),
      lineage: buildScanLineage({
        ...v2Input().lineage,
        methodology: "google-mantis",
      }),
    }],
    ["source revision", {
      ...context(baseline),
      lineage: buildScanLineage({
        ...v2Input().lineage,
        sourceRevision: `sha256:${"e".repeat(64)}`,
      }),
    }],
    ["policy", { ...context(baseline), policySchemaVersion: 2 }],
    ["coverage", {
      ...context(baseline),
      coverage: { ...baseline.coverage, status: "partial", unexaminedFileCount: 1 },
    }],
  ];

  for (const [name, candidate] of mismatches) {
    const selected = selectGateBaseline(candidate, { kind: "artifact", artifact: baseline });
    assert.equal(selected.kind, "incompatible", name);
  }
});
