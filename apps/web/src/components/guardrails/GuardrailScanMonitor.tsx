import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GateRun, ScanEvent, ScanRun } from "@csb/shared";
import { ArrowUpRight, Cpu, ListChecks, Radio, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";

import { api } from "../../api";
import {
  formatActivityState,
  formatDate,
  formatProgressMetric,
  formatScanUsd,
  formatTokens,
  formatUsd,
} from "../../format";
import { isGateActive } from "../../lib/guardrails";
import { scanCostPresentation, scanTokenUsage } from "../../lib/scan-cost";
import { appendTelemetryEvent, mergeTelemetrySnapshot, telemetrySnapshot } from "../../lib/telemetry";
import { useI18n } from "../../i18n";
import { AlertBanner, LiveDuration, ProgressTrack, Readout, SeverityStrip, StatusBadge, cx } from "../ui";
import { Button } from "@/components/ui/button";

export function GuardrailScanMonitor({ gate, onScanTerminal }: { gate: GateRun; onScanTerminal?: () => void }) {
  const { t } = useI18n();
  const scanId = gate.scanId;
  const [scan, setScan] = useState<ScanRun | null>(null);
  const [telemetry, setTelemetry] = useState(() => telemetrySnapshot([], 0));
  const [loading, setLoading] = useState(scanId !== null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const terminalReportedRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!scanId) return;
    try {
      const [detail, history] = await Promise.all([api.getScan(scanId), api.getTelemetry(scanId)]);
      setScan(detail.scan);
      setTelemetry((current) => mergeTelemetrySnapshot(current, history.lines, history.cursor));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("guardrails.scanUnavailable"));
    } finally {
      setLoading(false);
    }
  }, [scanId, t]);

  useEffect(() => {
    setScan(null);
    setTelemetry(telemetrySnapshot([], 0));
    setLoading(scanId !== null);
    setError(null);
    void load();
  }, [scanId, load]);

  useEffect(() => {
    if (!scan || scan.status === "running" || terminalReportedRef.current === scan.id) return;
    terminalReportedRef.current = scan.id;
    onScanTerminal?.();
  }, [onScanTerminal, scan]);

  useEffect(() => {
    if (!scanId) return;
    const active = isGateActive(gate.status) || scan?.status === "running";
    if (!active) return;
    const source = scan?.status === "running"
      ? new EventSource(api.scanEventsUrl(scanId, telemetry.cursor))
      : null;
    const handler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as ScanEvent;
        if (data.message) setTelemetry((current) => appendTelemetryEvent(current, data));
        if (data.scan) setScan(data.scan);
        else if (data.progress) setScan((current) => current ? { ...current, progress: data.progress } : current);
        if (data.type === "done" || data.type === "error") {
          void load();
          source?.close();
        }
      } catch {
        // The persisted telemetry snapshot remains the source of truth.
      }
    };
    if (source) {
      for (const name of ["log", "status", "cost", "progress", "done", "error"] as const) {
        source.addEventListener(name, handler);
      }
    }
    const poll = window.setInterval(() => void load(), 3_500);
    return () => {
      source?.close();
      window.clearInterval(poll);
    };
  }, [gate.status, load, scan?.status, scanId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [telemetry.lines.length]);

  if (!scanId) return <ScanStarting gate={gate} />;

  if (loading && scan === null) {
    return (
      <section className="bench-panel mt-4 min-w-0" aria-live="polite">
        <div className="flex min-h-44 items-center justify-center gap-3 p-6 text-muted-foreground">
          <RefreshCw aria-hidden className="animate-spin text-primary" size={16} />
          <span className="font-mono text-[9px] uppercase tracking-[.12em]">{t("guardrails.telemetryLoading")}</span>
        </div>
      </section>
    );
  }

  if (!scan) {
    return (
      <section className="bench-panel mt-4 min-w-0 p-4 sm:p-5">
        <AlertBanner>{error ?? t("guardrails.scanUnavailable")}</AlertBanner>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void load()}><RefreshCw aria-hidden size={14} />{t("common.retry")}</Button>
          <Button asChild><Link to={`/scans/${scanId}`}>{t("guardrails.openScanChannel")}<ArrowUpRight aria-hidden size={14} /></Link></Button>
        </div>
      </section>
    );
  }

  const tokenUsage = scanTokenUsage(scan);
  const costCopy = scanCostPresentation(scan.cost);
  const highPlus = scan.severity.critical + scan.severity.high;
  const activity = scan.progress?.activityState;
  const displayedActivity = guardrailDisplayedActivity(scan);
  const activityLabel = displayedActivity === "live"
    ? formatActivityState(activity)
    : displayedActivity === "failed"
      ? t("guardrails.failed")
      : t("guardrails.streamClosed");
  const activityTone = displayedActivity === "failed"
    ? "risk" as const
    : displayedActivity === "closed"
      ? "good" as const
      : activity === "active"
        ? "good" as const
        : activity === "stale"
          ? "risk" as const
          : undefined;
  const logs = telemetry.lines.slice(-120);
  const route = [scan.engine, scan.provider, scan.model].filter(Boolean).join(" · ");
  const reasoning = scan.effort ?? t("guardrails.providerManaged");
  const displayedProgress = guardrailDisplayedProgress(scan);
  const progressLabel = scan.progress
    ? `${scan.status === "failed" || scan.status === "cancelled" ? `${t("guardrails.failed")} · ` : ""}${scan.progress.phaseLabel}${scan.progress.detail ? ` / ${scan.progress.detail}` : ""}`
    : t("guardrails.progressPending");

  return (
    <section className="bench-panel mt-4 min-w-0 overflow-hidden" aria-labelledby="guardrail-scan-monitor-title" aria-live="polite">
      <header className="grid gap-4 border-b px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2 bench-label text-primary"><Radio aria-hidden size={14} className={scan.status === "running" ? "animate-pulse" : undefined} />LIVE SCAN CHANNEL</span>
            <StatusBadge status={scan.status} />
          </div>
          <h2 id="guardrail-scan-monitor-title" className="mt-2 font-heading text-xl font-semibold tracking-[-.025em] sm:text-2xl">{t("guardrails.scanMonitorTitle")}</h2>
          <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{route || scan.id}</p>
        </div>
        <ScanResultActions scan={scan} />
      </header>

      <div className="border-b px-4 py-3 sm:px-5">
        <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2 font-mono text-[9px]">
          <span className="min-w-0 break-words text-muted-foreground">{progressLabel}</span>
          <span className={cx("shrink-0", scan.status === "failed" || scan.status === "cancelled" ? "text-destructive" : "text-primary")}>{displayedProgress.metric}</span>
        </div>
        <ProgressTrack value={displayedProgress.value} indeterminate={displayedProgress.indeterminate} label={progressLabel} />
      </div>

      <div className="grid min-w-0 xl:grid-cols-[minmax(25rem,.82fr)_minmax(0,1.18fr)]">
        <div className="min-w-0 border-b xl:border-b-0 xl:border-r">
          <div className="grid border-b sm:grid-cols-2">
            <MonitorMetric label={t("guardrails.stage")} value={displayedProgress.metric} detail={scan.progress?.phaseLabel ?? "—"} tone={scan.status === "failed" || scan.status === "cancelled" ? "risk" : "signal"} />
            <MonitorMetric label={t("guardrails.activity")} value={activityLabel} detail={scan.progress?.lastActivityAt ? `${t("guardrails.lastEvent")} ${formatDate(scan.progress.lastActivityAt)}` : undefined} tone={activityTone} />
            <MonitorMetric label={t("guardrails.duration")} value={<LiveDuration startedAt={scan.startedAt} completedAt={scan.completedAt} status={scan.status} durationMs={scan.durationMs} showDot={false} />} />
            <MonitorMetric label={t("guardrails.findings")} value={scan.severity.total} detail={`${highPlus} HIGH+`} tone={highPlus > 0 ? "risk" : undefined} />
            <MonitorMetric label={t(costCopy.labelKey)} value={formatScanUsd(scan)} detail={scan.cost?.pricingBasis ?? t("guardrails.costWaitingUsage")} tone="signal" />
            <MonitorMetric label={t("guardrails.costCeiling")} value={formatCeiling(gate.costCeilingUsd)} detail={t("guardrails.costCeilingDetail")} />
          </div>

          <div className="border-b p-4 sm:p-5">
            <div className="flex items-center gap-2 text-primary"><Cpu aria-hidden size={14} /><span className="bench-label">{t("guardrails.executionProfile")}</span></div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Readout label={t("guardrails.engineRoute")} value={route || "—"} detail={scan.execution?.executionProfile ?? undefined} wrap />
              <Readout label={t("guardrails.reasoningMode")} value={`${reasoning} · ${scan.mode ?? "—"}`} detail={scan.connection?.protocol ?? scan.execution?.protocol ?? undefined} wrap />
            </div>
          </div>

          <div className="p-4 sm:p-5">
            <div className="bench-label">{t("guardrails.tokenUsage")}</div>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Readout label={t("guardrails.inputTokens")} value={formatTokens(tokenUsage.inputTokens)} />
              <Readout label={t("guardrails.cachedTokens")} value={formatTokens(tokenUsage.cachedInputTokens)} />
              <Readout label={t("guardrails.outputTokens")} value={formatTokens(tokenUsage.outputTokens)} />
            </div>
            <div className="mt-5"><SeverityStrip counts={scan.severity} total={scan.severity.total} /></div>
          </div>
        </div>

        <div className="min-w-0 bg-[var(--surface-code)]">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
            <div><div className="bench-label text-primary">STDOUT / EVENT STREAM</div><div className="mt-1 text-xs font-semibold">{t("guardrails.eventStream")}</div></div>
            <span className={cx("font-mono text-[8px] uppercase", scan.status === "running" ? "text-chart-2" : "text-muted-foreground")}>{scan.status === "running" ? t("guardrails.streamLive") : t("guardrails.streamClosed")}</span>
          </div>
          <pre ref={logRef} className="h-[23rem] max-w-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[10px] leading-5 text-secondary-foreground sm:p-5">{logs.length ? logs.join("\n") : scan.status === "running" ? t("guardrails.waitingEvents") : t("guardrails.noEvents")}</pre>
        </div>
      </div>
      {error && <div className="border-t p-4"><AlertBanner>{error}</AlertBanner></div>}
    </section>
  );
}

