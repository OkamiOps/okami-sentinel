export interface CallerWorkflowOptions {
  defaultBranch: string;
  secretName: string;
  workflowSha: string;
}

export interface CallerWorkflowDocument {
  path: ".github/workflows/csb-security-change-gate.yml";
  filename: "csb-security-change-gate.yml";
  mediaType: "application/yaml";
  content: string;
}

const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_SECRET = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export function callerWorkflowDocument(options: CallerWorkflowOptions): CallerWorkflowDocument {
  return {
    path: ".github/workflows/csb-security-change-gate.yml",
    filename: "csb-security-change-gate.yml",
    mediaType: "application/yaml",
    content: renderCallerWorkflow(options),
  };
}

export function renderCallerWorkflow(options: CallerWorkflowOptions): string {
  if (!SAFE_BRANCH.test(options.defaultBranch) || options.defaultBranch.includes("..")) {
    throw new Error("Invalid default branch for caller workflow");
  }
  if (!SAFE_SECRET.test(options.secretName)) {
    throw new Error("Invalid secret name for caller workflow");
  }
  if (!FULL_SHA.test(options.workflowSha)) {
    throw new Error("Caller workflow requires an immutable release SHA");
  }
  const { defaultBranch, secretName, workflowSha } = options;
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
    uses: OkamiOps/okami-sentinel/.github/workflows/security-change-gate.yml@${workflowSha}
    with:
      policy_path: .csb/guardrails.json
      exceptions_path: .csb/guardrails-exceptions.json
      csb_ref: ${workflowSha}
      default_branch: ${defaultBranch}
    secrets:
      ${secretName}: \${{ secrets.${secretName} }}
`;
}
