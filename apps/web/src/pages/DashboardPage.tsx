import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, PlusSignIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MetricsSummary, ScanRun } from "@csb/shared";
import { api } from "../api";
import { AlertBanner, EmptyState, LiveDuration, Loading, PageHeader, Panel, Readout, SeverityStrip, StatusBadge, cx } from "../components/ui";
import { Button } from "@/components/ui/button";
import { formatDate, formatUsd, shortId } from "../format";

export function DashboardPage() {
  const [data, setData] = useState<MetricsSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() { try { setError(null); const next = await api.metrics(); setData(next); setSelectedId((id) => { if (id && next.recent.some((scan) => scan.id === id)) return id; const running = next.recent.find((scan) => scan.status === "running"); const strongest = [...next.recent].filter((scan) => scan.status === "completed").sort((a, b) => b.severity.total - a.severity.total)[0]; return running?.id ?? strongest?.id ?? next.recent[0]?.id ?? null; }); } catch (err) { setError(err instanceof Error ? err.message : "Falha ao ler a bancada"); } }
  useEffect(() => { void load(); const id = window.setInterval(() => void load(), 8000); return () => window.clearInterval(id); }, []);
  async function reindex() { setBusy(true); try { await api.ingest(); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Falha ao reindexar"); } finally { setBusy(false); } }
  if (!data && !error) return <Loading />;
  if (!data) return <AlertBanner>{error}</AlertBanner>;

  const channels = data.recent.slice(0, 9);
  const selected = channels.find((s) => s.id === selectedId) ?? channels[0] ?? null;
  const selectedIndex = selected ? channels.findIndex((scan) => scan.id === selected.id) : -1;
  const highPlus = data.severity.critical + data.severity.high;
  const chart = (data.costTrend ?? []).map((p, i) => ({ ...p, label: String(i + 1).padStart(2, "0") }));

  return <div>
    <PageHeader code="01 / OVERVIEW" title="Evidence field" description="Cada run é um canal. Severidade, custo e cobertura aparecem como sinais da mesma amostra — não como cartões isolados." actions={<><Button variant="ghost" size="sm" onClick={() => void reindex()} disabled={busy}><HugeiconsIcon icon={RefreshIcon} size={13} className={busy ? "animate-spin" : ""} />Reindexar</Button><Button asChild size="sm"><Link to="/scans/new"><HugeiconsIcon icon={PlusSignIcon} size={13} />Lançar scan</Link></Button></>} />
    {error && <AlertBanner>{error}</AlertBanner>}

    <div className="bench-panel bench-corners scanline overflow-hidden">
      <div className="grid border-b lg:grid-cols-[17rem_minmax(0,1fr)_19rem]">
        <div className="border-b lg:border-b-0 lg:border-r">
          <div className="flex h-11 items-center justify-between border-b px-3"><span className="bench-label">RUN CHANNELS</span><span className="font-mono text-[9px] text-muted-foreground">{channels.length} INDEXED</span></div>
          <div className="max-h-[25rem] overflow-auto">
            {channels.length ? channels.map((scan, index) => { const focused = selected?.id === scan.id; return <button key={scan.id} type="button" aria-pressed={focused} onClick={() => setSelectedId(scan.id)} className={cx("grid w-full grid-cols-[2.3rem_minmax(0,1fr)_auto] items-center gap-2 border-b px-3 py-3 text-left transition hover:bg-accent", focused && "bg-primary/8 shadow-[inset_3px_0_0_var(--primary)]")}><span className={cx("font-mono text-[9px]", focused ? "text-primary" : "text-muted-foreground")}>CH-{String(index + 1).padStart(2, "0")}</span><span className="min-w-0"><span className="block truncate text-xs font-medium">{scan.displayName}</span><span className="mt-1 block truncate font-mono text-[8px] text-muted-foreground">{scan.model}/{scan.effort}</span></span><span className="flex flex-col items-end gap-1">{focused && <span className="font-mono text-[7px] uppercase tracking-wider text-primary">focus</span>}<StatusBadge status={scan.status} /></span></button>; }) : <EmptyState title="Nenhum canal" description="Inicie um scan para abrir a bancada." />}
          </div>
        </div>

        <div className="min-w-0 border-b lg:border-b-0 lg:border-r">
          <div className="flex min-h-11 items-center justify-between gap-3 border-b px-3 py-2"><span className="bench-label">COMPOSIÇÃO DE SEVERIDADE / CHANNEL SELECIONADO</span><span className="hidden font-mono text-[8px] text-muted-foreground sm:block">LARGURA = % DO TOTAL</span></div>
          {selected ? <SelectedComposition key={selected.id} scan={selected} channelIndex={selectedIndex} /> : <EmptyState title="Sem channel selecionado" />}
          {channels.length > 0 && <div className="border-t">
            <div className="flex items-center justify-between border-b px-3 py-2"><span className="bench-label">COMPARAR CHANNELS</span><span className="font-mono text-[8px] text-muted-foreground">CLIQUE PARA MOVER O FOCO</span></div>
            <div className="max-h-48 overflow-auto">{channels.map((scan, index) => <ComparisonLane key={scan.id} scan={scan} index={index} focused={selected.id === scan.id} onSelect={() => setSelectedId(scan.id)} />)}</div>
          </div>}
        </div>

        <div>
          <div className="flex h-11 items-center border-b px-3"><span className="bench-label">SAMPLE READOUT</span></div>
          {selected ? <div className="p-4">
            <div className="font-mono text-[9px] text-primary">{shortId(selected.id)} / {selected.status.toUpperCase()}</div>
            <h2 className="mt-2 text-lg font-semibold leading-tight">{selected.displayName}</h2>
            <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground">{selected.repositoryPath ?? selected.scanDir}</p>
            <div className="mt-5"><SeverityStrip counts={selected.severity} total={selected.severity.total} /></div>
            <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5"><Readout label="HIGH+" value={selected.severity.critical + selected.severity.high} tone="risk" /><Readout label="TOTAL" value={selected.severity.total} /><Readout label="COST" value={formatUsd(selected.cost?.estimatedUsd)} tone="signal" /><Readout label="DURATION" value={<LiveDuration startedAt={selected.startedAt} completedAt={selected.completedAt} status={selected.status} durationMs={selected.durationMs} showDot={false} />} /></div>
            <Button asChild variant="outline" size="sm" className="mt-6 w-full justify-between"><Link to={`/scans/${selected.id}`}>Abrir canal <HugeiconsIcon icon={ArrowRight01Icon} size={12} /></Link></Button>
          </div> : <EmptyState title="Sem amostra" />}
        </div>
      </div>

      <div className="grid grid-cols-2 border-b sm:grid-cols-4 lg:grid-cols-6">
        <GlobalReadout label="EXPOSURE / HIGH+" value={highPlus} tone="risk" />
        <GlobalReadout label="EVIDENCE" value={data.severity.total} />
        <GlobalReadout label="TOTAL COST" value={formatUsd(data.totalEstimatedUsd)} tone="signal" />
        <GlobalReadout label="RUNS COMPLETE" value={`${data.completedScans}/${data.totalScans}`} />
        <GlobalReadout label="HIGH / USD" value={data.highPerDollar?.toFixed(3) ?? "—"} tone="good" />
        <GlobalReadout label="AVG / RUN" value={formatUsd(data.avgUsdPerScan)} />
      </div>
    </div>

    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(25rem,.75fr)]">
      <Panel label="TRACE 01" title="Custo × evidência por run" aside={<div className="flex gap-4 font-mono text-[8px]"><span className="text-primary">■ COST</span><span className="text-chart-2">— FINDINGS</span></div>}>
        {chart.length ? <div className="h-[20rem] px-1 py-4 xl:h-[34rem]"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={chart} margin={{ top: 8, right: 14, left: -15, bottom: 0 }}><CartesianGrid vertical={false} strokeDasharray="2 5" /><XAxis dataKey="label" axisLine={false} tickLine={false} /><YAxis yAxisId="cost" axisLine={false} tickLine={false} tickFormatter={(v) => `$${Number(v).toFixed(0)}`} /><YAxis yAxisId="findings" orientation="right" axisLine={false} tickLine={false} /><Tooltip content={<TraceTooltip />} /><Bar yAxisId="cost" dataKey="estimatedUsd" fill="var(--chart-1)" fillOpacity={0.72} maxBarSize={34} /><Line yAxisId="findings" type="linear" dataKey="findingsTotal" stroke="var(--chart-2)" strokeWidth={1.5} dot={{ r: 3, fill: "var(--background)", strokeWidth: 1.5 }} /></ComposedChart></ResponsiveContainer></div> : <EmptyState title="Sem traço" description="A série começa após a primeira execução." />}
      </Panel>

      <TaxonomyPulse rows={data.topCategories ?? []} />
    </div>

    <Panel className="mt-4" label="RUN LEDGER" title="Últimas execuções" aside={<Button asChild variant="ghost" size="sm"><Link to="/scans">Abrir ledger <HugeiconsIcon icon={ArrowRight01Icon} size={12} /></Link></Button>}>
      <div className="overflow-x-auto"><table className="table table-sm min-w-[48rem]"><thead><tr className="font-mono text-[9px] uppercase text-muted-foreground"><th>Channel</th><th>Run</th><th>Status</th><th>Model</th><th>Exposure</th><th className="text-right">Custo</th><th>Started</th></tr></thead><tbody>{channels.slice(0, 6).map((scan, i) => <tr key={scan.id} className="border-border hover:bg-accent"><td className="font-mono text-[9px] text-primary">CH-{String(i + 1).padStart(2, "0")}</td><td><Link className="font-medium hover:text-primary" to={`/scans/${scan.id}`}>{scan.displayName}</Link></td><td><StatusBadge status={scan.status} /></td><td className="font-mono text-[9px] text-muted-foreground">{scan.model}/{scan.effort}</td><td className="font-mono">{scan.severity.critical + scan.severity.high} / {scan.severity.total}</td><td className="text-right font-mono tabular-nums text-primary">{formatUsd(scan.cost?.estimatedUsd)}</td><td className="font-mono text-[9px] text-muted-foreground">{formatDate(scan.startedAt)}</td></tr>)}</tbody></table></div>
    </Panel>
  </div>;
}

function TaxonomyPulse({ rows }: { rows: MetricsSummary["topCategories"] }) {
  const visible = rows.slice(0, 8);
  const [selectedCategory, setSelectedCategory] = useState(visible[0]?.category ?? "");
  const selected = visible.find((row) => row.category === selectedCategory) ?? visible[0];

  if (!selected) return <Panel label="TAXONOMY / PULSE" title="Concentração por classe"><EmptyState title="Sem taxonomia" description="As classes aparecem depois que a primeira evidência for indexada." /></Panel>;

  const selectedIndex = visible.findIndex((row) => row.category === selected.category);
  const maxCount = Math.max(1, ...visible.map((row) => row.count));
  const sampleTotal = visible.reduce((sum, row) => sum + row.count, 0);
  const selectedHigh = Math.min(selected.count, selected.high);
  const selectedOther = Math.max(0, selected.count - selectedHigh);
  const selectedShare = sampleTotal ? Math.round((selected.count / sampleTotal) * 100) : 0;

  return <Panel
    label="TAXONOMY / PULSE"
    title="Concentração por classe"
    aside={<div className="flex items-center gap-3 font-mono text-[7px] uppercase text-muted-foreground"><span className="flex items-center gap-1.5"><i className="size-1.5 bg-destructive" />high+</span><span className="flex items-center gap-1.5"><i className="size-1.5 bg-chart-2" />outros</span></div>}
  >
    <div key={selected.category} className="animate-in fade-in-0 slide-in-from-bottom-1 border-b bg-primary/[.035] px-4 py-4 duration-200">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[8px] uppercase tracking-[.14em] text-primary">classe em foco / {String(selectedIndex + 1).padStart(2, "0")}</span>
        <span className="font-mono text-[8px] text-muted-foreground">TOP {visible.length}</span>
      </div>
      <h3 className="mt-2 text-base font-semibold leading-snug [overflow-wrap:anywhere]">{selected.category}</h3>
      <div className="mt-4 grid grid-cols-4 border-l border-t">
        <TaxonomyMetric label="TOTAL" value={selected.count} />
        <TaxonomyMetric label="HIGH+" value={selectedHigh} tone="risk" />
        <TaxonomyMetric label="OUTROS" value={selectedOther} tone="good" />
        <TaxonomyMetric label="SHARE" value={`${selectedShare}%`} />
      </div>
      <p className="mt-2 font-mono text-[7px] uppercase leading-relaxed text-muted-foreground">share = participação desta classe nas {sampleTotal} evidências do top {visible.length}</p>
    </div>

    <div>
      <div className="grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-2 border-b px-4 py-2 font-mono text-[7px] uppercase tracking-wider text-muted-foreground"><span>rank</span><span>classe / composição</span><span>volume</span></div>
      {visible.map((row, index) => {
        const focused = row.category === selected.category;
        const high = Math.min(row.count, row.high);
        const other = Math.max(0, row.count - high);
        return <button
          key={row.category}
          type="button"
          aria-pressed={focused}
          onClick={() => setSelectedCategory(row.category)}
          className={cx("grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] gap-2 border-b px-4 py-3 text-left transition last:border-b-0 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring", focused && "bg-primary/[.07] shadow-[inset_3px_0_0_var(--primary)]")}
        >
          <span className={cx("pt-0.5 font-mono text-[8px]", focused ? "text-primary" : "text-muted-foreground")}>{String(index + 1).padStart(2, "0")}</span>
          <span className="min-w-0">
            <span className="block text-[11px] font-medium leading-snug [overflow-wrap:anywhere]">{row.category}</span>
            <span className="mt-2 block h-1.5 bg-muted" aria-hidden="true"><span className="flex h-full" style={{ width: `${(row.count / maxCount) * 100}%` }}>{high > 0 && <i className="h-full bg-destructive" style={{ width: `${(high / row.count) * 100}%` }} />}{other > 0 && <i className="h-full bg-chart-2" style={{ width: `${(other / row.count) * 100}%` }} />}</span></span>
          </span>
          <span className="text-right"><strong className="block font-mono text-[10px] font-semibold">{row.count}</strong><span className={cx("mt-1 block font-mono text-[7px] uppercase", high ? "text-destructive" : "text-muted-foreground")}>{high} high+</span></span>
        </button>;
      })}
    </div>
  </Panel>;
}

function TaxonomyMetric({ label, value, tone }: { label: string; value: string | number; tone?: "risk" | "good" }) {
  return <div className="border-b border-r px-2 py-2"><span className="block font-mono text-[7px] text-muted-foreground">{label}</span><strong className={cx("mt-1 block font-mono text-sm", tone === "risk" && "text-destructive", tone === "good" && "text-chart-2")}>{value}</strong></div>;
}

const severityChannels = [
  { key: "critical", label: "Critical", bar: "bg-destructive", text: "text-destructive" },
  { key: "high", label: "High", bar: "bg-destructive/70", text: "text-destructive" },
  { key: "medium", label: "Medium", bar: "bg-chart-3", text: "text-chart-3" },
  { key: "low", label: "Low", bar: "bg-chart-5", text: "text-chart-5" },
  { key: "info", label: "Info", bar: "bg-muted-foreground/45", text: "text-muted-foreground" },
] as const;

function SelectedComposition({ scan, channelIndex }: { scan: ScanRun; channelIndex: number }) {
  const total = scan.severity.total;
  const values = severityChannels.map((item) => ({
    ...item,
    count: item.key === "info" ? scan.severity.info + scan.severity.unknown : scan.severity[item.key],
  }));

  return <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
    <div className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><div className="font-mono text-[8px] uppercase tracking-[.12em] text-primary">CH-{String(channelIndex + 1).padStart(2, "0")} / EM FOCO</div><h3 className="mt-1 truncate text-base font-semibold">{scan.displayName}</h3><p className="mt-1 truncate font-mono text-[8px] text-muted-foreground">{scan.model}/{scan.effort} · {scan.mode ?? "standard"}</p></div>
        <div className="flex items-center gap-2"><StatusBadge status={scan.status} /><span className="font-mono text-[9px] text-muted-foreground">{total} findings</span></div>
      </div>
      <p className="mt-4 text-[10px] leading-relaxed text-muted-foreground">Cada cor é uma severidade. A largura mostra quanto ela representa dentro deste channel.</p>
      {total > 0 ? <div className="mt-3 flex h-10 w-full overflow-hidden border border-border bg-muted" role="img" aria-label={`Composição de ${scan.displayName}: ${values.map((item) => `${item.label} ${item.count}`).join(", ")}`}>{values.map((item) => { const percent = (item.count / total) * 100; if (!item.count) return null; return <div key={item.key} className={cx("flex min-w-1 items-center justify-center border-r border-background/55 px-1 font-mono text-[8px] font-semibold text-[#060609] transition-[width] duration-300 last:border-r-0", item.bar)} style={{ width: `${percent}%` }} title={`${item.label}: ${item.count} (${Math.round(percent)}%)`}>{percent >= 13 && <span className="truncate">{item.label.toUpperCase()} {item.count}</span>}</div>; })}</div> : <div className="mt-3 flex h-10 items-center justify-center border border-dashed border-border bg-muted/35 font-mono text-[9px] text-muted-foreground">0 FINDINGS · NENHUMA EVIDÊNCIA INDEXADA</div>}
      <div className="mt-3 grid grid-cols-2 border-l border-t sm:grid-cols-5">{values.map((item) => <SeverityReadout key={item.key} label={item.label} count={item.count} total={total} tone={item.text} />)}</div>
    </div>
  </div>;
}

function SeverityReadout({ label, count, total, tone }: { label: string; count: number; total: number; tone: string }) {
  const percent = total ? Math.round((count / total) * 100) : 0;
  return <div className="border-b border-r px-2.5 py-2"><div className={cx("font-mono text-[8px] uppercase", tone)}>{label}</div><div className="mt-1 flex items-baseline gap-1.5"><span className="font-mono text-sm font-semibold">{count}</span><span className="font-mono text-[8px] text-muted-foreground">{percent}%</span></div></div>;
}

function ComparisonLane({ scan, index, focused, onSelect }: { scan: ScanRun; index: number; focused: boolean; onSelect: () => void }) {
  return <button type="button" aria-pressed={focused} onClick={onSelect} className={cx("grid w-full grid-cols-[2.6rem_minmax(7rem,.7fr)_minmax(9rem,1.3fr)_3rem] items-center gap-2 border-b px-3 py-2.5 text-left transition hover:bg-accent", focused && "bg-primary/8 shadow-[inset_2px_0_0_var(--primary)]")}>
    <span className={cx("font-mono text-[8px]", focused ? "text-primary" : "text-muted-foreground")}>CH-{String(index + 1).padStart(2, "0")}</span>
    <span className="min-w-0"><span className="block truncate text-[10px] font-medium">{scan.displayName}</span><span className="block truncate font-mono text-[7px] text-muted-foreground">{scan.model}/{scan.effort}</span></span>
    <span className="min-w-0">{scan.severity.total ? <SeverityStrip counts={scan.severity} total={scan.severity.total} /> : <span className="flex h-2.5 items-center justify-center border border-dashed border-border font-mono text-[6px] uppercase text-muted-foreground">sem findings</span>}</span>
    <span className={cx("text-right font-mono text-[9px]", focused ? "text-primary" : "text-muted-foreground")}>{scan.severity.total}</span>
  </button>;
}

function GlobalReadout({ label, value, tone }: { label: string; value: string | number; tone?: "signal" | "risk" | "good" }) { return <div className="border-r border-t p-3 first:border-t-0 sm:border-t-0"><Readout label={label} value={value} tone={tone} /></div>; }
function TraceTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { displayName: string; estimatedUsd: number; findingsTotal: number; findingsHigh: number } }> }) { const p = payload?.[0]?.payload; if (!active || !p) return null; return <div className="border bg-popover p-3 text-xs"><div className="font-semibold">{p.displayName}</div><div className="mt-2 grid grid-cols-2 gap-6 font-mono text-[10px]"><span className="text-muted-foreground">COST<strong className="mt-1 block text-primary">{formatUsd(p.estimatedUsd)}</strong></span><span className="text-muted-foreground">EVIDENCE<strong className="mt-1 block text-chart-2">{p.findingsTotal} / {p.findingsHigh} high+</strong></span></div></div>; }
