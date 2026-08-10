import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Analytics01Icon, ArrowLeft01Icon, ArrowRight01Icon, Copy01Icon, DocumentValidationIcon, RefreshIcon, Search01Icon, SecurityCheckIcon, StopIcon } from "@hugeicons/core-free-icons";
import { scanEstimatedUsd, type FindingDetail, type FindingLifecycle, type FindingTriageStatus, type LifecycleFinding, type RegressionSummary, type ScanEvent, type ScanRun } from "@csb/shared";
import { api } from "../api";
import { DeleteScanButton } from "../components/scans/DeleteScanButton";
import { AlertBanner, EmptyState, LiveDuration, Loading, Panel, ProgressTrack, Readout, SeverityBadge, SeverityStrip, StatusBadge, cx } from "../components/ui";
import { AttackPathPreview } from "../components/attack-path";
import { BulletList, InspectorSection } from "../components/InspectorPrimitives";
import { LifecycleBadge, lifecycleLabel, lifecycleTone } from "../components/LifecycleBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatActivityState, formatDate, formatProgressMetric, formatTokens, formatUsd, shortId } from "../format";
import { attackPathHref } from "../lib/attack-path";
import { useI18n } from "../i18n";

type View = "evidence" | "telemetry" | "profile";

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
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  async function load() { const [r, delta] = await Promise.all([api.getScan(id), api.regression(id)]); setScan(r.scan); setRegression(delta); setFindings(delta.findings); return r; }
  useEffect(() => { setScan(null); setFindings([]); setRegression(null); setSelected(null); setSelectedSignal(null); setLogs([]); void load().then((r) => { setView(r.scan.status === "running" ? "telemetry" : "evidence"); }).catch((err) => setError(err instanceof Error ? err.message : "Falha ao carregar canal")); }, [id]);
  useEffect(() => { if (!scan || scan.status !== "running") return; const es = new EventSource(`/api/scans/${id}/events`); const handler = (event: MessageEvent) => { try { const data = JSON.parse(String(event.data)) as ScanEvent; if (data.message) setLogs((old) => [...old.slice(-450), data.message!]); if (data.scan) setScan(data.scan); else if (data.progress) setScan((old) => old ? { ...old, progress: data.progress! } : old); if (data.type === "done") { void load(); es.close(); } } catch { /* malformed event */ } }; ["log", "status", "cost", "progress", "done", "error"].forEach((name) => es.addEventListener(name, handler)); const poll = window.setInterval(() => void load().catch(() => undefined), 4500); return () => { es.close(); window.clearInterval(poll); }; }, [id, scan?.status]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);
  const filtered = useMemo(() => findings.filter((f) => (!severity || f.severity === severity) && (!lifecycle || f.lifecycle === lifecycle) && `${f.title} ${f.summary} ${f.primaryPath} ${f.category} ${f.cwe.join(" ")} ${f.lifecycle} ${f.triage.status}`.toLowerCase().includes(query.toLowerCase())), [findings, severity, lifecycle, query]);
  async function openFinding(f: LifecycleFinding, update = true) { try { const r = await api.getFinding(f.sourceScanId, f.findingId); setSelected(r.finding); setSelectedSignal(f); setView("evidence"); if (update) setParams({ f: f.findingId }, { replace: true }); } catch (err) { setError(err instanceof Error ? err.message : "Falha ao abrir evidência"); } }
  useEffect(() => { const fid = params.get("f"); const hit = findings.find((f) => f.findingId === fid); if (hit && (selected?.findingId !== fid || selectedSignal?.sourceScanId !== hit.sourceScanId)) void openFinding(hit, false); }, [findings, params]);
  async function cancel() { try { await api.cancelScan(id); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Falha ao cancelar"); } }
  async function setBaseline() { setBaselineBusy(true); try { const delta = await api.setBaseline(id); setRegression(delta); setFindings(delta.findings); setLifecycle(""); } catch (err) { setError(err instanceof Error ? err.message : "Falha ao fixar baseline"); } finally { setBaselineBusy(false); } }
  async function saveTriage(status: FindingTriageStatus, note: string) { if (!selectedSignal) return; const { triage } = await api.updateTriage(id, selectedSignal.findingId, { status, note }); setFindings((items) => items.map((item) => item.identity === selectedSignal.identity ? { ...item, triage } : item)); setSelectedSignal((item) => item ? { ...item, triage } : item); }
  if (!scan && !error) return <Loading />;
  if (!scan) return <AlertBanner>{error}</AlertBanner>;
  const highPlus = scan.severity.critical + scan.severity.high;
  const isOpenRouterEstimate = scan.cost?.pricingSource === "openrouter";
  const costDetail = isOpenRouterEstimate
    ? `IN ${formatUsd(scan.cost?.inputUsd)} · OUT ${formatUsd(scan.cost?.outputUsd)}`
    : undefined;
  return <div>
    <header className="bench-panel bench-corners mb-4">
      <div className="flex h-8 items-center justify-between border-b px-3 font-mono text-[8px] uppercase tracking-[.13em] text-muted-foreground"><span className="text-primary">CHANNEL / {shortId(scan.id)}</span><span>{scan.status === "running" ? "LIVE TELEMETRY" : "ARCHIVED EVIDENCE"}</span></div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 border-b p-5 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center gap-2"><Button asChild variant="ghost" size="sm"><Link to="/scans"><HugeiconsIcon icon={ArrowLeft01Icon} size={12} />{t("scanDetail.ledger")}</Link></Button><StatusBadge status={scan.status} /><span className="border border-primary/35 bg-primary/5 px-2 py-1 font-mono text-[9px] uppercase text-primary">{scan.engine}</span><span className="border px-2 py-1 font-mono text-[9px] text-muted-foreground">{scan.model}/{scan.effort}/{scan.mode}</span></div>
          <h1 className="mt-5 truncate font-heading text-3xl font-semibold tracking-[-.045em] sm:text-4xl">{scan.displayName}</h1>
          <button type="button" onClick={() => void navigator.clipboard.writeText(scan.repositoryPath ?? scan.scanDir)} className="mt-2 flex max-w-full items-center gap-2 truncate font-mono text-[10px] text-muted-foreground hover:text-primary"><HugeiconsIcon icon={Copy01Icon} size={11} />{scan.repositoryPath ?? scan.scanDir}</button>
          <div className="mt-5"><SeverityStrip counts={scan.severity} total={scan.severity.total} /></div>
          <div className="mt-5 flex flex-wrap gap-2"><Button asChild variant="outline" size="sm"><Link to={`/compare?ids=${scan.id}`}><HugeiconsIcon icon={Analytics01Icon} size={12} />{t("scanDetail.compare")}</Link></Button><Button asChild variant="outline" size="sm"><Link to={rescanHref(scan)}><HugeiconsIcon icon={RefreshIcon} size={12} />{t("scanDetail.repeat")}</Link></Button>{scan.status === "completed" && <Button variant="outline" size="sm" onClick={() => void setBaseline()} disabled={baselineBusy || regression?.isRepositoryBaseline}><HugeiconsIcon icon={SecurityCheckIcon} size={12} />{regression?.isRepositoryBaseline ? t("scanDetail.repoBaseline") : baselineBusy ? t("scanDetail.settingBaseline") : t("scanDetail.setBaseline")}</Button>}{scan.status === "running" && <Button variant="destructive" size="sm" onClick={() => void cancel()}><HugeiconsIcon icon={StopIcon} size={12} />{t("scanDetail.cancel")}</Button>}<DeleteScanButton scan={scan} onDeleted={() => navigate("/scans")} /></div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-5 p-5"><Readout label="HIGH+" value={highPlus} tone="risk" /><Readout label="TOTAL" value={scan.severity.total} /><Readout label={isOpenRouterEstimate ? "EST. COST" : "COST"} value={formatUsd(scanEstimatedUsd(scan))} detail={costDetail} tone="signal" /><Readout label="DURATION" value={<LiveDuration startedAt={scan.startedAt} completedAt={scan.completedAt} status={scan.status} durationMs={scan.durationMs} showDot={false} />} /><Readout label="INPUT" value={formatTokens(scan.cost?.inputTokens)} detail={isOpenRouterEstimate ? `CACHE ${formatTokens(scan.cost?.cachedInputTokens)}` : undefined} /><Readout label="OUTPUT" value={formatTokens(scan.cost?.outputTokens)} detail={isOpenRouterEstimate ? <span title={scan.cost?.pricingModel}>OPENROUTER RATE</span> : undefined} /><Button asChild className="col-span-2 h-auto justify-between border-chart-1 bg-chart-1 px-4 py-3 text-[#060609] hover:bg-chart-1/90"><Link to={`/scans/${scan.id}/report`} target="_blank"><span className="flex items-center gap-3"><HugeiconsIcon icon={DocumentValidationIcon} size={18} /><span className="text-left"><strong className="block text-xs uppercase tracking-[.08em]">{t("scanDetail.report")}</strong><span className="mt-0.5 block font-mono text-[8px] font-normal uppercase opacity-75">{scan.severity.total} findings · {t("scanDetail.print")}</span></span></span><HugeiconsIcon icon={ArrowRight01Icon} size={15} /></Link></Button></div>
      </div>
      {regression && <RegressionRail regression={regression} active={lifecycle} onSelect={(value) => { setLifecycle((current) => current === value ? "" : value); setView("evidence"); }} />}
      {scan.progress && <div className="border-t px-4 py-3"><div className="mb-2 flex items-center justify-between gap-4 font-mono text-[9px]"><span className="truncate">{scan.progress.phaseLabel}{scan.progress.detail ? ` / ${scan.progress.detail}` : ""}</span><span className="shrink-0 text-primary">{formatProgressMetric(scan.progress)}</span></div><ProgressTrack value={scan.progress.percent} indeterminate={scan.progress.indeterminate} /></div>}
    </header>
    {error && <AlertBanner>{error}</AlertBanner>}
    <div className="mb-4 flex overflow-x-auto border border-border">{(["evidence", "telemetry", "profile"] as View[]).map((id, i) => <button key={id} type="button" onClick={() => setView(id)} className={cx("h-10 border-r px-4 font-mono text-[9px] uppercase tracking-wider", view === id ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground")}>0{i + 1} / {id}</button>)}</div>
    {view === "evidence" && <EvidenceWorkbench scan={scan} findings={filtered} allFindings={findings} selected={selected} selectedSignal={selectedSignal} query={query} severity={severity} lifecycle={lifecycle} onQuery={setQuery} onSeverity={setSeverity} onLifecycle={setLifecycle} onOpen={(f) => void openFinding(f)} onSaveTriage={saveTriage} />}
    {view === "telemetry" && <Telemetry scan={scan} logs={logs} logRef={logRef} />}
    {view === "profile" && <Profile scan={scan} />}
  </div>;
}

function EvidenceWorkbench({ scan, findings, allFindings, selected, selectedSignal, query, severity, lifecycle, onQuery, onSeverity, onLifecycle, onOpen, onSaveTriage }: { scan: ScanRun; findings: LifecycleFinding[]; allFindings: LifecycleFinding[]; selected: FindingDetail | null; selectedSignal: LifecycleFinding | null; query: string; severity: string; lifecycle: FindingLifecycle | ""; onQuery: (v: string) => void; onSeverity: (v: string) => void; onLifecycle: (v: FindingLifecycle | "") => void; onOpen: (f: LifecycleFinding) => void; onSaveTriage: (status: FindingTriageStatus, note: string) => Promise<void> }) {
  return <div className="grid min-h-[36rem] md:grid-cols-[minmax(18rem,.75fr)_minmax(26rem,1.25fr)] xl:grid-cols-[14rem_minmax(18rem,.75fr)_minmax(24rem,1.25fr)]">
    <aside className="bench-panel border-b md:col-start-1 md:row-start-1 md:border-r xl:col-auto xl:row-auto xl:border-b-0"><div className="border-b p-3"><label className="flex items-center gap-2"><HugeiconsIcon icon={Search01Icon} size={12} className="text-muted-foreground" /><Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="search evidence" className="h-8 border-0 bg-transparent px-0 font-mono text-[10px] shadow-none focus-visible:ring-0" /></label></div><FilterGroup label="SEVERITY"><FilterButton label="all signals" count={allFindings.length} active={!severity} onClick={() => onSeverity("")} />{["critical", "high", "medium", "low", "info"].map((value) => <FilterButton key={value} label={value} count={allFindings.filter((finding) => finding.severity === value).length} active={severity === value} onClick={() => onSeverity(value)} />)}</FilterGroup><FilterGroup label="LIFECYCLE"><FilterButton label="all states" count={allFindings.length} active={!lifecycle} onClick={() => onLifecycle("")} />{lifecycleOrder.map((value) => <FilterButton key={value} label={lifecycleLabel[value]} count={allFindings.filter((finding) => finding.lifecycle === value).length} active={lifecycle === value} onClick={() => onLifecycle(value)} tone={lifecycleTone[value]} />)}</FilterGroup><div className="border-t p-3 text-[10px] leading-relaxed text-muted-foreground">Lifecycle compara fingerprints do canal atual com o baseline e o histórico deste repositório.</div></aside>
    <Panel className="border-b md:col-start-1 md:row-start-2 md:border-r xl:col-auto xl:row-auto xl:border-b-0" label="SIGNAL / DELTA LIST" title={`${findings.length} evidências no recorte`}><div className="max-h-[42rem] overflow-auto">{findings.map((f) => <button key={`${f.sourceScanId}:${f.findingId}`} onClick={() => onOpen(f)} className={cx("w-full border-b px-3 py-3 text-left hover:bg-accent", selectedSignal?.identity === f.identity && "bg-accent shadow-[inset_2px_0_0_var(--primary)]")}><div className="flex items-start gap-2"><SeverityBadge severity={f.severity} /><LifecycleBadge state={f.lifecycle} /><span className="min-w-0 flex-1 text-xs font-semibold leading-snug">{f.title}</span></div><div className="mt-2 flex min-w-0 items-center gap-2 font-mono text-[8px] text-muted-foreground"><span className="min-w-0 flex-1 truncate">{f.primaryPath ?? f.category ?? f.findingId}</span>{f.triage.status !== "unreviewed" && <span className="shrink-0 uppercase text-chart-2">{triageLabel[f.triage.status]}</span>}</div></button>)}{!findings.length && <EmptyState title="Nenhum sinal neste recorte" description="Remova filtros ou selecione outro estado do lifecycle." />}</div></Panel>
    <Panel className="md:col-start-2 md:row-span-2 md:row-start-1 xl:col-auto xl:row-auto xl:row-span-1" label="INSPECTOR" title={selected?.title ?? "Selecione uma evidência"} aside={selected && <div className="flex items-center gap-2"><LifecycleBadge state={selectedSignal?.lifecycle ?? "new"} /><SeverityBadge severity={selected.severity} /></div>} wrapTitle><div className="max-h-[42rem] overflow-auto">{selected && selectedSignal ? <FindingInspector key={`${selectedSignal.identity}:${selectedSignal.triage.updatedAt}`} scan={scan} finding={selected} signal={selectedSignal} onSaveTriage={onSaveTriage} /> : <EmptyState title="Inspector desarmado" description="Abra um finding na coluna central." />}</div></Panel>
  </div>;
}

const lifecycleOrder: FindingLifecycle[] = ["new", "regressed", "persisting", "fixed"];
const triageLabel: Record<FindingTriageStatus, string> = { unreviewed: "não revisado", confirmed: "confirmado", accepted: "aceito", false_positive: "falso positivo" };

function RegressionRail({ regression, active, onSelect }: { regression: RegressionSummary; active: FindingLifecycle | ""; onSelect: (state: FindingLifecycle) => void }) {
  return <div className="grid border-t sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1.4fr)_repeat(4,minmax(7rem,.65fr))]">
    <div className="min-w-0 border-b border-r px-4 py-3 sm:col-span-2 lg:col-span-1 lg:border-b-0"><div className="bench-label">REPOSITORY BASELINE / {regression.baselineSource}</div>{regression.baseline ? <div className="mt-1 flex items-center gap-2"><span className="truncate text-xs font-semibold">{regression.baseline.displayName}</span><span className="shrink-0 font-mono text-[8px] text-primary">{shortId(regression.baseline.id)}</span></div> : <div className="mt-1 text-xs text-muted-foreground">Primeira observação deste repositório</div>}</div>
    {lifecycleOrder.map((state) => <button key={state} type="button" aria-pressed={active === state} onClick={() => onSelect(state)} className={cx("border-b border-r px-4 py-3 text-left transition hover:bg-accent lg:border-b-0", active === state && "bg-accent shadow-[inset_0_-2px_0_var(--primary)]")}><span className={cx("font-mono text-[8px] uppercase tracking-wider", lifecycleTone[state])}>{lifecycleLabel[state]}</span><strong className="mt-1 block font-mono text-lg">{regression.counts[state]}</strong></button>)}
  </div>;
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return <div className="border-b p-2"><div className="bench-label px-2 pb-1 pt-1">{label}</div>{children}</div>;
}

function FilterButton({ label, count, active, onClick, tone }: { label: string; count: number; active: boolean; onClick: () => void; tone?: string }) {
  return <button type="button" onClick={onClick} className={cx("flex w-full justify-between px-2 py-1.5 font-mono text-[8px] uppercase", active ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground")}><span className={tone}>{label}</span><span>{count}</span></button>;
}

function Telemetry({ scan, logs, logRef }: { scan: ScanRun; logs: string[]; logRef: React.RefObject<HTMLPreElement | null> }) { const activity = scan.progress?.activityState; const activityTone = activity === "active" ? "good" : activity === "stale" ? "risk" : "signal"; return <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]"><Panel label="PROCESS" title="Runtime telemetry"><div className="grid gap-5 p-4"><Readout label="STATUS" value={scan.status.toUpperCase()} tone={scan.status === "running" ? "signal" : "good"} /><Readout label="ACTIVITY" value={formatActivityState(activity)} tone={activity ? activityTone : undefined} detail={activity === "stale" ? "No scanner events for 5m+" : activity === "quiet" ? "No scanner events for 30s+" : activity === "active" ? "Codex events are arriving" : undefined} /><Readout label="LAST EVENT" value={scan.progress?.lastActivityAt ? <LiveDuration startedAt={scan.progress.lastActivityAt} status={scan.status} showDot={false} /> : "—"} detail={scan.progress?.lastActivityAt ? formatDate(scan.progress.lastActivityAt) : undefined} /><Readout label="STAGE" value={formatProgressMetric(scan.progress)} /><Readout label="PHASE" value={scan.progress?.phaseLabel ?? "—"} /><Readout label="PID" value={scan.pid ?? "—"} /><Readout label="STARTED" value={formatDate(scan.startedAt)} /></div></Panel><Panel label="STDOUT / EVENT STREAM" title="Motor local"><pre ref={logRef} className="h-[34rem] overflow-auto whitespace-pre-wrap bg-[#060609] p-4 font-mono text-[10px] leading-5 text-[#b9bac8]">{logs.length ? logs.join("\n") : scan.status === "running" ? "Aguardando eventos do processo…" : "O stream desta execução não está mais ativo."}</pre></Panel></div>; }
function Profile({ scan }: { scan: ScanRun }) { const rows = [["scan id", scan.id], ["engine", scan.engine], ["provider", scan.provider], ["authentication", scan.authMode], ["pricing source", scan.cost?.pricingSource ?? "scanner"], ["pricing model", scan.cost?.pricingModel ?? scan.cost?.model ?? "—"], ["pricing updated", scan.cost?.pricingUpdatedAt ? formatDate(scan.cost.pricingUpdatedAt) : "—"], ["scanner version", scan.scannerVersion ?? "—"], ["recipe hash", scan.recipeHash ?? "—"], ["source", scan.source], ["repository", scan.repositoryPath ?? "—"], ["revision", scan.revision ?? "—"], ["scan dir", scan.scanDir], ["model", scan.model ?? "—"], ["effort", scan.effort ?? "—"], ["mode", scan.mode ?? "—"], ["started", formatDate(scan.startedAt)], ["completed", formatDate(scan.completedAt)]]; return <Panel label="MANIFEST" title="Execution profile"><div className="grid sm:grid-cols-2">{rows.map(([label, value]) => <div key={label} className="min-w-0 border-b p-4 sm:border-r"><div className="bench-label">{label}</div><div className="mt-2 break-all font-mono text-[10px]">{value}</div></div>)}</div></Panel>; }

type InspectorView = "brief" | "flow" | "evidence" | "fix";
type DataRecord = Record<string, unknown>;

function FindingInspector({ scan, finding, signal, onSaveTriage }: { scan: ScanRun; finding: FindingDetail; signal: LifecycleFinding; onSaveTriage: (status: FindingTriageStatus, note: string) => Promise<void> }) {
  const [view, setView] = useState<InspectorView>("brief");
  const tabs: Array<[InspectorView, string, string]> = [
    ["brief", "01", "Resumo"],
    ["flow", "02", "Caminho"],
    ["evidence", "03", `Evidências · ${Array.isArray(finding.codeEvidence) ? finding.codeEvidence.length : 0}`],
    ["fix", "04", "Correção"],
  ];

  return <div>
    <TriageConsole scan={scan} finding={finding} signal={signal} onSave={onSaveTriage} />
    <div className="sticky top-0 z-10 flex overflow-x-auto border-b bg-card/95 backdrop-blur-sm">
      {tabs.map(([id, code, label]) => <button key={id} type="button" onClick={() => setView(id)} className={cx("h-10 shrink-0 border-r px-3 font-mono text-[8px] uppercase tracking-wider", view === id ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground")}><span className="mr-2 opacity-55">{code}</span>{label}</button>)}
    </div>
    {view === "brief" && <FindingBrief finding={finding} />}
    {view === "flow" && <AttackPathPreview model={finding.attackPathModel} hrefForSelection={(laneId, nodeId) => attackPathHref({ scanId: scan.id, findingId: finding.findingId, evidenceScanId: signal.sourceScanId, laneId, nodeId })} />}
    {view === "evidence" && <EvidenceStack value={finding.codeEvidence} locations={finding.locations} />}
    {view === "fix" && <RemediationPlan finding={finding} />}
  </div>;
}

function TriageConsole({ scan, finding, signal, onSave }: { scan: ScanRun; finding: FindingDetail; signal: LifecycleFinding; onSave: (status: FindingTriageStatus, note: string) => Promise<void> }) {
  const [status, setStatus] = useState<FindingTriageStatus>(signal.triage.status);
  const [note, setNote] = useState(signal.triage.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() { setBusy(true); setError(null); try { await onSave(status, note); } catch (err) { setError(err instanceof Error ? err.message : "Falha ao salvar decisão"); } finally { setBusy(false); } }
  return <div className="border-b bg-primary/[.035] p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><LifecycleBadge state={signal.lifecycle} /><span className="font-mono text-[8px] uppercase text-muted-foreground">{signal.lifecycle === "fixed" ? "evidência do baseline" : "evidência do canal atual"}</span></div><span className="font-mono text-[7px] uppercase text-muted-foreground">decision record</span></div>
    <div className="mt-3 grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
      <Select value={status} onValueChange={(value) => setStatus(value as FindingTriageStatus)}><SelectTrigger className="h-9 rounded-none font-mono text-[9px] uppercase"><SelectValue /></SelectTrigger><SelectContent className="rounded-none"><SelectItem value="unreviewed">Não revisado</SelectItem><SelectItem value="confirmed">Confirmado</SelectItem><SelectItem value="accepted">Risco aceito</SelectItem><SelectItem value="false_positive">Falso positivo</SelectItem></SelectContent></Select>
      <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Nota da decisão…" className="h-9 rounded-none text-[10px]" />
      <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>{busy ? "Salvando…" : "Salvar"}</Button>
    </div>
    <div className="mt-2 flex items-center justify-between gap-3"><span className={cx("font-mono text-[8px]", error ? "text-destructive" : "text-muted-foreground")}>{error ?? (signal.triage.updatedAt ? `última decisão · ${formatDate(signal.triage.updatedAt)}` : "nenhuma decisão registrada")}</span><Button asChild variant="ghost" size="sm"><Link to={rescanHref(scan, finding.primaryPath)}><HugeiconsIcon icon={RefreshIcon} size={11} />Rescan do escopo</Link></Button></div>
  </div>;
}

function FindingBrief({ finding }: { finding: FindingDetail }) {
  const rootCause = dataRecord(finding.rootCause);
  const validation = dataRecord(finding.validation);
  return <div>
    <InspectorSection label="O QUE ACONTECE"><p className="text-[15px] leading-7 text-muted-foreground">{finding.summary ?? "Sem resumo disponível."}</p></InspectorSection>
    <div className="grid border-b sm:grid-cols-2">
      <MetaCell label="Categoria" value={finding.category ?? "Não classificada"} />
      <MetaCell label="Confiança" value={finding.confidence ?? "Não informada"} />
      <MetaCell label="Regra" value={finding.ruleId ?? "—"} mono />
      <MetaCell label="Local principal" value={finding.primaryPath ?? "—"} mono />
    </div>
    <InspectorSection label="POR QUE ESTA SEVERIDADE"><Callout tone="risk">{finding.severityRationale ?? "A severidade não inclui uma justificativa detalhada."}</Callout></InspectorSection>
    {textValue(rootCause?.summary) && <InspectorSection label="CAUSA RAIZ"><p className="text-xs leading-6 text-muted-foreground">{textValue(rootCause?.summary)}</p></InspectorSection>}
    {textValue(validation?.summary) && <InspectorSection label="COMO FOI VALIDADO"><p className="text-xs leading-6 text-muted-foreground">{textValue(validation?.summary)}</p>{textValue(validation?.method) && <div className="mt-3 inline-flex border px-2 py-1 font-mono text-[8px] uppercase text-chart-2">{textValue(validation?.method)}</div>}</InspectorSection>}
    {finding.confidenceRationale && <InspectorSection label="CONFIANÇA"><Callout tone="evidence">{finding.confidenceRationale}</Callout></InspectorSection>}
  </div>;
}

function EvidenceStack({ value, locations }: { value: unknown; locations: unknown }) {
  const evidence = Array.isArray(value) ? value.map(dataRecord).filter((item): item is DataRecord => Boolean(item)) : [];
  const locationRows = Array.isArray(locations) ? locations.map(dataRecord).filter((item): item is DataRecord => Boolean(item)) : [];
  if (!evidence.length) return <EmptyState title="Código não anexado" description="O finding não trouxe blocos de evidência estruturados." />;
  return <div>
    <div className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">Cada bloco marca o papel do código no fluxo. Abra somente o trecho que deseja revisar.</div>
    {evidence.map((item, index) => <CodeEvidence key={textValue(item.id) ?? index} item={item} index={index} />)}
    {locationRows.length > 0 && <InspectorSection label="TODAS AS LOCALIZAÇÕES"><div className="space-y-1.5">{locationRows.map((item, index) => <div key={`${textValue(item.path)}-${index}`} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 border-l border-border py-1 pl-3 font-mono text-[9px]"><span className="uppercase text-muted-foreground">{textValue(item.role) ?? "evidence"}</span><span className="break-all text-primary">{locationLabel(item)}</span></div>)}</div></InspectorSection>}
  </div>;
}

function RemediationPlan({ finding }: { finding: FindingDetail }) {
  const controls = textList(finding.preventiveControls);
  const tests = textList(finding.remediationTests);
  const validation = dataRecord(finding.validation);
  const validationLimits = textList(validation?.limitations);
  return <div>
    <InspectorSection label="CORREÇÃO RECOMENDADA"><Callout tone="signal">{textValue(finding.remediation) ?? "O finding não inclui uma remediação textual."}</Callout></InspectorSection>
    {controls.length > 0 && <InspectorSection label="CONTROLES PREVENTIVOS"><NumberedList items={controls} /></InspectorSection>}
    {tests.length > 0 && <InspectorSection label="TESTES DE REGRESSÃO"><NumberedList items={tests} accent="evidence" /></InspectorSection>}
    {validationLimits.length > 0 && <InspectorSection label="RESSALVAS DA VALIDAÇÃO"><BulletList items={validationLimits} /></InspectorSection>}
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
    <div className="border-t bg-[#060609]">
      {textValue(item.explanation) && <p className="border-b px-4 py-3 text-xs leading-6 text-muted-foreground">{textValue(item.explanation)}</p>}
      <pre className="max-w-full overflow-x-auto py-3 font-mono text-[10px] leading-5 text-[#b9bac8] [tab-size:2]"><code className="block min-w-max">{code.split("\n").map((line, lineIndex) => <span key={lineIndex} className="grid grid-cols-[3.25rem_minmax(0,1fr)]"><span className="select-none border-r border-border/70 pr-3 text-right text-muted-foreground/45">{start != null ? start + lineIndex : lineIndex + 1}</span><span className="px-3">{line || " "}</span></span>)}</code></pre>
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
function rescanHref(scan: ScanRun, findingPath?: string | null): string {
  const params = new URLSearchParams({ from: scan.id });
  if (scan.repositoryPath) params.set("repositoryPath", scan.repositoryPath);
  params.set("engine", scan.engine);
  if (scan.authMode) params.set("authMode", scan.authMode);
  if (scan.model) params.set("model", scan.model);
  if (scan.effort) params.set("effort", scan.effort);
  if (scan.mode === "standard" || scan.mode === "deep") params.set("mode", scan.mode);
  const scope = rescanScope(scan.repositoryPath, findingPath);
  if (scope) params.set("paths", scope);
  return `/scans/new?${params.toString()}`;
}
function rescanScope(repositoryPath: string | null, findingPath?: string | null): string | null {
  if (!findingPath) return null;
  let value = findingPath.replace(/:\d+(?::\d+)?(?:-\d+)?$/, "").replaceAll("\\", "/");
  const repository = repositoryPath?.replaceAll("\\", "/").replace(/\/$/, "");
  if (repository && value.startsWith(`${repository}/`)) value = value.slice(repository.length + 1);
  return value.replace(/^\.\//, "") || null;
}
