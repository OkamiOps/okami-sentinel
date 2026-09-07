import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Activity01Icon, Analytics01Icon, ArrowRight01Icon, Menu01Icon, PlusSignIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import type { ScanRun } from "@csb/shared";
import { api } from "./api";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { AlertBanner, LiveDuration, Loading, cx } from "./components/ui";
import { formatDate, formatScanUsd } from "./format";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { useI18n, type TranslationKey } from "./i18n";

const ActivityPage = lazy(() => import("./pages/ActivityPage").then(({ ActivityPage: page }) => ({ default: page })));
const AttackPathPage = lazy(() => import("./pages/AttackPathPage").then(({ AttackPathPage: page }) => ({ default: page })));
const ComparePage = lazy(() => import("./pages/ComparePage").then(({ ComparePage: page }) => ({ default: page })));
const CompareReportPage = lazy(() => import("./pages/CompareReportPage").then(({ CompareReportPage: page }) => ({ default: page })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then(({ DashboardPage: page }) => ({ default: page })));
const GuardrailsPage = lazy(() => import("./pages/GuardrailsPage").then(({ GuardrailsPage: page }) => ({ default: page })));
const GuardrailPolicyPage = lazy(() => import("./pages/GuardrailPolicyPage").then(({ GuardrailPolicyPage: page }) => ({ default: page })));
const GuardrailSetupPage = lazy(() => import("./pages/GuardrailSetupPage").then(({ GuardrailSetupPage: page }) => ({ default: page })));
const NewScanPage = lazy(() => import("./pages/NewScanPage").then(({ NewScanPage: page }) => ({ default: page })));
const ScanDetailPage = lazy(() => import("./pages/ScanDetailPage").then(({ ScanDetailPage: page }) => ({ default: page })));
const ScanReportPage = lazy(() => import("./pages/ScanReportPage").then(({ ScanReportPage: page }) => ({ default: page })));
const ScansPage = lazy(() => import("./pages/ScansPage").then(({ ScansPage: page }) => ({ default: page })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then(({ SettingsPage: page }) => ({ default: page })));
const ConnectionsPage = lazy(() => import("./pages/ConnectionsPage").then(({ ConnectionsPage: page }) => ({ default: page })));

const nav: ReadonlyArray<readonly [string, TranslationKey]> = [["/", "nav.overview"], ["/scans", "nav.runs"], ["/guardrails", "nav.guardrails"], ["/scans/new", "nav.operate"], ["/compare", "nav.compare"], ["/activity", "nav.activity"], ["/settings", "nav.system"]];

function NavStrip({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const { t } = useI18n();
  return <nav className="flex flex-col md:flex-row md:items-stretch">{nav.map(([to, label], index) => {
    const isActive = to === "/scans" ? pathname === "/scans" || (pathname.startsWith("/scans/") && pathname !== "/scans/new") : to === "/guardrails" ? pathname === "/guardrails" || pathname.startsWith("/guardrails/") : to === "/settings" ? pathname === "/settings" || pathname.startsWith("/settings/") : pathname === to;
    return <Link key={to} to={to} aria-current={isActive ? "page" : undefined} onClick={onNavigate} className={cx("group relative flex h-11 items-center gap-3 border-b border-border px-4 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:border-b-0 md:border-r", isActive && "bg-accent text-chart-1")}><span className="text-[8px] opacity-45">0{index + 1}</span>{t(label)}<span className={cx("absolute inset-x-0 bottom-0 h-px bg-chart-1 transition-transform", isActive ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100")} /></Link>;
  })}</nav>;
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [active, setActive] = useState<ScanRun[]>([]);
  const [shellState, setShellState] = useState<"checking" | "ready" | "offline">("checking");
  const [lastActiveUpdate, setLastActiveUpdate] = useState<string | null>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [modulesOpen, setModulesOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [reindexFailed, setReindexFailed] = useState(false);
  const activeRequestRef = useRef(0);
  const loadActive = useCallback(async () => {
    const requestId = ++activeRequestRef.current;
    try {
      const { scans } = await api.listActiveScans();
      if (requestId !== activeRequestRef.current) return;
      setActive(scans.filter((scan) => scan.status === "running"));
      setShellState("ready");
      setLastActiveUpdate(new Date().toISOString());
    } catch {
      if (requestId !== activeRequestRef.current) return;
      setShellState("offline");
    }
  }, []);
  useEffect(() => {
    void loadActive();
    const id = window.setInterval(() => void loadActive(), 4000);
    return () => window.clearInterval(id);
  }, [loadActive]);
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if (!(event.metaKey || event.ctrlKey)) return; if (event.key.toLowerCase() === "k") { event.preventDefault(); setLauncherOpen((open) => !open); } if (event.key === "Enter") { event.preventDefault(); navigate("/scans/new"); } }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); }, [navigate]);
  async function reindex() {
    setSyncing(true);
    setReindexFailed(false);
    try {
      await api.ingest();
      await loadActive();
    } catch {
      setReindexFailed(true);
    } finally {
      setSyncing(false);
    }
  }
  const current = active[0];
  const shellStatus = shellState === "offline"
    ? t("shell.apiOffline")
    : shellState === "checking"
      ? t("shell.engineChecking")
      : current
        ? t("shell.engineLive", { count: active.length })
        : t("shell.engineReady");
  const shellStatusDetail = shellState === "offline"
    ? t("shell.lastUpdated", { date: lastActiveUpdate ? formatDate(lastActiveUpdate) : t("common.unknown") })
    : lastActiveUpdate
      ? t("shell.lastUpdated", { date: formatDate(lastActiveUpdate) })
      : t("shell.noActiveScan");

  if (/^\/scans\/[^/]+\/report$/.test(location.pathname) || location.pathname === "/compare/report") {
    return <Suspense fallback={<Loading />}><Routes><Route path="/scans/:id/report" element={<ScanReportPage />} /><Route path="/compare/report" element={<CompareReportPage />} /></Routes></Suspense>;
  }

  return <div className="min-h-screen overflow-x-hidden pb-24 sm:pb-20">
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-md">
      <div className="flex h-12 items-stretch">
        <Link to="/" className="flex min-w-0 flex-1 items-center gap-2 border-r px-3 sm:min-w-52 sm:flex-none sm:px-4">
          <img src="/brand/okami-sentinel-mark.png" alt="" className="size-7 shrink-0 object-contain" />
          <span className="shrink-0 font-heading text-xs font-bold tracking-[0.12em]">OKAMI</span><span className="hidden font-mono text-[9px] text-muted-foreground sm:inline">/ SENTINEL</span>
        </Link>
        <div className="hidden flex-1 xl:block"><NavStrip /></div>
        <div className="ml-auto flex items-stretch">
          <div className="hidden items-center gap-2 border-l px-4 font-mono text-[9px] text-muted-foreground 2xl:flex" role="status" aria-live="polite" title={shellStatusDetail}><span className={cx("size-1.5 rounded-full", shellState === "offline" ? "bg-chart-3" : current ? "bg-primary" : "bg-chart-2")} />{shellStatus}</div>
          <ThemeSwitcher />
          <LanguageSwitcher />
          <Button asChild className="h-full border-y-0 border-r-0 px-3 sm:px-4"><Link to="/scans/new"><HugeiconsIcon icon={PlusSignIcon} size={13} />{t("shell.launch")}</Link></Button>
          <Sheet open={modulesOpen} onOpenChange={setModulesOpen}>
            <SheetTrigger asChild><Button variant="ghost" size="icon" className="h-full border-y-0 border-r-0 xl:hidden" aria-label={t("shell.openModules")}><HugeiconsIcon icon={Menu01Icon} size={16} /></Button></SheetTrigger>
            <SheetContent side="right" className="w-72 border-border bg-background p-0"><SheetTitle className="border-b px-4 py-4 font-mono text-xs">{t("shell.moduleIndex")}</SheetTitle><NavStrip onNavigate={() => setModulesOpen(false)} /></SheetContent>
          </Sheet>
        </div>
      </div>
      <div className="flex h-6 min-w-0 items-center justify-end border-t border-border/60 px-4 font-mono text-[8px] uppercase tracking-[0.13em] text-muted-foreground sm:justify-between">
        <span className="hidden shrink-0 sm:inline">{t("shell.benchmark")}</span>
        <span className="min-w-0 truncate text-right">{location.pathname === "/" ? "/overview" : location.pathname}</span>
      </div>
    </header>

    <main className="mx-auto w-full max-w-[112rem] px-3 py-5 sm:px-5 lg:px-7">
      {reindexFailed && <AlertBanner>
        {t("settings.reindexError")}
        <Button type="button" variant="outline" size="sm" disabled={syncing} onClick={() => void reindex()}>{t("common.retry")}</Button>
      </AlertBanner>}
      <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/scans" element={<ScansPage />} />
        <Route path="/scans/new" element={<NewScanPage />} />
        <Route path="/guardrails" element={<GuardrailsPage />} />
        <Route path="/guardrails/setup" element={<GuardrailSetupPage />} />
        <Route path="/guardrails/repositories/:repositoryKey/policy" element={<GuardrailPolicyPage />} />
        <Route path="/guardrails/:gateId" element={<GuardrailsPage />} />
        <Route path="/scans/:id/findings/:findingId/path" element={<AttackPathPage />} />
        <Route path="/scans/:id" element={<ScanDetailPage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/connections" element={<ConnectionsPage />} />
      </Routes>
      </Suspense>
    </main>

    <CommandDock current={current} shellState={shellState} shellStatus={shellStatus} shellStatusDetail={shellStatusDetail} open={launcherOpen} onOpenChange={setLauncherOpen} syncing={syncing} onReindex={() => void reindex()} onNavigate={navigate} />
  </div>;
}

function CommandDock({ current, shellState, shellStatus, shellStatusDetail, open, onOpenChange, syncing, onReindex, onNavigate }: { current?: ScanRun; shellState: "checking" | "ready" | "offline"; shellStatus: string; shellStatusDetail: string; open: boolean; onOpenChange: (open: boolean) => void; syncing: boolean; onReindex: () => void; onNavigate: (to: string) => void }) {
  const { t } = useI18n();
  return <div className="fixed inset-x-0 bottom-3 z-40 mx-auto w-[calc(100%-1.5rem)] max-w-5xl border border-border bg-[var(--surface-overlay)] shadow-[0_18px_60px_rgba(0,0,0,.25)] dark:shadow-[0_18px_60px_rgba(0,0,0,.55)] backdrop-blur-md">
      <div className="flex h-12 items-stretch">
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild><button type="button" className="group flex shrink-0 items-center gap-2 border-r border-chart-4/30 px-3 font-mono text-[9px] uppercase tracking-wider text-chart-4 transition hover:bg-chart-4/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-chart-4" aria-label={t("shell.openQuickActions")}><span>{t("shell.actions")}</span><span className="hidden border border-chart-4/25 px-1 py-0.5 text-[7px] text-muted-foreground sm:inline">⌘K</span></button></DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-72 rounded-none border border-chart-4/35 bg-popover p-1.5 shadow-[0_18px_60px_rgba(0,0,0,.35)] dark:shadow-[0_18px_60px_rgba(0,0,0,.65)] ring-0">
          <DropdownMenuLabel className="px-2 py-2 font-mono text-[8px] uppercase tracking-[.14em] text-chart-4">{t("shell.quickActions")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DockMenuItem icon={PlusSignIcon} label={t("shell.newScan")} detail={t("shell.openSequencer")} shortcut="⌘↵" onSelect={() => onNavigate("/scans/new")} />
          <DockMenuItem icon={Activity01Icon} label={t("nav.runs")} detail={t("shell.openLedger")} onSelect={() => onNavigate("/scans")} />
          <DockMenuItem icon={Analytics01Icon} label={t("nav.compare")} detail={t("shell.compareChannels")} onSelect={() => onNavigate("/compare")} />
          <DropdownMenuSeparator />
          <DockMenuItem icon={RefreshIcon} label={syncing ? t("shell.reindexing") : t("shell.reindex")} detail={t("shell.refreshBench")} disabled={syncing} onSelect={onReindex} />
        </DropdownMenuContent>
      </DropdownMenu>

      {current ? <Link to={`/scans/${current.id}`} className="flex min-w-0 flex-1 items-center gap-2 px-3 text-xs transition hover:bg-accent" title={shellState === "offline" ? shellStatusDetail : undefined}><span className={cx("shrink-0", shellState === "offline" ? "size-1.5 rounded-full bg-chart-3" : "live-dot text-primary")} /><span className={cx("hidden shrink-0 font-mono text-[8px] uppercase sm:inline", shellState === "offline" ? "text-chart-3" : "text-primary")}>{shellState === "offline" ? t("common.stale") : t("common.live")}</span><span className="min-w-0 flex-1 truncate">{current.displayName}</span><LiveDuration startedAt={current.startedAt} status={current.status} showDot={false} /><span className="hidden font-mono text-[9px] text-primary md:block">{formatScanUsd(current)}</span><HugeiconsIcon icon={ArrowRight01Icon} size={12} className="shrink-0" /></Link> : <div className="flex min-w-0 flex-1 items-center gap-2 px-3" aria-label={`${shellStatus}, ${shellStatusDetail}`}><span className={cx("size-1.5 shrink-0 rounded-full", shellState === "offline" ? "bg-chart-3" : "bg-chart-2")} /><span className={cx("font-mono text-[8px] uppercase tracking-wider", shellState === "offline" ? "text-chart-3" : "text-chart-2")}>{shellStatus}</span><span className="hidden truncate text-[10px] text-muted-foreground sm:block">{shellStatusDetail}</span></div>}

      <DockLink to="/scans" label={t("nav.runs")} icon={Activity01Icon} className="hidden sm:flex" />
      <DockLink to="/compare" label={t("nav.compare")} icon={Analytics01Icon} className="hidden md:flex" />
      <Link to="/scans/new" className="flex shrink-0 items-center gap-2 border-l border-chart-1/30 bg-chart-1 px-3 font-mono text-[9px] font-semibold uppercase tracking-wider text-primary-foreground transition hover:bg-chart-1/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-background"><HugeiconsIcon icon={PlusSignIcon} size={12} /><span className="hidden lg:inline">{t("shell.newScan")}</span><span className="hidden border border-primary-foreground/25 px-1 py-0.5 text-[7px] xl:inline">⌘↵</span></Link>
    </div>
  </div>;
}

function DockMenuItem({ icon, label, detail, shortcut, disabled, onSelect }: { icon: Parameters<typeof HugeiconsIcon>[0]["icon"]; label: string; detail: string; shortcut?: string; disabled?: boolean; onSelect: () => void }) {
  return <DropdownMenuItem disabled={disabled} onSelect={onSelect} className="rounded-none px-2 py-2.5 focus:bg-chart-4/10"><HugeiconsIcon icon={icon} size={13} className="text-chart-4" /><span className="ml-1 min-w-0"><span className="block text-[11px] font-medium">{label}</span><span className="block text-[9px] text-muted-foreground">{detail}</span></span>{shortcut && <DropdownMenuShortcut className="font-mono text-[8px]">{shortcut}</DropdownMenuShortcut>}</DropdownMenuItem>;
}

function DockLink({ to, label, icon, className }: { to: string; label: string; icon: Parameters<typeof HugeiconsIcon>[0]["icon"]; className?: string }) {
  return <Link to={to} className={cx("shrink-0 items-center gap-2 border-l px-3 font-mono text-[8px] uppercase tracking-wider text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring", className)}><HugeiconsIcon icon={icon} size={11} />{label}</Link>;
}
