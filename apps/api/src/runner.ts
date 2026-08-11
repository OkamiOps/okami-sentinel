import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type {
  ScanCost,
  ScanEvent,
  ScanProgress,
  ScanRun,
  StartScanRequest,
} from "@csb/shared";
import { emptySeverityCounts } from "@csb/shared";
import {
  CODEX_SECURITY_API_VAULT_TIMEOUT_MS,
  MAX_CONCURRENT_SCANS,
  MANTIS_CACHE_DIR,
  MANTIS_LOCAL_SOURCE_TIMEOUT_MS,
  MANTIS_REPOSITORY_URL,
  MANTIS_SOURCE_REF,
  RUNS_DIR,
  SCANS_ROOT,
} from "./config.js";
import {
  appendCliLog,
  findPidsForScanDir,
  processAlive,
  readCliLogSince,
  readCliLogTail,
  readDetachedActivity,
} from "./activity.js";
import { getRun, upsertRun } from "./db.js";
import { readWorkbenchScan, refreshRunByScanDir } from "./ingest.js";
import {
  isInternalProgressMarker,
  parseCliPhaseHint,
  progressEventMessage,
  progressForStatus,
  withProgress,
} from "./progress.js";
import { validateScannerRequest } from "./scanners/catalog.js";
import {
  prepareCodexSecurityApiLaunch,
  prepareMantisHttpLaunch,
  prepareMantisLocalLaunch,
  preparePortableCodexSecurityLaunch,
  prepareScannerLaunch,
} from "./scanners/launch.js";
import { createSafeMantisProviderPlan } from "./scanners/mantis-http-runner.js";
import type { MantisLocalProviderPlan } from "./scanners/mantis-local-runner.js";
import { resolveMantisLocalSource } from "./scanners/mantis-source.js";
import { ScanSelectionError, resolveScanLaunchSelection } from "./scanners/scan-selection.js";
import type { ScanLaunchPlan } from "./connections/launch-plan.js";
import {
  createSafePortableCodexSecurityProviderPlan,
  PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
  PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
  type SafePortableCodexSecurityProviderPlan,
} from "./scanners/portable-codex-security-profile.js";
import type { SafeVulnHunterProviderPlan } from "./scanners/vulnhunter-runtime.js";
import { isHttpAgentRouteProtocolSupported } from "./agent/http-agent-upstream.js";
import {
  CodexSecurityApiBridgeError,
  isCodexSecurityApiPlan,
  resolveCodexSecurityApiKey,
} from "./scanners/codex-security-api-bridge.js";
import { refreshMantisRunFromDisk } from "./scanners/mantis-reconcile.js";
import { refreshPortableCodexSecurityRunFromDisk } from "./scanners/portable-codex-security-reconcile.js";
import { refreshVulnHunterRunFromDisk } from "./scanners/vulnhunter-reconcile.js";
import { getProviderRuntime, type ProviderRuntime } from "./provider-runtime.js";
import {
  globalSecretRedactor,
  processSecretValues,
  redactText,
} from "./redaction.js";

type Listener = (event: ScanEvent) => void;

interface ActiveScan {
  id: string;
  scanDir: string;
  child: ChildProcess;
  listeners: Set<Listener>;
  logBuffer: ScanEvent[];
  releaseRedactionScope: () => void;
  progressTimer?: ReturnType<typeof setInterval>;
  lastProgressKey?: string;
}

interface DetachedWatch {
  id: string;
  listeners: Set<Listener>;
  timer: ReturnType<typeof setInterval>;
  lastProgressKey?: string;
  lastActivityKey?: string;
}

const active = new Map<string, ActiveScan>();
const detached = new Map<string, DetachedWatch>();

function redactProgressString<T extends string | null | undefined>(value: T): T {
  return (typeof value === "string" ? redactText(value) : value) as T;
}

export function sanitizeScanProgress(progress: ScanProgress): ScanProgress {
  return {
    ...progress,
    phase: redactProgressString(progress.phase),
    phaseLabel: redactText(progress.phaseLabel),
    detail: redactProgressString(progress.detail),
    unit: redactProgressString(progress.unit),
    deepPhase: redactProgressString(progress.deepPhase),
    activityState: redactProgressString(progress.activityState),
    lastActivityAt: redactProgressString(progress.lastActivityAt),
  };
}

export function sanitizeScanRun(run: ScanRun): ScanRun {
  return run.progress
    ? { ...run, progress: sanitizeScanProgress(run.progress) }
    : run;
}

