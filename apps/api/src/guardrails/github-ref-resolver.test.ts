import assert from "node:assert/strict";
import test from "node:test";

import type { GuardrailRepository } from "@csb/shared";

import {
  GitHubRefResolver,
  GitHubTargetResolutionError,
  parseGateTarget,
} from "./github-ref-resolver.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

test("freezes pull request base and head SHAs without using the merge test commit", async () => {
  const calls: string[] = [];
  const resolver = new GitHubRefResolver({
    readPullRequest: async (_repository, number) => {
      calls.push(`pr:${number}`);
      return {
        number,
        base: { ref: "main", sha: BASE_SHA },
        head: { ref: "feature/security", sha: HEAD_SHA },
        merge_commit_sha: "c".repeat(40),
      };
    },
    readCommit: async () => assert.fail("PR resolution must not resolve refs again"),
    readFile: async () => null,
  });

  assert.deepEqual(
    await resolver.resolve(repository(), { kind: "pull_request", number: 42 }),
    {
      baseRef: "main",
      headRef: "feature/security",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      policySha: BASE_SHA,
      pullRequestNumber: 42,
    },
  );
  assert.deepEqual(calls, ["pr:42"]);
});

test("resolves compare refs exactly once and freezes the base policy SHA", async () => {
  const calls: string[] = [];
  const resolver = new GitHubRefResolver({
    readPullRequest: async () => assert.fail("compare does not read a PR"),
    readCommit: async (_repository, ref) => {
      calls.push(ref);
      return { sha: ref === "release/v1" ? BASE_SHA : HEAD_SHA };
    },
    readFile: async () => null,
  });

  assert.deepEqual(
    await resolver.resolve(repository(), {
      kind: "compare",
      baseRef: "release/v1",
      headRef: "feature/security",
    }),
    {
      baseRef: "release/v1",
      headRef: "feature/security",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      policySha: BASE_SHA,
      pullRequestNumber: null,
    },
  );
  assert.deepEqual(calls.sort(), ["feature/security", "release/v1"]);
});

test("resolves a protected branch once and uses that immutable SHA for both trees and policy", async () => {
  let calls = 0;
  const resolver = new GitHubRefResolver({
    readPullRequest: async () => assert.fail("protected branch does not read a PR"),
    readCommit: async (_repository, ref) => {
      calls += 1;
      assert.equal(ref, "main");
      return { sha: HEAD_SHA };
    },
    readFile: async () => null,
  });

  assert.deepEqual(
    await resolver.resolve(repository(), { kind: "protected_branch", ref: "main" }),
    {
      baseRef: "main",
      headRef: "main",
      baseSha: HEAD_SHA,
      headSha: HEAD_SHA,
      policySha: HEAD_SHA,
      pullRequestNumber: null,
    },
  );
  assert.equal(calls, 1);
});

test("rejects implicit HEAD, loose shapes and non-canonical provider SHAs", async () => {
  for (const value of [
    { kind: "compare", baseRef: "main", headRef: "HEAD" },
    { kind: "protected_branch", ref: "HEAD" },
    { kind: "pull_request", number: 1, headSha: HEAD_SHA },
  ]) {
    assert.throws(
      () => parseGateTarget(value),
      (error: unknown) => error instanceof GitHubTargetResolutionError
        && error.code === "github_target_invalid",
    );
  }

  const resolver = new GitHubRefResolver({
    readPullRequest: async () => ({
      number: 1,
      base: { ref: "main", sha: BASE_SHA.toUpperCase() },
      head: { ref: "feature", sha: HEAD_SHA },
    }),
    readCommit: async () => ({ sha: "short" }),
    readFile: async () => null,
  });
  await assert.rejects(
    resolver.resolve(repository(), { kind: "pull_request", number: 1 }),
    (error: unknown) => error instanceof GitHubTargetResolutionError
      && error.code === "github_target_invalid",
  );
});

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
