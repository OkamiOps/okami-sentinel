import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GhResult, GhRunner } from "./github-cli.js";
import { getGitHubStatus } from "./github-status.js";

interface FakeGhOptions {
  authenticated?: boolean;
  secretNames?: string[];
  push?: boolean;
}

function fakeCodex(chatGpt = true): GhRunner {
  return async (args) => {
    assert.deepEqual(args, ["login", "status"]);
    return {
      stdout: chatGpt ? "Logged in using ChatGPT" : "Logged in using an API key",
      stderr: "",
      exitCode: 0,
    };
  };
}

function fakeGh(
  options: FakeGhOptions = {},
): { runner: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const success = (stdout = ""): GhResult => ({ stdout, stderr: "", exitCode: 0 });
  const failure = (stderr: string): GhResult => ({ stdout: "", stderr, exitCode: 1 });

  return {
    calls,
    runner: async (args) => {
      calls.push(args);
      const key = args.join(" ");
      if (key === "--version") return success("gh version 2.74.0");
      if (key === "auth status") {
        return options.authenticated === false
          ? failure("not logged in")
          : success("Logged in to github.com");
      }
      if (key === "repo view --json nameWithOwner,defaultBranchRef") {
        return success(
          JSON.stringify({
            nameWithOwner: "OkamiOps/okami-sentinel",
            defaultBranchRef: { name: "main" },
          }),
        );
      }
      if (
        key ===
        "api repos/OkamiOps/okami-sentinel --jq .permissions"
      ) {
        return success(
          JSON.stringify({
            admin: false,
            maintain: false,
            push: options.push !== false,
            triage: true,
            pull: true,
          }),
        );
      }
      if (
        key ===
        "api repos/OkamiOps/okami-sentinel/actions/permissions/workflow"
      ) {
        return success(
          JSON.stringify({
            default_workflow_permissions: "read",
            can_approve_pull_request_reviews: false,
          }),
        );
      }
      if (key === "secret list --json name") {
        return success(
          JSON.stringify(
            (options.secretNames ?? ["OPENAI_API_KEY"]).map((name) => ({ name })),
          ),
        );
      }
      return failure(`unexpected gh call: ${key}`);
    },
  };
}

test("reports each github capability independently", async () => {
  const repositoryPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "csb-github-status-"),
  );
  const gh = fakeGh({
    authenticated: true,
    secretNames: ["OPENAI_API_KEY"],
  });

  try {
    const status = await getGitHubStatus(repositoryPath, gh.runner, fakeCodex());

    assert.equal(status.subscription.ready, true);
    assert.equal(status.cli.available, true);
    assert.equal(status.auth.ready, true);
    assert.equal(status.remote.ready, true);
    assert.equal(status.permissions.ready, true);
    assert.equal(status.secret.ready, true);
    assert.equal(status.workflow.ready, false);
    assert.equal(status.baseline.ready, true);
    assert.equal(status.ready, false);
    assert.equal(
      gh.calls.some((args) => args[0] === "auth" && args[1] === "token"),
      false,
    );
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("reports read-only repository access without hiding healthy capabilities", async () => {
  const repositoryPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "csb-github-readonly-"),
  );
  const workflowDir = path.join(repositoryPath, ".github", "workflows");
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "csb-security-change-gate.yml"),
    "name: CSB Security Change Gate\n",
  );
  const gh = fakeGh({ push: false });

  try {
    const status = await getGitHubStatus(repositoryPath, gh.runner, fakeCodex());

    assert.equal(status.auth.ready, true);
    assert.equal(status.secret.ready, true);
    assert.equal(status.workflow.ready, false);
    assert.match(status.workflow.message, /legado/i);
    assert.match(status.workflow.action ?? "", /contrato v2/i);
    assert.equal(status.permissions.ready, false);
    assert.match(status.permissions.message, /somente leitura/i);
    assert.equal(status.ready, false);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("reports a caller workflow ready only with the v2 contract marker", async () => {
  const repositoryPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "csb-github-v2-workflow-"),
  );
  const workflowDir = path.join(repositoryPath, ".github", "workflows");
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "csb-security-change-gate.yml"),
    "# csb-guardrail-contract: 2\nname: CSB Security Change Gate\n",
  );
  const gh = fakeGh();

  try {
    const status = await getGitHubStatus(repositoryPath, gh.runner, fakeCodex());

    assert.equal(status.workflow.ready, true);
    assert.equal(status.workflow.action, null);
    assert.equal(status.ready, true);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("does not present an API-key login as a subscription", async () => {
  const repositoryPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "csb-codex-api-auth-"),
  );
  const gh = fakeGh();

  try {
    const status = await getGitHubStatus(
      repositoryPath,
      gh.runner,
      fakeCodex(false),
    );
    assert.equal(status.subscription.ready, false);
    assert.match(status.subscription.action ?? "", /codex login/i);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});
