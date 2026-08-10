import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CODEX_BIN } from "../config.js";
import { normalizeMantisWorkspace } from "./mantis-normalize.js";
import {
  createResilientLineWriter,
  MANTIS_CODEX_ISOLATION_ARGS,
  type MantisRunConfiguration,
  type MantisRuntimeState,
  summarizeMantisEvent,
  writeMantisRuntime,
} from "./mantis-runtime.js";

interface StageDefinition {
  id: string;
  skill: string;
  label: string;
  startPercent: number;
  completePercent: number;
}

const STAGES: StageDefinition[] = [
  { id: "architecture", skill: "mantis-architecture", label: "Architecture", startPercent: 10, completePercent: 18 },
  { id: "threat-model", skill: "mantis-threat-model", label: "Threat model", startPercent: 18, completePercent: 27 },
  { id: "plan", skill: "mantis-plan", label: "Review plan", startPercent: 27, completePercent: 35 },
  { id: "researcher", skill: "mantis-researcher", label: "Research", startPercent: 35, completePercent: 58 },
  { id: "dedupe", skill: "mantis-dedupe", label: "Deduplication", startPercent: 58, completePercent: 67 },
  { id: "review", skill: "mantis-review", label: "Independent review", startPercent: 67, completePercent: 78 },
  { id: "critic", skill: "mantis-critic", label: "Production viability", startPercent: 78, completePercent: 87 },
  { id: "calibrate", skill: "mantis-calibrate", label: "Risk calibration", startPercent: 87, completePercent: 94 },
  { id: "report", skill: "mantis-report", label: "Evidence report", startPercent: 94, completePercent: 98 },
];

const SNAPSHOT_EXCLUDES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".cache",
]);

const REQUIRED_SKILLS = STAGES.map((stage) => stage.skill);
let currentChild: ChildProcess | null = null;
let cancelled = false;
let runtime: MantisRuntimeState | null = null;
let outputDirForSignal: string | null = null;
const log = createResilientLineWriter(process.stdout);