export function sanitizeScanEvent(
  event: Omit<ScanEvent, "at"> & { at?: string },
): ScanEvent {
  return {
    ...event,
    ...(event.message === undefined ? {} : { message: redactText(event.message) }),
    ...(event.progress === undefined
      ? {}
      : { progress: sanitizeScanProgress(event.progress) }),
    ...(event.scan === undefined ? {} : { scan: sanitizeScanRun(event.scan) }),
    at: event.at ?? new Date().toISOString(),
  };
}

function emit(scan: ActiveScan, event: Omit<ScanEvent, "at"> & { at?: string }): void {
  const full = sanitizeScanEvent(event);
  if (full.message) {
    const cursor = appendCliLog(scan.scanDir, full.message);
    if (cursor > 0) full.cursor = cursor;
  }
  scan.logBuffer.push(full);
  if (scan.logBuffer.length > 500) scan.logBuffer.shift();
  for (const listener of scan.listeners) listener(full);
}

function emitDetached(
  watch: DetachedWatch,
  event: Omit<ScanEvent, "at"> & { at?: string },
): void {
  const full = sanitizeScanEvent(event);
  for (const listener of watch.listeners) listener(full);
}

export function getActiveScanIds(): string[] {
  return [...active.keys()];
}

/** @deprecated prefer getActiveScanIds — kept for older clients */
export function getActiveScanId(): string | null {
  return getActiveScanIds()[0] ?? null;
}

export function isScanActive(id: string): boolean {
  return active.has(id) || detached.has(id);
}

export function subscribe(
  scanId: string,
  listener: Listener,
  afterCursor?: number,
): () => void {
  const scan = active.get(scanId);
  if (scan) {
    for (const past of scan.logBuffer) {
      if (afterCursor === undefined || (past.cursor !== undefined && past.cursor > afterCursor)) {
        listener(past);
      }
    }
    scan.listeners.add(listener);
    return () => scan.listeners.delete(listener);
  }

  const run = getRun(scanId);
  if (run?.status === "running") {
    return subscribeDetached(scanId, run, listener, afterCursor);
  }

  listener({
    type: "error",
    at: new Date().toISOString(),
    message: "Scan não está ativo",
  });
  return () => undefined;
}

export function waitForScan(scanId: string): Promise<ScanRun> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    unsubscribe = subscribe(scanId, (event) => {
      if (
        (event.type === "done" || event.status === "cancelled") &&
        event.scan
      ) {
        settled = true;
        unsubscribe();
        resolve(event.scan);
      } else if (event.type === "error") {
        settled = true;
        unsubscribe();
        reject(new Error(event.message ?? "Scan falhou"));
      }
    });
    if (settled) unsubscribe();
  });
}

function subscribeDetached(
  scanId: string,
  run: ScanRun,
  listener: Listener,
  afterCursor?: number,
): () => void {
  const enriched = sanitizeScanRun(withProgress(run));
  if (afterCursor === undefined) {
    listener({
      type: "status",
      at: new Date().toISOString(),
      status: "running",
      message:
        "Scan ainda rodando, mas o stream stdout foi perdido no restart da API. " +
        "Mostrando progresso/atividade do workbench" +
        (readCliLogTail(run.scanDir, 1).length ? " + log gravado em disco." : "."),
      scan: enriched,
      progress: enriched.progress ?? undefined,
    });
  }

  const restored = afterCursor === undefined
    ? readCliLogTail(run.scanDir).map((line) => ({ line, cursor: undefined }))
    : readCliLogSince(run.scanDir, afterCursor);
  for (const entry of restored) {
    listener({
      type: "log",
      at: new Date().toISOString(),
      message: entry.line,
      cursor: entry.cursor,
    });
  }

  let watch = detached.get(scanId);
  let created = false;
  if (!watch) {
    created = true;
    watch = {
      id: scanId,
      listeners: new Set(),
      timer: setInterval(() => tickDetached(scanId), 3000),
    };
    detached.set(scanId, watch);
  }
  watch.listeners.add(listener);
  if (created) tickDetached(scanId);
  return () => {
    watch!.listeners.delete(listener);
    if (watch!.listeners.size === 0) {
      clearInterval(watch!.timer);
      detached.delete(scanId);
    }
  };
}

