import { useEffect, useState } from "react";
import type { ScanAnalysisMetrics as Metrics, ScanRun } from "@csb/shared";
import { useI18n } from "../../i18n";
import { useScopedI18n } from "../../i18n/scoped";
import { scanMetricsMessages } from "../../i18n/scan-metrics";
import { Button } from "../ui/button";

export function ScanAnalysisMetrics({ scan }: { scan: ScanRun }) {
  const { locale } = useI18n();
  const { t } = useScopedI18n(scanMetricsMessages);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const controller = new AbortController();
    setMetrics(null);
    setError(false);
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch(`/api/scans/${encodeURIComponent(scan.id)}/analysis-metrics`, { signal: controller.signal });
        if (!response.ok) throw new Error("metrics_unavailable");
        const value = await response.json() as Metrics;
        if (!disposed) { setMetrics(value); setError(false); }
      } catch { if (!disposed) setError(true); }
      finally { pending = false; }
    };
    void load();
    const timer = scan.status === "running" || scan.status === "queued" ? window.setInterval(() => void load(), 15_000) : undefined;
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); };
  }, [scan.id, scan.status, retry]);
  const number = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString(locale, { maximumFractionDigits: 0 });
  const rows = [
    { label: t("files"), value: number(metrics?.files) },
    { label: t("size"), value: metrics?.bytes == null ? "—" : `${(metrics.bytes / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 2 })} MB` },
    { label: t("lines"), value: number(metrics?.lines) },
    { label: t("batches"), value: metrics?.batchesTotal == null ? "—" : `${number(metrics.batchesCompleted)} / ${number(metrics.batchesTotal)}`, hint: t("batchesHint"), batch: true },
    { label: t("candidates"), value: number(metrics?.candidates), hint: t("provisional") },
    { label: t("rejections"), value: number(metrics?.rejections), hint: t("repairs") },
    { label: t("speed"), value: metrics?.outputTokensPerSecond == null ? "—" : `${metrics.outputTokensPerSecond.toLocaleString(locale, { maximumFractionDigits: 1 })} tok/s`, hint: t("speedHint") },
    { label: t("reasoning"), value: number(metrics?.reasoningTokens), hint: t("reasoningHint") },
  ];
  return <section aria-label={t("title")} className="mb-4 border border-border bg-card">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"><div><h2 className="text-sm font-semibold">{t("title")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("scope")}</p></div>{metrics && <span className="text-xs text-muted-foreground">{t("updated")} {new Date(metrics.measuredAt).toLocaleTimeString(locale)}</span>}</div>
    {error && <div role="status" className="flex flex-wrap items-center gap-2 border-b p-3 text-xs text-chart-3">{t("error")}<Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>{t("retry")}</Button></div>}
    {!metrics && !error ? <p role="status" className="p-4 text-xs text-muted-foreground">{t("loading")}</p> : <dl className="grid grid-cols-2 lg:grid-cols-4">{rows.map((row) => <div key={row.label} className="min-w-0 border-b border-r p-4"><dt className="text-xs text-muted-foreground">{row.label}</dt><dd className={`mt-2 break-words font-mono text-xl font-semibold ${row.batch ? "text-primary" : ""}`} title={row.value === "—" ? t("missing") : undefined}>{row.value}</dd>{row.batch && metrics?.batchesTotal != null && <div role="progressbar" aria-label={t("batches")} aria-valuemin={0} aria-valuenow={metrics.batchesCompleted ?? 0} aria-valuemax={metrics.batchesTotal} className="mt-2 h-1 w-full bg-primary/20"><div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, (metrics.batchesCompleted ?? 0) / Math.max(1, metrics.batchesTotal) * 100)}%` }} /></div>}{row.hint && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{row.hint}</p>}</div>)}</dl>}
  </section>;
}
