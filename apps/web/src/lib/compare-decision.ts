import type { ScanRun } from "@csb/shared";

export type CompareObjective = "balanced" | "coverage" | "high_plus" | "efficiency" | "speed";

export interface ScanDecisionRow {
  scan: ScanRun;
  score: number;
  total: number;
  highPlus: number;
  costUsd: number | null;
  durationMs: number | null;
  findingsPerDollar: number | null;
  highPerDollar: number | null;
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
    };
  });
  const maxTotal = Math.max(0, ...raw.map((row) => row.total));
  const maxHighPlus = Math.max(0, ...raw.map((row) => row.highPlus));
  const maxHighPerDollar = Math.max(0, ...raw.map((row) => row.highPerDollar ?? 0));
  const fastestMs = raw.reduce<number | null>((fastest, row) => row.durationMs == null ? fastest : fastest == null ? row.durationMs : Math.min(fastest, row.durationMs), null);

  return raw.map((row) => {
    const coverage = ratio(row.total, maxTotal);
    const highPlus = ratio(row.highPlus, maxHighPlus);
    const efficiency = ratio(row.highPerDollar ?? 0, maxHighPerDollar);
    const speed = inverseDuration(row.durationMs, fastestMs);
    const score = objective === "coverage"
      ? coverage
      : objective === "high_plus"
        ? highPlus
        : objective === "efficiency"
          ? efficiency
          : objective === "speed"
            ? speed
            : coverage * 0.4 + highPlus * 0.3 + efficiency * 0.2 + speed * 0.1;
    return { ...row, score: score * 100 };
  }).sort((left, right) => right.score - left.score || right.highPlus - left.highPlus || right.total - left.total);
}

