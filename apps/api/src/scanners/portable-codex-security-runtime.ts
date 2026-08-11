import fs from "node:fs";
import path from "node:path";
import {
  isSafeProviderErrorCode,
  type SafeProviderErrorCode,
  type ScanProgress,
} from "@csb/shared";

import {
  PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
  PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
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

const RUNTIME_STATUSES = new Set([
  "preparing",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const RUNTIME_STAGES = new Set([
  ...PORTABLE_CODEX_SECURITY_STAGES.map((stage) => stage.id),
  "normalize",
]);
const RUNTIME_KEYS = new Set([
  "engine",
  "executionProfile",
  "profileVersion",
  "methodologyRef",
  "status",
  "stage",
  "stageLabel",
  "percent",
  "detail",
  "startedAt",
  "updatedAt",
  "lastActivityAt",
  "activitySequence",
  "completedAt",
  "snapshotId",
  "sourceRef",
  "findings",
  "usage",
  "error",
  "errorCode",
]);
const USAGE_KEYS = new Set([
  "reported",
  "inputTokensKnown",
  "cachedInputTokensKnown",
  "cacheWriteInputTokensKnown",
  "outputTokensKnown",
  "maximumInputTokensPerRequest",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validUsage(value: unknown): value is ScannerUsage {
  if (!isRecord(value) || !hasOnlyKeys(value, USAGE_KEYS)) return false;
  return (
    (value.reported === undefined || typeof value.reported === "boolean") &&
    (value.inputTokensKnown === undefined || typeof value.inputTokensKnown === "boolean") &&
    (value.cachedInputTokensKnown === undefined || typeof value.cachedInputTokensKnown === "boolean") &&
    (value.cacheWriteInputTokensKnown === undefined ||
      typeof value.cacheWriteInputTokensKnown === "boolean") &&
    (value.outputTokensKnown === undefined || typeof value.outputTokensKnown === "boolean") &&
    (value.maximumInputTokensPerRequest === undefined ||
      nonNegativeSafeInteger(value.maximumInputTokensPerRequest)) &&
    nonNegativeSafeInteger(value.inputTokens) &&
    nonNegativeSafeInteger(value.cachedInputTokens) &&
    (value.cacheWriteInputTokens === undefined ||
      nonNegativeSafeInteger(value.cacheWriteInputTokens)) &&
    nonNegativeSafeInteger(value.outputTokens)
  );
}

function validPortableCodexSecurityRuntime(
  value: unknown,
): value is PortableCodexSecurityRuntimeState {
  if (!isRecord(value) || !hasOnlyKeys(value, RUNTIME_KEYS)) return false;
  return (
    value.engine === "codex-security" &&
    value.executionProfile === "portable" &&
    value.profileVersion === PORTABLE_CODEX_SECURITY_PROFILE_VERSION &&
    value.methodologyRef === PORTABLE_CODEX_SECURITY_METHODOLOGY_REF &&
    typeof value.status === "string" &&
    RUNTIME_STATUSES.has(value.status) &&
    typeof value.stage === "string" &&
    RUNTIME_STAGES.has(value.stage) &&
    typeof value.stageLabel === "string" &&
    value.stageLabel.trim().length > 0 &&
    typeof value.percent === "number" &&
    Number.isFinite(value.percent) &&
    value.percent >= 0 &&
    value.percent <= 100 &&
    (value.detail === null || typeof value.detail === "string") &&
    canonicalTimestamp(value.startedAt) &&
    canonicalTimestamp(value.updatedAt) &&
    (value.lastActivityAt === undefined || value.lastActivityAt === null ||
      canonicalTimestamp(value.lastActivityAt)) &&
    (value.activitySequence === undefined || nonNegativeSafeInteger(value.activitySequence)) &&
    (value.completedAt === null || canonicalTimestamp(value.completedAt)) &&
    (value.snapshotId === null ||
      (typeof value.snapshotId === "string" && value.snapshotId.length > 0)) &&
    typeof value.sourceRef === "string" &&
    value.sourceRef.length > 0 &&
    nonNegativeSafeInteger(value.findings) &&
    validUsage(value.usage) &&
    (value.error === null || typeof value.error === "string") &&
    (value.errorCode === null || isSafeProviderErrorCode(value.errorCode))
  );
}

export function readPortableCodexSecurityRuntime(
  scanDir: string,
): PortableCodexSecurityRuntimeState | null {
  const target = portableCodexSecurityRuntimePath(scanDir);
  if (!fs.existsSync(target)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
    return validPortableCodexSecurityRuntime(parsed) ? parsed : null;
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
  const methodologyCompleted = completed || state.stage === "normalize";
  const itemsTotal = PORTABLE_CODEX_SECURITY_STAGES.length;
  const itemsCompleted = methodologyCompleted ? itemsTotal : Math.max(0, stageIndex);
  const currentItem = methodologyCompleted
    ? itemsTotal
    : stageIndex >= 0
      ? stageIndex + 1
      : 0;

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
