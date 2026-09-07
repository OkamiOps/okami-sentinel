import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  PrinterIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import {
  MAX_COMPARE_SCANS,
  scanEstimatedUsd,
  type CompareFindingChange,
  type CompareFindingDelta,
  type ComparePairResult,
  type CompareResult,
  type ScanRun,
  type Severity,
} from "@csb/shared";
import { api } from "../api";
import {
  Kicker,
  MetaCell,
  Metric,
  ReportBrand,
  ReportFooter,
  ReportHeader,
  ReportSheet,
} from "../components/report/ReportPrimitives";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import {
  buildDecisionRanking,
  buildMarginalEconomics,
  isPartialComparableScan,
  type CompareObjective,
  type ScanDecisionRow,
} from "../lib/compare-decision";
import { formatDuration, formatScanUsd, formatUsd, shortId } from "../format";
import { Button } from "@/components/ui/button";
import { formatApiError } from "../lib/http";
import { useScopedI18n } from "../i18n/scoped";
import {
  compareReportMessages,
  compareReportPtBR,
} from "../i18n/compare-report";
import {
  executionProfileLabel,
  hasExecutionProfileMismatch,
} from "../lib/execution-profile";

const objectiveMeta: Record<
  CompareObjective,
  {
    label:
      | "compare.objective.balanced"
      | "compare.objective.coverage"
      | "compare.objective.highPlus"
      | "compare.objective.costFinding"
      | "compare.objective.costHigh"
      | "compare.objective.speed";
    description:
      | "compare.objective.balancedDescription"
      | "compare.objective.coverageDescription"
      | "compare.objective.highPlusDescription"
      | "compare.objective.costFindingDescription"
      | "compare.objective.costHighDescription"
      | "compare.objective.speedDescription";
  }
> = {
  balanced: {
    label: "compare.objective.balanced",
    description: "compare.objective.balancedDescription",
  },
  coverage: {
    label: "compare.objective.coverage",
    description: "compare.objective.coverageDescription",
  },
  high_plus: {
    label: "compare.objective.highPlus",
    description: "compare.objective.highPlusDescription",
  },
  cost_per_finding: {
    label: "compare.objective.costFinding",
    description: "compare.objective.costFindingDescription",
  },
  cost_per_high: {
    label: "compare.objective.costHigh",
    description: "compare.objective.costHighDescription",
  },
  speed: {
    label: "compare.objective.speed",
    description: "compare.objective.speedDescription",
  },
};
const severityText: Record<Severity, string> = {
  critical: "text-chart-4",
  high: "text-destructive",
  medium: "text-chart-3",
  low: "text-primary",
  info: "text-chart-2",
  unknown: "text-muted-foreground",
};
const changeLabel: Record<
  CompareFindingChange,
  | "compare.change.candidateOnly"
  | "compare.change.baselineOnly"
  | "compare.change.both"
  | "compare.change.severityChanged"
> = {
  candidate_only: "compare.change.candidateOnly",
  baseline_only: "compare.change.baselineOnly",
  both: "compare.change.both",
  severity_changed: "compare.change.severityChanged",
};
const changeTone: Record<CompareFindingChange, string> = {
  candidate_only: "text-primary",
  baseline_only: "text-chart-3",
  both: "text-chart-2",
  severity_changed: "text-chart-4",
};
const scanStatusLabel: Record<
  ScanRun["status"],
  keyof typeof compareReportPtBR
> = {
  queued: "compareReport.statusQueued",
  running: "compareReport.statusRunning",
  completed: "compareReport.statusCompleted",
  failed: "compareReport.statusFailed",
  cancelled: "compareReport.statusCancelled",
  incomplete: "compareReport.statusIncomplete",
};
type CompareReportT = ReturnType<
  typeof useScopedI18n<keyof typeof compareReportPtBR>
>["t"];
type ReportResult = { requestKey: string; value: CompareResult };
type ReportLoadError =
  | { requestKey: string; kind: "invalid-selection" }
  | { requestKey: string; kind: "request"; reason: unknown };

