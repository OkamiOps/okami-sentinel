import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { HealthResponse, ProviderConnection, ScannerCapability } from "@csb/shared";
import { ArrowRight, RefreshCw } from "lucide-react";

import { api } from "../api";
import { formatDate } from "../format";
import { AlertBanner, Loading, PageHeader, Panel, Readout, cx } from "../components/ui";
import { Button } from "@/components/ui/button";
import { useI18n } from "../i18n";
import { SettingsSectionNav } from "../components/settings/SettingsSectionNav";

type LoadErrors = Partial<Record<"health" | "scanners" | "connections", true>>;

const maturityTone: Record<ScannerCapability["maturity"], string> = {
  stable: "border-chart-2/35 text-chart-2",
  preview: "border-chart-3/35 text-chart-3",
  experimental: "border-chart-4/35 text-chart-4",
};

export function SettingsPage() {
  const { t } = useI18n();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [scanners, setScanners] = useState<ScannerCapability[] | null>(null);
  const [connections, setConnections] = useState<ProviderConnection[] | null>(null);
  const [catalogRefreshedAt, setCatalogRefreshedAt] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [errors, setErrors] = useState<LoadErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [operationError, setOperationError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reindexing, setReindexing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [healthResult, scannerResult, connectionResult] = await Promise.allSettled([
      api.health(),
      api.scanners(),
      api.listConnections(),
    ]);

    const nextErrors: LoadErrors = {};
    if (healthResult.status === "fulfilled") setHealth(healthResult.value);
    else nextErrors.health = true;

    if (scannerResult.status === "fulfilled") {
      setScanners(scannerResult.value.scanners);
      setCatalogRefreshedAt(scannerResult.value.refreshedAt);
    } else nextErrors.scanners = true;

    if (connectionResult.status === "fulfilled") setConnections(connectionResult.value);
    else nextErrors.connections = true;

    setErrors(nextErrors);
    setUpdatedAt(new Date().toISOString());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void api.health().then((next) => {
        setHealth(next);
        setErrors((current) => ({ ...current, health: undefined }));
        setUpdatedAt(new Date().toISOString());
      }).catch(() => {
        setErrors((current) => ({ ...current, health: true }));
      });
    }, 10_000);
    return () => window.clearInterval(id);
  }, []);

  const connectionSummary = useMemo(() => {
    const rows = connections ?? [];
    const ready = rows.filter((connection) => connection.status === "ready").length;
    const stale = rows.filter((connection) => connection.modelCatalogStale).length;
    const protocols = new Set(rows.map((connection) => connection.protocol)).size;
    const lastSync = rows.map((connection) => connection.lastModelSyncAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    return { total: rows.length, ready, attention: rows.length - ready, stale, protocols, lastSync };
  }, [connections]);

  const active = health?.activeScanIds.length ?? 0;
  const limit = health?.maxConcurrentScans ?? 0;
  const available = health ? Math.max(0, limit - active) : null;
  const availableScanners = scanners?.filter((scanner) => scanner.enabled && scanner.available).length ?? 0;
  const hasAnyData = Boolean(health || scanners || connections);
  const hasErrors = Object.values(errors).some(Boolean);

  async function ingest() {
    setReindexing(true);
    setMessage(null);
    setOperationError(false);
    try {
      const result = await api.ingest();
      setMessage(t("settings.reconciled", { count: result.imported }));
      await refresh();
    } catch {
      setMessage(null);
      setOperationError(true);
    } finally {
      setReindexing(false);
    }
  }

  return <div>
    <SettingsSectionNav />
    <PageHeader
      code={t("settings.moduleCode")}
      title={t("settings.title")}
      description={t("settings.description")}
      actions={<Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
        <RefreshCw aria-hidden="true" className={cx("size-3", loading && "animate-spin")} />
        {loading ? t("settings.refreshing") : t("settings.refresh")}
      </Button>}
    />

    {hasErrors && <AlertBanner tone="warning">{t("settings.partialData")}</AlertBanner>}
    {operationError && <AlertBanner>{t("settings.reindexError")}</AlertBanner>}
    {message && <AlertBanner tone="success">{message}</AlertBanner>}
    {!hasAnyData && loading ? <Loading label={t("settings.refreshing")} /> : <>
      <section className="bench-panel bench-corners scanline overflow-hidden" aria-label={t("settings.snapshot")}>
        <div className="grid grid-cols-2 lg:grid-cols-4">
          <SummaryCell label={t("settings.summaryApi")} value={health ? t("settings.reachable") : t("settings.unavailable")} detail={health?.api ?? t("settings.noSignal")} tone={health ? "good" : "risk"} />
          <SummaryCell label={t("settings.summaryScanners")} value={scanners ? scanners.length : "—"} detail={scanners ? t("settings.availableCount", { count: availableScanners }) : t("settings.noSignal")} tone={availableScanners ? "good" : undefined} />
          <SummaryCell label={t("settings.summaryRoutes")} value={connections ? connectionSummary.ready : "—"} detail={connections ? t("settings.routeCount", { total: connectionSummary.total, attention: connectionSummary.attention }) : t("settings.noSignal")} tone={connectionSummary.attention ? "risk" : connectionSummary.ready ? "good" : undefined} />
          <SummaryCell label={t("settings.summaryCapacity")} value={health ? `${active} / ${limit}` : "—"} detail={available == null ? t("settings.noSignal") : t("settings.availableSlots", { count: available })} tone={active >= limit && limit > 0 ? "risk" : "signal"} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 font-mono text-[8px] uppercase tracking-[.12em] text-muted-foreground">
          <span>{t("settings.snapshotUpdated", { date: formatDate(updatedAt) })}</span>
          <span>{t("settings.catalogUpdated", { date: formatDate(catalogRefreshedAt) })}</span>
        </div>
      </section>

      <div className="mt-4 grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(21rem,.65fr)]">
        <Panel className="xl:flex xl:h-full xl:flex-col" label="ENGINE REGISTRY" title={t("settings.engineRegistry")} aside={<span className="font-mono text-[8px] uppercase text-muted-foreground">{scanners?.length ?? 0} / {t("settings.catalogSignals")}</span>}>
          <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("settings.engineRegistryDescription")}</p>
          <div role="list" className="xl:grid xl:flex-1 xl:grid-rows-3">
            {(scanners ?? []).map((scanner, index) => <EngineLane key={scanner.engine} scanner={scanner} index={index} />)}
            {!scanners?.length && <div className="p-6 text-center text-xs text-muted-foreground">{t("settings.noScannerSignal")}</div>}
          </div>
        </Panel>

        <div className="grid content-start gap-4">
          <Panel label="CONNECTION POSTURE" title={t("settings.routePosture")}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-5 p-4">
              <Readout label={t("settings.readyRoutes")} value={connections ? connectionSummary.ready : "—"} tone="good" />
              <Readout label={t("settings.attentionRoutes")} value={connections ? connectionSummary.attention : "—"} tone={connectionSummary.attention ? "risk" : undefined} />
              <Readout label={t("settings.staleCatalogs")} value={connections ? connectionSummary.stale : "—"} tone={connectionSummary.stale ? "risk" : undefined} />
              <Readout label={t("settings.protocols")} value={connections ? connectionSummary.protocols : "—"} />
            </div>
            <div className="border-t p-4">
              <p className="text-xs leading-relaxed text-muted-foreground">{t("settings.routePostureDescription")}</p>
              <p className="mt-3 font-mono text-[8px] uppercase tracking-[.1em] text-muted-foreground">{t("settings.lastModelSync", { date: formatDate(connectionSummary.lastSync) })}</p>
              <Button asChild variant="outline" size="sm" className="mt-4 w-full justify-between">
                <Link to="/settings/connections">{t("settings.manageConnections")}<ArrowRight aria-hidden="true" className="size-3" /></Link>
              </Button>
            </div>
          </Panel>

          <Panel label="ROUTE CONTRACT" title={t("settings.compatibilityTitle")}>
            <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
              {["engine", "connection", "model", "preflight"].map((step, index) => <div key={step} className="bg-card px-3 py-3">
                <div className="font-mono text-[8px] text-primary">{String(index + 1).padStart(2, "0")}</div>
                <div className="mt-1 text-[10px] font-semibold uppercase">{t(`settings.routeStep.${step}` as "settings.routeStep.engine")}</div>
              </div>)}
            </div>
            <p className="border-t px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("settings.compatibilityDescription")}</p>
          </Panel>
        </div>
      </div>

      <div className="mt-4 grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(23rem,.72fr)]">
        <Panel label="LOCAL RUNTIME" title={t("settings.runtime")}>
          <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("settings.runtimeDescription")}</p>
          <dl className="grid sm:grid-cols-2 lg:grid-cols-4">
            <RuntimeCell label={t("settings.apiService")} value={health?.api ?? t("settings.noSignal")} state={Boolean(health)} />
            <RuntimeCell label={t("settings.cliVersion")} value={health?.codexInfo?.cliVersion ?? t("settings.notReported")} />
            <RuntimeCell label={t("settings.sdkVersion")} value={health?.codexInfo?.sdkVersion ?? t("settings.notReported")} />
            <RuntimeCell label={t("settings.localDefault")} value={`${health?.codexInfo?.model ?? t("settings.notReported")} / ${health?.codexInfo?.reasoningEffort ?? t("settings.providerManaged")}`} />
          </dl>
          <div className="grid border-t sm:grid-cols-3">
            <EnvelopeCell label={t("settings.active")} value={health ? active : "—"} />
            <EnvelopeCell label={t("settings.configuredLimit")} value={health ? limit : "—"} />
            <EnvelopeCell label={t("settings.available")} value={available ?? "—"} />
          </div>
          <p className="border-t px-4 py-3 text-[10px] leading-relaxed text-muted-foreground">{t("settings.capacityDescription")}</p>
        </Panel>

        <Panel label="LOCAL INDEX" title={t("settings.ingestion")} aside={<Button size="sm" onClick={() => void ingest()} disabled={reindexing}>{reindexing ? t("settings.indexing") : t("settings.reindex")}</Button>}>
          <div className="p-4">
            <div className="bench-label">{t("settings.indexSource")}</div>
            <div className="mt-2 break-all border-l border-primary/35 pl-3 font-mono text-[10px] leading-relaxed text-foreground">{health?.codexStateDir ?? t("settings.noSignal")}</div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <Readout label={t("settings.indexTarget")} value={t("settings.localIndex")} wrap />
              <Readout label={t("settings.targetRepositories")} value={t("settings.untouched")} tone="good" wrap />
            </div>
            <p className="mt-5 text-xs leading-relaxed text-muted-foreground">{t("settings.ingestionDescription")}</p>
          </div>
        </Panel>
      </div>
    </>}
  </div>;
}

