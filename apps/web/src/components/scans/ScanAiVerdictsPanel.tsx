import { useEffect, useState } from "react";
import type { AiVerdict, AiVerdictStatus, ScanAiVerdicts, ScanRun } from "@csb/shared";
import { api } from "../../api";
import { useScopedI18n } from "../../i18n/scoped";
import { aiVerdictMessages } from "../../i18n/ai-verdicts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const STATUS_STYLE: Record<AiVerdictStatus, string> = {
  confirmed: "border-destructive/60 text-destructive",
  rejected: "border-chart-2/60 text-chart-2",
  inconclusive: "border-chart-3/60 text-chart-3",
};

function StatusTag({ status, label }: { status: AiVerdictStatus; label: string }) {
  return <span className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${STATUS_STYLE[status]}`}>{label}</span>;
}

export function ScanAiVerdictsPanel({ scan }: { scan: ScanRun }) {
  const { t } = useScopedI18n(aiVerdictMessages);
  const [data, setData] = useState<ScanAiVerdicts | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState<AiVerdictStatus | "">("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    setError(false);
    api.getVerdicts(scan.id)
      .then((value) => { if (!disposed) setData(value); })
      .catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, [scan.id, scan.status, retry]);
  if (data && !data.available) return null;
  const verdicts = data?.verdicts ?? [];
  const needle = query.toLowerCase();
  const visible = verdicts.filter((verdict) => (filter === "" || verdict.status === filter) &&
    `${verdict.candidateId} ${verdict.category} ${verdict.hypothesis} ${verdict.citations.map((c) => c.path).join(" ")}`.toLowerCase().includes(needle));
  const selected: AiVerdict | undefined = visible.find((verdict) => verdict.candidateId === selectedId) ?? visible[0];
  const filters: Array<[AiVerdictStatus | "", string, number]> = [
    ["", t("all"), verdicts.length],
    ["confirmed", t("confirmed"), data?.counts.confirmed ?? 0],
    ["rejected", t("rejected"), data?.counts.rejected ?? 0],
    ["inconclusive", t("inconclusive"), data?.counts.inconclusive ?? 0],
  ];
  return <section aria-label={t("title")} className="mb-4 min-w-0 border border-border bg-card">
    <div className="space-y-2 border-l-2 border-primary px-4 py-3">
      <div className="font-mono text-[9px] uppercase tracking-wider text-primary">{t("title")}</div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("note")}</p>
      {data && <div role="group" className="flex flex-wrap gap-2">{filters.map(([id, label, count]) =>
        <Button key={id || "all"} size="sm" variant={filter === id ? "default" : "outline"} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label} · {count}</Button>)}
        {data.counts.downgraded > 0 && <span className="self-center font-mono text-[10px] text-chart-3">{t("downgraded")}: {data.counts.downgraded}</span>}
      </div>}
      {data && data.counts.legacy > 0 && <p className="text-xs text-chart-3">{t("legacyNote")}</p>}
      {data && !data.snapshotAvailable && <p className="text-xs text-chart-3">{t("snapshotMissing")}</p>}
    </div>
    {error && <div role="status" className="flex flex-wrap items-center gap-2 border-t p-3 text-xs text-chart-3">{t("error")}<Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>{t("retry")}</Button></div>}
    {!data && !error && <p role="status" className="border-t p-3 text-xs text-muted-foreground">{t("loading")}</p>}
    {data && verdicts.length === 0 && <p className="border-t p-3 text-xs text-muted-foreground">{t("empty")}</p>}
    {data && verdicts.length > 0 && <div className="border-t">
      <div className="border-b p-3"><Input className="w-full md:max-w-lg" aria-label={t("search")} placeholder={t("search")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="grid min-w-0 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="max-h-[34rem] min-w-0 overflow-y-auto border-b md:border-b-0 md:border-r">{visible.length === 0 && <p className="p-4 text-xs text-muted-foreground">{t("noMatches")}</p>}{visible.map((verdict) =>
          <button type="button" key={verdict.candidateId} onClick={() => setSelectedId(verdict.candidateId)} aria-pressed={selected?.candidateId === verdict.candidateId}
            className={`w-full border-b p-4 text-left focus-visible:outline focus-visible:outline-primary ${selected?.candidateId === verdict.candidateId ? "bg-primary/10 shadow-[inset_2px_0_0_var(--primary)]" : "hover:bg-accent"}`}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <StatusTag status={verdict.status} label={t(verdict.status)} />
              {verdict.downgraded && <span className="font-mono text-[9px] uppercase text-chart-3">{t("downgraded")}</span>}
              {verdict.legacy && <span className="font-mono text-[9px] uppercase text-muted-foreground">{t("legacy")}</span>}
              <span className="font-mono text-[10px] uppercase text-primary">{verdict.category}</span>
            </div>
            <p className="line-clamp-2 text-xs leading-relaxed">{verdict.hypothesis || verdict.candidateId}</p>
          </button>)}
        </div>
        <div className="max-h-[42rem] min-w-0 overflow-y-auto p-5">{selected && <article className="space-y-5 break-words">
          <div>
            <div className="flex flex-wrap items-center gap-2"><StatusTag status={selected.status} label={t(selected.status)} />
              {selected.downgraded && selected.proposedStatus && <span className="text-[11px] text-muted-foreground">{t("proposed")}: {t(selected.proposedStatus)}</span>}
              {selected.reason && <span className="font-mono text-[10px] text-muted-foreground">{t("reason")}: {selected.reason}</span>}
            </div>
            <h3 className="mt-3 text-sm font-medium leading-relaxed">{selected.hypothesis || selected.candidateId}</h3>
          </div>
          <div><h4 className="mb-2 text-xs font-semibold">{t("claim")}</h4><p className="text-xs leading-relaxed text-muted-foreground">{selected.claim ?? t("noClaim")}</p></div>
          {selected.missingEvidence.length > 0 && <div className="border border-chart-3/50 p-3">
            <h4 className="mb-2 text-xs font-semibold text-chart-3">{t("missing")}</h4>
            <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed">{selected.missingEvidence.map((item, index) =>
              <li key={`${item.code}:${index}`}>{t(`m.${item.code}`, { detail: item.detail ?? "" })}</li>)}</ul>
          </div>}
          <div><h4 className="mb-2 text-xs font-semibold">{t("citations")}</h4>
            {selected.citations.length === 0 ? <p className="text-xs text-muted-foreground">{t("noCitations")}</p> :
              <ol className="space-y-3">{selected.citations.map((citation, index) =>
                <li key={`${citation.path}:${citation.startLine}:${index}`} className={`border ${citation.valid ? "border-border" : "border-chart-3/60"}`}>
                  <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 font-mono text-[10px]">
                    <span className="uppercase text-primary">{citation.role}</span>
                    <span>{citation.path}:{citation.startLine}{citation.endLine !== citation.startLine ? `-${citation.endLine}` : ""}</span>
                    {!citation.valid && <span className="text-chart-3">{t("invalid")} · {t(`p.${citation.problem ?? "file-missing"}`)}</span>}
                  </div>
                  {citation.explanation && <p className="px-3 pt-2 text-xs text-muted-foreground">{citation.explanation}</p>}
                  {citation.excerpt !== undefined && <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed">{citation.excerpt.split("\n").map((line, offset) =>
                    <div key={offset}><span className="mr-3 inline-block w-8 select-none text-right text-muted-foreground">{citation.startLine + offset}</span>{line}</div>)}</pre>}
                </li>)}
              </ol>}
          </div>
        </article>}</div>
      </div>
    </div>}
  </section>;
}
