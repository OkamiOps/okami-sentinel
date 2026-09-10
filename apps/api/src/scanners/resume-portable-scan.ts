import { resolveDeepPlan, DEEP_PLAN_FILE } from "./portable-deep-plan.js";
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
import { assertPortableCodexSecuritySnapshot, assertExactStageArtifact, assertPortableCodexSecurityDossierAnchors, assertPortableCodexSecurityReportAnchors } from "./portable-codex-security-worker-support.js";
import { createPortableCodexSecurityDossier, applyPortableCodexSecurityStageArtifact, validatePortableCodexSecurityReportCoverage } from "./portable-codex-security-dossier.js";
import { mergePortableDeepDiscoveryDossiers } from "./portable-codex-security-deep-coverage.js";
import { createPortableAssessmentPages, assessmentPageDirectory } from "./portable-codex-security-assessment-pages.js";
import { createPortableCodexSecurityReportShards } from "./portable-codex-security-report-shards.js";
import { PORTABLE_CODEX_SECURITY_STAGES } from "./portable-codex-security-profile.js";

/** Read-only checkpoint validation, shared by dry-run and actual recovery. */
export function preflightPortableResume(scanDir: string, mode: "standard" | "deep") {
  const previous = readPortableCodexSecurityRuntime(scanDir);
  const resumable = ["discovery", "dataflow", "validation", "report"];
  if (!previous?.snapshotId || !resumable.includes(previous.stage ?? "") || previous.status === "completed") throw new Error("resume_requires_checkpoint");
  const snapshotRoot = path.join(scanDir, "portable-codex-security-snapshot");
  assertPortableCodexSecuritySnapshot({ snapshotRoot, snapshotId: previous.snapshotId });
  const artifacts = path.join(scanDir, "portable-codex-security-artifacts");
  const accepted = new Set<string>();
  function read(name: string, artifact: (typeof PORTABLE_CODEX_SECURITY_STAGES)[number]["artifact"]) {
    const root = path.join(artifacts, name);
    if (!fs.existsSync(root)) return null;
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("resume_invalid_checkpoint_directory");
    accepted.add(name);
    if (fs.readdirSync(root).length === 0) return null;
    return assertExactStageArtifact(root, { artifact });
  }
  let dossier = createPortableCodexSecurityDossier();
  for (const stage of PORTABLE_CODEX_SECURITY_STAGES.slice(0, 2)) {
    const artifact = read(stage.id, stage.artifact);
    if (!artifact) throw new Error("resume_missing_prerequisite_checkpoint");
    dossier = applyPortableCodexSecurityStageArtifact(dossier, artifact);
    assertPortableCodexSecurityDossierAnchors(snapshotRoot, dossier);
  }
  let completed = 0;
  let totalBatches = 1;
  let discoveryComplete = false;
  if (mode === "deep") {
    const plan = resolveDeepPlan({ snapshotRoot, snapshotId: previous.snapshotId!, outputDir: scanDir, resume: true });
    totalBatches = plan.partitions.length;
    const pages: typeof dossier[] = [];
    for (const partition of plan.partitions) {
      const artifact = read(`discovery-${String(partition.index + 1).padStart(3, "0")}`, "03-discovery.json");
      if (!artifact) continue;
      const restored = applyPortableCodexSecurityStageArtifact(dossier, artifact);
      assertPortableCodexSecurityDossierAnchors(snapshotRoot, restored);
      if (partition.paths.some(file => !restored.scope.inspected.includes(file))) throw new Error("resume_incomplete_partition");
      pages.push(restored); completed++;
    }
    discoveryComplete = completed === totalBatches;
    if (discoveryComplete) dossier = mergePortableDeepDiscoveryDossiers(dossier, pages, plan);
  } else {
    for (const name of ["discovery", "discovery-review"]) {
      const artifact = read(name, "03-discovery.json");
      if (!artifact) continue;
      if (name === "discovery-review" && completed === 0) throw new Error("resume_missing_prerequisite_checkpoint");
      dossier = applyPortableCodexSecurityStageArtifact({ ...dossier, stageSummaries: dossier.stageSummaries.filter(s => s.stage !== "discovery") }, artifact);
      assertPortableCodexSecurityDossierAnchors(snapshotRoot, dossier);
      completed++;
    }
    totalBatches = 2;
    discoveryComplete = completed === 2;
  }
  if (previous.stage !== "discovery" && !discoveryComplete) throw new Error("resume_missing_prerequisite_checkpoint");
  const verifiedStages: Record<string, number> = { discovery: completed };
  let prerequisiteComplete = discoveryComplete;
  for (const stage of PORTABLE_CODEX_SECURITY_STAGES.filter(s => s.id === "dataflow" || s.id === "validation")) {
    const paged = mode === "deep" && dossier.candidates.length > (stage.id === "validation" ? 8 : 32);
    const pages = paged ? createPortableAssessmentPages(dossier, stage.id, index => {
      // Validate an existing legacy page even when it is not selected for replay.
      return read(assessmentPageDirectory(stage.id, { index }), stage.artifact) !== null;
    }) : [{ index: 0, total: 1, dossier }];
    const count = pages.length;
    const restoredPages: typeof dossier[] = [];
    for (const page of pages) {
      const artifact = read(paged ? assessmentPageDirectory(stage.id, page) : stage.id, stage.artifact);
      if (!artifact) continue;
      if (!prerequisiteComplete) throw new Error("resume_missing_prerequisite_checkpoint");
      const restored = applyPortableCodexSecurityStageArtifact(page.dossier, artifact);
      assertPortableCodexSecurityDossierAnchors(snapshotRoot, restored);
      const assessments = restored.assessments.filter(a => a.stage === stage.id);
      if (assessments.length !== page.dossier.candidates.length || page.dossier.candidates.some(c => !assessments.some(a => a.candidateId === c.id))) throw new Error("resume_incomplete_assessment_page");
      restoredPages.push(restored);
    }
    verifiedStages[stage.id] = restoredPages.length;
    prerequisiteComplete = prerequisiteComplete && restoredPages.length === count;
    if (prerequisiteComplete) dossier = { ...dossier,
      stageSummaries: [...dossier.stageSummaries, ...restoredPages[0]!.stageSummaries.filter(s => s.stage === stage.id)],
      assessments: [...dossier.assessments, ...restoredPages.flatMap(p => p.assessments.filter(a => a.stage === stage.id))] };
    if (resumable.indexOf(previous.stage!) > resumable.indexOf(stage.id) && !prerequisiteComplete) throw new Error("resume_missing_prerequisite_checkpoint");
  }
  verifiedStages.report = 0;
  for (const shard of prerequisiteComplete ? createPortableCodexSecurityReportShards(dossier) : []) {
    const artifact = read(`report-${String(shard.index + 1).padStart(2, "0")}`, "sentinel-findings.json");
    if (!artifact) continue;
    if (!prerequisiteComplete) throw new Error("resume_missing_prerequisite_checkpoint");
    const report = validatePortableCodexSecurityReportCoverage(artifact, shard.dossier);
    assertPortableCodexSecurityReportAnchors(snapshotRoot, report);
    verifiedStages.report++;
  }
  for (const entry of fs.readdirSync(artifacts)) {
    if (!accepted.has(entry)) throw new Error("resume_unrecognized_checkpoint");
  }
  return { previous, completed, totalBatches, verifiedStages, dossier };
}

