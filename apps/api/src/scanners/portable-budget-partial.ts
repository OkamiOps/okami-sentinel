import fs from "node:fs";
import path from "node:path";
import type { ScanBudgetPartial, ScanBudgetWorkItem, ScanProviderPartial } from "@csb/shared";

export function validBudgetPartial(value: unknown): value is ScanBudgetPartial {
  if (!value || typeof value !== "object") return false;
  const summary = value as ScanBudgetPartial;
  return summary.stopReason === "budget" && Number.isFinite(summary.spentUsd) && summary.spentUsd >= 0 &&
    Number.isFinite(summary.maxCostUsd) && summary.maxCostUsd > 0 && validPartialWork(summary);
}

export function validProviderPartial(value: unknown): value is ScanProviderPartial {
  if (!value || typeof value !== "object") return false;
  const summary = value as ScanProviderPartial;
  return (summary.stopReason === "provider_unreachable" || summary.stopReason === "rate_limited") && validPartialWork(summary);
}

function validPartialWork(summary: Pick<ScanBudgetPartial, "completed" | "pending" | "interrupted">): boolean {
  const item = (entry: ScanBudgetWorkItem) => entry && typeof entry.stage === "string" &&
    (entry.page === null || typeof entry.page === "string") &&
    (entry.artifactPath === null || (typeof entry.artifactPath === "string" &&
      !path.isAbsolute(entry.artifactPath) && !entry.artifactPath.split(/[\\/]/).includes("..")));
  return Array.isArray(summary.completed) && summary.completed.every(item) &&
    Array.isArray(summary.pending) && summary.pending.every(item) && !!item(summary.interrupted);
}

export function assertBudgetResumeCap(summary: ScanBudgetPartial, maxCostUsd: number | undefined): void {
  if (maxCostUsd === undefined || !Number.isFinite(maxCostUsd) ||
      maxCostUsd <= summary.spentUsd || maxCostUsd <= summary.maxCostUsd) {
    throw new Error("resume_budget_cap_must_exceed_prior_spend_and_cap");
  }
}

export function assertResumeSpendAndHolds(spentUsd: number, reservedUsd: number, maxCostUsd: number): void {
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= spentUsd + reservedUsd) {
    throw new Error("resume_budget_cap_must_exceed_prior_spend_and_cap");
  }
}

export function writeBudgetPartial(scanDir: string, summary: ScanBudgetPartial): void {
  const target = path.join(scanDir, "budget-partial.json");
  const temporary = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(summary, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  syncBudgetArtifact(target);
}

export function syncBudgetArtifact(artifact: string): void {
  const fd = fs.openSync(artifact, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(artifact), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
