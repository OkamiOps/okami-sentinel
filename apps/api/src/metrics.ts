import { emptySeverityCounts, scanEstimatedUsd, type MetricsSummary, type ScanRun, type ScannerEngine, type SeverityCounts } from "@csb/shared";
import { listRuns } from "./db.js";
import { readFindingsFile } from "./ingest.js";

export type MetricsPeriodDays = 7 | 14 | 21 | 30;
export type MetricsStatusFilter = "active" | "completed" | "attention";

export interface MetricsFilters {
  days?: MetricsPeriodDays | null;
  status?: MetricsStatusFilter | null;
  engine?: ScannerEngine | null;
  repository?: string | null;
  query?: string | null;
  now?: Date;
}

export function buildMetricsSummary(filters: MetricsFilters = {}): MetricsSummary {
  const runs = filterMetricRuns(listRuns(), filters);
  const severity = emptySeverityCounts();
  let totalEstimatedUsd = 0;
  let pricedScans = 0;
  let hasUpperBoundCost = false;
  let completedScans = 0;
  let runningScans = 0;
  let attentionScans = 0;
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
    if (run.status === "failed" || run.status === "incomplete") attentionScans += 1;
    const estimatedUsd = scanEstimatedUsd(run);
    if (estimatedUsd != null) {
      totalEstimatedUsd += estimatedUsd;
      pricedScans += 1;
      if (run.cost?.estimateKind === "upper-bound") hasUpperBoundCost = true;
    }
    const measuredTokens = measuredTokenCounts(run);
    totalInputTokens += measuredTokens.inputTokens;
    totalOutputTokens += measuredTokens.outputTokens;
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

  const costTrend = chronological.filter((run) => scanEstimatedUsd(run) != null).map((r) => ({
    scanId: r.id,
    displayName: r.displayName,
    startedAt: r.startedAt,
    estimatedUsd: scanEstimatedUsd(r)!,
    findingsHigh: r.severity.high + r.severity.critical,
    findingsTotal: r.severity.total,
    model: r.model,
    effort: r.effort,
    estimateKind: r.cost?.estimateKind === "upper-bound" ? "upper-bound" as const : null,
  }));

  const topCategories = [...categoryMap.entries()]
    .map(([category, v]) => ({ category, count: v.count, high: v.high }))
    .sort((a, b) => b.count - a.count || b.high - a.high)
    .slice(0, 8);

  return {
    totalScans: runs.length,
    completedScans,
    runningScans,
    attentionScans,
    pricedScans,
    totalEstimatedUsd,
    avgUsdPerScan: pricedScans > 0 ? totalEstimatedUsd / pricedScans : 0,
    hasUpperBoundCost,
    avgDurationMs: durationN > 0 ? durationSum / durationN : null,
    totalInputTokens,
    totalOutputTokens,
    highPerDollar: totalEstimatedUsd > 0 ? findingsHighAll / totalEstimatedUsd : null,
    findingsPerDollar: totalEstimatedUsd > 0 ? findingsTotalAll / totalEstimatedUsd : null,
    severity,
    byModelEffort,
    costTrend,
    topCategories,
    recent: runs,
  };
}

export function filterMetricRuns(runs: ScanRun[], filters: MetricsFilters): ScanRun[] {
  const now = filters.now ?? new Date();
  const cutoff = filters.days == null
    ? null
    : now.getTime() - filters.days * 24 * 60 * 60 * 1_000;
  const query = filters.query?.trim().toLocaleLowerCase() ?? "";

  return runs.filter((run) => {
    if (cutoff != null) {
      const started = run.startedAt == null ? Number.NaN : Date.parse(run.startedAt);
      if (!Number.isFinite(started) || started < cutoff) return false;
    }
    if (filters.engine && run.engine !== filters.engine) return false;
    if (filters.repository && run.displayName !== filters.repository) return false;
    if (filters.status === "active" && run.status !== "queued" && run.status !== "running") return false;
    if (filters.status === "completed" && run.status !== "completed") return false;
    if (filters.status === "attention" && run.status !== "failed" && run.status !== "incomplete") return false;
    if (query) {
      const haystack = [run.id, run.displayName, run.repositoryPath, run.model, run.provider, run.engine, run.mode]
        .filter((value): value is string => typeof value === "string")
        .join("\n")
        .toLocaleLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/** Token telemetry is independent from whether a trustworthy USD quote exists. */
export function measuredTokenCounts(
  run: Pick<ScanRun, "cost" | "usage">,
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: run.usage?.inputTokens ?? run.cost?.inputTokens ?? 0,
    outputTokens: run.usage?.outputTokens ?? run.cost?.outputTokens ?? 0,
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
