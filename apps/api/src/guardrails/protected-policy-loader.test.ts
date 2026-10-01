import assert from "node:assert/strict";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";
import type {
  GateTarget,
  GuardrailRepository,
  ResolvedGateTarget,
} from "@csb/shared";

import { policyForPreset } from "./policy-presets.js";
import {
  ProtectedPolicyLoader,
  ProtectedPolicyLoaderError,
} from "./protected-policy-loader.js";
import type { GitHubRepositoryReader, RemoteRepositoryFile } from "./repository-source-adapter.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

test("loads policy and exceptions only from the frozen PR base SHA", async () => {
  const calls: Array<{ sha: string; path: string }> = [];
  const reader = policyReader(calls, new Map([
    [`${BASE_SHA}:.csb/guardrails.json`, JSON.stringify(defaultGuardrailPolicy())],
    [`${BASE_SHA}:.csb/guardrails-exceptions.json`, JSON.stringify({
      schemaVersion: 1,
      exceptions: [{
        findingIdentity: "finding-1",
        reason: "approved migration",
        owner: "security",
        createdAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-08-13T00:00:00.000Z",
        branches: ["main"],
        ruleIndexes: [],
      }],
    })],
    [`${HEAD_SHA}:.csb/guardrails.json`, JSON.stringify({ schemaVersion: 999 })],
  ]));

  const loaded = await new ProtectedPolicyLoader(reader).load(
    repository(),
    { kind: "pull_request", number: 42 },
    resolvedTarget(),
  );

  assert.equal(loaded.policySource, "repository_file");
  assert.equal(loaded.readOnly, true);
  assert.equal(loaded.fileInvalidReason, null);
  assert.equal(loaded.policySha, BASE_SHA);
  assert.deepEqual(loaded.policy, defaultGuardrailPolicy());
  assert.equal(loaded.exceptions.length, 1);
  assert.deepEqual(calls, [
    { sha: BASE_SHA, path: ".csb/guardrails.json" },
    { sha: BASE_SHA, path: ".csb/guardrails-exceptions.json" },
  ]);
});

test("uses the default policy only when the protected policy file is absent", async () => {
  const calls: Array<{ sha: string; path: string }> = [];
  const loaded = await new ProtectedPolicyLoader(policyReader(calls, new Map()), () => null).load(
    repository(),
    { kind: "compare", baseRef: "main", headRef: "feature" },
    resolvedTarget(),
  );

  assert.equal(loaded.policySource, "default");
  assert.equal(loaded.readOnly, false);
  assert.equal(loaded.fileInvalidReason, null);
  assert.deepEqual(loaded.policy, defaultGuardrailPolicy());
  assert.deepEqual(loaded.exceptions, []);
  assert.equal(calls.every((call) => call.sha === BASE_SHA), true);
});

test("loads protected-branch policy from its single resolved head SHA", async () => {
  const calls: Array<{ sha: string; path: string }> = [];
  const reader = policyReader(calls, new Map([
    [`${HEAD_SHA}:.csb/guardrails.json`, JSON.stringify(defaultGuardrailPolicy())],
  ]));
  const target: GateTarget = { kind: "protected_branch", ref: "main" };
  const resolved: ResolvedGateTarget = {
    baseRef: "main",
    headRef: "main",
    baseSha: HEAD_SHA,
    headSha: HEAD_SHA,
    policySha: HEAD_SHA,
    pullRequestNumber: null,
  };

  const loaded = await new ProtectedPolicyLoader(reader).load(repository(), target, resolved);
  assert.equal(loaded.policySource, "repository_file");
  assert.equal(calls.every((call) => call.sha === HEAD_SHA), true);
});

test("the Sentinel policy wins when the repository carries no file", async () => {
  const sentinel = policyForPreset("warn-only", ["main"]);
  const loaded = await new ProtectedPolicyLoader(policyReader([], new Map()), () => sentinel).load(
    repository(),
    { kind: "pull_request", number: 42 },
    resolvedTarget(),
  );
  assert.equal(loaded.policySource, "sentinel");
  assert.equal(loaded.readOnly, false);
  assert.deepEqual(loaded.policy, sentinel);
});

