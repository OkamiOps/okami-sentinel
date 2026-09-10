import { useEffect, useState } from "react";
import type { ScanRun, ScanCandidatePreview as Preview } from "@csb/shared";
import { useScopedI18n } from "../../i18n/scoped";
import { candidatePreviewMessages } from "../../i18n/candidate-preview";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function ScanCandidatePreview({ scan, expanded }: { scan: ScanRun; expanded: boolean }) {
  const { t, locale } = useScopedI18n(candidatePreviewMessages);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(expanded);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active = scan.status === "running" || scan.status === "queued";
  useEffect(() => { setOpen(expanded); }, [expanded]);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const controller = new AbortController();
    setPreview(null); setError(false); setSelectedId(null);
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch(`/api/scans/${encodeURIComponent(scan.id)}/candidate-preview`, { signal: controller.signal });
        if (!response.ok) throw new Error("preview_unavailable");
        const value = await response.json() as Preview;
        if (!disposed) { setPreview(value); setError(false); }
      } catch { if (!disposed) setError(true); }
      finally { pending = false; }
    };
    void load();
    const timer = active ? window.setInterval(() => void load(), 15_000) : undefined;
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); };
  }, [scan.id, scan.status, retry, active]);
  const candidates = preview?.candidates ?? [];
  const visible = candidates.filter((candidate) => `${candidate.category} ${candidate.hypothesis} ${candidate.anchors.map((anchor) => anchor.path).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const selected = visible.find((candidate) => candidate.id === selectedId) ?? visible[0];
  return <section aria-label={t("title")} className="mb-4 min-w-0 border border-primary/40 bg-card">
    <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-primary px-4 py-3">
      <div className="min-w-0"><div className="font-mono text-[9px] uppercase tracking-wider text-primary">{t("title")}</div><h2 role="status" className="mt-1 text-sm font-semibold">{preview ? t("count", { count: candidates.length }) : t("loading")}</h2></div>
      <Button variant="outline" size="sm" aria-expanded={open} aria-controls={`preview-${scan.id}`} onClick={() => setOpen(!open)}>{t(open ? "hide" : "show")}</Button>
      <p className="w-full text-xs leading-relaxed text-muted-foreground">{t("note")}</p>
      {!active && <p className="text-xs text-chart-3">{t("stopped")}</p>}
    </div>
    {error && <div role="status" className="flex flex-wrap items-center gap-2 border-t p-3 text-xs text-chart-3">{t("error")}<Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>{t("retry")}</Button></div>}
    {open && <div id={`preview-${scan.id}`} className="border-t">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-3"><Input className="w-full md:max-w-lg" aria-label={t("search")} placeholder={t("search")} value={query} onChange={(event) => setQuery(event.target.value)} />{preview && <span className="text-[10px] text-muted-foreground">{t("updated")} {new Date(preview.measuredAt).toLocaleTimeString(locale)}</span>}</div>
      <div className="grid min-w-0 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="max-h-[34rem] min-w-0 overflow-y-auto border-b md:border-b-0 md:border-r">{visible.map((candidate) => <button type="button" key={candidate.id} onClick={() => setSelectedId(candidate.id)} aria-pressed={selected?.id === candidate.id} className={`w-full border-b p-4 text-left focus-visible:outline focus-visible:outline-primary ${selected?.id === candidate.id ? "bg-primary/10 shadow-[inset_2px_0_0_var(--primary)]" : "hover:bg-accent"}`}><div className="mb-2 flex flex-wrap items-center gap-2"><span className="font-mono text-[10px] uppercase text-primary">{candidate.category}</span><span className="border border-chart-3/40 px-1.5 py-0.5 text-[9px] text-chart-3">{t("pending")}</span></div><p className="line-clamp-3 break-words text-xs leading-relaxed">{candidate.hypothesis}</p><p className="mt-2 truncate font-mono text-[10px] text-muted-foreground">{candidate.anchors[0]?.path}</p></button>)}{preview && !visible.length && <p className="p-6 text-xs text-muted-foreground">{t(query ? "noMatch" : active ? "empty" : "unavailable")}</p>}</div>
        <div className="max-h-[42rem] min-w-0 overflow-y-auto p-5">{selected ? <article className="space-y-5 break-words"><div><span className="font-mono text-[10px] uppercase text-primary">{selected.category} · {t("pending")}</span><h3 className="mt-3 text-sm font-medium leading-relaxed">{selected.hypothesis}</h3></div>{selected.expectedImpact && <div><h4 className="mb-2 text-xs font-semibold">{t("impact")}</h4><p className="text-xs leading-relaxed text-muted-foreground">{selected.expectedImpact}</p></div>}{selected.prerequisites && <div><h4 className="mb-2 text-xs font-semibold">{t("prerequisites")}</h4><p className="text-xs leading-relaxed text-muted-foreground">{selected.prerequisites}</p></div>}<div><h4 className="mb-2 text-xs font-semibold">{t("files")}</h4><ul className="space-y-3">{selected.anchors.map((anchor, index) => <li key={`${anchor.path}:${anchor.line}:${index}`} className="border-l border-primary/40 pl-3"><p className="break-all font-mono text-[10px] text-primary">{anchor.path}:{anchor.line}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{anchor.explanation}</p></li>)}</ul></div></article> : <p className="text-xs text-muted-foreground">{t("select")}</p>}</div>
      </div>
    </div>}
  </section>;
}
