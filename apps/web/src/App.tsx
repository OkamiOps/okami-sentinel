import { useCallback, useEffect, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Activity01Icon, Analytics01Icon, ArrowRight01Icon, Menu01Icon, PlusSignIcon, RefreshIcon, SecurityCheckIcon } from "@hugeicons/core-free-icons";
import type { ScanRun } from "@csb/shared";
import { api } from "./api";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { LiveDuration, cx } from "./components/ui";
import { formatUsd } from "./format";
import { ActivityPage } from "./pages/ActivityPage";
import { AttackPathPage } from "./pages/AttackPathPage";
import { ComparePage } from "./pages/ComparePage";
import { DashboardPage } from "./pages/DashboardPage";
import { GuardrailsPage } from "./pages/GuardrailsPage";
import { NewScanPage } from "./pages/NewScanPage";
import { ScanDetailPage } from "./pages/ScanDetailPage";
import { ScansPage } from "./pages/ScansPage";
import { SettingsPage } from "./pages/SettingsPage";

const nav = [["/", "Visão"], ["/scans", "Runs"], ["/guardrails", "Guardrails"], ["/scans/new", "Operar"], ["/compare", "Comparar"], ["/activity", "Atividade"], ["/settings", "Sistema"]] as const;

function NavStrip({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  return <nav className="flex flex-col md:flex-row md:items-stretch">{nav.map(([to, label], index) => {
    const isActive = to === "/scans" ? pathname === "/scans" || (pathname.startsWith("/scans/") && pathname !== "/scans/new") : to === "/guardrails" ? pathname === "/guardrails" || pathname.startsWith("/guardrails/") : pathname === to;
    return <Link key={to} to={to} aria-current={isActive ? "page" : undefined} onClick={onNavigate} className={cx("group relative flex h-11 items-center gap-3 border-b border-border px-4 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:border-b-0 md:border-r", isActive && "bg-accent text-primary")}><span className="text-[8px] opacity-45">0{index + 1}</span>{label}<span className={cx("absolute inset-x-0 bottom-0 h-px bg-primary transition-transform", isActive ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100")} /></Link>;
  })}</nav>;
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [active, setActive] = useState<ScanRun[]>([]);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const loadActive = useCallback(async () => { const { scans } = await api.listScans(); setActive(scans.filter((scan) => scan.status === "running")); }, []);
  useEffect(() => { let dead = false; const load = () => void api.listScans().then(({ scans }) => { if (!dead) setActive(scans.filter((s) => s.status === "running")); }).catch(() => undefined); load(); const id = window.setInterval(load, 4000); return () => { dead = true; window.clearInterval(id); }; }, []);
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if (!(event.metaKey || event.ctrlKey)) return; if (event.key.toLowerCase() === "k") { event.preventDefault(); setLauncherOpen((open) => !open); } if (event.key === "Enter") { event.preventDefault(); navigate("/scans/new"); } }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); }, [navigate]);
  async function reindex() { setSyncing(true); try { await api.ingest(); await loadActive(); } finally { setSyncing(false); } }
  const current = active[0];

  return <div className="min-h-screen overflow-x-hidden pb-20">
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-md">
      <div className="flex h-12 items-stretch">
        <Link to="/" className="flex min-w-52 items-center gap-2 border-r px-4">
          <span className="flex size-6 items-center justify-center border border-primary text-primary"><HugeiconsIcon icon={SecurityCheckIcon} size={13} /></span>
          <span className="font-heading text-xs font-bold tracking-[-0.01em]">CSB</span><span className="font-mono text-[9px] text-muted-foreground">/ LOCAL BENCH</span>
        </Link>
        <div className="hidden flex-1 md:block"><NavStrip /></div>
        <div className="ml-auto flex items-stretch">
          <div className="hidden items-center gap-2 border-l px-4 font-mono text-[9px] text-muted-foreground lg:flex"><span className={cx("size-1.5 rounded-full", current ? "bg-primary" : "bg-chart-2")} />ENGINE {current ? `${active.length} LIVE` : "READY"}</div>
          <Button asChild className="h-full border-y-0 border-r-0 px-4"><Link to="/scans/new"><HugeiconsIcon icon={PlusSignIcon} size={13} />LAUNCH</Link></Button>
          <Sheet>
            <SheetTrigger asChild><Button variant="ghost" size="icon" className="h-full border-y-0 border-r-0 md:hidden" aria-label="Abrir módulos"><HugeiconsIcon icon={Menu01Icon} size={16} /></Button></SheetTrigger>
            <SheetContent side="right" className="w-72 border-border bg-background p-0"><SheetTitle className="border-b px-4 py-4 font-mono text-xs">CSB / MODULE INDEX</SheetTitle><NavStrip /></SheetContent>
          </Sheet>
        </div>
      </div>
      <div className="flex h-6 min-w-0 items-center justify-end border-t border-border/60 px-4 font-mono text-[8px] uppercase tracking-[0.13em] text-muted-foreground sm:justify-between">
        <span className="hidden shrink-0 sm:inline">security benchmark instrumentation</span>
        <span className="min-w-0 truncate text-right">{location.pathname === "/" ? "/overview" : location.pathname}</span>
      </div>
    </header>

    <main className="mx-auto w-full max-w-[112rem] px-3 py-5 sm:px-5 lg:px-7">
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/scans" element={<ScansPage />} />
        <Route path="/scans/new" element={<NewScanPage />} />
        <Route path="/guardrails" element={<GuardrailsPage />} />
        <Route path="/guardrails/:gateId" element={<GuardrailsPage />} />
        <Route path="/scans/:id/findings/:findingId/path" element={<AttackPathPage />} />
        <Route path="/scans/:id" element={<ScanDetailPage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </main>

    <CommandDock current={current} open={launcherOpen} onOpenChange={setLauncherOpen} syncing={syncing} onReindex={() => void reindex()} onNavigate={navigate} />
  </div>;
}

