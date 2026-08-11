import { getIntlLocale } from "./i18n";
import { scanEstimatedUsd, type ScanProgress, type ScanRun } from "@csb/shared";

export function formatUsd(value: number | null | undefined, upperBound = false): string {
  if (value == null || Number.isNaN(value)) return "—";
  const formatted = new Intl.NumberFormat(getIntlLocale(), {
    style: "currency",
    currency: "USD",
    currencyDisplay: "code",
    maximumFractionDigits: 2,
  }).format(value);
  return upperBound ? `≤ ${formatted}` : formatted;
}

export function formatScanUsd(
  scan: Pick<ScanRun, "engine" | "authMode" | "cost">,
): string {
  return formatUsd(scanEstimatedUsd(scan), scan.cost?.estimateKind === "upper-bound");
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  }
  if (m > 0) {
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  return `${s}s`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(getIntlLocale(), {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function elapsedFrom(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  if (completedAt) {
    const end = Date.parse(completedAt);
    if (!Number.isNaN(end)) return Math.max(0, end - start);
  }
  return Math.max(0, nowMs - start);
}

export function formatProgressMetric(
  progress: ScanProgress | null | undefined,
): string {
  if (!progress) return "—";
  if (
    progress.indeterminate &&
    progress.currentItem != null &&
    progress.itemsTotal > 0
  ) {
    return `STAGE ${String(progress.currentItem).padStart(2, "0")}/${String(progress.itemsTotal).padStart(2, "0")}`;
  }
  return `${Math.round(progress.percent)}%`;
}

export function formatActivityState(
  state: ScanProgress["activityState"],
): string {
  if (state === "active") return "ACTIVE";
  if (state === "quiet") return "QUIET";
  if (state === "stale") return "NO EVENTS";
  return "—";
}