function progress(
  config: MantisRunConfiguration,
  update: Partial<MantisRuntimeState>,
): void {
  if (!runtime) throw new Error("Mantis runtime was not initialized.");
  runtime = {
    ...runtime,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  writeMantisRuntime(config.outputDir, runtime);
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
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
}

function validMantisSource(sourceRoot: string): boolean {
  return REQUIRED_SKILLS.every((skill) =>
    fs.existsSync(path.join(sourceRoot, skill, "SKILL.md")),
  );
}

function ensureMantisSource(config: MantisRunConfiguration): string {
  const configured = process.env.MANTIS_SKILLS_DIR?.trim();
  if (configured) {
    const sourceRoot = path.resolve(configured);
    if (!validMantisSource(sourceRoot)) {
      throw new Error(`MANTIS_SKILLS_DIR does not contain the required skills: ${sourceRoot}`);
    }
    return sourceRoot;
  }

  fs.mkdirSync(config.source.cacheDir, { recursive: true, mode: 0o700 });
  const stableDir = path.join(config.source.cacheDir, config.source.ref.slice(0, 12));
  if (validMantisSource(stableDir)) return stableDir;

  const checkoutDir = `${stableDir}.checkout-${process.pid}-${Date.now()}`;
  log(`[mantis/bootstrap] Fetching reviewed source ${config.source.ref.slice(0, 12)}.`);
  run(
    "git",
    ["clone", "--filter=blob:none", "--no-checkout", config.source.repositoryUrl, checkoutDir],
    config.source.cacheDir,
  );
  run("git", ["-C", checkoutDir, "checkout", "--detach", config.source.ref], config.source.cacheDir);
  if (!validMantisSource(checkoutDir)) {
    throw new Error("Fetched Mantis source is missing required scan-only skills.");
  }
  if (!fs.existsSync(stableDir)) fs.renameSync(checkoutDir, stableDir);
  return fs.existsSync(stableDir) ? stableDir : checkoutDir;
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function createSnapshot(config: MantisRunConfiguration): string {
  const sourceRoot = path.resolve(config.repositoryPath);
  const snapshotRoot = path.join(config.outputDir, "mantis-snapshot");
  if (!fs.statSync(sourceRoot).isDirectory()) throw new Error("Mantis target is not a directory.");
  if (inside(sourceRoot, config.outputDir)) {
    throw new Error("Mantis output directory cannot be nested inside the target repository.");
  }
  if (fs.existsSync(snapshotRoot)) {
    throw new Error("Mantis snapshot directory already exists; refusing to overwrite it.");
  }

  let entries = 0;
  fs.cpSync(sourceRoot, snapshotRoot, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    filter(source) {
      if (source === sourceRoot) return true;
      const relative = path.relative(sourceRoot, source);
      const segments = relative.split(path.sep);
      if (segments.some((segment) => SNAPSHOT_EXCLUDES.has(segment))) return false;
      try {
        if (fs.lstatSync(source).isSymbolicLink()) return false;
      } catch {
        return false;
      }
      entries += 1;
      if (entries > 500_000) {
        throw new Error("Mantis snapshot exceeds the 500,000-entry safety limit.");
      }
      return true;
    },
  });
  return snapshotRoot;
}

function listSnapshotFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function hashSnapshot(root: string): string {
  const hash = createHash("sha256");
  for (const file of listSnapshotFiles(root)) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return `content:${hash.digest("hex")}`;
}

function initializeState(stateRoot: string, snapshotRoot: string, snapshotId: string): void {
  const workspace = path.join(stateRoot, "workspace");
  fs.mkdirSync(path.join(workspace, "findings"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspace, "archive"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workspace, "learnings.jsonl"), "", { mode: 0o600 });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(snapshotRoot, ".mantis_snapshot_id"),
    `${snapshotId}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(workspace, ".mantis_state.json"),
    `${JSON.stringify(
      {
        pass_number: 1,
        last_updated: now,
        vcs_info: { vcs_type: "none", snapshot_id: snapshotId },
        active_snapshot: {
          root: snapshotRoot,
          snapshot_id: snapshotId,
          snapshot_pinned: true,
          pass: 1,
          vcs_type: "none",
        },
        snapshot_history: [
          { pass: 1, snapshot_id: snapshotId, snapshot_pinned: true, timestamp: now },
        ],
        changed_files_status: "UNKNOWN",
        changed_files_pass: 1,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function collectUsage(value: unknown, totals: MantisRuntimeState["usage"]): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const usage = record.usage;
  if (usage && typeof usage === "object") {
    const item = usage as Record<string, unknown>;
    totals.inputTokens += Number(item.input_tokens ?? item.inputTokens ?? 0) || 0;
    totals.cachedInputTokens += Number(item.cached_input_tokens ?? item.cachedInputTokens ?? 0) || 0;
    totals.outputTokens += Number(item.output_tokens ?? item.outputTokens ?? 0) || 0;
  }
}

function stagePrompt(
  stage: StageDefinition,
  sourceRoot: string,
  stateRoot: string,
  snapshotRoot: string,
  snapshotId: string,
  scopePaths: string[],
): string {
  const skillPath = path.join(sourceRoot, stage.skill, "SKILL.md");
  const scope = scopePaths.length
    ? `Prioritize this operator-selected scope while preserving required dependency tracing: ${scopePaths.join(", ")}.`
    : "The operator selected the complete repository scope.";
  return [
    `Read ${skillPath} completely and execute that Mantis stage exactly once.`,
    `Invocation arguments: --snapshot_root=${snapshotRoot} --snapshot_id=${snapshotId} --state_root=${stateRoot}.`,
    scope,
    "This is an authorized defensive, scan-only run.",
    "The snapshot is immutable and read-only. Write state and findings only below the supplied state_root.",
    "Do not invoke mantis-reproduce, mantis-chain, mantis-patch, remote publishing, or any generated payload execution.",
    "Do not change the target or the snapshot. Do not ask interactive questions; fail clearly if a precondition is missing.",
    `When the ${stage.id} stage is complete, respond with a compact status and the state-relative artifacts written.`,
  ].join("\n");
}

async function runStage(
  config: MantisRunConfiguration,
  stage: StageDefinition,
  sourceRoot: string,
  stateRoot: string,
  snapshotRoot: string,
  snapshotId: string,
): Promise<void> {
  const logDir = path.join(config.outputDir, "mantis-logs");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, `${stage.id}.jsonl`);
  const args = [
    ...MANTIS_CODEX_ISOLATION_ARGS,
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
    stagePrompt(stage, sourceRoot, stateRoot, snapshotRoot, snapshotId, config.paths),
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: stateRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    currentChild = child;
    const stageUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let lastHeartbeatAt = 0;
    const stdout = readline.createInterface({ input: child.stdout! });
    const stderr = readline.createInterface({ input: child.stderr! });

    stdout.on("line", (line) => {
      fs.appendFileSync(logPath, `${line}\n`, "utf8");
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "turn.completed") collectUsage(event, stageUsage);
        const activity = summarizeMantisEvent(event);
        const nowMs = Date.now();
        if (activity && runtime && nowMs - lastHeartbeatAt >= 1_000) {
          lastHeartbeatAt = nowMs;
          const now = new Date(nowMs).toISOString();
          runtime = {
            ...runtime,
            detail: activity,
            lastActivityAt: now,
            activitySequence: (runtime.activitySequence ?? 0) + 1,
            updatedAt: now,
          };
          writeMantisRuntime(config.outputDir, runtime);
          log(`[mantis/${stage.id}] ${activity}`);
        }
      } catch {
        // The JSONL contract is best effort; preserve the raw line in the stage log.
      }
    });
    stderr.on("line", (line) => {
      fs.appendFileSync(logPath, `${JSON.stringify({ stream: "stderr", line })}\n`, "utf8");
      log(`[mantis/${stage.id}] ${line}`);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      currentChild = null;
      if (runtime) {
        runtime.usage.inputTokens += stageUsage.inputTokens;
        runtime.usage.cachedInputTokens += stageUsage.cachedInputTokens;
        runtime.usage.outputTokens += stageUsage.outputTokens;
      }
      if (cancelled) reject(new Error("Mantis scan cancelled."));
      else if (code === 0) resolve();
      else reject(new Error(`Mantis stage ${stage.id} failed with exit ${code}.`));
    });
  });
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Usage: mantis-worker <config.json>");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as MantisRunConfiguration;
  config.outputDir = path.resolve(config.outputDir);
  config.repositoryPath = path.resolve(config.repositoryPath);
  outputDirForSignal = config.outputDir;
  const startedAt = new Date().toISOString();
  runtime = {
    engine: "mantis",
    status: "preparing",
    stage: "bootstrap",
    stageLabel: "Mantis bootstrap",
    percent: 2,
    detail: "verifying the pinned skill source",
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    snapshotId: null,
    sourceRef: config.source.ref,
    findings: 0,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    error: null,
  };
  writeMantisRuntime(config.outputDir, runtime);

  const sourceRoot = ensureMantisSource(config);
  progress(config, { percent: 5, detail: "creating an immutable source snapshot" });
  const snapshotRoot = createSnapshot(config);
  const snapshotId = hashSnapshot(snapshotRoot);
  const stateRoot = path.join(config.outputDir, "mantis");
  initializeState(stateRoot, snapshotRoot, snapshotId);
  progress(config, {
    status: "running",
    percent: 10,
    detail: "snapshot pinned; starting deterministic stages",
    snapshotId,
  });

  for (const stage of STAGES) {
    if (cancelled) throw new Error("Mantis scan cancelled.");
    progress(config, {
      stage: stage.id,
      stageLabel: stage.label,
      percent: stage.startPercent,
      detail: `running ${stage.skill}`,
    });
    await runStage(config, stage, sourceRoot, stateRoot, snapshotRoot, snapshotId);
    progress(config, {
      percent: stage.completePercent,
      detail: `${stage.label} complete`,
    });
  }

  progress(config, {
    stage: "normalize",
    stageLabel: "Normalize evidence",
    percent: 99,
    detail: "mapping Mantis findings into Sentinel's canonical schema",
  });
  const findings = normalizeMantisWorkspace(stateRoot, config.outputDir);
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
    runtime = {
      ...runtime,
      status: "cancelled",
      detail: "cancellation requested",
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeMantisRuntime(outputDirForSignal, runtime);
  }
});

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (runtime && outputDirForSignal) {
    let recoveredFindings = runtime.findings;
    const stateRoot = path.join(outputDirForSignal, "mantis");
    if (fs.existsSync(path.join(stateRoot, "workspace", "findings"))) {
      try {
        recoveredFindings = normalizeMantisWorkspace(stateRoot, outputDirForSignal);
        if (recoveredFindings > 0) {
          log(`[mantis/recovery] Preserved ${recoveredFindings} partial findings.`);
        }
      } catch (normalizationError) {
        log(
          `[mantis/recovery] Partial normalization failed: ${normalizationError instanceof Error ? normalizationError.message : String(normalizationError)}`,
        );
      }
    }
    runtime = {
      ...runtime,
      status: cancelled ? "cancelled" : "failed",
      detail: message,
      findings: recoveredFindings,
      error: message,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeMantisRuntime(outputDirForSignal, runtime);
  }
  process.stderr.write(`[mantis] ${message}\n`);
  process.exitCode = cancelled ? 143 : 1;
});
