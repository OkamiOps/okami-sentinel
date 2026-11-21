import { useEffect, useState } from "react";
import type { ScanCandidateGroups, ScanCandidateGroupVerdictStatus, ScanRun } from "@csb/shared";
import { useScopedI18n } from "../../i18n/scoped";
import { candidateGroupsMessages } from "../../i18n/candidate-groups";
import { Button } from "../ui/button";

const VERDICT_TONE: Record<ScanCandidateGroupVerdictStatus, string> = {
  confirmed: "border-destructive/50 text-destructive",
  rejected: "border-chart-2/50 text-chart-2",
  inconclusive: "border-chart-3/50 text-chart-3",
  pending: "border-border text-muted-foreground",
};

export function ScanCandidateGroupsPanel({ scan }: { scan: ScanRun }) {
  const { t } = useScopedI18n(candidateGroupsMessages);
  const [value, setValue] = useState<ScanCandidateGroups | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setValue(null); setError(false);
    void (async () => {
      try {
        const response = await fetch(`/api/scans/${encodeURIComponent(scan.id)}/candidate-groups`, { signal: controller.signal });
        if (response.status === 401) window.dispatchEvent(new Event("sentinel:unauthorized"));
        if (!response.ok) throw new Error("groups_unavailable");
        setValue(await response.json() as ScanCandidateGroups);
      } catch { if (!controller.signal.aborted) setError(true); }
    })();
    return () => controller.abort();
  }, [scan.id, scan.status, retry]);
  const groups = value?.groups ?? [];
  const heading = !value ? t("loading")
    : !value.recorded ? t("title")
    : value.candidates === null || value.reviewed === null ? t("summaryPending", { groups: groups.length })
    : t("summary", { candidates: value.candidates, reviewed: value.reviewed, groups: groups.length });
  return <section aria-label={t("title")} className="mb-4 min-w-0 border bg-card">
    <div className="border-l-2 border-primary px-4 py-3">
      <div className="font-mono text-[9px] uppercase tracking-wider text-primary">{t("title")}</div>
      <h2 role="status" className="mt-1 text-sm font-semibold">{heading}</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{value && !value.recorded ? t("legacy") : t("note")}</p>
    </div>
    {error && <div role="status" className="flex flex-wrap items-center gap-2 border-t p-3 text-xs text-chart-3">{t("error")}<Button size="sm" variant="outline" onClick={() => setRetry((count) => count + 1)}>{t("retry")}</Button></div>}
    {value?.recorded && !groups.length && <p className="border-t p-4 text-xs text-muted-foreground">{t("none")}</p>}
    {groups.length > 0 && <ul className="divide-y border-t">{groups.map((group) => <li key={group.representativeId} aria-label={`${group.members[0]?.category ?? ""} · ${t("members", { count: group.memberIds.length })}`} className="min-w-0 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase text-primary">{group.members[0]?.category}</span>
        <span className="border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">{t("members", { count: group.memberIds.length })}</span>
        <span className="text-[10px] text-muted-foreground">{t("verdict")}</span>
        <span className={`border px-1.5 py-0.5 text-[10px] font-medium ${VERDICT_TONE[group.verdict.status]}`}>{t(group.verdict.status)}{group.verdict.reason ? ` · ${group.verdict.reason}` : ""}</span>
      </div>
      <ol className="space-y-2">{group.members.map((member) => <li key={member.id} className={`min-w-0 border-l pl-3 ${member.id === group.representativeId ? "border-primary" : "border-border"}`}>
        <div className="flex flex-wrap items-center gap-2"><span className="break-all font-mono text-[10px]">{member.id}</span><span className="text-[9px] uppercase tracking-wider text-muted-foreground">{t(member.id === group.representativeId ? "reviewedByAi" : "inherits")}</span></div>
        <p className="mt-1 break-words text-xs leading-relaxed">{member.hypothesis}</p>
        <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{member.anchors.map((anchor) => `${anchor.path}:${anchor.startLine}${anchor.endLine === anchor.startLine ? "" : `-${anchor.endLine}`} (${anchor.role})`).join(" · ")}</p>
      </li>)}</ol>
    </li>)}</ul>}
  </section>;
}
