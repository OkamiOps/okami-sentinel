import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, PlusSignIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { scanEstimatedUsd, type ScanRun } from "@csb/shared";
import { api } from "../api";
import { DeleteScanButton } from "../components/scans/DeleteScanButton";
import { ScanIdentityBadges } from "../components/scans/ScanIdentityBadges";
import { AlertBanner, EmptyState, Loading, PageHeader, Panel, SeverityStrip, StatusBadge } from "../components/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, formatUsd, shortId } from "../format";
import { useI18n } from "../i18n";

export function ScansPage() {
  const { t } = useI18n();
  const [scans, setScans] = useState<ScanRun[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  async function load() { try { const r = await api.listScans(); setScans(r.scans); setError(null); } catch (err) { setError(err instanceof Error ? err.message : "Falha ao carregar runs"); } finally { setLoading(false); } }
  useEffect(() => { void load(); const id = window.setInterval(() => void load(), 6000); return () => window.clearInterval(id); }, []);
  const visible = useMemo(() => scans.filter((scan) => { if (status === "active" && (scan.status === "cancelled" || scan.status === "failed")) return false; if (status !== "all" && status !== "active" && scan.status !== status) return false; const hay = `${scan.displayName} ${scan.engine} ${scan.model} ${scan.effort} ${scan.repositoryPath}`.toLowerCase(); return hay.includes(query.toLowerCase()); }), [scans, query, status]);
  const pricedCosts = visible.map(scanEstimatedUsd).filter((value): value is number => value != null);
  const totalCost = pricedCosts.length ? pricedCosts.reduce((sum, value) => sum + value, 0) : null;
  const evidence = visible.reduce((sum, scan) => sum + scan.severity.total, 0);

  return <div>
    <PageHeader code="02 / RUN LEDGER" title={t("scans.title")} description={t("scans.description")} actions={<Button asChild size="sm"><Link to="/scans/new"><HugeiconsIcon icon={PlusSignIcon} size={13} />{t("scans.new")}</Link></Button>} />
    {error && <AlertBanner>{error}</AlertBanner>}
    <div className="bench-panel mb-4 grid sm:grid-cols-[minmax(0,1fr)_auto]">
      <label className="flex h-11 items-center gap-2 border-b px-3 sm:border-b-0 sm:border-r"><HugeiconsIcon icon={Search01Icon} size={13} className="text-muted-foreground" /><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("scans.filter")} className="h-full border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0" /></label>
      <div className="flex overflow-x-auto">{[["active", t("common.current")], ["running", t("common.live")], ["completed", t("common.complete")], ["failed", t("common.failed")], ["cancelled", t("common.cancelled")], ["all", t("common.all")]].map(([id, label]) => <button key={id} type="button" onClick={() => setStatus(id)} className={`h-11 border-l px-3 font-mono text-[9px] uppercase ${status === id ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>)}</div>
    </div>
    <div className="mb-4 grid grid-cols-2 border border-border lg:grid-cols-4"><LedgerReadout label="VISIBLE" value={visible.length} /><LedgerReadout label="EVIDENCE" value={evidence} /><LedgerReadout label="COST / USD" value={formatUsd(totalCost)} /><LedgerReadout label="ARCHIVED NOISE" value={scans.filter((s) => s.status === "cancelled" || s.status === "failed").length} /></div>
    <Panel label="CHANNEL INDEX" title={t("scans.records", { count: visible.length })}>
      {loading ? <Loading /> : visible.length ? <div className="overflow-x-auto"><table className="table min-w-[68rem]"><thead><tr className="font-mono text-[9px] uppercase text-muted-foreground"><th>ID</th><th>Run / target</th><th>Status</th><th>Evidence spectrum</th><th>High+</th><th>{t("scans.total")}</th><th>Cost</th><th>Started</th><th /></tr></thead><tbody>{visible.map((scan) => <RunRow key={scan.id} scan={scan} onDeleted={load} />)}</tbody></table></div> : <EmptyState title={t("scans.empty")} description={t("scans.emptyDescription")} />}
    </Panel>
  </div>;
}

function RunRow({ scan, onDeleted }: { scan: ScanRun; onDeleted: () => Promise<void> }) { const high = scan.severity.critical + scan.severity.high; return <tr className="border-border hover:bg-accent/70"><td className="font-mono text-[9px] text-primary">{shortId(scan.id)}</td><td className="min-w-72 max-w-96"><Link to={`/scans/${scan.id}`} className="block truncate text-sm font-semibold hover:text-primary">{scan.displayName}</Link><div className="mt-2"><ScanIdentityBadges scan={scan} compact /></div><span title={scan.repositoryPath ?? scan.scanDir} className="mt-2 block max-w-80 truncate font-mono text-[9px] text-muted-foreground">{scan.repositoryPath ?? scan.scanDir}</span><span className="mt-1 block font-mono text-[8px] uppercase text-muted-foreground">{scan.effort} / {scan.mode}</span></td><td><StatusBadge status={scan.status} /></td><td className="w-48"><SeverityStrip counts={scan.severity} total={scan.severity.total} /></td><td className={high ? "font-mono text-destructive" : "font-mono text-muted-foreground"}>{high}</td><td className="font-mono font-semibold tabular-nums">{scan.severity.total}</td><td className="font-mono text-primary">{formatUsd(scanEstimatedUsd(scan))}</td><td className="font-mono text-[9px] text-muted-foreground">{formatDate(scan.startedAt)}</td><td><div className="flex items-center justify-end gap-1"><DeleteScanButton scan={scan} compact onDeleted={onDeleted} /><Button asChild variant="ghost" size="icon-sm"><Link to={`/scans/${scan.id}`} aria-label="Abrir run"><HugeiconsIcon icon={ArrowRight01Icon} size={12} /></Link></Button></div></td></tr>; }
function LedgerReadout({ label, value }: { label: string; value: string | number }) { return <div className="border-r p-3 last:border-r-0"><div className="bench-label">{label}</div><div className="mt-1 font-mono text-xl font-semibold">{value}</div></div>; }
