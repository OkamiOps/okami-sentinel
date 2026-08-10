import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Bug02Icon,
  Folder01Icon,
  LockIcon,
  SecurityCheckIcon,
  TestTubeIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type {
  EffortLevel,
  FsListResponse,
  HealthResponse,
  ScannerAuthMode,
  ScannerCapability,
  ScannerCatalogResponse,
  ScannerEngine,
  ScanMode,
} from "@csb/shared";
import { api } from "../api";
import { AlertBanner, PageHeader, Panel, Readout, cx } from "../components/ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { formatUsd } from "../format";
import { useI18n, type TranslationKey } from "../i18n";

const PREFS = "csb-bench-launch-v2";
const scannerOrder: ScannerEngine[] = ["codex-security", "mantis", "vulnhunter"];

type Saved = {
  repositoryPath?: string;
  engine?: ScannerEngine;
  authMode?: ScannerAuthMode;
  model?: string;
  effort?: string;
  mode?: ScanMode;
  maxCostUsd?: string;
  unlimited?: boolean;
  paths?: string;
};

const placeholderScanners: ScannerCapability[] = scannerOrder.map((engine) => ({
  engine,
  name:
    engine === "codex-security"
      ? "Codex Security"
      : engine === "mantis"
        ? "Google Mantis"
        : "Capital One VulnHunter",
  enabled: engine !== "vulnhunter",
  available: false,
  maturity: engine === "codex-security" ? "stable" : engine === "mantis" ? "preview" : "experimental",
  reason: null,
  sourceUrl:
    engine === "codex-security"
      ? "https://github.com/openai/codex-security"
      : engine === "mantis"
        ? "https://github.com/google/mantis"
        : "https://github.com/capitalone/vulnhunter",
  authModes: [],
  models: [],
  efforts: [],
  modes: [],
  stageCount: 0,
  writesTarget: false,
  executesGeneratedCode: false,
}));

function saved(): Saved {
  try {
    return JSON.parse(localStorage.getItem(PREFS) ?? "{}") as Saved;
  } catch {
    return {};
  }
}

function isEngine(value: string | null): value is ScannerEngine {
  return scannerOrder.includes(value as ScannerEngine);
}

function isAuthMode(value: string | null): value is ScannerAuthMode {
  return value === "chatgpt" || value === "api-key";
}

function launchInitial(params: URLSearchParams): Saved {
  const stored = saved();
  const engine = params.get("engine");
  const authMode = params.get("authMode");
  const mode = params.get("mode");
  return {
    ...stored,
    repositoryPath: params.get("repositoryPath") || stored.repositoryPath,
    engine: isEngine(engine) ? engine : stored.engine,
    authMode: isAuthMode(authMode) ? authMode : stored.authMode,
    model: params.get("model") || stored.model,
    effort: params.get("effort") || stored.effort,
    mode: mode === "deep" || mode === "standard" ? mode : stored.mode,
    paths: params.get("paths") || stored.paths,
  };
}

const engineDescription: Record<ScannerEngine, TranslationKey> = {
  "codex-security": "newScan.engine.codexDescription",
  mantis: "newScan.engine.mantisDescription",
  vulnhunter: "newScan.engine.vulnHunterDescription",
};

function ScannerGlyph({ engine, size = 18 }: { engine: ScannerEngine; size?: number }) {
  const icon =
    engine === "codex-security"
      ? SecurityCheckIcon
      : engine === "mantis"
        ? Bug02Icon
        : TestTubeIcon;
  return <HugeiconsIcon icon={icon} size={size} />;
}

