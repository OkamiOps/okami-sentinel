import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface ServerRecoveryCandidate {
  id: string;
  scanDir: string;
  status: string;
  portable: boolean;
}
export interface ServerRecoveryDependencies {
  getCandidate(id: string): ServerRecoveryCandidate | null;
  hasProcess(scanDir: string): boolean;
  /** Strict snapshot/checkpoint validation. Terminal runtime states must be rejected. */
  prepare(candidate: ServerRecoveryCandidate): Promise<{ snapshotId: string; start(): Promise<void> }>;
}
export interface ServerRecoveryOutcome { scanId: string; status: "resumed" | "skipped" | "blocked"; reason?: string; }

/** Release a newly acquired reservation even when the atomic row claim loses a race. */
export function claimPortableRestartCapacity(reserve: () => boolean, claim: () => boolean, release: () => void): void {
  if (!reserve()) throw new Error("restart_capacity_full");
  try { if (!claim()) throw new Error("restart_state_invalid"); }
  catch (error) { release(); throw error; }
}

/** The callback must target only the child just created by this recovery attempt. */
export function assertPortableRestartLaunchAllowed(status: string | undefined, draining: boolean, stopOwnChild: () => void): void {
  if (draining || status !== "queued") {
    stopOwnChild();
    throw new Error("restart_draining");
  }
}

