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
  SecurityCheckIcon,
  TestTubeIcon,
} from "@hugeicons/core-free-icons";
import type {
  ConnectionCompatibility,
  FsListResponse,
  HealthResponse,
  ScannerCapability,
  ScannerCatalogResponse,
  ScannerEngine,
  ScanMode,
  ProviderConnection,
  ProviderModel,
} from "@csb/shared";
import { api } from "../api";
import { AlertBanner, PageHeader, Panel, Readout, cx } from "../components/ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatUsd } from "../format";
import { useI18n, type TranslationKey } from "../i18n";
import {
  buildConnectionAwareStartRequest,
  canResolveConnectionWithEngine,
  connectionSelectionFor,
  defaultReasoningEffortForModel,
  loadLiveConnectionModels,
  reasoningEffortPanelClass,
  reasoningEffortViewportClass,
  reasoningEffortGridClass,
  reasoningEffortForModel,
} from "../lib/new-scan-routing";

const PREFS = "csb-bench-launch-v2";
const scannerOrder: ScannerEngine[] = ["codex-security", "mantis", "vulnhunter"];

type Saved = {
  repositoryPath?: string;
  engine?: ScannerEngine;
  connectionId?: string;
  modelId?: string;
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
  enabled: true,
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

function launchInitial(params: URLSearchParams): Saved {
  const stored = saved();
  const engine = params.get("engine");
  const mode = params.get("mode");
  return {
    ...stored,
    repositoryPath: params.get("repositoryPath") || stored.repositoryPath,
    engine: isEngine(engine) ? engine : stored.engine,
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
  const [connections, setConnections] = useState<ProviderConnection[] | null>(null);
  const [connectionsError, setConnectionsError] = useState(false);
  const [connectionId, setConnectionId] = useState(initial.connectionId ?? "");
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(initial.modelId ?? null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(false);
  const [compatibility, setCompatibility] = useState<ConnectionCompatibility | null>(null);
  const [compatibilityLoading, setCompatibilityLoading] = useState(false);
  const [compatibilityError, setCompatibilityError] = useState(false);
  const [effort, setEffort] = useState<string | null>(initial.effort ?? null);
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
  const selectedConnection = connections?.find((candidate) => candidate.id === connectionId) ?? null;
  const selectedConnectionModels = useMemo(
    () => selectedConnection === null ? [] : models.filter((model) => model.connectionId === selectedConnection.id),
    [models, selectedConnection],
  );
  const selection = useMemo(
    () => connectionSelectionFor(selectedConnection, selectedConnectionModels, selectedModelId),
    [selectedConnection, selectedConnectionModels, selectedModelId],
  );
  const selectedModel = useMemo(
    () => selection?.modelId === null || selection === null
      ? null
      : selectedConnectionModels.find((model) => model.id === selection.modelId) ?? null,
    [selectedConnectionModels, selection],
  );
  const reasoning = useMemo(
    () => reasoningEffortForModel(selectedModel, effort),
    [effort, selectedModel],
  );
  const engineReady = catalog !== null && scanner !== undefined && canResolveConnectionWithEngine(scanner);
  const routeReady = engineReady && selection !== null && compatibility?.eligible === true &&
    compatibility.connectionId === selection.connectionId &&
    compatibility.modelSelectionMode === selection.modelSelectionMode &&
    compatibility.modelId === selection.modelId;
  const usesCostEnvelope = engine === "codex-security";
  const cost = Math.max(100, Number(maxCostUsd) || 100);

  useEffect(() => {
    void Promise.all([api.health(), api.scanners()])
      .then(([healthResponse, scannerResponse]) => {
        setHealth(healthResponse);
        setCatalog(scannerResponse);
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : t("newScan.runtimeUnavailable")),
      );
    void api.listConnections()
      .then(setConnections)
      .catch(() => setConnectionsError(true));
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
        connectionId,
        modelId: selectedModelId,
        effort,
        mode,
        maxCostUsd,
        unlimited,
        paths,
      }),
    );
  }, [repositoryPath, engine, connectionId, selectedModelId, effort, mode, maxCostUsd, unlimited, paths]);

  useEffect(() => {
    if (!catalog || !scanner) return;
    if (!scanner.modes.includes(mode) && scanner.modes[0]) setMode(scanner.modes[0]);
  }, [catalog, mode, scanner]);

  useEffect(() => {
    setEffort(defaultReasoningEffortForModel(selectedModel));
  }, [selectedModel?.id, selectedModel?.reasoningEffort]);

  useEffect(() => {
    let active = true;
    setModels([]);
    setModelsError(false);
    if (selectedConnection === null || selectedConnection.modelSelectionMode === "runtime-default") {
      setModelsLoading(false);
      setSelectedModelId(null);
      return () => { active = false; };
    }
    setModelsLoading(true);
    setSelectedModelId(null);
    void loadLiveConnectionModels(api, selectedConnection.id)
      .then((catalogModels) => {
        if (!active) return;
        setModels(catalogModels);
        setSelectedModelId((current) => catalogModels.some((model) => model.id === current) ? current : catalogModels[0]?.id ?? null);
      })
      .catch(() => { if (active) setModelsError(true); })
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [selectedConnection?.id, selectedConnection?.modelSelectionMode]);

  useEffect(() => {
    let active = true;
    setCompatibility(null);
    setCompatibilityError(false);
    if (selection === null) {
      setCompatibilityLoading(false);
      return () => { active = false; };
    }
    setCompatibilityLoading(true);
    void api.resolveScanCompatibility({ engine, selection, remoteRepositoryConfirmed: authorized })
      .then((result) => { if (active) setCompatibility(result); })
      .catch(() => { if (active) setCompatibilityError(true); })
      .finally(() => { if (active) setCompatibilityLoading(false); });
    return () => { active = false; };
  }, [authorized, engine, selection?.connectionId, selection?.modelId, selection?.modelSelectionMode]);

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
    if (selectedConnection === null) return setError(t("newScan.connectionRequired"));
    if (selection === null) return setError(t("newScan.connectionModelRequired"));
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
      const request = buildConnectionAwareStartRequest({
        repositoryPath: repositoryPath.trim(),
        engine,
        selection,
        compatibility,
        remoteRepositoryConfirmed: authorized,
        effort: reasoning.selected ?? undefined,
        reasoning,
        mode,
        maxCostUsd: usesCostEnvelope && !unlimited ? cost : undefined,
        paths: paths.split(",").map((item) => item.trim()).filter(Boolean),
      });
      if (request === null) throw new Error(t("newScan.routeUnavailable"));
      const { scan: launched } = await api.startScan(request);
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
        <div className="grid gap-4 xl:grid-cols-[minmax(18rem,.88fr)_minmax(36rem,1.45fr)_minmax(19rem,.78fr)]">
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
                            candidate.enabled
                              ? "bg-chart-2"
                              : disabled
                                ? "bg-muted-foreground"
                                : "bg-chart-3",
                          )}
                        />
                        {disabled
                          ? t("newScan.portQueued")
                          : candidate.available
                            ? t("newScan.ready")
                            : t("newScan.connectionCheck")}
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
              <div className="min-w-0 border-b p-4 lg:border-b-0 lg:border-r">
                <div className="bench-label mb-3">{t("newScan.connectionRoute")}</div>
                <p className="mb-3 text-[10px] leading-relaxed text-muted-foreground">{t("newScan.connectionHelp")}</p>
                {connections === null && !connectionsError ? (
                  <div role="status" className="border border-dashed p-3 text-[10px] text-muted-foreground">{t("newScan.connectionLoading")}</div>
                ) : connectionsError ? (
                  <div className="border border-destructive/40 bg-destructive/5 p-3 text-[10px] leading-relaxed text-destructive">{t("newScan.connectionError")}</div>
                ) : connections?.length === 0 ? (
                  <div className="border border-dashed p-3 text-[10px] leading-relaxed text-muted-foreground"><p>{t("newScan.connectionEmpty")}</p><Link to="/settings/connections" className="mt-2 inline-block text-primary underline underline-offset-4">{t("newScan.manageConnections")}</Link></div>
                ) : (
                  <Select value={connectionId} onValueChange={(next) => { setConnectionId(next); setAuthorized(false); setError(null); }}>
                    <SelectTrigger aria-label={t("newScan.selectConnection")} className="w-full min-w-0 max-w-full overflow-hidden *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate"><SelectValue placeholder={t("newScan.selectConnection")} /></SelectTrigger>
                    <SelectContent>{connections?.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.display.routeLabel}</SelectItem>)}</SelectContent>
                  </Select>
                )}
                {selectedConnection && <p className="mt-3 border-l-2 border-primary/50 pl-3 text-[10px] leading-relaxed text-muted-foreground">{selectedConnection.display.providerLabel} · {selectedConnection.display.routeLabel}</p>}
              </div>

              <div className="min-w-0 p-4">
                <div className="bench-label mb-3">{t("newScan.modelChannel")}</div>
                {selectedConnection === null ? (
                  <div className="border border-dashed p-3 text-[10px] leading-relaxed text-muted-foreground">{t("newScan.connectionModelRequired")}</div>
                ) : selectedConnection.modelSelectionMode === "runtime-default" ? (
                  <div className="border border-primary/35 bg-primary/[.04] p-3"><p className="text-xs font-semibold text-primary">{t("newScan.runtimeDefault")}</p><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t("newScan.runtimeDefaultHelp")}</p></div>
                ) : modelsLoading ? (
                  <div role="status" className="border border-dashed p-3 text-[10px] text-muted-foreground">{t("newScan.modelLoading")}</div>
                ) : modelsError ? (
                  <div className="border border-destructive/40 bg-destructive/5 p-3 text-[10px] text-destructive">{t("newScan.modelError")}</div>
                ) : selectedConnectionModels.length === 0 ? (
                  <div className="border border-dashed p-3 text-[10px] leading-relaxed text-muted-foreground"><p>{t("newScan.modelEmpty")}</p><Link to="/settings/connections" className="mt-2 inline-block text-primary underline underline-offset-4">{t("newScan.manageConnections")}</Link></div>
                ) : (
                  <Select value={selectedModelId ?? ""} onValueChange={setSelectedModelId}>
                    <SelectTrigger aria-label={t("newScan.selectModel")} className="w-full min-w-0 max-w-full overflow-hidden *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate"><SelectValue placeholder={t("newScan.selectModel")} /></SelectTrigger>
                    <SelectContent>{selectedConnectionModels.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.displayName ? `${candidate.displayName} · ${candidate.id}` : candidate.id}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              </div>
            </div>

            <div className="grid border-b md:grid-cols-[1.25fr_.75fr]">
              <div className={reasoningEffortPanelClass}>
                <div className="bench-label mb-3">{t("newScan.reasoningEffort")}</div>
                <div className={reasoningEffortViewportClass}>
                  <div className={reasoningEffortGridClass}>
                    {reasoning.options.length === 0 ? (
                      <div className="flex h-14 items-center px-3 font-mono text-[8px] uppercase text-muted-foreground">
                        {t("newScan.providerManagedEffort")}
                      </div>
                    ) : reasoning.options.map((candidate) => (
                      <button
                        key={candidate}
                        type="button"
                        title={candidate}
                        aria-label={candidate}
                        aria-pressed={reasoning.selected === candidate}
                        onClick={() => setEffort(candidate)}
                        className={cx(
                          "relative h-14 w-full min-w-0 truncate border-l border-border px-2 font-mono text-[8px] uppercase first:border-l-0 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                          reasoning.selected === candidate
                            ? "z-10 bg-chart-4/[.06] text-chart-4 after:pointer-events-none after:absolute after:inset-0 after:border after:border-chart-4/60"
                            : "hover:bg-accent",
                        )}
                      >
                        {candidate}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="p-4">
                <div className="bench-label mb-3">{t("newScan.scanMode")}</div>
                <div className="grid grid-cols-2 border border-border">
                  {scanner?.modes.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      onClick={() => setMode(candidate)}
                      className={cx(
                        "relative border-l border-border px-3 py-3 font-mono text-[9px] uppercase first:border-l-0 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                        mode === candidate
                          ? "z-10 bg-primary/8 text-primary after:pointer-events-none after:absolute after:inset-0 after:border after:border-primary"
                          : "hover:bg-accent",
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
                <span className="max-w-40 truncate border px-2 py-1">{selectedConnection?.display.routeLabel ?? t("newScan.connectionRequired")}</span>
                <HugeiconsIcon icon={ArrowRight01Icon} size={11} className="text-muted-foreground" />
                <span className="max-w-40 truncate border px-2 py-1">{selection?.modelId ?? (selection ? t("newScan.runtimeDefault") : "—")}</span>
                <span className="ml-auto text-muted-foreground">
                  {paths ? `${paths.split(",").filter(Boolean).length} paths` : t("newScan.fullScope")}
                </span>
              </div>
              {(engine === "mantis" || engine === "vulnhunter") && (
                <div className="mt-4 border-l-2 border-chart-3 bg-chart-3/[.045] px-3 py-2">
                  <div className="font-mono text-[8px] uppercase tracking-wider text-chart-3">
                    {t(engine === "mantis" ? "newScan.mantisBoundary" : "newScan.vulnHunterBoundary")}
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                    {t(engine === "mantis" ? "newScan.mantisBoundaryDescription" : "newScan.vulnHunterBoundaryDescription")}
                  </p>
                </div>
              )}
            </div>
          </Panel>

          <Panel className="bench-corners" label="STAGE 03 / AUTHORIZE" title={t("newScan.authorize")}>
            {usesCostEnvelope ? (
              <>
                <div className="grid grid-cols-2 border-b p-4">
                  <Readout label={t("newScan.expected")} value={unlimited ? "OPEN" : t("common.unknown").toUpperCase()} tone="signal" />
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
                    {t(engine === "vulnhunter" ? "newScan.vulnHunterPlanUsageDescription" : "newScan.planUsageDescription")}
                  </p>
                  <div className="mt-4 grid gap-2 font-mono text-[8px] uppercase text-muted-foreground">
                    <span className="flex items-center justify-between border-b pb-2">
                      <span>{t("newScan.targetWrites")}</span><strong className="text-chart-2">0</strong>
                    </span>
                    <span className="flex items-center justify-between border-b pb-2">
                      <span>{t("newScan.generatedExecution")}</span><strong className="text-chart-2">OFF</strong>
                    </span>
                    <span className="flex items-center justify-between">
                      <span>{t("newScan.authSource")}</span><strong className="max-w-32 truncate text-foreground">{selectedConnection?.display.providerLabel ?? "—"}</strong>
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
                    {scanner?.name} / {selection?.modelId ?? (selection ? t("newScan.runtimeDefault") : "—")} / {reasoning.selected ?? t("newScan.providerManagedEffort")} · {usesCostEnvelope ? t("newScan.ceiling").toLowerCase() : t("newScan.planAllowance")}.
                  </span>
                </span>
              </label>
            </div>

            <div className="p-4">
              {!engineReady && scanner?.reason && (
                <p className="mb-3 border border-chart-3/30 bg-chart-3/[.04] p-2 text-[10px] leading-relaxed text-chart-3">
                  {scanner.reason}
                </p>
              )}
              {!compatibilityLoading && selectedConnection !== null && (compatibilityError || compatibility?.eligible === false) && (
                <p className="mb-3 border border-chart-3/30 bg-chart-3/[.04] p-2 text-[10px] leading-relaxed text-chart-3">{compatibilityError ? t("newScan.compatibilityError") : t("newScan.compatibilityBlocked")} <Link to="/settings/connections" className="underline underline-offset-4">{t("newScan.manageConnections")}</Link></p>
              )}
              {compatibilityLoading && <p role="status" className="mb-3 border border-dashed p-2 text-[10px] text-muted-foreground">{t("newScan.compatibilityLoading")}</p>}
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
                  {routeReady ? t("newScan.connectionReady") : t("newScan.connectionBlocked")}
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
