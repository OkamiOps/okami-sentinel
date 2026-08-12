import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGateArtifactV2,
  buildScanLineage,
  defaultGuardrailPolicy,
} from "@csb/gate-core";
import type { GateArtifact, GateArtifactV2, GateFindingDelta } from "@csb/shared";

import type { GhRunner } from "./github-cli.js";
import {
  publishGateCheck,
  publishManagedGateCheck,
  type ManagedGitHubCheckClient,
} from "./github-check.js";

function finding(
  identity: string,
  severity: GateFindingDelta["severity"],
  lifecycle: GateFindingDelta["lifecycle"],
  primaryPath = "src/report.ts:88",
): GateFindingDelta {
  return {
    findingId: identity,
    occurrenceId: null,
    identity,
    title: lifecycle === "reopened" ? "High reaberto" : `Finding ${identity}`,
    severity,
    confidence: "high",
    ruleId: "CSB-1",
    summary: `Evidence for ${identity}`,
    primaryPath,
    fingerprints: [identity],
    category: "authorization",
    cwe: ["CWE-862"],
    lifecycle,
    triage: { status: "confirmed", note: null, updatedAt: null },
    exception: null,
    sourceScanId: "scan-1",
  };
}

function blockedArtifact(): GateArtifact {
  const reopened = finding("reopened-high", "high", "reopened");
  return {
    schemaVersion: 1,
    gateId: "gate-1",
    repository: {
      key: "github.com/OkamiOps/okami-sentinel",
      owner: "OkamiOps",
      name: "okami-sentinel",
      defaultBranch: "main",
    },
    source: "local",
    changeSet: {
      baseRef: "main",
      headRef: "HEAD",
      baseSha: "base-sha",
      headSha: "head-sha",
      files: [{
        status: "modified",
        path: "src/report.ts",
        previousPath: null,
        additions: 4,
        deletions: 1,
      }],
      scanPaths: ["src/report.ts"],
      scopeMode: "changed",
      fallbackReason: null,
    },
    policy: defaultGuardrailPolicy(),
    scan: { id: "scan-1", cost: null, status: "completed" },
    baselineCommit: "base-sha",
    findings: [
      finding("fixed-low", "low", "fixed"),
      finding("new-critical", "critical", "new"),
      reopened,
      ...Array.from({ length: 22 }, (_, index) =>
        finding(`medium-${String(index).padStart(2, "0")}`, "medium", "persistent")),
    ],
    decision: {
      outcome: "blocked",
      summary: "A reopened high finding blocks this change.",
      violations: [{
        findingIdentity: reopened.identity,
        ruleIndex: 1,
        decision: "block",
        reason: "high/reopened",
      }],
      warnings: [],
      exceptionsApplied: [],
      githubConclusion: "failure",
      decisionGraph: { nodes: [], selectedNodeId: "verdict" },
    },
    versions: { gateCore: "0.1.0", scanner: null },
    createdAt: "2026-08-07T10:00:00.000Z",
  };
}

