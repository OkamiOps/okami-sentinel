import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { nanoid } from "nanoid";
import { getRun, upsertRun, reserveScanCapacity, releaseScanCapacity } from "../db.js";
import { MAX_CONCURRENT_SCANS } from "../config.js";
import { getProviderRuntime } from "../provider-runtime.js";
import { cliLogPath } from "../activity.js";
import { captureProcessIdentity, persistProcessIdentity, findProcessIdentitiesForScanDir } from "../process-identity.js";
import { readPortableCodexSecurityWorkerConfiguration } from "./portable-codex-security-worker.js";
import { readPortableCodexSecurityRuntime } from "./portable-codex-security-runtime.js";
import { assertPortableCodexSecuritySnapshot, assertExactStageArtifact, assertPortableCodexSecurityDossierAnchors } from "./portable-codex-security-worker-support.js";
import { createPortableCodexSecurityDossier, applyPortableCodexSecurityStageArtifact } from "./portable-codex-security-dossier.js";
import { createPortableDeepCoveragePlan } from "./portable-codex-security-deep-coverage.js";
import { PORTABLE_CODEX_SECURITY_STAGES } from "./portable-codex-security-profile.js";

/** Local operator recovery. Does not mutate or overwrite the interrupted run. */
async function resume(scanId: string, dryRun: boolean) {
  const original = getRun(scanId);
  if (!original || !["failed", "cancelled"].includes(original.status) || original.engine !== "codex-security" || original.execution?.executionProfile !== "portable") throw new Error("resume_requires_interrupted_portable_scan");
  if (findProcessIdentitiesForScanDir(original.scanDir).length > 0) throw new Error("resume_source_still_running");
  const config = readPortableCodexSecurityWorkerConfiguration(path.join(original.scanDir, "portable-codex-security-run.json"));
  const previous = readPortableCodexSecurityRuntime(original.scanDir);
  if (!previous?.snapshotId || previous.stage !== "discovery") throw new Error("resume_requires_discovery_checkpoint");
  const snapshotRoot = path.join(original.scanDir, "portable-codex-security-snapshot");
  assertPortableCodexSecuritySnapshot({ snapshotRoot, snapshotId: previous.snapshotId });
  const plan = createPortableDeepCoveragePlan(snapshotRoot);
  const artifacts = path.join(original.scanDir, "portable-codex-security-artifacts");
  let base = createPortableCodexSecurityDossier();
  for (const stage of PORTABLE_CODEX_SECURITY_STAGES.slice(0, 2)) {
    base = applyPortableCodexSecurityStageArtifact(base, assertExactStageArtifact(path.join(artifacts, stage.id), stage));
    assertPortableCodexSecurityDossierAnchors(snapshotRoot, base);
  }
  let completed = 0;
  for (const partition of plan.partitions) {
    const root = path.join(artifacts, `discovery-${String(partition.index + 1).padStart(3, "0")}`);
    if (!fs.existsSync(root) || fs.readdirSync(root).length === 0) continue;
    const restored = applyPortableCodexSecurityStageArtifact(base, assertExactStageArtifact(root, { artifact: "03-discovery.json" }));
    assertPortableCodexSecurityDossierAnchors(snapshotRoot, restored);
    if (partition.paths.some(file => !restored.scope.inspected.includes(file))) throw new Error("resume_incomplete_partition");
    completed++;
  }
  console.log(JSON.stringify({ sourceScanId: scanId, snapshotId: previous.snapshotId, verifiedBatches: completed, totalBatches: plan.partitions.length, dryRun }));
  if (dryRun) return;
  const id = nanoid(12);
  if (!reserveScanCapacity(id, MAX_CONCURRENT_SCANS)) throw new Error("scan_capacity_full");
  try {
    const runtime = getProviderRuntime();
    const frozen = runtime.store.getSnapshot(scanId);
    if (!frozen?.modelId) throw new Error("resume_missing_connection_snapshot");
    const probe = await runtime.connections.probe(frozen.connectionId, { connectionId: frozen.connectionId, modelId: frozen.modelId, modelSelectionMode: "catalog" });
    if (probe?.report.status !== "passed") throw new Error("resume_capability_probe_failed");
    const outputDir = path.join(path.dirname(original.scanDir), `csb-resumed-${id}`);
    fs.mkdirSync(outputDir, { mode: 0o700 });
    for (const name of ["portable-codex-security-snapshot", "portable-codex-security-artifacts"]) fs.cpSync(path.join(original.scanDir, name), path.join(outputDir, name), { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    // Node cp creates directories with default permissions; preserve both the
    // read-only snapshot and private artifact directories before starting.
    function restoreDirectoryModes(source: string, copied: string): void {
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (entry.isDirectory()) restoreDirectoryModes(path.join(source, entry.name), path.join(copied, entry.name));
      }
      fs.chmodSync(copied, fs.statSync(source).mode & 0o777);
    }
    for (const name of ["portable-codex-security-snapshot", "portable-codex-security-artifacts"]) {
      restoreDirectoryModes(path.join(original.scanDir, name), path.join(outputDir, name));
    }
    assertPortableCodexSecuritySnapshot({ snapshotRoot: path.join(outputDir, "portable-codex-security-snapshot"), snapshotId: previous.snapshotId! });
    fs.writeFileSync(path.join(outputDir, "portable-codex-security-runtime.json"), JSON.stringify(previous), { mode: 0o600 });
    for (const name of ["portable-codex-security-pricing.json", "scanner-pricing.json"]) if (fs.existsSync(path.join(original.scanDir, name))) fs.copyFileSync(path.join(original.scanDir, name), path.join(outputDir, name));
    const legacyLog = cliLogPath(original.scanDir);
    if (fs.existsSync(legacyLog)) {
      fs.copyFileSync(legacyLog, cliLogPath(outputDir));
      fs.copyFileSync(legacyLog, path.join(outputDir, "portable-worker-events.log"));
    }
    const resumedConfig = { ...config, outputDir, limits: { ...config.limits, totalTimeoutMs: 0 }, providerPlan: { ...config.providerPlan, scanId: id, capabilityCheckId: probe.report.id } };
    const configPath = path.join(outputDir, "portable-codex-security-run.json");
    fs.writeFileSync(configPath, JSON.stringify(resumedConfig), { mode: 0o600 });
    fs.writeFileSync(path.join(outputDir, "resume-source.json"), JSON.stringify({ scanId, resumedAt: new Date().toISOString(), verifiedBatches: completed, snapshotId: previous.snapshotId }), { mode: 0o600 });
    runtime.store.writeSnapshot({ ...frozen, scanId: id, capabilityCheckId: probe.report.id, capturedAt: new Date().toISOString() });
    const run = { ...original, id, scanDir: outputDir, status: "queued" as const, displayName: `${original.displayName} · resumed`, pid: null, completedAt: null, durationMs: null, progress: null, execution: { ...original.execution, capabilityCheckId: probe.report.id } };
    upsertRun(run);
    const fd = fs.openSync(cliLogPath(outputDir), "a", 0o600);
    const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "portable-codex-security-worker.ts"), configPath, "--resume-discovery"], { cwd: path.resolve(import.meta.dirname, "../.."), detached: true, stdio: ["ignore", fd, fd], env: process.env });
    fs.closeSync(fd);
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const identity = captureProcessIdentity(child.pid!, outputDir);
    if (!identity || !persistProcessIdentity(outputDir, identity)) { child.kill("SIGTERM"); throw new Error("resume_process_identity_failed"); }
    upsertRun({ ...run, status: "running", pid: child.pid! });
    child.unref();
    console.log(JSON.stringify({ resumedScanId: id, pid: child.pid, verifiedBatches: completed, outputDir }));
  } catch (error) { releaseScanCapacity(id); throw error; }
}
if (process.argv[1]?.endsWith("resume-portable-scan.ts")) {
  void resume(process.argv[2] ?? "", process.argv.includes("--dry-run")).catch(() => { console.error("portable_scan_resume_failed"); process.exitCode = 1; });
}
