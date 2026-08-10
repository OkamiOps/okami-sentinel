import { emptySeverityCounts, scanEstimatedUsd, type MetricsSummary, type SeverityCounts } from "@csb/shared";
import { listRuns } from "./db.js";
import { readFindingsFile } from "./ingest.js";

export function buildMetricsSummary(): MetricsSummary {
  const runs = listRuns();
  const severity = emptySeverityCounts();
  let totalEstimatedUsd = 0;
  let pricedScans = 0;
  let completedScans = 0;
  let runningScans = 0;
  let durationSum = 0;
  let durationN = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let findingsHighAll = 0;
  let findingsTotalAll = 0;

  const groups = new Map<
    string,
    {
      model: string;
      effort: string;
      runs: number;
      pricedRuns: number;
      totalUsd: number;
      findingsHigh: number;
      findingsTotal: number;
    }
  >();

  const categoryMap = new Map<string, { count: number; high: number }>();

  for (const run of runs) {
    if (run.status === "completed") completedScans += 1;
    if (run.status === "running") runningScans += 1;
    const estimatedUsd = scanEstimatedUsd(run);
    if (estimatedUsd != null) {
      totalEstimatedUsd += estimatedUsd;
      pricedScans += 1;
    }
    totalInputTokens += run.cost?.inputTokens ?? 0;
    totalOutputTokens += run.cost?.outputTokens ?? 0;
    if (estimatedUsd != null) {
      findingsHighAll += run.severity.high + run.severity.critical;
      findingsTotalAll += run.severity.total;
    }
    addSeverity(severity, run.severity);

    if (run.durationMs != null && run.durationMs > 0) {
      durationSum += run.durationMs;
      durationN += 1;
    }

    const model = run.model ?? "unknown";
    const effort = run.effort ?? "unknown";
    const key = `${model}::${effort}`;
    const g = groups.get(key) ?? {
      model,
      effort,
      runs: 0,
      pricedRuns: 0,
      totalUsd: 0,
      findingsHigh: 0,
      findingsTotal: 0,
    };
    g.runs += 1;
    if (estimatedUsd != null) {
      g.pricedRuns += 1;
      g.totalUsd += estimatedUsd;
      g.findingsHigh += run.severity.high + run.severity.critical;
      g.findingsTotal += run.severity.total;
    }
    groups.set(key, g);

    // Aggregate categories from completed scans with findings (cap work)
    if (run.status === "completed" && run.severity.total > 0 && categoryMap.size < 200) {
      try {
        for (const f of readFindingsFile(run.scanDir)) {
          const cat = f.category ?? "Uncategorized";
          const cur = categoryMap.get(cat) ?? { count: 0, high: 0 };
          cur.count += 1;
          if (f.severity === "high" || f.severity === "critical") cur.high += 1;
          categoryMap.set(cat, cur);
        }
      } catch {
        // ignore
      }
    }
  }

  const byModelEffort = [...groups.values()]
    .map((g) => ({
      ...g,
      avgUsd: g.pricedRuns > 0 ? g.totalUsd / g.pricedRuns : 0,
      highPerDollar: g.totalUsd > 0 ? g.findingsHigh / g.totalUsd : null,
      totalPerDollar: g.totalUsd > 0 ? g.findingsTotal / g.totalUsd : null,
    }))
    .sort((a, b) => (b.highPerDollar ?? -1) - (a.highPerDollar ?? -1));

  const chronological = [...runs]
    .filter((r) => r.startedAt)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

  const costTrend = chronological.filter((run) => scanEstimatedUsd(run) != null).slice(-12).map((r) => ({
    scanId: r.id,
    displayName: r.displayName,
    startedAt: r.startedAt,
    estimatedUsd: scanEstimatedUsd(r)!,
    findingsHigh: r.severity.high + r.severity.critical,
    findingsTotal: r.severity.total,
    model: r.model,
    effort: r.effort,
  }));

  const topCategories = [...categoryMap.entries()]
    .map(([category, v]) => ({ category, count: v.count, high: v.high }))
    .sort((a, b) => b.count - a.count || b.high - a.high)
    .slice(0, 8);

  return {
    totalScans: runs.length,
    completedScans,
    runningScans,
    totalEstimatedUsd,
    avgUsdPerScan: pricedScans > 0 ? totalEstimatedUsd / pricedScans : 0,
    avgDurationMs: durationN > 0 ? durationSum / durationN : null,
    totalInputTokens,
    totalOutputTokens,
    highPerDollar: totalEstimatedUsd > 0 ? findingsHighAll / totalEstimatedUsd : null,
    findingsPerDollar: totalEstimatedUsd > 0 ? findingsTotalAll / totalEstimatedUsd : null,
    severity,
    byModelEffort,
    costTrend,
    topCategories,
    recent: runs.slice(0, 8),
  };
}

function addSeverity(target: SeverityCounts, source: SeverityCounts): void {
  target.critical += source.critical;
  target.high += source.high;
  target.medium += source.medium;
  target.low += source.low;
  target.info += source.info;
  target.unknown += source.unknown;
  target.total += source.total;
}