function tickDetached(scanId: string): void {
  const watch = detached.get(scanId);
  if (!watch) return;
  const run = getRun(scanId);
  if (!run) return;

  if (run.status !== "running") {
    const enriched = sanitizeScanRun(withProgress(run));
    emitDetached(watch, {
      type: "done",
      status: run.status,
      message: `Scan finalizado (${run.status})`,
      scan: enriched,
      progress: enriched.progress ?? undefined,
    });
    clearInterval(watch.timer);
    detached.delete(scanId);
    return;
  }

  // Pull latest cost/status from workbench for orphaned jobs.
  try {
    refreshRunByScanDir(run.scanDir, run.id);
  } catch {
    // ignore
  }
  const latest = getRun(scanId) ?? run;
  const restoredProgress = progressForStatus(
    "running",
    latest.scanDir,
    latest.mode,
    latest.startedAt,
  );
  if (restoredProgress) {
    const progress = sanitizeScanProgress(restoredProgress);
    const key = progressKey(progress);
    if (watch.lastProgressKey !== key) {
      watch.lastProgressKey = key;
      latest.progress = progress;
      emitDetached(watch, {
        type: "progress",
        progress,
        message: progressEventMessage(progress),
        scan: { ...latest, progress },
      });
    }
  }

  const activity = readDetachedActivity(latest.scanDir);
  const activityKey = activity.join("|");
  if (activity.length && activityKey !== watch.lastActivityKey) {
    watch.lastActivityKey = activityKey;
    for (const line of activity.slice(-4)) {
      const cursor = appendCliLog(latest.scanDir, line);
      emitDetached(watch, { type: "log", message: line, cursor: cursor || undefined });
    }
  }
}

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

export interface StartScanOptions {
  signal?: AbortSignal;
  /** Injectable only for deterministic launch-boundary tests. */
  dependencies?: Partial<StartScanDependencies>;
}

type StartScanProviderRuntime = Pick<ProviderRuntime, "launchPlans" | "vault"> & {
  store: Pick<ProviderRuntime["store"], "get" | "getSnapshot" | "getModel">;
};

interface StartScanDependencies {
  validateScannerRequest: typeof validateScannerRequest;
  providerRuntime: StartScanProviderRuntime;
  resolveMantisLocalSource: typeof resolveMantisLocalSource;
  spawn: ScannerSpawn;
  /** Existing-session environment only; API-key variables are removed in launch.ts. */
  environment: NodeJS.ProcessEnv;
}

type ScannerSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: boolean;
    stdio: ["ignore", "pipe", "pipe"];
  },
) => ChildProcess;

