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
  estimateFrozenCatalogUsageCost,
  readPortableCodexSecurityPricing,
} from "../model-pricing.js";
import {
  portableCodexSecurityRuntimeProgress,
  readPortableCodexSecurityRuntime,
} from "./portable-codex-security-runtime.js";

function countSeverity(findingsPath: string): SeverityCounts {
  const counts = emptySeverityCounts();
  try {
    const payload: unknown = JSON.parse(fs.readFileSync(findingsPath, "utf8"));
    if (!isRecord(payload) || !Array.isArray(payload.findings)) return counts;
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
  } catch {
    // A malformed partial artifact never becomes evidence.
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

/** Rehydrates only the immutable Portable run from its worker-owned local artifacts. */
export function refreshPortableCodexSecurityRunFromDisk(run: ScanRun): ScanRun {
  if (run.engine !== "codex-security" || run.execution?.executionProfile !== "portable") {
    return run;
  }
  const runtime = readPortableCodexSecurityRuntime(run.scanDir);
  if (
    runtime === null ||
    runtime.profileVersion !== run.execution.profileVersion ||
    runtime.methodologyRef !== run.execution.methodologyRef
  ) return run;

  const severity = countSeverity(path.join(run.scanDir, "findings.json"));
  const status = mappedStatus(runtime.status, severity.total > 0, run.pid);
  const completedAt = status === "running"
    ? null
    : runtime.completedAt ?? run.completedAt;
  const durationMs = completedAt !== null && run.startedAt !== null
    ? durationBetween(run.startedAt, completedAt) ?? run.durationMs
    : run.durationMs;
  return {
    ...run,
    revision: runtime.snapshotId ?? run.revision,
    status,
    completedAt,
    durationMs,
    cost: estimateFrozenCatalogUsageCost(
      runtime.usage,
      readPortableCodexSecurityPricing(run.scanDir),
    ),
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
