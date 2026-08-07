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
  CODEX_SECURITY_ARGS_PREFIX,
  CODEX_SECURITY_BIN,
  CODEX_SECURITY_STATE_DIR,
  MAX_CONCURRENT_SCANS,
  RUNS_DIR,
  SCANS_ROOT,
} from "./config.js";
import {
  appendCliLog,
  findPidsForScanDir,
  processAlive,
  readCliLogTail,
  readDetachedActivity,
} from "./activity.js";
import { getRun, upsertRun } from "./db.js";
import { refreshRunByScanDir, refreshRunFromDisk } from "./ingest.js";
import { parseCliPhaseHint, progressForStatus, withProgress } from "./progress.js";

type Listener = (event: ScanEvent) => void;

interface ActiveScan {
  id: string;
  scanDir: string;
  child: ChildProcess;
  listeners: Set<Listener>;
  logBuffer: ScanEvent[];
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

function emit(scan: ActiveScan, event: Omit<ScanEvent, "at"> & { at?: string }): void {
  const full: ScanEvent = { ...event, at: event.at ?? new Date().toISOString() };
  scan.logBuffer.push(full);
  if (scan.logBuffer.length > 500) scan.logBuffer.shift();
  if (full.message) appendCliLog(scan.scanDir, full.message);
  for (const listener of scan.listeners) listener(full);
}

function emitDetached(
  watch: DetachedWatch,
  event: Omit<ScanEvent, "at"> & { at?: string },
): void {
  const full: ScanEvent = { ...event, at: event.at ?? new Date().toISOString() };
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

export function subscribe(scanId: string, listener: Listener): () => void {
  const scan = active.get(scanId);
  if (scan) {
    for (const past of scan.logBuffer) listener(past);
    scan.listeners.add(listener);
    return () => scan.listeners.delete(listener);
  }

  const run = getRun(scanId);
  if (run?.status === "running") {
    return subscribeDetached(scanId, run, listener);
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
): () => void {
  const enriched = withProgress(run);
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

  for (const line of readCliLogTail(run.scanDir)) {
    listener({
      type: "log",
      at: new Date().toISOString(),
      message: line,
    });
  }

  let watch = detached.get(scanId);
  if (!watch) {
    watch = {
      id: scanId,
      listeners: new Set(),
      timer: setInterval(() => tickDetached(scanId), 3000),
    };
    detached.set(scanId, watch);
    tickDetached(scanId);
  }
  watch.listeners.add(listener);
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
    emitDetached(watch, {
      type: "done",
      status: run.status,
      message: `Scan finalizado (${run.status})`,
      scan: withProgress(run),
      progress: withProgress(run).progress ?? undefined,
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
  const progress = progressForStatus(
    "running",
    latest.scanDir,
    latest.mode,
    latest.startedAt,
  );
  if (progress) {
    const key = progressKey(progress);
    if (watch.lastProgressKey !== key) {
      watch.lastProgressKey = key;
      latest.progress = progress;
      emitDetached(watch, {
        type: "progress",
        progress,
        message: progress.detail
          ? `${progress.phaseLabel} · ${progress.detail} (${progress.percent}%)`
          : `${progress.phaseLabel} (${progress.percent}%)`,
        scan: { ...latest, progress },
      });
    }
  }

  const activity = readDetachedActivity(latest.scanDir);
  const activityKey = activity.join("|");
  if (activity.length && activityKey !== watch.lastActivityKey) {
    watch.lastActivityKey = activityKey;
    for (const line of activity.slice(-4)) {
      emitDetached(watch, { type: "log", message: line });
      appendCliLog(latest.scanDir, line);
    }
  }
}

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

export async function startScan(req: StartScanRequest): Promise<ScanRun> {
  if (active.size >= MAX_CONCURRENT_SCANS) {
    throw new Error(
      `Limite de scans simultâneos atingido (${MAX_CONCURRENT_SCANS}). Cancele um ou aumente CSB_MAX_CONCURRENT_SCANS.`,
    );
  }

  const repositoryPath = path.resolve(req.repositoryPath);
  if (!fs.existsSync(repositoryPath) || !fs.statSync(repositoryPath).isDirectory()) {
    throw new Error(`Repositório inválido: ${repositoryPath}`);
  }

  const displayName = req.displayName?.trim() || path.basename(repositoryPath);
  const id = nanoid(12);
  const outputDir = path.join(SCANS_ROOT, safeName(displayName), `csb-${safeName(displayName)}-${id}`);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  const model = req.model || "gpt-5.6-sol";
  const effort = req.effort || "high";
  const mode = req.mode || "standard";

  const args = [
    ...CODEX_SECURITY_ARGS_PREFIX,
    "scan",
    repositoryPath,
    "--model",
    model,
    "--effort",
    String(effort),
    "--mode",
    mode,
    "--output-dir",
    outputDir,
    "--json",
  ];

  if (req.maxCostUsd != null && req.maxCostUsd > 0) {
    args.push("--max-cost", String(req.maxCostUsd));
  }
  // Only explicit user paths — let Codex Security use its default repo scope otherwise.
  for (const p of req.paths ?? []) {
    if (p.trim()) args.push("--path", p.trim());
  }

  const startedAt = new Date().toISOString();
  const run: ScanRun = {
    id,
    displayName,
    repositoryPath,
    revision: null,
    scanDir: outputDir,
    status: "running",
    model,
    effort: String(effort),
    mode,
    startedAt,
    completedAt: null,
    durationMs: null,
    cost: {
      estimatedUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      model,
    },
    severity: emptySeverityCounts(),
    source: "benchmark",
    pid: null,
    progress: progressForStatus("running", outputDir, mode, startedAt),
  };
  upsertRun(run);

  const child = spawn(CODEX_SECURITY_BIN, args, {
    cwd: repositoryPath,
    env: {
      ...process.env,
      CODEX_SECURITY_STATE_DIR,
      CI: "1",
      NO_COLOR: "1",
    },
    // Own process group so an API restart does not SIGTERM long-running scans.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  run.pid = child.pid ?? null;
  upsertRun(run);

  const activeScan: ActiveScan = {
    id,
    scanDir: outputDir,
    child,
    listeners: new Set(),
    logBuffer: [],
  };
  active.set(id, activeScan);

  emit(activeScan, {
    type: "status",
    status: "running",
    message: `Iniciando: ${CODEX_SECURITY_BIN} ${args.join(" ")}`,
    scan: run,
  });

  const onChunk = (chunk: Buffer, stream: "stdout" | "stderr") => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      emit(activeScan, {
        type: "log",
        message: `[${stream}] ${line}`,
      });
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
  });

  child.on("close", (code) => {
    if (activeScan.progressTimer) clearInterval(activeScan.progressTimer);
    const refreshed = refreshAfterClose(outputDir, run);
    if (code === 0 || refreshed.status === "completed") {
      refreshed.status = refreshed.status === "failed" ? "failed" : "completed";
    } else if (refreshed.status === "cancelled") {
      // keep
    } else {
      refreshed.status = code === null ? "cancelled" : "failed";
    }
    refreshed.completedAt = refreshed.completedAt ?? new Date().toISOString();
    refreshed.durationMs =
      refreshed.durationMs ??
      (Date.parse(refreshed.completedAt) - Date.parse(startedAt));
    refreshed.pid = null;
    refreshed.progress =
      refreshed.status === "completed"
        ? progressForStatus("completed", refreshed.scanDir, refreshed.mode)
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
  });

  return run;
}

function progressKey(p: ScanProgress): string {
  return `${p.percent}|${p.phase}|${p.detail ?? ""}|${p.deepPhase ?? ""}`;
}

function applyProgress(
  activeScan: ActiveScan,
  run: ScanRun,
  progress: ScanProgress,
): void {
  const key = progressKey(progress);
  if (activeScan.lastProgressKey === key) return;
  activeScan.lastProgressKey = key;
  run.progress = progress;
  emit(activeScan, {
    type: "progress",
    progress,
    message: progress.detail
      ? `${progress.phaseLabel} · ${progress.detail} (${progress.percent}%)`
      : `${progress.phaseLabel} (${progress.percent}%)`,
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

function refreshAfterClose(outputDir: string, fallback: ScanRun): ScanRun {
  // Try to pick up official workbench id if created
  try {
    const manifestPath = path.join(outputDir, "scan-manifest.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        scan?: { id?: string };
      };
      const officialId = manifest.scan?.id;
      if (officialId) {
        const official = refreshRunFromDisk(officialId);
        if (official) {
          // Keep our benchmark id as primary key but merge metrics
          return {
            ...official,
            id: fallback.id,
            source: "benchmark",
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
  const byDir = refreshRunByScanDir(outputDir, fallback.id);
  if (byDir) {
    return {
      ...byDir,
      id: fallback.id,
      source: "benchmark",
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
