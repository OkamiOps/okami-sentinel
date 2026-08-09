import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import clsx from "clsx";
import { useElapsedMs } from "../hooks";
import { formatDuration } from "../format";
import { useI18n, type TranslationKey } from "../i18n";

export function cx(...parts: Array<string | false | null | undefined>) { return clsx(parts); }

export function PageHeader({ code, title, description, actions }: { code?: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-5 grid gap-4 border-b border-border pb-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
      <div className="min-w-0">
        <div className="bench-label text-primary">{code ?? "CSB / MODULE"}</div>
        <div className="mt-2 flex min-w-0 items-baseline gap-4">
          <h1 className="truncate font-heading text-2xl font-semibold tracking-[-0.045em] sm:text-3xl">{title}</h1>
          <span className="hidden h-px flex-1 bg-border sm:block" />
        </div>
        {description && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 md:justify-end">{actions}</div>}
    </header>
  );
}

export function Panel({ children, className, label, title, aside, wrapTitle = false }: { children: ReactNode; className?: string; label?: ReactNode; title?: ReactNode; aside?: ReactNode; wrapTitle?: boolean }) {
  return (
    <section className={cx("bench-panel min-w-0", className)}>
      {(label || title || aside) && <div className={cx("flex min-h-11 justify-between gap-4 border-b px-4 py-2.5", wrapTitle ? "items-start" : "items-center")}>
        <div className="min-w-0 flex-1">{label && <div className="bench-label">{label}</div>}{title && <div className={cx("mt-0.5 text-sm font-semibold", wrapTitle ? "whitespace-normal pr-2 leading-snug" : "truncate")}>{title}</div>}</div>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>}
      {children}
    </section>
  );
}

const statusLabel: Record<string, TranslationKey> = { completed: "common.complete", running: "common.live", failed: "common.failed", cancelled: "common.cancelled", queued: "common.queued", incomplete: "common.partial" };
export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const tone: Record<string, string> = { completed: "text-chart-2 border-chart-2/35", running: "text-primary border-primary/40", failed: "text-destructive border-destructive/40", cancelled: "text-muted-foreground border-border", queued: "text-chart-3 border-chart-3/35", incomplete: "text-chart-3 border-chart-3/35" };
  return <span className={cx("inline-flex h-5 items-center gap-1.5 border px-1.5 font-mono text-[9px] uppercase tracking-wider", tone[status] ?? "border-border text-muted-foreground")}><span className={cx("size-1 rounded-full bg-current", status === "running" && "live-dot")} />{statusLabel[status] ? t(statusLabel[status]) : status}</span>;
}

const severityTone: Record<string, string> = { critical: "border-destructive bg-destructive text-white", high: "border-destructive/50 bg-destructive/10 text-destructive", medium: "border-chart-3/50 bg-chart-3/10 text-chart-3", low: "border-chart-5/50 bg-chart-5/10 text-chart-5", info: "border-border bg-muted text-muted-foreground", unknown: "border-border bg-transparent text-muted-foreground" };
export function SeverityBadge({ severity }: { severity: string }) { return <span className={cx("inline-flex h-5 items-center border px-1.5 font-mono text-[9px] font-semibold uppercase tracking-wide", severityTone[severity] ?? severityTone.unknown)}>{severity}</span>; }

export function AlertBanner({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "warning" | "success" | "info" }) {
  const map = { error: "border-destructive/45 bg-destructive/8 text-destructive", warning: "border-chart-3/40 bg-chart-3/8 text-chart-3", success: "border-chart-2/40 bg-chart-2/8 text-chart-2", info: "border-chart-5/40 bg-chart-5/8 text-chart-5" };
  return <div className={cx("mb-4 border px-3 py-2.5 text-xs", map[tone])}>{children}</div>;
}

export function EmptyState({ title, description, icon }: { title: string; description?: string; icon?: IconSvgElement }) {
  return <div className="flex min-h-44 flex-col items-center justify-center px-5 py-12 text-center">{icon && <HugeiconsIcon icon={icon} size={22} className="mb-3 text-muted-foreground" />}<div className="text-sm font-semibold">{title}</div>{description && <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>}</div>;
}

export function Readout({ label, value, detail, tone }: { label: string; value: ReactNode; detail?: ReactNode; tone?: "signal" | "risk" | "good" }) {
  return <div className="min-w-0 border-l border-border pl-3"><div className="bench-label">{label}</div><div className={cx("mt-1 truncate font-mono text-lg font-semibold tabular-nums", tone === "signal" && "text-primary", tone === "risk" && "text-destructive", tone === "good" && "text-chart-2")}>{value}</div>{detail && <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{detail}</div>}</div>;
}

export function LiveDuration({ startedAt, completedAt, status, durationMs, showDot = true }: { startedAt?: string | null; completedAt?: string | null; status?: string | null; durationMs?: number | null; showDot?: boolean }) {
  const elapsed = useElapsedMs(startedAt, status, completedAt);
  return <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">{showDot && status === "running" && <span className="live-dot text-primary" />}{formatDuration(durationMs ?? elapsed)}</span>;
}

export function ProgressTrack({ value, label }: { value: number; label?: string }) {
  return <div><div className="h-1 bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>{label && <div className="mt-1 font-mono text-[9px] text-muted-foreground">{label}</div>}</div>;
}

export function Loading() { return <div className="flex min-h-72 items-center justify-center"><span className="loading loading-bars loading-md text-primary" /></div>; }

export function SeverityStrip({ counts, total }: { counts: { critical: number; high: number; medium: number; low: number; info?: number; unknown?: number }; total: number }) {
  const { t } = useI18n();
  const rows = [
    ["critical", counts.critical, "bg-destructive"], ["high", counts.high, "bg-destructive/70"], ["medium", counts.medium, "bg-chart-3"], ["low", counts.low, "bg-chart-5"], ["info", counts.info ?? 0, "bg-muted-foreground/40"],
  ] as const;
  return <div className="flex h-2.5 w-full overflow-hidden bg-muted" aria-label={`${total} ${t("common.findings")}`}>{rows.map(([key, value, color]) => value > 0 && <span key={key} className={color} style={{ width: `${(value / Math.max(1, total)) * 100}%` }} title={`${key}: ${value}`} />)}</div>;
}
