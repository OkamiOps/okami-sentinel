import assert from "node:assert/strict";
import test from "node:test";

import type { GuardrailRepository } from "@csb/shared";

import {
  GitHubRepositoryEnrollmentError,
  GitHubRepositoryService,
} from "./github-repository-service.js";

const localRepository: GuardrailRepository = {
  repositoryKey: "local/fixture",
  repositoryPath: "/workspace/fixture",
  source: "local",
  displayName: "fixture",
  defaultBranch: "main",
  defaultExecutor: "sentinel-managed",
  remoteOwner: null,
  remoteName: null,
  githubConnectionId: null,
  githubInstallationId: null,
  githubRepositoryId: null,
  enabled: true,
  policyPath: ".csb/guardrails.json",
  lastGateId: null,
  githubStatus: "not_configured",
};

test("remote enrollment derives identity only from the authorized repository record", async () => {
  const service = new GitHubRepositoryService({
    inspectLocal: async () => localRepository,
    requireAuthorizedRepository: (connectionId, installationId, repositoryId) => {
      assert.deepEqual([connectionId, installationId, repositoryId], ["connection-1", "77", "991122"]);
      return {
        repositoryId: "991122",
        installationId: "77",
        connectionId: "connection-1",
        owner: "OkamiOps",
        name: "okami-sentinel",
        defaultBranch: "main",
        private: true,
        archived: false,
        updatedAt: "2026-08-12T12:00:00.000Z",
      };
    },
  });

  assert.deepEqual(await service.enroll({
    source: "github",
    connectionId: "connection-1",
    installationId: "77",
    repositoryId: "991122",
    defaultExecutor: "github-actions",
  }), {
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    displayName: "OkamiOps/okami-sentinel",
    defaultBranch: "main",
    defaultExecutor: "github-actions",
    remoteOwner: "OkamiOps",
    remoteName: "okami-sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "991122",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
  });
});

test("local enrollment preserves the existing inspector contract", async () => {
  const service = new GitHubRepositoryService({
    inspectLocal: async (repositoryPath, displayName) => {
      assert.equal(repositoryPath, "/workspace/fixture");
      assert.equal(displayName, "Visible fixture");
      return localRepository;
    },
    requireAuthorizedRepository: () => {
      throw new Error("remote authority must not be called");
    },
  });

  assert.equal(await service.enroll({
    source: "local",
    repositoryPath: "/workspace/fixture",
    displayName: "Visible fixture",
  }), localRepository);
});

test("remote enrollment fails closed on a mismatched authority response", async () => {
  const service = new GitHubRepositoryService({
    inspectLocal: async () => localRepository,
    requireAuthorizedRepository: () => ({
      repositoryId: "991122",
      installationId: "another-installation",
      connectionId: "connection-1",
      owner: "OkamiOps",
      name: "okami-sentinel",
      defaultBranch: "main",
      private: true,
      archived: false,
      updatedAt: "2026-08-12T12:00:00.000Z",
    }),
  });

  await assert.rejects(
    service.enroll({
      source: "github",
      connectionId: "connection-1",
      installationId: "77",
      repositoryId: "991122",
      defaultExecutor: "sentinel-managed",
    }),
    (error: unknown) => error instanceof GitHubRepositoryEnrollmentError
      && error.code === "github_repository_authority_mismatch",
  );
});
