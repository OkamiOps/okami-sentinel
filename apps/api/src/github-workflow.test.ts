import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installCallerWorkflow } from "./github-workflow.js";

const EXPECTED_CALLER = `name: CSB Security Change Gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  pull-requests: read
  actions: read
  checks: write
jobs:
  security-change-gate:
    uses: OkamiOps/Codex-Security-Benchmark/.github/workflows/security-change-gate.yml@v1
    with:
      policy_path: .csb/guardrails.json
      default_branch: main
    secrets:
      OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
`;

test("writes the exact versioned caller workflow without committing it", async () => {
  const repositoryPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "csb-github-workflow-"),
  );

  try {
    const result = await installCallerWorkflow(repositoryPath, {
      defaultBranch: "main",
      secretName: "OPENAI_API_KEY",
    });
    const body = fs.readFileSync(result.path, "utf8");

    assert.equal(body, EXPECTED_CALLER);
    assert.match(body, /@v1/);
    assert.doesNotMatch(body, /@main/);
    assert.equal(
      result.path,
      path.join(
        repositoryPath,
        ".github",
        "workflows",
        "csb-security-change-gate.yml",
      ),
    );
    assert.equal(result.committed, false);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("renders the configured branch and secret into the caller", async () => {
  const repositoryPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "csb-github-workflow-options-"),
  );

  try {
    const result = await installCallerWorkflow(repositoryPath, {
      defaultBranch: "trunk",
      secretName: "CSB_OPENAI_KEY",
    });
    const body = fs.readFileSync(result.path, "utf8");

    assert.match(body, /branches: \[trunk\]/);
    assert.match(body, /default_branch: trunk/);
    assert.match(body, /CSB_OPENAI_KEY: \$\{\{ secrets\.CSB_OPENAI_KEY \}\}/);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("rejects branch and secret values that can alter the yaml structure", async () => {
  const repositoryPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "csb-github-workflow-invalid-"),
  );

  try {
    await assert.rejects(
      () =>
        installCallerWorkflow(repositoryPath, {
          defaultBranch: "main\npermissions: write-all",
          secretName: "OPENAI_API_KEY",
        }),
      /default branch/i,
    );
    await assert.rejects(
      () =>
        installCallerWorkflow(repositoryPath, {
          defaultBranch: "main",
          secretName: "OPENAI_API_KEY }} malicious",
        }),
      /secret name/i,
    );
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});
