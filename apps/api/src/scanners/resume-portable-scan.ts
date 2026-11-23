import { resolveDeepPlan, DEEP_PLAN_FILE, STANDARD_PLAN_FILE } from "./portable-deep-plan.js";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { nanoid } from "nanoid";
import type { CapabilityReport, ScanRun } from "@csb/shared";
import { estimateFrozenScannerUsageCost, readScannerPricingQuote, frozenScannerPricingSupportsCostBudget } from "../model-pricing.js";
import { getRun, upsertRun, reserveScanCapacity, releaseScanCapacity } from "../db.js";
import { MAX_CONCURRENT_SCANS } from "../config.js";
import { getProviderRuntime } from "../provider-runtime.js";
import { cliLogPath } from "../activity.js";
import { captureProcessIdentity, persistProcessIdentity, findProcessIdentitiesForScanDir } from "../process-identity.js";
import { readPortableCodexSecurityWorkerConfiguration } from "./portable-codex-security-worker.js";
import { readPortableCodexSecurityRuntime, type PortableCodexSecurityRuntimeState } from "./portable-codex-security-runtime.js";
import { assertPortableCodexSecuritySnapshot, assertExactStageArtifact, assertPortableCodexSecurityDossierAnchors, assertPortableCodexSecurityReportAnchors } from "./portable-codex-security-worker-support.js";
import { createPortableCodexSecurityDossier, applyPortableCodexSecurityStageArtifact, validatePortableCodexSecurityReportCoverage } from "./portable-codex-security-dossier.js";
import { mergePortableDeepDiscoveryDossiers } from "./portable-codex-security-deep-coverage.js";
import { PORTABLE_CANDIDATE_GROUPS_FILE, groupPortableCandidatesBeforeReview } from "./portable-codex-security-candidate-groups.js";
import { createPortableAssessmentPages, assessmentPageDirectory } from "./portable-codex-security-assessment-pages.js";
import { createPortableCodexSecurityReportShards } from "./portable-codex-security-report-shards.js";
import { PORTABLE_CODEX_SECURITY_STAGES } from "./portable-codex-security-profile.js";
import { assertBudgetResumeCap, assertResumeSpendAndHolds } from "./portable-budget-partial.js";
import { readPortableReviewReuse, restorePortableReviewReuse, REVIEW_REUSE_FILE } from "./portable-review-reuse.js";
import { addPortableSastCandidates, PORTABLE_SAST_TRIAGE_FILE, readPortableSastTriage } from "./portable-sast-triage.js";
import { BUSINESS_LOGIC_FILE, BUSINESS_LOGIC_ARTIFACT } from "./portable-business-logic.js";