function SummaryCell({ label, value, detail, tone }: { label: string; value: string | number; detail: string; tone?: "signal" | "risk" | "good" }) {
  return <div className="min-w-0 border-b border-r p-3 lg:border-b-0"><Readout label={label} value={value} detail={detail} tone={tone} wrap /></div>;
}

function EngineLane({ scanner, index }: { scanner: ScannerCapability; index: number }) {
  const { t } = useI18n();
  const signaled = scanner.enabled && scanner.available;
  return <article role="listitem" className={cx("grid min-w-0 border-b last:border-b-0 lg:grid-cols-[3.5rem_minmax(14rem,.8fr)_minmax(0,1.2fr)]", signaled ? "border-l-2 border-l-chart-2/70" : "border-l-2 border-l-destructive/70")}>
    <div className="border-b px-3 py-4 font-mono text-[9px] text-muted-foreground lg:border-b-0 lg:border-r">EN-{String(index + 1).padStart(2, "0")}</div>
    <div className="min-w-0 border-b px-4 py-4 lg:border-b-0 lg:border-r">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{scanner.name}</h2>
        <span className={cx("border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider", maturityTone[scanner.maturity])}>{t(`settings.maturity.${scanner.maturity}` as "settings.maturity.stable")}</span>
      </div>
      <div className={cx("mt-2 flex items-center gap-2 font-mono text-[9px] uppercase", signaled ? "text-chart-2" : "text-destructive")}><span className="size-1.5 rounded-full bg-current" />{signaled ? t("settings.catalogAvailable") : t("settings.catalogUnavailable")}</div>
      {scanner.reason && <p className="mt-2 break-words text-[10px] leading-relaxed text-muted-foreground">{scanner.reason}</p>}
    </div>
    <dl className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 2xl:grid-cols-4">
      <EngineDatum label={t("settings.stages")} value={scanner.stageCount} />
      <EngineDatum label={t("settings.modes")} value={scanner.modes.join(" / ")} />
      <EngineDatum label={t("settings.models")} value={scanner.models.length} />
      <EngineDatum label={t("settings.boundary")} value={scanner.writesTarget || scanner.executesGeneratedCode ? t("settings.reviewBoundary") : t("settings.readOnlyBoundary")} tone={scanner.writesTarget || scanner.executesGeneratedCode ? "risk" : "good"} />
    </dl>
  </article>;
}

function EngineDatum({ label, value, tone }: { label: string; value: string | number; tone?: "risk" | "good" }) {
  return <div className="min-w-0 border-b border-r px-3 py-3"><dt className="bench-label">{label}</dt><dd className={cx("mt-1 break-words font-mono text-[10px] font-semibold", tone === "risk" && "text-destructive", tone === "good" && "text-chart-2")}>{value}</dd></div>;
}

function RuntimeCell({ label, value, state }: { label: string; value: string; state?: boolean }) {
  return <div className="min-w-0 border-b border-r p-4"><dt className="bench-label">{label}</dt><dd className="mt-2 flex min-w-0 items-start gap-2"><span className={cx("mt-1 size-1.5 shrink-0 rounded-full", state === true ? "bg-chart-2" : state === false ? "bg-destructive" : "bg-border")} /><span className="break-all font-mono text-[10px] leading-relaxed">{value}</span></dd></div>;
}

function EnvelopeCell({ label, value }: { label: string; value: string | number }) {
  return <div className="border-b border-r p-4"><div className="bench-label">{label}</div><div className="mt-1 font-mono text-lg font-semibold tabular-nums">{value}</div></div>;
}