export function guardrailDisplayedActivity(scan: Pick<ScanRun, "status">): "live" | "failed" | "closed" {
  if (scan.status === "running") return "live";
  if (scan.status === "failed" || scan.status === "cancelled") return "failed";
  return "closed";
}

export function guardrailDisplayedProgress(
  scan: Pick<ScanRun, "status" | "progress">,
): { value: number; metric: string; indeterminate: boolean } {
  const progress = scan.progress;
  if (!progress) return { value: 0, metric: "—", indeterminate: scan.status === "running" };
  const terminal = scan.status !== "running";
  if (terminal && progress.unit === "stages" && progress.itemsTotal > 0) {
    const completed = Math.min(progress.itemsCompleted, progress.itemsTotal);
    return {
      value: Math.max(0, Math.min(100, (completed / progress.itemsTotal) * 100)),
      metric: `${completed}/${progress.itemsTotal}`,
      indeterminate: false,
    };
  }
  return {
    value: progress.percent,
    metric: formatProgressMetric(progress),
    indeterminate: scan.status === "running" && progress.indeterminate === true,
  };
}

export function ScanResultActions({ scan }: { scan: ScanRun }) {
  const { t } = useI18n();
  const hasFindings = scan.status !== "running" && scan.severity.total > 0;
  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
      {hasFindings ? (
        <Button asChild className="min-h-11 w-full sm:w-auto">
          <Link to={`/scans/${scan.id}`}><ListChecks aria-hidden size={14} />{t("guardrails.viewFindings", { count: scan.severity.total })}<ArrowUpRight aria-hidden size={14} /></Link>
        </Button>
      ) : (
        <Button asChild className="min-h-11 w-full sm:w-auto">
          <Link to={`/scans/${scan.id}`}>{t("guardrails.openScanChannel")}<ArrowUpRight aria-hidden size={14} /></Link>
        </Button>
      )}
    </div>
  );
}

