import type {
  GateExecutorKind,
  GitHubMonitorCheckoutMode,
  GitHubMonitorRule,
  GitHubMonitorScannerSelection,
  ScanMode,
  ScannerEngine,
} from "@csb/shared";

export type GitHubCheckoutMode = GitHubMonitorCheckoutMode;

export interface GitHubMonitorRuleInput {
  repositoryKey: string;
  executor: GateExecutorKind;
  scanner: GitHubMonitorScannerSelection | null;
  costCeilingUsd: number | null;
  dailyCostCeilingUsd: number | null;
  followBranches: string[];
  checkoutMode: GitHubCheckoutMode;
  enabled: boolean;
}

export interface GitHubMonitorDraft {
  scannerEngine: ScannerEngine;
  executor: GateExecutorKind;
  providerConnectionId: string;
  modelSelectionMode: "catalog" | "runtime-default";
  modelId: string | null;
  mode: ScanMode;
  effort: string;
  costCeilingUsd: string;
  dailyCostCeilingUsd: string;
  followBranches: string;
  checkoutMode: GitHubCheckoutMode;
}

export function initialGitHubMonitorDraft(defaultBranch = ""): GitHubMonitorDraft {
  return {
    scannerEngine: "codex-security",
    executor: "sentinel-managed",
    providerConnectionId: "",
    modelSelectionMode: "catalog",
    modelId: null,
    mode: "standard",
    effort: "",
    costCeilingUsd: "",
    dailyCostCeilingUsd: "",
    followBranches: defaultBranch,
    checkoutMode: "none",
  };
}

export function branchesFromInput(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((branch) => branch.trim()).filter(Boolean))];
}

export function isValidFollowBranch(branch: string): boolean {
  return branch.length > 0 &&
    branch.length <= 255 &&
    /^[A-Za-z0-9*][A-Za-z0-9._/*-]*$/.test(branch) &&
    !branch.includes("..") &&
    !branch.endsWith(".") &&
    !branch.endsWith("/");
}

export function parseRequiredCeiling(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function ruleInputFromDraft(
  repositoryKey: string,
  draft: GitHubMonitorDraft,
  enabled: boolean,
): GitHubMonitorRuleInput | null {
  const followBranches = branchesFromInput(draft.followBranches);
  const costCeilingUsd = parseRequiredCeiling(draft.costCeilingUsd);
  const dailyCostCeilingUsd = draft.dailyCostCeilingUsd.trim()
    ? parseRequiredCeiling(draft.dailyCostCeilingUsd)
    : costCeilingUsd;
  const validBranches = followBranches.length > 0 && followBranches.length <= 20 && followBranches.every(isValidFollowBranch);
  const budgetFieldsValid = (!draft.costCeilingUsd.trim() && !draft.dailyCostCeilingUsd.trim()) ||
    (costCeilingUsd !== null && dailyCostCeilingUsd !== null);
  const hasScanner = draft.scannerEngine === "codex-security" &&
    draft.providerConnectionId.length > 0 &&
    (draft.modelSelectionMode === "runtime-default" || draft.modelId !== null);

  if (!repositoryKey || !validBranches || !budgetFieldsValid) return null;
  if (enabled && (costCeilingUsd === null || dailyCostCeilingUsd === null)) return null;
  if (enabled && draft.executor === "sentinel-managed" && !hasScanner) return null;

  const scanner = draft.executor === "sentinel-managed" && hasScanner
    ? {
        engine: "codex-security" as const,
        connection: {
          connectionId: draft.providerConnectionId,
          modelSelectionMode: draft.modelSelectionMode,
          modelId: draft.modelSelectionMode === "runtime-default" ? null : draft.modelId,
        },
        mode: draft.mode,
        ...(draft.effort.trim() ? { effort: draft.effort.trim() } : {}),
      }
    : null;

  if (enabled && draft.executor === "sentinel-managed" && scanner === null) return null;
  return {
    repositoryKey,
    executor: draft.executor,
    scanner,
    costCeilingUsd: costCeilingUsd ?? null,
    dailyCostCeilingUsd: dailyCostCeilingUsd ?? null,
    followBranches,
    // Git checkout updates are a separately initiated local operation. A
    // remote monitor rule never mutates a checkout as a side effect of a scan.
    checkoutMode: "none",
    enabled,
  };
}

export function draftFromGitHubMonitorRule(rule: GitHubMonitorRule): GitHubMonitorDraft {
  return {
    scannerEngine: rule.scanner?.engine ?? "codex-security",
    executor: rule.executor,
    providerConnectionId: rule.scanner?.connection.connectionId ?? "",
    modelSelectionMode: rule.scanner?.connection.modelSelectionMode ?? "catalog",
    modelId: rule.scanner?.connection.modelId ?? null,
    mode: rule.scanner?.mode ?? "standard",
    effort: rule.scanner?.effort ?? "",
    // An observation-only rule intentionally has no paid scan ceilings. Do not
    // hydrate those null values as the literal string "null" in the form.
    costCeilingUsd: rule.costCeilingUsd === null ? "" : String(rule.costCeilingUsd),
    dailyCostCeilingUsd: rule.dailyCostCeilingUsd === null || rule.dailyCostCeilingUsd === rule.costCeilingUsd
      ? ""
      : String(rule.dailyCostCeilingUsd),
    followBranches: rule.followBranches.join(", "),
    checkoutMode: "none",
  };
}
