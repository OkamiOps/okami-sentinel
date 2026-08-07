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
  const currentKeys = new Set(current.map(findingIdentity));
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

  const fixedKeys = new Set<string>();
  for (const finding of baselineFindings) {
    const identity = findingIdentity(finding);
    if (currentKeys.has(identity) || fixedKeys.has(identity)) continue;
    fixedKeys.add(identity);
    findings.push({
      ...finding,
      identity,
      lifecycle: "fixed",
      triage: triage.get(identity) ?? { ...unreviewed },
      sourceScanId: baseline!.id,
    });
  }

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
    if (explicit && repositoryKeyFor(explicit) === repositoryKeyFor(scan)) {
      if (explicit.id === scan.id || runTime(explicit) <= runTime(scan)) {
        return { baseline: explicit, source: "explicit" };
      }
    }
  }

  const automatic = repositoryRuns
    .filter((run) => run.id !== scan.id && run.status === "completed" && runTime(run) < runTime(scan))
    .sort((a, b) => runTime(b) - runTime(a))[0] ?? null;
  return automatic ? { baseline: automatic, source: "automatic" } : { baseline: null, source: "none" };
}

function historicalFindingKeys(scan: ScanRun, repositoryRuns: ScanRun[]): Set<string> {
  const keys = new Set<string>();
  for (const run of repositoryRuns) {
    if (run.id === scan.id || run.status !== "completed" || runTime(run) >= runTime(scan)) continue;
    for (const finding of toFindingSummaries(readFindingsFile(run.scanDir))) {
      keys.add(findingIdentity(finding));
    }
  }
  return keys;
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