function ScanStarting({ gate }: { gate: GateRun }) {
  const { t } = useI18n();
  return (
    <section className="bench-panel mt-4 min-w-0" aria-live="polite">
      <div className="flex min-h-44 flex-col justify-center p-5 sm:p-7">
        <div className="flex items-center gap-2 text-primary"><RefreshCw aria-hidden className="animate-spin" size={15} /><span className="bench-label">{t("guardrails.scanStarting")}</span></div>
        <h2 className="mt-3 font-heading text-xl font-semibold">{t("guardrails.scanStartingTitle")}</h2>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">{t("guardrails.scanStartingDescription")}</p>
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          <Readout label={t("guardrails.materialization")} value={gate.materializationState} wrap />
          <Readout label={t("guardrails.costCeiling")} value={formatCeiling(gate.costCeilingUsd)} tone="signal" wrap />
          <Readout label="GATE ID" value={gate.id} wrap />
        </div>
      </div>
    </section>
  );
}

function MonitorMetric({ label, value, detail, tone }: { label: string; value: ReactNode; detail?: ReactNode; tone?: "signal" | "risk" | "good" }) {
  return <div className="min-w-0 border-b p-4 sm:border-r sm:[&:nth-child(2n)]:border-r-0"><Readout label={label} value={value} detail={detail} tone={tone} wrap /></div>;
}

function formatCeiling(value: number | null | undefined): string {
  return value != null && value > 0 ? formatUsd(value, true) : "—";
}
