import {
  MAX_COMPARE_SCANS,
  type CompareFindingChange,
  type CompareFindingDelta,
  type ComparePairResult,
  type CompareResult,
  type FindingSummary,
  type ScanRun,
  scanEstimatedUsd,
} from "@csb/shared";
import { getRun } from "./db.js";
import { readFindingsFile, toFindingSummaries } from "./ingest.js";
import { findingIdentity } from "./lifecycle.js";

interface ComparableFinding extends FindingSummary {
  locations?: unknown;
}

interface ComparableLocation {
  path: string;
  startLine: number | null;
  endLine: number | null;
}

interface FindingPair {
  key: string;
  before: ComparableFinding | null;
  after: ComparableFinding | null;
}

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
  const findingsByScan = new Map<string, ComparableFinding[]>();

  for (const id of scanIds) {
    const run = getRun(id);
    if (!run) throw new Error(`Scan não encontrado: ${id}`);
    scans.push(run);
    const details = readFindingsFile(run.scanDir);
    const summaries = toFindingSummaries(details);
    findingsByScan.set(id, summaries.map((finding, index) => ({
      ...finding,
      locations: details[index]?.locations,
    })));
  }

  const comparisons: ComparePairResult[] = scanIds.slice(1).map((candidateScanId) => ({
    candidateScanId,
    ...buildFindingDiff(scanIds[0], candidateScanId, findingsByScan),
  }));

  const ranking = scans.map((scan) => {
    const usd = scanEstimatedUsd(scan);
    const high = scan.severity.high + scan.severity.critical;
    const total = scan.severity.total;
    return {
      scanId: scan.id,
      model: scan.model,
      effort: scan.effort,
      estimatedUsd: usd ?? 0,
      findingsHigh: high,
      findingsTotal: total,
      highPerDollar: usd != null && usd > 0 ? high / usd : null,
      totalPerDollar: usd != null && usd > 0 ? total / usd : null,
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
  findingsByScan: ReadonlyMap<string, readonly ComparableFinding[]>,
): Pick<ComparePairResult, "counts" | "findings"> {
  const pairs = pairFindings(
    findingsByScan.get(baselineScanId) ?? [],
    findingsByScan.get(candidateScanId) ?? [],
  );
  const counts: Record<CompareFindingChange, number> = {
    candidate_only: 0,
    baseline_only: 0,
    both: 0,
    severity_changed: 0,
  };
  const findings: CompareFindingDelta[] = [];

  for (const { key, before, after } of pairs) {
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
      baseline: before ? { ...findingSummary(before), scanId: baselineScanId } : null,
      candidate: after ? { ...findingSummary(after), scanId: candidateScanId } : null,
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

function pairFindings(
  baseline: readonly ComparableFinding[],
  candidate: readonly ComparableFinding[],
): FindingPair[] {
  const pairs: FindingPair[] = [];
  const usedBaseline = new Set<number>();
  const usedCandidate = new Set<number>();

  for (let baselineIndex = 0; baselineIndex < baseline.length; baselineIndex += 1) {
    const identity = findingIdentity(baseline[baselineIndex]!);
    const candidateIndex = candidate.findIndex((finding, index) =>
      !usedCandidate.has(index) && findingIdentity(finding) === identity
    );
    if (candidateIndex < 0) continue;
    usedBaseline.add(baselineIndex);
    usedCandidate.add(candidateIndex);
    pairs.push({
      key: identity,
      before: baseline[baselineIndex]!,
      after: candidate[candidateIndex]!,
    });
  }

  const semanticCandidates: Array<{
    baselineIndex: number;
    candidateIndex: number;
    score: number;
  }> = [];
  for (let baselineIndex = 0; baselineIndex < baseline.length; baselineIndex += 1) {
    if (usedBaseline.has(baselineIndex)) continue;
    for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex += 1) {
      if (usedCandidate.has(candidateIndex)) continue;
      const score = semanticMatchScore(
        baseline[baselineIndex]!,
        candidate[candidateIndex]!,
      );
      if (score != null) semanticCandidates.push({ baselineIndex, candidateIndex, score });
    }
  }
  semanticCandidates.sort((left, right) =>
    right.score - left.score
    || left.baselineIndex - right.baselineIndex
    || left.candidateIndex - right.candidateIndex
  );
  for (const match of semanticCandidates) {
    if (usedBaseline.has(match.baselineIndex) || usedCandidate.has(match.candidateIndex)) continue;
    const before = baseline[match.baselineIndex]!;
    const after = candidate[match.candidateIndex]!;
    usedBaseline.add(match.baselineIndex);
    usedCandidate.add(match.candidateIndex);
    pairs.push({
      key: semanticPairKey(before, after),
      before,
      after,
    });
  }

  baseline.forEach((finding, index) => {
    if (!usedBaseline.has(index)) {
      pairs.push({ key: findingIdentity(finding), before: finding, after: null });
    }
  });
  candidate.forEach((finding, index) => {
    if (!usedCandidate.has(index)) {
      pairs.push({ key: findingIdentity(finding), before: null, after: finding });
    }
  });
  return uniquePairKeys(pairs);
}

function uniquePairKeys(pairs: FindingPair[]): FindingPair[] {
  const occurrences = new Map<string, number>();
  return pairs.map((pair) => {
    const occurrence = occurrences.get(pair.key) ?? 0;
    occurrences.set(pair.key, occurrence + 1);
    return occurrence === 0
      ? pair
      : { ...pair, key: `${pair.key}::occurrence:${occurrence + 1}` };
  });
}

function semanticMatchScore(
  baseline: ComparableFinding,
  candidate: ComparableFinding,
): number | null {
  const baselineLocations = comparableLocations(baseline);
  const candidateLocations = comparableLocations(candidate);
  const sameCwe = baseline.cwe.some((value) =>
    candidate.cwe.some((other) => value.toUpperCase() === other.toUpperCase())
  );
  const samePath = baselineLocations.some((left) =>
    candidateLocations.some((right) => left.path === right.path)
  );
  const overlappingLocation = baselineLocations.some((left) =>
    candidateLocations.some((right) =>
      left.path === right.path && rangesOverlap(left, right)
    )
  );
  const titleSimilarity = tokenSimilarity(baseline.title, candidate.title);

  if (sameCwe && overlappingLocation) return 100 + titleSimilarity * 10;
  if (sameCwe && samePath && titleSimilarity >= 0.25) return 70 + titleSimilarity * 10;
  if (overlappingLocation && titleSimilarity >= 0.4) return 50 + titleSimilarity * 10;
  return null;
}

function comparableLocations(finding: ComparableFinding): ComparableLocation[] {
  const rows = Array.isArray(finding.locations) ? finding.locations : [];
  const locations = rows.flatMap((value): ComparableLocation[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    if (typeof row.path !== "string" || !row.path.trim()) return [];
    return [{
      path: normalizeComparisonPath(row.path),
      startLine: finiteNumber(row.startLine),
      endLine: finiteNumber(row.endLine) ?? finiteNumber(row.startLine),
    }];
  });
  if (locations.length > 0) return locations;
  if (!finding.primaryPath) return [];
  const match = finding.primaryPath.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  return [{
    path: normalizeComparisonPath(match?.[1] ?? finding.primaryPath),
    startLine: match ? Number(match[2]) : null,
    endLine: match ? Number(match[3] ?? match[2]) : null,
  }];
}

function rangesOverlap(left: ComparableLocation, right: ComparableLocation): boolean {
  if (left.startLine == null || right.startLine == null) return false;
  const leftEnd = left.endLine ?? left.startLine;
  const rightEnd = right.endLine ?? right.startLine;
  return left.startLine <= rightEnd && right.startLine <= leftEnd;
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function titleTokens(value: string): Set<string> {
  const ignored = new Set(["a", "an", "and", "in", "of", "the", "to", "with"]);
  return new Set(
    value.toLowerCase().match(/[a-z0-9]+/g)?.filter((token) =>
      token.length > 1 && !ignored.has(token)
    ) ?? [],
  );
}

function semanticPairKey(
  baseline: ComparableFinding,
  candidate: ComparableFinding,
): string {
  const cwe = baseline.cwe.find((value) => candidate.cwe.includes(value)) ?? "uncategorized";
  const baselineLocations = comparableLocations(baseline);
  const candidateLocations = comparableLocations(candidate);
  const location = baselineLocations.find((left) =>
    candidateLocations.some((right) => left.path === right.path && rangesOverlap(left, right))
  ) ?? baselineLocations.find((left) =>
    candidateLocations.some((right) => left.path === right.path)
  );
  const line = location?.startLine != null ? `:${location.startLine}` : "";
  return `semantic:${cwe.toLowerCase()}::${location?.path ?? normalizeComparisonPath(baseline.primaryPath ?? candidate.primaryPath ?? "")}${line}::${baseline.findingId}::${candidate.findingId}`;
}

function findingSummary(finding: ComparableFinding): FindingSummary {
  return {
    findingId: finding.findingId,
    occurrenceId: finding.occurrenceId,
    title: finding.title,
    severity: finding.severity,
    confidence: finding.confidence,
    ruleId: finding.ruleId,
    summary: finding.summary,
    primaryPath: finding.primaryPath,
    fingerprints: finding.fingerprints,
    category: finding.category,
    cwe: finding.cwe,
  };
}

function normalizeComparisonPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
