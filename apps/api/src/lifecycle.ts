import type { FindingLifecycle, ScanStatus } from "@csb/shared";
import { findingIdentity } from "@csb/gate-core";

export { findingIdentity };

export function classifyCurrentFinding(
  identity: string,
  baselineKeys: ReadonlySet<string>,
  historicalKeys: ReadonlySet<string>,
): FindingLifecycle {
  if (baselineKeys.has(identity)) return "persisting";
  if (historicalKeys.has(identity)) return "regressed";
  return "new";
}

export function normalizeRepositoryKey(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

export function isRemovableScanStatus(status: ScanStatus | string): boolean {
  return status === "failed" || status === "cancelled";
}
