import { fileGroup, graphColors } from "../../lib/file-graph";
import { FileGraphCanvas } from "./FileGraphCanvas";
import { useEffect, useMemo, useState } from "react";
import type { ScanRun } from "@csb/shared";
import { api, type ScanFilesGraph } from "../../api";
import { useI18n } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { filesCopy } from "./files-copy";


export function ScanFilesGraphPanel({ scan }: { scan: ScanRun }) {
  const { locale } = useI18n(); const c = filesCopy[locale];
  const [data, setData] = useState<ScanFilesGraph | null>(null);
  const [error, setError] = useState(false); const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState(""); const [selected, setSelected] = useState("");
  useEffect(() => {
    let disposed = false;
    const load = async () => { try { const result = await api.getFilesGraph(scan.id); if (!disposed) { setData(previous => JSON.stringify(previous) === JSON.stringify(result) ? previous : result); setError(false); } } catch { if (!disposed) setError(true); } };
    void load(); const timer = scan.status === "running" ? window.setInterval(() => void load(), 15000) : undefined;
    return () => { disposed = true; window.clearInterval(timer); };
  }, [scan.id, scan.status, retry]);
  const degree = useMemo(() => { const map = new Map<string, number>(); for (const e of data?.edges ?? []) { map.set(e.source, (map.get(e.source) ?? 0) + 1); map.set(e.target, (map.get(e.target) ?? 0) + 1); } return map; }, [data]);
  const files = useMemo(() => [...(data?.files ?? [])].sort((a,b) => (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0) || a.path.localeCompare(b.path)), [data, degree]);
  const path = selected;
  const neighbors = useMemo(() => {
    const map = new Map<string, { path: string; incoming: number; outgoing: number }>();
    for (const e of data?.edges ?? []) { const target = e.source === path ? e.target : e.target === path ? e.source : null; if (!target) continue; const n = map.get(target) ?? { path: target, incoming: 0, outgoing: 0 }; if (e.source === path) n.outgoing += e.count; else n.incoming += e.count; map.set(target,n); }
    return [...map.values()].sort((a,b) => (b.incoming+b.outgoing)-(a.incoming+a.outgoing) || a.path.localeCompare(b.path));
  }, [data,path]);

  const filtered = files.filter(f => f.path.toLowerCase().includes(query.toLowerCase()));
  const choose = (value:string) => { setSelected(value); };
  if (error && !data) return <div className="border p-6" role="alert"><p>{c.error}</p><Button className="mt-3" onClick={() => { setError(false); setRetry(x=>x+1); }}>{c.retry}</Button></div>;
  if (!data) return <div className="border p-8 text-muted-foreground" role="status">{c.loading}</div>;
  if (data.status !== "ready") return <section className="border bg-card p-8"><h2 className="font-semibold">{c.title}</h2><p className="mt-3 max-w-2xl text-sm text-muted-foreground">{c.unavailable}</p><Button variant="outline" className="mt-4" onClick={() => setRetry(x=>x+1)}>{c.retry}</Button></section>;
  return <section className="border bg-card">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b p-4"><div><h2 className="font-semibold">{c.title}</h2><p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{c.description}</p></div><div className="flex gap-6 font-mono text-xs"><span><b className="block text-xl text-primary">{files.length}</b>{c.files}</span><span><b className="block text-xl text-primary">{data.edges.length}</b>{c.relations}</span></div></header>
    {error && <p role="alert" className="border-b p-3 text-xs text-destructive">{c.error} <Button variant="outline" onClick={() => setRetry(x=>x+1)}>{c.retry}</Button></p>}
    <div className="grid min-w-0 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="min-w-0 border-b lg:border-b-0 lg:border-r"><div className="border-b p-3"><Input value={query} onChange={e=>setQuery(e.target.value)} placeholder={c.search} aria-label={c.search}/><p className="mt-2 font-mono text-[10px] text-muted-foreground">{filtered.length} / {files.length} {c.files}</p></div><div className="max-h-64 overflow-y-auto lg:max-h-[700px]" aria-label={c.files}>{filtered.map(f=><button key={f.path} type="button" aria-pressed={path===f.path} onClick={()=>choose(f.path)} title={f.path} className={`flex w-full items-center gap-2 border-b px-3 py-3 text-left text-xs focus-visible:outline-2 focus-visible:outline-primary ${path===f.path ? "bg-primary/10 text-primary" : "hover:bg-accent"}`}><span className="min-w-0 flex-1 break-all">{f.path}</span><span className="font-mono text-muted-foreground">{degree.get(f.path) ?? 0}</span></button>)}{!filtered.length && <p className="p-4 text-sm text-muted-foreground">{c.empty}</p>}</div></aside>
      <div className="min-w-0"><div className="border-b p-4"><p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{selected ? c.scope : c.all}</p><h3 className="mt-2 break-all font-mono text-sm text-primary">{path || c.select}</h3></div>
        <div aria-label={c.groups} className="flex flex-wrap gap-x-4 gap-y-2 border-b px-4 py-2 text-[10px] text-muted-foreground">{[...new Set(files.map(f=>fileGroup(f.path)))].sort().map((group,i)=><span key={group} className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full" style={{background:graphColors[i%graphColors.length]}}/>{group}</span>)}</div>
        <FileGraphCanvas data={data} selected={selected} query={query} onSelect={choose}/>
        {selected && <div className="border-t"><div className="flex items-center justify-between gap-3 p-3"><span className="text-xs text-muted-foreground">{neighbors.length} {c.related}</span><Button variant="ghost" size="sm" onClick={()=>choose("")}>{c.all}</Button></div><div className="grid max-h-48 overflow-y-auto sm:grid-cols-2">{neighbors.map(n=><button key={n.path} onClick={()=>choose(n.path)} className="border-t p-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"><span className="block break-all font-mono text-xs">{n.path}</span><span className="mt-1 block text-[10px] text-muted-foreground">← {c.incoming}: {n.incoming} · {c.outgoing}: {n.outgoing} →</span></button>)}</div>{!neighbors.length && <p className="p-4 text-xs text-muted-foreground">{c.isolated}</p>}</div>}

      </div>
    </div><footer className="break-all border-t p-3 font-mono text-[9px] text-muted-foreground">{c.snapshot}: {data.snapshot ?? c.unknown}</footer>
  </section>;
}
