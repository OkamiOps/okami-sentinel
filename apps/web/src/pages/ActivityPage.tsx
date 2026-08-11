import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, StopIcon } from "@hugeicons/core-free-icons";
import type { ScanRun } from "@csb/shared";
import { api } from "../api";
import { AlertBanner, EmptyState, LiveDuration, PageHeader, Panel, ProgressTrack, StatusBadge } from "../components/ui";
import { Button } from "@/components/ui/button";
import { formatDate, formatProgressMetric, formatScanUsd } from "../format";
import { useI18n } from "../i18n";

export function ActivityPage() {
  const { t } = useI18n();
  const [scans, setScans] = useState<ScanRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  async function load() { try { const r = await api.listScans(); setScans(r.scans); setError(null); } catch (err) { setError(err instanceof Error ? err.message : "Falha ao ler atividade"); } }
  useEffect(() => { void load(); const id = window.setInterval(() => void load(), 3500); return () => window.clearInterval(id); }, []);
  const active = scans.filter((s) => s.status === "running" || s.status === "queued");
  const history = scans.filter((s) => s.status !== "running" && s.status !== "queued").slice(0, 18);
  async function cancel(id: string) { try { await api.cancelScan(id); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Falha ao cancelar"); } }
  return <div>
    <PageHeader code="05 / ACTIVITY" title={t("activity.title")} description={t("activity.description")} />
    {error && <AlertBanner>{error}</AlertBanner>}
    <Panel label="LIVE BUS" title={t("activity.processes", { count: active.length })} aside={<span className="font-mono text-[9px] text-chart-2">POLL / 3.5S</span>}>
      {active.length ? <div className="divide-y">{active.map((scan, i) => <div key={scan.id} className="grid gap-4 px-4 py-4 lg:grid-cols-[3rem_minmax(0,1.3fr)_minmax(12rem,.7fr)_auto] lg:items-center"><div className="font-mono text-[9px] text-primary">PROC<br />{String(i + 1).padStart(2, "0")}</div><div className="min-w-0"><div className="flex items-center gap-2"><span className="truncate text-sm font-semibold">{scan.displayName}</span><StatusBadge status={scan.status} /></div><div className="mt-1 truncate font-mono text-[9px] text-muted-foreground">{scan.engine} · {scan.model}/{scan.effort} · {scan.repositoryPath}</div></div><div><div className="mb-2 flex items-center justify-between gap-3 font-mono text-[9px]"><span className="truncate text-muted-foreground">{scan.progress?.phaseLabel ?? "preflight"}</span><span className="shrink-0 text-primary">{formatProgressMetric(scan.progress)}</span></div><ProgressTrack value={scan.progress?.percent ?? 2} label={scan.progress?.detail ?? undefined} indeterminate={scan.progress?.indeterminate} /></div><div className="flex items-center justify-end gap-2"><LiveDuration startedAt={scan.startedAt} status={scan.status} /><span className="font-mono text-[10px] text-primary">{formatScanUsd(scan)}</span>{scan.status === "running" && <Button variant="destructive" size="icon-sm" onClick={() => void cancel(scan.id)} aria-label={t("activity.cancel")}><HugeiconsIcon icon={StopIcon} size={12} /></Button>}</div></div>)}</div> : <EmptyState title={t("activity.idle")} description={t("activity.idleDescription")} />}
    </Panel>
    <Panel className="mt-4" label="EVENT TRACE" title={t("activity.transitions")}>
      {history.length ? <div>{history.map((scan, i) => <div key={scan.id} className="grid grid-cols-[1.2rem_5rem_minmax(0,1fr)_auto] gap-3 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[1.2rem_8rem_minmax(0,1fr)_8rem_7rem]"><div className="relative flex justify-center"><span className="mt-1.5 size-1.5 rounded-full bg-border" />{i < history.length - 1 && <span className="absolute bottom-[-13px] top-4 w-px bg-border" />}</div><span className="font-mono text-[8px] text-muted-foreground">{formatDate(scan.completedAt ?? scan.startedAt)}</span><span className="min-w-0"><span className="block truncate text-xs font-medium">{scan.displayName}</span><span className="block truncate font-mono text-[8px] text-muted-foreground">{scan.engine} · {scan.model}/{scan.effort}</span></span><span className="hidden text-right font-mono text-[9px] tabular-nums text-primary sm:block">{formatScanUsd(scan)}</span><Link to={`/scans/${scan.id}`} className="flex items-center justify-end gap-2"><StatusBadge status={scan.status} /><HugeiconsIcon icon={ArrowRight01Icon} size={11} className="text-muted-foreground" /></Link></div>)}</div> : <EmptyState title={t("activity.noEvents")} />}
    </Panel>
  </div>;
}
