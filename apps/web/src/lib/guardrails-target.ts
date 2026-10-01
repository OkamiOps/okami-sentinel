import type {
  GateExecutorKind,
  GateTarget,
  GuardrailRepository,
} from "@csb/shared";

export type GuardrailTargetKind = "pull_request" | "protected_branch" | "compare";

export interface GuardrailTargetDraft {
  kind: GuardrailTargetKind;
  pullRequestNumber: string;
  baseRef: string;
  headRef: string;
}

/**
 * The execution planes a repository can be asked for. Both are offered to every
 * GitHub repository: `defaultExecutor` is the one enrolment preferred, not the only
 * one the installation can reach, and a radiogroup with a single card is not a
 * choice. A local folder has no caller workflow, so it keeps one plane.
 */
export function guardrailExecutorChoices(
  repository: GuardrailRepository,
): GateExecutorKind[] {
  return repository.source === "github"
    ? ["sentinel-managed", "github-actions"]
    : ["sentinel-managed"];
}

export function initialGuardrailTargetDraft(
  repository: GuardrailRepository,
): GuardrailTargetDraft {
  return {
    kind: repository.source === "github" ? "pull_request" : "compare",
    pullRequestNumber: "",
    baseRef: repository.defaultBranch,
    headRef: repository.source === "github" ? "" : "HEAD",
  };
}

export function targetFromDraft(
  repository: GuardrailRepository,
  draft: GuardrailTargetDraft,
): GateTarget | null {
  if (repository.source === "local") {
    const baseRef = draft.baseRef.trim();
    const headRef = draft.headRef.trim();
    return baseRef && headRef
      ? { kind: "compare", baseRef, headRef }
      : null;
  }

  if (draft.kind === "pull_request") {
    const number = Number(draft.pullRequestNumber);
    return Number.isSafeInteger(number) && number > 0
      ? { kind: "pull_request", number }
      : null;
  }

  if (draft.kind === "protected_branch") {
    const ref = draft.baseRef.trim();
    return ref && ref.toUpperCase() !== "HEAD"
      ? { kind: "protected_branch", ref }
      : null;
  }

  const baseRef = draft.baseRef.trim();
  const headRef = draft.headRef.trim();
  if (!baseRef || !headRef || baseRef.toUpperCase() === "HEAD" || headRef.toUpperCase() === "HEAD") {
    return null;
  }
  return { kind: "compare", baseRef, headRef };
}

export function reconcileRemotePullRequestDraft(
  repository: GuardrailRepository,
  draft: GuardrailTargetDraft,
  pullRequestNumbers: readonly number[],
): GuardrailTargetDraft {
  const currentNumber = Number(draft.pullRequestNumber);
  const selectedNumber = pullRequestNumbers.includes(currentNumber)
    ? currentNumber
    : pullRequestNumbers[0];

  if (selectedNumber !== undefined) {
    return { ...draft, pullRequestNumber: String(selectedNumber) };
  }

  return draft.kind === "pull_request"
    ? {
        ...draft,
        kind: "protected_branch",
        pullRequestNumber: "",
        baseRef: repository.defaultBranch,
      }
    : { ...draft, pullRequestNumber: "" };
}

export function preflightFingerprint(
  repositoryKey: string,
  executor: GateExecutorKind,
  target: GateTarget,
): string {
  return JSON.stringify([repositoryKey, executor, target]);
}
