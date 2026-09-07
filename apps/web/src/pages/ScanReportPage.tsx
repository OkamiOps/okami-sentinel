import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, PrinterIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { scanEstimatedUsd, type FindingDetail, type FindingLifecycle, type FindingTriageStatus, type LifecycleFinding, type ScanStatus, type Severity } from "@csb/shared";
import { api, type ScanReportData } from "../api";
import { Kicker, MetaCell, Metric, ReportBrand, ReportFooter, ReportHeader, ReportSheet, ReportText } from "../components/report/ReportPrimitives";
import { formatDate, formatDuration, formatScanUsd, formatTokens, formatUsd, shortId } from "../format";
import { Button } from "@/components/ui/button";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { useScopedI18n } from "../i18n/scoped";
import { scanReportMessages, type ScanReportKey } from "../i18n/scan-report";
import { reasoningDeliveryCopy, scanReasoningDelivery } from "../lib/reasoning-delivery";
import { executionProfileLabel } from "../lib/execution-profile";
import { scanCostPresentation, scanTokenUsage } from "../lib/scan-cost";
import { reportEvidenceBlocks, reportExcerpt } from "../lib/report-content";
import { formatApiError } from "../lib/http";
import type { TranslationKey } from "../i18n";

const severityOrder: Severity[] = ["critical", "high", "medium", "low", "info", "unknown"];
const severityLabelKey: Record<Severity, ScanReportKey> = {
  critical: "scanReport.severity.critical",
  high: "scanReport.severity.high",
  medium: "scanReport.severity.medium",
  low: "scanReport.severity.low",
  info: "scanReport.severity.info",
  unknown: "scanReport.severity.unknown",
};
const severityText: Record<Severity, string> = {
  critical: "text-chart-4",
  high: "text-destructive",
  medium: "text-chart-3",
  low: "text-primary",
  info: "text-muted-foreground",
  unknown: "text-muted-foreground",
};
const severityBar: Record<Severity, string> = {
  critical: "bg-chart-4",
  high: "bg-destructive",
  medium: "bg-chart-3",
  low: "bg-primary",
  info: "bg-muted-foreground",
  unknown: "bg-muted-foreground",
};
const lifecycleLabelKey: Record<FindingLifecycle, ScanReportKey> = {
  new: "scanReport.lifecycle.new",
  persisting: "scanReport.lifecycle.persisting",
  fixed: "scanReport.lifecycle.fixed",
  regressed: "scanReport.lifecycle.regressed",
};
const scanStatusLabelKey: Record<ScanStatus, TranslationKey> = {
  completed: "common.complete",
  running: "common.live",
  failed: "common.failed",
  cancelled: "common.cancelled",
  queued: "common.queued",
  incomplete: "common.partial",
};
const triageLabelKey: Record<FindingTriageStatus, TranslationKey> = {
  unreviewed: "scanDetail.triage.unreviewed",
  confirmed: "scanDetail.triage.confirmed",
  accepted: "scanDetail.triage.accepted",
  false_positive: "scanDetail.triage.falsePositive",
};

