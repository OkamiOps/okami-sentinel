import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Analytics01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import type { CompareResult, ScanRun } from "@csb/shared";
import { api } from "../api";
import { AlertBanner, EmptyState, LiveDuration, PageHeader, Panel, SeverityBadge, SeverityStrip, cx } from "../components/ui";
import { Button } from "@/components/ui/button";
import { formatUsd, shortId } from "../format";

const colors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-5)", "var(--chart-4)"];

export function ComparePage() {
  const [params] = useSearchParams();
  const [scans, setScans] = useState<ScanRun[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.listScans().then(({ scans: all }) => { const complete = all.filter((s) => s.status === "completed"); setScans(complete); const ids = (params.get("ids") ?? "").split(",").filter(Boolean); if (ids.length >= 2) setSelected(ids.filter((id) => complete.some((s) => s.id === id)).slice(0, 5)); }).catch((err) => setError(err instanceof Error ? err.message : "Falha ao listar")); }, [params]);
  const chosen = useMemo(() => selected.map((id) => scans.find((s) => s.id === id)).filter((s): s is ScanRun => Boolean(s)), [selected, scans]);
  function toggle(id: string) { setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-5)); setResult(null); }
  async function compare() { setBusy(true); setError(null); try { setResult(await api.compare({ scanIds: selected })); } catch (err) { setError(err instanceof Error ? err.message : "Falha na comparação"); } finally { setBusy(false); } }
  return <div>
    <PageHeader code="04 / COMPARE" title="Signal comparator" description="Monte canais lado a lado e compare o que interessa: custo, exposição encontrada, eficiência e evidência compartilhada. Sem transformar um radar bonito em conclusão falsa." actions={<Button onClick={() => void compare()} disabled={busy || selected.length < 2}><HugeiconsIcon icon={Analytics01Icon} size={13} />{busy ? "PROCESSANDO…" : `COMPARAR ${selected.length} CANAIS`}</Button>} />
    {error && <AlertBanner>{error}</AlertBanner>}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <Panel label="SAMPLE LIBRARY" title="Runs concluídos">
        {scans.length ? <div className="grid md:grid-cols-2">{scans.map((scan) => { const on = selected.includes(scan.id); const channel = selected.indexOf(scan.id); return <button key={scan.id} type="button" onClick={() => toggle(scan.id)} className={cx("grid min-h-32 grid-cols-[2rem_minmax(0,1fr)] gap-3 border-b p-4 text-left md:nth-[odd]:border-r", on ? "bg-accent shadow-[inset_2px_0_0_var(--primary)]" : "hover:bg-accent/60")}><span className={cx("flex size-6 items-center justify-center border font-mono text-[9px]", on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground")}>{on ? <HugeiconsIcon icon={Tick02Icon} size={12} /> : "+"}</span><span className="min-w-0"><span className="flex items-center justify-between gap-3"><span className="truncate text-sm font-semibold">{scan.displayName}</span>{on && <span className="font-mono text-[8px] text-primary">CH-{String(channel + 1).padStart(2, "0")}</span>}</span><span className="mt-1 block truncate font-mono text-[9px] text-muted-foreground">{scan.model}/{scan.effort}/{scan.mode}</span><span className="mt-4 block"><SeverityStrip counts={scan.severity} total={scan.severity.total} /></span><span className="mt-2 grid grid-cols-3 font-mono text-[9px]"><span>{formatUsd(scan.cost?.estimatedUsd)}</span><span className="text-destructive">{scan.severity.critical + scan.severity.high} high+</span><span className="text-right text-muted-foreground">{scan.severity.total} total</span></span></span></button>; })}</div> : <EmptyState title="Biblioteca vazia" description="Conclua dois scans para abrir o comparador." />}
      </Panel>
      <Panel className="h-fit xl:sticky xl:top-24" label="PATCH BAY" title={`${chosen.length}/5 canais conectados`}>
        <div className="min-h-64 divide-y">{chosen.map((scan, i) => <div key={scan.id} className="flex items-center gap-3 px-3 py-3"><span className="font-mono text-[9px]" style={{ color: colors[i] }}>CH-{String(i + 1).padStart(2, "0")}</span><span className="min-w-0 flex-1 truncate text-xs">{scan.displayName}</span><button type="button" onClick={() => toggle(scan.id)} className="font-mono text-[9px] text-muted-foreground hover:text-destructive">DISCONNECT</button></div>)}{chosen.length === 0 && <div className="p-4 text-xs leading-relaxed text-muted-foreground">Selecione runs na biblioteca para conectá-los à bancada.</div>}</div>
        <div className="border-t p-3"><Button className="w-full" disabled={chosen.length < 2 || busy} onClick={() => void compare()}>EXECUTAR LEITURA</Button></div>
      </Panel>
    </div>
    {result && <ComparisonOutput result={result} />}
  </div>;
}

function ComparisonOutput({ result }: { result: CompareResult }) {
  const maxEff = Math.max(.001, ...result.ranking.map((r) => r.highPerDollar ?? 0));
  const points = result.ranking.map((row, i) => ({ x: row.estimatedUsd, y: row.findingsHigh, z: Math.max(60, row.findingsTotal * 7), name: result.scans.find((s) => s.id === row.scanId)?.displayName ?? shortId(row.scanId), color: colors[i], index: i }));
  return <section className="mt-5">
    <div className="mb-3 flex items-center gap-3"><span className="bench-label text-primary">READOUT / COMPLETE</span><span className="h-px flex-1 bg-border" /><span className="font-mono text-[8px] text-muted-foreground">ABSOLUTE VALUES · HEURISTIC EFFICIENCY</span></div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,.8fr)]">
      <Panel label="EFFICIENCY PLANE" title="Custo × high findings" aside={<span className="font-mono text-[8px] text-muted-foreground">BUBBLE / TOTAL FINDINGS</span>}>
        <div className="h-[23rem] p-3"><ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 15, right: 20, bottom: 5, left: 0 }}><CartesianGrid strokeDasharray="2 5" /><XAxis type="number" dataKey="x" name="Custo" tickFormatter={(v) => `$${Number(v).toFixed(0)}`} /><YAxis type="number" dataKey="y" name="High+" /><ZAxis type="number" dataKey="z" range={[70, 520]} /><Tooltip content={<PlaneTooltip />} />{points.map((p) => <Scatter key={p.name} name={p.name} data={[p]} fill={p.color} />)}</ScatterChart></ResponsiveContainer></div>
      </Panel>
      <Panel label="EFFICIENCY RAIL" title="High findings / USD">
        <div className="divide-y">{result.ranking.map((row, i) => { const scan = result.scans.find((s) => s.id === row.scanId); return <div key={row.scanId} className="p-4"><div className="flex items-center gap-3"><span className="font-mono text-lg font-semibold" style={{ color: colors[i] }}>0{i + 1}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{scan?.displayName ?? shortId(row.scanId)}</span><span className="font-mono text-[8px] text-muted-foreground">{row.model}/{row.effort}</span></span><span className="font-mono text-xs">{row.highPerDollar?.toFixed(3) ?? "—"}</span></div><div className="mt-3 h-1 bg-muted"><div className="h-full" style={{ width: `${((row.highPerDollar ?? 0) / maxEff) * 100}%`, background: colors[i] }} /></div></div>; })}</div>
      </Panel>
    </div>
    <Panel className="mt-4" label="TRUTH TABLE" title="Matriz absoluta">
      <div className="overflow-x-auto"><table className="table min-w-[50rem]"><thead><tr className="font-mono text-[9px] uppercase text-muted-foreground"><th>Channel</th><th>Run</th><th>Cost</th><th>High+</th><th>Total</th><th>High/USD</th><th>Duration</th></tr></thead><tbody>{result.ranking.map((row, i) => { const scan = result.scans.find((s) => s.id === row.scanId); return <tr key={row.scanId}><td className="font-mono" style={{ color: colors[i] }}>CH-{String(i + 1).padStart(2, "0")}</td><td><div className="text-xs font-semibold">{scan?.displayName ?? shortId(row.scanId)}</div><div className="font-mono text-[8px] text-muted-foreground">{row.model}/{row.effort}</div></td><td className="font-mono text-primary">{formatUsd(row.estimatedUsd)}</td><td className="font-mono text-destructive">{row.findingsHigh}</td><td className="font-mono">{row.findingsTotal}</td><td className="font-mono text-chart-2">{row.highPerDollar?.toFixed(3) ?? "—"}</td><td><LiveDuration startedAt={scan?.startedAt} completedAt={scan?.completedAt} status={scan?.status} durationMs={row.durationMs} showDot={false} /></td></tr>; })}</tbody></table></div>
    </Panel>
    <div className="mt-4 grid gap-4 lg:grid-cols-2"><FindingBank title={`SHARED SIGNALS / ${result.shared.length}`} rows={result.shared} /><Panel label="UNIQUE SIGNALS" title="Evidência exclusiva por canal"><div className="divide-y">{result.scans.map((scan, i) => <div key={scan.id} className="px-4 py-3"><div className="flex items-center justify-between text-xs"><span className="truncate" style={{ color: colors[i] }}>CH-{String(i + 1).padStart(2, "0")} · {scan.displayName}</span><span className="font-mono">{result.uniqueByScan[scan.id]?.length ?? 0}</span></div><div className="mt-2 flex flex-wrap gap-1">{(result.uniqueByScan[scan.id] ?? []).slice(0, 4).map((f) => <SeverityBadge key={f.key} severity={f.severity} />)}</div></div>)}</div></Panel></div>
  </section>;
}

function FindingBank({ title, rows }: { title: string; rows: Array<{ key: string; severity: string; title: string }> }) { return <Panel label="OVERLAP" title={title}><div className="divide-y">{rows.slice(0, 18).map((f) => <div key={f.key} className="flex items-start gap-3 px-4 py-3"><SeverityBadge severity={f.severity} /><span className="text-xs leading-relaxed">{f.title}</span></div>)}{rows.length === 0 && <EmptyState title="Nenhum sinal compartilhado" />}</div></Panel>; }
function PlaneTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { name: string; x: number; y: number; z: number } }> }) { const p = payload?.[0]?.payload; if (!active || !p) return null; return <div className="border bg-popover p-3 text-xs"><div className="font-semibold">{p.name}</div><div className="mt-2 font-mono text-[9px] text-muted-foreground">{formatUsd(p.x)} · {p.y} high+ · {Math.round(p.z / 7)} total</div></div>; }
