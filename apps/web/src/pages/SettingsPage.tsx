import { useEffect, useState } from "react";
import type { HealthResponse } from "@csb/shared";
import { api } from "../api";
import { AlertBanner, PageHeader, Panel, Readout } from "../components/ui";
import { Button } from "@/components/ui/button";

export function SettingsPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() { try { setHealth(await api.health()); setError(null); } catch (err) { setError(err instanceof Error ? err.message : "Engine indisponível"); } }
  useEffect(() => { void load(); }, []);
  async function ingest() { setBusy(true); try { const r = await api.ingest(); setMessage(`${r.imported} registros importados para o índice local.`); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Falha ao reindexar"); } finally { setBusy(false); } }
  return <div>
    <PageHeader code="06 / SYSTEM" title="Engine control" description="Estado do motor local, limites de execução e operações de índice expostos como painel de controle — não como formulário de conta SaaS." />
    {error && <AlertBanner>{error}</AlertBanner>}{message && <AlertBanner tone="success">{message}</AlertBanner>}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(18rem,.7fr)]">
      <Panel label="ENGINE MATRIX" title="Runtime local">
        <div className="grid sm:grid-cols-2"><SystemRow label="API" value={health?.api ?? "unreachable"} state={health?.ok} /><SystemRow label="CLI VERSION" value={health?.codexInfo?.cliVersion ?? "unknown"} /><SystemRow label="SDK VERSION" value={health?.codexInfo?.sdkVersion ?? "unknown"} /><SystemRow label="DEFAULT MODEL" value={health?.codexInfo?.model ?? "runtime default"} /><SystemRow label="REASONING" value={health?.codexInfo?.reasoningEffort ?? "runtime default"} /><SystemRow label="STATE DIR" value={health?.codexStateDir ?? "—"} /></div>
      </Panel>
      <Panel label="CAPACITY" title="Execution envelope">
        <div className="grid grid-cols-2 gap-5 p-4"><Readout label="ACTIVE" value={health?.activeScanIds.length ?? 0} tone={health?.activeScanIds.length ? "signal" : "good"} /><Readout label="CAPACITY" value={health?.maxConcurrentScans ?? "—"} /><Readout label="AVAILABLE" value={health ? Math.max(0, health.maxConcurrentScans - health.activeScanIds.length) : "—"} /><Readout label="HEALTH" value={health?.ok ? "READY" : "OFFLINE"} tone={health?.ok ? "good" : "risk"} /></div>
      </Panel>
    </div>
    <Panel className="mt-4" label="INDEX OPERATIONS" title="Filesystem ingestion" aside={<Button size="sm" onClick={() => void ingest()} disabled={busy}>{busy ? "INDEXANDO…" : "REINDEXAR AGORA"}</Button>}>
      <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]"><p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">Revarre artefatos do Codex Security no diretório de estado e atualiza o índice local. A operação não inicia scans e não altera os repositórios analisados.</p><div className="border-l pl-4 font-mono text-[9px] leading-5 text-muted-foreground"><div>WRITE TARGET / LOCAL INDEX</div><div>SOURCE / {health?.codexStateDir ?? "UNKNOWN"}</div><div className="text-chart-2">SIDE EFFECT / INGEST ONLY</div></div></div>
    </Panel>
  </div>;
}
function SystemRow({ label, value, state }: { label: string; value: string; state?: boolean }) { return <div className="min-w-0 border-b p-4 sm:border-r"><div className="bench-label">{label}</div><div className="mt-2 flex items-center gap-2"><span className={`size-1.5 rounded-full ${state === true ? "bg-chart-2" : state === false ? "bg-destructive" : "bg-border"}`} /><span className="truncate font-mono text-xs">{value}</span></div></div>; }
