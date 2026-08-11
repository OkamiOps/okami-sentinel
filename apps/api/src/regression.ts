import path from "node:path";
import type {
  FindingLifecycle,
  FindingTriage,
  FindingTriageStatus,
  LifecycleFinding,
  RegressionSummary,
  ScanRun,
} from "@csb/shared";
import {
  getFindingTriage,
  getRepositoryBaseline,
  getRun,
  listRuns,
  setRepositoryBaseline,
  upsertFindingTriage,
} from "./db.js";
import { readFindingsFile, toFindingSummaries } from "./ingest.js";
import { classifyCurrentFinding, findingIdentity, normalizeRepositoryKey } from "./lifecycle.js";

const unreviewed: FindingTriage = { status: "unreviewed", note: null, updatedAt: null };

export function buildRegressionSummary(scanId: string): RegressionSummary {
  const scan = getRun(scanId);
  if (!scan) throw new Error("Scan não encontrado");

  const repositoryKey = repositoryKeyFor(scan);
  const repositoryRuns = listRuns().filter((run) => repositoryKeyFor(run) === repositoryKey);
  const explicitBaselineId = getRepositoryBaseline(repositoryKey);
  const { baseline, source } = resolveBaseline(scan, repositoryRuns, explicitBaselineId);
  const current = toFindingSummaries(readFindingsFile(scan.scanDir));
  const baselineFindings = baseline ? toFindingSummaries(readFindingsFile(baseline.scanDir)) : [];
  const baselineKeys = new Set(baselineFindings.map(findingIdentity));
  const historicalKeys = historicalFindingKeys(scan, repositoryRuns);
  const triage = getFindingTriage(repositoryKey);

  const findings: LifecycleFinding[] = current.map((finding) => {
    const identity = findingIdentity(finding);
    return {
      ...finding,
      identity,
      lifecycle: classifyCurrentFinding(identity, baselineKeys, historicalKeys),
      triage: triage.get(identity) ?? { ...unreviewed },
      sourceScanId: scan.id,
    };
  });

  const counts: Record<FindingLifecycle, number> = { new: 0, persisting: 0, fixed: 0, regressed: 0 };
  for (const finding of findings) counts[finding.lifecycle] += 1;

  return {
    scanId,
    baseline,
    baselineSource: source,
    isRepositoryBaseline: explicitBaselineId === scan.id,
    counts,
    findings,
  };
}

export function markScanAsRepositoryBaseline(scanId: string): RegressionSummary {
  const scan = getRun(scanId);
  if (!scan) throw new Error("Scan não encontrado");
  if (scan.status !== "completed") throw new Error("Apenas scans concluídos podem virar baseline");
  setRepositoryBaseline(repositoryKeyFor(scan), scan.id);
  return buildRegressionSummary(scan.id);
}

export function updateFindingTriage(
  scanId: string,
  findingId: string,
  status: FindingTriageStatus,
  note: string | null,
): FindingTriage {
  const scan = getRun(scanId);
  if (!scan) throw new Error("Scan não encontrado");
  const summary = buildRegressionSummary(scanId);
  const finding = summary.findings.find((item) => item.findingId === findingId || item.occurrenceId === findingId);
  if (!finding) throw new Error("Finding não encontrado neste histórico");
  return upsertFindingTriage(repositoryKeyFor(scan), finding.identity, status, cleanNote(note));
}

function resolveBaseline(
  scan: ScanRun,
  repositoryRuns: ScanRun[],
  explicitBaselineId: string | null,
): { baseline: ScanRun | null; source: RegressionSummary["baselineSource"] } {
  if (explicitBaselineId) {
    const explicit = getRun(explicitBaselineId);
    if (
      explicit &&
      repositoryKeyFor(explicit) === repositoryKeyFor(scan) &&
      comparableAnalysisLineage(scan, explicit)
    ) {
      if (explicit.id === scan.id || runTime(explicit) <= runTime(scan)) {
        return { baseline: explicit, source: "explicit" };
      }
    }
  }

  const automatic = repositoryRuns
    .filter((run) =>
      run.id !== scan.id &&
      run.status === "completed" &&
      runTime(run) < runTime(scan) &&
      comparableAnalysisLineage(scan, run)
    )
    .sort((a, b) => runTime(b) - runTime(a))[0] ?? null;
  return automatic ? { baseline: automatic, source: "automatic" } : { baseline: null, source: "none" };
}

function historicalFindingKeys(scan: ScanRun, repositoryRuns: ScanRun[]): Set<string> {
  const keys = new Set<string>();
  for (const run of repositoryRuns) {
    if (
      run.id === scan.id ||
      run.status !== "completed" ||
      runTime(run) >= runTime(scan) ||
      !comparableAnalysisLineage(scan, run) ||
      !knownRevisionChanged(run, scan)
    ) continue;
    for (const finding of toFindingSummaries(readFindingsFile(run.scanDir))) {
      keys.add(findingIdentity(finding));
    }
  }
  return keys;
}

function knownRevisionChanged(previous: ScanRun, current: ScanRun): boolean {
  const before = previous.revision?.trim();
  const after = current.revision?.trim();
  return Boolean(before && after && before !== after);
}

/**
 * Lifecycle is an observation within one scanner lineage, not a cross-engine
 * comparison. Cross-engine/model comparisons belong to the explicit Compare
 * workflow. A missing recipe hash is historical ambiguity and fails closed.
 */
export function comparableAnalysisLineage(current: ScanRun, candidate: ScanRun): boolean {
  if (!current.recipeHash || !candidate.recipeHash) return false;
  return current.engine === candidate.engine &&
    current.provider === candidate.provider &&
    current.model === candidate.model &&
    current.mode === candidate.mode &&
    current.effort === candidate.effort &&
    current.scannerVersion === candidate.scannerVersion &&
    current.recipeHash === candidate.recipeHash &&
    (current.execution?.executionProfile ?? null) === (candidate.execution?.executionProfile ?? null) &&
    (current.execution?.profileVersion ?? null) === (candidate.execution?.profileVersion ?? null) &&
    (current.execution?.methodologyRef ?? null) === (candidate.execution?.methodologyRef ?? null) &&
    (current.connection?.routeKind ?? current.execution?.routeKind ?? null) ===
      (candidate.connection?.routeKind ?? candidate.execution?.routeKind ?? null) &&
    (current.connection?.protocol ?? current.execution?.protocol ?? null) ===
      (candidate.connection?.protocol ?? candidate.execution?.protocol ?? null);
}

function repositoryKeyFor(scan: ScanRun): string {
  const value = scan.repositoryPath ?? scan.scanDir;
  return normalizeRepositoryKey(path.resolve(value));
}

function runTime(scan: ScanRun): number {
  const value = Date.parse(scan.startedAt ?? scan.completedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function cleanNote(value: string | null): string | null {
  const note = value?.trim();
  return note ? note.slice(0, 2000) : null;
}
