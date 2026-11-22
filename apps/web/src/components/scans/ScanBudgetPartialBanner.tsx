import type { ScanBudgetWorkItem, ScanRun } from "@csb/shared";
import { formatUsd } from "../../format";
import { scanBudgetMessages } from "../../i18n/scan-budget";
import { useScopedI18n } from "../../i18n/scoped";
import { budgetResumeCommand, isBudgetPartial } from "../../lib/scan-budget";
import { AlertBanner } from "../ui";
import { ScanResumeForm } from "./ScanResumeForm";

export function ScanBudgetPartialBanner({ scan }: { scan: ScanRun }) {
  const { t } = useScopedI18n(scanBudgetMessages);
  if (!isBudgetPartial(scan) && !scan.providerPartial && !scan.resume) return null;
  const summary = scan.budgetPartial;
  const workSummary = summary ?? scan.providerPartial;
  const workList = (items: ScanBudgetWorkItem[]) => items.length ? <ul className="max-h-64 space-y-2 overflow-y-auto">
    {items.map((item, index) => <li key={`${item.stage}:${item.page}:${index}`}>
      <span>{item.stage} / {item.page ?? t("budgetUnplanned")}</span>
      {item.artifactPath && <code className="mt-1 block break-all text-[10px] text-muted-foreground">{item.artifactPath}</code>}
    </li>)}
  </ul> : <p>{t("budgetNone")}</p>;
  return <AlertBanner tone="warning">
    <h2 className="font-heading text-base font-semibold">{t(scan.providerPartial
      ? scan.providerPartial.stopReason === "rate_limited" ? "providerRateLimited" : "providerPartial"
      : isBudgetPartial(scan) ? "budgetPartial" : "resumeStageFailed")}</h2>
    {scan.providerPartial && <p className="mt-2">{t("providerPartialReason")}</p>}
    {scan.resume && <ScanResumeForm key={scan.id} scan={scan} />}
    {workSummary ? <>
      {summary && <p className="mt-2 font-mono">{t("budgetSpent", { spent: formatUsd(summary.spentUsd), cap: formatUsd(summary.maxCostUsd) })}</p>}
      <div className="my-4 grid gap-4 md:grid-cols-3">
        <section><h3 className="mb-2 font-semibold">{t("budgetCompleted")}</h3>{workList(workSummary.completed)}</section>
        <section><h3 className="mb-2 font-semibold">{t("budgetInterrupted")}</h3>{workList([workSummary.interrupted])}</section>
        <section><h3 className="mb-2 font-semibold">{t("budgetPending")}</h3>{workList(workSummary.pending)}</section>
      </div>
      <details className="mt-4"><summary className="cursor-pointer font-medium">{t("resumeAdvanced")}</summary><p className="mt-2">{t("budgetResume")}</p>
      <pre className="mt-2 overflow-x-auto border bg-background p-3 font-mono text-[11px] text-foreground"><code>{budgetResumeCommand(scan.id, summary ?? { spentUsd: 0, maxCostUsd: (scan.resume?.suggestedMaxCostUsd ?? 200) / 2 } as NonNullable<ScanRun["budgetPartial"]>)}</code></pre></details>
    </> : scan.resume ? <details className="mt-4"><summary className="cursor-pointer">{t("resumeAdvanced")}</summary><pre className="mt-2 overflow-x-auto bg-background p-3"><code>{budgetResumeCommand(scan.id, { spentUsd: 0, maxCostUsd: scan.resume.suggestedMaxCostUsd / 2 } as NonNullable<ScanRun["budgetPartial"]>)}</code></pre></details> : <p className="mt-2">{t("budgetUnavailable")}</p>}
  </AlertBanner>;
}