/** Read-only checkpoint validation, shared by dry-run and actual recovery. */
export function preflightPortableResume(scanDir: string, mode: "standard" | "deep", scopePaths?: readonly string[]) {
  const previous = readPortableCodexSecurityRuntime(scanDir);
  const resumable = ["inventory", "threat-model", "discovery", "dataflow", "validation", "report", "normalize"];
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
  if ((previous.budgetPartial || previous.providerPartial) && ["inventory", "threat-model"].includes(previous.stage)) {
    const verifiedStages: Record<string, number> = {};
    for (const stage of PORTABLE_CODEX_SECURITY_STAGES.slice(0, 2)) {
      const artifact = read(stage.id, stage.artifact);
      if (artifact) {
        dossier = applyPortableCodexSecurityStageArtifact(dossier, artifact);
        assertPortableCodexSecurityDossierAnchors(snapshotRoot, dossier);
        verifiedStages[stage.id] = 1;
      } else if (stage.id !== previous.stage) throw new Error("resume_missing_prerequisite_checkpoint");
      if (stage.id === previous.stage) break;
    }
    if (fs.readdirSync(artifacts).some(entry => !accepted.has(entry))) throw new Error("resume_unrecognized_checkpoint");
    return { previous, completed: 0, totalBatches: 0, verifiedStages, dossier };
  }
  for (const stage of PORTABLE_CODEX_SECURITY_STAGES.slice(0, 2)) {
    const artifact = read(stage.id, stage.artifact);
    if (!artifact) throw new Error("resume_missing_prerequisite_checkpoint");
    dossier = applyPortableCodexSecurityStageArtifact(dossier, artifact);
    assertPortableCodexSecurityDossierAnchors(snapshotRoot, dossier);
  }
  let completed = 0;
  let totalBatches = 1;
  let discoveryComplete = false;
  const fullCoverage = mode === "deep" || fs.existsSync(path.join(scanDir, STANDARD_PLAN_FILE));
  if (fullCoverage) {
    const plan = resolveDeepPlan({ snapshotRoot, snapshotId: previous.snapshotId!, outputDir: scanDir, resume: true, mode, scopePaths });
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
  const verifiedStages: Record<string, number> = { inventory: 1, "threat-model": 1, discovery: completed };
  let prerequisiteComplete = discoveryComplete;
  if (discoveryComplete) {
    dossier = groupPortableCandidatesBeforeReview(dossier, artifacts, { resume: true, persist: false });
    dossier = addPortableSastCandidates(dossier, readPortableSastTriage(scanDir));
    if (fs.existsSync(path.join(artifacts, PORTABLE_CANDIDATE_GROUPS_FILE))) accepted.add(PORTABLE_CANDIDATE_GROUPS_FILE);
    const reuse = readPortableReviewReuse(scanDir);
    if (reuse) dossier = restorePortableReviewReuse(dossier, snapshotRoot, reuse);
  }
  const reusedIds = new Set(readPortableReviewReuse(scanDir)?.candidates.map(c => c.candidateId) ?? []);
  for (const stage of PORTABLE_CODEX_SECURITY_STAGES.filter(s => s.id === "dataflow" || s.id === "validation")) {
    const fullDossier = dossier;
    dossier = { ...dossier, candidates: dossier.candidates.filter(c => !reusedIds.has(c.id)),
      assessments: dossier.assessments.filter(a => !reusedIds.has(a.candidateId)) };
    if (dossier.candidates.length === 0 && reusedIds.size > 0) {
      dossier = fullDossier;
      verifiedStages[stage.id] = 0;
      continue;
    }
    const paged = fullCoverage && dossier.candidates.length > (stage.id === "validation" ? 8 : 32);
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
    dossier = { ...dossier, candidates: fullDossier.candidates,
      assessments: [...dossier.assessments, ...fullDossier.assessments.filter(a => reusedIds.has(a.candidateId))] };
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
    if (entry === "business-logic") {
      const root = path.join(artifacts, entry);
      if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("resume_invalid_checkpoint_directory");
      for (const page of fs.readdirSync(root)) {
        const directory = path.join(root, page);
        if (!/^business-logic-\d{2,}$/.test(page) || !fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error("resume_unrecognized_checkpoint");
        for (const file of fs.readdirSync(directory)) {
          if (file !== BUSINESS_LOGIC_ARTIFACT || !fs.lstatSync(path.join(directory, file)).isFile()) throw new Error("resume_unrecognized_checkpoint");
        }
      }
      accepted.add(entry);
    }
    if (!accepted.has(entry)) throw new Error("resume_unrecognized_checkpoint");
  }
  if (previous.stage === "normalize") {
    const shards = createPortableCodexSecurityReportShards(dossier);
    if (shards.some(shard => shard.candidateIds.length > 0) && verifiedStages.report !== shards.length) throw new Error("resume_missing_prerequisite_checkpoint");
  }
  return { previous, completed, totalBatches, verifiedStages, dossier };
}

export function inspectPortableResume(original: ScanRun) {
  if (!["incomplete", "failed"].includes(original.status) || original.engine !== "codex-security" || original.execution?.executionProfile !== "portable") throw new Error("resume_requires_partial_portable_scan");
  if (findProcessIdentitiesForScanDir(original.scanDir).length > 0) throw new Error("resume_source_still_running");
  const config = readPortableCodexSecurityWorkerConfiguration(path.join(original.scanDir, "portable-codex-security-run.json"));
  if (!config.costBudget) {
    const pricing = readScannerPricingQuote(original.scanDir);
    if (!pricing || !frozenScannerPricingSupportsCostBudget(pricing)) throw new Error("resume_cost_unavailable");
    config.costBudget = { maxCostUsd: 200, pricing };
  }
  const { previous, completed, totalBatches, verifiedStages } = preflightPortableResume(original.scanDir, config.mode, config.paths);
  if (!["incomplete", "failed"].includes(previous.status)) throw new Error("resume_requires_checkpoint");
  const spentUsd = previous.budgetPartial?.spentUsd ?? (!previous.usage.reported ? 0
    : config.costBudget ? estimateFrozenScannerUsageCost(previous.usage, config.costBudget.pricing)?.estimatedUsd : undefined);
  if (config.costBudget && spentUsd === undefined) throw new Error("resume_cost_unavailable");
  const suggestedMaxCostUsd = Math.max(200, Math.ceil(Math.max(spentUsd ?? 0, config.costBudget?.maxCostUsd ?? 0) * 2));
  return { config, previous, completed, totalBatches, verifiedStages, spentUsd, suggestedMaxCostUsd };
}

export function portableResumeAvailability(original: ScanRun) {
  try {
    const { suggestedMaxCostUsd } = inspectPortableResume(original);
    if (!getProviderRuntime().store.getSnapshot(original.id)?.modelId) return undefined;
    return { suggestedMaxCostUsd };
  } catch { return undefined; }
}

export function preparePortableResumeRuntime(previous: PortableCodexSecurityRuntimeState): PortableCodexSecurityRuntimeState {
  return { ...previous, status: "preparing", completedAt: null, error: null, errorCode: null };
}

export async function probePortableResume<T extends { report: CapabilityReport }>(
  probe: () => Promise<T | null>,
  wait: (ms: number) => Promise<unknown> = delay,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let transient = false;
    try {
      const result = await probe();
      if (result?.report.status === "passed") return result;
      transient = transientResumeProbeFailure({ code: result?.report.errorCode });
    } catch (error) {
      transient = transientResumeProbeFailure(error);
    }
    if (!transient || attempt === 1) break;
    await wait(500);
  }
  throw new Error("resume_capability_probe_failed");
}

function transientResumeProbeFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown };
  return ["provider_unreachable", "rate_limited", "agent_time_limit", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(String(failure.code)) ||
    (typeof failure.status === "number" && (failure.status === 408 || failure.status === 429 || failure.status >= 500 && failure.status <= 599)) ||
    failure.name === "TimeoutError" || failure.name === "AbortError" ||
    (error instanceof TypeError && /fetch failed|failed to fetch|network error/i.test(error.message));
}

