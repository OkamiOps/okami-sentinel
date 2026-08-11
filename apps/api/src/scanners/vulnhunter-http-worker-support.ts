import type { AgentEvent, AgentUsage } from "../agent/session-types.js";
import { addScannerUsage, type ScannerUsage } from "./usage.js";

export type VulnHunterHttpTerminal = "running" | "failed" | "cancelled";

/** A provider cleanup cancellation cannot overwrite an already-observed failure. */
export function advanceVulnHunterHttpTerminal(
  terminal: VulnHunterHttpTerminal,
  event: AgentEvent,
): VulnHunterHttpTerminal {
  if (terminal === "failed" || event.type === "failure") return "failed";
  if (event.type === "cancellation") return "cancelled";
  return terminal;
}

export function vulnHunterHttpTerminalExitCode(
  terminal: VulnHunterHttpTerminal,
): 1 | 143 | null {
  if (terminal === "failed") return 1;
  if (terminal === "cancelled") return 143;
  return null;
}

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
