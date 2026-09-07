import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Analytics01Icon, ArrowLeft01Icon, ArrowRight01Icon, Copy01Icon, DocumentValidationIcon, RefreshIcon, Search01Icon, SecurityCheckIcon, StopIcon } from "@hugeicons/core-free-icons";
import { type FindingDetail, type FindingLifecycle, type FindingTriageStatus, type LifecycleFinding, type RegressionSummary, type ScanEvent, type ScanRun } from "@csb/shared";
import { api } from "../api";
import { DeleteScanButton } from "../components/scans/DeleteScanButton";
import { AlertBanner, EmptyState, LiveDuration, Loading, Panel, ProgressTrack, Readout, SeverityBadge, SeverityStrip, StatusBadge, cx } from "../components/ui";
import { AttackPathPreview } from "../components/attack-path";
import { BulletList, InspectorSection } from "../components/InspectorPrimitives";
import { LifecycleBadge, lifecycleTone } from "../components/LifecycleBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate, formatProgressLabel, formatProgressMetric, formatScanUsd, formatTokens, formatUsd, shortId } from "../format";
import { attackPathHref } from "../lib/attack-path";
import { executionProfileLabel, portableRetryHref } from "../lib/execution-profile";
import { scanCostPresentation, scanTokenUsage } from "../lib/scan-cost";
import { appendTelemetryEvent, mergeTelemetrySnapshot, telemetrySnapshot } from "../lib/telemetry";
import { reasoningDeliveryCopy, scanReasoningDelivery } from "../lib/reasoning-delivery";
import { formatApiError } from "../lib/http";
import { useI18n, type TranslationKey } from "../i18n";

type View = "evidence" | "telemetry" | "profile";
const triageLabels: Record<FindingTriageStatus, TranslationKey> = {
  unreviewed: "scanDetail.triage.unreviewed", confirmed: "scanDetail.triage.confirmed",
  accepted: "scanDetail.triage.accepted", false_positive: "scanDetail.triage.falsePositive",
};

