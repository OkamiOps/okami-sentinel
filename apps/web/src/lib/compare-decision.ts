import type { ScanRun } from "@csb/shared";

export type CompareObjective = "balanced" | "coverage" | "high_plus" | "cost_per_finding" | "cost_per_high" | "speed";

export interface ScanDecisionRow {
  scan: ScanRun;
  score: number;
  total: number;
  highPlus: number;
  costUsd: number | null;
  durationMs: number | null;
  findingsPerDollar: number | null;
  highPerDollar: number | null;
  costPerFinding: number | null;
  costPerHighPlus: number | null;
  findingsPerHour: number | null;
  highPerHour: number | null;
}

export interface MarginalDecisionRow {
  scanId: string;
  extraCostUsd: number | null;
  extraFindings: number;
  extraHighPlus: number;
  costPerExtraFinding: number | null;
  costPerExtraHighPlus: number | null;
}

export function isPartialComparableScan(scan: ScanRun): boolean {
  return scan.status === "failed" && scan.severity.total > 0;
}

export function isComparableScan(scan: ScanRun): boolean {
  return scan.status === "completed" || isPartialComparableScan(scan);
}

function ratio(value: number, maximum: number): number {
  return maximum > 0 ? value / maximum : 0;
}

function inverseDuration(durationMs: number | null, fastestMs: number | null): number {
  if (durationMs == null || durationMs <= 0 || fastestMs == null) return 0;
  return fastestMs / durationMs;
}

export function buildDecisionRanking(scans: ScanRun[], objective: CompareObjective): ScanDecisionRow[] {
  const raw = scans.map((scan) => {
    const costUsd = scan.cost?.estimatedUsd != null && scan.cost.estimatedUsd > 0 ? scan.cost.estimatedUsd : null;
    const durationMs = scan.durationMs != null && scan.durationMs > 0 ? scan.durationMs : null;
    const total = scan.severity.total;
    const highPlus = scan.severity.critical + scan.severity.high;
    return {
      scan,
      total,
      highPlus,
      costUsd,
      durationMs,
      findingsPerDollar: costUsd == null ? null : total / costUsd,
      highPerDollar: costUsd == null ? null : highPlus / costUsd,
      costPerFinding: costUsd == null || total <= 0 ? null : costUsd / total,
      costPerHighPlus: costUsd == null || highPlus <= 0 ? null : costUsd / highPlus,
      findingsPerHour: durationMs == null ? null : total / (durationMs / 3_600_000),
      highPerHour: durationMs == null ? null : highPlus / (durationMs / 3_600_000),
    };
  });
  const maxTotal = Math.max(0, ...raw.map((row) => row.total));
  const maxHighPlus = Math.max(0, ...raw.map((row) => row.highPlus));
  const maxFindingsPerDollar = Math.max(0, ...raw.map((row) => row.findingsPerDollar ?? 0));
  const maxHighPerDollar = Math.max(0, ...raw.map((row) => row.highPerDollar ?? 0));
  const fastestMs = raw.reduce<number | null>((fastest, row) => row.durationMs == null ? fastest : fastest == null ? row.durationMs : Math.min(fastest, row.durationMs), null);

  return raw.map((row) => {
    const coverage = ratio(row.total, maxTotal);
    const highPlus = ratio(row.highPlus, maxHighPlus);
    const findingEfficiency = ratio(row.findingsPerDollar ?? 0, maxFindingsPerDollar);
    const highEfficiency = ratio(row.highPerDollar ?? 0, maxHighPerDollar);
    const speed = inverseDuration(row.durationMs, fastestMs);
    const score = objective === "coverage"
      ? coverage
      : objective === "high_plus"
        ? highPlus
        : objective === "cost_per_finding"
          ? findingEfficiency
          : objective === "cost_per_high"
            ? highEfficiency
          : objective === "speed"
            ? speed
            : coverage * 0.3 + highPlus * 0.25 + findingEfficiency * 0.2 + highEfficiency * 0.15 + speed * 0.1;
    return { ...row, score: score * 100 };
  }).sort((left, right) => right.score - left.score || right.highPlus - left.highPlus || right.total - left.total);
}

export function buildMarginalEconomics(rows: ScanDecisionRow[], baselineScanId: string): MarginalDecisionRow[] {
  const baseline = rows.find((row) => row.scan.id === baselineScanId);
  if (!baseline) return [];
  return rows.filter((row) => row.scan.id !== baselineScanId).map((row) => {
    const extraCostUsd = row.costUsd == null || baseline.costUsd == null ? null : row.costUsd - baseline.costUsd;
    const extraFindings = row.total - baseline.total;
    const extraHighPlus = row.highPlus - baseline.highPlus;
    return {
      scanId: row.scan.id,
      extraCostUsd,
      extraFindings,
      extraHighPlus,
      costPerExtraFinding: extraCostUsd == null || extraFindings <= 0 ? null : extraCostUsd / extraFindings,
      costPerExtraHighPlus: extraCostUsd == null || extraHighPlus <= 0 ? null : extraCostUsd / extraHighPlus,
    };
  });
}