export async function startScan(
  req: StartScanRequest,
  options: StartScanOptions = {},
): Promise<ScanRun> {
  throwIfLaunchAborted(options.signal);
  const dependencies = options.dependencies ?? {};

  if (active.size >= MAX_CONCURRENT_SCANS) {
    throw new Error(
      `Limite de scans simultâneos atingido (${MAX_CONCURRENT_SCANS}). Cancele um ou aumente CSB_MAX_CONCURRENT_SCANS.`,
    );
  }

  const repositoryPath = path.resolve(req.repositoryPath);
  if (!fs.existsSync(repositoryPath) || !fs.statSync(repositoryPath).isDirectory()) {
    throw new Error(`Repositório inválido: ${repositoryPath}`);
  }

  const scanner = await (dependencies.validateScannerRequest ?? validateScannerRequest)(req);
  throwIfLaunchAborted(options.signal);

  const displayName = req.displayName?.trim() || path.basename(repositoryPath);
  const id = nanoid(12);
  const outputDir = path.join(SCANS_ROOT, safeName(displayName), `csb-${safeName(displayName)}-${id}`);
  const providerRuntime = dependencies.providerRuntime ?? getProviderRuntime();
  const selection = resolveScanLaunchSelection({
    request: req,
    scanId: id,
    launchPlans: providerRuntime.launchPlans,
  });
  // This repeats the server-side immutable selection check before any vault or
  // network-facing preflight. A Portable child will repeat it once more before
  // it opens its credential boundary.
  const portablePlan = portableCodexSecurityProviderPlan(id, selection.plan);
  const codexSecurityApiKey = selection.plan !== null && isCodexSecurityApiPlan(selection.plan)
    ? await resolveCodexSecurityApiKey({
      scanId: id,
      plan: selection.plan,
      getConnection: (connectionId) => providerRuntime.store.get(connectionId),
      getSnapshot: (scanId) => providerRuntime.store.getSnapshot(scanId),
      getModel: (connectionId, modelId) =>
        providerRuntime.store.getModel(connectionId, modelId),
      vault: providerRuntime.vault,
      signal: options.signal,
      timeoutMs: CODEX_SECURITY_API_VAULT_TIMEOUT_MS,
    })
    : null;
  throwIfLaunchAborted(options.signal);
  const localMantisPlan = localMantisProviderPlan(selection.plan);
  const localMantisSource = localMantisPlan === null
    ? null
    : await (dependencies.resolveMantisLocalSource ?? resolveMantisLocalSource)({
      repositoryUrl: MANTIS_REPOSITORY_URL,
      ref: MANTIS_SOURCE_REF,
      cacheDir: MANTIS_CACHE_DIR,
      timeoutMs: MANTIS_LOCAL_SOURCE_TIMEOUT_MS,
      signal: options.signal,
    });
  if (localMantisSource !== null && localMantisSource.ref !== MANTIS_SOURCE_REF) {
    throw new Error("Mantis local source pin mismatch");
  }
  throwIfLaunchAborted(options.signal);

  // No output directory, worker config, or child process exists until the
  // immutable plan has passed and the exact Codex Security API tuple, when
  // selected, has resolved its vault credential.
  const startedAt = new Date().toISOString();
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  // Connection-aware local runtime-default plans intentionally have no model.
  // Never reinstate a browser value or the legacy GPT fallback for them.
  const model = selection.connectionAware
    ? selection.model
    : selection.model ?? req.model ?? scanner.models[0]?.id ?? "gpt-5.6-sol";
  // Legacy launches retain the historical high default. A resolved provider
  // model without effort metadata is provider-managed, so no synthetic flag
  // or persisted value may be introduced after selection normalization.
  const effort = selection.request.effort ?? (selection.connectionAware ? null : "high");
  const mode = req.mode || "standard";
  const requiredModel = (): string => {
    if (model === null) throw new Error("Selected scanner route requires an exact provider model");
    return model;
  };
  const launch = localMantisPlan !== null && localMantisSource !== null
    ? prepareMantisLocalLaunch({
      request: selection.request,
      repositoryPath,
      outputDir,
      effort,
      mode,
      sourceCacheDir: localMantisSource.sourceCacheDir,
      mantisLocalProviderPlan: localMantisPlan,
      ...(dependencies.environment === undefined ? {} : { environment: dependencies.environment }),
    })
    : portablePlan !== undefined
    ? preparePortableCodexSecurityLaunch({
      request: selection.request,
      repositoryPath,
      outputDir,
      model: requiredModel(),
      effort,
      mode,
      providerKind: selection.plan!.providerKind,
      portableCodexSecurityProviderPlan: portablePlan,
      pricing: selection.plan!.model!.pricing,
      capturedAt: startedAt,
      ...(dependencies.environment === undefined ? {} : { environment: dependencies.environment }),
    })
    : codexSecurityApiKey !== null
    ? prepareCodexSecurityApiLaunch({
      request: selection.request,
      repositoryPath,
      outputDir,
      model: requiredModel(),
      effort,
      mode,
      apiKey: codexSecurityApiKey,
    })
    : selection.plan?.runnerKind === "agent-session" &&
        selection.plan.engine === "mantis"
      ? prepareMantisHttpLaunch({
        request: selection.request,
        repositoryPath,
        outputDir,
        model: requiredModel(),
        effort,
        mode,
        providerKind: selection.plan.providerKind,
        mantisProviderPlan: createSafeMantisProviderPlan(selection.plan),
      })
      : prepareScannerLaunch({
        request: selection.request,
        repositoryPath,
        outputDir,
        model: requiredModel(),
        effort,
        mode,
        vulnhunterProviderPlan: vulnhunterProviderPlan(id, selection.plan),
        providerKind: selection.plan?.engine === "vulnhunter" &&
            selection.plan.runnerKind === "agent-session"
          ? selection.plan.providerKind
          : undefined,
      });

  const initialProgress = progressForStatus("running", outputDir, mode, startedAt);
  const run: ScanRun = {
    id,
    displayName,
    repositoryPath,
    revision: null,
    scanDir: outputDir,
    status: "running",
    model,
    effort,
    mode,
    engine: launch.engine,
    provider: launch.provider,
    authMode: launch.authMode,
    scannerVersion: launch.scannerVersion,
    recipeHash: launch.recipeHash,
    startedAt,
    completedAt: null,
    durationMs: null,
    cost:
      launch.authMode === null ||
      ((launch.engine === "mantis" || launch.engine === "vulnhunter") &&
        (launch.authMode === "chatgpt" || launch.authMode === "existing-session")
      )
        ? null
        : {
          estimatedUsd: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          model: model ?? undefined,
        },
    severity: emptySeverityCounts(),
    source: "benchmark",
    pid: null,
    execution: selection.plan?.execution ?? null,
    launchSelection: launchSelectionForRun(selection.plan, selection.request.paths),
    progress: initialProgress ? sanitizeScanProgress(initialProgress) : null,
  };
  upsertRun(run);

  const redactionScope = `scan/${id}`;
  globalSecretRedactor.register(redactionScope, processSecretValues(launch.env));
  let redactionScopeReleased = false;
  const releaseRedactionScope = (): void => {
    if (redactionScopeReleased) return;
    redactionScopeReleased = true;
    globalSecretRedactor.unregister(redactionScope);
  };

  let child: ChildProcess;
  try {
    const spawnScanner: ScannerSpawn = dependencies.spawn ?? spawn;
    child = spawnScanner(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      // Own process group so an API restart does not SIGTERM long-running scans.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    releaseRedactionScope();
    throw error;
  }

  run.pid = child.pid ?? null;
  upsertRun(run);

  const activeScan: ActiveScan = {
    id,
    scanDir: outputDir,
    child,
    listeners: new Set(),
    logBuffer: [],
    releaseRedactionScope,
  };
  active.set(id, activeScan);

  emit(activeScan, {
    type: "status",
    status: "running",
    message: `Iniciando ${scanner.name}: ${launch.displayCommand}`,
    scan: run,
  });

  const onChunk = (chunk: Buffer, stream: "stdout" | "stderr") => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (!isInternalProgressMarker(line)) {
        emit(activeScan, {
          type: "log",
          message: `[${stream}] ${line}`,
        });
      }
      maybeParseCost(line, activeScan, run);
      maybeParseProgress(line, activeScan, run);
    }
  };

  child.stdout?.on("data", (c: Buffer) => onChunk(c, "stdout"));
  child.stderr?.on("data", (c: Buffer) => onChunk(c, "stderr"));

  activeScan.progressTimer = setInterval(() => {
    pollWorkbenchProgress(activeScan, run);
  }, 3000);
  pollWorkbenchProgress(activeScan, run);

  child.on("error", (err) => {
    if (activeScan.progressTimer) clearInterval(activeScan.progressTimer);
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    run.durationMs = Date.parse(run.completedAt) - Date.parse(startedAt);
    run.pid = null;
    run.progress = null;
    upsertRun(run);
    emit(activeScan, {
      type: "error",
      message: err.message,
      status: "failed",
      scan: run,
    });
    active.delete(id);
    activeScan.releaseRedactionScope();
  });

  child.on("close", (code) => {
    if (activeScan.progressTimer) clearInterval(activeScan.progressTimer);
    const refreshed = refreshAfterClose(outputDir, run);
    if (refreshed.status === "completed") {
      // Keep the scanner's terminal state.
    } else if (refreshed.status === "cancelled" || refreshed.status === "incomplete") {
      // keep
    } else if (code === 0 && refreshed.status !== "failed") {
      refreshed.status = "completed";
    } else {
      refreshed.status = code === null ? "cancelled" : "failed";
    }
    refreshed.completedAt = refreshed.completedAt ?? new Date().toISOString();
    refreshed.durationMs =
      refreshed.durationMs ??
      (Date.parse(refreshed.completedAt) - Date.parse(startedAt));
    refreshed.pid = null;
    const completedProgress = refreshed.status === "completed"
      ? progressForStatus("completed", refreshed.scanDir, refreshed.mode)
      : isPortableCodexSecurityRun(refreshed)
        ? refreshed.progress ?? null
        : null;
    refreshed.progress = completedProgress
      ? sanitizeScanProgress(completedProgress)
      : null;
    upsertRun(refreshed);
    emit(activeScan, {
      type: "done",
      status: refreshed.status,
      message: `Scan finalizado (exit ${code})`,
      scan: refreshed,
      cost: refreshed.cost ?? undefined,
      progress: refreshed.progress ?? undefined,
    });
    active.delete(id);
    activeScan.releaseRedactionScope();
  });

  return run;
}

