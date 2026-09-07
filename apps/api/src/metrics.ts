import {
  type MetricsSummary,
  type ScanRun,
  type ScannerEngine,
  type SeverityCounts,
} from "@csb/shared";
import { getDb, rowToScanRun, type BenchmarkRow } from "./db.js";

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

export const METRICS_RECENT_LIMIT = 100;
export const METRICS_COST_TREND_LIMIT = 200;

interface MetricsAggregateRow {
  total_scans: number;
  completed_scans: number;
  running_scans: number;
  attention_scans: number;
  priced_scans: number;
  total_estimated_usd: number;
  has_upper_bound_cost: number;
  avg_duration_ms: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  findings_high_priced: number;
  findings_total_priced: number;
  severity_critical: number;
  severity_high: number;
  severity_medium: number;
  severity_low: number;
  severity_info: number;
  severity_unknown: number;
  severity_total: number;
}

interface MetricSelection {
  fromWhere: string;
  where: string;
  params: Array<string | number>;
}

/**
 * All aggregates run against the persisted metrics projection. The projection
 * is written during upsert/backfill so this endpoint neither walks artifacts
 * nor parses every cost JSON document on a polling request.
 */
export function buildMetricsSummary(filters: MetricsFilters = {}): MetricsSummary {
  const database = getDb();
  const selection = metricSelection(database, filters);
  const aggregate = database.prepare(`
    SELECT
      COUNT(*) AS total_scans,
      COALESCE(SUM(CASE WHEN runs.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_scans,
      COALESCE(SUM(CASE WHEN runs.status = 'running' THEN 1 ELSE 0 END), 0) AS running_scans,
      COALESCE(SUM(CASE WHEN runs.status IN ('failed', 'incomplete') THEN 1 ELSE 0 END), 0) AS attention_scans,
      COALESCE(SUM(CASE WHEN runs.metric_estimated_usd IS NOT NULL THEN 1 ELSE 0 END), 0) AS priced_scans,
      COALESCE(SUM(runs.metric_estimated_usd), 0) AS total_estimated_usd,
      COALESCE(MAX(runs.metric_upper_bound), 0) AS has_upper_bound_cost,
      AVG(CASE WHEN runs.duration_ms > 0 THEN runs.duration_ms END) AS avg_duration_ms,
      COALESCE(SUM(runs.metric_input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(runs.metric_output_tokens), 0) AS total_output_tokens,
      COALESCE(SUM(CASE WHEN runs.metric_estimated_usd IS NOT NULL
        THEN runs.severity_high + runs.severity_critical ELSE 0 END), 0) AS findings_high_priced,
      COALESCE(SUM(CASE WHEN runs.metric_estimated_usd IS NOT NULL
        THEN runs.severity_total ELSE 0 END), 0) AS findings_total_priced,
      COALESCE(SUM(runs.severity_critical), 0) AS severity_critical,
      COALESCE(SUM(runs.severity_high), 0) AS severity_high,
      COALESCE(SUM(runs.severity_medium), 0) AS severity_medium,
      COALESCE(SUM(runs.severity_low), 0) AS severity_low,
      COALESCE(SUM(runs.severity_info), 0) AS severity_info,
      COALESCE(SUM(runs.severity_unknown), 0) AS severity_unknown,
      COALESCE(SUM(runs.severity_total), 0) AS severity_total
    ${selection.fromWhere}
  `).get(...selection.params) as MetricsAggregateRow;

  const totalEstimatedUsd = Number(aggregate.total_estimated_usd);
  const severity: SeverityCounts = {
    critical: Number(aggregate.severity_critical),
    high: Number(aggregate.severity_high),
    medium: Number(aggregate.severity_medium),
    low: Number(aggregate.severity_low),
    info: Number(aggregate.severity_info),
    unknown: Number(aggregate.severity_unknown),
    total: Number(aggregate.severity_total),
  };
  const byModelEffort = (database.prepare(`
    SELECT
      COALESCE(runs.model, 'unknown') AS model,
      COALESCE(runs.effort, 'unknown') AS effort,
      COUNT(*) AS runs,
      COALESCE(SUM(CASE WHEN runs.metric_estimated_usd IS NOT NULL THEN 1 ELSE 0 END), 0) AS priced_runs,
      COALESCE(SUM(runs.metric_estimated_usd), 0) AS total_usd,
      COALESCE(SUM(CASE WHEN runs.metric_estimated_usd IS NOT NULL
        THEN runs.severity_high + runs.severity_critical ELSE 0 END), 0) AS findings_high,
      COALESCE(SUM(CASE WHEN runs.metric_estimated_usd IS NOT NULL
        THEN runs.severity_total ELSE 0 END), 0) AS findings_total
    ${selection.fromWhere}
    GROUP BY COALESCE(runs.model, 'unknown'), COALESCE(runs.effort, 'unknown')
  `).all(...selection.params) as Array<{
    model: string;
    effort: string;
    runs: number;
    priced_runs: number;
    total_usd: number;
    findings_high: number;
    findings_total: number;
  }>).map((group) => {
    const pricedRuns = Number(group.priced_runs);
    const totalUsd = Number(group.total_usd);
    const findingsHigh = Number(group.findings_high);
    const findingsTotal = Number(group.findings_total);
    return {
      model: group.model,
      effort: group.effort,
      runs: Number(group.runs),
      totalUsd,
      avgUsd: pricedRuns > 0 ? totalUsd / pricedRuns : 0,
      findingsHigh,
      findingsTotal,
      highPerDollar: totalUsd > 0 ? findingsHigh / totalUsd : null,
      totalPerDollar: totalUsd > 0 ? findingsTotal / totalUsd : null,
    };
  }).sort((a, b) => (b.highPerDollar ?? -1) - (a.highPerDollar ?? -1));

  const costTrendTotal = (database.prepare(`
    SELECT COUNT(*) AS count
    ${selection.fromWhere}
      AND runs.metric_estimated_usd IS NOT NULL
      AND runs.started_at IS NOT NULL
  `).get(...selection.params) as { count: number }).count;
  const costTrend = (database.prepare(`
    SELECT
      runs.id, runs.display_name, runs.started_at, runs.metric_estimated_usd,
      runs.severity_high, runs.severity_critical, runs.severity_total,
      runs.model, runs.effort, runs.metric_upper_bound
    ${selection.fromWhere}
      AND runs.metric_estimated_usd IS NOT NULL
      AND runs.started_at IS NOT NULL
    ORDER BY runs.started_at DESC, runs.id DESC
    LIMIT ?
  `).all(...selection.params, METRICS_COST_TREND_LIMIT) as Array<{
    id: string;
    display_name: string;
    started_at: string;
    metric_estimated_usd: number;
    severity_high: number;
    severity_critical: number;
    severity_total: number;
    model: string | null;
    effort: string | null;
    metric_upper_bound: number;
  }>).reverse().map((run) => ({
    scanId: run.id,
    displayName: run.display_name,
    startedAt: run.started_at,
    estimatedUsd: Number(run.metric_estimated_usd),
    findingsHigh: Number(run.severity_high) + Number(run.severity_critical),
    findingsTotal: Number(run.severity_total),
    model: run.model,
    effort: run.effort,
    estimateKind: run.metric_upper_bound === 1 ? "upper-bound" as const : null,
  }));

  const topCategories = database.prepare(`
    SELECT
      categories.category AS category,
      COALESCE(SUM(categories.finding_count), 0) AS count,
      COALESCE(SUM(categories.high_count), 0) AS high
    FROM run_finding_category_metrics AS categories
    INNER JOIN runs ON runs.id = categories.scan_id
    LEFT JOIN hidden_runs ON hidden_runs.id = runs.id
    WHERE ${selection.where}
      AND runs.status = 'completed' AND runs.severity_total > 0
    GROUP BY categories.category
    ORDER BY count DESC, high DESC, categories.category ASC
    LIMIT 8
  `).all(...selection.params) as MetricsSummary["topCategories"];

  const recent = (database.prepare(`
    SELECT runs.*
    ${selection.fromWhere}
    ORDER BY COALESCE(runs.started_at, runs.created_at) DESC, runs.id DESC
    LIMIT ?
  `).all(...selection.params, METRICS_RECENT_LIMIT) as BenchmarkRow[]).map(rowToScanRun);

  return {
    totalScans: Number(aggregate.total_scans),
    completedScans: Number(aggregate.completed_scans),
    runningScans: Number(aggregate.running_scans),
    attentionScans: Number(aggregate.attention_scans),
    pricedScans: Number(aggregate.priced_scans),
    totalEstimatedUsd,
    avgUsdPerScan: aggregate.priced_scans > 0 ? totalEstimatedUsd / aggregate.priced_scans : 0,
    hasUpperBoundCost: aggregate.has_upper_bound_cost === 1,
    avgDurationMs: aggregate.avg_duration_ms === null ? null : Number(aggregate.avg_duration_ms),
    totalInputTokens: Number(aggregate.total_input_tokens),
    totalOutputTokens: Number(aggregate.total_output_tokens),
    highPerDollar: totalEstimatedUsd > 0 ? Number(aggregate.findings_high_priced) / totalEstimatedUsd : null,
    findingsPerDollar: totalEstimatedUsd > 0 ? Number(aggregate.findings_total_priced) / totalEstimatedUsd : null,
    severity,
    byModelEffort,
    costTrend,
    costTrendTotal: Number(costTrendTotal),
    topCategories,
    recent,
    recentTotal: Number(aggregate.total_scans),
  };
}

