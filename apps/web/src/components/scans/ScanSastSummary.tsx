import type { FindingSummary, ScanSastSummary as SastSummary } from "@csb/shared";
import { scanSastMessages } from "../../i18n/scan-sast";
import { useScopedI18n } from "../../i18n/scoped";
import { cx } from "../ui";

export function FindingOriginBadge({ finding }: { finding: FindingSummary }) {
  const { t } = useScopedI18n(scanSastMessages);
  const sast = finding.origin?.kind === "sast";
  return <span className={cx("inline-flex shrink-0 border px-1.5 py-0.5 font-mono text-[8px]", sast ? "border-primary/35 bg-primary/5 text-primary" : "border-border text-muted-foreground")}>
    {sast ? t("opengrep") : t("ai")}
  </span>;
}

export function FindingOriginFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useScopedI18n(scanSastMessages);
  return <div role="group" aria-label={t("origin")} className="flex flex-wrap items-center gap-2 border border-b-0 px-3 py-2">
    <span className="mr-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{t("origin")}</span>
    {(["", "sast", "ai"] as const).map(origin => <button key={origin} type="button" aria-pressed={value === origin} onClick={() => onChange(origin)} className={cx("border px-3 py-1 font-mono text-[10px]", value === origin ? "border-primary/35 bg-primary/5 text-primary" : "text-muted-foreground hover:text-foreground")}>
      {t(origin === "" ? "all" : origin)}
    </button>)}
  </div>;
}

export function ScanSastSummary({ summary }: { summary: SastSummary | null | undefined }) {
  const { t, locale } = useScopedI18n(scanSastMessages);
  if (!summary) return null;
  const reason = summary.reason === summary.status ? null : summary.reason && Object.hasOwn(scanSastMessages[locale], summary.reason)
    ? t(summary.reason as keyof typeof scanSastMessages["pt-BR"]) : summary.reason;
  return <section aria-label={t("title")} className="bench-panel mb-4 px-4 py-3">
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[10px]">
      <h2 className="font-semibold text-primary">{t("title")}</h2>
      <span className={summary.status === "completed" ? "text-primary" : "text-muted-foreground"}>{t(summary.status)}{reason ? ` · ${reason}` : ""}</span>
      <span>{t("count", { count: summary.count })}</span>
      <span className="text-muted-foreground">{t("version", { version: summary.version ?? t("unknown") })}</span>
      <span className="text-muted-foreground">{t("duration", { seconds: (summary.durationMs / 1000).toLocaleString(locale, { maximumFractionDigits: 1 }) })}</span>
    </div>
    <p className="mt-2 text-[10px] text-muted-foreground">{t("note")}</p>
  </section>;
}
