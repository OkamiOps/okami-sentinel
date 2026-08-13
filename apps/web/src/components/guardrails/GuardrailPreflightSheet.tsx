import { useEffect, useRef, useState } from "react";
import type {
  ConnectionCompatibility,
  GateExecutorKind,
  GateRun,
  GuardrailScanSelection,
  GuardrailPullRequestSummary,
  GuardrailRepository,
  ProviderConnection,
  ProviderModel,
  ScannerCatalogResponse,
  ScannerEngine,
  ScanMode,
} from "@csb/shared";
import {
  Bug,
  Cloud,
  FlaskConical,
  GitBranch,
  GitCompareArrows,
  GitPullRequestArrow,
  HardDrive,
  LockKeyhole,
  ShieldCheck,
  Shield,
  Workflow,
} from "lucide-react";

import { api, type GuardrailTargetPreview } from "../../api";
import {
  initialGuardrailTargetDraft,
  preflightFingerprint,
  reconcileRemotePullRequestDraft,
  targetFromDraft,
  type GuardrailTargetDraft,
} from "../../lib/guardrails-target";
import { AlertBanner } from "../ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ChoiceCard } from "./ChoiceCard";
import { useI18n } from "../../i18n";
import {
  compatibilityReasonKey,
  connectionSelectionFor,
  isProbeOnlyCompatibilityBlock,
  reasoningEffortForCompatibility,
  reconcileReasoningEffort,
  validateConnectionCapability,
} from "../../lib/new-scan-routing";

const ENGINE_ORDER: ScannerEngine[] = ["codex-security", "mantis", "vulnhunter"];

