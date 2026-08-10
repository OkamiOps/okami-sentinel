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

export function mantisRuntimeProgress(state: MantisRuntimeState): ScanProgress {
  let phase: string = "preflight";
  if (["architecture", "threat-model"].includes(state.stage)) phase = "threat_model";
  else if (["plan", "researcher"].includes(state.stage)) phase = "discovery";
  else if (["dedupe", "review", "critic"].includes(state.stage)) phase = "validation";
  else if (["calibrate", "report", "normalize"].includes(state.stage)) phase = "reporting";

  return {
    percent: Math.max(1, Math.min(state.status === "completed" ? 100 : 99, state.percent)),
    phase,
    phaseLabel: state.status === "completed" ? "Concluído" : state.stageLabel,
    detail: state.detail,
    unit: "stages",
    itemsCompleted: Math.max(0, Math.round((state.percent / 100) * 9)),
    itemsTotal: 9,
    reportableFindings: state.findings,
  };
}