/** Converts an already-persisted server plan into the child-safe DTO. */
function vulnhunterProviderPlan(
  scanId: string,
  plan: ScanLaunchPlan | null,
): SafeVulnHunterProviderPlan | undefined {
  if (
    plan?.engine !== "vulnhunter" ||
    plan.runnerKind !== "agent-session" ||
    plan.model === null ||
    plan.capabilityCheckId === null ||
    !isVulnHunterProviderProtocol(plan)
  ) return undefined;
  return {
    scanId,
    connectionId: plan.connectionId,
    routeKind: plan.routeKind,
    protocol: plan.protocol,
    modelId: plan.model.id,
    capabilityCheckId: plan.capabilityCheckId,
  };
}

/** Converts only the exact already-resolved Portable provenance into worker ids. */
function portableCodexSecurityProviderPlan(
  scanId: string,
  plan: ScanLaunchPlan | null,
): SafePortableCodexSecurityProviderPlan | undefined {
  if (
    plan?.engine !== "codex-security" ||
    plan.runnerKind !== "agent-session" ||
    plan.model === null ||
    plan.capabilityCheckId === null ||
    plan.execution?.executionProfile !== "portable" ||
    plan.execution.profileVersion !== PORTABLE_CODEX_SECURITY_PROFILE_VERSION ||
    plan.execution.methodologyRef !== PORTABLE_CODEX_SECURITY_METHODOLOGY_REF ||
    plan.execution.capabilityCheckId !== plan.capabilityCheckId ||
    plan.execution.connectionId !== plan.connectionId ||
    plan.execution.routeKind !== plan.routeKind ||
    plan.execution.protocol !== plan.protocol ||
    plan.snapshot.scanId !== scanId ||
    plan.snapshot.connectionId !== plan.connectionId ||
    plan.snapshot.routeKind !== plan.routeKind ||
    plan.snapshot.modelSelectionMode !== "catalog" ||
    plan.snapshot.modelId !== plan.model.id ||
    plan.snapshot.capabilityCheckId !== plan.capabilityCheckId ||
    plan.snapshot.executionProfile !== "portable" ||
    plan.snapshot.profileVersion !== PORTABLE_CODEX_SECURITY_PROFILE_VERSION ||
    plan.snapshot.methodologyRef !== PORTABLE_CODEX_SECURITY_METHODOLOGY_REF ||
    plan.snapshot.protocol !== plan.protocol ||
    plan.snapshot.authKind !== plan.execution.authKind
  ) {
    if (plan?.execution?.executionProfile === "portable") {
      throw new ScanSelectionError("provider_runner_unavailable");
    }
    return undefined;
  }
  try {
    return createSafePortableCodexSecurityProviderPlan({
      scanId,
      connectionId: plan.connectionId,
      routeKind: plan.routeKind,
      protocol: plan.protocol,
      modelId: plan.model.id,
      capabilityCheckId: plan.capabilityCheckId,
      profileVersion: plan.execution.profileVersion,
      methodologyRef: plan.execution.methodologyRef,
    });
  } catch {
    throw new ScanSelectionError("provider_runner_unavailable");
  }
}

