import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import type { FsListResponse, HealthResponse } from "@csb/shared";
import { api } from "../api";
import { AlertBanner, PageHeader, Panel, Readout, cx } from "../components/ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { formatUsd } from "../format";

const PREFS = "csb-bench-launch";
const models = ["gpt-5.6-sol", "gpt-5.6-terra"];
const efforts = ["minimal", "low", "medium", "high", "xhigh"];
type Saved = { repositoryPath?: string; model?: string; effort?: string; mode?: "standard" | "deep"; maxCostUsd?: string; unlimited?: boolean; paths?: string };
function saved(): Saved { try { return JSON.parse(localStorage.getItem(PREFS) ?? "{}") as Saved; } catch { return {}; } }
function launchInitial(params: URLSearchParams): Saved {
  const stored = saved();
  const mode = params.get("mode");
  return {
    ...stored,
    repositoryPath: params.get("repositoryPath") || stored.repositoryPath,
    model: params.get("model") || stored.model,
    effort: params.get("effort") || stored.effort,
    mode: mode === "deep" || mode === "standard" ? mode : stored.mode,
    paths: params.get("paths") || stored.paths,
  };
}

export function NewScanPage() {
  const [searchParams] = useSearchParams();
  const initial = useMemo(() => launchInitial(searchParams), [searchParams]);
  const rescanFrom = searchParams.get("from");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [fs, setFs] = useState<FsListResponse | null>(null);
  const [repositoryPath, setRepositoryPath] = useState(initial.repositoryPath ?? "");
  const [model, setModel] = useState(initial.model ?? models[0]);
  const [effort, setEffort] = useState(initial.effort ?? "high");
  const [mode, setMode] = useState<"standard" | "deep">(initial.mode ?? "standard");
  const [maxCostUsd, setMaxCostUsd] = useState(initial.maxCostUsd ?? "100");
  const [unlimited, setUnlimited] = useState(initial.unlimited ?? false);
  const [paths, setPaths] = useState(initial.paths ?? "");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);

  useEffect(() => { void api.health().then(setHealth).catch(() => undefined); void api.listFs(initial.repositoryPath || undefined).then((r) => { setFs(r); setRepositoryPath((p) => p || r.path); }).catch((err) => setError(err instanceof Error ? err.message : "Falha no browser de pastas")); }, [initial.repositoryPath]);
  useEffect(() => { localStorage.setItem(PREFS, JSON.stringify({ repositoryPath, model, effort, mode, maxCostUsd, unlimited, paths })); }, [repositoryPath, model, effort, mode, maxCostUsd, unlimited, paths]);
  async function open(path: string) { try { setFs(await api.listFs(path)); } catch (err) { setError(err instanceof Error ? err.message : "Path indisponível"); } }
  const cost = Math.max(100, Number(maxCostUsd) || 100);
  const expected = Math.round(cost * ({ minimal: .16, low: .3, medium: .55, high: .82, xhigh: 1 }[effort] ?? .7) * (mode === "deep" ? 1.3 : 1));
  async function submit(e: FormEvent) { e.preventDefault(); setError(null); setStarted(null); if (!repositoryPath.trim()) return setError("Selecione um repositório."); if (!authorized) return setError("Autorize explicitamente o envelope de custo."); if (!unlimited && (!Number.isFinite(Number(maxCostUsd)) || Number(maxCostUsd) < 100)) return setError("O limite mínimo é US$ 100."); setBusy(true); try { const { scan } = await api.startScan({ repositoryPath: repositoryPath.trim(), model, effort, mode, maxCostUsd: unlimited ? undefined : cost, paths: paths.split(",").map((p) => p.trim()).filter(Boolean) }); setStarted(scan.id); void api.health().then(setHealth); } catch (err) { setError(err instanceof Error ? err.message : "Falha no lançamento"); } finally { setBusy(false); } }

  return <div>
    <PageHeader code="03 / OPERATE" title="Launch sequencer" description="Um manifesto em três estágios conectados: alvo, estratégia e autorização. O comando só acende quando o envelope está explícito." actions={<Button asChild variant="ghost" size="sm"><Link to="/scans"><HugeiconsIcon icon={ArrowLeft01Icon} size={12} />Voltar ao ledger</Link></Button>} />
    {(health?.activeScanIds.length ?? 0) > 0 && <AlertBanner tone="warning">{health?.activeScanIds.length} processo(s) já consomem o motor · capacidade {health?.maxConcurrentScans}.</AlertBanner>}
    {rescanFrom && <AlertBanner tone="info">Manifesto reaproveitado do canal <span className="font-mono">{rescanFrom.slice(0, 8)}</span>. Revise o escopo e autorize novamente o custo antes de transmitir.</AlertBanner>}
    {error && <AlertBanner>{error}</AlertBanner>}
    {started && <AlertBanner tone="success">Scan aceito pelo motor. <Link to={`/scans/${started}`} className="underline underline-offset-4">Abrir canal ativo</Link>.</AlertBanner>}
    <form onSubmit={(e) => void submit(e)}>
      <div className="grid gap-0 xl:grid-cols-[minmax(0,1.15fr)_minmax(20rem,.85fr)_19rem]">
        <Panel className="xl:border-r-0" label="STAGE 01 / TARGET" title="Repository channel">
          <div className="border-b p-4"><label className="bench-label" htmlFor="repo">ABSOLUTE PATH</label><Input id="repo" value={repositoryPath} onChange={(e) => setRepositoryPath(e.target.value)} className="mt-2 font-mono text-xs" placeholder="/path/to/repository" /></div>
          <div className="flex items-center justify-between border-b px-4 py-2"><span className="font-mono text-[9px] text-muted-foreground">FILESYSTEM / {fs?.path ?? "LOADING"}</span>{fs?.parent && <Button type="button" variant="ghost" size="sm" onClick={() => void open(fs.parent!)}>.. / PARENT</Button>}</div>
          <div className="h-[22rem] overflow-auto">{fs?.entries.filter((x) => x.isDirectory).map((entry) => <button key={entry.path} type="button" onDoubleClick={() => void open(entry.path)} onClick={() => setRepositoryPath(entry.path)} className={cx("grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 border-b px-4 py-2.5 text-left hover:bg-accent", repositoryPath === entry.path && "bg-accent text-primary")}><HugeiconsIcon icon={Folder01Icon} size={13} /><span className="truncate font-mono text-[10px]">{entry.name}</span><span className="font-mono text-[8px] text-muted-foreground">SELECT</span></button>)}</div>
          <div className="border-t p-4"><label className="bench-label" htmlFor="paths">SCOPE PATHS / OPTIONAL</label><Input id="paths" value={paths} onChange={(e) => setPaths(e.target.value)} className="mt-2 font-mono text-xs" placeholder="src, packages/api" /><p className="mt-2 text-[10px] text-muted-foreground">Separados por vírgula. Vazio analisa o repositório inteiro.</p></div>
        </Panel>

        <Panel className="xl:border-r-0" label="STAGE 02 / STRATEGY" title="Analysis profile">
          <div className="border-b p-4"><div className="bench-label mb-3">MODEL CHANNEL</div><div className="grid grid-cols-2">{models.map((id) => <button key={id} type="button" onClick={() => setModel(id)} className={cx("border px-3 py-4 text-left first:border-r-0", model === id ? "border-chart-4/55 bg-chart-4/[.035]" : "border-border hover:bg-accent")}><span className={cx("block font-mono text-[10px]", model === id && "text-chart-4")}>{id}</span><span className="mt-1 block text-[9px] text-muted-foreground">{id.includes("sol") ? "frontier / deep" : "balanced / daily"}</span></button>)}</div></div>
          <div className="border-b p-4"><div className="bench-label mb-3">REASONING EFFORT</div><div className="grid grid-cols-5">{efforts.map((id) => <button key={id} type="button" onClick={() => setEffort(id)} className={cx("h-14 border border-r-0 px-1 font-mono text-[8px] uppercase last:border-r", effort === id ? "border-chart-4/60 bg-chart-4/[.06] text-chart-4" : "hover:bg-accent")}>{id}</button>)}</div></div>
          <div className="border-b p-4"><div className="bench-label mb-3">SCAN MODE</div><div className="grid grid-cols-2">{(["standard", "deep"] as const).map((id) => <button key={id} type="button" onClick={() => setMode(id)} className={cx("border px-3 py-3 font-mono text-[9px] uppercase first:border-r-0", mode === id ? "border-primary bg-primary/8 text-primary" : "border-border hover:bg-accent")}>{id}</button>)}</div></div>
          <div className="p-4"><div className="bench-label">SELECTED PROFILE</div><div className="mt-3 border-l border-chart-4/60 pl-3 font-mono text-[10px] leading-6"><div>{model}</div><div>{effort} / {mode}</div><div className="text-muted-foreground">paths: {paths ? paths.split(",").length : "all"}</div></div></div>
        </Panel>

        <Panel className="bench-corners" label="STAGE 03 / AUTHORIZE" title="Cost envelope">
          <div className="grid grid-cols-2 border-b p-4"><Readout label="EXPECTED" value={unlimited ? "OPEN" : formatUsd(expected)} tone="signal" /><Readout label="CEILING" value={unlimited ? "NONE" : formatUsd(cost)} /></div>
          <div className="border-b p-4"><label className="bench-label" htmlFor="cost">MAX COST / USD</label><Input id="cost" type="number" min="100" step="1" value={maxCostUsd} onChange={(e) => setMaxCostUsd(e.target.value)} disabled={unlimited} className="mt-2 font-mono text-lg" /><label htmlFor="unlimited-cost" className="mt-3 flex cursor-pointer items-center gap-3 text-xs text-muted-foreground"><Checkbox id="unlimited-cost" checked={unlimited} onCheckedChange={(checked) => setUnlimited(checked === true)} />Sem limite de custo</label></div>
          <div className="border-b p-4"><div className="bench-label">CONFIRMAÇÃO OBRIGATÓRIA</div><label htmlFor="authorize-scan" className={cx("mt-3 flex cursor-pointer items-start gap-3 border p-3 transition-colors", authorized ? "border-primary bg-primary/[.06]" : "border-primary/50 bg-background hover:border-primary hover:bg-accent/40")}><Checkbox id="authorize-scan" className="mt-0.5" checked={authorized} onCheckedChange={(checked) => setAuthorized(checked === true)} /><span><span className="block text-sm font-semibold">Autorizar execução</span><span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">Perfil <strong className="text-foreground">{model}/{effort}/{mode}</strong> · custo estimado.</span></span></label></div>
          <div className="p-4"><Button type="submit" size="lg" disabled={busy || !authorized} className="w-full justify-between">{busy ? "TRANSMITINDO…" : "TRANSMITIR MANIFESTO"}<HugeiconsIcon icon={ArrowRight01Icon} size={13} /></Button><div className="mt-3 flex items-center justify-between font-mono text-[8px] text-muted-foreground"><span>ENGINE {health?.ok ? "READY" : "CHECK"}</span><span>{health?.activeScanIds.length ?? 0}/{health?.maxConcurrentScans ?? "—"} ACTIVE</span></div></div>
        </Panel>
      </div>
    </form>
  </div>;
}