function recordingGh(result: { exitCode?: number; stderr?: string } = {}): {
  runner: GhRunner;
  calls: Array<{ args: string[]; cwd: string; stdin?: string }>;
} {
  const calls: Array<{ args: string[]; cwd: string; stdin?: string }> = [];
  return {
    calls,
    runner: async (args, options) => {
      calls.push({ args, ...options });
      return {
        stdout: "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
  };
}

test("publishes a failure check for a blocked gate", async () => {
  const gh = recordingGh();
  const artifact = blockedArtifact();

  await publishGateCheck({
    artifact,
    owner: "OkamiOps",
    repository: "okami-sentinel",
    detailsUrl: null,
  }, gh.runner);

  assert.deepEqual(gh.calls[0]?.args, [
    "api",
    "--method",
    "POST",
    "repos/OkamiOps/okami-sentinel/check-runs",
    "--input",
    "-",
  ]);
  const payload = JSON.parse(gh.calls[0]?.stdin ?? "{}") as {
    name?: string;
    conclusion?: string;
    head_sha?: string;
    output?: { summary?: string; annotations?: Array<{ title?: string }> };
  };
  assert.equal(payload.name, "CSB Security Change Gate");
  assert.equal(payload.conclusion, "failure");
  assert.equal(payload.head_sha, artifact.changeSet.headSha);
  assert.ok(payload.output?.summary?.includes("High reaberto"));
  assert.equal(payload.output?.annotations?.length, 20);
  assert.deepEqual(
    payload.output?.annotations?.slice(0, 2).map((annotation) => annotation.title),
    ["Finding new-critical", "High reaberto"],
  );
});

test("never publishes absolute local paths", async () => {
  const gh = recordingGh();
  const artifact = blockedArtifact();
  artifact.findings[0]!.primaryPath = "/Users/marcos/private/src/report.ts:88";
  artifact.findings[0]!.summary = "Evidence at /Users/marcos/private/src/report.ts";
  artifact.decision.summary = "Generated from /Users/marcos/private";

  await publishGateCheck({
    artifact,
    owner: "OkamiOps",
    repository: "CSB",
    detailsUrl: null,
  }, gh.runner);

  assert.equal((gh.calls[0]?.stdin ?? "").includes("/Users/"), false);
});

test("reports a failed gh publication", async () => {
  const gh = recordingGh({ exitCode: 1, stderr: "GitHub API unavailable" });
  await assert.rejects(
    () => publishGateCheck({
      artifact: blockedArtifact(),
      owner: "OkamiOps",
      repository: "CSB",
      detailsUrl: null,
    }, gh.runner),
    /github.*unavailable/i,
  );
});

test("managed publisher creates once then updates by gate external_id", async () => {
  const artifact = managedArtifact();
  const writes: Array<{ path: string; method: "PATCH" | "POST"; body: unknown }> = [];
  let existing = false;
  const client: ManagedGitHubCheckClient = {
    readAuthorizedRepositoryJson: async (_connection, _installation, _repository, resourcePath) => {
      assert.equal(resourcePath.includes(artifact.resolvedTarget.headSha), true);
      return {
        check_runs: existing
          ? [{ id: 7788, external_id: artifact.gateId }]
          : [],
      };
    },
    writeAuthorizedRepositoryJson: async (
      _connection,
      _installation,
      _repository,
      resourcePath,
      method,
      body,
    ) => {
      writes.push({ path: resourcePath, method, body });
      existing = true;
      return { id: 7788 };
    },
  };
  const input = {
    artifact,
    authority: {
      connectionId: "connection-1",
      installationId: "77",
      repositoryId: "991122",
    },
    detailsUrl: "http://localhost:5173/guardrails/gates/gate-managed-1",
  };

  assert.equal(await publishManagedGateCheck(input, client), "created");
  assert.equal(await publishManagedGateCheck(input, client), "updated");
  assert.deepEqual(writes.map((call) => call.method), ["POST", "PATCH"]);
  assert.equal(writes[0]?.path, "/repos/OkamiOps/private-sentinel/check-runs");
  assert.equal(writes[1]?.path, "/repos/OkamiOps/private-sentinel/check-runs/7788");
  assert.equal((writes[0]?.body as { external_id?: string }).external_id, artifact.gateId);
  assert.equal(JSON.stringify(writes).includes("/private/"), false);
});

test("managed publisher refuses off-policy preflights and mismatched repository authority", async () => {
  const client: ManagedGitHubCheckClient = {
    readAuthorizedRepositoryJson: async () => assert.fail("must not read GitHub"),
    writeAuthorizedRepositoryJson: async () => assert.fail("must not write GitHub"),
  };
  const offPolicy = managedArtifact({ protectedBranches: ["release"] });
  await assert.rejects(
    publishManagedGateCheck({
      artifact: offPolicy,
      authority: { connectionId: "connection-1", installationId: "77", repositoryId: "991122" },
      detailsUrl: null,
    }, client),
    /not eligible/,
  );
  await assert.rejects(
    publishManagedGateCheck({
      artifact: managedArtifact(),
      authority: { connectionId: "connection-1", installationId: "77", repositoryId: "other" },
      detailsUrl: null,
    }, client),
    /not eligible/,
  );
});

function managedArtifact(
  policyOverrides: Partial<ReturnType<typeof defaultGuardrailPolicy>> = {},
): GateArtifactV2 {
  const policy = { ...defaultGuardrailPolicy(), ...policyOverrides };
  const delta = finding(`sha256:${"9".repeat(64)}`, "high", "new");
  return buildGateArtifactV2({
    gateId: "gate-managed-1",
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
    executor: "sentinel-managed",
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
        path: "src/report.ts",
        previousPath: null,
        additions: null,
        deletions: null,
      }],
      scanPaths: ["src/report.ts"],
      scopeMode: "changed",
      fallbackReason: null,
    },
    policy,
    scan: { id: "scan-1", cost: null, status: "completed" },
    baselineCommit: "a".repeat(40),
    evaluation: {
      deltas: [delta],
      decision: {
        outcome: "blocked",
        summary: "One blocking policy violation.",
        violations: [{
          findingIdentity: delta.identity,
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
      route: "minimax-token-plan",
      protocol: "anthropic-messages",
      provider: "minimax",
      model: "MiniMax-M3",
      reasoningEffort: "provider-managed",
      methodology: "sentinel/codex-security-methodology@v1",
      profile: "portable-v1",
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
      materializerVersion: "github-archive-v1",
    },
    workflowRun: null,
    versions: { gateCore: "0.2.0", scanner: "portable-v1" },
    createdAt: "2026-08-12T12:00:00.000Z",
  });
}