test("the repository file still wins over a saved Sentinel policy", async () => {
  const reader = policyReader([], new Map([
    [`${BASE_SHA}:.csb/guardrails.json`, JSON.stringify(policyForPreset("block-critical", ["main"]))],
  ]));
  const loaded = await new ProtectedPolicyLoader(reader, () => policyForPreset("warn-only", ["main"])).load(
    repository(),
    { kind: "pull_request", number: 42 },
    resolvedTarget(),
  );
  assert.equal(loaded.policySource, "repository_file");
  assert.equal(loaded.readOnly, true);
  assert.deepEqual(loaded.policy, policyForPreset("block-critical", ["main"]));
});

test("an invalid policy file reports the reason and falls to the Sentinel policy", async () => {
  const sentinel = policyForPreset("warn-only", ["main"]);
  for (const content of ["{", JSON.stringify({ ...defaultGuardrailPolicy(), schemaVersion: 2 })]) {
    const reader = policyReader([], new Map([
      [`${BASE_SHA}:.csb/guardrails.json`, content],
    ]));
    const loaded = await new ProtectedPolicyLoader(reader, () => sentinel).load(
      repository(),
      { kind: "pull_request", number: 42 },
      resolvedTarget(),
    );
    assert.equal(loaded.policySource, "sentinel");
    assert.equal(loaded.readOnly, false);
    assert.equal(loaded.fileInvalidReason, "policy_invalid");
    assert.deepEqual(loaded.policy, sentinel);
  }
});

test("an invalid policy file with nothing saved falls to the default, still reporting the reason", async () => {
  const reader = policyReader([], new Map([
    [`${BASE_SHA}:.csb/guardrails.json`, "{"],
  ]));
  const loaded = await new ProtectedPolicyLoader(reader, () => null).load(
    repository(),
    { kind: "pull_request", number: 42 },
    resolvedTarget(),
  );
  assert.equal(loaded.policySource, "default");
  assert.equal(loaded.fileInvalidReason, "policy_invalid");
  assert.deepEqual(loaded.policy, defaultGuardrailPolicy());
});

test("malformed protected exceptions fail closed with their own typed code", async () => {
  const reader = policyReader([], new Map([
    [`${BASE_SHA}:.csb/guardrails.json`, JSON.stringify(defaultGuardrailPolicy())],
    [`${BASE_SHA}:.csb/guardrails-exceptions.json`, JSON.stringify({ schemaVersion: 2, exceptions: [] })],
  ]));
  await assert.rejects(
    new ProtectedPolicyLoader(reader, () => null).load(
      repository(),
      { kind: "pull_request", number: 42 },
      resolvedTarget(),
    ),
    (error: unknown) => error instanceof ProtectedPolicyLoaderError
      && error.code === "protected_exceptions_invalid",
  );
});

function policyReader(
  calls: Array<{ sha: string; path: string }>,
  files: ReadonlyMap<string, string>,
): GitHubRepositoryReader {
  return {
    readPullRequest: async () => assert.fail("not used"),
    readCommit: async () => assert.fail("not used"),
    readFile: async (_repository, sha, path): Promise<RemoteRepositoryFile | null> => {
      calls.push({ sha, path });
      const content = files.get(`${sha}:${path}`);
      return content === undefined
        ? null
        : { path, content, blobSha: "c".repeat(40) };
    },
  };
}

function resolvedTarget(): ResolvedGateTarget {
  return {
    baseRef: "main",
    headRef: "feature/security",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    policySha: BASE_SHA,
    pullRequestNumber: 42,
  };
}

function repository(): GuardrailRepository {
  return {
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    displayName: "OkamiOps/private-sentinel",
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: "OkamiOps",
    remoteName: "private-sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "991122",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
  };
}
