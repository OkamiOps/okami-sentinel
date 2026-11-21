import type { ScanBudgetPartial, ScanRun } from "@csb/shared";

export function isBudgetPartial(scan: Pick<ScanRun, "status" | "statusReason">): boolean {
  return scan.status === "incomplete" && scan.statusReason === "budget_exhausted";
}

export function budgetResumeCommand(scanId: string, summary: ScanBudgetPartial): string {
  const higherCap = Math.ceil(Math.max(summary.spentUsd, summary.maxCostUsd) * 2);
  const quotedId = `'${scanId.replaceAll("'", "'\\''")}'`;
  return `pnpm exec tsx src/scanners/resume-portable-scan.ts ${quotedId} --max-cost-usd ${higherCap}`;
}