function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Only IDs captured as active before server boot reconciliation are authorized. */
export async function recoverPortableServerRuns(ids: readonly string[], dependencies: ServerRecoveryDependencies): Promise<ServerRecoveryOutcome[]> {
  const outcomes: ServerRecoveryOutcome[] = [];
  for (const id of new Set(ids)) {
    const candidate = dependencies.getCandidate(id);
    if (!candidate?.portable || candidate.status !== "incomplete" || dependencies.hasProcess(candidate.scanDir)) {
      outcomes.push({ scanId: id, status: "skipped" }); continue;
    }
    try {
      const prepared = await dependencies.prepare(candidate);
      const journal = path.join(candidate.scanDir, "portable-server-recovery.json");
      let attempts = 0;
      if (fs.existsSync(journal)) {
        const stat = fs.lstatSync(journal);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("restart_state_invalid");
        const saved = JSON.parse(fs.readFileSync(journal, "utf8"));
        if (saved.version !== 1 || saved.scanId !== id || saved.snapshotId !== prepared.snapshotId ||
            !Number.isInteger(saved.attempts) || saved.attempts < 0 || saved.attempts > 2) throw new Error("restart_state_invalid");
        attempts = saved.attempts;
      }
      if (attempts >= 2) throw new Error("restart_budget_exhausted");
      const current = dependencies.getCandidate(id);
      if (current?.status !== "incomplete" || dependencies.hasProcess(candidate.scanDir)) {
        outcomes.push({ scanId: id, status: "skipped" }); continue;
      }
      atomicJson(journal, { version: 1, scanId: id, snapshotId: prepared.snapshotId, attempts: attempts + 1 });
      await prepared.start();
      outcomes.push({ scanId: id, status: "resumed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const reason = ["restart_budget_exhausted", "restart_state_invalid", "restart_capacity_full", "restart_capability_unavailable", "restart_terminal_runtime", "restart_no_checkpoint", "restart_draining"].includes(message)
        ? message : "restart_validation_or_launch_failed";
      outcomes.push({ scanId: id, status: "blocked", reason });
    }
  }
  return outcomes;
}

/** Old worker absence is checked before cleaning task-owned empty locks. */
function releaseInterruptedSessionLocks(directory: string): void {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("restart_state_invalid");
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("restart_state_invalid");
    if (entry.isDirectory()) releaseInterruptedSessionLocks(target);
    else if (/^[a-f0-9]{64}\.lock$/.test(entry.name)) {
      if (!entry.isFile() || fs.lstatSync(target).size !== 0) throw new Error("restart_state_invalid");
      fs.unlinkSync(target);
    }
  }
}

export async function recoverPortableScansAfterServerRestart(ids: readonly string[]): Promise<ServerRecoveryOutcome[]> {
  return recoverPortableScansAfterWorkerInterruption(ids);
}

/** Reconcile an interrupted Portable worker under its existing scan ID. */
export async function recoverPortableScansAfterWorkerInterruption(ids: readonly string[]): Promise<ServerRecoveryOutcome[]> {
  const [{ getRun, getDb, upsertRun, reserveScanCapacity, releaseScanCapacity }, { MAX_CONCURRENT_SCANS },
    { getProviderRuntime }, { cliLogPath }, identity, { readPortableCodexSecurityWorkerConfiguration },
    { preflightPortableResume }, { spawn }, { isDraining }] = await Promise.all([
    import("../db.js"), import("../config.js"), import("../provider-runtime.js"), import("../activity.js"),
    import("../process-identity.js"), import("./portable-codex-security-worker.js"), import("./resume-portable-scan.js"),
    import("node:child_process"), import("../shutdown.js"),
  ]);
  return recoverPortableServerRuns(ids, {
    getCandidate(id) {
      const run = getRun(id);
      return run ? { id, scanDir: run.scanDir, status: run.status,
        portable: run.engine === "codex-security" && run.execution?.executionProfile === "portable" } : null;
    },
    hasProcess: directory => identity.findProcessIdentitiesForScanDir(directory).length > 0,
    async prepare(candidate) {
      if (isDraining()) throw new Error("restart_draining");
      const run = getRun(candidate.id)!;
      const configPath = path.join(run.scanDir, "portable-codex-security-run.json");
      const config = readPortableCodexSecurityWorkerConfiguration(configPath);
      if (path.resolve(config.outputDir) !== path.resolve(run.scanDir) || config.providerPlan.scanId !== run.id) throw new Error("restart_state_invalid");
      const { previous } = preflightPortableResume(run.scanDir, config.mode);
      if (previous.status !== "running" && previous.status !== "preparing") throw new Error("restart_terminal_runtime");
      if (!previous.snapshotId) throw new Error("restart_no_checkpoint");
      return { snapshotId: previous.snapshotId, async start() {
        if (isDraining()) throw new Error("restart_draining");
        claimPortableRestartCapacity(
          () => reserveScanCapacity(run.id, MAX_CONCURRENT_SCANS),
          () => getDb().prepare("UPDATE runs SET status = 'queued' WHERE id = ? AND status = 'incomplete'").run(run.id).changes === 1,
          () => releaseScanCapacity(run.id),
        );
        try {
          upsertRun({ ...run, status: "queued", pid: null, completedAt: null, durationMs: null });
          const runtime = getProviderRuntime();
          const frozen = runtime.store.getSnapshot(run.id);
          if (!frozen?.modelId) throw new Error("restart_state_invalid");
          const probe = await runtime.connections.probe(frozen.connectionId, { connectionId: frozen.connectionId,
            modelId: frozen.modelId, modelSelectionMode: "catalog" });
          if (probe?.report.status !== "passed") throw new Error("restart_capability_unavailable");
          if (isDraining() || getRun(run.id)?.status !== "queued") throw new Error("restart_draining");
          if (identity.findProcessIdentitiesForScanDir(run.scanDir).length) throw new Error("restart_state_invalid");
          releaseInterruptedSessionLocks(path.join(run.scanDir, "portable-recovery"));
          atomicJson(configPath, { ...config, providerPlan: { ...config.providerPlan, capabilityCheckId: probe.report.id } });
          runtime.store.refreshSnapshotCapability(run.id, frozen.capabilityCheckId, probe.report.id);
          const descriptor = fs.openSync(cliLogPath(run.scanDir), "a", 0o600);
          let child;
          try { child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "portable-codex-security-worker.ts"), configPath, "--resume-discovery"],
            { cwd: path.resolve(import.meta.dirname, "../.."), detached: true, stdio: ["ignore", descriptor, descriptor], env: process.env }); }
          finally { fs.closeSync(descriptor); }
          await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
          assertPortableRestartLaunchAllowed(getRun(run.id)?.status, isDraining(), () => { child.kill("SIGTERM"); });
          const processIdentity = identity.captureProcessIdentity(child.pid!, run.scanDir);
          if (!processIdentity || !identity.persistProcessIdentity(run.scanDir, processIdentity)) {
            child.kill("SIGTERM"); throw new Error("restart_state_invalid");
          }
          assertPortableRestartLaunchAllowed(getRun(run.id)?.status, isDraining(), () => { child.kill("SIGTERM"); });
          upsertRun({ ...run, status: "running", pid: child.pid!, completedAt: null, durationMs: null,
            execution: { ...run.execution!, capabilityCheckId: probe.report.id } });
          child.unref();
        } catch (error) {
          const current = getRun(run.id);
          if (current?.status === "queued") upsertRun({ ...run, status: "incomplete", pid: null });
          releaseScanCapacity(run.id);
          throw error;
        }
      } };
    },
  });
}