function isPortableCodexSecurityRun(run: ScanRun): boolean {
  return run.engine === "codex-security" &&
    run.execution?.executionProfile === "portable";
}

/** Snapshot-owned model selection plus the exact normalized scope used at launch. */
function launchSelectionForRun(
  plan: ScanLaunchPlan | null,
  paths: readonly string[] | undefined,
): ScanRun["launchSelection"] {
  if (plan === null) return null;
  return {
    modelSelectionMode: plan.snapshot.modelSelectionMode,
    modelId: plan.snapshot.modelId,
    paths: (paths ?? []).map((item) => item.trim()).filter(Boolean),
  };
}

function isVulnHunterProviderProtocol(
  plan: ScanLaunchPlan,
): plan is ScanLaunchPlan & { protocol: SafeVulnHunterProviderPlan["protocol"] } {
  const directXaiOAuth = plan.providerKind === "xai" &&
    plan.routeKind === "xai-oauth" &&
    plan.protocol === "xai-oauth-responses";
  return isHttpAgentRouteProtocolSupported(plan.routeKind, plan.protocol) &&
    (directXaiOAuth || (plan.routeKind !== "xai-oauth" && plan.protocol !== "xai-oauth-responses"));
}

function progressKey(p: ScanProgress): string {
  return `${p.percent}|${p.phase}|${p.detail ?? ""}|${p.deepPhase ?? ""}|${p.activityState ?? ""}|${p.lastActivityAt ?? ""}`;
}

