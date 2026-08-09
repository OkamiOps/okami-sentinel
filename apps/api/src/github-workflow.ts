import fs from "node:fs";
import path from "node:path";

export interface InstallCallerWorkflowOptions {
  defaultBranch: string;
  secretName: string;
}

export interface InstallCallerWorkflowResult {
  path: string;
  committed: false;
}

const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_SECRET = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function installCallerWorkflow(
  repositoryPath: string,
  options: InstallCallerWorkflowOptions,
): Promise<InstallCallerWorkflowResult> {
  if (!SAFE_BRANCH.test(options.defaultBranch)) {
    throw new Error("Invalid default branch for caller workflow");
  }
  if (!SAFE_SECRET.test(options.secretName)) {
    throw new Error("Invalid secret name for caller workflow");
  }

  const workflowPath = path.join(
    path.resolve(repositoryPath),
    ".github",
    "workflows",
    "csb-security-change-gate.yml",
  );
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, renderCallerWorkflow(options), "utf8");

  return { path: workflowPath, committed: false };
}

function renderCallerWorkflow(options: InstallCallerWorkflowOptions): string {
  const { defaultBranch, secretName } = options;
  return `name: CSB Security Change Gate
on:
  pull_request:
  push:
    branches: [${defaultBranch}]
permissions:
  contents: read
  pull-requests: read
  actions: read
  checks: write
jobs:
  security-change-gate:
    uses: OkamiOps/okami-sentinel/.github/workflows/security-change-gate.yml@v1
    with:
      policy_path: .csb/guardrails.json
      default_branch: ${defaultBranch}
    secrets:
      ${secretName}: \${{ secrets.${secretName} }}
`;
}
