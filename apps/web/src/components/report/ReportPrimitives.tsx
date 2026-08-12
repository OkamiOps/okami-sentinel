import type { ReactNode } from "react";

export function ReportSheet({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <article className={`report-sheet relative flex flex-col ${className}`}>
    <div className="report-watermark" aria-hidden="true"><img className="report-watermark-mark" src="/brand/okami-sentinel-mark.png" alt="" /></div>
    {children}
  </article>;
}

export function ReportBrand() {
  return <div className="report-brand flex items-center justify-between border-b border-border pb-5"><div className="flex items-center gap-3"><img src="/brand/okami-sentinel-mark.png" alt="" className="h-11 w-11 object-contain" /><div><div className="font-heading text-sm font-bold tracking-[.18em]">OKAMI</div><div className="font-mono text-[7px] uppercase tracking-[.38em] text-muted-foreground">Sentinel</div></div></div><div className="hidden font-mono text-[8px] uppercase tracking-[.16em] text-primary sm:block">Local security intelligence</div></div>;
}

export function ReportHeader({ section, title, reportId }: { section: string; title: string; reportId: string }) {
  return <header className="report-header"><ReportBrand /><div className="mt-9 flex min-w-0 items-end justify-between gap-6 border-b border-border pb-5"><div className="min-w-0"><Kicker>{section} / Report section</Kicker><h2 className="report-copy mt-2 font-heading text-3xl font-semibold tracking-[-.045em]">{title}</h2></div><span className="report-copy max-w-[13rem] text-right font-mono text-[8px] text-muted-foreground">{reportId}</span></div></header>;
}

export function ReportFooter({ reportId }: { reportId: string }) {
  return <footer className="report-footer mt-auto flex items-center justify-between border-t border-border pt-4 font-mono text-[7px] uppercase tracking-[.14em] text-muted-foreground"><span>{reportId} / confidential</span><span>OKAMI SENTINEL · <span className="report-page-number" /></span></footer>;
}

export function Kicker({ children }: { children: ReactNode }) {
  return <div className="font-mono text-[8px] uppercase tracking-[.18em] text-primary">{children}</div>;
}

export function MetaCell({ label, value }: { label: string; value: ReactNode }) {
  return <div className="min-w-0 border-b border-r border-border p-4"><div className="report-copy font-mono text-[7px] uppercase tracking-[.15em] text-muted-foreground">{label}</div><div className="report-copy mt-2 font-mono text-[10px] leading-5 text-foreground">{value}</div></div>;
}

export function Metric({ label, value, tone = "text-foreground", kind = "number" }: { label: string; value: ReactNode; tone?: string; kind?: "number" | "currency" | "compact" }) {
  return <div className={`report-metric report-metric-${kind} min-w-0 border-b border-r border-border p-4`}><div className="report-metric-label report-copy font-mono text-[7px] uppercase tracking-[.14em] text-muted-foreground">{label}</div><strong className={`report-metric-value report-copy mt-2 block font-mono tabular-nums ${tone}`}>{value}</strong></div>;
}

export function ReportText({ title, children }: { title: string; children: ReactNode }) {
  return <div className="report-keep border border-border p-5"><Kicker>{title}</Kicker><p className="mt-3 text-xs leading-6 text-muted-foreground">{children}</p></div>;
}