export function CompareReportPage() {
  const { t } = useScopedI18n(compareReportMessages);
  const [params] = useSearchParams();
  const ids = useMemo(
    () =>
      [...new Set((params.get("ids") ?? "").split(",").filter(Boolean))].slice(
        0,
        MAX_COMPARE_SCANS,
      ),
    [params],
  );
  const requestKey = ids.join(",");
  const objective = parseObjective(params.get("objective"));
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState<ReportLoadError | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const displayedResult =
    result?.requestKey === requestKey ? result.value : null;
  const displayedError = error?.requestKey === requestKey ? error : null;
  const errorMessage =
    displayedError?.kind === "invalid-selection"
      ? t("compareReport.invalidSelection")
      : displayedError
        ? formatApiError(displayedError.reason, t)
        : null;

  useEffect(() => {
    let active = true;
    setError(null);
    if (ids.length < 2) {
      setLoading(false);
      setError({ requestKey, kind: "invalid-selection" });
      return () => {
        active = false;
      };
    }
    setLoading(true);
    api
      .compare({ scanIds: ids })
      .then((value) => {
        if (active) {
          setResult({ requestKey, value });
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (active) {
          setError({ requestKey, kind: "request", reason });
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [ids.length, reload, requestKey]);

  useEffect(() => {
    const previous = document.title;
    document.title = displayedResult
      ? t("compareReport.documentTitle", {
          count: displayedResult.scans.length,
        })
      : t("compareReport.documentTitleEmpty");
    return () => {
      document.title = previous;
    };
  }, [displayedResult, t]);

  if (errorMessage && !displayedResult)
    return (
      <ReportError
        error={errorMessage}
        onRetry={() => setReload((value) => value + 1)}
      />
    );
  if (!displayedResult)
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-screen items-center justify-center font-mono text-[10px] uppercase tracking-[.18em] text-muted-foreground"
      >
        {t("compareReport.loading")}
      </div>
    );

  const ranking = buildDecisionRanking(displayedResult.scans, objective);
  const marginal = new Map(
    buildMarginalEconomics(ranking, displayedResult.baselineScanId).map(
      (row) => [row.scanId, row],
    ),
  );
  const baseline = displayedResult.scans.find(
    (scan) => scan.id === displayedResult.baselineScanId,
  )!;
  const partialScans = displayedResult.scans.filter(isPartialComparableScan);
  const pricedCosts = displayedResult.scans
    .map(scanEstimatedUsd)
    .filter((value): value is number => value != null);
  const totalCost = pricedCosts.length
    ? pricedCosts.reduce((sum, value) => sum + value, 0)
    : null;
  const totalCostIsUpperBound = displayedResult.scans.some(
    (scan) => scan.cost?.estimateKind === "upper-bound",
  );
  const reportId = `CMP-${displayedResult.baselineScanId.slice(0, 6).toUpperCase()}-${displayedResult.scans.length}X`;
  const winner = ranking[0];
  const backHref = `/compare?ids=${displayedResult.scans.map((scan) => scan.id).join(",")}`;
  const objectiveLabel = t(objectiveMeta[objective].label);
  const objectiveDescription = t(objectiveMeta[objective].description);

  return (
    <div className="report-root min-h-screen bg-[var(--surface-code)] pb-16 text-foreground">
      <div className="report-toolbar report-no-print sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-[210mm] items-center gap-1 px-2 py-3 sm:gap-2 sm:px-4">
          <Button asChild variant="ghost" size="sm">
            <Link to={backHref}>
              <HugeiconsIcon icon={ArrowLeft01Icon} size={13} />
              {t("report.back")}
            </Link>
          </Button>
          <div className="hidden min-w-0 flex-1 truncate px-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground md:block">
            {t("compareReport.toolbarSummary", {
              count: displayedResult.scans.length,
              objective: objectiveLabel,
            })}
          </div>
          <LanguageSwitcher />
          <Button
            variant="outline"
            size="sm"
            aria-label={t("report.refresh")}
            disabled={loading}
            onClick={() => setReload((value) => value + 1)}
          >
            <HugeiconsIcon icon={RefreshIcon} size={13} />
            <span className="hidden sm:inline">{t("report.refresh")}</span>
          </Button>
          <Button
            size="sm"
            aria-label={t("report.print")}
            onClick={() => window.print()}
          >
            <HugeiconsIcon icon={PrinterIcon} size={13} />
            <span className="hidden sm:inline">{t("report.print")}</span>
            <span className="sm:hidden">{t("compareReport.pdf")}</span>
          </Button>
        </div>
        {errorMessage && (
          <div
            role="status"
            aria-live="polite"
            className="border-t border-chart-3/40 bg-chart-3/10 px-4 py-2 text-xs text-foreground"
          >
            <div className="mx-auto flex max-w-[210mm] flex-wrap items-center gap-2">
              <strong>{t("compareReport.staleTitle")}</strong>
              <span>{errorMessage}</span>
              <span className="text-muted-foreground">
                {t("compareReport.staleDescription")}
              </span>
              <Button
                className="ml-auto"
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => setReload((value) => value + 1)}
              >
                {t("common.retry")}
              </Button>
            </div>
          </div>
        )}
      </div>

      <main className="report-stack">
        <ReportSheet className="report-cover overflow-hidden">
          <img
            src="/brand/okami-sentinel-mark.png"
            alt=""
            className="pointer-events-none absolute -bottom-20 -right-12 w-[34rem] max-w-[72%] opacity-[.14] grayscale"
          />
          <div className="relative z-10 flex min-h-0 flex-1 flex-col">
            <ReportBrand />
            <div className="mt-20 max-w-[38rem]">
              <Kicker>{t("compareReport.coverKicker")}</Kicker>
              <h1 className="mt-5 font-heading text-[3.55rem] font-semibold leading-[.94] tracking-[-.065em]">
                {t("compareReport.coverTitleLead")}
                <br />
                {t("compareReport.coverTitleTail")}
              </h1>
              <div className="mt-7 h-px w-28 bg-chart-1" />
              <p className="mt-7 max-w-xl text-lg leading-relaxed text-muted-foreground">
                {t("compareReport.coverDescription")}
              </p>
            </div>
            <div className="mt-auto grid border-y border-border sm:grid-cols-2">
              <MetaCell
                label={t("compareReport.baselineLabel")}
                value={`${baseline.displayName} / ${shortId(baseline.id)}`}
              />
              <MetaCell
                label={t("compareReport.comparisonSetLabel")}
                value={t("compareReport.comparisonSetValue", {
                  scans: displayedResult.scans.length,
                  candidates: displayedResult.candidateScanIds.length,
                })}
              />
              <MetaCell
                label={t("compareReport.decisionObjectiveLabel")}
                value={objectiveLabel}
              />
              <MetaCell
                label={t("compareReport.reportIdLabel")}
                value={reportId}
              />
            </div>
            <div className="mt-7 flex items-center justify-between gap-4 font-mono text-[8px] uppercase tracking-[.16em] text-muted-foreground">
              <span>{t("compareReport.confidentialEvidence")}</span>
              <span>
                {t("compareReport.partialInputs", {
                  count: partialScans.length,
                })}
              </span>
            </div>
          </div>
        </ReportSheet>

        <ReportSheet className="report-executive-sheet">
          <ReportHeader
            section="01"
            title={t("report.executive")}
            reportId={reportId}
          />
          <div className="mt-9">
            <section className="report-keep border border-border p-6">
              <Kicker>{t("compareReport.winnerKicker")}</Kicker>
              <div className="report-executive-winner mt-4 grid gap-5 md:grid-cols-[minmax(0,1fr)_16rem]">
                <div>
                  <div className="flex items-start gap-4">
                    <span className="font-mono text-5xl font-semibold text-primary">
                      01
                    </span>
                    <div className="min-w-0">
                      <h2 className="break-words font-heading text-2xl font-semibold leading-tight tracking-[-.04em] sm:text-3xl">
                        {profile(winner.scan, t)}
                      </h2>
                      <p className="mt-1 font-mono text-[8px] text-muted-foreground">
                        {winner.scan.displayName} / {shortId(winner.scan.id)}
                      </p>
                    </div>
                  </div>
                  <p className="mt-6 text-sm leading-7 text-muted-foreground">
                    {t("compareReport.winnerSummary", {
                      objective: objectiveLabel,
                      description: objectiveDescription,
                    })}
                  </p>
                </div>
                {isPartialComparableScan(winner.scan) ? (
                  <div className="self-start border-l-2 border-chart-3 bg-chart-3/5 px-4 py-3 text-xs leading-6">
                    <strong>{t("compareReport.partialResultTitle")}</strong>{" "}
                    {t("compareReport.partialResultDescription")}
                  </div>
                ) : (
                  <div className="self-start border-l-2 border-chart-2 bg-chart-2/5 px-4 py-3 text-xs leading-6">
                    <strong>{t("compareReport.completeResultTitle")}</strong>{" "}
                    {t("compareReport.completeResultDescription")}
                  </div>
                )}
              </div>
            </section>
            <section className="report-keep mt-4 grid grid-cols-2 border border-border sm:grid-cols-4">
              <Metric
                label={t("compareReport.scansMetric")}
                value={displayedResult.scans.length}
              />
              <Metric
                label={t("compareReport.partialMetric")}
                value={partialScans.length}
                tone="text-chart-3"
              />
              <Metric
                label={
                  pricedCosts.length === displayedResult.scans.length
                    ? t("compareReport.totalCostMetric")
                    : t("compareReport.knownCostMetric")
                }
                value={formatUsd(totalCost, totalCostIsUpperBound)}
                tone="text-chart-1"
                kind="currency"
              />
              <Metric
                label={t("compareReport.objectiveMetric")}
                value={objectiveLabel}
                tone="text-primary"
                kind="compact"
              />
            </section>
          </div>
          <RankingRows rows={ranking} marginal={marginal} />
          <div className="report-executive-note mt-4 border-l-2 border-chart-3 px-4 text-[9px] leading-4 text-muted-foreground">
            <strong className="text-foreground">
              {t("compareReport.readingLimitTitle")}
            </strong>{" "}
            {t("compareReport.readingLimitDescription")}
          </div>
          <ReportFooter reportId={reportId} />
        </ReportSheet>

        <ReportSheet>
          <ReportHeader
            section="02"
            title={t("compareReport.coverageCostSeverity")}
            reportId={reportId}
          />
          <section className="report-keep mt-8 border border-border p-5">
            <Kicker>{t("compareReport.costCoverageKicker")}</Kicker>
            <CoverageCostPlot rows={ranking} />
          </section>
          <section className="report-keep mt-5 border border-border">
            <div className="border-b border-border px-5 py-4">
              <Kicker>{t("compareReport.severityProfileKicker")}</Kicker>
            </div>
            <div className="p-5">
              <SeverityProfiles scans={displayedResult.scans} />
            </div>
          </section>
          <ReportFooter reportId={reportId} />
        </ReportSheet>

        {displayedResult.comparisons.map((comparison, index) => (
          <PairSummarySheet
            key={comparison.candidateScanId}
            result={displayedResult}
            comparison={comparison}
            index={index}
            reportId={reportId}
          />
        ))}

        <ReportSheet>
          <ReportHeader
            section="04"
            title={t("report.conclusion")}
            reportId={reportId}
          />
          <div className="report-conclusion-grid report-keep mt-16 grid gap-6 md:grid-cols-[1.2fr_.8fr]">
            <section>
              <Kicker>{t("compareReport.decisionHandoff")}</Kicker>
              <h2 className="mt-4 font-heading text-4xl font-semibold tracking-[-.05em]">
                {t("compareReport.conclusionTitle")}
              </h2>
              <p className="mt-6 text-base leading-8 text-muted-foreground">
                {t("compareReport.conclusionDescription")}
              </p>
            </section>
            <div className="border border-border p-6">
              <Kicker>{t("compareReport.nextActions")}</Kicker>
              <ol className="mt-5 space-y-5">
                {(
                  [
                    "compareReport.nextActionConfirmSample",
                    "compareReport.nextActionReviewSignals",
                    "compareReport.nextActionNormalize",
                    "compareReport.nextActionRecordFalsePositives",
                    "compareReport.nextActionRepeat",
                  ] as const
                ).map((item, index) => (
                  <li key={item} className="flex gap-4">
                    <span className="font-mono text-xs text-primary">
                      0{index + 1}
                    </span>
                    <span className="text-sm">{t(item)}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <div className="mt-auto flex flex-col items-center justify-center py-16 text-center">
            <img
              src="/brand/okami-sentinel-mark.png"
              alt="OKAMI Sentinel"
              className="h-32 w-32 object-contain"
            />
            <div className="mt-4 font-heading text-xl font-semibold tracking-[.25em]">
              OKAMI
            </div>
            <div className="font-mono text-[9px] uppercase tracking-[.45em] text-muted-foreground">
              Sentinel
            </div>
          </div>
          <ReportFooter reportId={reportId} />
        </ReportSheet>
      </main>
    </div>
  );
}

function RankingRows({
  rows,
  marginal,
}: {
  rows: ScanDecisionRow[];
  marginal: Map<string, ReturnType<typeof buildMarginalEconomics>[number]>;
}) {
  const { t } = useScopedI18n(compareReportMessages);
  return (
    <section className="mt-5 border border-border">
      <div className="hidden sm:block">
        <div className="report-row grid grid-cols-[2.5rem_minmax(0,1fr)_4.5rem_4rem_5.5rem_5.5rem] border-b border-border bg-muted/40 px-4 py-2 font-mono text-[7px] uppercase tracking-wider text-muted-foreground">
          <span>#</span>
          <span>{t("compareReport.rankingExecution")}</span>
          <span>{t("compareReport.rankingScore")}</span>
          <span>High+</span>
          <span>{t("compareReport.rankingCost")}</span>
          <span>{t("compareReport.rankingCostPerFinding")}</span>
        </div>
        {rows.map((row, index) => (
          <div
            key={row.scan.id}
            className="report-row grid grid-cols-[2.5rem_minmax(0,1fr)_4.5rem_4rem_5.5rem_5.5rem] items-center border-b border-border px-4 py-3 last:border-0"
          >
            <span className="font-mono text-sm text-primary">0{index + 1}</span>
            <div className="min-w-0 pr-3">
              <div className="report-copy text-[10px] font-semibold leading-4">
                {profile(row.scan, t)}
              </div>
              <div className="report-copy mt-1 font-mono text-[7px] leading-3 text-muted-foreground">
                {shortId(row.scan.id)} ·{" "}
                {t("compareReport.totalValue", { count: row.total })}
                {marginal.get(row.scan.id)?.extraFindings
                  ? ` · ${t("compareReport.vsBaseline", { count: signed(marginal.get(row.scan.id)!.extraFindings) })}`
                  : ""}
              </div>
            </div>
            <span className="font-mono text-[10px]">
              {row.score.toFixed(1)}
            </span>
            <span className="font-mono text-[10px] text-chart-4">
              {row.highPlus}
            </span>
            <span className="report-copy font-mono text-[8px] text-chart-1">
              {formatUsd(
                row.costUsd,
                row.scan.cost?.estimateKind === "upper-bound",
              )}
            </span>
            <span className="report-copy font-mono text-[8px] text-primary">
              {formatUsd(
                row.costPerFinding,
                row.scan.cost?.estimateKind === "upper-bound",
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="sm:hidden">
        {rows.map((row, index) => (
          <div
            key={row.scan.id}
            className="report-row border-b border-border p-4 last:border-0"
          >
            <div className="flex items-start gap-3">
              <span className="font-mono text-lg text-primary">
                0{index + 1}
              </span>
              <div className="min-w-0">
                <div className="break-words text-[11px] font-semibold">
                  {profile(row.scan, t)}
                </div>
                <div className="mt-1 font-mono text-[7px] text-muted-foreground">
                  {shortId(row.scan.id)} ·{" "}
                  {t("compareReport.totalValue", { count: row.total })}
                </div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-4 border border-border">
              <SmallMetric
                label={t("compareReport.scoreMetric")}
                value={row.score.toFixed(1)}
              />
              <SmallMetric label="High+" value={row.highPlus} />
              <SmallMetric
                label={t("compareReport.costMetric")}
                value={formatUsd(
                  row.costUsd,
                  row.scan.cost?.estimateKind === "upper-bound",
                )}
              />
              <SmallMetric
                label={t("compareReport.costPerFindingMetric")}
                value={formatUsd(
                  row.costPerFinding,
                  row.scan.cost?.estimateKind === "upper-bound",
                )}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CoverageCostPlot({ rows }: { rows: ScanDecisionRow[] }) {
  const { t } = useScopedI18n(compareReportMessages);
  const pricedRows = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.costUsd != null);
  if (!pricedRows.length)
    return (
      <div className="mt-4 border border-border p-6 text-[10px] leading-5 text-muted-foreground">
        {t("compareReport.noComparableCost")}
      </div>
    );
  const maxCost = Math.max(1, ...pricedRows.map(({ row }) => row.costUsd!));
  const maxTotal = Math.max(1, ...pricedRows.map(({ row }) => row.total));
  const maxHigh = Math.max(1, ...pricedRows.map(({ row }) => row.highPlus));
  return (
    <div className="mt-4">
      <svg
        viewBox="0 0 640 300"
        role="img"
        aria-label={t("compareReport.costCoverageAria")}
        className="h-auto w-full"
      >
        <line x1="58" y1="248" x2="596" y2="248" stroke="var(--border)" />
        <line x1="58" y1="34" x2="58" y2="248" stroke="var(--border)" />
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <g key={ratio}>
            <line
              x1="58"
              y1={248 - ratio * 198}
              x2="596"
              y2={248 - ratio * 198}
              stroke="var(--border)"
              strokeDasharray="2 6"
            />
            <line
              x1={58 + ratio * 516}
              y1="34"
              x2={58 + ratio * 516}
              y2="248"
              stroke="var(--border)"
              strokeDasharray="2 6"
            />
          </g>
        ))}
        <text x="58" y="278" fill="var(--muted-foreground)" fontSize="9">
          {t("compareReport.lowCostAxis")}
        </text>
        <text x="528" y="278" fill="var(--muted-foreground)" fontSize="9">
          {t("compareReport.highCostAxis")}
        </text>
        <text x="63" y="22" fill="var(--muted-foreground)" fontSize="9">
          {t("compareReport.moreFindingsAxis")}
        </text>
        {pricedRows.map(({ row, index }) => {
          const radius = 8 + (row.highPlus / maxHigh) * 10;
          const x = 58 + radius + (row.costUsd! / maxCost) * (516 - radius * 2);
          const y = 248 - radius - (row.total / maxTotal) * (198 - radius * 2);
          return (
            <g key={row.scan.id}>
              <circle
                cx={x}
                cy={y}
                r={radius}
                fill={
                  index === 0
                    ? "var(--primary)"
                    : `var(--chart-${(index % 5) + 1})`
                }
                fillOpacity=".78"
                stroke="var(--foreground)"
                strokeWidth="1"
              />
              <text
                x={x}
                y={y + 3}
                textAnchor="middle"
                fill="var(--background)"
                fontSize="8"
                fontWeight="700"
              >
                S{index + 1}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {rows.map((row, index) => (
          <div
            key={row.scan.id}
            className="flex min-w-0 items-start gap-2 border border-border px-2 py-2"
          >
            <span className="font-mono text-[8px] text-primary">
              S{index + 1}
            </span>
            <span className="report-copy min-w-0 font-mono text-[7px] leading-3 text-muted-foreground">
              {profile(row.scan, t)} ·{" "}
              {formatUsd(
                row.costUsd,
                row.scan.cost?.estimateKind === "upper-bound",
              )}{" "}
              · {t("compareReport.totalValue", { count: row.total })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SeverityProfiles({ scans }: { scans: ScanRun[] }) {
  const { t } = useScopedI18n(compareReportMessages);
  const max = Math.max(1, ...scans.map((scan) => scan.severity.total));
  return (
    <div className="space-y-3">
      {scans.map((scan, index) => (
        <div
          key={scan.id}
          className="grid grid-cols-[2rem_10.5rem_minmax(0,1fr)_3rem] items-center gap-3"
        >
          <span className="font-mono text-[8px] text-primary">
            S{index + 1}
          </span>
          <span className="report-copy font-mono text-[7px] leading-3">
            {profile(scan, t)}
          </span>
          <div className="flex h-3 bg-muted">
            {(["critical", "high", "medium", "low", "info"] as const).map(
              (severity) => (
                <span
                  key={severity}
                  className={
                    severity === "critical"
                      ? "bg-chart-4"
                      : severity === "high"
                        ? "bg-destructive"
                        : severity === "medium"
                          ? "bg-chart-3"
                          : severity === "low"
                            ? "bg-primary"
                            : "bg-chart-2"
                  }
                  style={{ width: `${(scan.severity[severity] / max) * 100}%` }}
                />
              ),
            )}
          </div>
          <span className="text-right font-mono text-[9px]">
            {scan.severity.total}
          </span>
        </div>
      ))}
    </div>
  );
}

function PairSummarySheet({
  result,
  comparison,
  index,
  reportId,
}: {
  result: CompareResult;
  comparison: ComparePairResult;
  index: number;
  reportId: string;
}) {
  const { t } = useScopedI18n(compareReportMessages);
  const baseline = result.scans.find(
    (scan) => scan.id === result.baselineScanId,
  )!;
  const candidate = result.scans.find(
    (scan) => scan.id === comparison.candidateScanId,
  )!;
  const baselineHigh = baseline.severity.critical + baseline.severity.high;
  const candidateHigh = candidate.severity.critical + candidate.severity.high;
  const total = comparison.findings.length || 1;
  const baselineCost = scanEstimatedUsd(baseline);
  const candidateCost = scanEstimatedUsd(candidate);
  const costDelta =
    baselineCost == null ||
    candidateCost == null ||
    baseline.cost?.estimateKind === "upper-bound" ||
    candidate.cost?.estimateKind === "upper-bound"
      ? null
      : candidateCost - baselineCost;
  const baselineCostPerFinding = unitCost(
    baselineCost,
    baseline.severity.total,
  );
  const candidateCostPerFinding = unitCost(
    candidateCost,
    candidate.severity.total,
  );
  const baselineCostPerHigh = unitCost(baselineCost, baselineHigh);
  const candidateCostPerHigh = unitCost(candidateCost, candidateHigh);
  const agreement = Math.round(
    ((comparison.counts.both + comparison.counts.severity_changed) / total) *
      100,
  );
  const priority = priorityDivergences(comparison.findings, 3);
  const direction =
    candidate.severity.total === baseline.severity.total
      ? t("compareReport.directionSame")
      : candidate.severity.total > baseline.severity.total
        ? t("compareReport.directionMore", {
            count: candidate.severity.total - baseline.severity.total,
          })
        : t("compareReport.directionFewer", {
            count: baseline.severity.total - candidate.severity.total,
          });
  return (
    <ReportSheet>
      <ReportHeader
        section="03"
        title={t("compareReport.pairTitle", {
          number: String(index + 1).padStart(2, "0"),
          profile: profile(candidate, t),
        })}
        reportId={reportId}
      />
      <div className="report-run-comparison report-keep mt-7 grid gap-3 md:grid-cols-[1fr_auto_1fr]">
        <RunCard role={t("compareReport.baselineLabel")} scan={baseline} />
        <div className="report-run-arrow hidden items-center font-mono text-xl text-primary md:flex">
          →
        </div>
        <RunCard
          role={t("compareReport.candidateRole", {
            number: String(index + 1).padStart(2, "0"),
          })}
          scan={candidate}
        />
      </div>
      <section className="report-keep mt-4 grid grid-cols-2 border border-border sm:grid-cols-4">
        <Metric
          label={t("compareReport.deltaTotal")}
          value={signed(candidate.severity.total - baseline.severity.total)}
          tone="text-primary"
        />
        <Metric
          label={t("compareReport.deltaHigh")}
          value={signed(candidateHigh - baselineHigh)}
          tone="text-chart-4"
        />
        <Metric
          label={t("compareReport.deltaCost")}
          value={formatSignedUsd(costDelta)}
          tone="text-chart-1"
          kind="currency"
        />
        <Metric
          label={t("compareReport.agreement")}
          value={`${agreement}%`}
          tone="text-chart-2"
        />
      </section>
      <section className="report-keep mt-4 border border-border p-4">
        <Kicker>{t("compareReport.operationalReading")}</Kicker>
        <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
          {t("compareReport.operationalSummary", {
            direction,
            highDelta: signed(candidateHigh - baselineHigh),
            costDelta: formatSignedUsd(costDelta),
            baselineFindingCost: formatUsd(
              baselineCostPerFinding,
              baseline.cost?.estimateKind === "upper-bound",
            ),
            candidateFindingCost: formatUsd(
              candidateCostPerFinding,
              candidate.cost?.estimateKind === "upper-bound",
            ),
            baselineHighCost: formatUsd(
              baselineCostPerHigh,
              baseline.cost?.estimateKind === "upper-bound",
            ),
            candidateHighCost: formatUsd(
              candidateCostPerHigh,
              candidate.cost?.estimateKind === "upper-bound",
            ),
          })}
        </p>
        <div className="mt-3 flex h-3 bg-muted">
          {(
            [
              "candidate_only",
              "severity_changed",
              "both",
              "baseline_only",
            ] as CompareFindingChange[]
          ).map((change) => (
            <span
              key={change}
              className={
                change === "candidate_only"
                  ? "bg-primary"
                  : change === "severity_changed"
                    ? "bg-chart-4"
                    : change === "both"
                      ? "bg-chart-2"
                      : "bg-chart-3"
              }
              style={{ width: `${(comparison.counts[change] / total) * 100}%` }}
            />
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              "candidate_only",
              "severity_changed",
              "both",
              "baseline_only",
            ] as CompareFindingChange[]
          ).map((change) => (
            <div
              key={change}
              className="flex items-center justify-between border border-border px-2 py-2"
            >
              <span
                className={`font-mono text-[6px] uppercase ${changeTone[change]}`}
              >
                {t(changeLabel[change])}
              </span>
              <strong className="font-mono text-[10px]">
                {comparison.counts[change]}
              </strong>
            </div>
          ))}
        </div>
      </section>
      <section className="mt-4 border border-border">
        <div className="report-keep border-b border-border px-4 py-3">
          <Kicker>{t("compareReport.priorityDivergences")}</Kicker>
        </div>
        <div className="report-findings-grid grid md:grid-cols-3">
          {priority.map((finding) => (
            <DetailedFinding key={finding.key} finding={finding} />
          ))}
          {!priority.length && (
            <div className="report-keep p-6 text-xs text-muted-foreground">
              {t("compareReport.noDivergences")}
            </div>
          )}
        </div>
      </section>
      {hasExecutionProfileMismatch([baseline, candidate]) && (
        <div className="report-keep mt-5 border-l-2 border-chart-3 bg-chart-3/5 px-4 py-3 text-[10px] leading-5">
          {t("compare.profileMismatch")}
        </div>
      )}
      {(isPartialComparableScan(baseline) ||
        isPartialComparableScan(candidate)) && (
        <div className="report-keep mt-5 border-l-2 border-chart-3 bg-chart-3/5 px-4 py-3 text-[10px] leading-5">
          <strong>{t("compareReport.partialInputTitle")}</strong>{" "}
          {t("compareReport.partialInputDescription")}
        </div>
      )}
      <ReportFooter reportId={reportId} />
    </ReportSheet>
  );
}

function RunCard({ role, scan }: { role: string; scan: ScanRun }) {
  const { t } = useScopedI18n(compareReportMessages);
  const highPlus = scan.severity.critical + scan.severity.high;
  const estimatedUsd = scanEstimatedUsd(scan);
  const costPerFinding =
    estimatedUsd != null && scan.severity.total
      ? estimatedUsd / scan.severity.total
      : null;
  const executionProfile = executionProfileLabel(scan, t);
  return (
    <div className="min-w-0 border border-border p-4">
      <Kicker>{role}</Kicker>
      <div className="mt-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="report-copy font-heading text-sm font-semibold leading-5">
            {profile(scan, t)}
          </h3>
          <p className="report-copy mt-1 font-mono text-[7px] leading-3 text-muted-foreground">
            {shortId(scan.id)} · {t(scanStatusLabel[scan.status])} ·{" "}
            {formatDuration(scan.durationMs)}
          </p>
        </div>
        {isPartialComparableScan(scan) && (
          <span className="border border-chart-3/50 px-2 py-1 font-mono text-[7px] uppercase text-chart-3">
            {t("compareReport.partialBadge")}
          </span>
        )}
      </div>
      {scan.execution && (
        <p className="report-copy mt-3 border-l border-border pl-3 font-mono text-[7px] leading-3 text-muted-foreground">
          {executionProfile ?? "—"} · {scan.execution.protocol ?? "—"} ·{" "}
          {scan.execution.authKind ?? "—"}
        </p>
      )}
      <div className="mt-3 grid grid-cols-4 border border-border">
        <SmallMetric
          label={t("compareReport.totalMetric")}
          value={scan.severity.total}
        />
        <SmallMetric label="High+" value={highPlus} />
        <SmallMetric
          label={t("compareReport.costMetric")}
          value={formatScanUsd(scan)}
        />
        <SmallMetric
          label={t("compareReport.costPerFindingMetric")}
          value={formatUsd(
            costPerFinding,
            scan.cost?.estimateKind === "upper-bound",
          )}
        />
      </div>
    </div>
  );
}

function SmallMetric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 border-r border-border p-2 last:border-0">
      <div className="report-copy font-mono text-[7px] uppercase text-muted-foreground">
        {label}
      </div>
      <div className="report-copy mt-1 font-mono text-[8px] leading-3 tabular-nums">
        {value}
      </div>
    </div>
  );
}

function DetailedFinding({ finding }: { finding: CompareFindingDelta }) {
  const { t } = useScopedI18n(compareReportMessages);
  const baselineSeverity = finding.baseline?.severity ?? "—";
  const candidateSeverity = finding.candidate?.severity ?? "—";
  const occurrence = finding.candidate ?? finding.baseline;
  return (
    <article className="report-keep min-w-0 border-b border-r border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <span
          className={`font-mono text-[7px] uppercase ${changeTone[finding.change]}`}
        >
          {t(changeLabel[finding.change])}
        </span>
        <span className="shrink-0 font-mono text-[7px] uppercase">
          <span
            className={
              baselineSeverity === "—"
                ? "text-muted-foreground"
                : severityText[baselineSeverity]
            }
          >
            {baselineSeverity}
          </span>
          <span className="mx-1 text-muted-foreground">→</span>
          <span
            className={
              candidateSeverity === "—"
                ? "text-muted-foreground"
                : severityText[candidateSeverity]
            }
          >
            {candidateSeverity}
          </span>
        </span>
      </div>
      <h3 className="report-copy mt-3 text-[10px] font-semibold leading-4">
        {finding.title}
      </h3>
      <p className="report-copy mt-2 text-[9px] leading-4 text-muted-foreground">
        {trimText(
          occurrence?.summary ?? t("compareReport.noTechnicalSummary"),
          180,
        )}
      </p>
      <div className="report-copy mt-3 font-mono text-[7px] leading-3 text-muted-foreground">
        {occurrence?.primaryPath ?? occurrence?.category ?? finding.key}
        {occurrence?.cwe.length ? ` · ${occurrence.cwe.join(", ")}` : ""}
      </div>
    </article>
  );
}

function ReportError({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  const { t } = useScopedI18n(compareReportMessages);
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div
        role="alert"
        aria-live="assertive"
        tabIndex={-1}
        className="w-full max-w-xl border border-destructive/50 bg-destructive/10 p-6"
      >
        <h1 className="font-mono text-[9px] uppercase tracking-[.16em] text-destructive">
          {t("compareReport.errorTitle")}
        </h1>
        <p className="mt-3 text-sm">{error}</p>
        <Button className="mt-5" onClick={onRetry}>
          <HugeiconsIcon icon={RefreshIcon} size={13} />
          {t("common.retry")}
        </Button>
      </div>
    </div>
  );
}

function parseObjective(value: string | null): CompareObjective {
  return value && value in objectiveMeta
    ? (value as CompareObjective)
    : "balanced";
}
function profile(scan: ScanRun, t: CompareReportT): string {
  return `${scan.engine} · ${scan.model ?? t("compareReport.missingModel")}/${scan.effort ?? t("compareReport.missingEffort")}/${scan.mode ?? t("compareReport.missingMode")}`;
}
function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
function formatSignedUsd(value: number | null): string {
  return value == null
    ? "—"
    : `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatUsd(Math.abs(value))}`;
}
function unitCost(
  cost: number | null | undefined,
  findings: number,
): number | null {
  return cost == null || findings <= 0 ? null : cost / findings;
}
function trimText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
function priorityDivergences(
  findings: CompareFindingDelta[],
  limit: number,
): CompareFindingDelta[] {
  const divergent = findings.filter((finding) => finding.change !== "both");
  const picked: CompareFindingDelta[] = [];
  (
    [
      "candidate_only",
      "severity_changed",
      "baseline_only",
    ] as CompareFindingChange[]
  ).forEach((change) => {
    const finding = divergent.find((item) => item.change === change);
    if (finding) picked.push(finding);
  });
  for (const finding of divergent) {
    if (picked.length >= limit) break;
    if (!picked.includes(finding)) picked.push(finding);
  }
  return picked.slice(0, limit);
}