export function ScanReportPage() {
  const { t } = useScopedI18n(scanReportMessages);
  const { id = "" } = useParams();
  const [data, setData] = useState<ScanReportData | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; reason: unknown } | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(id);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setData(null);
    setLoadedId(null);
    setError(null);
  }, [id]);

  useEffect(() => {
    let active = true;
    setLoadingId(id);
    setError(null);
    void api.report(id).then((value) => {
      if (!active) return;
      setData(value);
      setLoadedId(id);
    }).catch((reason) => {
      if (active) setError({ id, reason });
    }).finally(() => {
      if (active) setLoadingId((current) => current === id ? null : current);
    });
    return () => { active = false; };
  }, [id, reload]);

  const report = loadedId === id ? data : null;
  const reportError = error?.id === id ? error : null;
  const refreshing = loadingId === id && report !== null;

  useEffect(() => {
    const previous = document.title;
    document.title = report
      ? t("scanReport.documentTitle", { name: report.scan.displayName })
      : t("scanReport.documentTitleDefault");
    return () => { document.title = previous; };
  }, [report, t]);

  const findings = useMemo(() => sortFindings(report?.findings ?? []), [report]);
  const indexPages = useMemo(() => chunk(findings, 12), [findings]);
  const priorityFindings = useMemo(() => findings.filter((finding) => finding.severity === "critical" || finding.severity === "high"), [findings]);
  const lifecycle = useMemo(() => new Map((report?.regression.findings ?? []).map((finding) => [finding.findingId, finding])), [report]);

  if (reportError && !report) {
    return <main className="flex min-h-screen items-center justify-center p-6" aria-labelledby="scan-report-load-error-title"><section role="alert" className="w-full max-w-xl border border-destructive/50 bg-destructive/10 p-6"><div className="font-mono text-[9px] uppercase tracking-[.16em] text-destructive">{t("scanReport.loadFailedEyebrow")}</div><h1 id="scan-report-load-error-title" className="mt-3 font-heading text-2xl font-semibold tracking-[-.04em]">{t("scanReport.loadFailedTitle")}</h1><p className="mt-3 text-sm text-muted-foreground">{t("scanReport.loadFailedMessage", { message: formatApiError(reportError.reason, t) })}</p><Button className="mt-5" onClick={() => setReload((value) => value + 1)}><HugeiconsIcon icon={RefreshIcon} size={13} />{t("common.retry")}</Button></section></main>;
  }

  if (!report) {
    return <div className="flex min-h-screen items-center justify-center font-mono text-[10px] uppercase tracking-[.18em] text-muted-foreground" role="status" aria-live="polite">{t("scanReport.initialLoading")}</div>;
  }

  const { scan, regression, generatedAt } = report;
  const partial = (scan.status === "failed" || scan.status === "incomplete") && scan.severity.total > 0;
  const highPlus = scan.severity.critical + scan.severity.high;
  const estimatedUsd = scanEstimatedUsd(scan);
  const costCopy = scanCostPresentation(scan.cost);
  const tokenUsage = scanTokenUsage(scan);
  const usdPerFinding = estimatedUsd != null && scan.severity.total ? estimatedUsd / scan.severity.total : null;
  const reportId = `SNT-${scan.id.toUpperCase()}`;
  const statusLabel = t(scanStatusLabelKey[scan.status]);
  const resolvedExecutionProfileLabel = executionProfileLabel(scan, t);
  const reasoningCopy = reasoningDeliveryCopy(scanReasoningDelivery(scan));

  return <div className="report-root min-h-screen bg-[var(--surface-code)] pb-16 text-foreground">
    <div className="report-toolbar report-no-print sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-[210mm] items-center gap-1 px-2 py-3 sm:gap-2 sm:px-4">
        <Button asChild variant="ghost" size="sm"><Link to={`/scans/${scan.id}`}><HugeiconsIcon icon={ArrowLeft01Icon} size={13} />{t("report.back")}</Link></Button>
        <div className="hidden min-w-0 flex-1 truncate px-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground md:block">{scan.displayName} / {shortId(scan.id)}</div>
        <LanguageSwitcher />
        <Button className="ml-auto" variant="outline" size="sm" aria-label={t("report.refresh")} onClick={() => setReload((value) => value + 1)} disabled={refreshing}><HugeiconsIcon icon={RefreshIcon} size={13} /><span className="hidden sm:inline">{refreshing ? t("scanReport.refreshing") : t("report.refresh")}</span></Button>
        <Button size="sm" aria-label={t("report.print")} onClick={() => window.print()}><HugeiconsIcon icon={PrinterIcon} size={13} /><span className="hidden sm:inline">{t("report.print")}</span><span className="sm:hidden">{t("scanReport.pdf")}</span></Button>
      </div>
    </div>

    {reportError && <div className="report-no-print mx-auto max-w-[210mm] px-2 pt-3 sm:px-4"><div role="status" aria-live="polite" className="border border-chart-3/45 bg-chart-3/10 px-4 py-3 text-xs text-foreground"><div className="font-mono text-[8px] uppercase tracking-[.14em] text-chart-3">{t("scanReport.staleEyebrow")}</div><div className="mt-1 flex flex-wrap items-center justify-between gap-3"><span>{t("scanReport.staleMessage", { message: formatApiError(reportError.reason, t) })}</span><Button type="button" variant="outline" size="sm" onClick={() => setReload((value) => value + 1)} disabled={refreshing}><HugeiconsIcon icon={RefreshIcon} size={13} />{t("common.retry")}</Button></div></div></div>}

    <main className="report-stack">
      <ReportSheet className="report-cover overflow-hidden">
        <img src="/brand/okami-sentinel-mark.png" alt="" className="pointer-events-none absolute -bottom-20 -right-12 w-[34rem] max-w-[72%] opacity-[.16] grayscale" />
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <ReportBrand />
          <div className="mt-20 max-w-[34rem]">
            <Kicker>{t("scanReport.coverKicker")}</Kicker>
            <h1 className="mt-5 whitespace-pre-line font-heading text-[3.7rem] font-semibold leading-[.94] tracking-[-.065em]">{t("scanReport.coverTitle")}</h1>
            <div className="mt-7 h-px w-28 bg-chart-1" />
            <p className="mt-7 max-w-lg text-lg leading-relaxed text-muted-foreground">{t("scanReport.coverDescription")}</p>
          </div>
          <div className="mt-auto grid border-y border-border sm:grid-cols-2">
            <MetaCell label={t("scanReport.target")} value={scan.displayName} />
            <MetaCell label={t("scanReport.reportId")} value={reportId} />
            <MetaCell label={t("scanReport.scanChannel")} value={`${scan.engine}${resolvedExecutionProfileLabel ? ` · ${resolvedExecutionProfileLabel}` : ""} · ${scan.model ?? "—"}/${scan.effort ?? "—"}/${scan.mode ?? "—"}`} />
            <MetaCell label={t("scanReport.generated")} value={formatDate(generatedAt)} />
          </div>
          <div className="mt-7 flex items-center justify-between gap-4 font-mono text-[8px] uppercase tracking-[.16em] text-muted-foreground"><span>{t("scanReport.confidentialEvidence")}</span><span title={scan.status}>{statusLabel}</span></div>
        </div>
      </ReportSheet>

      <ReportSheet className="report-scan-executive-sheet">
        <ReportHeader section="01" title={t("report.executive")} reportId={reportId} />
        <div className="mt-10 grid gap-4 md:grid-cols-[1.22fr_.78fr]">
          <section className="border border-border p-6">
            <Kicker>{t("scanReport.decisionSignal")}</Kicker>
            <h2 className="mt-3 font-heading text-3xl font-semibold tracking-[-.045em]">{partial ? t("scanReport.partialTitle") : scan.status === "completed" ? t("scanReport.completedTitle") : t("scanReport.executionTitle", { status: statusLabel })}</h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">{partial ? t("scanReport.partialDescription", { total: scan.severity.total }) : t("scanReport.executiveDescription", { total: scan.severity.total, highPlus })}</p>
            <div className="mt-6 border-l-2 border-chart-3 bg-chart-3/5 px-4 py-3 text-xs leading-6"><strong>{t("scanReport.readingLimitTitle")}</strong> {t("scanReport.readingLimit")}</div>
          </section>
          <section className="grid grid-cols-2 border border-border">
            <Metric label={t("scanReport.findings")} value={scan.severity.total} />
            <Metric label={t("scanReport.highPlus")} value={highPlus} tone="text-chart-4" />
            <Metric label={t(costCopy.labelKey)} value={formatScanUsd(scan)} tone="text-chart-1" kind="currency" />
            <Metric label={t("scanReport.costPerFinding")} value={formatUsd(usdPerFinding, scan.cost?.estimateKind === "upper-bound")} tone="text-primary" kind="currency" />
          </section>
        </div>

        <section className="mt-5 border border-border">
          <div className="border-b border-border px-5 py-4"><Kicker>{t("scanReport.riskDistribution")}</Kicker></div>
          <div className="grid gap-0 md:grid-cols-[1fr_13rem]">
            <div className="p-5">
              {severityOrder.slice(0, 5).map((severity) => <SeverityRow key={severity} severity={severity} count={scan.severity[severity]} total={scan.severity.total} />)}
            </div>
            <div className="grid grid-cols-3 border-t border-border md:border-l md:border-t-0">
              <Metric label={t("scanReport.new")} value={regression.counts.new} tone="text-primary" kind="compact" />
              <Metric label={t("scanReport.regressed")} value={regression.counts.regressed} tone="text-destructive" kind="compact" />
              <Metric label={t("scanReport.persisting")} value={regression.counts.persisting} tone="text-chart-3" kind="compact" />
            </div>
          </div>
        </section>

        <section className="mt-5 grid border border-border sm:grid-cols-2 lg:grid-cols-4">
          <MetaCell label={t("scanReport.duration")} value={formatDuration(scan.durationMs)} />
          <MetaCell label={t("scanReport.inputTokens")} value={formatTokens(tokenUsage.inputTokens)} />
          <MetaCell label={t("scanReport.outputTokens")} value={formatTokens(tokenUsage.outputTokens)} />
          <MetaCell label={t("scanReport.baseline")} value={regression.baseline ? `${regression.baseline.displayName} / ${shortId(regression.baseline.id)}` : t("scanReport.noBaseline")} />
        </section>
        <ReportFooter reportId={reportId} />
      </ReportSheet>

      <ReportSheet className="report-manifest-sheet">
        <ReportHeader section="02" title={t("scanReport.manifestTitle")} reportId={reportId} />
        <div className="mt-10 grid border border-border sm:grid-cols-2">
          <MetaCell label={t("scanReport.scanId")} value={scan.id} />
          <MetaCell label={t("scanReport.status")} value={<span title={scan.status}>{partial ? `${statusLabel} / ${t("scanReport.partialResults")}` : statusLabel}</span>} />
          <MetaCell label={t("scanReport.repository")} value={scan.repositoryPath ?? "—"} />
          <MetaCell label={t("scanReport.revision")} value={scan.revision ?? "—"} />
          <MetaCell label={t("scanReport.engine")} value={scan.engine} />
          <MetaCell label={t("scanReport.model")} value={scan.model ?? "—"} />
          <MetaCell label={t("scanReport.scanMode")} value={scan.mode ?? "—"} />
          <MetaCell label={t("scanReport.source")} value={scan.source} />
          <MetaCell label={t("scanReport.started")} value={formatDate(scan.startedAt)} />
          <MetaCell label={t("scanReport.completed")} value={formatDate(scan.completedAt)} />
        </div>
        <section className="mt-6 grid gap-5 md:grid-cols-2">
          <ReportText title={t("scanReport.howToReadTitle")}>{t("scanReport.howToRead")}</ReportText>
          <ReportText title={t("scanReport.whatItDoesNotProveTitle")}>{t("scanReport.whatItDoesNotProve")}</ReportText>
        </section>
        <ReportFooter reportId={reportId} />
      </ReportSheet>

      <ReportSheet className="report-manifest-sheet">
        <ReportHeader section="02B" title={t("scanReport.methodTitle")} reportId={reportId} />
        <div className="mt-10 grid border border-border sm:grid-cols-2">
          <MetaCell label={t("scanReport.authentication")} value={scan.authMode ?? "—"} />
          {scan.execution && <>
            <MetaCell label={t("report.executionProfile")} value={resolvedExecutionProfileLabel ?? "—"} />
            <MetaCell label={t("report.profileVersion")} value={scan.execution.profileVersion} />
            <MetaCell label={t("report.methodologyRef")} value={scan.execution.methodologyRef} />
            <MetaCell label={t("report.protocol")} value={scan.execution.protocol ?? "—"} />
            <MetaCell label={t("report.connectionAuth")} value={scan.execution.authKind ?? "—"} />
          </>}
          <MetaCell label={t("scanReport.reasoningDelivery")} value={t(reasoningCopy.key, reasoningCopy.variables)} />
          <MetaCell label={t("scanReport.scannerVersion")} value={scan.scannerVersion ?? "—"} />
          <MetaCell label={t("scanReport.recipeHash")} value={scan.recipeHash ?? "—"} />
        </div>
        <section className="mt-6 grid gap-5 md:grid-cols-2">
          {scan.execution?.executionProfile === "portable" && <ReportText title={t("report.executionProfile")}>{t("report.portableDisclosure")}</ReportText>}
          <ReportText title={t("scanReport.methodSectionTitle")}>{t("scanReport.methodDescription")}</ReportText>
          <ReportText title={t("scanReport.priorityTitle")}>{t("scanReport.priorityDescription")}</ReportText>
        </section>
        <ReportFooter reportId={reportId} />
      </ReportSheet>

      {indexPages.map((page, pageIndex) => <ReportSheet key={`index-${pageIndex}`}>
        <ReportHeader section="03" title={indexPages.length > 1 ? t("scanReport.indexTitlePage", { page: pageIndex + 1 }) : t("scanReport.indexTitle")} reportId={reportId} />
        <div className="mt-8 border border-border">
          <div className="report-index-grid grid grid-cols-[4.2rem_5.2rem_minmax(0,1fr)_7rem] border-b border-border bg-muted/40 px-4 py-3 font-mono text-[8px] uppercase tracking-[.13em] text-muted-foreground"><span>{t("scanReport.reference")}</span><span>{t("scanReport.risk")}</span><span>{t("scanReport.findingLocation")}</span><span className="report-index-lifecycle">{t("scanReport.lifecycle")}</span></div>
          {page.map((finding) => <FindingIndexRow key={finding.findingId} finding={finding} index={findings.indexOf(finding)} signal={lifecycle.get(finding.findingId)} />)}
        </div>
        <div className="mt-5 border-l-2 border-primary px-4 text-[11px] leading-6 text-muted-foreground">{t("scanReport.detailedFindingsNote", { count: priorityFindings.length })}</div>
        <ReportFooter reportId={reportId} />
      </ReportSheet>)}

      {priorityFindings.map((finding) => <FindingSheet key={finding.findingId} finding={finding} index={findings.indexOf(finding)} signal={lifecycle.get(finding.findingId)} reportId={reportId} />)}

      <ReportSheet>
        <ReportHeader section="05" title={t("scanReport.closingTitle")} reportId={reportId} />
        <div className="mt-16 grid gap-6 md:grid-cols-[1.2fr_.8fr]">
          <section>
            <Kicker>{t("scanReport.operatorHandoff")}</Kicker>
            <h2 className="mt-4 font-heading text-4xl font-semibold tracking-[-.05em]">{t("scanReport.closingHeading")}</h2>
            <p className="mt-6 text-base leading-8 text-muted-foreground">{t("scanReport.closingDescription")}</p>
          </section>
          <div className="border border-border p-6">
            <Kicker>{t("scanReport.suggestedSequence")}</Kicker>
            <ol className="mt-5 space-y-5">{(["scanReport.stepConfirm", "scanReport.stepTriage", "scanReport.stepFix", "scanReport.stepRepeat", "scanReport.stepCompare"] as const).map((item, index) => <li key={item} className="flex gap-4"><span className="font-mono text-xs text-primary">0{index + 1}</span><span className="text-sm">{t(item)}</span></li>)}</ol>
          </div>
        </div>
        <div className="mt-auto flex flex-col items-center justify-center py-20 text-center">
          <img src="/brand/okami-sentinel-mark.png" alt={t("scanReport.brandAlt")} className="h-32 w-32 object-contain" />
          <div className="mt-4 font-heading text-xl font-semibold tracking-[.25em]">OKAMI</div>
          <div className="font-mono text-[9px] uppercase tracking-[.45em] text-muted-foreground">Sentinel</div>
        </div>
        <ReportFooter reportId={reportId} />
      </ReportSheet>
    </main>
  </div>;
}

