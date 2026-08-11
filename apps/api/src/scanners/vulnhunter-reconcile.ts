import fs from "node:fs";
import path from "node:path";
import {
  emptySeverityCounts,
  normalizeSeverity,
  type ScanRun,
  type ScanStatus,
  type SeverityCounts,
} from "@csb/shared";
import { processAlive } from "../activity.js";
import {
  estimateFrozenScannerUsageCost,
  readScannerPricingQuote,
  scannerPricingQuoteMatchesRun,
} from "../model-pricing.js";
import { readVulnHunterRuntime } from "./vulnhunter-runtime.js";
import { scannerUsageSummary } from "./usage.js";

function countSeverity(findingsPath: string): SeverityCounts {
  const counts = emptySeverityCounts();
  if (!fs.existsSync(findingsPath)) return counts;
  try {
    const payload = JSON.parse(fs.readFileSync(findingsPath, "utf8")) as {
      findings?: Array<{ severity?: unknown }>;
    };
    for (const finding of payload.findings ?? []) {
      counts[normalizeSeverity(finding.severity)] += 1;
      counts.total += 1;
    }
  } catch {
    // Malformed output is never promoted to evidence.
  }
  return counts;
}

function mappedStatus(
  runtimeStatus: string,
  hasFindings: boolean,
  pid: number | null,
): ScanStatus {
  if (runtimeStatus === "completed") return "completed";
  if (runtimeStatus === "cancelled") return "cancelled";
  if (runtimeStatus === "failed") return hasFindings ? "incomplete" : "failed";
  if (processAlive(pid)) return "running";
  return hasFindings ? "incomplete" : "failed";
}

export function refreshVulnHunterRunFromDisk(run: ScanRun): ScanRun {
  if (run.engine !== "vulnhunter") return run;
  const runtime = readVulnHunterRuntime(run.scanDir);
  if (!runtime) return run;
  const severity = countSeverity(path.join(run.scanDir, "findings.json"));
  const hasFindings = severity.total > 0;
  const status = mappedStatus(runtime.status, hasFindings, run.pid);
  const completedAt = status === "running"
    ? null
    : runtime.completedAt ?? run.completedAt ?? new Date().toISOString();
  const pricing = readScannerPricingQuote(run.scanDir);
  const pricedCost = pricing !== null && scannerPricingQuoteMatchesRun(pricing, run)
    ? estimateFrozenScannerUsageCost(runtime.usage, pricing)
    : null;
  return {
    ...run,
    revision: runtime.snapshotId ?? run.revision,
    status,
    completedAt,
    durationMs:
      completedAt && run.startedAt
        ? Date.parse(completedAt) - Date.parse(run.startedAt)
        : run.durationMs,
    cost: pricedCost,
    usage: scannerUsageSummary(runtime.usage),
    severity,
    scannerVersion: runtime.sourceRef,
    pid: status === "running" ? run.pid : null,
  };
}
