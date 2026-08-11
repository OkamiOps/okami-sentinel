import fs from "node:fs";
import path from "node:path";
import type { SafeProviderErrorCode, ScanProgress } from "@csb/shared";

import {
  PORTABLE_CODEX_SECURITY_STAGES,
  type PortableCodexSecurityStage,
} from "./portable-codex-security-profile.js";
import type { ScannerUsage } from "./usage.js";

export interface PortableCodexSecurityRuntimeState {
  engine: "codex-security";
  executionProfile: "portable";
  profileVersion: string;
  methodologyRef: string;
  status: "preparing" | "running" | "completed" | "failed" | "cancelled";
  stage: PortableCodexSecurityStage["id"] | "normalize";
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
  usage: ScannerUsage;
  error: string | null;
  errorCode: SafeProviderErrorCode | null;
}

export function portableCodexSecurityRuntimePath(scanDir: string): string {
  return path.join(scanDir, "portable-codex-security-runtime.json");
}

export function readPortableCodexSecurityRuntime(
  scanDir: string,
): PortableCodexSecurityRuntimeState | null {
  const target = portableCodexSecurityRuntimePath(scanDir);
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as PortableCodexSecurityRuntimeState;
    return parsed.engine === "codex-security" && parsed.executionProfile === "portable"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function writePortableCodexSecurityRuntime(
  scanDir: string,
  state: PortableCodexSecurityRuntimeState,
): void {
  fs.mkdirSync(scanDir, { recursive: true, mode: 0o700 });
  const target = portableCodexSecurityRuntimePath(scanDir);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
}

function portableCodexSecurityActivityState(
  lastActivityAt: string,
  nowMs: number,
): "active" | "quiet" | "stale" {
  const ageMs = Math.max(0, nowMs - Date.parse(lastActivityAt));
  if (ageMs <= 30_000) return "active";
  if (ageMs <= 5 * 60_000) return "quiet";
  return "stale";
}

function phaseForStage(stage: PortableCodexSecurityRuntimeState["stage"]): string {
  if (stage === "inventory") return "preflight";
  if (stage === "threat-model") return "threat_model";
  if (stage === "discovery") return "discovery";
  if (stage === "dataflow") return "attack_path";
  if (stage === "validation") return "validation";
  if (stage === "report" || stage === "normalize") return "reporting";
  return "preflight";
}

function boundedPercent(state: PortableCodexSecurityRuntimeState): number {
  if (state.status === "completed") return 100;
  return Math.max(0, Math.min(99, state.percent));
}

export function portableCodexSecurityRuntimeProgress(
  state: PortableCodexSecurityRuntimeState,
  lastActivityAt: string = state.lastActivityAt ?? state.updatedAt,
  nowMs: number = Date.now(),
): ScanProgress {
  const stageIndex = PORTABLE_CODEX_SECURITY_STAGES.findIndex(
    (stage) => stage.id === state.stage,
  );
  const completed = state.status === "completed";
  const itemsTotal = PORTABLE_CODEX_SECURITY_STAGES.length;
  const itemsCompleted = completed ? itemsTotal : Math.max(0, stageIndex);
  const currentItem = completed ? itemsTotal : stageIndex >= 0 ? stageIndex + 1 : 0;

  return {
    percent: boundedPercent(state),
    phase: phaseForStage(state.stage),
    phaseLabel: completed ? "Concluído" : state.stageLabel,
    detail: state.detail,
    unit: "stages",
    itemsCompleted,
    itemsTotal,
    currentItem,
    indeterminate: !completed,
    activityState: completed
      ? undefined
      : portableCodexSecurityActivityState(lastActivityAt, nowMs),
    lastActivityAt,
    reportableFindings: state.findings,
  };
}