function applyProgress(
  activeScan: ActiveScan,
  run: ScanRun,
  progress: ScanProgress,
): void {
  const safeProgress = sanitizeScanProgress(progress);
  const key = progressKey(safeProgress);
  if (activeScan.lastProgressKey === key) return;
  activeScan.lastProgressKey = key;
  run.progress = safeProgress;
  emit(activeScan, {
    type: "progress",
    progress: safeProgress,
    message: progressEventMessage(safeProgress),
    scan: { ...run },
  });
}

function pollWorkbenchProgress(activeScan: ActiveScan, run: ScanRun): void {
  try {
    const progress = progressForStatus(
      "running",
      run.scanDir,
      run.mode,
      run.startedAt,
    );
    if (progress) applyProgress(activeScan, run, progress);
  } catch {
    // ignore transient sqlite locks
  }
}

function maybeParseProgress(
  line: string,
  activeScan: ActiveScan,
  run: ScanRun,
): void {
  const hint = parseCliPhaseHint(line);
  if (!hint || hint.percent == null) return;
  // Don't override richer workbench progress with CLI guesses.
  if (run.progress && run.progress.itemsTotal > 0) return;
  if (run.progress && (run.progress.percent ?? 0) >= (hint.percent ?? 0)) return;
  applyProgress(activeScan, run, {
    percent: hint.percent,
    phase: hint.phase ?? run.progress?.phase ?? "discovery",
    phaseLabel: hint.phaseLabel ?? "Em andamento",
    detail: hint.detail ?? null,
    unit: hint.unit ?? null,
    itemsCompleted: hint.itemsCompleted ?? 0,
    itemsTotal: hint.itemsTotal ?? 0,
    deepPhase: hint.deepPhase,
    reportableFindings: hint.reportableFindings,
  });
}

function maybeParseCost(line: string, activeScan: ActiveScan, run: ScanRun): void {
  // A subscription/local-session run has no reliable usage contract. Do not
  // turn arbitrary prose such as "1,000 tokens" into a fictitious cost.
  if (run.cost === null) return;
  // Heuristics from CLI progress lines
  const usd = line.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:USD|usd)/i);
  const tokens = line.match(/([0-9,]+)\s+tokens?/i);
  if (!usd && !tokens) return;

  const cost: ScanCost = {
    estimatedUsd: usd ? Number(usd[1]) : run.cost?.estimatedUsd ?? 0,
    inputTokens: run.cost?.inputTokens ?? 0,
    cachedInputTokens: run.cost?.cachedInputTokens ?? 0,
    cacheWriteInputTokens: run.cost?.cacheWriteInputTokens ?? 0,
    outputTokens: run.cost?.outputTokens ?? 0,
    model: run.model ?? undefined,
  };
  if (tokens) {
    cost.inputTokens = Number(tokens[1].replace(/,/g, ""));
  }
  run.cost = cost;
  upsertRun(run);
  emit(activeScan, { type: "cost", cost, scan: run });
}

function throwIfLaunchAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CodexSecurityApiBridgeError("credential_unavailable");
}

function localMantisProviderPlan(plan: ScanLaunchPlan | null): MantisLocalProviderPlan | null {
  if (plan === null || plan.runnerKind !== "local-agent-session") return null;
  if (
    plan.engine !== "mantis" ||
    plan.providerKind !== "anthropic" ||
    plan.routeKind !== "claude-code-local" ||
    plan.protocol !== "claude-code-cli" ||
    plan.scannerAuthMode !== "existing-session" ||
    plan.snapshot.connectionId !== plan.connectionId ||
    plan.snapshot.routeKind !== plan.routeKind
  ) throw new Error("Mantis local provider plan is invalid");
  const modelSelectionMode = plan.snapshot.modelSelectionMode;
  if (modelSelectionMode !== "catalog" && modelSelectionMode !== "runtime-default") {
    throw new Error("Mantis local provider plan is invalid");
  }
  const runtimeDefault = modelSelectionMode === "runtime-default";
  if (
    (runtimeDefault && (plan.snapshot.modelId !== null || plan.model !== null || plan.capabilityCheckId !== null)) ||
    (!runtimeDefault && (
      modelSelectionMode !== "catalog" ||
      plan.snapshot.modelId === null ||
      plan.model === null ||
      plan.model.id !== plan.snapshot.modelId ||
      plan.capabilityCheckId !== null
    ))
  ) throw new Error("Mantis local provider plan is invalid");
  return {
    scanId: plan.snapshot.scanId,
    connectionId: plan.connectionId,
    routeKind: plan.routeKind,
    protocol: plan.protocol,
    modelSelectionMode,
    modelId: plan.snapshot.modelId,
  };
}

