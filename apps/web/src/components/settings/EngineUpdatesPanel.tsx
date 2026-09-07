import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineUpdateErrorCode, EngineUpdateItem, EngineUpdatesResponse } from "@csb/shared";
import { ExternalLink, RefreshCw, RotateCcw } from "lucide-react";

import { formatDate } from "../../format";
import { engineUpdatesMessages } from "../../i18n/engine-updates";
import { useScopedI18n } from "../../i18n/scoped";
import { engineUpdatesApi } from "../../lib/engine-updates-api";
import { AlertBanner, Loading, Panel, cx } from "../ui";
import { Button } from "../ui/button";

type Operation = { id: EngineUpdateItem["id"]; action: "update" | "rollback" } | null;
type EngineUpdatesMessageKey = keyof typeof engineUpdatesMessages["pt-BR"];
type EngineUpdatesTranslator = (key: EngineUpdatesMessageKey, variables?: Record<string, string | number>) => string;

const errorCodes = new Set<EngineUpdateErrorCode>([
  "scan_active", "update_in_progress", "check_required", "version_changed",
  "external_runtime", "bundled_engine", "registry_unavailable", "install_failed",
  "verification_failed", "rollback_unavailable", "state_invalid",
]);

const statusTone: Record<EngineUpdateItem["status"], string> = {
  unchecked: "border-border text-muted-foreground",
  current: "border-chart-2/45 text-chart-2",
  available: "border-primary/45 text-primary",
  review_required: "border-chart-3/45 text-chart-3",
  unavailable: "border-destructive/45 text-destructive",
};

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function versionLabel(item: EngineUpdateItem): "engineUpdates.currentVersion" | "engineUpdates.cachedVersion" | "engineUpdates.externalVersion" | "engineUpdates.bundledVersion" {
  if (item.source === "managed") return "engineUpdates.currentVersion";
  if (item.source === "external") return "engineUpdates.externalVersion";
  if (item.source === "bundled") return "engineUpdates.bundledVersion";
  return "engineUpdates.cachedVersion";
}

function errorMessage(error: unknown, t: EngineUpdatesTranslator): string {
  const code = error instanceof Error ? error.message as EngineUpdateErrorCode : null;
  return code && errorCodes.has(code)
    ? t(`engineUpdates.error.${code}` as keyof typeof engineUpdatesMessages["pt-BR"])
    : t("engineUpdates.loadError");
}

