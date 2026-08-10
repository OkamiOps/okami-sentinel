import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CODEX_BIN } from "../config.js";
import { createResilientLineWriter } from "./mantis-runtime.js";
import { normalizeVulnHunterWorkspace } from "./vulnhunter-normalize.js";
import {
  buildVulnHunterFinalizationPrompt,
  buildVulnHunterPrompt,
  summarizeVulnHunterEvent,
  VULNHUNTER_CODEX_ISOLATION_ARGS,
  type VulnHunterRunConfiguration,
  type VulnHunterRuntimeState,
  writeVulnHunterRuntime,
} from "./vulnhunter-runtime.js";
import {
  assertVulnHunterNonOperationalArtifacts,
  createVulnHunterSnapshot,
  inferVulnHunterStage,
  validVulnHunterSkillRoot,
} from "./vulnhunter-worker-support.js";

let currentChild: ChildProcess | null = null;
let cancelled = false;
let runtime: VulnHunterRuntimeState | null = null;
let outputDirForSignal: string | null = null;
const log = createResilientLineWriter(process.stdout);

function progress(
  config: VulnHunterRunConfiguration,
  update: Partial<VulnHunterRuntimeState>,
): void {
  if (!runtime) throw new Error("VulnHunter runtime was not initialized.");
  runtime = { ...runtime, ...update, updatedAt: new Date().toISOString() };
  writeVulnHunterRuntime(config.outputDir, runtime);
  log(
    `SENTINEL_PROGRESS ${JSON.stringify({
      percent: runtime.percent,
      phaseLabel: runtime.stageLabel,
      detail: runtime.detail,
      stage: runtime.stage,
      findings: runtime.findings,
    })}`,
  );
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: 5 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
}

function ensureVulnHunterSource(config: VulnHunterRunConfiguration): string {
  const configured = process.env.VULNHUNTER_SKILL_DIR?.trim();
  if (configured) {
    const skillRoot = path.resolve(configured);
    if (!validVulnHunterSkillRoot(skillRoot)) {
      throw new Error(`VULNHUNTER_SKILL_DIR is incomplete: ${skillRoot}`);
    }
    return skillRoot;
  }

  fs.mkdirSync(config.source.cacheDir, { recursive: true, mode: 0o700 });
  const stableDir = path.join(config.source.cacheDir, config.source.ref.slice(0, 12));
  const stableSkillRoot = path.join(stableDir, "vulnhunt");
  if (validVulnHunterSkillRoot(stableSkillRoot)) return stableSkillRoot;

  const checkoutDir = `${stableDir}.checkout-${process.pid}-${Date.now()}`;
  log(`[vulnhunter/bootstrap] Fetching reviewed source ${config.source.ref.slice(0, 12)}.`);
  run(
    "git",
    ["clone", "--filter=blob:none", "--no-checkout", config.source.repositoryUrl, checkoutDir],
    config.source.cacheDir,
  );
  run("git", ["-C", checkoutDir, "checkout", "--detach", config.source.ref], config.source.cacheDir);
  const checkoutSkillRoot = path.join(checkoutDir, "vulnhunt");
  if (!validVulnHunterSkillRoot(checkoutSkillRoot)) {
    throw new Error("Fetched VulnHunter source is missing the reviewed skill phases.");
  }
  if (!fs.existsSync(stableDir)) fs.renameSync(checkoutDir, stableDir);
  return validVulnHunterSkillRoot(stableSkillRoot) ? stableSkillRoot : checkoutSkillRoot;
}

function gitValue(repositoryPath: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value || null;
}

function scanMetadata(repositoryPath: string): { branchLabel: string; repositoryUrl: string } {
  const branch = gitValue(repositoryPath, ["branch", "--show-current"]);
  const revision = gitValue(repositoryPath, ["rev-parse", "--short=12", "HEAD"]);
  const repositoryUrl = gitValue(repositoryPath, ["remote", "get-url", "origin"])
    ?? path.basename(repositoryPath);
  return {
    branchLabel: branch && revision ? `${branch} [${revision}]` : revision ? `detached [${revision}]` : "unknown",
    repositoryUrl,
  };
}