export function ScanDetailPage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [scan, setScan] = useState<ScanRun | null>(null);
  const [findings, setFindings] = useState<LifecycleFinding[]>([]);
  const [regression, setRegression] = useState<RegressionSummary | null>(null);
  const [selected, setSelected] = useState<FindingDetail | null>(null);
  const [selectedSignal, setSelectedSignal] = useState<LifecycleFinding | null>(null);
  const [view, setView] = useState<View>("evidence");
  const [severity, setSeverity] = useState("");
  const [lifecycle, setLifecycle] = useState<FindingLifecycle | "">("");
  const [query, setQuery] = useState("");
  const [telemetry, setTelemetry] = useState(() => telemetrySnapshot([], 0));
  const [error, setError] = useState<unknown>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const requestRef = useRef(0);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const [r, delta, history] = await Promise.all([api.getScan(id), api.regression(id), api.getTelemetry(id)]);
      if (request !== requestRef.current) return null;
      setScan(r.scan);
      setRegression(delta);
      setFindings(delta.findings);
      setTelemetry((current) => mergeTelemetrySnapshot(current, history.lines, history.cursor));
      setLastUpdated(new Date().toISOString());
      setError(null);
      return r;
    } catch (reason) {
      if (request === requestRef.current) setError(reason);
      return null;
    }
  }, [id]);
  useEffect(() => {
    setScan(null); setFindings([]); setRegression(null); setSelected(null); setSelectedSignal(null);
    setTelemetry(telemetrySnapshot([], 0)); setError(null); setLastUpdated(null);
    void load().then((r) => { if (r) setView(r.scan.status === "running" ? "telemetry" : "evidence"); });
    return () => { requestRef.current += 1; };
  }, [load]);
  useEffect(() => { if (!scan || scan.status !== "running") return; const es = new EventSource(`/api/scans/${id}/events?after=${telemetry.cursor}`); const handler = (event: MessageEvent) => { try { const data = JSON.parse(String(event.data)) as ScanEvent; if (data.message) setTelemetry((old) => appendTelemetryEvent(old, data)); if (data.scan) setScan(data.scan); else if (data.progress) setScan((old) => old ? { ...old, progress: data.progress! } : old); if (data.type === "done") { void load(); es.close(); } } catch { /* malformed event */ } }; ["log", "status", "cost", "progress", "done", "error"].forEach((name) => es.addEventListener(name, handler)); const poll = window.setInterval(() => void load().catch(() => undefined), 4500); return () => { es.close(); window.clearInterval(poll); }; }, [id, scan?.status, load]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [telemetry.lines]);
  const filtered = useMemo(() => findings.filter((f) => (!severity || f.severity === severity) && (!lifecycle || f.lifecycle === lifecycle) && `${f.title} ${f.summary} ${f.primaryPath} ${f.category} ${f.cwe.join(" ")} ${f.lifecycle} ${f.triage.status}`.toLowerCase().includes(query.toLowerCase())), [findings, severity, lifecycle, query]);
  async function openFinding(f: LifecycleFinding, update = true) { try { const r = await api.getFinding(f.sourceScanId, f.findingId); setSelected(r.finding); setSelectedSignal(f); setView("evidence"); if (update) setParams({ f: f.findingId }, { replace: true }); } catch (err) { setError(err); } }
  useEffect(() => { const fid = params.get("f"); const hit = findings.find((f) => f.findingId === fid); if (hit && (selected?.findingId !== fid || selectedSignal?.sourceScanId !== hit.sourceScanId)) void openFinding(hit, false); }, [findings, params]);
  useEffect(() => {
    if (!selectedSignal) return;
    const stillCurrent = findings.some((finding) =>
      finding.findingId === selectedSignal.findingId &&
      finding.sourceScanId === selectedSignal.sourceScanId
    );
    if (stillCurrent) return;
    setSelected(null);
    setSelectedSignal(null);
    setParams({}, { replace: true });
  }, [findings, selectedSignal?.findingId, selectedSignal?.sourceScanId]);
  async function cancel() { try { await api.cancelScan(id); await load(); } catch (err) { setError(err); } }
  async function setBaseline() { setBaselineBusy(true); try { const delta = await api.setBaseline(id); setRegression(delta); setFindings(delta.findings); setLifecycle(""); } catch (err) { setError(err); } finally { setBaselineBusy(false); } }
  async function saveTriage(status: FindingTriageStatus, note: string) { if (!selectedSignal) return; const { triage } = await api.updateTriage(id, selectedSignal.findingId, { status, note }); setFindings((items) => items.map((item) => item.identity === selectedSignal.identity ? { ...item, triage } : item)); setSelectedSignal((item) => item ? { ...item, triage } : item); }
  const errorBanner = error !== null && <AlertBanner tone={scan ? "warning" : "error"}><div className="flex flex-wrap items-center justify-between gap-3"><span>{formatApiError(error, t)}{scan && lastUpdated ? ` · ${t("scans.stale", { date: formatDate(lastUpdated) })}` : ""}</span><Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t("common.retry")}</Button></div></AlertBanner>;
  if (!scan && error === null) return <Loading />;
  if (!scan) return errorBanner;
  const highPlus = scan.severity.critical + scan.severity.high;
  const costCopy = scanCostPresentation(scan.cost);
  const tokenUsage = scanTokenUsage(scan);
  const hasTrustedPricing = scan.cost?.pricingSource !== undefined;
  const costDetail = hasTrustedPricing
    ? `${t("scanDetail.costInput")} ${formatUsd(scan.cost?.inputUsd)} · ${t("scanDetail.costOutput")} ${formatUsd(scan.cost?.outputUsd)}`
    : undefined;
  const rateDetail = costCopy.rateKey === null
    ? undefined
    : `${t(costCopy.rateKey)}${costCopy.disclaimerKey === null ? "" : ` · ${t(costCopy.disclaimerKey)}`}`;
  const resolvedExecutionProfileLabel = executionProfileLabel(scan, t);
  const retryHref = portableRetryHref(scan);
  const reasoningCopy = reasoningDeliveryCopy(scanReasoningDelivery(scan));
  return <div>
    <header className="bench-panel bench-corners mb-4">
      <div className="flex h-8 items-center justify-between border-b px-3 font-mono text-[8px] uppercase tracking-[.13em] text-muted-foreground"><span className="text-primary">{t("scanDetail.channel")} / {shortId(scan.id)}</span><span>{scan.status === "running" ? t("scanDetail.liveTelemetry") : t("scanDetail.archivedEvidence")}</span></div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 border-b p-5 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center gap-2"><Button asChild variant="ghost" size="sm"><Link to="/scans"><HugeiconsIcon icon={ArrowLeft01Icon} size={12} />{t("scanDetail.ledger")}</Link></Button><StatusBadge status={scan.status} /><span className="border border-primary/35 bg-primary/5 px-2 py-1 font-mono text-[9px] uppercase text-primary">{scan.engine}</span>{resolvedExecutionProfileLabel && <span aria-label={`${t("scanDetail.executionProfile")}: ${resolvedExecutionProfileLabel}`} className="border border-primary/35 bg-primary/[.04] px-2 py-1 font-mono text-[9px] uppercase text-primary">{resolvedExecutionProfileLabel}</span>}<span className="border px-2 py-1 font-mono text-[9px] text-muted-foreground">{scan.model ?? t("scans.providerDefault")} / {scan.mode}</span><span className="border border-border bg-muted/30 px-2 py-1 font-mono text-[8px] uppercase text-muted-foreground">{t(reasoningCopy.key, reasoningCopy.variables)}</span></div>
          <h1 className="mt-5 truncate font-heading text-3xl font-semibold tracking-[-.045em] sm:text-4xl">{scan.displayName}</h1>
          <button type="button" onClick={() => void navigator.clipboard.writeText(scan.repositoryPath ?? scan.scanDir)} className="mt-2 flex max-w-full items-center gap-2 truncate font-mono text-[10px] text-muted-foreground hover:text-primary"><HugeiconsIcon icon={Copy01Icon} size={11} />{scan.repositoryPath ?? scan.scanDir}</button>
          <div className="mt-5"><SeverityStrip counts={scan.severity} total={scan.severity.total} /></div>
          <div className="mt-5 flex flex-wrap gap-2"><Button asChild variant="outline" size="sm"><Link to={`/compare?ids=${scan.id}`}><HugeiconsIcon icon={Analytics01Icon} size={12} />{t("scanDetail.compare")}</Link></Button>{retryHref && <Button asChild variant="outline" size="sm"><Link to={retryHref} className="focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"><HugeiconsIcon icon={RefreshIcon} size={12} />{t("scanDetail.repeat")}</Link></Button>}{scan.status === "completed" && <Button variant="outline" size="sm" onClick={() => void setBaseline()} disabled={baselineBusy || regression?.isRepositoryBaseline}><HugeiconsIcon icon={SecurityCheckIcon} size={12} />{regression?.isRepositoryBaseline ? t("scanDetail.repoBaseline") : baselineBusy ? t("scanDetail.settingBaseline") : t("scanDetail.setBaseline")}</Button>}{scan.status === "running" && <Button variant="destructive" size="sm" onClick={() => void cancel()}><HugeiconsIcon icon={StopIcon} size={12} />{t("scanDetail.cancel")}</Button>}<DeleteScanButton scan={scan} onDeleted={() => navigate("/scans")} /></div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-5 p-5"><Readout label={t("scanDetail.highPlus")} value={highPlus} tone="risk" /><Readout label={t("scanDetail.total")} value={scan.severity.total} /><Readout label={t(costCopy.labelKey)} value={formatScanUsd(scan)} detail={costDetail} tone="signal" /><Readout label={t("scanDetail.duration")} value={<LiveDuration startedAt={scan.startedAt} completedAt={scan.completedAt} status={scan.status} durationMs={scan.durationMs} showDot={false} />} /><Readout label={t("scanDetail.input")} value={formatTokens(tokenUsage.inputTokens)} detail={tokenUsage.cachedInputTokens === null ? undefined : `${t("scanDetail.cache")} ${formatTokens(tokenUsage.cachedInputTokens)}`} /><Readout label={t("scanDetail.output")} value={formatTokens(tokenUsage.outputTokens)} detail={rateDetail ? <span title={rateDetail}>{rateDetail}</span> : undefined} wrap /><Button asChild className="col-span-2 h-auto justify-between border-chart-1 bg-chart-1 px-4 py-3 text-primary-foreground hover:bg-chart-1/90"><Link to={`/scans/${scan.id}/report`} target="_blank"><span className="flex items-center gap-3"><HugeiconsIcon icon={DocumentValidationIcon} size={18} /><span className="text-left"><strong className="block text-xs uppercase tracking-[.08em]">{t("scanDetail.report")}</strong><span className="mt-0.5 block font-mono text-[8px] font-normal uppercase opacity-75">{t("scanDetail.findingsCount", { count: scan.severity.total })} · {t("scanDetail.print")}</span></span></span><HugeiconsIcon icon={ArrowRight01Icon} size={15} /></Link></Button></div>
      </div>
      {regression && <RegressionRail regression={regression} active={lifecycle} onSelect={(value) => { setLifecycle((current) => current === value ? "" : value); setView("evidence"); }} />}
      {scan.progress && <div className="border-t px-4 py-3"><div className="mb-2 flex items-center justify-between gap-4 font-mono text-[9px]"><span className="truncate">{formatProgressLabel(scan.progress)}{scan.progress.detail ? ` / ${scan.progress.detail}` : ""}</span><span className="shrink-0 text-primary">{formatProgressMetric(scan.progress)}</span></div><ProgressTrack value={scan.progress.percent} indeterminate={scan.progress.indeterminate} /></div>}
    </header>
    {errorBanner}
    <div className="mb-4 flex overflow-x-auto border border-border">{(["evidence", "telemetry", "profile"] as View[]).map((id, i) => <button key={id} type="button" onClick={() => setView(id)} className={cx("h-10 border-r px-4 font-mono text-[9px] uppercase tracking-wider", view === id ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground")}>0{i + 1} / {t(`scanDetail.view${id[0].toUpperCase()}${id.slice(1)}` as "scanDetail.viewEvidence")}</button>)}</div>
    {view === "evidence" && <EvidenceWorkbench scan={scan} findings={filtered} allFindings={findings} selected={selected} selectedSignal={selectedSignal} query={query} severity={severity} lifecycle={lifecycle} onQuery={setQuery} onSeverity={setSeverity} onLifecycle={setLifecycle} onOpen={(f) => void openFinding(f)} onSaveTriage={saveTriage} />}
    {view === "telemetry" && <Telemetry scan={scan} logs={telemetry.lines} logRef={logRef} />}
    {view === "profile" && <Profile scan={scan} />}
  </div>;
}

function EvidenceWorkbench({ scan, findings, allFindings, selected, selectedSignal, query, severity, lifecycle, onQuery, onSeverity, onLifecycle, onOpen, onSaveTriage }: { scan: ScanRun; findings: LifecycleFinding[]; allFindings: LifecycleFinding[]; selected: FindingDetail | null; selectedSignal: LifecycleFinding | null; query: string; severity: string; lifecycle: FindingLifecycle | ""; onQuery: (v: string) => void; onSeverity: (v: string) => void; onLifecycle: (v: FindingLifecycle | "") => void; onOpen: (f: LifecycleFinding) => void; onSaveTriage: (status: FindingTriageStatus, note: string) => Promise<void> }) {
  const { t } = useI18n();
  return <div className="grid min-h-[36rem] md:grid-cols-[minmax(18rem,.75fr)_minmax(26rem,1.25fr)] xl:grid-cols-[14rem_minmax(18rem,.75fr)_minmax(24rem,1.25fr)]">
    <aside className="bench-panel border-b md:col-start-1 md:row-start-1 md:border-r xl:col-auto xl:row-auto xl:border-b-0"><div className="border-b p-3"><label className="flex items-center gap-2"><HugeiconsIcon icon={Search01Icon} size={12} className="text-muted-foreground" /><Input aria-label={t("scanDetail.searchEvidence")} value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t("scanDetail.searchEvidence")} className="h-8 border-0 bg-transparent px-0 font-mono text-[10px] shadow-none focus-visible:ring-0" /></label></div><FilterGroup label={t("scanDetail.severity")}><FilterButton label={t("scanDetail.allSignals")} count={allFindings.length} active={!severity} onClick={() => onSeverity("")} />{["critical", "high", "medium", "low", "info"].map((value) => <FilterButton key={value} label={t(`compare.severity.${value}` as "compare.severity.critical")} count={allFindings.filter((finding) => finding.severity === value).length} active={severity === value} onClick={() => onSeverity(value)} />)}</FilterGroup><FilterGroup label={t("scanDetail.lifecycle")}><FilterButton label={t("scanDetail.allStates")} count={allFindings.length} active={!lifecycle} onClick={() => onLifecycle("")} />{lifecycleOrder.map((value) => <FilterButton key={value} label={t(`scanDetail.lifecycle.${value}` as "scanDetail.lifecycle.new")} count={allFindings.filter((finding) => finding.lifecycle === value).length} active={lifecycle === value} onClick={() => onLifecycle(value)} tone={lifecycleTone[value]} />)}</FilterGroup><div className="border-t p-3 text-[10px] leading-relaxed text-muted-foreground">{t("scanDetail.currentRunNote")}</div></aside>
    <Panel className="border-b md:col-start-1 md:row-start-2 md:border-r xl:col-auto xl:row-auto xl:border-b-0" label={t("scanDetail.signalDeltaList")} title={t("scanDetail.evidenceCount", { count: findings.length })}><div className="max-h-[42rem] overflow-auto">{findings.map((f) => <button key={`${f.sourceScanId}:${f.findingId}`} onClick={() => onOpen(f)} className={cx("w-full border-b px-3 py-3 text-left hover:bg-accent", selectedSignal?.identity === f.identity && "bg-accent shadow-[inset_2px_0_0_var(--primary)]")}><div className="flex items-start gap-2"><SeverityBadge severity={f.severity} /><LifecycleBadge state={f.lifecycle} /><span className="min-w-0 flex-1 text-xs font-semibold leading-snug">{f.title}</span></div><div className="mt-2 flex min-w-0 items-center gap-2 font-mono text-[8px] text-muted-foreground"><span className="min-w-0 flex-1 truncate">{f.primaryPath ?? f.category ?? f.findingId}</span>{f.triage.status !== "unreviewed" && <span className="shrink-0 uppercase text-chart-2">{t(triageLabels[f.triage.status])}</span>}</div></button>)}{!findings.length && <EmptyState title={t("scanDetail.noSignal")} description={t("scanDetail.removeFilters")} />}</div></Panel>
    <Panel className="md:col-start-2 md:row-span-2 md:row-start-1 xl:col-auto xl:row-auto xl:row-span-1" label={t("scanDetail.inspector")} title={selected?.title ?? t("scanDetail.selectEvidence")} aside={selected && <div className="flex items-center gap-2"><LifecycleBadge state={selectedSignal?.lifecycle ?? "new"} /><SeverityBadge severity={selected.severity} /></div>} wrapTitle><div className="max-h-[42rem] overflow-auto">{selected && selectedSignal ? <FindingInspector key={`${selectedSignal.identity}:${selectedSignal.triage.updatedAt}`} scan={scan} finding={selected} signal={selectedSignal} onSaveTriage={onSaveTriage} /> : <EmptyState title={t("scanDetail.inspectorDisarmed")} description={t("scanDetail.openFinding")} />}</div></Panel>
  </div>;
}

const lifecycleOrder: FindingLifecycle[] = ["new", "regressed", "persisting"];
function RegressionRail({ regression, active, onSelect }: { regression: RegressionSummary; active: FindingLifecycle | ""; onSelect: (state: FindingLifecycle) => void }) {
  const { t } = useI18n();
  return <div className="grid border-t sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1.4fr)_repeat(3,minmax(7rem,.65fr))]">
    <div className="min-w-0 border-b border-r px-4 py-3 sm:col-span-2 lg:col-span-1 lg:border-b-0"><div className="bench-label">{t("scanDetail.repositoryBaseline")} / {regression.baselineSource}</div>{regression.baseline ? <div className="mt-1 flex items-center gap-2"><span className="truncate text-xs font-semibold">{regression.baseline.displayName}</span><span className="shrink-0 font-mono text-[8px] text-primary">{shortId(regression.baseline.id)}</span></div> : <div className="mt-1 text-xs text-muted-foreground">{t("scanDetail.firstObservation")}</div>}</div>
    {lifecycleOrder.map((state) => <button key={state} type="button" aria-pressed={active === state} onClick={() => onSelect(state)} className={cx("border-b border-r px-4 py-3 text-left transition hover:bg-accent lg:border-b-0", active === state && "bg-accent shadow-[inset_0_-2px_0_var(--primary)]")}><span className={cx("font-mono text-[8px] uppercase tracking-wider", lifecycleTone[state])}>{t(`scanDetail.lifecycle.${state}` as "scanDetail.lifecycle.new")}</span><strong className="mt-1 block font-mono text-lg">{regression.counts[state]}</strong></button>)}
  </div>;
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return <div className="border-b p-2"><div className="bench-label px-2 pb-1 pt-1">{label}</div>{children}</div>;
}

function FilterButton({ label, count, active, onClick, tone }: { label: string; count: number; active: boolean; onClick: () => void; tone?: string }) {
  return <button type="button" onClick={onClick} className={cx("flex w-full justify-between px-2 py-1.5 font-mono text-[8px] uppercase", active ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground")}><span className={tone}>{label}</span><span>{count}</span></button>;
}

function Telemetry({ scan, logs, logRef }: { scan: ScanRun; logs: string[]; logRef: React.RefObject<HTMLPreElement | null> }) {
  const { t } = useI18n();
  const activity = scan.progress?.activityState;
  const activityTone = activity === "active" ? "good" : activity === "stale" ? "risk" : "signal";
  const activityDetail = activity === "stale" ? t("scanDetail.noEvents5m") : activity === "quiet" ? t("scanDetail.noEvents30s") : activity === "active" ? t("scanDetail.eventsArriving") : undefined;
  return <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]"><Panel label={t("scanDetail.process")} title={t("scanDetail.runtimeTelemetry")}><div className="grid gap-5 p-4"><Readout label={t("scanDetail.status")} value={<StatusBadge status={scan.status} />} tone={scan.status === "running" ? "signal" : "good"} /><Readout label={t("scanDetail.activity")} value={activity ? t(`scanDetail.activity.${activity}` as "scanDetail.activity.active") : "—"} tone={activity ? activityTone : undefined} detail={activityDetail} /><Readout label={t("scanDetail.lastEvent")} value={scan.progress?.lastActivityAt ? <LiveDuration startedAt={scan.progress.lastActivityAt} status={scan.status} showDot={false} /> : "—"} detail={scan.progress?.lastActivityAt ? formatDate(scan.progress.lastActivityAt) : undefined} /><Readout label={t("scanDetail.stage")} value={formatProgressMetric(scan.progress)} /><Readout label={t("scanDetail.phase")} value={formatProgressLabel(scan.progress)} /><Readout label={t("scanDetail.pid")} value={scan.pid ?? "—"} /><Readout label={t("scanDetail.started")} value={formatDate(scan.startedAt)} /></div></Panel><Panel label={t("scanDetail.stdoutStream")} title={t("scanDetail.localEngine")}><pre ref={logRef} className="h-[34rem] overflow-auto whitespace-pre-wrap bg-[var(--surface-code)] p-4 font-mono text-[10px] leading-5 text-secondary-foreground">{logs.length ? logs.join("\n") : scan.status === "running" ? t("scanDetail.waitingEvents") : t("scanDetail.streamInactive")}</pre></Panel></div>;
}
function Profile({ scan }: { scan: ScanRun }) {
  const { t } = useI18n();
  const execution = scan.execution;
  const executionProfile = executionProfileLabel(scan, t) ?? "—";
  const reasoning = reasoningDeliveryCopy(scanReasoningDelivery(scan));
  const rows = [
    [t("scanDetail.scanId"), scan.id], [t("scanDetail.engine"), scan.engine], [t("scanDetail.provider"), scan.provider ?? "—"], [t("scanDetail.authentication"), scan.authMode ?? "—"],
    ...(execution ? [
      [t("scanDetail.executionProfile"), executionProfile],
      [t("scanDetail.profileVersion"), execution.profileVersion],
      [t("scanDetail.methodologyRef"), execution.methodologyRef],
      [t("scanDetail.protocol"), execution.protocol ?? "—"],
      [t("scanDetail.connectionAuth"), execution.authKind ?? "—"],
    ] : []),
    [t("scanDetail.pricingSource"), scan.cost?.pricingSource ?? "scanner"], [t("scanDetail.pricingModel"), scan.cost?.pricingModel ?? scan.cost?.model ?? "—"], [t("scanDetail.pricingUpdated"), scan.cost?.pricingUpdatedAt ? formatDate(scan.cost.pricingUpdatedAt) : "—"], [t("scanDetail.scannerVersion"), scan.scannerVersion ?? "—"], [t("scanDetail.recipeHash"), scan.recipeHash ?? "—"], [t("scanDetail.source"), scan.source], [t("scanDetail.repository"), scan.repositoryPath ?? "—"], [t("scanDetail.revision"), scan.revision ?? "—"], [t("scanDetail.scanDir"), scan.scanDir], [t("scanDetail.model"), scan.model ?? "—"], [t("scanDetail.reasoningDelivery"), t(reasoning.key, reasoning.variables)], [t("scanDetail.mode"), scan.mode ?? "—"], [t("scanDetail.started"), formatDate(scan.startedAt)], [t("scanDetail.completed"), formatDate(scan.completedAt)],
  ];
  return <Panel label={t("scanDetail.manifest")} title={t("scanDetail.executionProfileTitle")}>
    {execution?.executionProfile === "portable" && <div className="border-b border-chart-3/40 bg-chart-3/[.04] px-4 py-3 text-[10px] leading-relaxed text-muted-foreground">{t("scanDetail.portableDisclosure")}</div>}
    <div className="grid sm:grid-cols-2">{rows.map(([label, value]) => <div key={label} className="min-w-0 border-b p-4 sm:border-r"><div className="bench-label">{label}</div><div className="mt-2 break-all font-mono text-[10px]">{value}</div></div>)}</div>
  </Panel>;
}

type InspectorView = "brief" | "flow" | "evidence" | "fix";
type DataRecord = Record<string, unknown>;

function FindingInspector({ scan, finding, signal, onSaveTriage }: { scan: ScanRun; finding: FindingDetail; signal: LifecycleFinding; onSaveTriage: (status: FindingTriageStatus, note: string) => Promise<void> }) {
  const { t } = useI18n();
  const [view, setView] = useState<InspectorView>("brief");
  const tabs: Array<[InspectorView, string, string]> = [
    ["brief", "01", t("scanDetail.tabSummary")],
    ["flow", "02", t("scanDetail.tabPath")],
    ["evidence", "03", t("scanDetail.tabEvidence", { count: Array.isArray(finding.codeEvidence) ? finding.codeEvidence.length : 0 })],
    ["fix", "04", t("scanDetail.tabFix")],
  ];

  return <div>
    <TriageConsole signal={signal} onSave={onSaveTriage} />
    <div className="sticky top-0 z-10 flex overflow-x-auto border-b bg-card/95 backdrop-blur-sm">
      {tabs.map(([id, code, label]) => <button key={id} type="button" onClick={() => setView(id)} className={cx("h-10 shrink-0 border-r px-3 font-mono text-[8px] uppercase tracking-wider", view === id ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground")}><span className="mr-2 opacity-55">{code}</span>{label}</button>)}
    </div>
    {view === "brief" && <FindingBrief finding={finding} />}
    {view === "flow" && <AttackPathPreview model={finding.attackPathModel} hrefForSelection={(laneId, nodeId) => attackPathHref({ scanId: scan.id, findingId: finding.findingId, evidenceScanId: signal.sourceScanId, laneId, nodeId })} />}
    {view === "evidence" && <EvidenceStack value={finding.codeEvidence} locations={finding.locations} />}
    {view === "fix" && <RemediationPlan finding={finding} />}
  </div>;
}

function TriageConsole({ signal, onSave }: { signal: LifecycleFinding; onSave: (status: FindingTriageStatus, note: string) => Promise<void> }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<FindingTriageStatus>(signal.triage.status);
  const [note, setNote] = useState(signal.triage.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() { setBusy(true); setError(null); try { await onSave(status, note); } catch (err) { setError(formatApiError(err, t)); } finally { setBusy(false); } }
  return <div className="border-b bg-primary/[.035] p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><LifecycleBadge state={signal.lifecycle} /><span className="font-mono text-[8px] uppercase text-muted-foreground">{t("scanDetail.currentChannelEvidence")}</span></div><span className="font-mono text-[7px] uppercase text-muted-foreground">{t("scanDetail.decisionRecord")}</span></div>
    <div className="mt-3 grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
      <Select value={status} onValueChange={(value) => setStatus(value as FindingTriageStatus)}><SelectTrigger className="h-9 rounded-none font-mono text-[9px] uppercase"><SelectValue /></SelectTrigger><SelectContent className="rounded-none"><SelectItem value="unreviewed">{t("scanDetail.triage.unreviewed")}</SelectItem><SelectItem value="confirmed">{t("scanDetail.triage.confirmed")}</SelectItem><SelectItem value="accepted">{t("scanDetail.triage.accepted")}</SelectItem><SelectItem value="false_positive">{t("scanDetail.triage.falsePositive")}</SelectItem></SelectContent></Select>
      <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("scanDetail.decisionNote")} className="h-9 rounded-none text-[10px]" />
      <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>{busy ? t("scanDetail.saving") : t("scanDetail.save")}</Button>
    </div>
    <div className={cx("mt-2 font-mono text-[8px]", error ? "text-destructive" : "text-muted-foreground")}>{error ?? (signal.triage.updatedAt ? t("scanDetail.lastDecision", { date: formatDate(signal.triage.updatedAt) }) : t("scanDetail.noDecision"))}</div>
  </div>;
}

function FindingBrief({ finding }: { finding: FindingDetail }) {
  const { t } = useI18n();
  const rootCause = dataRecord(finding.rootCause);
  const validation = dataRecord(finding.validation);
  return <div>
    <InspectorSection label={t("scanDetail.whatHappens")}><p className="text-[15px] leading-7 text-muted-foreground">{finding.summary ?? t("scanDetail.noSummary")}</p></InspectorSection>
    <div className="grid border-b sm:grid-cols-2">
      <MetaCell label={t("scanDetail.category")} value={finding.category ?? t("scanDetail.unclassified")} />
      <MetaCell label={t("scanDetail.confidence")} value={finding.confidence ?? t("scanDetail.unreported")} />
      <MetaCell label={t("scanDetail.rule")} value={finding.ruleId ?? "—"} mono />
      <MetaCell label={t("scanDetail.primaryLocation")} value={finding.primaryPath ?? "—"} mono />
    </div>
    <InspectorSection label={t("scanDetail.severityWhy")}><Callout tone="risk">{finding.severityRationale ?? t("scanDetail.noSeverityRationale")}</Callout></InspectorSection>
    {textValue(rootCause?.summary) && <InspectorSection label={t("scanDetail.rootCause")}><p className="text-xs leading-6 text-muted-foreground">{textValue(rootCause?.summary)}</p></InspectorSection>}
    {textValue(validation?.summary) && <InspectorSection label={t("scanDetail.validatedHow")}><p className="text-xs leading-6 text-muted-foreground">{textValue(validation?.summary)}</p>{textValue(validation?.method) && <div className="mt-3 inline-flex border px-2 py-1 font-mono text-[8px] uppercase text-chart-2">{textValue(validation?.method)}</div>}</InspectorSection>}
    {finding.confidenceRationale && <InspectorSection label={t("scanDetail.evidenceConfidence")}><Callout tone="evidence">{finding.confidenceRationale}</Callout></InspectorSection>}
  </div>;
}

function EvidenceStack({ value, locations }: { value: unknown; locations: unknown }) {
  const { t } = useI18n();
  const evidence = Array.isArray(value) ? value.map(dataRecord).filter((item): item is DataRecord => Boolean(item)) : [];
  const locationRows = Array.isArray(locations) ? locations.map(dataRecord).filter((item): item is DataRecord => Boolean(item)) : [];
  if (!evidence.length) return <EmptyState title={t("scanDetail.codeNotAttached")} description={t("scanDetail.codeNotAttachedDescription")} />;
  return <div>
    <div className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("scanDetail.evidenceHint")}</div>
    {evidence.map((item, index) => <CodeEvidence key={textValue(item.id) ?? index} item={item} index={index} />)}
    {locationRows.length > 0 && <InspectorSection label={t("scanDetail.allLocations")}><div className="space-y-1.5">{locationRows.map((item, index) => <div key={`${textValue(item.path)}-${index}`} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 border-l border-border py-1 pl-3 font-mono text-[9px]"><span className="uppercase text-muted-foreground">{textValue(item.role) ?? t("scanDetail.evidenceRole")}</span><span className="break-all text-primary">{locationLabel(item)}</span></div>)}</div></InspectorSection>}
  </div>;
}

function RemediationPlan({ finding }: { finding: FindingDetail }) {
  const { t } = useI18n();
  const controls = textList(finding.preventiveControls);
  const tests = textList(finding.remediationTests);
  const validation = dataRecord(finding.validation);
  const validationLimits = textList(validation?.limitations);
  return <div>
    <InspectorSection label={t("scanDetail.recommendedFix")}><Callout tone="signal">{textValue(finding.remediation) ?? t("scanDetail.noRemediation")}</Callout></InspectorSection>
    {controls.length > 0 && <InspectorSection label={t("scanDetail.preventiveControls")}><NumberedList items={controls} /></InspectorSection>}
    {tests.length > 0 && <InspectorSection label={t("scanDetail.regressionTests")}><NumberedList items={tests} accent="evidence" /></InspectorSection>}
    {validationLimits.length > 0 && <InspectorSection label={t("scanDetail.validationCaveats")}><BulletList items={validationLimits} /></InspectorSection>}
  </div>;
}

function CodeEvidence({ item, index }: { item: DataRecord; index: number }) {
  const code = textValue(item.code) ?? "";
  const start = numberValue(item.startLine);
  const role = textValue(item.role) ?? "evidence";
  return <details className="group border-b" open={index === 0}>
    <summary className="grid cursor-pointer list-none grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 hover:bg-accent/60">
      <span className="font-mono text-[9px] text-primary">{String(index + 1).padStart(2, "0")}</span>
      <span className="min-w-0"><span className="block font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{role.replaceAll("_", " ")}</span><span className="mt-1 block break-all font-mono text-[10px] text-foreground">{locationLabel(item)}</span></span>
      <span className="font-mono text-[10px] text-muted-foreground group-open:text-primary">＋</span>
    </summary>
    <div className="border-t bg-[var(--surface-code)]">
      {textValue(item.explanation) && <p className="border-b px-4 py-3 text-xs leading-6 text-muted-foreground">{textValue(item.explanation)}</p>}
      <pre className="max-w-full overflow-x-auto py-3 font-mono text-[10px] leading-5 text-secondary-foreground [tab-size:2]"><code className="block min-w-max">{code.split("\n").map((line, lineIndex) => <span key={lineIndex} className="grid grid-cols-[3.25rem_minmax(0,1fr)]"><span className="select-none border-r border-border/70 pr-3 text-right text-muted-foreground/45">{start != null ? start + lineIndex : lineIndex + 1}</span><span className="px-3">{line || " "}</span></span>)}</code></pre>
    </div>
  </details>;
}

function MetaCell({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="min-w-0 border-b border-r p-4"><div className="bench-label">{label}</div><div className={cx("mt-2 break-words text-xs", mono && "break-all font-mono text-[10px] text-primary")}>{value}</div></div>; }
function Callout({ children, tone }: { children: React.ReactNode; tone: "risk" | "evidence" | "signal" }) { return <div className={cx("border-l-2 py-1 pl-3 text-xs leading-6", tone === "risk" && "border-destructive text-foreground", tone === "evidence" && "border-chart-2 text-muted-foreground", tone === "signal" && "border-primary text-foreground")}>{children}</div>; }
function NumberedList({ items, accent = "signal" }: { items: string[]; accent?: "signal" | "evidence" }) { return <ol className="space-y-3">{items.map((item, index) => <li key={`${item}-${index}`} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 text-xs leading-6"><span className={cx("flex size-6 items-center justify-center border font-mono text-[8px]", accent === "signal" ? "border-primary/45 text-primary" : "border-chart-2/45 text-chart-2")}>{String(index + 1).padStart(2, "0")}</span><span className="text-muted-foreground">{item}</span></li>)}</ol>; }

function dataRecord(value: unknown): DataRecord | null { return value != null && typeof value === "object" && !Array.isArray(value) ? value as DataRecord : null; }
function textValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function textList(value: unknown): string[] { return Array.isArray(value) ? value.map(textValue).filter((item): item is string => Boolean(item)) : []; }
function locationLabel(item: DataRecord): string { const path = textValue(item.path) ?? "unknown"; const start = numberValue(item.startLine); const end = numberValue(item.endLine); if (start == null) return path; return `${path}:${start}${end != null && end !== start ? `–${end}` : ""}`; }