function CommandDock({ current, open, onOpenChange, syncing, onReindex, onNavigate }: { current?: ScanRun; open: boolean; onOpenChange: (open: boolean) => void; syncing: boolean; onReindex: () => void; onNavigate: (to: string) => void }) {
  return <div className="fixed inset-x-0 bottom-3 z-40 mx-auto w-[calc(100%-1.5rem)] max-w-5xl border border-primary/40 bg-[#0e1210]/96 shadow-[0_18px_60px_rgba(0,0,0,.55)] backdrop-blur-md">
    <div className="flex h-12 items-stretch">
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild><button type="button" className="group flex shrink-0 items-center gap-2 border-r border-primary/30 px-3 font-mono text-[9px] uppercase tracking-wider text-primary transition hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary" aria-label="Abrir ações rápidas"><span>ações</span><span className="hidden border border-primary/25 px-1 py-0.5 text-[7px] text-muted-foreground sm:inline">⌘K</span></button></DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-72 rounded-none border border-primary/35 bg-[#0e1210] p-1.5 shadow-[0_18px_60px_rgba(0,0,0,.65)] ring-0">
          <DropdownMenuLabel className="px-2 py-2 font-mono text-[8px] uppercase tracking-[.14em] text-primary">Quick actions / local bench</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DockMenuItem icon={PlusSignIcon} label="Novo scan" detail="Abrir launch sequencer" shortcut="⌘↵" onSelect={() => onNavigate("/scans/new")} />
          <DockMenuItem icon={Activity01Icon} label="Runs" detail="Abrir ledger indexado" onSelect={() => onNavigate("/scans")} />
          <DockMenuItem icon={Analytics01Icon} label="Comparar" detail="Montar canais lado a lado" onSelect={() => onNavigate("/compare")} />
          <DropdownMenuSeparator />
          <DockMenuItem icon={RefreshIcon} label={syncing ? "Reindexando…" : "Reindexar evidências"} detail="Atualizar a leitura da bancada" disabled={syncing} onSelect={onReindex} />
        </DropdownMenuContent>
      </DropdownMenu>

      {current ? <Link to={`/scans/${current.id}`} className="flex min-w-0 flex-1 items-center gap-2 px-3 text-xs transition hover:bg-accent"><span className="live-dot shrink-0 text-primary" /><span className="hidden shrink-0 font-mono text-[8px] uppercase text-primary sm:inline">live</span><span className="min-w-0 flex-1 truncate">{current.displayName}</span><LiveDuration startedAt={current.startedAt} status={current.status} showDot={false} /><span className="hidden font-mono text-[9px] text-primary md:block">{formatUsd(current.cost?.estimatedUsd)}</span><HugeiconsIcon icon={ArrowRight01Icon} size={12} className="shrink-0" /></Link> : <div className="flex min-w-0 flex-1 items-center gap-2 px-3" aria-label="Motor pronto, nenhum scan ativo"><span className="size-1.5 shrink-0 rounded-full bg-chart-2" /><span className="font-mono text-[8px] uppercase tracking-wider text-chart-2">engine ready</span><span className="hidden truncate text-[10px] text-muted-foreground sm:block">Nenhum scan consumindo recursos</span></div>}

      <DockLink to="/scans" label="Runs" icon={Activity01Icon} className="hidden sm:flex" />
      <DockLink to="/compare" label="Comparar" icon={Analytics01Icon} className="hidden md:flex" />
      <Link to="/scans/new" className="flex shrink-0 items-center gap-2 border-l border-primary/30 bg-primary px-3 font-mono text-[9px] font-semibold uppercase tracking-wider text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-background"><HugeiconsIcon icon={PlusSignIcon} size={12} /><span className="hidden lg:inline">Novo scan</span><span className="hidden border border-primary-foreground/25 px-1 py-0.5 text-[7px] xl:inline">⌘↵</span></Link>
    </div>
  </div>;
}

function DockMenuItem({ icon, label, detail, shortcut, disabled, onSelect }: { icon: Parameters<typeof HugeiconsIcon>[0]["icon"]; label: string; detail: string; shortcut?: string; disabled?: boolean; onSelect: () => void }) {
  return <DropdownMenuItem disabled={disabled} onSelect={onSelect} className="rounded-none px-2 py-2.5 focus:bg-primary/10"><HugeiconsIcon icon={icon} size={13} className="text-primary" /><span className="ml-1 min-w-0"><span className="block text-[11px] font-medium">{label}</span><span className="block text-[9px] text-muted-foreground">{detail}</span></span>{shortcut && <DropdownMenuShortcut className="font-mono text-[8px]">{shortcut}</DropdownMenuShortcut>}</DropdownMenuItem>;
}

function DockLink({ to, label, icon, className }: { to: string; label: string; icon: Parameters<typeof HugeiconsIcon>[0]["icon"]; className?: string }) {
  return <Link to={to} className={cx("shrink-0 items-center gap-2 border-l px-3 font-mono text-[8px] uppercase tracking-wider text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring", className)}><HugeiconsIcon icon={icon} size={11} />{label}</Link>;
}
