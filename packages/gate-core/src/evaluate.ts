import type {
  ChangeSet,
  FindingSummary,
  FindingTriage,
  GateDecision,
  GateFindingDelta,
  GateOutcome,
  GateViolation,
  GitHubConclusion,
  GuardrailException,
  GuardrailPolicy,
} from "@csb/shared";
import { findingIdentity } from "./identity.js";

export interface EvaluateGateInput {
  policy: GuardrailPolicy;
  branch: string;
  changeSet: ChangeSet;
  currentFindings: FindingSummary[];
  baselineFindings: FindingSummary[] | null;
  historicalFindings: FindingSummary[];
  triageByIdentity: ReadonlyMap<string, FindingTriage>;
  exceptions: GuardrailException[];
  sourceScanId: string;
  baselineScanId: string | null;
  now: string;
}

export interface EvaluateGateResult {
  deltas: GateFindingDelta[];
  decision: Omit<GateDecision, "decisionGraph">;
}

const unreviewedTriage: FindingTriage = {
  status: "unreviewed",
  note: null,
  updatedAt: null,
};

export function classifyGateFindings(input: EvaluateGateInput): GateFindingDelta[] {
  if (input.baselineFindings === null) {
    return input.currentFindings.map((finding): GateFindingDelta => {
      const identity = findingIdentity(finding);
      return delta(finding, identity, "new", input);
    });
  }

  const baseline = input.baselineFindings;
  const baselineIdentities = new Set(baseline.map(findingIdentity));
  const historicalIdentities = new Set(input.historicalFindings.map(findingIdentity));
  const currentIdentities = new Set(input.currentFindings.map(findingIdentity));

  const current = input.currentFindings.map((finding): GateFindingDelta => {
    const identity = findingIdentity(finding);
    const lifecycle = baselineIdentities.has(identity)
      ? "persistent"
      : historicalIdentities.has(identity)
        ? "reopened"
        : "new";
    return delta(finding, identity, lifecycle, input);
  });

  const fixed = baseline
    .filter((finding) => !currentIdentities.has(findingIdentity(finding)))
    .map((finding): GateFindingDelta => {
      const identity = findingIdentity(finding);
      return delta(finding, identity, "fixed", input);
    });

  return [...current, ...fixed];
}

export function evaluateGate(input: EvaluateGateInput): EvaluateGateResult {
  if (input.changeSet.files.length === 0) return noChangesResult();
  if (input.baselineFindings === null) return bootstrapResult(input);

  const deltas = classifyGateFindings(input);
  const violations: GateViolation[] = [];
  const warnings: GateViolation[] = [];
  const exceptionsApplied: string[] = [];

  for (const finding of deltas) {
    if (finding.lifecycle === "fixed") continue;
    if (finding.triage.status === "false_positive") continue;
    input.policy.rules.forEach((rule, ruleIndex) => {
      if (!rule.severity.includes(finding.severity) || !rule.lifecycle.includes(finding.lifecycle)) return;
      const activeException = input.exceptions.find((exception) =>
        exception.findingIdentity === finding.identity
        && exception.createdAt <= input.now
        && input.now < exception.expiresAt
        && (exception.branches.includes(input.branch) || exception.ruleIndexes.includes(ruleIndex)),
      );
      if (activeException) {
        finding.exception ??= cloneException(activeException);
        if (!exceptionsApplied.includes(finding.identity)) exceptionsApplied.push(finding.identity);
        return;
      }
      const row: GateViolation = {
        findingIdentity: finding.identity,
        ruleIndex,
        decision: rule.decision,
        reason: `${finding.severity}/${finding.lifecycle}`,
      };
      (rule.decision === "block" ? violations : warnings).push(row);
    });
  }

  const outcome: GateOutcome = violations.length ? "blocked" : warnings.length ? "warning" : "pass";
  return {
    deltas,
    decision: {
      outcome,
      summary: decisionSummary(outcome, violations.length, warnings.length),
      violations,
      warnings,
      exceptionsApplied,
      githubConclusion: githubConclusion(outcome),
    },
  };
}

export function githubConclusion(outcome: GateOutcome): GitHubConclusion {
  if (outcome === "pass" || outcome === "no_changes") return "success";
  if (outcome === "warning" || outcome === "bootstrap") return "neutral";
  if (outcome === "blocked") return "failure";
  return "action_required";
}

function delta(
  finding: FindingSummary,
  identity: string,
  lifecycle: GateFindingDelta["lifecycle"],
  input: EvaluateGateInput,
): GateFindingDelta {
  return {
    ...finding,
    fingerprints: [...finding.fingerprints],
    cwe: [...finding.cwe],
    identity,
    lifecycle,
    triage: { ...(input.triageByIdentity.get(identity) ?? unreviewedTriage) },
    exception: null,
    sourceScanId: sourceScanId(lifecycle, input),
  };
}

function noChangesResult(): EvaluateGateResult {
  return {
    deltas: [],
    decision: {
      outcome: "no_changes",
      summary: "No changed files to scan.",
      violations: [],
      warnings: [],
      exceptionsApplied: [],
      githubConclusion: githubConclusion("no_changes"),
    },
  };
}

function bootstrapResult(input: EvaluateGateInput): EvaluateGateResult {
  const deltas = classifyGateFindings(input);
  return {
    deltas,
    decision: {
      outcome: "bootstrap",
      summary: `Baseline initialized with ${deltas.length} finding(s).`,
      violations: [],
      warnings: [],
      exceptionsApplied: [],
      githubConclusion: githubConclusion("bootstrap"),
    },
  };
}

function decisionSummary(outcome: GateOutcome, violations: number, warnings: number): string {
  if (outcome === "blocked") return `${violations} blocking policy violation(s).`;
  if (outcome === "warning") return `${warnings} policy warning(s).`;
  return "No policy violations.";
}

function cloneException(exception: GuardrailException): GuardrailException {
  return {
    ...exception,
    branches: [...exception.branches],
    ruleIndexes: [...exception.ruleIndexes],
  };
}

function sourceScanId(
  lifecycle: GateFindingDelta["lifecycle"],
  input: EvaluateGateInput,
): string {
  if (lifecycle !== "fixed") return input.sourceScanId;
  if (input.baselineScanId === null) {
    throw new Error("baselineScanId is required for fixed findings");
  }
  return input.baselineScanId;
}
