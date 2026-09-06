import fs from "node:fs";
import path from "node:path";
import {
  emptySeverityCounts,
  normalizeSeverity,
  type ScanRun,
  type ScanStatus,
  type SeverityCounts,
} from "@csb/shared";
import {
  findProcessIdentitiesForScanDir,
  isProcessIdentityCurrent,
  persistProcessIdentity,
  readProcessIdentity,
} from "../process-identity.js";
import {
  readScannerPricingQuote,
} from "../model-pricing.js";
import { resolveReconciledScannerCost } from "../provider-pricing.js";
import { readVulnHunterRuntime } from "./vulnhunter-runtime.js";
import { scannerUsageSummary } from "./usage.js";

function countSeverity(findingsPath: string): SeverityCounts | null {
  const counts = emptySeverityCounts();
  if (!fs.existsSync(findingsPath)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(findingsPath, "utf8")) as {
      findings?: Array<{ severity?: unknown }>;
    };
    if (!Array.isArray(payload.findings)) return null;
    for (const finding of payload.findings ?? []) {
      counts[normalizeSeverity(finding.severity)] += 1;
      counts.total += 1;
    }
    return counts;
  } catch {
    // Retain prior persisted evidence when a partial artifact is malformed.
    return null;
  }
}

const BOOTSTRAP_GRACE_MS = 45_000;

function workerIsCurrent(run: ScanRun): boolean {
  const persisted = readProcessIdentity(run.scanDir);
  if (persisted !== null && isProcessIdentityCurrent(persisted, run.scanDir)) return true;
  const discovered = findProcessIdentitiesForScanDir(run.scanDir)
    .find((identity) => persisted === null || identity.pid !== persisted.pid);
  if (!discovered) return false;
  persistProcessIdentity(run.scanDir, discovered);
  return true;
}

function withinBootstrapGrace(run: ScanRun, now = Date.now()): boolean {
  const startedAt = run.startedAt === null ? Number.NaN : Date.parse(run.startedAt);
  return Number.isFinite(startedAt) && now >= startedAt && now - startedAt < BOOTSTRAP_GRACE_MS;
}

function mappedStatus(
  runtimeStatus: string,
  hasFindings: boolean,
  run: ScanRun,
): ScanStatus {
  if (runtimeStatus === "completed") return "completed";
  if (runtimeStatus === "cancelled") return "cancelled";
  if (runtimeStatus === "failed") return hasFindings ? "incomplete" : "failed";
  if (workerIsCurrent(run) || withinBootstrapGrace(run)) return "running";
  return hasFindings ? "incomplete" : "failed";
}

export function refreshVulnHunterRunFromDisk(run: ScanRun): ScanRun {
  if (run.engine !== "vulnhunter") return run;
  // Do not let a final worker flush resurrect an explicit cancellation.
  if (run.status === "cancelled") return run;
  const runtime = readVulnHunterRuntime(run.scanDir);
  if (!runtime) {
    if (run.status !== "running" || workerIsCurrent(run) || withinBootstrapGrace(run)) return run;
    const severity = countSeverity(path.join(run.scanDir, "findings.json")) ?? run.severity;
    const completedAt = run.completedAt ?? new Date().toISOString();
    return {
      ...run,
      status: severity.total > 0 ? "incomplete" : "failed",
      completedAt,
      durationMs: run.startedAt
        ? Date.parse(completedAt) - Date.parse(run.startedAt)
        : run.durationMs,
      severity,
      pid: null,
      progress: null,
    };
  }
  const severity = countSeverity(path.join(run.scanDir, "findings.json")) ?? run.severity;
  const hasFindings = severity.total > 0;
  const status = mappedStatus(runtime.status, hasFindings, run);
  const completedAt = status === "running"
    ? null
    : runtime.completedAt ?? run.completedAt ?? new Date().toISOString();
  const pricing = readScannerPricingQuote(run.scanDir);
  const pricedCost = resolveReconciledScannerCost({
    run,
    usage: runtime.usage,
    pricing,
  });
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
