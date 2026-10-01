import {
  guardrailPolicyPresetOf,
  MAX_GUARDRAIL_ENROLLMENT_BATCH,
  type GuardrailBaseline,
  type GuardrailEnrollmentSkip,
  type GuardrailPolicy,
  type GuardrailPolicyPreset,
} from "@csb/shared";

import type { TranslationKey } from "../i18n";
import type { GuardrailPolicySource } from "../api";
import type { GateTone } from "./guardrails";

/**
 * The baseline states whose reason has a sentence of its own. Anything else is a
 * reason the projection recorded and nobody has translated yet: it still reads as
 * stale, because printing a raw code at the operator is worse than being vague.
 */
const NAMED_STALE_REASONS = new Set(["scan_lineage", "protected_branch", "coverage", "policy_schema"]);

export function baselineLabelKey(baseline: Pick<GuardrailBaseline, "state" | "staleReason">): TranslationKey {
  if (baseline.state !== "stale") return `guardrails.baseline.${baseline.state}` as TranslationKey;
  if (baseline.staleReason !== null && NAMED_STALE_REASONS.has(baseline.staleReason)) {
    return `guardrails.baseline.stale.${baseline.staleReason}` as TranslationKey;
  }
  return "guardrails.baseline.stale" as TranslationKey;
}

/**
 * The reason a baseline went stale, on its own — for a list that already shows the
 * word and must not print it twice. `null` when there is nothing to add.
 */
export function baselineReasonKey(
  baseline: Pick<GuardrailBaseline, "state" | "staleReason">,
): TranslationKey | null {
  if (baseline.state !== "stale" || baseline.staleReason === null) return null;
  return NAMED_STALE_REASONS.has(baseline.staleReason)
    ? `guardrails.baselineReason.${baseline.staleReason}` as TranslationKey
    : "guardrails.baselineReason.unknown";
}

/**
 * Only `ready` is good news. `absent` is **neutral**, not a fault: it is the normal
 * state of a repository enrolled a minute ago, and the first merge fixes it without
 * anybody doing anything.
 */
export function baselineToneOf(baseline: Pick<GuardrailBaseline, "state">): GateTone {
  switch (baseline.state) {
    case "ready": return "good";
    case "building": return "active";
    case "stale": return "warning";
    case "absent": return "neutral";
  }
}

/**
 * Which level of the precedence to name. An invalid repository file outranks the
 * level that ended up deciding: an operator told only "Sentinel" would go looking
 * for a bug in the editor instead of fixing the file.
 */
export function policySourceLabelKey(
  source: GuardrailPolicySource,
  fileInvalidReason: string | null,
): TranslationKey {
  if (fileInvalidReason !== null) return "guardrails.policySource.fileInvalid" as TranslationKey;
  return `guardrails.policySource.${source}` as TranslationKey;
}

export function selectedPresetFromPolicy(policy: GuardrailPolicy): GuardrailPolicyPreset {
  return guardrailPolicyPresetOf(policy);
}

/** A repository the App installation offers, as the multi-select reads it. */
export interface EnrollmentCandidate {
  repositoryId: string;
  owner: string;
  name: string;
  archived: boolean;
}

export interface EnrollmentSelectionRow {
  repositoryId: string;
  label: string;
  selected: boolean;
  disabled: boolean;
  /** Why it cannot be chosen, in the same words the API would skip it with. */
  reason: GuardrailEnrollmentSkip["reason"] | null;
}

export interface EnrollmentSelection {
  rows: EnrollmentSelectionRow[];
  /** The ids a click can still add, in the order the list shows them. */
  selectableIds: string[];
  /** What a submit would send: chosen **and** still choosable. */
  selectedIds: string[];
  /** Whether the chosen set is past the bound the API refuses. */
  overBound: boolean;
  canSubmit: boolean;
}

/**
 * What the multi-select shows and what a submit would send.
 *
 * An already-enrolled repository stays **visible and disabled** rather than
 * disappearing: an operator looking for a repository that is already there needs to
 * see that it is, not wonder whether the installation reaches it. The same goes for
 * an archived one, which the API would skip for a different reason.
 *
 * A repository chosen a moment ago and enrolled by somebody else since drops out of
 * the batch instead of being sent and skipped.
 */
export function enrollmentSelectionState(
  candidates: readonly EnrollmentCandidate[],
  /**
   * The **GitHub repository ids** already in the register, not Sentinel keys. The two
   * normally differ only by the `github:` prefix, but the comparison that matters is
   * the one GitHub makes, and a key is the product's own name for a row.
   */
  enrolledRepositoryIds: ReadonlySet<string>,
  selectedIds: ReadonlySet<string>,
): EnrollmentSelection {
  const rows = candidates.map((candidate) => {
    const enrolled = enrolledRepositoryIds.has(candidate.repositoryId);
    const reason: GuardrailEnrollmentSkip["reason"] | null = enrolled
      ? "already_enrolled"
      : candidate.archived ? "archived" : null;
    return {
      repositoryId: candidate.repositoryId,
      label: `${candidate.owner}/${candidate.name}`,
      selected: reason === null && selectedIds.has(candidate.repositoryId),
      disabled: reason !== null,
      reason,
    };
  });
  const selectable = rows.filter((row) => !row.disabled);
  const chosen = rows.filter((row) => row.selected).map((row) => row.repositoryId);
  const overBound = chosen.length > MAX_GUARDRAIL_ENROLLMENT_BATCH;
  return {
    rows,
    selectableIds: selectable.map((row) => row.repositoryId),
    selectedIds: chosen,
    overBound,
    canSubmit: chosen.length > 0 && !overBound,
  };
}
