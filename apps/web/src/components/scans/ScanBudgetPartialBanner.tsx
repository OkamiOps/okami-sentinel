import type { ScanBudgetWorkItem, ScanRun } from "@csb/shared";
import { formatUsd } from "../../format";
import { scanBudgetMessages } from "../../i18n/scan-budget";
import { useScopedI18n } from "../../i18n/scoped";
import { budgetResumeCommand, isBudgetPartial } from "../../lib/scan-budget";
import { AlertBanner } from "../ui";

export function ScanBudgetPartialBanner({ scan }: { scan: ScanRun }) {
  const { t } = useScopedI18n(scanBudgetMessages);
  if (!isBudgetPartial(scan)) return null;
  const summary = scan.budgetPartial;
  const workList = (items: ScanBudgetWorkItem[]) => items.length ? <ul className="max-h-64 space-y-2 overflow-y-auto">
    {items.map((item, index) => <li key={`${item.stage}:${item.page}:${index}`}>
      <span>{item.stage} / {item.page ?? t("budgetUnplanned")}</span>
      {item.artifactPath && <code className="mt-1 block break-all text-[10px] text-muted-foreground">{item.artifactPath}</code>}
    </li>)}
  </ul> : <p>{t("budgetNone")}</p>;
  return <AlertBanner tone="warning">
    <h2 className="font-heading text-base font-semibold">{t("budgetPartial")}</h2>
    {summary ? <>
      <p className="mt-2 font-mono">{t("budgetSpent", { spent: formatUsd(summary.spentUsd), cap: formatUsd(summary.maxCostUsd) })}</p>
      <div className="my-4 grid gap-4 md:grid-cols-3">
        <section><h3 className="mb-2 font-semibold">{t("budgetCompleted")}</h3>{workList(summary.completed)}</section>
        <section><h3 className="mb-2 font-semibold">{t("budgetInterrupted")}</h3>{workList([summary.interrupted])}</section>
        <section><h3 className="mb-2 font-semibold">{t("budgetPending")}</h3>{workList(summary.pending)}</section>
      </div>
      <p>{t("budgetResume")}</p>
      <pre className="mt-2 overflow-x-auto border bg-background p-3 font-mono text-[11px] text-foreground"><code>{budgetResumeCommand(scan.id, summary)}</code></pre>
    </> : <p className="mt-2">{t("budgetUnavailable")}</p>}
  </AlertBanner>;
}