/** Does not mutate or overwrite the interrupted run. */
export async function resumeBudgetPortableScan(scanId: string, requestedMaxCostUsd?: number, dryRun = false) {
  const original = getRun(scanId);
  if (!original) throw new Error("resume_scan_not_found");
  if (!original.execution) throw new Error("resume_requires_partial_portable_scan");
  const { config, previous, completed, totalBatches, verifiedStages, spentUsd, suggestedMaxCostUsd } = inspectPortableResume(original);
  const maxCostUsd = requestedMaxCostUsd ?? suggestedMaxCostUsd;
  assertResumeSpendAndHolds(spentUsd ?? 0, previous.budgetReservedUsd ?? 0, maxCostUsd);
  if (previous.budgetPartial) assertBudgetResumeCap(previous.budgetPartial, maxCostUsd);
  console.log(JSON.stringify({ sourceScanId: scanId, snapshotId: previous.snapshotId, verifiedBatches: completed, totalBatches, verifiedStages, dryRun }));
  if (dryRun) return;
  const id = nanoid(12);
  if (!reserveScanCapacity(id, MAX_CONCURRENT_SCANS)) throw new Error("scan_capacity_full");
  try {
    const runtime = getProviderRuntime();
    const frozen = runtime.store.getSnapshot(scanId);
    if (!frozen?.modelId) throw new Error("resume_missing_connection_snapshot");
    const probe = await probePortableResume(() => runtime.connections.probe(frozen.connectionId, { connectionId: frozen.connectionId, modelId: frozen.modelId, modelSelectionMode: "catalog" }));
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
    fs.writeFileSync(path.join(outputDir, "portable-codex-security-runtime.json"), JSON.stringify(preparePortableResumeRuntime(previous)), { mode: 0o600 });
    for (const name of ["portable-codex-security-pricing.json", "scanner-pricing.json", DEEP_PLAN_FILE, STANDARD_PLAN_FILE, REVIEW_REUSE_FILE, PORTABLE_SAST_TRIAGE_FILE]) if (fs.existsSync(path.join(original.scanDir, name))) fs.copyFileSync(path.join(original.scanDir, name), path.join(outputDir, name));
    const businessRecord = path.join(original.scanDir, "portable-codex-security-results", BUSINESS_LOGIC_FILE);
    if (fs.existsSync(businessRecord)) {
      const results = path.join(outputDir, "portable-codex-security-results");
      fs.mkdirSync(results, { mode: 0o700 });
      fs.copyFileSync(businessRecord, path.join(results, BUSINESS_LOGIC_FILE));
    }
    const sastFiles = ["opengrep-findings.json", "opengrep-status.json"];
    if (sastFiles.some(name => fs.existsSync(path.join(original.scanDir, "sast", name)))) {
      fs.mkdirSync(path.join(outputDir, "sast"), { mode: 0o700 });
      for (const name of sastFiles) {
        const source = path.join(original.scanDir, "sast", name);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(outputDir, "sast", name));
      }
    }
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
    const resumedConfig = { ...config, graphify: config.graphify === true, outputDir, ...(config.costBudget ? { costBudget: { ...config.costBudget, maxCostUsd } } : {}), limits: { ...config.limits, totalTimeoutMs: 0 }, providerPlan: { ...config.providerPlan, scanId: id, capabilityCheckId: probe.report.id } };
    const configPath = path.join(outputDir, "portable-codex-security-run.json");
    fs.writeFileSync(configPath, JSON.stringify(resumedConfig), { mode: 0o600 });
    fs.writeFileSync(path.join(outputDir, "resume-source.json"), JSON.stringify({ scanId, resumedAt: new Date().toISOString(), verifiedBatches: completed, verifiedStages, snapshotId: previous.snapshotId }), { mode: 0o600 });
    runtime.store.writeSnapshot({ ...frozen, scanId: id, capabilityCheckId: probe.report.id, capturedAt: new Date().toISOString() });
    const run = { ...original, startedAt: new Date().toISOString(), cost: null, usage: null, statusReason: undefined, budgetPartial: undefined, providerPartial: undefined, resume: undefined, graphify: resumedConfig.graphify, id, scanDir: outputDir, status: "queued" as const, displayName: `${original.displayName} · resumed`, pid: null, completedAt: null, durationMs: null, progress: null, execution: { ...original.execution, capabilityCheckId: probe.report.id } };
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
    return id;
  } catch (error) { releaseScanCapacity(id); throw error; }
}
if (process.argv[1]?.endsWith("resume-portable-scan.ts")) {
  const capIndex = process.argv.indexOf("--max-cost-usd");
  void resumeBudgetPortableScan(process.argv[2] ?? "", capIndex < 0 ? NaN : Number(process.argv[capIndex + 1]), process.argv.includes("--dry-run"))
    .catch(error => { console.error(error instanceof Error && /^resume_[a-z_]+$/.test(error.message) ? error.message : "portable_scan_resume_failed"); process.exitCode = 1; });
}
