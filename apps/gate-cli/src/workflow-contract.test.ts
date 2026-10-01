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
  const triggerEnvelope = workflow.slice(0, workflow.indexOf("permissions:"));
  assert.match(workflow, /^# csb-guardrail-contract: 3$/m);
  assert.match(triggerEnvelope, /workflow_call:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(triggerEnvelope, /^\s{2}pull_request:/m);
  assert.doesNotMatch(triggerEnvelope, /^\s{2}push:/m);
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
  assert.match(workflow, /status=completed/);
  // C-2: the baseline Sentinel counts is the baseline the run compares against. A
  // dispatch-only caller produces no `event=push` history to search, and every
  // Sentinel-started gate — including the protected-branch one that *is* the
  // baseline — is a `workflow_dispatch` run.
  assert.match(workflow, /inputs\.baseline_workflow_run_id/);
  // N-2: every Sentinel dispatch runs on the default branch, a pull-request gate
  // included, so the fallback prefers `push` runs, only falls back to
  // `workflow_dispatch` when there are none, and never accepts a candidate whose
  // artifact is not a protected-branch gate.
  assert.match(workflow, /-f event=push/);
  assert.match(workflow, /-f event=workflow_dispatch/);
  assert.match(workflow, /if \[\[ -z "\$\{push_runs\}" \]\]; then/);
  assert.match(workflow, /for run_id in \$\{candidates\}; do/);
  assert.match(workflow, /\.target\.kind \/\/ empty/);
  assert.match(workflow, /"\$\{kind\}" != "protected_branch"/);
  // A run is never taken by position: the lists are bounded and every candidate is
  // checked. (Selecting *the* artifact inside one chosen run still may be.)
  assert.doesNotMatch(workflow, /workflow_runs[^\n]*\[0\]\.id/);
  assert.match(workflow, /workflow_runs[^\n]*\[0:5\]\[\]\.id/);
  // I-4: the ceiling the console showed reaches the run.
  assert.match(workflow, /inputs\.cost_ceiling_usd/);
  assert.match(workflow, /--max-cost-usd/);

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
