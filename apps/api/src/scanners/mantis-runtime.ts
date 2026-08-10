import fs from "node:fs";
import path from "node:path";
import type { ScanProgress } from "@csb/shared";

export interface MantisRunConfiguration {
  outputDir: string;
  repositoryPath: string;
  model: string;
  effort: string;
  paths: string[];
  source: {
    repositoryUrl: string;
    ref: string;
    cacheDir: string;
  };
}

export interface MantisRuntimeState {
  engine: "mantis";
  status: "preparing" | "running" | "completed" | "failed" | "cancelled";
  stage: string;
  stageLabel: string;
  percent: number;
  detail: string | null;
  startedAt: string;
  updatedAt: string;
  lastActivityAt?: string | null;
  activitySequence?: number;
  completedAt: string | null;
  snapshotId: string | null;
  sourceRef: string;
  findings: number;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  error: string | null;
}

const MANTIS_STAGE_IDS = [
  "architecture",
  "threat-model",
  "plan",
  "researcher",
  "dedupe",
  "review",
  "critic",
  "calibrate",
  "report",
] as const;

export const MANTIS_CODEX_ISOLATION_ARGS = ["--disable", "plugins"] as const;

interface LineOutput {
  destroyed?: boolean;
  write(chunk: string): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

export function createResilientLineWriter(
  stream: LineOutput,
): (message: string) => void {
  let available = !stream.destroyed;
  stream.on("error", () => {
    available = false;
  });
  return (message: string) => {
    if (!available || stream.destroyed) return;
    try {
      stream.write(`${message}\n`);
    } catch {
      available = false;
    }
  };
}

export function summarizeMantisEvent(
  event: Record<string, unknown>,
): string | null {
  const eventType = typeof event.type === "string" ? event.type : "";
  if (eventType === "thread.started") return "Codex session started";
  if (eventType === "turn.started") return "Stage analysis started";
  if (eventType === "turn.completed") return "Stage analysis completed";
  if (eventType !== "item.started" && eventType !== "item.completed") {
    return null;
  }

  const item = event.item;
  if (!item || typeof item !== "object") return null;
  const itemType = String((item as Record<string, unknown>).type ?? "work item");
  const completed = eventType === "item.completed";
  const labels: Record<string, [string, string]> = {
    agent_message: ["Agent preparing an update", "Agent reported progress"],
    command_execution: ["Command execution started", "Command execution completed"],
    file_change: ["State artifact update started", "State artifacts updated"],
    mcp_tool_call: ["Tool call started", "Tool call completed"],
    web_search: ["Research started", "Research completed"],
  };
  const label = labels[itemType];
  if (label) return label[completed ? 1 : 0];
  return completed ? "Work item completed" : "Work item started";
}

export function latestMantisActivityAt(
  scanDir: string,
  state: MantisRuntimeState,
): string {
  let latest = Math.max(
    Date.parse(state.updatedAt) || 0,
    Date.parse(state.lastActivityAt ?? "") || 0,
  );
  const logsDir = path.join(scanDir, "mantis-logs");
  try {
    for (const entry of fs.readdirSync(logsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      latest = Math.max(latest, fs.statSync(path.join(logsDir, entry.name)).mtimeMs);
    }
  } catch {
    // A stage log does not exist during bootstrap or may disappear during cleanup.
  }
  return new Date(latest || Date.now()).toISOString();
}

function mantisActivityState(
  lastActivityAt: string,
  nowMs: number,
): "active" | "quiet" | "stale" {
  const ageMs = Math.max(0, nowMs - Date.parse(lastActivityAt));
  if (ageMs <= 30_000) return "active";
  if (ageMs <= 5 * 60_000) return "quiet";
  return "stale";
}

export function mantisRuntimePath(scanDir: string): string {
  return path.join(scanDir, "mantis-runtime.json");
}

export function readMantisRuntime(scanDir: string): MantisRuntimeState | null {
  const file = mantisRuntimePath(scanDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as MantisRuntimeState;
    return parsed.engine === "mantis" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeMantisRuntime(scanDir: string, state: MantisRuntimeState): void {
  fs.mkdirSync(scanDir, { recursive: true, mode: 0o700 });
  const target = mantisRuntimePath(scanDir);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
}

export function mantisRuntimeProgress(
  state: MantisRuntimeState,
  lastActivityAt: string = state.lastActivityAt ?? state.updatedAt,
  nowMs: number = Date.now(),
): ScanProgress {
  let phase: string = "preflight";
  if (["architecture", "threat-model"].includes(state.stage)) phase = "threat_model";
  else if (["plan", "researcher"].includes(state.stage)) phase = "discovery";
  else if (["dedupe", "review", "critic"].includes(state.stage)) phase = "validation";
  else if (["calibrate", "report", "normalize"].includes(state.stage)) phase = "reporting";

  const stageIndex = MANTIS_STAGE_IDS.indexOf(
    state.stage as (typeof MANTIS_STAGE_IDS)[number],
  );
  const completed = state.status === "completed";
  const itemsCompleted = completed
    ? MANTIS_STAGE_IDS.length
    : Math.max(0, stageIndex);
  const currentItem = completed
    ? MANTIS_STAGE_IDS.length
    : stageIndex >= 0
      ? stageIndex + 1
      : 0;

  return {
    percent: Math.max(1, Math.min(state.status === "completed" ? 100 : 99, state.percent)),
    phase,
    phaseLabel: state.status === "completed" ? "Concluído" : state.stageLabel,
    detail: state.detail,
    unit: "stages",
    itemsCompleted,
    itemsTotal: MANTIS_STAGE_IDS.length,
    currentItem,
    indeterminate: !completed,
    activityState: completed
      ? undefined
      : mantisActivityState(lastActivityAt, nowMs),
    lastActivityAt,
    reportableFindings: state.findings,
  };
}
