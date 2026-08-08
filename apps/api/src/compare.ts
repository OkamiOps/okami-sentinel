import {
  MAX_COMPARE_SCANS,
  type CompareFindingChange,
  type CompareFindingDelta,
  type ComparePairResult,
  type CompareResult,
  type FindingSummary,
  type ScanRun,
} from "@csb/shared";
import { getRun } from "./db.js";
import { readFindingsFile, toFindingSummaries } from "./ingest.js";
import { findingIdentity } from "./lifecycle.js";

const changeOrder: CompareFindingChange[] = [
  "candidate_only",
  "severity_changed",
  "baseline_only",
  "both",
];
const severityOrder = ["critical", "high", "medium", "low", "info", "unknown"];

export function compareScans(scanIds: string[]): CompareResult {
  if (scanIds.length < 2 || scanIds.length > MAX_COMPARE_SCANS) {
    throw new Error(`Selecione de 2 a ${MAX_COMPARE_SCANS} scans para comparar`);
  }

  const scans: ScanRun[] = [];
  const findingsByScan = new Map<string, FindingSummary[]>();

  for (const id of scanIds) {
    const run = getRun(id);
    if (!run) throw new Error(`Scan não encontrado: ${id}`);
    scans.push(run);
    findingsByScan.set(id, toFindingSummaries(readFindingsFile(run.scanDir)));
  }

  const comparisons: ComparePairResult[] = scanIds.slice(1).map((candidateScanId) => ({
    candidateScanId,
    ...buildFindingDiff(scanIds[0], candidateScanId, findingsByScan),
  }));

  const ranking = scans.map((scan) => {
    const usd = scan.cost?.estimatedUsd ?? 0;
    const high = scan.severity.high + scan.severity.critical;
    const total = scan.severity.total;
    return {
      scanId: scan.id,
      model: scan.model,
      effort: scan.effort,
      estimatedUsd: usd,
      findingsHigh: high,
      findingsTotal: total,
      highPerDollar: usd > 0 ? high / usd : null,
      totalPerDollar: usd > 0 ? total / usd : null,
      durationMs: scan.durationMs,
    };
  });

  ranking.sort((a, b) => {
    const av = a.highPerDollar ?? -1;
    const bv = b.highPerDollar ?? -1;
    return bv - av;
  });

  return {
    scans,
    baselineScanId: scanIds[0],
    candidateScanIds: scanIds.slice(1),
    comparisons,
    ranking,
  };
}

export function buildFindingDiff(
  baselineScanId: string,
  candidateScanId: string,
  findingsByScan: ReadonlyMap<string, FindingSummary[]>,
): Pick<ComparePairResult, "counts" | "findings"> {
  const baseline = indexFindings(findingsByScan.get(baselineScanId) ?? []);
  const candidate = indexFindings(findingsByScan.get(candidateScanId) ?? []);
  const keys = new Set([...baseline.keys(), ...candidate.keys()]);
  const counts: Record<CompareFindingChange, number> = {
    candidate_only: 0,
    baseline_only: 0,
    both: 0,
    severity_changed: 0,
  };
  const findings: CompareFindingDelta[] = [];

  for (const key of keys) {
    const before = baseline.get(key) ?? null;
    const after = candidate.get(key) ?? null;
    const change: CompareFindingChange = !before
      ? "candidate_only"
      : !after
        ? "baseline_only"
        : before.severity !== after.severity
          ? "severity_changed"
          : "both";
    counts[change] += 1;
    findings.push({
      key,
      title: after?.title ?? before?.title ?? "Finding sem título",
      change,
      baseline: before ? { ...before, scanId: baselineScanId } : null,
      candidate: after ? { ...after, scanId: candidateScanId } : null,
    });
  }

  findings.sort((left, right) => {
    const changeDelta = changeOrder.indexOf(left.change) - changeOrder.indexOf(right.change);
    if (changeDelta !== 0) return changeDelta;
    const leftSeverity = left.candidate?.severity ?? left.baseline?.severity ?? "unknown";
    const rightSeverity = right.candidate?.severity ?? right.baseline?.severity ?? "unknown";
    const severityDelta = severityOrder.indexOf(leftSeverity) - severityOrder.indexOf(rightSeverity);
    return severityDelta || left.title.localeCompare(right.title);
  });

  return { counts, findings };
}

function indexFindings(findings: FindingSummary[]): Map<string, FindingSummary> {
  return new Map(findings.map((finding) => [findingIdentity(finding), finding]));
}
