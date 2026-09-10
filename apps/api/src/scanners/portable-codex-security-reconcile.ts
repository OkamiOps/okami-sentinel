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
  estimateFrozenCatalogUsageCost,
  readPortableCodexSecurityPricing,
  readScannerPricingQuote,
  scannerPricingQuotePath,
} from "../model-pricing.js";
import { resolveReconciledScannerCost } from "../provider-pricing.js";
import {
  portableCodexSecurityRuntimeProgress,
  readPortableCodexSecurityRuntime,
} from "./portable-codex-security-runtime.js";
import { scannerUsageSummary } from "./usage.js";

function countSeverity(findingsPath: string): SeverityCounts | null {
  const counts = emptySeverityCounts();
  try {
    const payload: unknown = JSON.parse(fs.readFileSync(findingsPath, "utf8"));
    if (!isRecord(payload) || !Array.isArray(payload.findings)) return null;
    for (const finding of payload.findings) {
      if (!isRecord(finding)) continue;
      const rawSeverity = typeof finding.severity === "string"
        ? finding.severity
        : isRecord(finding.severity) && typeof finding.severity.level === "string"
          ? finding.severity.level
          : null;
      if (rawSeverity === null) continue;
      counts[normalizeSeverity(rawSeverity)] += 1;
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

function noRuntimeFallback(run: ScanRun, severity: SeverityCounts): ScanRun {
  if (run.status !== "running" || workerIsCurrent(run) || withinBootstrapGrace(run)) return run;
  const completedAt = run.completedAt ?? new Date().toISOString();
  return {
    ...run,
    status: severity.total > 0 ? "incomplete" : "failed",
    completedAt,
    durationMs: run.startedAt === null
      ? run.durationMs
      : durationBetween(run.startedAt, completedAt) ?? run.durationMs,
    severity,
    pid: null,
    progress: null,
  };
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
  // A dead worker with a live/preparing runtime is still resumable. Keep the
  // row recoverable even when no finding has been persisted yet; the recovery
  // coordinator will validate the snapshot/checkpoints before dispatch.
  if (runtimeStatus === "running" || runtimeStatus === "preparing") return "incomplete";
  return hasFindings ? "incomplete" : "failed";
}

/** Rehydrates only the immutable Portable run from its worker-owned local artifacts. */
export function refreshPortableCodexSecurityRunFromDisk(run: ScanRun): ScanRun {
  if (run.engine !== "codex-security" || run.execution?.executionProfile !== "portable") {
    return run;
  }
  // A cancellation or server-restart interruption is authoritative while an
  // old worker runtime may still say running.
  // Queued recovery is owned by its launcher while the capability probe runs;
  // a status read must not mistake its not-yet-spawned worker for another crash.
  if (run.status === "queued" || run.status === "cancelled" || run.status === "incomplete") return run;
  const runtime = readPortableCodexSecurityRuntime(run.scanDir);
  const severity = countSeverity(path.join(run.scanDir, "findings.json")) ?? run.severity;
  if (
    runtime === null ||
    runtime.profileVersion !== run.execution.profileVersion ||
    runtime.methodologyRef !== run.execution.methodologyRef
  ) return noRuntimeFallback(run, severity);

  const status = mappedStatus(runtime.status, severity.total > 0, run);
  const completedAt = status === "running"
    ? null
    : runtime.completedAt ?? run.completedAt;
  const durationMs = completedAt !== null && run.startedAt !== null
    ? durationBetween(run.startedAt, completedAt) ?? run.durationMs
    : run.durationMs;
  const scannerPricing = readScannerPricingQuote(run.scanDir);
  const scannerQuoteExists = fs.existsSync(scannerPricingQuotePath(run.scanDir));
  const providerCost = resolveReconciledScannerCost({
    run,
    usage: runtime.usage,
    pricing: scannerPricing,
  });
  return {
    ...run,
    revision: runtime.snapshotId ?? run.revision,
    status,
    completedAt,
    durationMs,
    cost: scannerQuoteExists
      ? providerCost
      : providerCost ?? estimateFrozenCatalogUsageCost(
          runtime.usage,
          readPortableCodexSecurityPricing(run.scanDir),
        ),
    usage: scannerUsageSummary(runtime.usage),
    severity,
    scannerVersion: runtime.profileVersion,
    pid: status === "running" ? run.pid : null,
    progress: portableCodexSecurityRuntimeProgress(runtime),
  };
}

function durationBetween(startedAt: string, completedAt: string): number | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
