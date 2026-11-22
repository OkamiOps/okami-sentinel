import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { BusinessLogicFlow, BusinessLogicFlowStatus, ScanBusinessLogic, ScanRun } from "@csb/shared";
import { api } from "../../api";
import { formatUsd } from "../../format";
import { useScopedI18n } from "../../i18n/scoped";
import { businessLogicMessages } from "../../i18n/business-logic";
import { Button } from "../ui/button";

const STATUS_STYLE: Record<BusinessLogicFlowStatus, string> = {
  issues: "border-destructive/60 text-destructive",
  "no-issues": "border-chart-2/60 text-chart-2",
  inconclusive: "border-chart-3/60 text-chart-3",
  "skipped-budget": "border-muted-foreground/60 text-muted-foreground",
  failed: "border-muted-foreground/60 text-muted-foreground",
};
const STATUS_KEY = { issues: "issues", "no-issues": "noIssues", inconclusive: "inconclusive", "skipped-budget": "skipped-budget", failed: "failed" } as const;

export function ScanBusinessLogicPanel({ scan }: { scan: ScanRun }) {
  const { t } = useScopedI18n(businessLogicMessages);
  const [data, setData] = useState<ScanBusinessLogic | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    setError(false);
    api.getBusinessLogic(scan.id)
      .then((value) => { if (!disposed) setData(value); })
      .catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, [scan.id, scan.status, retry]);
  if (data && !data.available) return null;
  const usd = (value: number | null) => value === null ? t("unavailable") : formatUsd(value);
  const flows = data?.flows ?? [];
  const selected: BusinessLogicFlow | undefined = flows.find((flow) => flow.id === selectedId) ?? flows.find((flow) => flow.status === "issues") ?? flows[0];
  return <section aria-label={t("title")} className="mb-4 min-w-0 border border-border bg-card">
    <div className="space-y-2 border-l-2 border-primary px-4 py-3">
      <div className="font-mono text-[9px] uppercase tracking-wider text-primary">{t("title")}{data?.source && ` · ${t(data.source === "graphify" ? "graphify" : "codeContext")}`}</div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("note")}</p>
      {data && <p className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
        <span>{t("flows")}: {data.counts.flows}</span>
        <span className="text-destructive">{t("issues")}: {data.counts.issues}</span>
        <span className="text-chart-2">{t("noIssues")}: {data.counts.noIssues}</span>
        <span className="text-chart-3">{t("inconclusive")}: {data.counts.inconclusive}</span>
        {data.counts.skippedBudget > 0 && <span>{t("skipped-budget")}: {data.counts.skippedBudget}</span>}
        {data.counts.failed > 0 && <span>{t("failed")}: {data.counts.failed}</span>}
        <span>{t("spent")}: {usd(data.spentUsd)}{data.budgetUsd !== null && ` / ${t("budget")} ${usd(data.budgetUsd)}`}</span>
        {data.counts.reused > 0 && <span className="text-primary">{t("reused")}: {data.counts.reused} · {t("avoided")} ≈ {usd(data.estimatedCostAvoidedUsd)}</span>}
      </p>}
      {data && !data.snapshotAvailable && <p className="text-xs text-chart-3">{t("snapshotMissing")}</p>}
    </div>
    {error && <div role="status" className="flex flex-wrap items-center gap-2 border-t p-3 text-xs text-chart-3">{t("error")}<Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>{t("retry")}</Button></div>}
    {!data && !error && <p role="status" className="border-t p-3 text-xs text-muted-foreground">{t("loading")}</p>}
    {data && flows.length === 0 && <p className="border-t p-3 text-xs text-muted-foreground">{t("empty")}</p>}
    {data && flows.length > 0 && <div className="grid min-w-0 border-t md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="max-h-[34rem] min-w-0 overflow-y-auto border-b md:border-b-0 md:border-r">{flows.map((flow) =>
        <button type="button" key={flow.id} onClick={() => setSelectedId(flow.id)} aria-pressed={selected?.id === flow.id}
          className={`w-full border-b p-4 text-left focus-visible:outline focus-visible:outline-primary ${selected?.id === flow.id ? "bg-primary/10 shadow-[inset_2px_0_0_var(--primary)]" : "hover:bg-accent"}`}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${STATUS_STYLE[flow.status]}`}>{t(STATUS_KEY[flow.status])}</span>
            {flow.findings.length > 0 && <span className="font-mono text-[10px] text-primary">{flow.findings.length} {t("findings").toLowerCase()}</span>}
            {flow.reusedFrom && <span className="font-mono text-[9px] uppercase text-primary">{t("reused")}</span>}
          </div>
          <p className="truncate font-mono text-[11px]">{flow.entry}</p>
          {flow.summary && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{flow.summary}</p>}
        </button>)}
      </div>
      <div className="max-h-[42rem] min-w-0 overflow-y-auto p-5">{selected && <article className="space-y-5 break-words">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${STATUS_STYLE[selected.status]}`}>{t(STATUS_KEY[selected.status])}</span>
          {selected.reusedFrom && <Link className="border border-primary/50 px-1.5 py-0.5 text-[11px] text-primary underline" to={`/scans/${encodeURIComponent(selected.reusedFrom.scanId)}`}>{t("reused")}</Link>}
          <span className="font-mono text-[11px]">{selected.entry}</span>
        </div>
        {selected.summary && <p className="text-xs leading-relaxed text-muted-foreground">{selected.summary}</p>}
        <div><h4 className="mb-2 text-xs font-semibold">{t("steps")}</h4>
          <ol className="space-y-1 font-mono text-[10px] text-muted-foreground">{selected.steps.map((step, index) =>
            <li key={`${step.path}:${step.startLine}`}>{index + 1}. {step.symbol} · {step.path}:{step.startLine}-{step.endLine}</li>)}</ol></div>
        <div><h4 className="mb-2 text-xs font-semibold">{t("findings")}</h4>
          {selected.findings.length === 0 ? <p className="text-xs text-muted-foreground">{t("noFindings")}</p> :
            <ol className="space-y-4">{selected.findings.map((finding, index) => <li key={index} className="space-y-2 border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] uppercase text-destructive">{finding.severity}</span>
                <span className="font-mono text-[10px] uppercase text-primary">{t(`k.${finding.ruleKind}`)}</span>
                <span className={`font-mono text-[9px] uppercase ${finding.downgraded ? "text-chart-3" : "text-chart-2"}`}>{t(finding.downgraded ? "downgraded" : "confirmed")}</span>
              </div>
              <h5 className="text-sm font-medium">{finding.title}</h5>
              <p className="text-xs leading-relaxed"><span className="font-semibold">{t("claim")}: </span>{finding.claim}</p>
              {finding.impact && <p className="text-xs leading-relaxed text-muted-foreground"><span className="font-semibold">{t("impact")}: </span>{finding.impact}</p>}
              <div className="space-y-2"><h6 className="text-[11px] font-semibold">{t("citations")}</h6>{finding.citations.map((citation, offset) =>
                <div key={`${citation.path}:${citation.startLine}:${offset}`} className={`border ${citation.valid ? "border-border" : "border-chart-3/60"}`}>
                  <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 font-mono text-[10px]">
                    <span className="uppercase text-primary">{citation.role}</span>
                    <span>{citation.path}:{citation.startLine}{citation.endLine !== citation.startLine ? `-${citation.endLine}` : ""}</span>
                    {!citation.valid && <span className="text-chart-3">{t("invalid")}</span>}
                  </div>
                  {citation.explanation && <p className="px-3 pt-2 text-xs text-muted-foreground">{citation.explanation}</p>}
                  {citation.excerpt !== undefined && <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed">{citation.excerpt.split("\n").map((line, n) =>
                    <div key={n}><span className="mr-3 inline-block w-8 select-none text-right text-muted-foreground">{citation.startLine + n}</span>{line}</div>)}</pre>}
                </div>)}</div>
            </li>)}</ol>}
        </div>
        {selected.missingEvidence.length > 0 && <div className="border border-chart-3/50 p-3"><h4 className="mb-2 text-xs font-semibold text-chart-3">{t("missing")}</h4>
          <ul className="list-disc space-y-1 pl-4 text-xs">{selected.missingEvidence.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      </article>}</div>
    </div>}
  </section>;
}
