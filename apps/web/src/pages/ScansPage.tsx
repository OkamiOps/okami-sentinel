import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon, PlusSignIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { type ScanRun } from "@csb/shared";
import { api, type ScanListResponse, type ScanListSummary } from "../api";
import { DeleteScanButton } from "../components/scans/DeleteScanButton";
import { ScanIdentityBadges } from "../components/scans/ScanIdentityBadges";
import { AlertBanner, EmptyState, Loading, PageHeader, Panel, SeverityStrip, StatusBadge } from "../components/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatApiError } from "../lib/http";
import { formatDate, formatScanUsd, formatUsd, shortId } from "../format";
import { useI18n } from "../i18n";
import { reasoningDeliveryCopy, scanReasoningDelivery } from "../lib/reasoning-delivery";

const PAGE_SIZE = 25;
const emptySummary: ScanListSummary = { evidence: 0, costUsd: null, costIsUpperBound: false, archivedCount: 0 };

type ScanStatusFilter = "active" | "running" | "completed" | "failed" | "cancelled" | "all";

export function ScansPage() {
  const { t } = useI18n();
  const [result, setResult] = useState<ScanListResponse>({ scans: [], total: 0, limit: PAGE_SIZE, offset: 0, summary: emptySummary });
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ScanStatusFilter>("active");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const next = await api.listScans({ limit: PAGE_SIZE, offset, status, query });
      if (requestId !== requestRef.current) return;
      const total = next.total ?? next.scans.length;
      const nextOffset = next.offset ?? offset;
      if (total > 0 && nextOffset >= total) {
        const clampedOffset = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
        setOffset(clampedOffset);
        return;
      }
      setResult({
        ...next,
        total,
        limit: next.limit ?? PAGE_SIZE,
        offset: nextOffset,
        summary: next.summary ?? emptySummary,
      });
      if (nextOffset !== offset) setOffset(nextOffset);
      setError(null);
      setLastUpdated(new Date().toISOString());
    } catch (reason) {
      if (requestId === requestRef.current) setError(formatApiError(reason, t));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [offset, query, status, t]);

  useEffect(() => {
    setLoading(true);
    void load();
    const id = window.setInterval(() => void load(), 6000);
    return () => window.clearInterval(id);
  }, [load]);

  const scans = result.scans;
  const total = result.total ?? scans.length;
  const summary = result.summary ?? emptySummary;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(totalPages, Math.floor(offset / PAGE_SIZE) + 1);
  const noDataYet = loading && scans.length === 0 && !error;

  function chooseStatus(next: ScanStatusFilter) {
    setStatus(next);
    setOffset(0);
  }

  function search(value: string) {
    setQuery(value);
    setOffset(0);
  }

  return <div>
    <PageHeader code="02 / RUN LEDGER" title={t("scans.title")} description={t("scans.description")} actions={<Button asChild size="sm"><Link to="/scans/new"><HugeiconsIcon icon={PlusSignIcon} size={13} />{t("scans.new")}</Link></Button>} />
    {error && <AlertBanner tone={scans.length ? "warning" : "error"}><div className="flex flex-wrap items-center justify-between gap-3"><span>{scans.length && lastUpdated ? `${error} · ${t("scans.stale", { date: formatDate(lastUpdated) })}` : error}</span><Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t("common.retry")}</Button></div></AlertBanner>}
    <div className="bench-panel mb-4 grid sm:grid-cols-[minmax(0,1fr)_auto]">
      <label className="group flex h-11 items-center gap-3 border-b bg-background px-3 shadow-[inset_2px_0_0_transparent] transition-[border-color,background-color,box-shadow] focus-within:bg-primary/[.035] focus-within:shadow-[inset_2px_0_0_var(--primary)]"><HugeiconsIcon icon={Search01Icon} size={14} className="text-muted-foreground transition-colors group-focus-within:text-primary" /><Input aria-label={t("scans.filter")} value={query} onChange={(event) => search(event.target.value)} placeholder={t("scans.filter")} className="h-full border-0 bg-transparent px-0 text-xs shadow-none hover:bg-transparent focus-visible:bg-transparent focus-visible:shadow-none" /></label>
      <div className="flex overflow-x-auto">{([["active", t("common.current")], ["running", t("common.live")], ["completed", t("common.complete")], ["failed", t("common.failed")], ["cancelled", t("common.cancelled")], ["all", t("common.all")]] as const).map(([id, label]) => <button key={id} type="button" onClick={() => chooseStatus(id)} className={`h-11 border-l px-3 font-mono text-[9px] uppercase ${status === id ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>)}</div>
    </div>
    <div className="mb-4 grid grid-cols-2 border border-border lg:grid-cols-4"><LedgerReadout label={t("scans.visible")} value={total} /><LedgerReadout label={t("scans.evidence")} value={summary.evidence} /><LedgerReadout label={t("scans.costUsd")} value={formatUsd(summary.costUsd, summary.costIsUpperBound)} /><LedgerReadout label={t("scans.archived")} value={summary.archivedCount} /></div>
    <Panel label={t("scans.channelIndex")} title={t("scans.records", { count: total })} aside={lastUpdated && <span className="font-mono text-[8px] text-muted-foreground">{t("scans.lastUpdated", { date: formatDate(lastUpdated) })}</span>}>
      {noDataYet ? <Loading /> : error && scans.length === 0 ? <EmptyState title={t("scans.unavailable")} description={t("scans.unavailableDescription")} /> : scans.length ? <div className="overflow-x-auto"><table className="table min-w-[68rem]"><thead><tr className="font-mono text-[9px] uppercase text-muted-foreground"><th>{t("scans.id")}</th><th>{t("scans.runTarget")}</th><th>{t("scans.status")}</th><th>{t("scans.spectrum")}</th><th>{t("scans.highPlus")}</th><th>{t("scans.total")}</th><th>{t("scans.cost")}</th><th>{t("scans.started")}</th><th /></tr></thead><tbody>{scans.map((scan) => <RunRow key={scan.id} scan={scan} onDeleted={load} />)}</tbody></table></div> : <EmptyState title={t("scans.empty")} description={t("scans.emptyDescription")} />}
      {total > PAGE_SIZE && <nav className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-3" aria-label={t("scans.pagination")}><span className="font-mono text-[9px] text-muted-foreground">{t("scans.page", { current: currentPage, total: totalPages })}</span><div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}><HugeiconsIcon icon={ArrowLeft01Icon} size={12} />{t("scans.previous")}</Button><Button type="button" variant="outline" size="sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>{t("scans.next")}<HugeiconsIcon icon={ArrowRight01Icon} size={12} /></Button></div></nav>}
    </Panel>
  </div>;
}

function RunRow({ scan, onDeleted }: { scan: ScanRun; onDeleted: () => Promise<void> }) {
  const { t } = useI18n();
  const high = scan.severity.critical + scan.severity.high;
  const reasoning = reasoningDeliveryCopy(scanReasoningDelivery(scan));
  return <tr className="border-border hover:bg-accent/70"><td className="font-mono text-[9px] text-primary">{shortId(scan.id)}</td><td className="min-w-72 max-w-96"><Link to={`/scans/${scan.id}`} className="block truncate text-sm font-semibold hover:text-primary">{scan.displayName}</Link><div className="mt-2"><ScanIdentityBadges scan={scan} compact /></div><span title={scan.repositoryPath ?? scan.scanDir} className="mt-2 block max-w-80 truncate font-mono text-[9px] text-muted-foreground">{scan.repositoryPath ?? scan.scanDir}</span><span className="mt-1 block font-mono text-[8px] uppercase text-muted-foreground">{t(reasoning.key, reasoning.variables)} · {scan.mode}</span></td><td><StatusBadge status={scan.status} /></td><td className="w-48"><SeverityStrip counts={scan.severity} total={scan.severity.total} /></td><td className={high ? "font-mono text-destructive" : "font-mono text-muted-foreground"}>{high}</td><td className="font-mono font-semibold tabular-nums">{scan.severity.total}</td><td className="font-mono text-primary">{formatScanUsd(scan)}</td><td className="font-mono text-[9px] text-muted-foreground">{formatDate(scan.startedAt)}</td><td><div className="flex items-center justify-end gap-1"><DeleteScanButton scan={scan} compact onDeleted={onDeleted} /><Button asChild variant="ghost" size="icon-sm"><Link to={`/scans/${scan.id}`} aria-label={t("scans.open")}><HugeiconsIcon icon={ArrowRight01Icon} size={12} /></Link></Button></div></td></tr>;
}

function LedgerReadout({ label, value }: { label: string; value: string | number }) { return <div className="border-r p-3 last:border-r-0"><div className="bench-label">{label}</div><div className="mt-1 font-mono text-xl font-semibold">{value}</div></div>; }