export function EngineUpdatesPanel() {
  const { t } = useScopedI18n(engineUpdatesMessages);
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  const preserveActionError = useRef(false);
  const [snapshot, setSnapshot] = useState<EngineUpdatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [operation, setOperation] = useState<Operation>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async ({ preserveError = false }: { preserveError?: boolean } = {}) => {
    const version = ++requestVersion.current;
    try {
      const next = await engineUpdatesApi.list();
      if (!mounted.current || version !== requestVersion.current) return;
      setSnapshot(next);
      if (!preserveError && !preserveActionError.current) setError(null);
    } catch (cause) {
      if (!mounted.current || version !== requestVersion.current) return;
      if (!preserveError) setError(errorMessage(cause, t));
    } finally {
      if (mounted.current && version === requestVersion.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  useEffect(() => {
    const delay = operation || snapshot?.busy ? 2_000 : snapshot?.blockedReason === "scan_active" ? 5_000 : null;
    if (delay === null) return;
    const interval = window.setInterval(() => void refresh(), delay);
    return () => window.clearInterval(interval);
  }, [operation, refresh, snapshot?.blockedReason, snapshot?.busy]);

  const replaceSnapshot = useCallback((next: EngineUpdatesResponse) => {
    ++requestVersion.current;
    if (!mounted.current) return;
    setSnapshot(next);
    setError(null);
    setLoading(false);
  }, []);

  async function check() {
    ++requestVersion.current;
    preserveActionError.current = false;
    setChecking(true);
    setError(null);
    try {
      replaceSnapshot(await engineUpdatesApi.check());
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause, t));
    } finally {
      if (mounted.current) setChecking(false);
    }
  }

  async function run(item: EngineUpdateItem, action: NonNullable<Operation>["action"]) {
    if (action === "update" && (!item.canUpdate || !item.latestVersion)) return;
    if (action === "rollback" && (!item.canRollback || !item.previousVersion)) return;
    ++requestVersion.current;
    preserveActionError.current = false;
    setOperation({ id: item.id, action });
    setError(null);
    try {
      const next = action === "update"
        ? await engineUpdatesApi.update(item.id, item.latestVersion!)
        : await engineUpdatesApi.rollback(item.id);
      replaceSnapshot(next);
    } catch (cause) {
      if (mounted.current) {
        preserveActionError.current = true;
        setError(errorMessage(cause, t));
        void refresh({ preserveError: true });
      }
    } finally {
      if (mounted.current) setOperation(null);
    }
  }

  const busy = Boolean(checking || operation || snapshot?.busy);
  const blockedMessage = snapshot?.blockedReason ? t(`engineUpdates.blocked.${snapshot.blockedReason}` as keyof typeof engineUpdatesMessages["pt-BR"]) : null;
  const lastOperation = snapshot?.lastOperation;

  return <Panel
    className="mt-4"
    label={t("engineUpdates.label")}
    title={t("engineUpdates.title")}
    aside={<Button variant="outline" size="sm" onClick={() => void check()} disabled={checking || busy}>
      <RefreshCw aria-hidden="true" className={cx("size-3", checking && "animate-spin")} />
      {checking ? t("engineUpdates.checking") : t("engineUpdates.check")}
    </Button>}
  >
    <div className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">
      <p>{t("engineUpdates.description")}</p>
      <p className="mt-2 border-l border-primary/40 pl-3 text-[11px]">{t("engineUpdates.managed")}</p>
    </div>

    {loading && !snapshot ? <Loading label={t("engineUpdates.loading")} /> : <>
      {error && <div className="px-4 pt-4"><AlertBanner>{error}</AlertBanner></div>}
      {blockedMessage && <div className="px-4 pt-4"><AlertBanner tone="warning">{blockedMessage}</AlertBanner></div>}
      {operation && <div className="px-4 pt-4"><AlertBanner tone="info">{t(`engineUpdates.operation.${operation.action}` as keyof typeof engineUpdatesMessages["pt-BR"])}</AlertBanner></div>}
      {lastOperation?.status === "failed" && <div className="px-4 pt-4"><AlertBanner><div>{t("engineUpdates.lastOperation.failed")}</div>{lastOperation.error && <div className="mt-1">{t(`engineUpdates.error.${lastOperation.error}`)}</div>}</AlertBanner></div>}

      <div role="list" aria-label={t("engineUpdates.title")} className="divide-y divide-border">
        {(snapshot?.items ?? []).map((item) => <UpdateRow
          item={item}
          key={item.id}
          busy={busy || Boolean(snapshot?.blockedReason)}
          pending={operation?.id === item.id}
          t={t}
          onUpdate={() => void run(item, "update")}
          onRollback={() => void run(item, "rollback")}
        />)}
      </div>

      <p className="border-t px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">{t("engineUpdates.methodology")}</p>
      {lastOperation && lastOperation.status === "succeeded" && <p className="border-t px-4 py-2 font-mono text-[8px] uppercase tracking-[.1em] text-muted-foreground">{t("engineUpdates.lastOperation", { action: t(`engineUpdates.lastOperation.${lastOperation.action}` as keyof typeof engineUpdatesMessages["pt-BR"]), version: lastOperation.version ?? t("engineUpdates.notReported") })}</p>}
    </>}
  </Panel>;
}

function UpdateRow({
  item, busy, pending, t, onUpdate, onRollback,
}: {
  item: EngineUpdateItem;
  busy: boolean;
  pending: boolean;
  t: EngineUpdatesTranslator;
  onUpdate: () => void;
  onRollback: () => void;
}) {
  const sourceUrl = safeExternalUrl(item.sourceUrl);
  const canUpdate = item.canUpdate && Boolean(item.latestVersion) && !busy;
  const canRollback = item.canRollback && Boolean(item.previousVersion) && !busy;
  const updateLabel = item.source === "managed"
    ? t("engineUpdates.update", { version: item.latestVersion ?? t("engineUpdates.notReported") })
    : t("engineUpdates.install", { version: item.latestVersion ?? t("engineUpdates.notReported") });

  return <article role="listitem" className="grid min-w-0 gap-4 px-4 py-4 lg:grid-cols-[minmax(13rem,.8fr)_minmax(17rem,1.2fr)_auto] lg:items-center">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{item.name}</h3>
        <span className={cx("border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider", statusTone[item.status])}>{t(`engineUpdates.status.${item.status}`)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[8px] uppercase tracking-[.1em] text-muted-foreground">
        <span>{t(`engineUpdates.source.${item.source}`)}</span>
        {item.checkedAt && <span>{t("engineUpdates.checkedAt", { date: formatDate(item.checkedAt) })}</span>}
      </div>
      {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[10px] text-primary underline-offset-4 hover:underline"><ExternalLink aria-hidden="true" className="size-3" />{t("engineUpdates.openSource")}</a>}
    </div>

    <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-l border-border pl-3 sm:grid-cols-3 lg:border-l-0 lg:pl-0">
      <VersionReadout label={t(versionLabel(item))} value={item.currentVersion ?? t("engineUpdates.notReported")} />
      <VersionReadout label={t("engineUpdates.latestVersion")} value={item.latestVersion ?? t("engineUpdates.notReported")} tone={item.status === "available" ? "text-primary" : undefined} />
      {item.previousVersion && <VersionReadout label={t("engineUpdates.rollback", { version: item.previousVersion })} value={item.previousVersion} />}
      {item.error && <div className={cx("col-span-full font-mono text-[9px]", item.error === "bundled_engine" ? "text-chart-3" : "text-destructive")}>{t(`engineUpdates.error.${item.error}`)}</div>}
    </div>

    <div className="flex min-w-[11rem] flex-wrap gap-2 lg:justify-end">
      {item.canUpdate && <Button size="sm" variant="configuration" disabled={!canUpdate} onClick={onUpdate}>{pending ? t("engineUpdates.working") : updateLabel}</Button>}
      {item.canRollback && <Button size="sm" variant="outline" disabled={!canRollback} onClick={onRollback}><RotateCcw aria-hidden="true" className="size-3" />{t("engineUpdates.rollback", { version: item.previousVersion ?? "" })}</Button>}
    </div>
  </article>;
}

function VersionReadout({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0"><div className="bench-label">{label}</div><div className={cx("mt-1 truncate font-mono text-xs font-semibold tabular-nums", tone)}>{value}</div></div>;
}
