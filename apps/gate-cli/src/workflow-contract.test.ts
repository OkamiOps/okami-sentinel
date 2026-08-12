import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "security-change-gate.yml");
const callerPath = path.join(repositoryRoot, ".github", "workflows", "fixtures", "caller.yml");

test("workflow v2 freezes policy and head, restores a baseline and publishes one validated Check", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /^# csb-guardrail-contract: 2$/m);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request_target/);

  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /pull-requests:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /checks:\s*write/);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.doesNotMatch(workflow, /workflows:\s*write/);

  const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s]+)\s*$/gm)].map((match) => match[1]!);
  assert.ok(uses.length >= 4);
  for (const value of uses) {
    assert.match(value, /^[^@]+@[0-9a-f]{40}$/, value);
  }

  assert.match(workflow, /path:\s*policy/);
  assert.match(workflow, /ref:\s*\$\{\{ steps\.revisions\.outputs\.policy_sha \}\}/);
  assert.match(workflow, /path:\s*head/);
  assert.match(workflow, /ref:\s*\$\{\{ steps\.revisions\.outputs\.head_sha \}\}/);
  assert.match(workflow, /--policy-root\s+"\$\{GITHUB_WORKSPACE\}\/policy"/);
  assert.match(workflow, /--repository\s+"\$\{GITHUB_WORKSPACE\}\/head"/);
  assert.match(workflow, /--baseline-state/);
  assert.match(workflow, /--baseline\s+"\$\{BASELINE_PATH\}"/);
  assert.match(workflow, /event=push/);
  assert.match(workflow, /status=completed/);

  assert.match(workflow, /publish-check/);
  assert.match(workflow, /csb-gate-manifest\.json/);
  assert.match(workflow, /artifactSha256/);
  assert.match(workflow, /name:\s*csb-gate-artifact-v2/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.doesNotMatch(workflow, /actions\/github-script/);
  assert.doesNotMatch(workflow, /npm\s+(?:run|test|build).*head/);
  assert.doesNotMatch(workflow, /pnpm\s+--dir\s+head/);
});

test("workflow requires a real immutable Sentinel release SHA", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /CSB_RELEASE_SHA/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.doesNotMatch(workflow, /ref:\s*(?:main|v\d+)\s*$/m);
  assert.doesNotMatch(workflow, /OkamiOps\/okami-sentinel\/.+@(?![0-9a-f]{40})/);
});

test("caller remains contained until the v2 workflow commit exists remotely", () => {
  const caller = fs.readFileSync(callerPath, "utf8");
  assert.match(caller, /security-change-gate\.yml@v1/);
  assert.doesNotMatch(caller, /@main/);
  assert.doesNotMatch(caller, /secrets:\s*inherit/);
});
