import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "security-change-gate.yml");
const callerPath = path.join(repositoryRoot, ".github", "workflows", "fixtures", "caller.yml");

test("legacy workflow is contained until the v2 contract replaces it", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /pull-requests:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.doesNotMatch(workflow, /checks:\s*write/);
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.csb_ref \}\}/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(workflow, /CSB_GUARDRAIL_CONTRACT:\s*legacy-contained/);
  assert.match(workflow, /exit 3/);
  assert.doesNotMatch(workflow, /csb-guardrail-contract:\s*2/);
  assert.doesNotMatch(workflow, /actions\/github-script/);
  assert.doesNotMatch(workflow, /checks\.create/);
  assert.doesNotMatch(workflow, /@main/);
});

test("caller uses the v1 reusable workflow and forwards only the named scanner secret", () => {
  const caller = fs.readFileSync(callerPath, "utf8");
  assert.match(caller, /security-change-gate\.yml@v1/);
  assert.match(caller, /OPENAI_API_KEY:\s*\$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.doesNotMatch(caller, /@main/);
  assert.doesNotMatch(caller, /secrets:\s*inherit/);
});
