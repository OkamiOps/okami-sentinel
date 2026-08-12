import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubRepositorySourceAdapter,
  RepositorySourceInputError,
  parseEnrollGuardrailRepositoryRequest,
} from "./repository-source-adapter.js";
import type { GuardrailRepository } from "@csb/shared";

test("parses the discriminated Local and GitHub enrollment bodies", () => {
  assert.deepEqual(parseEnrollGuardrailRepositoryRequest({
    source: "local",
    repositoryPath: " /workspace/repository ",
    displayName: " Fixture ",
  }), {
    source: "local",
    repositoryPath: "/workspace/repository",
    displayName: "Fixture",
  });

  assert.deepEqual(parseEnrollGuardrailRepositoryRequest({
    source: "github",
    connectionId: "connection-1",
    installationId: "77",
    repositoryId: "991122",
    defaultExecutor: "sentinel-managed",
  }), {
    source: "github",
    connectionId: "connection-1",
    installationId: "77",
    repositoryId: "991122",
    defaultExecutor: "sentinel-managed",
  });
});

test("remote enrollment rejects client-authoritative paths, URLs, slugs and fields", () => {
  for (const extra of [
    { repositoryPath: "/tmp/repository" },
    { repositoryUrl: "https://github.com/attacker/repository" },
    { owner: "attacker", name: "repository" },
    { defaultBranch: "attacker-branch" },
  ]) {
    assert.throws(
      () => parseEnrollGuardrailRepositoryRequest({
        source: "github",
        connectionId: "connection-1",
        installationId: "77",
        repositoryId: "991122",
        defaultExecutor: "github-actions",
        ...extra,
      }),
      (error: unknown) => error instanceof RepositorySourceInputError
        && error.code === "repository_request_invalid",
    );
  }
});

test("enrollment rejects unknown sources, missing local paths and invalid executors", () => {
  for (const input of [
    { source: "gitlab", repositoryPath: "/workspace/repository" },
    { source: "local" },
    {
      source: "github",
      connectionId: "connection-1",
      installationId: "77",
      repositoryId: "991122",
      defaultExecutor: "remote-shell",
    },
  ]) {
    assert.throws(
      () => parseEnrollGuardrailRepositoryRequest(input),
      (error: unknown) => error instanceof RepositorySourceInputError,
    );
  }
});

test("reads PRs, commits and protected files through the authorized repository tuple", async () => {
  const calls: Array<{ path: string; permissions: unknown }> = [];
  const adapter = new GitHubRepositorySourceAdapter({
    readAuthorizedRepositoryJson: async (
      connectionId,
      installationId,
      repositoryId,
      path,
      permissions,
    ) => {
      assert.deepEqual([connectionId, installationId, repositoryId], ["connection-1", "77", "991122"]);
      calls.push({ path, permissions });
      if (path.includes("/contents/")) {
        const content = Buffer.from('{"schemaVersion":1}').toString("base64");
        return {
          type: "file",
          encoding: "base64",
          path: ".csb/guardrails.json",
          content,
          size: Buffer.byteLength('{"schemaVersion":1}'),
          sha: "c".repeat(40),
        };
      }
      return { sha: "a".repeat(40) };
    },
  });
  const repository = remoteRepository();

  assert.deepEqual(await adapter.readPullRequest(repository, 42), { sha: "a".repeat(40) });
  assert.deepEqual(await adapter.readCommit(repository, "feature/security"), { sha: "a".repeat(40) });
  assert.deepEqual(await adapter.readFile(repository, "b".repeat(40), ".csb/guardrails.json"), {
    path: ".csb/guardrails.json",
    content: '{"schemaVersion":1}',
    blobSha: "c".repeat(40),
  });
  assert.deepEqual(calls, [
    {
      path: "/repos/OkamiOps/private-sentinel/pulls/42",
      permissions: { pull_requests: "read" },
    },
    {
      path: "/repos/OkamiOps/private-sentinel/commits/feature%2Fsecurity",
      permissions: { contents: "read" },
    },
    {
      path: `/repos/OkamiOps/private-sentinel/contents/.csb/guardrails.json?ref=${"b".repeat(40)}`,
      permissions: { contents: "read" },
    },
  ]);
});

test("rejects non-canonical base64 instead of decoding a permissive provider payload", async () => {
  const adapter = new GitHubRepositorySourceAdapter({
    readAuthorizedRepositoryJson: async () => ({
      type: "file",
      encoding: "base64",
      path: ".csb/guardrails.json",
      content: "not!base64",
      size: 6,
      sha: "c".repeat(40),
    }),
  });
  await assert.rejects(
    adapter.readFile(remoteRepository(), "b".repeat(40), ".csb/guardrails.json"),
    (error: unknown) => error instanceof RepositorySourceInputError,
  );
});

function remoteRepository(): GuardrailRepository {
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
