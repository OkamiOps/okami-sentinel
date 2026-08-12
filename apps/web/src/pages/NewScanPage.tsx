import {
  useEffect,
  useMemo,
  useRef,
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
  parsePortableRetryIntent,
  selectionMatchesPortableRetry,
} from "../lib/execution-profile";
import {
  buildConnectionAwareStartRequest,
  canResolveConnectionWithEngine,
  compatibilityReasonKey,
  connectionSelectionFor,
  isProbeOnlyCompatibilityBlock,
  loadLiveConnectionModels,
  reasoningEffortPanelClass,
  reasoningEffortViewportClass,
  reasoningEffortGridClass,
  reasoningEffortOptionClass,
  parseCostCeiling,
  reasoningEffortForCompatibility,
  reconcileReasoningEffort,
  validateConnectionCapability,
} from "../lib/new-scan-routing";
import {
  connectionReasoningDelivery,
  reasoningDeliveryCopy,
} from "../lib/reasoning-delivery";

const PREFS = "csb-bench-launch-v2";
const scannerOrder: ScannerEngine[] = ["codex-security", "mantis", "vulnhunter"];

type Saved = {
  repositoryPath?: string;
  engine?: ScannerEngine;
  connectionId?: string;
  modelSelectionMode?: "catalog" | "runtime-default";
  modelId?: string | null;
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
  const retry = parsePortableRetryIntent(params);
  if (params.has("from")) {
    return retry === null ? {} : {
      repositoryPath: retry.repositoryPath,
      engine: retry.engine,
      connectionId: retry.connectionId,
      modelSelectionMode: retry.modelSelectionMode,
      modelId: retry.modelId,
      mode: retry.mode,
      paths: retry.paths.join(","),
    };
  }
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
  const retryIntent = useMemo(() => parsePortableRetryIntent(searchParams), [searchParams]);
  const rescanFrom = retryIntent?.from ?? null;
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
  const [providerValidation, setProviderValidation] = useState<"validating" | "ready" | "failed" | "error" | null>(null);
  const [effort, setEffort] = useState<string | null>(initial.effort ?? null);
  const [mode, setMode] = useState<ScanMode>(initial.mode ?? "standard");
  const [maxCostUsd, setMaxCostUsd] = useState(initial.maxCostUsd ?? "1");
  const [unlimited, setUnlimited] = useState(initial.unlimited ?? false);
  const [paths, setPaths] = useState(initial.paths ?? "");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const compatibilityRequestRef = useRef(0);
  const capabilityAttemptRef = useRef<string | null>(null);
  const selectedRouteRef = useRef<string | null>(null);

  const scanners = catalog?.scanners ?? placeholderScanners;
  const scanner = scanners.find((candidate) => candidate.engine === engine) ?? scanners[0];
  const selectedConnection = connections?.find((candidate) => candidate.id === connectionId) ?? null;
  const selectedConnectionModels = useMemo(
    () => selectedConnection === null ? [] : models.filter((model) => model.connectionId === selectedConnection.id),
    [models, selectedConnection],
  );
  const resolvedSelection = useMemo(
    () => connectionSelectionFor(selectedConnection, selectedConnectionModels, selectedModelId),
    [selectedConnection, selectedConnectionModels, selectedModelId],
  );
  const selection = useMemo(
    () => retryIntent === null || selectionMatchesPortableRetry(retryIntent, resolvedSelection)
      ? resolvedSelection
      : null,
    [resolvedSelection, retryIntent],
  );
  const reasoning = useMemo(
    () => reasoningEffortForCompatibility(compatibility, effort),
    [compatibility, effort],
  );
  const reasoningDeliveryCopyValue = reasoningDeliveryCopy(
    connectionReasoningDelivery(selectedConnection, reasoning.selected),
  );
  const engineReady = catalog !== null && scanner !== undefined && canResolveConnectionWithEngine(scanner);
  const modeReady = scanner?.modes.includes(mode) === true;
  const routeReady = engineReady && modeReady && selection !== null && compatibility?.eligible === true &&
    compatibility.connectionId === selection.connectionId &&
    compatibility.modelSelectionMode === selection.modelSelectionMode &&
    compatibility.modelId === selection.modelId;
  const usesCostEnvelope = engine === "codex-security";
  const cost = parseCostCeiling(maxCostUsd) ?? 1;
  const executionProfile = engine === "codex-security" ? compatibility?.selectedProfile ?? null : null;
  const executionProfileLabel = executionProfile === "native"
    ? t("newScan.profile.native")
    : executionProfile === "portable"
      ? t("newScan.profile.portable")
      : t("newScan.profile.pending");
  const executionProfileReason = executionProfile === "native"
    ? t("newScan.profile.nativeReason")
    : executionProfile === "portable"
      ? t("newScan.profile.portableReason")
      : null;
  const executionMethodology = executionProfile === "native"
    ? t("newScan.profile.nativeMethodology")
    : executionProfile === "portable"
      ? t("newScan.profile.portableMethodology")
      : "—";
  const capabilityProbeOnlyBlock = isProbeOnlyCompatibilityBlock(compatibility);
  const capabilityProbeKey = selection !== null && selectedConnection !== null
    ? [selection.connectionId, selection.modelSelectionMode, selection.modelId ?? "runtime-default", selectedConnection.protocol].join("|")
    : null;
  const selectedRouteKey = `${engine}|${capabilityProbeKey ?? "none"}`;
  const reasoningEffortContractKey = compatibility === null
    ? null
    : JSON.stringify([
      compatibility.connectionId,
      compatibility.modelSelectionMode,
      compatibility.modelId,
      compatibility.reasoningEffort ?? null,
    ]);

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
    if (selectedRouteRef.current !== null && selectedRouteRef.current !== selectedRouteKey) {
      setAuthorized(false);
    }
    selectedRouteRef.current = selectedRouteKey;
    capabilityAttemptRef.current = null;
    setProviderValidation(null);
  }, [selectedRouteKey]);

  useEffect(() => {
    if (!catalog || !scanner) return;
    if (retryIntent !== null) return;
    if (!scanner.modes.includes(mode) && scanner.modes[0]) setMode(scanner.modes[0]);
  }, [catalog, mode, retryIntent, scanner]);

  useEffect(() => {
    setEffort((current) => reconcileReasoningEffort(current, compatibility));
  }, [reasoningEffortContractKey]);

  useEffect(() => {
    let active = true;
    setModels([]);
    setModelsError(false);
    const retryModelId = retryIntent !== null && retryIntent.connectionId === selectedConnection?.id
      ? retryIntent.modelId
      : undefined;
    if (selectedConnection === null) {
      setModelsLoading(false);
      setSelectedModelId(retryIntent !== null && retryIntent.connectionId === connectionId ? retryIntent.modelId : null);
      return () => { active = false; };
    }
    if (selectedConnection.modelSelectionMode === "runtime-default") {
      setModelsLoading(false);
      setSelectedModelId(retryModelId ?? null);
      return () => { active = false; };
    }
    setModelsLoading(true);
    setSelectedModelId(retryModelId ?? null);
    void loadLiveConnectionModels(api, selectedConnection.id)
      .then((catalogModels) => {
        if (!active) return;
        setModels(catalogModels);
        setSelectedModelId((current) => retryModelId !== undefined
          ? retryModelId
          : catalogModels.some((model) => model.id === current)
            ? current
            : catalogModels[0]?.id ?? null);
      })
      .catch(() => { if (active) setModelsError(true); })
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [connectionId, retryIntent?.connectionId, retryIntent?.modelId, selectedConnection?.id, selectedConnection?.modelSelectionMode]);

  useEffect(() => {
    let active = true;
    const requestId = ++compatibilityRequestRef.current;
    setCompatibility(null);
    setCompatibilityError(false);
    if (selection === null) {
      setCompatibilityLoading(false);
      return () => { active = false; };
    }
    setCompatibilityLoading(true);
    void api.resolveScanCompatibility({
      engine,
      selection,
      remoteRepositoryConfirmed: authorized,
      ...(engine === "codex-security" ? { executionProfilePreference: "auto" } : {}),
    })
      .then((result) => {
        if (active && compatibilityRequestRef.current === requestId) setCompatibility(result);
      })
      .catch(() => {
        if (active && compatibilityRequestRef.current === requestId) setCompatibilityError(true);
      })
      .finally(() => {
        if (active && compatibilityRequestRef.current === requestId) setCompatibilityLoading(false);
      });
    return () => { active = false; };
  }, [authorized, engine, selection?.connectionId, selection?.modelId, selection?.modelSelectionMode]);

  useEffect(() => {
    if (
      !authorized ||
      selectedConnection === null ||
      selection === null ||
      selection.modelSelectionMode !== "catalog" ||
      selection.modelId === null ||
      !capabilityProbeOnlyBlock ||
      capabilityProbeKey === null ||
      capabilityAttemptRef.current === capabilityProbeKey
    ) return;

    capabilityAttemptRef.current = capabilityProbeKey;
    const requestId = ++compatibilityRequestRef.current;
    setProviderValidation("validating");
    setCompatibilityLoading(true);
    setCompatibilityError(false);
    void validateConnectionCapability(api, {
      engine,
      selection,
      remoteRepositoryConfirmed: true,
    })
      .then(({ report, compatibility: refreshed }) => {
        if (compatibilityRequestRef.current !== requestId) return;
        setCompatibility(refreshed);
        setProviderValidation(report.status === "passed" && refreshed.eligible ? "ready" : "failed");
      })
      .catch(() => {
        if (compatibilityRequestRef.current !== requestId) return;
        setProviderValidation("error");
      })
      .finally(() => {
        if (compatibilityRequestRef.current === requestId) setCompatibilityLoading(false);
      });
  }, [authorized, capabilityProbeKey, capabilityProbeOnlyBlock, engine, selectedConnection, selection]);

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
      parseCostCeiling(maxCostUsd) === null
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
                  <Select value={selectedModelId ?? ""} onValueChange={(next) => { setSelectedModelId(next); setAuthorized(false); }}>
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
                      <div className="col-span-full flex h-14 items-center bg-background px-3 font-mono text-[8px] uppercase text-muted-foreground">
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
                          reasoningEffortOptionClass,
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
                <p className="mt-3 font-mono text-[8px] uppercase leading-relaxed text-muted-foreground">
                  {t(reasoningDeliveryCopyValue.key, reasoningDeliveryCopyValue.variables)}
                </p>
              </div>
              <div className="p-4">
                <div className="bench-label mb-3">{t("newScan.scanMode")}</div>
                <div className="grid grid-cols-2 border border-border">
                  {scanner?.modes.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      aria-pressed={mode === candidate}
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
                {engine === "codex-security" && <>
                  <HugeiconsIcon icon={ArrowRight01Icon} size={11} className="text-muted-foreground" />
                  <span aria-label={`${t("newScan.executionProfile")}: ${executionProfileLabel}`} className="max-w-40 truncate border border-primary/35 bg-primary/[.04] px-2 py-1 text-primary">{executionProfileLabel}</span>
                </>}
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
                    min="0.01"
                    step="0.01"
                    value={maxCostUsd}
                    onChange={(event) => setMaxCostUsd(event.target.value)}
                    disabled={unlimited}
                    className="mt-2 font-mono text-lg"
                  />
                  <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                    {t("newScan.costCeilingDisclosure")}
                  </p>
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

            {engine === "codex-security" && (
              <div className="border-b">
                <div className="grid grid-cols-2 p-4">
                  <Readout
                    label={t("newScan.executionProfile")}
                    value={executionProfileLabel}
                    detail={executionProfile === null ? undefined : `${t("newScan.profile.auto")} · ${compatibility?.profileVersion ?? "—"}`}
                    tone={executionProfile === "native" ? "good" : executionProfile === "portable" ? "signal" : undefined}
                  />
                  <Readout
                    label={t("newScan.profile.methodology")}
                    value={executionMethodology}
                    detail={compatibility?.methodologyRef ?? undefined}
                    wrap
                  />
                </div>
                {executionProfileReason && <p className="border-t px-4 py-3 text-[10px] leading-relaxed text-muted-foreground">{executionProfileReason}</p>}
              </div>
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
                  onCheckedChange={(checked) => {
                    const next = checked === true;
                    if (!next) {
                      capabilityAttemptRef.current = null;
                      compatibilityRequestRef.current += 1;
                      setProviderValidation(null);
                    }
                    setAuthorized(next);
                  }}
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
              {(capabilityProbeOnlyBlock || providerValidation !== null) && (
                <p
                  role={providerValidation === "error" ? "alert" : providerValidation === "validating" ? "status" : undefined}
                  aria-live={providerValidation === "error" ? "assertive" : "polite"}
                  className={cx(
                    "mb-3 border p-2 text-[10px] leading-relaxed",
                    providerValidation === "ready"
                      ? "border-chart-2/30 bg-chart-2/[.04] text-chart-2"
                      : providerValidation === "failed" || providerValidation === "error"
                        ? "border-chart-3/30 bg-chart-3/[.04] text-chart-3"
                        : "border-primary/30 bg-primary/[.04] text-primary",
                  )}
                >
                  {providerValidation === "validating"
                    ? t("newScan.providerValidating")
                    : providerValidation === "ready"
                      ? t("newScan.providerValidationReady")
                      : providerValidation === "failed"
                        ? t("newScan.providerValidationFailed")
                        : providerValidation === "error"
                          ? t("newScan.providerValidationError")
                          : t("newScan.providerValidationHelp")}
                </p>
              )}
              {!compatibilityLoading && selectedConnection !== null && (compatibilityError || (compatibility?.eligible === false && !capabilityProbeOnlyBlock)) && (
                <p className="mb-3 border border-chart-3/30 bg-chart-3/[.04] p-2 text-[10px] leading-relaxed text-chart-3">{compatibilityError ? t("newScan.compatibilityError") : t(compatibilityReasonKey(compatibility?.reasons ?? []))} <Link to="/settings/connections" className="underline underline-offset-4">{t("newScan.manageConnections")}</Link></p>
              )}
              {compatibilityLoading && <p role="status" className="mb-3 border border-dashed p-2 text-[10px] text-muted-foreground">{t("newScan.compatibilityLoading")}</p>}
              <Button
                type="submit"
                size="lg"
                disabled={busy || !authorized || !routeReady}
                className="w-full justify-between"
              >
                {providerValidation === "validating" ? t("newScan.providerValidating") : busy ? t("newScan.starting") : t("newScan.submit")}
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