function SeverityRow({ severity, count, total }: { severity: Severity; count: number; total: number }) {
  const { t } = useScopedI18n(scanReportMessages);
  const percentage = total ? Math.round((count / total) * 100) : 0;
  return <div className="grid grid-cols-[5rem_minmax(0,1fr)_4rem] items-center gap-3 border-b border-border/70 py-3 last:border-0"><span className={`font-mono text-[9px] uppercase ${severityText[severity]}`}>{t(severityLabelKey[severity])}</span><div className="h-2 bg-muted"><div className={`h-full ${severityBar[severity]}`} style={{ width: `${percentage}%` }} /></div><span className="text-right font-mono text-[9px]">{count} / {percentage}%</span></div>;
}

function FindingIndexRow({ finding, index, signal }: { finding: FindingDetail; index: number; signal?: LifecycleFinding }) {
  const { t } = useScopedI18n(scanReportMessages);
  const lifecycleLabel = signal ? t(lifecycleLabelKey[signal.lifecycle]) : t("scanReport.noDelta");
  return <div className="report-index-grid grid grid-cols-[4.2rem_5.2rem_minmax(0,1fr)_7rem] items-center border-b border-border px-4 py-3 last:border-0"><span className="font-mono text-[8px] text-primary">OKS-{String(index + 1).padStart(3, "0")}</span><span className={`font-mono text-[8px] uppercase ${severityText[finding.severity]}`}>{t(severityLabelKey[finding.severity])}</span><div className="min-w-0 pr-4"><div className="truncate text-[11px] font-semibold">{finding.title}</div><div className="mt-1 truncate font-mono text-[7px] text-muted-foreground">{finding.primaryPath ?? finding.category ?? finding.findingId}</div><div className="mt-1 font-mono text-[7px] uppercase text-muted-foreground sm:hidden">{lifecycleLabel}</div></div><span className="report-index-lifecycle font-mono text-[7px] uppercase text-muted-foreground">{lifecycleLabel}</span></div>;
}

