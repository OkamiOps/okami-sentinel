import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGateArtifactV2,
  buildScanLineage,
  defaultGuardrailPolicy,
} from "@csb/gate-core";
import type { GateArtifactV2 } from "@csb/shared";

import {
  publishActionsGateCheck,
  type ActionsGitHubTransport,
} from "./actions-check-publisher.js";

interface RecordedRequest {
  method: "GET" | "PATCH" | "POST";
  path: string;
  body: unknown;
}

test("creates once and then updates the Actions-owned Check by gate external_id", async () => {
  const artifact = actionsArtifact();
  const requests: RecordedRequest[] = [];
  let existing = false;
  const transport: ActionsGitHubTransport = {
    request: async (method, resourcePath, body = null) => {
      requests.push({ method, path: resourcePath, body });
      if (method === "GET") {
        return {
          check_runs: existing
            ? [{ id: 7788, external_id: artifact.gateId }]
            : [{ id: 1111, external_id: "another-gate" }],
        };
      }
      existing = true;
      return { id: 7788 };
    },
  };

  assert.equal(await publishActionsGateCheck({
    artifact,
    expectedRepository: "OkamiOps/private-sentinel",
    detailsUrl: "https://github.com/OkamiOps/private-sentinel/actions/runs/123",
  }, transport), "created");
  assert.equal(await publishActionsGateCheck({
    artifact,
    expectedRepository: "OkamiOps/private-sentinel",
    detailsUrl: null,
  }, transport), "updated");

  assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST", "GET", "PATCH"]);
  assert.match(requests[0]!.path, new RegExp(artifact.resolvedTarget.headSha));
  assert.match(requests[3]!.path, /check-runs\/7788$/);
  const create = requests[1]!.body as Record<string, unknown>;
  assert.equal(create.external_id, artifact.gateId);
  assert.equal(create.head_sha, artifact.resolvedTarget.headSha);
  assert.equal(create.conclusion, "failure");
});

test("rejects ambiguous or mismatched Check identity without a write", async () => {
  const artifact = actionsArtifact();
  for (const checkRuns of [
    [
      { id: 1, external_id: artifact.gateId },
      { id: 2, external_id: artifact.gateId },
    ],
  ]) {
    let writes = 0;
    const transport: ActionsGitHubTransport = {
      request: async (method) => {
        if (method !== "GET") writes += 1;
        return { check_runs: checkRuns };
      },
    };
    await assert.rejects(
      publishActionsGateCheck({
        artifact,
        expectedRepository: "OkamiOps/private-sentinel",
        detailsUrl: null,
      }, transport),
      /ambiguous/i,
    );
    assert.equal(writes, 0);
  }

  const noWrite: ActionsGitHubTransport = {
    request: async () => {
      throw new Error("transport must not be called");
    },
  };
  await assert.rejects(
    publishActionsGateCheck({
      artifact,
      expectedRepository: "OkamiOps/another-repository",
      detailsUrl: null,
    }, noWrite),
    /repository identity/i,
  );
  await assert.rejects(
    publishActionsGateCheck({
      artifact: { ...artifact, executor: "sentinel-managed" },
      expectedRepository: "OkamiOps/private-sentinel",
      detailsUrl: null,
    }, noWrite),
    /not eligible/i,
  );
});

function actionsArtifact(): GateArtifactV2 {
  const policy = defaultGuardrailPolicy();
  const identity = `sha256:${"9".repeat(64)}`;
  const finding = {
    findingId: identity,
    occurrenceId: null,
    identity,
    title: "Authentication boundary bypass",
    severity: "high" as const,
    confidence: "high" as const,
    ruleId: "CSB-1",
    summary: "Untrusted input reaches an authorization-sensitive sink.",
    primaryPath: "src/auth.ts:42",
    fingerprints: [identity],
    category: "authorization",
    cwe: ["CWE-862"],
    lifecycle: "new" as const,
    triage: { status: "confirmed" as const, note: null, updatedAt: null },
    exception: null,
    sourceScanId: "scan-actions-1",
  };
  return buildGateArtifactV2({
    gateId: "gate-actions-1",
    repository: {
      id: "github:991122",
      key: "github:991122",
      owner: "OkamiOps",
      name: "private-sentinel",
      defaultBranch: "main",
      locator: {
        kind: "github",
        repositoryId: "991122",
        owner: "OkamiOps",
        name: "private-sentinel",
      },
    },
    source: "github",
    executor: "github-actions",
    target: { kind: "pull_request", number: 7 },
    resolvedTarget: {
      baseRef: "main",
      headRef: "refs/pull/7/head",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      policySha: "a".repeat(40),
      pullRequestNumber: 7,
    },
    policySource: "base",
    changeSet: {
      baseRef: "main",
      headRef: "refs/pull/7/head",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      files: [{
        status: "modified",
        path: "src/auth.ts",
        previousPath: null,
        additions: null,
        deletions: null,
      }],
      scanPaths: ["src/auth.ts"],
      scopeMode: "changed",
      fallbackReason: null,
    },
    policy,
    scan: { id: "scan-actions-1", cost: null, status: "completed" },
    baselineCommit: "a".repeat(40),
    evaluation: {
      deltas: [finding],
      decision: {
        outcome: "blocked",
        summary: "One blocking policy violation.",
        violations: [{
          findingIdentity: identity,
          ruleIndex: 1,
          decision: "block",
          reason: "high/new",
        }],
        warnings: [],
        exceptionsApplied: [],
        githubConclusion: "failure",
      },
    },
    lineage: buildScanLineage({
      engine: "codex-security",
      engineVersion: "portable-v1",
      route: "openai-api",
      protocol: "codex-security-cli",
      provider: "openai",
      model: policy.scan.model,
      reasoningEffort: policy.scan.effort,
      methodology: "openai/codex-security",
      profile: policy.scan.mode,
      recipeHash: `sha256:${"d".repeat(64)}`,
      sourceRevision: `sha256:${"e".repeat(64)}`,
    }),
    coverage: {
      status: "complete",
      repositoryFileCount: 1,
      inspectedFileCount: 1,
      unexaminedFileCount: 0,
      submodules: [],
      lfsPointers: [],
    },
    snapshot: {
      identity: `sha256:${"c".repeat(64)}`,
      materializerVersion: "actions-git-index-v1",
    },
    workflowRun: { id: "123", attempt: 1 },
    versions: { gateCore: "0.2.0", scanner: "portable-v1" },
    createdAt: "2026-08-12T12:00:00.000Z",
  });
}
