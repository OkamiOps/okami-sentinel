import type { GitHubActionEventStatus, GitHubWebhookDeliveryOutcome } from "@csb/shared";

import type { GitHubActionsMessageKey } from "../../i18n/github-actions";
import { githubActionsMessages } from "../../i18n/github-actions";
import type { TranslationKey } from "../../i18n";

/** The scoped translator of the GitHub tab, passed down instead of re-derived. */
export type GitHubT = (
  key: GitHubActionsMessageKey | TranslationKey,
  variables?: Record<string, string | number>,
) => string;

const REASON_KEYS = new Set(
  Object.keys(githubActionsMessages["pt-BR"])
    .filter((key) => key.startsWith("github.reason."))
    .map((key) => key.slice("github.reason.".length)),
);

/**
 * A reason in words, never the raw code. An unmapped code still reads as a
 * sentence with the code inside it, because `fork_pull_request` on screen tells the
 * operator nothing and `snake_case` in a table is how a screen admits it does not
 * know what it is showing.
 */
export function reasonText(t: GitHubT, code: string | null): string | null {
  if (code === null || code.trim() === "") return null;
  const key = code.trim();
  if (REASON_KEYS.has(key)) return t(`github.reason.${key}` as GitHubActionsMessageKey);
  return t("github.reason.unknown", { code: key });
}

/**
 * The reasons that are not failures. `initial_baseline` and `check_run_rerequested`
 * are the system working as designed, so they must not wear the destructive tone
 * that teaches the operator to read every row as a problem.
 */
const NEUTRAL_REASONS = new Set(["initial_baseline", "check_run_rerequested", "target_already_recorded"]);

export function isNeutralReason(code: string | null): boolean {
  return code !== null && NEUTRAL_REASONS.has(code.trim());
}

export const eventStatusTone: Record<GitHubActionEventStatus, string> = {
  observed: "border-border text-muted-foreground",
  queued: "border-chart-3/45 text-chart-3",
  dispatching: "border-primary/45 text-primary",
  launched: "border-chart-2/45 text-chart-2",
  skipped: "border-border text-muted-foreground",
  failed: "border-destructive/45 text-destructive",
  superseded: "border-border text-muted-foreground",
};

export const deliveryOutcomeTone: Record<GitHubWebhookDeliveryOutcome, string> = {
  processed: "border-chart-2/45 text-chart-2",
  ignored: "border-border text-muted-foreground",
  failed: "border-destructive/45 text-destructive",
};

/** Only `https:` reaches an `href`, so a stored value cannot become `javascript:`. */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
