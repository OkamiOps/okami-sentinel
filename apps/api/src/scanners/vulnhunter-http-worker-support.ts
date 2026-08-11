import type { AgentEvent, AgentUsage } from "../agent/session-types.js";
import { addScannerUsage, type ScannerUsage } from "./usage.js";

/** Event JSONL is persisted only after the caller's complete secret registry redacts it. */
export function serializeVulnHunterHttpEvent(
  event: AgentEvent,
  redact: (value: string) => string,
): string {
  try {
    return redact(JSON.stringify(event));
  } catch {
    return "{\"type\":\"event\"}";
  }
}

/** Agent wire usage is per bounded model turn; the scan runtime stores totals. */
export function addVulnHunterHttpUsage(
  current: ScannerUsage,
  usage: AgentUsage,
): ScannerUsage {
  return addScannerUsage(current, usage);
}