export function NewScanPage() {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const [searchParams] = useSearchParams();
  const initial = useMemo(() => launchInitial(searchParams), [searchParams]);
  const rescanFrom = searchParams.get("from");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [catalog, setCatalog] = useState<ScannerCatalogResponse | null>(null);
  const [fsState, setFsState] = useState<FsListResponse | null>(null);
  const [repositoryPath, setRepositoryPath] = useState(initial.repositoryPath ?? "");
  const [engine, setEngine] = useState<ScannerEngine>(initial.engine ?? "codex-security");
  const [authMode, setAuthMode] = useState<ScannerAuthMode>(initial.authMode ?? "chatgpt");
  const [model, setModel] = useState(initial.model ?? "gpt-5.6-sol");
  const [effort, setEffort] = useState(initial.effort ?? "high");
  const [mode, setMode] = useState<ScanMode>(initial.mode ?? "standard");
  const [maxCostUsd, setMaxCostUsd] = useState(initial.maxCostUsd ?? "100");
  const [unlimited, setUnlimited] = useState(initial.unlimited ?? false);
  const [paths, setPaths] = useState(initial.paths ?? "");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);

  const scanners = catalog?.scanners ?? placeholderScanners;
  const scanner = scanners.find((candidate) => candidate.engine === engine) ?? scanners[0];
  const auth = scanner?.authModes.find((candidate) => candidate.id === authMode);
  const routeReady = Boolean(scanner?.enabled && scanner.available && auth?.available);
  const usesCostEnvelope = engine === "codex-security";
  const cost = Math.max(100, Number(maxCostUsd) || 100);
  const expected = Math.round(
    cost *
      ({ minimal: 0.16, low: 0.3, medium: 0.55, high: 0.82, xhigh: 1 }[effort] ?? 0.7) *
      (mode === "deep" ? 1.3 : 1),
  );

  useEffect(() => {
    void Promise.all([api.health(), api.scanners()])
      .then(([healthResponse, scannerResponse]) => {
        setHealth(healthResponse);
        setCatalog(scannerResponse);
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : t("newScan.runtimeUnavailable")),
      );
    void api
      .listFs(initial.repositoryPath || undefined)
      .then((response) => {
        setFsState(response);
        setRepositoryPath((current) => current || response.path);
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : t("newScan.folderUnavailable")),
      );
  }, [initial.repositoryPath, t]);

  useEffect(() => {
    localStorage.setItem(
      PREFS,
      JSON.stringify({
        repositoryPath,
        engine,
        authMode,
        model,
        effort,
        mode,
        maxCostUsd,
        unlimited,
        paths,
      }),
    );
  }, [repositoryPath, engine, authMode, model, effort, mode, maxCostUsd, unlimited, paths]);

  useEffect(() => {
    if (!catalog || !scanner) return;
    const nextAuth = scanner.authModes.find((candidate) => candidate.available)?.id;
    if (!scanner.authModes.some((candidate) => candidate.id === authMode && candidate.available) && nextAuth) {
      setAuthMode(nextAuth);
    }
    if (!scanner.models.some((candidate) => candidate.id === model) && scanner.models[0]) {
      setModel(scanner.models[0].id);
    }
    if (!scanner.efforts.includes(effort as EffortLevel) && scanner.efforts[0]) {
      setEffort(scanner.efforts[0]);
    }
    if (!scanner.modes.includes(mode) && scanner.modes[0]) setMode(scanner.modes[0]);
  }, [authMode, catalog, effort, mode, model, scanner]);

  async function open(directory: string) {
    try {
      setFsState(await api.listFs(directory));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("newScan.folderUnavailable"));
    }
  }

  function selectEngine(next: ScannerCapability) {
    if (!next.enabled) return;
    setEngine(next.engine);
    setAuthorized(false);
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setStarted(null);
    if (!repositoryPath.trim()) return setError(t("newScan.selectRepository"));
    if (!routeReady) return setError(t("newScan.routeUnavailable"));
    if (!authorized) return setError(t("newScan.confirmRoute"));
    if (
      usesCostEnvelope &&
      !unlimited &&
      (!Number.isFinite(Number(maxCostUsd)) || Number(maxCostUsd) < 100)
    ) {
      return setError(t("newScan.minimumCost"));
    }
    setBusy(true);
    try {
      const { scan: launched } = await api.startScan({
        repositoryPath: repositoryPath.trim(),
        engine,
        authMode,
        provider: "openai",
        model,
        effort,
        mode,
        maxCostUsd: usesCostEnvelope && !unlimited ? cost : undefined,
        paths: paths.split(",").map((item) => item.trim()).filter(Boolean),
      });
      setStarted(launched.id);
      void api.health().then(setHealth);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("newScan.launchFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        code="03 / OPERATE"
        title={t("newScan.title")}
        description={t("newScan.description")}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/scans">
              <HugeiconsIcon icon={ArrowLeft01Icon} size={12} />
              {t("newScan.back")}
            </Link>
          </Button>
        }
      />
      {(health?.activeScanIds.length ?? 0) > 0 && (
        <AlertBanner tone="warning">
          {t("newScan.activeProcesses", {
            count: health?.activeScanIds.length ?? 0,
            capacity: health?.maxConcurrentScans ?? "—",
          })}
        </AlertBanner>
      )}
      {rescanFrom && (
        <AlertBanner tone="info">
          {t("newScan.reusedManifest")} <span className="font-mono">{rescanFrom.slice(0, 8)}</span>.
        </AlertBanner>
      )}
      {error && <AlertBanner>{error}</AlertBanner>}
      {started && (
        <AlertBanner tone="success">
          {t("newScan.accepted")} {" "}
          <Link to={`/scans/${started}`} className="underline underline-offset-4">
            {t("newScan.openActive")}
          </Link>
          .
        </AlertBanner>
      )}

      <form onSubmit={(event) => void submit(event)}>
        <div className="grid gap-4 2xl:grid-cols-[minmax(18rem,.88fr)_minmax(36rem,1.45fr)_minmax(19rem,.78fr)]">
          <Panel label="STAGE 01 / TARGET" title={t("newScan.target")}>
            <div className="border-b p-4">
              <label className="bench-label" htmlFor="repo">
                {t("newScan.absolutePath")}
              </label>
              <Input
                id="repo"
                value={repositoryPath}
                onChange={(event) => setRepositoryPath(event.target.value)}
                className="mt-2 font-mono text-xs"
                placeholder="/path/to/repository"
              />
            </div>
            <div className="flex items-center justify-between border-b px-4 py-2">
              <span className="truncate font-mono text-[9px] text-muted-foreground">
                FILESYSTEM / {fsState?.path ?? "LOADING"}
              </span>
              {fsState?.parent && (
                <Button type="button" variant="ghost" size="sm" onClick={() => void open(fsState.parent!)}>
                  .. / {t("newScan.parent")}
                </Button>
              )}
            </div>
            <div className="h-[25rem] overflow-auto">
              {fsState?.entries.filter((entry) => entry.isDirectory).map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onDoubleClick={() => void open(entry.path)}
                  onClick={() => setRepositoryPath(entry.path)}
                  className={cx(
                    "grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 border-b px-4 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary",
                    repositoryPath === entry.path && "bg-accent text-primary",
                  )}
                >
                  <HugeiconsIcon icon={Folder01Icon} size={13} />
                  <span className="truncate font-mono text-[10px]">{entry.name}</span>
                  <span className="font-mono text-[8px] text-muted-foreground">
                    {repositoryPath === entry.path ? t("newScan.selected") : t("newScan.select")}
                  </span>
                </button>
              ))}
            </div>
            <div className="border-t p-4">
              <label className="bench-label" htmlFor="paths">
                {t("newScan.scopePaths")}
              </label>
              <Input
                id="paths"
                value={paths}
                onChange={(event) => setPaths(event.target.value)}
                className="mt-2 font-mono text-xs"
                placeholder="src, packages/api"
              />
              <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                {t("newScan.scopeHelp")}
              </p>
            </div>
          </Panel>

          <Panel label="STAGE 02 / ROUTING" title={t("newScan.strategy")}>
            <div className="border-b p-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="bench-label">{t("newScan.scannerEngine")}</div>
                  <p className="mt-2 max-w-xl text-[11px] leading-relaxed text-muted-foreground">
                    {t("newScan.engineHelp")}
                  </p>
                </div>
                <span className="hidden font-mono text-[8px] uppercase text-muted-foreground sm:block">
                  {catalog ? t("newScan.capabilitiesLive") : t("newScan.probing")}
                </span>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                {scanners.map((candidate, index) => {
                  const selected = candidate.engine === engine;
                  const disabled = !candidate.enabled;
                  return (
                    <button
                      key={candidate.engine}
                      type="button"
                      disabled={disabled}
                      aria-pressed={selected}
                      onClick={() => selectEngine(candidate)}
                      className={cx(
                        "relative min-h-44 overflow-hidden border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed",
                        selected
                          ? "border-primary/70 bg-primary/[.055]"
                          : "border-border bg-background hover:border-muted-foreground/40 hover:bg-accent/40",
                        disabled && "opacity-55 grayscale",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span
                          className={cx(
                            "grid size-8 place-items-center border",
                            selected ? "border-primary/50 text-primary" : "border-border text-muted-foreground",
                          )}
                        >
                          <ScannerGlyph engine={candidate.engine} />
                        </span>
                        <span className="font-mono text-[7px] uppercase tracking-[.14em] text-muted-foreground">
                          {String(index + 1).padStart(2, "0")} / {candidate.maturity}
                        </span>
                      </div>
                      <span className="mt-5 block text-sm font-semibold leading-tight">{candidate.name}</span>
                      <span className="mt-2 block text-[10px] leading-relaxed text-muted-foreground">
                        {t(engineDescription[candidate.engine])}
                      </span>
                      <span className="mt-4 flex items-center gap-1.5 font-mono text-[8px] uppercase">
                        <span
                          className={cx(
                            "size-1.5 rounded-full",
                            candidate.available
                              ? "bg-chart-2"
                              : disabled
                                ? "bg-muted-foreground"
                                : "bg-chart-3",
                          )}
                        />
                        {candidate.available
                          ? t("newScan.ready")
                          : disabled
                            ? t("newScan.portQueued")
                            : t("newScan.needsRuntime")}
                      </span>
                      {selected && (
                        <motion.span
                          layoutId="scanner-signal"
                          className="absolute inset-x-0 bottom-0 h-0.5 bg-primary"
                          transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid border-b lg:grid-cols-[.85fr_1.15fr]">
              <div className="border-b p-4 lg:border-b-0 lg:border-r">
                <div className="bench-label mb-3">{t("newScan.authentication")}</div>
                <div className="grid gap-2">
                  {scanner?.authModes.length ? (
                    scanner.authModes.map((candidate) => {
                      const selected = authMode === candidate.id;
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          disabled={!candidate.available}
                          aria-pressed={selected}
                          onClick={() => {
                            setAuthMode(candidate.id);
                            setAuthorized(false);
                          }}
                          className={cx(
                            "flex min-h-14 items-center gap-3 border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-45",
                            selected ? "border-primary/60 bg-primary/[.05]" : "border-border hover:bg-accent",
                          )}
                        >
                          <span className={cx("grid size-7 place-items-center border", selected && "border-primary/50 text-primary")}>
                            {candidate.available ? (
                              <HugeiconsIcon icon={Tick02Icon} size={13} />
                            ) : (
                              <HugeiconsIcon icon={LockIcon} size={12} />
                            )}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-xs font-semibold">
                              {candidate.id === "chatgpt" ? t("newScan.chatgptPlan") : t("newScan.apiKey")}
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-[8px] text-muted-foreground">
                              {candidate.available ? t("newScan.credentialReady") : candidate.reason ?? t("newScan.credentialMissing")}
                            </span>
                          </span>
                        </button>
                      );
                    })
                  ) : (
                    <div className="border border-dashed p-3 text-[10px] leading-relaxed text-muted-foreground">
                      {t("newScan.noCompatibleAuth")}
                    </div>
                  )}
                </div>
              </div>

              <div className="p-4">
                <div className="bench-label mb-3">{t("newScan.modelChannel")}</div>
                <div className="grid grid-cols-2">
                  {scanner?.models.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => setModel(candidate.id)}
                      className={cx(
                        "border px-3 py-4 text-left first:border-r-0 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                        model === candidate.id
                          ? "border-chart-4/55 bg-chart-4/[.035]"
                          : "border-border hover:bg-accent",
                      )}
                    >
                      <span className={cx("block font-mono text-[10px]", model === candidate.id && "text-chart-4")}>
                        {candidate.id}
                      </span>
                      <span className="mt-1 block text-[9px] text-muted-foreground">
                        {candidate.profile === "frontier" ? t("newScan.frontierProfile") : t("newScan.balancedProfile")}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid border-b md:grid-cols-[1.25fr_.75fr]">
              <div className="border-b p-4 md:border-b-0 md:border-r">
                <div className="bench-label mb-3">{t("newScan.reasoningEffort")}</div>
                <div className={cx("grid", (scanner?.efforts.length ?? 0) > 3 ? "grid-cols-5" : "grid-cols-3")}>
                  {scanner?.efforts.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      onClick={() => setEffort(candidate)}
                      className={cx(
                        "h-14 border border-r-0 px-1 font-mono text-[8px] uppercase last:border-r focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                        effort === candidate
                          ? "border-chart-4/60 bg-chart-4/[.06] text-chart-4"
                          : "hover:bg-accent",
                      )}
                    >
                      {candidate}
                    </button>
                  ))}
                </div>
              </div>
              <div className="p-4">
                <div className="bench-label mb-3">{t("newScan.scanMode")}</div>
                <div className="grid grid-cols-2">
                  {scanner?.modes.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      onClick={() => setMode(candidate)}
                      className={cx(
                        "border px-3 py-3 font-mono text-[9px] uppercase first:border-r-0 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                        mode === candidate
                          ? "border-primary bg-primary/8 text-primary"
                          : "border-border hover:bg-accent",
                      )}
                    >
                      {candidate}
                    </button>
                  ))}
                </div>
                {scanner?.modes.length === 1 && (
                  <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">
                    {t("newScan.scanOnlyBoundary")}
                  </p>
                )}
              </div>
            </div>

            <div className="p-4">
              <div className="flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase">
                <span className="border border-primary/50 px-2 py-1 text-primary">{scanner?.name ?? engine}</span>
                <HugeiconsIcon icon={ArrowRight01Icon} size={11} className="text-muted-foreground" />
                <span className="border px-2 py-1">{authMode}</span>
                <HugeiconsIcon icon={ArrowRight01Icon} size={11} className="text-muted-foreground" />
                <span className="border px-2 py-1">{model}</span>
                <span className="ml-auto text-muted-foreground">
                  {paths ? `${paths.split(",").filter(Boolean).length} paths` : t("newScan.fullScope")}
                </span>
              </div>
              {engine === "mantis" && (
                <div className="mt-4 border-l-2 border-chart-3 bg-chart-3/[.045] px-3 py-2">
                  <div className="font-mono text-[8px] uppercase tracking-wider text-chart-3">
                    {t("newScan.mantisBoundary")}
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                    {t("newScan.mantisBoundaryDescription")}
                  </p>
                </div>
              )}
            </div>
          </Panel>

          <Panel className="bench-corners" label="STAGE 03 / AUTHORIZE" title={t("newScan.authorize")}>
            {usesCostEnvelope ? (
              <>
                <div className="grid grid-cols-2 border-b p-4">
                  <Readout label={t("newScan.expected")} value={unlimited ? "OPEN" : formatUsd(expected)} tone="signal" />
                  <Readout label={t("newScan.ceiling")} value={unlimited ? "NONE" : formatUsd(cost)} />
                </div>
                <div className="border-b p-4">
                  <label className="bench-label" htmlFor="cost">
                    {t("newScan.maxCost")}
                  </label>
                  <Input
                    id="cost"
                    type="number"
                    min="100"
                    step="1"
                    value={maxCostUsd}
                    onChange={(event) => setMaxCostUsd(event.target.value)}
                    disabled={unlimited}
                    className="mt-2 font-mono text-lg"
                  />
                  <label htmlFor="unlimited-cost" className="mt-3 flex cursor-pointer items-center gap-3 text-xs text-muted-foreground">
                    <Checkbox
                      id="unlimited-cost"
                      checked={unlimited}
                      onCheckedChange={(checked) => setUnlimited(checked === true)}
                    />
                    {t("newScan.unlimited")}
                  </label>
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 border-b p-4">
                  <Readout label={t("newScan.pipelineStages")} value={scanner?.stageCount ?? 9} tone="signal" />
                  <Readout label={t("newScan.targetState")} value="PINNED" />
                </div>
                <div className="border-b p-4">
                  <div className="bench-label">{t("newScan.planUsage")}</div>
                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                    {t("newScan.planUsageDescription")}
                  </p>
                  <div className="mt-4 grid gap-2 font-mono text-[8px] uppercase text-muted-foreground">
                    <span className="flex items-center justify-between border-b pb-2">
                      <span>{t("newScan.targetWrites")}</span><strong className="text-chart-2">0</strong>
                    </span>
                    <span className="flex items-center justify-between border-b pb-2">
                      <span>{t("newScan.generatedExecution")}</span><strong className="text-chart-2">OFF</strong>
                    </span>
                    <span className="flex items-center justify-between">
                      <span>{t("newScan.authSource")}</span><strong className="text-foreground">CHATGPT</strong>
                    </span>
                  </div>
                </div>
              </>
            )}

            <div className="border-b p-4">
              <div className="bench-label">{t("newScan.requiredConfirmation")}</div>
              <label
                htmlFor="authorize-scan"
                className={cx(
                  "mt-3 flex cursor-pointer items-start gap-3 border p-3 transition-colors",
                  authorized
                    ? "border-primary bg-primary/[.06]"
                    : "border-primary/50 bg-background hover:border-primary hover:bg-accent/40",
                )}
              >
                <Checkbox
                  id="authorize-scan"
                  className="mt-0.5"
                  checked={authorized}
                  onCheckedChange={(checked) => setAuthorized(checked === true)}
                />
                <span>
                  <span className="block text-sm font-semibold">{t("newScan.authorizeExecution")}</span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                    {scanner?.name} / {model} / {effort} · {usesCostEnvelope ? t("newScan.estimatedCost") : t("newScan.planAllowance")}.
                  </span>
                </span>
              </label>
            </div>

            <div className="p-4">
              {!routeReady && scanner?.reason && (
                <p className="mb-3 border border-chart-3/30 bg-chart-3/[.04] p-2 text-[10px] leading-relaxed text-chart-3">
                  {scanner.reason}
                </p>
              )}
              <Button
                type="submit"
                size="lg"
                disabled={busy || !authorized || !routeReady}
                className="w-full justify-between"
              >
                {busy ? t("newScan.starting") : t("newScan.submit")}
                <HugeiconsIcon icon={ArrowRight01Icon} size={13} />
              </Button>
              <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[8px] text-muted-foreground">
                <span className={routeReady ? "text-chart-2" : "text-chart-3"}>
                  {routeReady ? t("newScan.routeReady") : t("newScan.routeBlocked")}
                </span>
                <span>{health?.activeScanIds.length ?? 0}/{health?.maxConcurrentScans ?? "—"} ACTIVE</span>
              </div>
            </div>
          </Panel>
        </div>
      </form>
    </div>
  );
}
