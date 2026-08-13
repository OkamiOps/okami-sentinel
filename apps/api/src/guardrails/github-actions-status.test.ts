import assert from "node:assert/strict";
import test from "node:test";

import type { GuardrailRepository } from "@csb/shared";

import { callerWorkflowDocument } from "../github-workflow.js";
import {
  getGitHubActionsStatus,
  type GitHubActionsStatusAuthority,
} from "./github-actions-status.js";

const RELEASE_SHA = "a".repeat(40);

test("is ready only when the active caller exactly matches the pinned release", async () => {
  const reads: string[] = [];
  const content = callerWorkflowDocument({
    defaultBranch: "main",
    secretName: "OPENAI_API_KEY",
    workflowSha: RELEASE_SHA,
  }).content;
  const authority: GitHubActionsStatusAuthority = {
    readAuthorizedRepositoryJson: async (_connection, _installation, _repository, path) => {
      reads.push(path);
      return path.includes("/contents/")
        ? { type: "file", encoding: "base64", content: Buffer.from(content).toString("base64") }
        : { state: "active", path: ".github/workflows/csb-security-change-gate.yml" };
    },
  };

  const status = await getGitHubActionsStatus(repository(), authority, RELEASE_SHA);
  assert.deepEqual(status, {
    ready: true,
    code: "ready",
    workflowPath: ".github/workflows/csb-security-change-gate.yml",
    releaseSha: RELEASE_SHA,
    triggers: { push: false, pullRequest: true, merge: true },
  });
  assert.equal(reads.length, 2);
});

test("reports an outdated caller without dispatching or modifying the repository", async () => {
  const authority: GitHubActionsStatusAuthority = {
    readAuthorizedRepositoryJson: async () => ({
      type: "file",
      encoding: "base64",
      content: Buffer.from("name: old caller\n").toString("base64"),
    }),
  };
  const status = await getGitHubActionsStatus(repository(), authority, RELEASE_SHA);
  assert.equal(status.ready, false);
  assert.equal(status.code, "caller_workflow_outdated");
});

test("fails closed before GitHub when the immutable release is unavailable", async () => {
  const authority: GitHubActionsStatusAuthority = {
    readAuthorizedRepositoryJson: async () => assert.fail("must not call GitHub"),
  };
  const status = await getGitHubActionsStatus(repository(), authority, null);
  assert.equal(status.ready, false);
  assert.equal(status.code, "actions_release_unavailable");
});

function repository(): GuardrailRepository {
  return {
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    displayName: "OkamiOps/private-sentinel",
    defaultBranch: "main",
    defaultExecutor: "github-actions",
    remoteOwner: "OkamiOps",
    remoteName: "private-sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "991122",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "ready",
  };
}