function FindingSheet({ finding, index, signal, reportId }: { finding: FindingDetail; index: number; signal?: LifecycleFinding; reportId: string }) {
  const { t } = useScopedI18n(scanReportMessages);
  const marker = t("scanReport.truncationMarker");
  const evidence = reportEvidenceBlocks(finding.codeEvidence, 1, {
    artifact: t("scanReport.evidenceArtifact"),
    role: t("scanReport.evidenceRole"),
    explanation: t("scanReport.structuredEvidence"),
    noSource: t("scanReport.noSourceExcerpt"),
    marker,
  });
  const validation = boundedText(finding.validation, 1, 180, marker);
  const remediation = boundedText(finding.remediation, 1, 240, marker);
  const rationale = [finding.severityRationale, finding.confidenceRationale].filter((line): line is string => Boolean(line)).slice(0, 1).map((line) => reportExcerpt(line, { maxChars: 170, maxLines: 2, marker }).text);
  const locations = locationList(finding.locations).slice(0, 6);
  const summary = reportExcerpt(finding.summary ?? t("scanReport.noFindingSummary"), { maxChars: 360, maxLines: 4, marker }).text;
  const lifecycleLabel = signal ? t(lifecycleLabelKey[signal.lifecycle]) : null;
  const triage = signal ? t(triageLabelKey[signal.triage.status]) : t(triageLabelKey.unreviewed);
  return <ReportSheet className="report-finding-sheet">
    <ReportHeader section="04" title={t("scanReport.technicalFindingTitle", { id: `OKS-${String(index + 1).padStart(3, "0")}` })} reportId={reportId} />
    <div className="mt-6 flex flex-wrap items-center gap-2"><span className={`border border-current px-2 py-1 font-mono text-[8px] uppercase ${severityText[finding.severity]}`}>{t(severityLabelKey[finding.severity])}</span><span className="border border-border px-2 py-1 font-mono text-[8px] uppercase text-muted-foreground">{t("scanReport.confidence")} / <span title={finding.confidence ?? undefined}>{finding.confidence ?? t("common.unknown")}</span></span>{lifecycleLabel && <span className="border border-border px-2 py-1 font-mono text-[8px] uppercase text-muted-foreground">{lifecycleLabel}</span>}</div>
    <h2 className="report-copy mt-4 max-w-3xl font-heading text-2xl font-semibold leading-tight tracking-[-.04em]">{finding.title}</h2>
    <p className="report-copy mt-3 max-w-3xl whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{summary}</p>
    <div className="mt-5 grid border border-border sm:grid-cols-2">
      <MetaCell label={t("scanReport.primaryLocation")} value={finding.primaryPath ?? "—"} />
      <MetaCell label={t("scanReport.cweRule")} value={[...finding.cwe, finding.ruleId].filter(Boolean).join(" · ") || "—"} />
      <MetaCell label={t("scanReport.category")} value={finding.category ?? "—"} />
      <MetaCell label={t("scanReport.triage")} value={<span title={signal?.triage.status}>{triage}</span>} />
    </div>
    {locations.length > 0 && <ReportSection title={t("scanReport.affectedLocations")}><div className="flex min-w-0 flex-wrap gap-2">{locations.map((location) => <span key={location} className="report-copy max-w-full border border-border px-2 py-1 font-mono text-[8px] text-muted-foreground">{location}</span>)}</div></ReportSection>}
    <ReportSection title={t("scanReport.evidenceExcerpt")}>
      {evidence.blocks.length ? <div className="space-y-3">{evidence.blocks.map((block) => <article key={block.id} className="report-evidence-block border border-border bg-card/70"><div className="grid min-w-0 gap-1 border-b border-border px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto]"><div className="min-w-0"><strong className="report-copy block text-[9px]">{block.label}</strong><span className="report-copy mt-1 block font-mono text-[7px] text-primary">{block.path}</span></div><span className="font-mono text-[7px] uppercase text-muted-foreground">{block.role}</span></div><p className="report-copy px-3 pt-2 text-[9px] leading-4 text-muted-foreground">{block.explanation.text}</p><pre className="report-code-excerpt"><code>{block.code.text}</code></pre></article>)}</div> : <TextBlocks lines={boundedText(finding.codeEvidence, 2, 320, marker)} fallback={t("scanReport.noStructuredEvidence")} />}
      {evidence.hidden > 0 && <p className="mt-2 font-mono text-[7px] uppercase text-muted-foreground">{t("scanReport.hiddenEvidenceBlocks", { count: evidence.hidden })}</p>}
    </ReportSection>
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <ReportSection title={t("scanReport.remediationDirection")} compact><TextBlocks lines={remediation} fallback={t("scanReport.noRemediation")} /></ReportSection>
      <ReportSection title={t("scanReport.validationRationale")} compact><TextBlocks lines={[...validation, ...rationale].slice(0, 4)} fallback={t("scanReport.noValidation")} /></ReportSection>
    </div>
    <ReportFooter reportId={reportId} />
  </ReportSheet>;
}

