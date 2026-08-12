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
  return `# csb-guardrail-caller: 2
name: CSB Security Change Gate
run-name: CSB gate \${{ inputs.gate_id || github.run_id }} · \${{ inputs.head_sha || github.sha }}
on:
  pull_request:
  push:
    branches: [${defaultBranch}]
  workflow_dispatch:
    inputs:
      gate_id:
        description: Persisted Sentinel gate identity
        required: true
        type: string
      target_kind:
        description: Frozen target kind
        required: true
        type: choice
        options: [pull_request, compare, protected_branch]
      base_ref:
        description: Frozen base reference
        required: true
        type: string
      head_ref:
        description: Frozen head reference
        required: true
        type: string
      base_sha:
        description: Frozen base SHA
        required: true
        type: string
      head_sha:
        description: Frozen head SHA
        required: true
        type: string
      protected_branch:
        description: Protected branch
        required: true
        type: string
      pull_request_number:
        description: Pull request number or 0
        required: false
        default: "0"
        type: string
      head_repository:
        description: Optional fork owner/repository
        required: false
        type: string
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
      gate_id: \${{ inputs.gate_id }}
      target_kind: \${{ inputs.target_kind }}
      base_ref: \${{ inputs.base_ref }}
      head_ref: \${{ inputs.head_ref }}
      base_sha: \${{ inputs.base_sha }}
      head_sha: \${{ inputs.head_sha }}
      protected_branch: \${{ inputs.protected_branch }}
      pull_request_number: \${{ inputs.pull_request_number }}
      head_repository: \${{ inputs.head_repository }}
    secrets:
      ${secretName}: \${{ secrets.${secretName} }}
`;
}
