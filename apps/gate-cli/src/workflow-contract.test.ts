import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "security-change-gate.yml");
const callerPath = path.join(repositoryRoot, ".github", "workflows", "fixtures", "caller.yml");

test("workflow has bounded permissions, immutable tool ref and unconditional artifact upload", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /pull-requests:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /checks:\s*write/);
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.csb_ref \}\}/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(workflow, /steps\.scanner-auth\.outputs\.ready == 'true'/);
  assert.match(workflow, /const conclusion = artifact\.decision\.githubConclusion;/);
  assert.doesNotMatch(workflow, /@main/);
});

test("caller uses the v1 reusable workflow and forwards only the named scanner secret", () => {
  const caller = fs.readFileSync(callerPath, "utf8");
  assert.match(caller, /security-change-gate\.yml@v1/);
  assert.match(caller, /OPENAI_API_KEY:\s*\$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.doesNotMatch(caller, /@main/);
  assert.doesNotMatch(caller, /secrets:\s*inherit/);
});
