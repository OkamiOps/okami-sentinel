import fs from "node:fs";

import { getProviderRuntime } from "../provider-runtime.js";
import { globalSecretRedactor } from "../redaction.js";
import {
  PortableCodexSecurityRunnerError,
  runPortableCodexSecurity,
  type PortableCodexSecurityCostBudget,
  type PortableCodexSecurityWorkerConfiguration,
} from "./portable-codex-security-http-runner.js";
import { isFrozenScannerPricing } from "../model-pricing.js";
import { createSafePortableCodexSecurityProviderPlan } from "./portable-codex-security-profile.js";

const MAX_CONFIG_BYTES = 128 * 1024;
const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;
const READ_NO_FOLLOW = fs.constants.O_RDONLY | NO_FOLLOW;
const controller = new AbortController();

process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

/** Reads a strictly local, secret-free worker manifest. */
export function readPortableCodexSecurityWorkerConfiguration(
  configPath: string,
): PortableCodexSecurityWorkerConfiguration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readPinnedWorkerConfig(configPath));
  } catch {
    throw new PortableCodexSecurityRunnerError("provider_plan_invalid");
  }
  if (!isConfigurationShape(parsed)) {
    throw new PortableCodexSecurityRunnerError("provider_plan_invalid");
  }
  try {
    return {
      outputDir: parsed.outputDir,
      repositoryPath: parsed.repositoryPath,
      paths: [...parsed.paths],
      sourceRef: parsed.sourceRef,
      mode: parsed.mode,
      providerPlan: createSafePortableCodexSecurityProviderPlan(parsed.providerPlan),
      limits: parsed.limits as unknown as PortableCodexSecurityWorkerConfiguration["limits"],
      ...(parsed.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.reasoningEffort }),
      ...(parsed.costBudget === undefined
        ? {}
        : { costBudget: parsed.costBudget as PortableCodexSecurityCostBudget }),
    };
  } catch {
    throw new PortableCodexSecurityRunnerError("provider_plan_invalid");
  }
}

function readPinnedWorkerConfig(configPath: string): string {
  let descriptor: number | undefined;
  try {
    const expected = fs.lstatSync(configPath);
    if (!validConfigFile(expected)) throw new Error("unsafe config");
    descriptor = fs.openSync(configPath, READ_NO_FOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!validConfigFile(opened) || !sameVersion(expected, opened)) {
      throw new Error("config changed");
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytes === 0) break;
      offset += bytes;
    }
    const afterOpen = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(configPath);
    if (offset !== buffer.length || !validConfigFile(afterPath) ||
      !sameVersion(opened, afterOpen) || !sameVersion(opened, afterPath)) {
      throw new Error("config changed");
    }
    return buffer.toString("utf8");
  } catch {
    throw new PortableCodexSecurityRunnerError("provider_plan_invalid");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validConfigFile(info: fs.Stats): boolean {
  return !info.isSymbolicLink() && info.isFile() &&
    (info.mode & 0o777) === 0o600 && info.size > 0 && info.size <= MAX_CONFIG_BYTES;
}

function sameVersion(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** A worker must never format provider text or an Error message for stderr. */
export function portableCodexSecurityWorkerErrorCode(error: unknown): string {
  return error instanceof PortableCodexSecurityRunnerError
    ? error.code
    : "portable_codex_security_failed";
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new PortableCodexSecurityRunnerError("provider_plan_invalid");
  const configuration = readPortableCodexSecurityWorkerConfiguration(configPath);
  const runtime = getProviderRuntime();
  await runPortableCodexSecurity(configuration, {
    getSnapshot: (scanId) => runtime.store.getSnapshot(scanId),
    getConnection: (connectionId) => runtime.store.get(connectionId),
    getModel: (connectionId, modelId) => runtime.store.getModel(connectionId, modelId),
    getCapabilityCheck: (capabilityCheckId) => runtime.store.getCapabilityCheck(capabilityCheckId),
    vault: runtime.vault,
    xaiOAuth: runtime.xaiOAuthTokenResolver,
    signal: controller.signal,
    redactor: globalSecretRedactor,
    log: (line) => process.stdout.write(`${globalSecretRedactor.redactText(line)}\n`),
  });
}

if (process.argv[1]?.endsWith("portable-codex-security-worker.js") ||
  process.argv[1]?.endsWith("portable-codex-security-worker.ts")) {
  void main().catch((error) => {
    process.stderr.write(`[portable-codex-security] ${portableCodexSecurityWorkerErrorCode(error)}\n`);
    process.exitCode = controller.signal.aborted ? 143 : 1;
  });
}

function isConfigurationShape(value: unknown): value is Record<string, unknown> & {
  outputDir: string;
  repositoryPath: string;
  paths: string[];
  sourceRef: string;
  mode: "standard" | "deep";
  providerPlan: unknown;
  limits: Record<string, unknown>;
  reasoningEffort?: string;
  costBudget?: { maxCostUsd: number; pricing: unknown };
} {
  if (!isRecord(value) || !onlyKeys(value, [
    "outputDir", "repositoryPath", "paths", "sourceRef", "mode", "providerPlan", "limits", "reasoningEffort", "costBudget",
  ])) return false;
  if (
    !safeText(value.outputDir, 4_096) ||
    !safeText(value.repositoryPath, 4_096) ||
    !safeText(value.sourceRef, 256) ||
    (value.mode !== "standard" && value.mode !== "deep") ||
    !Array.isArray(value.paths) ||
    value.paths.length > 256 ||
    !value.paths.every((item) => safeRelativePath(item)) ||
    !isRecord(value.limits) ||
    !onlyKeys(value.limits, [
      "totalTimeoutMs", "maxModelTurns", "maxToolCalls", "maxInputBytes", "maxOutputBytes",
    ]) ||
    !Object.values(value.limits).every((item) =>
      typeof item === "number" && Number.isSafeInteger(item) && item > 0,
    ) ||
    (value.reasoningEffort !== undefined && !safeText(value.reasoningEffort, 64)) ||
    (value.costBudget !== undefined && !validCostBudget(value.costBudget))
  ) return false;
  return true;
}

function validCostBudget(value: unknown): value is { maxCostUsd: number; pricing: unknown } {
  return isRecord(value) && onlyKeys(value, ["maxCostUsd", "pricing"]) &&
    typeof value.maxCostUsd === "number" && Number.isFinite(value.maxCostUsd) &&
    value.maxCostUsd > 0 && isFrozenScannerPricing(value.pricing);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit &&
    !/[\u0000-\u001F\u007F]/.test(value);
}

function safeRelativePath(value: unknown): value is string {
  return safeText(value, 1_024) && value === value.trim() &&
    !value.startsWith("/") && !value.split(/[\\/]+/).includes("..");
}