function metricSelection(database: ReturnType<typeof getDb>, filters: MetricsFilters): MetricSelection {
  database.function(
    "sentinel_metrics_search_lower",
    { deterministic: true },
    (value: unknown) => String(value ?? "").toLocaleLowerCase(),
  );
  database.function(
    "sentinel_metrics_started_at_ms",
    { deterministic: true },
    (value: unknown) => {
      const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : null;
    },
  );
  const params: Array<string | number> = [];
  let where = "hidden_runs.id IS NULL";
  if (filters.days != null) {
    const cutoff = (filters.now ?? new Date()).getTime() - filters.days * 24 * 60 * 60 * 1_000;
    // Date.parse preserves the historical milliseconds/offset/invalid-date rule.
    where += ` AND sentinel_metrics_started_at_ms(runs.started_at) >= ?`;
    params.push(cutoff);
  }
  if (filters.engine) {
    where += ` AND runs.engine = ?`;
    params.push(filters.engine);
  }
  if (filters.repository) {
    where += ` AND runs.display_name = ?`;
    params.push(filters.repository);
  }
  if (filters.status === "active") where += ` AND runs.status IN ('queued', 'running')`;
  if (filters.status === "completed") where += ` AND runs.status = 'completed'`;
  if (filters.status === "attention") where += ` AND runs.status IN ('failed', 'incomplete')`;
  const query = filters.query?.trim().toLocaleLowerCase() ?? "";
  if (query) {
    where += `
      AND instr(sentinel_metrics_search_lower(
        runs.id || char(10) || runs.display_name || char(10) ||
        COALESCE(runs.repository_path, '') || char(10) ||
        COALESCE(runs.model, '') || char(10) || COALESCE(runs.provider, '') || char(10) ||
        COALESCE(runs.engine, '') || char(10) || COALESCE(runs.mode, '')
      ), ?) > 0`;
    params.push(query);
  }
  return {
    fromWhere: `
      FROM runs
      LEFT JOIN hidden_runs ON hidden_runs.id = runs.id
      WHERE ${where}`,
    where,
    params,
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
