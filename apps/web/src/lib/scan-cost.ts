import type { ScanCost, ScanRun, ScanUsageSummary } from "@csb/shared";

export type ScanCostCopyKey =
  | "scanCost.cost"
  | "scanCost.estimated"
  | "scanCost.paygEquivalent"
  | "scanCost.openrouterRate"
  | "scanCost.providerRate"
  | "scanCost.officialRate"
  | "scanCost.planDisclaimer";

export interface ScanCostPresentation {
  labelKey: ScanCostCopyKey;
  rateKey: ScanCostCopyKey | null;
  disclaimerKey: ScanCostCopyKey | null;
}

export function scanCostPresentation(cost: ScanCost | null): ScanCostPresentation {
  if (cost?.pricingBasis === "payg-equivalent") {
    return {
      labelKey: "scanCost.paygEquivalent",
      rateKey: cost.pricingSource === "official-rate-card"
        ? "scanCost.officialRate"
        : cost.pricingSource === "openrouter"
          ? "scanCost.openrouterRate"
          : "scanCost.providerRate",
      disclaimerKey: "scanCost.planDisclaimer",
    };
  }
  if (cost?.pricingSource !== undefined) {
    const rateKey = cost.pricingSource === "openrouter"
      ? "scanCost.openrouterRate"
      : cost.pricingSource === "official-rate-card"
        ? "scanCost.officialRate"
        : "scanCost.providerRate";
    return {
      labelKey: "scanCost.estimated",
      rateKey,
      disclaimerKey: null,
    };
  }
  return {
    labelKey: "scanCost.cost",
    rateKey: null,
    disclaimerKey: null,
  };
}

/** Usage remains reportable even when no auditable USD quote exists. */
export function scanTokenUsage(
  scan: Pick<ScanRun, "cost" | "usage">,
): ScanUsageSummary {
  if (scan.usage !== null && scan.usage !== undefined) {
    return scan.usage;
  }
  return {
    inputTokens: scan.cost?.inputTokens ?? null,
    cachedInputTokens: scan.cost?.cachedInputTokens ?? null,
    cacheWriteInputTokens: scan.cost?.cacheWriteInputTokens ?? null,
    outputTokens: scan.cost?.outputTokens ?? null,
  };
}
