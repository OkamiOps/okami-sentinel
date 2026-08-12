import assert from "node:assert/strict";
import test from "node:test";

import { callerWorkflowDocument, renderCallerWorkflow } from "./github-workflow.js";

const RELEASE_SHA = "9".repeat(40);

test("renders a downloadable caller pinned to one real immutable workflow SHA", () => {
  const document = callerWorkflowDocument({
    defaultBranch: "main",
    secretName: "OPENAI_API_KEY",
    workflowSha: RELEASE_SHA,
  });

  assert.equal(document.path, ".github/workflows/csb-security-change-gate.yml");
  assert.equal(document.filename, "csb-security-change-gate.yml");
  assert.equal(document.mediaType, "application/yaml");
  assert.match(document.content, new RegExp(`security-change-gate\\.yml@${RELEASE_SHA}`));
  assert.match(document.content, new RegExp(`csb_ref: ${RELEASE_SHA}`));
  assert.match(document.content, /run-name: CSB gate/);
  assert.match(document.content, /^  pull_request:$/m);
  assert.match(document.content, /^  push:$/m);
  assert.match(document.content, /^    branches: \[main\]$/m);
  assert.match(document.content, /workflow_dispatch:/);
  assert.match(document.content, /gate_id: \$\{\{ inputs\.gate_id \}\}/);
  assert.match(document.content, /head_sha: \$\{\{ inputs\.head_sha \}\}/);
  assert.match(document.content, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.doesNotMatch(document.content, /@main|@v\d+/);
  assert.doesNotMatch(document.content, /secrets:\s*inherit/);
});

test("caller rendering is pure and accepts only bounded YAML-safe values", () => {
  const trunk = renderCallerWorkflow({
    defaultBranch: "release/trunk",
    secretName: "CSB_OPENAI_KEY",
    workflowSha: RELEASE_SHA,
  });
  assert.match(trunk, /branches: \[release\/trunk\]/);
  assert.match(trunk, /CSB_OPENAI_KEY: \$\{\{ secrets\.CSB_OPENAI_KEY \}\}/);

  assert.throws(() => renderCallerWorkflow({
    defaultBranch: "main\npermissions: write-all",
    secretName: "OPENAI_API_KEY",
    workflowSha: RELEASE_SHA,
  }), /default branch/i);
  assert.throws(() => renderCallerWorkflow({
    defaultBranch: "main",
    secretName: "OPENAI_API_KEY }} malicious",
    workflowSha: RELEASE_SHA,
  }), /secret name/i);
  assert.throws(() => renderCallerWorkflow({
    defaultBranch: "main",
    secretName: "OPENAI_API_KEY",
    workflowSha: "v2",
  }), /immutable release SHA/i);
});
