import type {
  GateExecutorKind,
  GitHubAction,
  GitHubActionScannerSelection,
  GitHubActionTriggerKind,
  ScanMode,
} from "@csb/shared";

/** 1..20 patterns, the bound the API and the store both enforce. */
export const MAX_BRANCH_PATTERNS = 20;
/** The matcher compiles at most four wildcards; a fifth matches nothing. */
export const MAX_BRANCH_PATTERN_WILDCARDS = 4;
const MAX_NAME = 80;
const MAX_PATTERN = 255;
const MAX_USD = 100_000;

/**
 * The form's own shape: every field a string or a null the operator can leave
 * empty, so a half-typed ceiling is a draft and not a number. `model: null` means
 * "the provider's own default", which the API expresses as
 * `modelSelectionMode: "runtime-default"`.
 */
export interface GitHubActionDraft {
  repositoryKey: string;
  name: string;
  triggerKind: GitHubActionTriggerKind;
  /** Comma- or newline-separated, exactly as typed. */
  branchPatterns: string;
  executor: GateExecutorKind;
  /** The provider connection the Sentinel-managed executor spends on. */
  connectionId: string | null;
  model: string | null;
  effort: string | null;
  mode: ScanMode;
  costCeilingUsd: string;
  dailyCostCeilingUsd: string;
  enabled: boolean;
  includeForks: boolean;
}

/**
 * The body `POST /github/actions` accepts. It is deliberately **not**
 * `GitHubActionCreate`: that type carries `connectionId`, `installationId` and
 * `repositoryId`, which the route copies from the enrolled repository and refuses
 * in the body — a caller who could name them could point an action at an
 * installation it has no grant on. `createdBy` comes from the session for the same
 * reason.
 */
export interface GitHubActionRequestBody {
  repositoryKey: string;
  name: string;
  triggerKind: GitHubActionTriggerKind;
  branchPatterns: string[];
  executor: GateExecutorKind;
  scanner: GitHubActionScannerSelection | null;
  costCeilingUsd: number;
  dailyCostCeilingUsd: number | null;
  enabled: boolean;
  includeForks: boolean;
}

export type GitHubActionFieldError =
  | { field: "name"; code: "required" | "too_long" }
  | { field: "branchPatterns"; code: "required" | "too_many" | "invalid" }
  | { field: "costCeilingUsd"; code: "required" | "not_positive" }
  | { field: "dailyCostCeilingUsd"; code: "not_positive" | "below_per_scan" }
  | { field: "connectionId"; code: "required" }
  | { field: "enabled"; code: "admin_only" };

export type GitHubActionDraftResult =
  | { ok: true; body: GitHubActionRequestBody }
  | { ok: false; errors: GitHubActionFieldError[] };

export function initialGitHubActionDraft(repositoryKey: string): GitHubActionDraft {
  return {
    repositoryKey,
    name: "",
    triggerKind: "pull_request",
    branchPatterns: "",
    // Phase 1 has one selectable executor; GitHub Actions arrives in phase 4.
    executor: "sentinel-managed",
    connectionId: null,
    model: null,
    effort: null,
    mode: "standard",
    // No invented ceiling. A number nobody chose is a number that gets spent.
    costCeilingUsd: "",
    dailyCostCeilingUsd: "",
    enabled: false,
    includeForks: false,
  };
}

export function draftFromAction(action: GitHubAction): GitHubActionDraft {
  return {
    repositoryKey: action.repositoryKey,
    name: action.name,
    triggerKind: action.triggerKind,
    branchPatterns: action.branchPatterns.join(", "),
    executor: action.executor,
    connectionId: action.scanner?.connection.connectionId ?? null,
    model: action.scanner?.connection.modelId ?? null,
    effort: action.scanner?.effort ?? null,
    mode: action.scanner?.mode ?? "standard",
    costCeilingUsd: String(action.costCeilingUsd),
    // An action with no day budget must not read back as the string "null".
    dailyCostCeilingUsd: action.dailyCostCeilingUsd === null ? "" : String(action.dailyCostCeilingUsd),
    enabled: action.enabled,
    includeForks: action.includeForks,
  };
}

/**
 * Splits what was typed into the patterns the API will see. Duplicates collapse:
 * the route refuses a repeated pattern, and bouncing the operator for repeating
 * `main` in a comma list would be a round trip that teaches nothing.
 */
export function branchPatternsFromInput(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((pattern) => pattern.trim()).filter(Boolean))];
}

