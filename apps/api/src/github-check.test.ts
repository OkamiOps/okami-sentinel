import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";

import {
  buildGateArtifactV2,
  buildScanLineage,
  defaultGuardrailPolicy,
} from "@csb/gate-core";
import type { GateArtifactV2, GateFindingDelta } from "@csb/shared";

import {
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

test("a pull request to an unprotected base is published all the same", async () => {
  // Phase 3 widened `publication.eligible`: the Check is informational, and the
  // author of a pull request to any base asked the same question.
  const writes: string[] = [];
  const result = await publishManagedGateCheck({
    artifact: managedArtifact({ protectedBranches: ["release"] }),
    authority: { connectionId: "connection-1", installationId: "77", repositoryId: "991122" },
    detailsUrl: null,
  }, {
    readAuthorizedRepositoryJson: async () => ({ check_runs: [] }),
    writeAuthorizedRepositoryJson: async (_c, _i, _r, path) => {
      writes.push(path);
      return { id: 1 };
    },
  });
  assert.equal(result, "created");
  assert.deepEqual(writes, ["/repos/OkamiOps/private-sentinel/check-runs"]);
});

test("managed publisher refuses a mismatched repository authority", async () => {
  const client: ManagedGitHubCheckClient = {
    readAuthorizedRepositoryJson: async () => assert.fail("must not read GitHub"),
    writeAuthorizedRepositoryJson: async () => assert.fail("must not write GitHub"),
  };
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

test("the check carries a details url pointing at the gate", async () => {
  const artifact = managedArtifact();
  let payload: Record<string, unknown> = {};
  await publishManagedGateCheck({
    artifact,
    authority: { connectionId: "connection-1", installationId: "77", repositoryId: "991122" },
    detailsUrl: "https://sentinel.example/guardrails/gate-managed-1",
  }, {
    readAuthorizedRepositoryJson: async () => ({ check_runs: [] }),
    writeAuthorizedRepositoryJson: async (_c, _i, _r, _path, _method, body) => {
      payload = body as Record<string, unknown>;
      return { id: 1 };
    },
  });
  assert.equal(payload.details_url, "https://sentinel.example/guardrails/gate-managed-1");
});

test("the check summary says it is informational", async () => {
  let payload: { output?: { summary?: string; text?: string } } = {};
  await publishManagedGateCheck({
    artifact: managedArtifact(),
    authority: { connectionId: "connection-1", installationId: "77", repositoryId: "991122" },
    detailsUrl: null,
  }, {
    readAuthorizedRepositoryJson: async () => ({ check_runs: [] }),
    writeAuthorizedRepositoryJson: async (_c, _i, _r, _path, _method, body) => {
      payload = body as { output?: { summary?: string; text?: string } };
      return { id: 1 };
    },
  });
  assert.match(payload.output?.summary ?? "", /This check is informational/);
  assert.match(payload.output?.text ?? "", /This check is informational/);
});

test("publishGateCheck no longer exists", async () => {
  const module = await import("./github-check.js") as Record<string, unknown>;
  assert.equal("publishGateCheck" in module, false);
  assert.equal("PublishGateCheckInput" in module, false);
  // No gh runner: the Check is published with the App credential, everywhere.
  const source = await readFile(new URL("./github-check.ts", import.meta.url), "utf8");
  assert.equal(source.includes("github-cli"), false);
});

/**
 * `github-cli.ts` stays, for exactly one reader: the Git state of a repository that
 * lives in a folder on this machine. Any second importer would be a publication
 * path that needs a credential the GitHub App already carries.
 */
test("github-status.ts is the only module that reaches for the gh runner", async () => {
  const sources = await readdir(new URL("./", import.meta.url), { recursive: true });
  const importers: string[] = [];
  for (const entry of sources) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const text = await readFile(new URL(`./${entry}`, import.meta.url), "utf8");
    if (/from "\.{1,2}\/?[^"]*github-cli\.js"/.test(text)) importers.push(entry);
  }
  assert.deepEqual(importers.sort(), ["github-status.ts"]);
});