function collectUsage(value: unknown, totals: VulnHunterRuntimeState["usage"]): void {
  if (!value || typeof value !== "object") return;
  const usage = (value as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return;
  const item = usage as Record<string, unknown>;
  totals.inputTokens += Number(item.input_tokens ?? item.inputTokens ?? 0) || 0;
  totals.cachedInputTokens += Number(item.cached_input_tokens ?? item.cachedInputTokens ?? 0) || 0;
  totals.outputTokens += Number(item.output_tokens ?? item.outputTokens ?? 0) || 0;
}

function updateArtifactStage(
  config: VulnHunterRunConfiguration,
  resultsDir: string,
  detail?: string,
): void {
  if (!runtime || runtime.status !== "running") return;
  const stage = inferVulnHunterStage(resultsDir);
  const stageChanged = stage.id !== runtime.stage;
  if (!stageChanged && !detail) return;
  progress(config, {
    stage: stage.id,
    stageLabel: stage.label,
    percent: stage.percent,
    detail: detail ?? `${stage.label} artifacts detected`,
  });
}

async function runVulnHunter(
  config: VulnHunterRunConfiguration,
  skillRoot: string,
  snapshotRoot: string,
  resultsDir: string,
  branchLabel: string,
  repositoryUrl: string,
): Promise<void> {
  const stateRoot = path.dirname(resultsDir);
  const logDir = path.join(config.outputDir, "vulnhunter-logs");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const prompt = buildVulnHunterPrompt({
    skillPath: path.join(skillRoot, "SKILL.md"),
    snapshotRoot,
    resultsDir,
    branchLabel,
    repositoryUrl,
    model: config.model,
    scopePaths: config.paths,
  });
  await runCodexSession(config, stateRoot, resultsDir, prompt, "scan.jsonl", true);
}

async function runVulnHunterFinalization(
  config: VulnHunterRunConfiguration,
  snapshotRoot: string,
  resultsDir: string,
): Promise<void> {
  const stateRoot = path.dirname(resultsDir);
  const prompt = buildVulnHunterFinalizationPrompt({
    snapshotRoot,
    resultsDir,
    scopePaths: config.paths,
  });
  await runCodexSession(
    config,
    stateRoot,
    resultsDir,
    prompt,
    "finalization.jsonl",
    false,
  );
}

async function runCodexSession(
  config: VulnHunterRunConfiguration,
  stateRoot: string,
  resultsDir: string,
  prompt: string,
  logName: string,
  multiAgent: boolean,
): Promise<void> {
  const logDir = path.join(config.outputDir, "vulnhunter-logs");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, logName);
  const args = [
    ...VULNHUNTER_CODEX_ISOLATION_ARGS,
    multiAgent ? "--enable" : "--disable",
    "multi_agent",
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--model",
    config.model,
    "--sandbox",
    "workspace-write",
    "--cd",
    stateRoot,
    "-c",
    `model_reasoning_effort=${JSON.stringify(config.effort)}`,
    prompt,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: stateRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    currentChild = child;
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let lastActivityAt = 0;
    let stderrNoticeShown = false;
    let fatalMessage: string | null = null;
    const stdout = readline.createInterface({ input: child.stdout! });
    const stderr = readline.createInterface({ input: child.stderr! });
    const stageTimer = setInterval(() => updateArtifactStage(config, resultsDir), 2_000);

    stdout.on("line", (line) => {
      fs.appendFileSync(logPath, `${line}\n`, "utf8");
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "turn.completed") collectUsage(event, usage);
        if (event.type === "error" && typeof event.message === "string") {
          fatalMessage = event.message.replace(/\s+/g, " ").trim().slice(0, 600);
        }
        const activity = summarizeVulnHunterEvent(event);
        const nowMs = Date.now();
        if (activity && runtime && nowMs - lastActivityAt >= 1_000) {
          lastActivityAt = nowMs;
          const now = new Date(nowMs).toISOString();
          runtime = {
            ...runtime,
            lastActivityAt: now,
            activitySequence: (runtime.activitySequence ?? 0) + 1,
          };
          updateArtifactStage(config, resultsDir, activity);
          log(`[vulnhunter/${runtime.stage}] ${activity}`);
        }
      } catch {
        // Preserve unknown JSONL records locally without presenting their contents as progress.
      }
    });
    stderr.on("line", (line) => {
      fs.appendFileSync(logPath, `${JSON.stringify({ stream: "stderr", line })}\n`, "utf8");
      if (!stderrNoticeShown) {
        stderrNoticeShown = true;
        log("[vulnhunter/runtime] Codex diagnostics captured in the local scan log.");
      }
    });

    child.on("error", (error) => {
      clearInterval(stageTimer);
      reject(error);
    });
    child.on("close", (code) => {
      clearInterval(stageTimer);
      currentChild = null;
      if (runtime) {
        runtime.usage.inputTokens += usage.inputTokens;
        runtime.usage.cachedInputTokens += usage.cachedInputTokens;
        runtime.usage.outputTokens += usage.outputTokens;
      }
      if (cancelled) reject(new Error("VulnHunter scan cancelled."));
      else if (code === 0) resolve();
      else {
        const detail = fatalMessage ? `: ${fatalMessage}` : ".";
        reject(new Error(`VulnHunter Codex session failed with exit ${code}${detail}`));
      }
    });
  });
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Usage: vulnhunter-worker <config.json>");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as VulnHunterRunConfiguration;
  config.outputDir = path.resolve(config.outputDir);
  config.repositoryPath = path.resolve(config.repositoryPath);
  if (config.readOnly !== true) throw new Error("VulnHunter Codex port requires readOnly=true.");
  outputDirForSignal = config.outputDir;
  const startedAt = new Date().toISOString();
  runtime = {
    engine: "vulnhunter",
    status: "preparing",
    stage: "bootstrap",
    stageLabel: "VulnHunter bootstrap",
    percent: 2,
    detail: "verifying the pinned upstream skill",
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    snapshotId: null,
    sourceRef: config.source.ref,
    findings: 0,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    error: null,
  };
  writeVulnHunterRuntime(config.outputDir, runtime);

  const metadata = scanMetadata(config.repositoryPath);
  const skillRoot = ensureVulnHunterSource(config);
  progress(config, { percent: 5, detail: "creating an immutable source snapshot" });
  const { snapshotRoot, snapshotId } = createVulnHunterSnapshot(
    config.repositoryPath,
    config.outputDir,
  );
  const stateRoot = path.join(config.outputDir, "vulnhunter");
  const resultsDir = path.join(stateRoot, "results");
  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  progress(config, {
    status: "running",
    stage: "recon",
    stageLabel: "Repository reconnaissance",
    percent: 8,
    detail: "snapshot pinned; starting agent-driven static analysis",
    snapshotId,
  });

  try {
    await runVulnHunter(
      config,
      skillRoot,
      snapshotRoot,
      resultsDir,
      metadata.branchLabel,
      metadata.repositoryUrl,
    );
  } catch (error) {
    if (cancelled || !fs.existsSync(path.join(resultsDir, "phase3d_output.md"))) throw error;
    log(
      `[vulnhunter/report] Analysis artifacts are complete; continuing with the isolated defensive finalizer after: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertVulnHunterNonOperationalArtifacts(resultsDir);
  if (!fs.existsSync(path.join(resultsDir, "phase3d_output.md"))) {
    throw new Error("VulnHunter completed without the required phase3d_output.md sweep.");
  }
  progress(config, {
    stage: "report",
    stageLabel: "Defensive evidence handoff",
    percent: 92,
    detail: "assembling verified static evidence for Sentinel",
  });
  if (!fs.existsSync(path.join(resultsDir, "sentinel-findings.json"))) {
    await runVulnHunterFinalization(config, snapshotRoot, resultsDir);
  }
  assertVulnHunterNonOperationalArtifacts(resultsDir);
  if (!fs.existsSync(path.join(resultsDir, "sentinel-findings.json"))) {
    throw new Error("VulnHunter completed without the required sentinel-findings.json handoff.");
  }
  progress(config, {
    stage: "normalize",
    stageLabel: "Normalize evidence",
    percent: 99,
    detail: "mapping verified VulnHunter traces into Sentinel's canonical schema",
  });
  const findings = normalizeVulnHunterWorkspace(resultsDir, config.outputDir);
  progress(config, {
    status: "completed",
    stage: "complete",
    stageLabel: "Complete",
    percent: 100,
    detail: `${findings} reportable findings normalized`,
    findings,
    completedAt: new Date().toISOString(),
  });
}

process.on("SIGTERM", () => {
  cancelled = true;
  currentChild?.kill("SIGTERM");
  if (runtime && outputDirForSignal) {
    const now = new Date().toISOString();
    runtime = {
      ...runtime,
      status: "cancelled",
      detail: "cancellation requested",
      completedAt: now,
      updatedAt: now,
    };
    writeVulnHunterRuntime(outputDirForSignal, runtime);
  }
});

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (runtime && outputDirForSignal) {
    let recoveredFindings = runtime.findings;
    const resultsDir = path.join(outputDirForSignal, "vulnhunter", "results");
    if (fs.existsSync(path.join(resultsDir, "sentinel-findings.json"))) {
      try {
        recoveredFindings = normalizeVulnHunterWorkspace(resultsDir, outputDirForSignal);
        if (recoveredFindings > 0) {
          log(`[vulnhunter/recovery] Preserved ${recoveredFindings} partial findings.`);
        }
      } catch (normalizationError) {
        log(
          `[vulnhunter/recovery] Partial normalization failed: ${normalizationError instanceof Error ? normalizationError.message : String(normalizationError)}`,
        );
      }
    }
    const now = new Date().toISOString();
    runtime = {
      ...runtime,
      status: cancelled ? "cancelled" : "failed",
      detail: message,
      findings: recoveredFindings,
      error: message,
      completedAt: now,
      updatedAt: now,
    };
    writeVulnHunterRuntime(outputDirForSignal, runtime);
  }
  process.stderr.write(`[vulnhunter] ${message}\n`);
  process.exitCode = cancelled ? 143 : 1;
});