/** Local operator recovery. Does not mutate or overwrite the interrupted run. */
async function resume(scanId: string, dryRun: boolean) {
  const original = getRun(scanId);
  if (!original || !["failed", "cancelled"].includes(original.status) || original.engine !== "codex-security" || original.execution?.executionProfile !== "portable") throw new Error("resume_requires_interrupted_portable_scan");
  if (findProcessIdentitiesForScanDir(original.scanDir).length > 0) throw new Error("resume_source_still_running");
  const config = readPortableCodexSecurityWorkerConfiguration(path.join(original.scanDir, "portable-codex-security-run.json"));
  const { previous, completed, totalBatches, verifiedStages } = preflightPortableResume(original.scanDir, config.mode);
  console.log(JSON.stringify({ sourceScanId: scanId, snapshotId: previous.snapshotId, verifiedBatches: completed, totalBatches, verifiedStages, dryRun }));
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
    for (const name of ["portable-codex-security-pricing.json", "scanner-pricing.json", DEEP_PLAN_FILE]) if (fs.existsSync(path.join(original.scanDir, name))) fs.copyFileSync(path.join(original.scanDir, name), path.join(outputDir, name));
    // Preserve accepted recovery fragments and attempt budgets across a new run ID.
    const recoveryRoot = path.join(original.scanDir, "portable-recovery");
    if (fs.existsSync(recoveryRoot)) {
      fs.cpSync(recoveryRoot, path.join(outputDir, "portable-recovery"), { recursive: true, preserveTimestamps: true,
        errorOnExist: true, force: false, filter: source => {
          const stat = fs.lstatSync(source);
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("resume_invalid_recovery_state");
          return !/^[a-f0-9]{64}\.lock$/.test(path.basename(source));
        } });
    }
    const legacyLog = cliLogPath(original.scanDir);
    if (fs.existsSync(legacyLog)) {
      fs.copyFileSync(legacyLog, cliLogPath(outputDir));
    }
    const workerLog = path.join(original.scanDir, "portable-worker-events.log");
    const eventLog = fs.existsSync(workerLog) ? workerLog : legacyLog;
    if (fs.existsSync(eventLog)) fs.copyFileSync(eventLog, path.join(outputDir, "portable-worker-events.log"));
    const resumedConfig = { ...config, outputDir, limits: { ...config.limits, totalTimeoutMs: 0 }, providerPlan: { ...config.providerPlan, scanId: id, capabilityCheckId: probe.report.id } };
    const configPath = path.join(outputDir, "portable-codex-security-run.json");
    fs.writeFileSync(configPath, JSON.stringify(resumedConfig), { mode: 0o600 });
    fs.writeFileSync(path.join(outputDir, "resume-source.json"), JSON.stringify({ scanId, resumedAt: new Date().toISOString(), verifiedBatches: completed, verifiedStages, snapshotId: previous.snapshotId }), { mode: 0o600 });
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
    console.log(JSON.stringify({ resumedScanId: id, pid: child.pid, verifiedBatches: completed, verifiedStages, outputDir }));
  } catch (error) { releaseScanCapacity(id); throw error; }
}
if (process.argv[1]?.endsWith("resume-portable-scan.ts")) {
  void resume(process.argv[2] ?? "", process.argv.includes("--dry-run")).catch(() => { console.error("portable_scan_resume_failed"); process.exitCode = 1; });
}
