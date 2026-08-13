export interface CallerWorkflowOptions {
  defaultBranch: string;
  secretName: string;
  workflowSha: string;
  triggers?: GuardrailAutomationTriggers;
}

export interface GuardrailAutomationTriggers {
  push: boolean;
  pullRequest: boolean;
  merge: boolean;
}

export const DEFAULT_GUARDRAIL_AUTOMATION = Object.freeze({
  push: false,
  pullRequest: true,
  merge: true,
} satisfies GuardrailAutomationTriggers);

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
  const triggers = automationTriggers(options.triggers ?? DEFAULT_GUARDRAIL_AUTOMATION);
  const automaticEvents = renderAutomaticEvents(triggers);
  const mergeGuard = triggers.merge
    ? "    if: github.event.action != 'closed' || github.event.pull_request.merged == true\n"
    : "";
  return `# csb-guardrail-caller: 3
# csb-automation: push=${Number(triggers.push)},pr=${Number(triggers.pullRequest)},merge=${Number(triggers.merge)}
name: CSB Security Change Gate
run-name: CSB gate \${{ inputs.gate_id || github.run_id }} · \${{ inputs.head_sha || github.sha }}
on:
${automaticEvents}${automaticEvents ? "\n" : ""}  workflow_dispatch:
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
${mergeGuard}    uses: OkamiOps/okami-sentinel/.github/workflows/security-change-gate.yml@${workflowSha}
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

export function parseCallerAutomation(content: string): GuardrailAutomationTriggers | null {
  const match = /^# csb-automation: push=([01]),pr=([01]),merge=([01])$/m.exec(content);
  if (!match) return null;
  return { push: match[1] === "1", pullRequest: match[2] === "1", merge: match[3] === "1" };
}

function automationTriggers(value: GuardrailAutomationTriggers): GuardrailAutomationTriggers {
  if (!value || typeof value.push !== "boolean" || typeof value.pullRequest !== "boolean" || typeof value.merge !== "boolean") {
    throw new Error("Invalid guardrail automation triggers");
  }
  return value;
}

function renderAutomaticEvents(triggers: GuardrailAutomationTriggers): string {
  const lines: string[] = [];
  if (triggers.push) lines.push("  push:");
  if (triggers.pullRequest || triggers.merge) {
    const types = [
      ...(triggers.pullRequest ? ["opened", "synchronize", "reopened", "ready_for_review"] : []),
      ...(triggers.merge ? ["closed"] : []),
    ];
    lines.push("  pull_request:", `    types: [${types.join(", ")}]`);
  }
  return lines.join("\n");
}