function ReportSection({ title, children, compact = false }: { title: string; children: ReactNode; compact?: boolean }) {
  return <section className={`${compact ? "mt-0" : "mt-4"} min-w-0 border-t border-border pt-3`}><Kicker>{title}</Kicker><div className="mt-2 min-w-0">{children}</div></section>;
}

function TextBlocks({ lines, fallback }: { lines: string[]; fallback?: string }) {
  const content = lines.length ? lines : fallback ? [fallback] : [];
  return <div className="min-w-0 space-y-2">{content.map((line, index) => <p key={`${line}-${index}`} className="report-copy whitespace-pre-wrap text-[9px] leading-4 text-muted-foreground">{line}</p>)}</div>;
}

function sortFindings(findings: FindingDetail[]): FindingDetail[] {
  return [...findings].sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity) || a.title.localeCompare(b.title));
}

function chunk<T>(items: T[], size: number): T[][] {
  if (!items.length) return [[]];
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));
}

function flattenText(value: unknown, limit: number): string[] {
  const collected: string[] = [];
  const visit = (entry: unknown) => {
    if (collected.length >= limit || entry == null) return;
    if (typeof entry === "string") {
      const clean = entry.trim();
      if (clean && !collected.includes(clean)) collected.push(clean);
      return;
    }
    if (typeof entry === "number" || typeof entry === "boolean") return;
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (typeof entry === "object") Object.values(entry as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return collected;
}

function boundedText(value: unknown, limit: number, maxChars: number, marker: string): string[] {
  return flattenText(value, limit).map((line) => reportExcerpt(line, { maxChars, maxLines: 4, marker }).text);
}

function locationList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return "";
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : "";
    const lines = typeof record.lines === "string" || typeof record.lines === "number" ? `:${record.lines}` : "";
    return `${path}${lines}`;
  }).filter(Boolean))].slice(0, 10);
}