/**
 * The same shape the API's `branchPatterns` parser accepts, so a refusal happens in
 * the form instead of as an opaque `invalid_branch_patterns` after a round trip.
 */
export function isValidBranchPattern(pattern: string): boolean {
  return pattern.length > 0
    && pattern.length <= MAX_PATTERN
    && /^[A-Za-z0-9*][A-Za-z0-9._/*-]*$/.test(pattern)
    && !pattern.includes("..")
    && !pattern.endsWith(".")
    && !pattern.endsWith("/")
    && branchPatternWildcards(pattern) <= MAX_BRANCH_PATTERN_WILDCARDS;
}

/** Counts as the matcher does: `***` collapses to one wildcard, like `**`. */
export function branchPatternWildcards(pattern: string): number {
  return (pattern.match(/\*+/g) ?? []).length;
}

/**
 * Every refusal the operator can fix, in field order, so the sheet can put each
 * message under its own control instead of one banner for a form with three
 * problems. The API stays the authority: this only avoids round trips it would
 * refuse anyway.
 */
export function validateGitHubActionDraft(
  draft: GitHubActionDraft,
  context: { isAdmin: boolean },
): GitHubActionDraftResult {
  const errors: GitHubActionFieldError[] = [];
  const name = draft.name.trim();
  if (name.length === 0) errors.push({ field: "name", code: "required" });
  else if (name.length > MAX_NAME) errors.push({ field: "name", code: "too_long" });

  const patterns = branchPatternsFromInput(draft.branchPatterns);
  if (patterns.length === 0) errors.push({ field: "branchPatterns", code: "required" });
  else if (patterns.length > MAX_BRANCH_PATTERNS) errors.push({ field: "branchPatterns", code: "too_many" });
  else if (!patterns.every(isValidBranchPattern)) errors.push({ field: "branchPatterns", code: "invalid" });

  const perScan = parseUsd(draft.costCeilingUsd);
  if (draft.costCeilingUsd.trim() === "") errors.push({ field: "costCeilingUsd", code: "required" });
  else if (perScan === null) errors.push({ field: "costCeilingUsd", code: "not_positive" });

  const dailyTyped = draft.dailyCostCeilingUsd.trim() !== "";
  const daily = dailyTyped ? parseUsd(draft.dailyCostCeilingUsd) : null;
  if (dailyTyped && daily === null) errors.push({ field: "dailyCostCeilingUsd", code: "not_positive" });
  // The day budget bounds the repository's whole UTC day, so a day below one scan
  // is an action that can never dispatch once.
  else if (daily !== null && perScan !== null && daily < perScan) {
    errors.push({ field: "dailyCostCeilingUsd", code: "below_per_scan" });
  }

  // Only the Sentinel-managed executor spends a provider connection; the GitHub
  // Actions one spends the customer's minutes and carries no scanner at all.
  const needsConnection = draft.executor === "sentinel-managed";
  if (needsConnection && (draft.connectionId === null || draft.connectionId.trim() === "")) {
    errors.push({ field: "connectionId", code: "required" });
  }

  // The API re-checks this; refusing here is what keeps the button from offering a
  // 403 as the answer to pressing it.
  if (draft.enabled && !context.isAdmin) errors.push({ field: "enabled", code: "admin_only" });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      repositoryKey: draft.repositoryKey,
      name,
      triggerKind: draft.triggerKind,
      branchPatterns: patterns,
      executor: draft.executor,
      scanner: needsConnection ? scannerFrom(draft) : null,
      costCeilingUsd: perScan!,
      dailyCostCeilingUsd: daily,
      enabled: draft.enabled,
      includeForks: draft.includeForks,
    },
  };
}

function scannerFrom(draft: GitHubActionDraft): GitHubActionScannerSelection {
  const modelId = draft.model === null || draft.model.trim() === "" ? null : draft.model.trim();
  const effort = draft.effort === null || draft.effort.trim() === "" ? null : draft.effort.trim();
  return {
    engine: "codex-security",
    connection: {
      connectionId: draft.connectionId!.trim(),
      // A `catalog` selection with no model is a 400; an unset model is the
      // provider's own default and has to say so.
      modelSelectionMode: modelId === null ? "runtime-default" : "catalog",
      modelId,
    },
    ...(effort === null ? {} : { effort }),
    mode: draft.mode,
  };
}

function parseUsd(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_USD) return null;
  return parsed;
}