interface RunRefreshDependencies {
  readOfficialRun: (id: string) => ScanRun | null;
  refreshByScanDir: (scanDir: string, fallbackId: string) => ScanRun | null;
}

const runRefreshDependencies: RunRefreshDependencies = {
  readOfficialRun: readWorkbenchScan,
  refreshByScanDir: refreshRunByScanDir,
};

export function refreshAfterClose(
  outputDir: string,
  fallback: ScanRun,
  dependencies: RunRefreshDependencies = runRefreshDependencies,
): ScanRun {
  if (isPortableCodexSecurityRun(fallback)) {
    return refreshPortableCodexSecurityRunFromDisk(getRun(fallback.id) ?? fallback);
  }
  if (fallback.engine === "mantis") {
    return refreshMantisRunFromDisk(getRun(fallback.id) ?? fallback);
  }
  if (fallback.engine === "vulnhunter") {
    return refreshVulnHunterRunFromDisk(getRun(fallback.id) ?? fallback);
  }
  // Try to pick up official workbench id if created
  try {
    const manifestPath = path.join(outputDir, "scan-manifest.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        scan?: { id?: string };
      };
      const officialId = manifest.scan?.id;
      if (officialId) {
        const official = dependencies.readOfficialRun(officialId);
        if (official) {
          // Keep our benchmark id as primary key but merge metrics
          return {
            ...official,
            id: fallback.id,
            source: "benchmark",
            engine: fallback.engine,
            provider: fallback.provider,
            authMode: fallback.authMode,
            scannerVersion: official.scannerVersion ?? fallback.scannerVersion,
            recipeHash: fallback.recipeHash,
            model: official.model ?? fallback.model,
            effort: official.effort ?? fallback.effort,
            scanDir: official.scanDir || fallback.scanDir,
          };
        }
      }
    }
  } catch {
    // fall through
  }
  // No manifest (common when the CLI fails mid-seal) — still merge cost by scanDir.
  const byDir = dependencies.refreshByScanDir(outputDir, fallback.id);
  if (byDir) {
    return {
      ...byDir,
      id: fallback.id,
      source: "benchmark",
      engine: fallback.engine,
      provider: fallback.provider,
      authMode: fallback.authMode,
      scannerVersion: byDir.scannerVersion ?? fallback.scannerVersion,
      recipeHash: fallback.recipeHash,
      model: byDir.model ?? fallback.model,
      effort: byDir.effort ?? fallback.effort,
      mode: byDir.mode ?? fallback.mode,
    };
  }
  const existing = getRun(fallback.id) ?? fallback;
  return existing;
}

export function cancelScan(id: string): boolean {
  const scan = active.get(id);
  const run = getRun(id);
  if (!scan && (!run || run.status !== "running")) return false;

  if (scan?.progressTimer) clearInterval(scan.progressTimer);

  const pids = new Set<number>();
  if (scan?.child.pid) pids.add(scan.child.pid);
  if (run?.pid && processAlive(run.pid)) pids.add(run.pid);
  if (run?.scanDir) {
    for (const pid of findPidsForScanDir(run.scanDir)) pids.add(pid);
  }

  // Kill only the target PIDs — never the process group (-pid). Orphaned Contion
  // jobs often share a shell PGID; group kill would wipe unrelated scans.
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  setTimeout(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 5000);

  if (run) {
    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    run.pid = null;
    run.progress = null;
    if (run.startedAt) {
      run.durationMs = Date.parse(run.completedAt) - Date.parse(run.startedAt);
    }
    upsertRun(run);
    if (scan) {
      emit(scan, {
        type: "status",
        status: "cancelled",
        message: "Cancelamento solicitado",
        scan: run,
      });
    } else {
      const watch = detached.get(id);
      if (watch) {
        emitDetached(watch, {
          type: "status",
          status: "cancelled",
          message: "Cancelamento solicitado (processo órfão)",
          scan: run,
        });
      }
    }
  }
  active.delete(id);
  const watch = detached.get(id);
  if (watch) {
    clearInterval(watch.timer);
    detached.delete(id);
  }
  return true;
}