export function GuardrailPreflightSheet({
  repositories,
  initialRepositoryKey,
  open,
  onOpenChange,
  onStarted,
  onError,
}: {
  repositories: GuardrailRepository[];
  initialRepositoryKey?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (gate: GateRun) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const [repositoryKey, setRepositoryKey] = useState(repositories[0]?.repositoryKey ?? "");
  const selected = repositories.find((repository) => repository.repositoryKey === repositoryKey)
    ?? repositories[0]
    ?? null;
  const [draft, setDraft] = useState<GuardrailTargetDraft>(() => selected
    ? initialGuardrailTargetDraft(selected)
    : { kind: "compare", pullRequestNumber: "", baseRef: "main", headRef: "HEAD" });
  const [executor, setExecutor] = useState<GateExecutorKind>(selected?.defaultExecutor ?? "sentinel-managed");
  const [preview, setPreview] = useState<GuardrailTargetPreview | null>(null);
  const [acceptedFingerprint, setAcceptedFingerprint] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pullRequests, setPullRequests] = useState<GuardrailPullRequestSummary[] | null>(null);
  const [pullRequestsError, setPullRequestsError] = useState<string | null>(null);
  const [executorChosenByUser, setExecutorChosenByUser] = useState(false);
  const [managedFallback, setManagedFallback] = useState(false);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const [catalog, setCatalog] = useState<ScannerCatalogResponse | null>(null);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [engine, setEngine] = useState<ScannerEngine>("codex-security");
  const [connectionId, setConnectionId] = useState("");
  const [modelId, setModelId] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [mode, setMode] = useState<ScanMode>("standard");
  const [compatibility, setCompatibility] = useState<ConnectionCompatibility | null>(null);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [providerValidation, setProviderValidation] = useState<"validating" | "ready" | "failed" | "error" | null>(null);
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const capabilityAttemptRef = useRef<string | null>(null);

  const scanner = catalog?.scanners.find((candidate) => candidate.engine === engine) ?? null;
  const connection = connections.find((candidate) => candidate.id === connectionId) ?? null;
  const connectionModels = models.filter((model) => model.connectionId === connectionId);
  const nativeScannerModelIds = new Set(scanner?.models.map((model) => model.id) ?? []);
  const nativeCostModelUnsupported = engine === "codex-security"
    && compatibility?.selectedProfile === "native"
    && modelId !== null
    && !nativeScannerModelIds.has(modelId);
  const connectionSelection = connectionSelectionFor(connection, connectionModels, modelId);
  const reasoning = reasoningEffortForCompatibility(compatibility, effort);
  const capabilityProbeOnlyBlock = isProbeOnlyCompatibilityBlock(compatibility);
  const capabilityProbeKey = connectionSelection !== null && connection !== null
    ? [engine, connectionSelection.connectionId, connectionSelection.modelId ?? "runtime-default", connection.protocol, capabilityRetry].join("|")
    : null;
  const routeReady = executor !== "sentinel-managed" || (
    connectionSelection !== null
    && compatibility?.eligible === true
    && compatibility.connectionId === connectionSelection.connectionId
    && compatibility.modelSelectionMode === connectionSelection.modelSelectionMode
    && compatibility.modelId === connectionSelection.modelId
    && scanner?.modes.includes(mode) === true
    && !nativeCostModelUnsupported
  );
  const scanSelection: GuardrailScanSelection | null = executor === "sentinel-managed" && routeReady && connectionSelection
    ? {
        engine,
        connection: connectionSelection,
        ...(reasoning.kind === "configurable" && reasoning.selected !== null ? { effort: reasoning.selected } : {}),
        mode,
      }
    : null;

  const target = selected ? targetFromDraft(selected, draft) : null;
  const fingerprint = selected && target
    ? `${preflightFingerprint(selected.repositoryKey, executor, target)}:${JSON.stringify(scanSelection)}`
    : null;
  const previewAccepted = preview !== null && fingerprint !== null && fingerprint === acceptedFingerprint;
  const remoteReady = previewAccepted && preview.executorCapability.ready;

  useEffect(() => {
    if (!open) return;
    const repository = repositories.find((item) => item.repositoryKey === initialRepositoryKey)
      ?? repositories.find((item) => item.repositoryKey === repositoryKey)
      ?? repositories[0];
    if (!repository) return;
    setRepositoryKey(repository.repositoryKey);
    setDraft(initialGuardrailTargetDraft(repository));
    setExecutor(repository.defaultExecutor);
    setPreview(null);
    setAcceptedFingerprint(null);
    setIdempotencyKey(null);
    setError(null);
    setExecutorChosenByUser(false);
    setManagedFallback(false);
  }, [open, initialRepositoryKey]);

  useEffect(() => {
    if (!repositoryKey && repositories[0]) setRepositoryKey(repositories[0].repositoryKey);
  }, [repositories, repositoryKey]);

  useEffect(() => {
    if (!open) return;
    void Promise.all([api.scanners(), api.listConnections()]).then(([nextCatalog, nextConnections]) => {
      setCatalog(nextCatalog);
      setConnections(nextConnections);
      setConnectionId((current) => nextConnections.some((item) => item.id === current)
        ? current
        : nextConnections.find((item) => item.status === "ready")?.id ?? nextConnections[0]?.id ?? "");
    }).catch(() => setError(t("newScan.runtimeUnavailable")));
  }, [open, t]);

  useEffect(() => {
    if (!open || connection === null) return;
    let cancelled = false;
    setModels([]);
    setModelId(null);
    if (connection.modelSelectionMode === "runtime-default") return;
    void api.listConnectionModels(connection.id).then((nextModels) => {
      if (cancelled) return;
      setModels(nextModels);
      setModelId(nextModels[0]?.id ?? null);
    }).catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, [open, connection?.id, connection?.modelSelectionMode]);

  useEffect(() => {
    if (!open || connectionSelection === null) {
      setCompatibility(null);
      return;
    }
    let cancelled = false;
    setRoutingBusy(true);
    setCompatibility(null);
    setProviderValidation(null);
    void api.resolveScanCompatibility({
      engine,
      selection: connectionSelection,
      remoteRepositoryConfirmed: true,
      ...(engine === "codex-security" ? { executionProfilePreference: "auto" as const } : {}),
    }).then((result) => { if (!cancelled) setCompatibility(result); })
      .catch(() => { if (!cancelled) setCompatibility(null); })
      .finally(() => { if (!cancelled) setRoutingBusy(false); });
    return () => { cancelled = true; };
  }, [open, engine, connectionSelection?.connectionId, connectionSelection?.modelId, connectionSelection?.modelSelectionMode]);

  useEffect(() => {
    if (
      !open
      || executor !== "sentinel-managed"
      || connectionSelection === null
      || connectionSelection.modelSelectionMode !== "catalog"
      || connectionSelection.modelId === null
      || !capabilityProbeOnlyBlock
      || capabilityProbeKey === null
      || capabilityAttemptRef.current === capabilityProbeKey
    ) return;

    capabilityAttemptRef.current = capabilityProbeKey;
    let cancelled = false;
    setProviderValidation("validating");
    setRoutingBusy(true);
    void validateConnectionCapability(api, {
      engine,
      selection: connectionSelection,
      remoteRepositoryConfirmed: true,
    }).then(({ report, compatibility: refreshed }) => {
      if (cancelled) return;
      setCompatibility(refreshed);
      setProviderValidation(report.status === "passed" && refreshed.eligible ? "ready" : "failed");
    }).catch(() => {
      if (!cancelled) setProviderValidation("error");
    }).finally(() => {
      if (!cancelled) setRoutingBusy(false);
    });
    return () => { cancelled = true; };
  }, [open, executor, engine, connectionSelection?.connectionId, connectionSelection?.modelId, connectionSelection?.modelSelectionMode, capabilityProbeKey, capabilityProbeOnlyBlock]);

  useEffect(() => {
    setEffort((current) => reconcileReasoningEffort(current, compatibility));
  }, [compatibility]);

  useEffect(() => {
    if (scanner !== null && !scanner.modes.includes(mode) && scanner.modes[0]) setMode(scanner.modes[0]);
  }, [scanner, mode]);

  useEffect(() => {
    if (!open || selected?.source !== "github") {
      setPullRequests(null);
      setPullRequestsError(null);
      return;
    }
    let cancelled = false;
    setPullRequests(null);
    setPullRequestsError(null);
    void api.listGuardrailPullRequests(selected.repositoryKey).then(({ pullRequests: openPullRequests }) => {
      if (cancelled) return;
      setPullRequests(openPullRequests);
      setDraft((current) => reconcileRemotePullRequestDraft(
        selected,
        current,
        openPullRequests.map((pullRequest) => pullRequest.number),
      ));
    }).catch(() => {
      if (cancelled) return;
      setPullRequests([]);
      setPullRequestsError(t("guardrails.prLoadError"));
      setDraft((current) => reconcileRemotePullRequestDraft(selected, current, []));
    });
    return () => { cancelled = true; };
  }, [open, selected?.repositoryKey, selected?.source, t]);

  useEffect(() => {
    if (!open || selected?.source !== "github" || !target || !fingerprint || !routeReady) return;
    let cancelled = false;
    setPreviewBusy(true);
    setError(null);
    onError(null);
    void api.previewGuardrailTarget(selected.repositoryKey, {
      target,
      executor,
      ...(scanSelection === null ? {} : { scanSelection }),
    }).then((response) => {
      if (cancelled) return;
      if (
        !response.preview.executorCapability.ready
        && executor === "github-actions"
        && !executorChosenByUser
      ) {
        setManagedFallback(true);
        setExecutor("sentinel-managed");
        setPreview(null);
        setAcceptedFingerprint(null);
        setIdempotencyKey(null);
        return;
      }
      setPreview(response.preview);
      setAcceptedFingerprint(fingerprint);
      setIdempotencyKey(`guardrail:${crypto.randomUUID()}`);
    }).catch((cause) => {
      if (cancelled) return;
      const message = cause instanceof Error ? cause.message : t("guardrails.resolveError");
      setError(message);
      onError(message);
    }).finally(() => {
      if (!cancelled) setPreviewBusy(false);
    });
    return () => { cancelled = true; };
  }, [open, selected?.repositoryKey, selected?.source, fingerprint, executorChosenByUser, previewRefresh, routeReady, t]);

  function invalidatePreview(nextDraft?: GuardrailTargetDraft, nextExecutor?: GateExecutorKind) {
    if (nextDraft) setDraft(nextDraft);
    if (nextExecutor) setExecutor(nextExecutor);
    setPreview(null);
    setAcceptedFingerprint(null);
    setIdempotencyKey(null);
    setError(null);
  }

  function selectRepository(value: string) {
    const repository = repositories.find((item) => item.repositoryKey === value);
    if (!repository) return;
    setRepositoryKey(value);
    setDraft(initialGuardrailTargetDraft(repository));
    setExecutor(repository.defaultExecutor);
    setPreview(null);
    setAcceptedFingerprint(null);
    setIdempotencyKey(null);
    setError(null);
    setExecutorChosenByUser(false);
    setManagedFallback(false);
  }

  function selectExecutor(nextExecutor: GateExecutorKind) {
    setExecutorChosenByUser(true);
    setManagedFallback(false);
    invalidatePreview(undefined, nextExecutor);
  }

  async function start() {
    if (!selected || !target) return;
    if (selected.source === "github" && (!previewAccepted || !preview?.executorCapability.ready)) return;
    setBusy(true);
    setError(null);
    onError(null);
    try {
      const body = {
        repositoryKey: selected.repositoryKey,
        target,
        executor,
        ...(preview ? { previewIdentity: preview.previewIdentity } : {}),
      };
      const response = executor === "github-actions"
        ? await api.dispatchGuardrailActionsGate(
            selected.repositoryKey,
            body,
            idempotencyKey ?? `guardrail:${crypto.randomUUID()}`,
          )
        : await api.startGate(body);
      onOpenChange(false);
      onStarted(response.gate);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("guardrails.startError");
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  const canStart = Boolean(selected && target && routeReady) && (
    selected?.source === "local" || remoteReady
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button className="min-h-11" disabled={repositories.length === 0}>
          <GitPullRequestArrow aria-hidden size={14} />{t("guardrails.preflight")}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 border-border bg-background sm:max-w-4xl">
        <SheetHeader className="border-b pr-14">
          <SheetTitle className="font-heading">{t("guardrails.preflightTitle")}</SheetTitle>
          <SheetDescription>{t("guardrails.preflightDescription")}</SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-5 p-4 pb-8">
            <section aria-labelledby="preflight-authority-title">
              <StepHeading code="01 / AUTHORITY" id="preflight-authority-title" title={t("guardrails.authorityTitle")} />
              <Field label={t("guardrails.repository")} htmlFor="guardrail-preflight-repository">
                <Select value={selected?.repositoryKey ?? ""} onValueChange={selectRepository}>
                  <SelectTrigger id="guardrail-preflight-repository" className="min-h-11 w-full rounded-none"><SelectValue placeholder={t("guardrails.select")} /></SelectTrigger>
                  <SelectContent position="popper" className="rounded-none border-border bg-popover">
                    {repositories.map((repository) => <SelectItem key={repository.repositoryKey} value={repository.repositoryKey} className="min-h-11 rounded-none">{repository.displayName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              {selected && (
                <div className="mt-3 grid gap-3 border bg-secondary/20 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                  <span className="grid size-9 place-items-center border border-primary/50 text-primary">
                    {selected.source === "github" ? <GitBranch aria-hidden size={16} /> : <HardDrive aria-hidden size={16} />}
                  </span>
                  <div className="min-w-0">
                    <div className="bench-label text-primary">{selected.source === "github" ? "GITHUB APP" : "LOCAL WORKSPACE"}</div>
                    <div className="mt-1 break-all font-mono text-[10px]">{selected.source === "github" ? `${selected.remoteOwner}/${selected.remoteName}` : selected.repositoryPath}</div>
                  </div>
                  <span className="font-mono text-[9px] uppercase text-muted-foreground">{selected.defaultBranch}</span>
                </div>
              )}
            </section>

            {selected && (
              <section aria-labelledby="preflight-target-title">
                <StepHeading code="02 / TARGET" id="preflight-target-title" title={selected.source === "github" ? t("guardrails.remoteTarget") : t("guardrails.localTarget")}>
                  {selected.source === "github" ? t("guardrails.remoteTargetHelp") : t("guardrails.localTargetHelp")}
                </StepHeading>

                {selected.source === "github" && (
                  <div className="mb-4 grid gap-2" role="radiogroup" aria-label={t("guardrails.remoteTarget")}>
                    <ChoiceCard checked={draft.kind === "pull_request"} icon={<GitPullRequestArrow aria-hidden size={17} />} title={t("guardrails.pullRequest")} meta="GITHUB RESOLVED" description={t("guardrails.remoteTargetHelp")} onSelect={() => invalidatePreview({ ...draft, kind: "pull_request" })} />
                    <ChoiceCard checked={draft.kind === "protected_branch"} icon={<GitBranch aria-hidden size={17} />} title={t("guardrails.branchSnapshot")} meta="FULL REPOSITORY" description={t("guardrails.branchSnapshotHelp")} onSelect={() => invalidatePreview({ ...draft, kind: "protected_branch", baseRef: selected.defaultBranch })} />
                    <ChoiceCard checked={draft.kind === "compare"} icon={<GitCompareArrows aria-hidden size={17} />} title={t("guardrails.compareRefs")} meta="BASE + HEAD" description={t("guardrails.remoteTargetHelp")} onSelect={() => invalidatePreview({ ...draft, kind: "compare" })} />
                  </div>
                )}

                {selected.source === "github" && draft.kind === "pull_request" ? (
                  <Field label={t("guardrails.prNumber")} htmlFor="guardrail-pr-number" hint={t("guardrails.prNumberHelp")}>
                    {pullRequests === null ? (
                      <div className="grid min-h-14 place-items-center border bg-secondary/20 px-4 text-xs text-muted-foreground">{t("guardrails.prLoading")}</div>
                    ) : pullRequests.length > 0 ? (
                      <Select value={draft.pullRequestNumber} onValueChange={(value) => invalidatePreview({ ...draft, pullRequestNumber: value })}>
                        <SelectTrigger id="guardrail-pr-number" className="min-h-14 w-full rounded-none text-left"><SelectValue /></SelectTrigger>
                        <SelectContent position="popper" className="max-w-[calc(100vw-2rem)] rounded-none border-border bg-popover sm:max-w-2xl">
                          {pullRequests.map((pullRequest) => (
                            <SelectItem key={pullRequest.number} value={String(pullRequest.number)} className="min-h-14 rounded-none py-2">
                              <span className="grid min-w-0 gap-0.5">
                                <span className="truncate text-sm font-medium">#{pullRequest.number} · {pullRequest.title}</span>
                                <span className="truncate font-mono text-[9px] text-muted-foreground">{pullRequest.headRef} → {pullRequest.baseRef} · @{pullRequest.author}{pullRequest.draft ? ` · ${t("guardrails.prDraft")}` : ""}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div id="guardrail-pr-number" className="border border-dashed px-4 py-5 text-xs leading-5 text-muted-foreground">{pullRequestsError ?? t("guardrails.prEmpty")}</div>
                    )}
                  </Field>
                ) : draft.kind === "protected_branch" ? (
                  <Field label={t("guardrails.branchRef")} htmlFor="guardrail-branch-ref" hint={pullRequestsError ?? (pullRequests?.length === 0 ? t("guardrails.branchFallbackHelp") : t("guardrails.branchSnapshotHelp"))}>
                    <Input id="guardrail-branch-ref" className="min-h-11 font-mono" value={draft.baseRef} onChange={(event) => invalidatePreview({ ...draft, baseRef: event.target.value })} />
                  </Field>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("guardrails.baseRef")} htmlFor="guardrail-base-ref" hint={t("guardrails.baseRefHelp")}>
                      <Input id="guardrail-base-ref" className="min-h-11 font-mono" value={draft.baseRef} onChange={(event) => invalidatePreview({ ...draft, baseRef: event.target.value })} />
                    </Field>
                    <Field label={t("guardrails.headRef")} htmlFor="guardrail-head-ref" hint={selected.source === "github" ? t("guardrails.remoteHeadHelp") : t("guardrails.localHeadHelp")}>
                      <Input id="guardrail-head-ref" className="min-h-11 font-mono" value={draft.headRef} onChange={(event) => invalidatePreview({ ...draft, headRef: event.target.value })} />
                    </Field>
                  </div>
                )}
              </section>
            )}

            {selected?.source === "github" && executor === "sentinel-managed" && (
              <section aria-labelledby="preflight-scan-route-title">
                <StepHeading code="03 / SCAN ROUTE" id="preflight-scan-route-title" title={t("newScan.strategy")}>
                  {t("newScan.engineHelp")}
                </StepHeading>
                <div className="grid gap-2" role="radiogroup" aria-label={t("newScan.scannerEngine")}>
                  {ENGINE_ORDER.map((candidate) => {
                    const capability = catalog?.scanners.find((item) => item.engine === candidate);
                    const checked = candidate === engine;
                    const icon = candidate === "codex-security"
                      ? <Shield aria-hidden size={17} />
                      : candidate === "mantis"
                        ? <Bug aria-hidden size={17} />
                        : <FlaskConical aria-hidden size={17} />;
                    return (
                      <ChoiceCard
                        key={candidate}
                        checked={checked}
                        disabled={capability?.enabled === false}
                        icon={icon}
                        title={capability?.name ?? candidate}
                        meta={(capability?.maturity ?? "checking").toUpperCase()}
                        description={t(candidate === "codex-security" ? "newScan.engine.codexDescription" : candidate === "mantis" ? "newScan.engine.mantisDescription" : "newScan.engine.vulnHunterDescription")}
                        onSelect={() => {
                          setEngine(candidate);
                          setCompatibility(null);
                          invalidatePreview();
                        }}
                      />
                    );
                  })}
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <Field label={t("newScan.connectionRoute")} htmlFor="guardrail-scan-connection">
                    <Select value={connectionId} onValueChange={(value) => { setConnectionId(value); invalidatePreview(); }}>
                      <SelectTrigger id="guardrail-scan-connection" className="min-h-11 w-full rounded-none"><SelectValue placeholder={t("newScan.connectionRequired")} /></SelectTrigger>
                      <SelectContent position="popper" className="rounded-none border-border bg-popover">
                        {connections.map((item) => <SelectItem key={item.id} value={item.id} className="min-h-11 rounded-none">{item.name} · {item.display.providerLabel}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label={t("newScan.modelChannel" )} htmlFor="guardrail-scan-model">
                    {connection?.modelSelectionMode === "runtime-default" ? (
                      <div id="guardrail-scan-model" className="grid min-h-11 items-center border px-3 font-mono text-[10px] text-muted-foreground">{t("newScan.providerManagedEffort")}</div>
                    ) : (
                      <Select value={modelId ?? ""} onValueChange={(value) => { setModelId(value); invalidatePreview(); }}>
                        <SelectTrigger id="guardrail-scan-model" className="min-h-11 w-full rounded-none"><SelectValue placeholder={t("newScan.connectionModelRequired")} /></SelectTrigger>
                        <SelectContent position="popper" className="max-w-[calc(100vw-2rem)] rounded-none border-border bg-popover sm:max-w-2xl">
                          {connectionModels.map((model) => <SelectItem key={model.id} value={model.id} className="min-h-11 rounded-none">{model.displayName}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                  </Field>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{t("newScan.reasoningEffort")}</div>
                    <div className="mt-2 grid grid-cols-2 gap-px border bg-border">
                      {reasoning.kind === "provider-managed" ? (
                        <div className="col-span-2 bg-background px-3 py-3 font-mono text-[9px] uppercase text-muted-foreground">{t("newScan.providerManagedEffort")}</div>
                      ) : reasoning.options.map((option) => (
                        <button key={option} type="button" aria-pressed={reasoning.selected === option} onClick={() => { setEffort(option); invalidatePreview(); }} className={`min-h-11 bg-background px-3 font-mono text-[9px] uppercase transition-colors ${reasoning.selected === option ? "text-primary shadow-[inset_0_-2px_var(--primary)]" : "text-muted-foreground hover:text-foreground"}`}>{option}</button>
                      ))}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{t("newScan.scanMode")}</div>
                    <div className="mt-2 grid grid-cols-2 gap-px border bg-border">
                      {["standard", "deep"].map((option) => (
                        <button key={option} type="button" disabled={scanner?.modes.includes(option as ScanMode) === false} aria-pressed={mode === option} onClick={() => { setMode(option as ScanMode); invalidatePreview(); }} className={`min-h-11 bg-background px-3 font-mono text-[9px] uppercase transition-colors disabled:opacity-40 ${mode === option ? "text-primary shadow-[inset_0_-2px_var(--primary)]" : "text-muted-foreground hover:text-foreground"}`}>{option}</button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={`mt-3 grid gap-3 border px-4 py-3 text-xs leading-5 ${routeReady ? "border-chart-2/40 bg-chart-2/[.05] text-chart-2" : "border-destructive/40 bg-destructive/[.05] text-destructive"}`}>
                  <span>
                    {providerValidation === "validating" || routingBusy
                      ? t("newScan.providerValidating")
                      : providerValidation === "failed"
                        ? t("newScan.providerValidationFailed")
                        : providerValidation === "error"
                          ? t("newScan.providerValidationError")
                            : nativeCostModelUnsupported
                              ? t("guardrails.nativeCostModelUnsupported")
                            : routeReady
                            ? `${scanner?.name ?? engine} · ${connection?.name ?? "—"} · ${modelId ?? t("newScan.providerManagedEffort")}`
                            : compatibility === null
                              ? t("newScan.routeUnavailable")
                              : t(compatibilityReasonKey(compatibility.reasons))}
                  </span>
                  {(providerValidation === "failed" || providerValidation === "error") && connectionSelection?.modelSelectionMode === "catalog" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-fit border-current text-current"
                      onClick={() => {
                        capabilityAttemptRef.current = null;
                        setCapabilityRetry((value) => value + 1);
                      }}
                    >
                      {t("connections.operations.probe")}
                    </Button>
                  )}
                </div>
              </section>
            )}

            {selected?.source === "github" && (
              <section aria-labelledby="preflight-executor-title">
                <StepHeading code="04 / EXECUTION PLANE" id="preflight-executor-title" title={t("guardrails.executorTitle")} />
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("guardrails.executorTitle")}>
                  <ChoiceCard checked={executor === "sentinel-managed"} icon={<Cloud aria-hidden size={17} />} title="Sentinel managed" meta="IMMUTABLE SNAPSHOT" description={t("guardrails.managedDescription")} onSelect={() => selectExecutor("sentinel-managed")} />
                  <ChoiceCard checked={executor === "github-actions"} icon={<Workflow aria-hidden size={17} />} title="GitHub Actions" meta="PINNED CALLER" description={t("guardrails.actionsDescription")} onSelect={() => selectExecutor("github-actions")} />
                </div>
                {managedFallback && <div className="mt-3 border border-primary/40 bg-primary/[.06] px-4 py-3 text-xs leading-5 text-muted-foreground"><span className="font-semibold text-primary">Sentinel managed</span> · {t("guardrails.managedFallbackReady")}</div>}
              </section>
            )}

            {selected?.source === "github" && (
              <section aria-labelledby="preflight-proof-title">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <StepHeading code="05 / SERVER PREVIEW" id="preflight-proof-title" title={t("guardrails.previewTitle")}>
                    {t("guardrails.previewDescription")}
                  </StepHeading>
                  <Button type="button" variant="outline" className="min-h-11" disabled={previewBusy || !target} onClick={() => setPreviewRefresh((value) => value + 1)}>
                    <LockKeyhole aria-hidden size={14} />{previewBusy ? t("guardrails.resolving") : previewAccepted ? t("guardrails.resolveAgain") : t("guardrails.resolve")}
                  </Button>
                </div>
                <div aria-live="polite">
                  {error && <AlertBanner>{error}</AlertBanner>}
                  {previewAccepted && preview ? <PreviewReadout preview={preview} /> : (
                    <div className="border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">{t("guardrails.previewEmpty")}</div>
                  )}
                </div>
              </section>
            )}
          </div>
        </ScrollArea>

        <div className="sticky bottom-0 mt-auto grid gap-3 border-t bg-background/95 p-4 backdrop-blur sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="flex min-w-0 items-start gap-2 text-xs leading-5 text-muted-foreground">
            <ShieldCheck aria-hidden size={14} className="mt-0.5 shrink-0 text-primary" />
            <span>{selected?.source === "github"
              ? previewAccepted && preview
                ? `${preview.resolvedTarget.baseSha.slice(0, 12)} → ${preview.resolvedTarget.headSha.slice(0, 12)} · ${preview.executor}`
                : t("guardrails.previewRequired")
              : t("guardrails.localIdentityPending")}</span>
          </div>
          <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={busy || previewBusy || !canStart} onClick={() => void start()}>
            <GitPullRequestArrow aria-hidden size={14} />{busy ? t("guardrails.starting") : executor === "github-actions" ? t("guardrails.dispatch") : t("guardrails.start")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PreviewReadout({ preview }: { preview: GuardrailTargetPreview }) {
  const { t } = useI18n();
  const capability = preview.executorCapability.ready ? "READY" : "BLOCKED";
  return (
    <div className="border">
      <div className="grid sm:grid-cols-2">
        <Readout label={t("guardrails.previewBase")} value={`${preview.resolvedTarget.baseRef}\n${preview.resolvedTarget.baseSha}`} />
        <Readout label={t("guardrails.previewHead")} value={`${preview.resolvedTarget.headRef}\n${preview.resolvedTarget.headSha}`} />
        <Readout label={t("guardrails.previewPolicy")} value={`${preview.policySource} · ${preview.policySha}`} />
        <Readout label={t("guardrails.previewExecutor")} value={`${capability} · ${preview.executorCapability.code}`} tone={preview.executorCapability.ready ? "good" : "risk"} />
        <Readout label={t("guardrails.previewScan")} value={`${preview.scanPlan.engine ?? "codex-security"} · ${preview.scanPlan.model} · ${preview.scanPlan.effort} · ${preview.scanPlan.mode}\n${preview.scanPlan.scopeMode}${preview.scanPlan.scopeMode === "changed" ? ` · ${preview.scanPlan.maxChangedPaths} paths` : ""}`} />
        <Readout label={t("guardrails.previewCost")} value={`≤ USD ${preview.costBudget.maxCostUsd.toFixed(2)}\n${t("guardrails.costInFlight")}`} />
      </div>
      <div className="grid border-t px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div><div className="bench-label">{t("guardrails.publicationOwner")}</div><p className="mt-1 text-xs text-muted-foreground">{preview.publication.eligible ? t("guardrails.publicationEligible", { branch: preview.publication.protectedBranch ?? "—" }) : t("guardrails.publicationIneligible")}</p></div>
        <span className="mt-2 font-mono text-[9px] uppercase text-primary sm:mt-0">{t("guardrails.expires")} {new Date(preview.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </div>
  );
}

function Readout({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "risk" }) {
  return (
    <div className="min-w-0 border-b p-4 sm:border-r sm:[&:nth-child(2n)]:border-r-0">
      <div className="bench-label">{label}</div>
      <div className={`mt-2 whitespace-pre-wrap break-all font-mono text-[10px] leading-5 ${tone === "good" ? "text-chart-2" : tone === "risk" ? "text-destructive" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

function StepHeading({ code, id, title, children }: { code: string; id?: string; title: string; children?: React.ReactNode }) {
  return <div className="mb-3"><div className="bench-label text-primary">{code}</div><h3 id={id} className="mt-1 font-heading text-base font-semibold">{title}</h3>{children && <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{children}</p>}</div>;
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return <div className="min-w-0"><label className="text-sm font-semibold" htmlFor={htmlFor}>{label}</label><div className="mt-2">{children}</div>{hint && <p className="mt-2 text-xs leading-5 text-muted-foreground">{hint}</p>}</div>;
}
