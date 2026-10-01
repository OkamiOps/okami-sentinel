import { GitBranch, Hammer } from "lucide-react";
import type { GuardrailBaseline } from "@csb/shared";

import { AlertBanner, Panel, cx } from "../ui";
import { Button } from "@/components/ui/button";
import { useI18n } from "../../i18n";
import { baselineLabelKey, baselineToneOf } from "../../lib/guardrail-repository-page";

const TONE_CLASS = {
  good: "border-chart-2/45 text-chart-2",
  warning: "border-chart-3/45 text-chart-3",
  active: "border-primary/45 text-primary",
  neutral: "border-border text-muted-foreground",
  risk: "border-destructive/45 text-destructive",
} as const;

/**
 * The baseline block of the repository page: the word, the commit it stands on, and
 * the one button that builds it without waiting for a merge.
 *
 * The three facts share one fixed grid, so the columns line up with the other blocks
 * of the page instead of being measured by whatever each value happens to be.
 */
export function BaselineCard({
  baseline,
  hasProtectedBranchAction,
  canBuild,
  busy,
  error,
  onBuild,
}: {
  baseline: GuardrailBaseline;
  hasProtectedBranchAction: boolean;
  canBuild: boolean;
  busy: boolean;
  error: string | null;
  onBuild: () => void;
}) {
  const { t, locale } = useI18n();
  const tone = baselineToneOf(baseline);

  return <Panel
    label={t("guardrails.baselineSection")}
    title={t("guardrails.baselineSectionTitle")}
    wrapTitle
    aside={canBuild && <Button type="button" size="sm" disabled={busy} onClick={onBuild}>
      <Hammer aria-hidden className="size-3" />
      {busy ? t("guardrails.baselineBuildStarting") : t("guardrails.baselineBuildNow")}
    </Button>}
  >
    <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">
      {t("guardrails.baselineSectionDescription")}
    </p>

    {error && <div className="p-4 pb-0"><AlertBanner>{error}</AlertBanner></div>}

    <dl className="grid gap-4 p-4 sm:grid-cols-3">
      <div className="min-w-0">
        <dt className="bench-label">{t("guardrails.baselineState")}</dt>
        <dd className="mt-2">
          <span className={cx(
            "inline-flex h-6 items-center gap-1.5 border px-2 font-mono text-[9px] uppercase tracking-wider",
            TONE_CLASS[tone],
          )}>
            <span className={cx("size-1 rounded-full bg-current", tone === "active" && "live-dot")} />
            {t(baselineLabelKey(baseline))}
          </span>
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="bench-label">{t("guardrails.baselineCommit")}</dt>
        <dd className="mt-2 min-w-0 break-all font-mono text-[10px] leading-relaxed">
          {baseline.commitSha === null ? "—" : baseline.commitSha.slice(0, 12)}
          {baseline.protectedBranch !== null && <span className="ml-2 inline-flex items-center gap-1 text-muted-foreground">
            <GitBranch aria-hidden className="size-2.5" />{baseline.protectedBranch}
          </span>}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="bench-label">
          {baseline.state === "building" && baseline.requestedAt !== null
            ? t("guardrails.baselineRequestedAt")
            : t("guardrails.baselineBuiltAt")}
        </dt>
        <dd className="mt-2 min-w-0 font-mono text-[10px] leading-relaxed">
          {formatMoment(
            baseline.state === "building" ? baseline.requestedAt ?? baseline.builtAt : baseline.builtAt,
            locale,
          )}
        </dd>
      </div>
    </dl>

    {/* Without a push action on the protected branch the baseline will never appear
        on its own, and saying "it builds itself on the first merge" would be a
        promise the configuration does not keep. */}
    {!hasProtectedBranchAction && <p className="border-t border-chart-3/40 bg-chart-3/[.06] px-4 py-3 text-xs leading-relaxed text-chart-3">
      {t("guardrails.baselineNoPushAction")}
    </p>}

    {canBuild && <p className="border-t px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
      {t("guardrails.baselineBuildCost")}
    </p>}
  </Panel>;
}

function formatMoment(value: string | null, locale: string): string {
  if (value === null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}
