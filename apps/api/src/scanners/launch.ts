import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ScannerAuthMode,
  ScannerEngine,
  ScanMode,
  StartScanRequest,
  ModelPricing,
} from "@csb/shared";
import {
  CODEX_SECURITY_ARGS_PREFIX,
  CODEX_SECURITY_BIN,
  codexSecurityEnvironment,
  MANTIS_CACHE_DIR,
  MANTIS_HTTP_WORKER_BIN,
  MANTIS_HTTP_WORKER_ENTRY,
  MANTIS_LOCAL_WORKER_BIN,
  MANTIS_LOCAL_WORKER_ENTRY,
  MANTIS_REPOSITORY_URL,
  MANTIS_SOURCE_REF,
  MANTIS_WORKER_BIN,
  MANTIS_WORKER_ENTRY,
  PORTABLE_CODEX_SECURITY_WORKER_BIN,
  PORTABLE_CODEX_SECURITY_WORKER_ENTRY,
  ROOT_DIR,
  VULNHUNTER_PROFILE_VERSION,
  VULNHUNTER_REPOSITORY_URL,
  VULNHUNTER_SOURCE_REF,
  VULNHUNTER_WORKER_BIN,
  VULNHUNTER_WORKER_ENTRY,
} from "../config.js";
import {
  writePortableCodexSecurityPricing,
  writeScannerPricingQuote,
  type FrozenScannerPricing,
} from "../model-pricing.js";
import type { MantisRunConfiguration } from "./mantis-runtime.js";
import type {
  MantisHttpWorkerConfiguration,
  SafeMantisProviderPlan,
} from "./mantis-http-runner.js";
import type { MantisLocalProviderPlan } from "./mantis-local-runner.js";
import type {
  PortableCodexSecurityExecutionLimits,
  PortableCodexSecurityWorkerConfiguration,
} from "./portable-codex-security-http-runner.js";
import {
  PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
  type SafePortableCodexSecurityProviderPlan,
} from "./portable-codex-security-profile.js";
import type {
  SafeVulnHunterProviderPlan,
  VulnHunterRunConfiguration,
} from "./vulnhunter-runtime.js";

export interface ScannerLaunch {
  engine: ScannerEngine;
  authMode: ScannerAuthMode | null;
  provider: string;
  scannerVersion: string | null;
  recipeHash: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  displayCommand: string;
}

export interface ScannerLaunchInput {
  request: StartScanRequest;
  repositoryPath: string;
  outputDir: string;
  model: string;
  effort: string | null;
  mode: ScanMode;
  /** Only the server-resolved immutable reference may cross into a worker config. */
  vulnhunterProviderPlan?: SafeVulnHunterProviderPlan;
  /** Run metadata only; never written into the child configuration. */
  providerKind?: string;
  /** Frozen, secret-free quote scoped to the already resolved connection and model. */
  pricingQuote?: FrozenScannerPricing | null;
}

export interface CodexSecurityApiLaunchInput extends ScannerLaunchInput {
  /** Secret material from the selected vault; never serialized into a config or command. */
  apiKey: string;
  /** Provider-level Codex configuration preserved alongside the Native effort codec. */
  codexOverrides?: readonly string[];
  /** Injectable only to make the child-environment boundary testable. */
  environment?: NodeJS.ProcessEnv;
}

export interface MantisHttpLaunchInput extends ScannerLaunchInput {
  /** Trusted runtime metadata, never serialized into the worker config. */
  providerKind: string;
  mantisProviderPlan: SafeMantisProviderPlan;
}

export interface PortableCodexSecurityLaunchInput extends ScannerLaunchInput {
  /** Safe identifiers only; the worker repeats this revalidation before vault/network access. */
  portableCodexSecurityProviderPlan: SafePortableCodexSecurityProviderPlan;
  /** Run metadata only; never written as a provider body. */
  providerKind: string;
  /** Catalog rate snapshot written before the worker is spawned. */
  pricing: ModelPricing | null;
  capturedAt: string;
  /** Injectable only to make the child-environment boundary testable. */
  environment?: NodeJS.ProcessEnv;
}

/**
 * The local Claude worker receives no secret and no browser-owned model data.
 * Its source checkout is resolved before this function is called.
 */
export interface MantisLocalLaunchInput {
  request: StartScanRequest;
  repositoryPath: string;
  outputDir: string;
  effort: string | null;
  mode: ScanMode;
  sourceCacheDir: string;
  mantisLocalProviderPlan: MantisLocalProviderPlan;
  /** Private test seam; production inherits the existing Claude session. */
  environment?: NodeJS.ProcessEnv;
}

export function explicitAuthEnvironment(
  authMode: ScannerAuthMode,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...source };
  if (authMode === "chatgpt") {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    return env;
  }
  if (!env.OPENAI_API_KEY?.trim() && !env.CODEX_API_KEY?.trim()) {
    throw new Error(
      "Autenticação API selecionada, mas OPENAI_API_KEY/CODEX_API_KEY não está configurada no backend.",
    );
  }
  return env;
}

function recipeHash(input: {
  engine: ScannerEngine;
  authMode: ScannerAuthMode | null;
  model: string;
  effort: string | null;
  mode: string;
  paths: string[];
  scannerVersion: string | null;
  provider?: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

const PORTABLE_STANDARD_LIMITS: PortableCodexSecurityExecutionLimits = {
  totalTimeoutMs: 900_000,
  maxModelTurns: 24,
  maxToolCalls: 96,
  maxInputBytes: 1_048_576,
  maxOutputBytes: 1_048_576,
};

const PORTABLE_DEEP_LIMITS: PortableCodexSecurityExecutionLimits = {
  totalTimeoutMs: 1_800_000,
  maxModelTurns: 48,
  maxToolCalls: 192,
  maxInputBytes: 1_048_576,
  maxOutputBytes: 1_048_576,
};

const CODEX_SECURITY_EFFORT_FLAG_VALUES = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

// Codex Security 0.1.9 defaults every private runtime to a detailed reasoning
// summary. Some valid Codex models reject the resulting `reasoning.summary`
// request field. Sentinel does not consume reasoning summaries, so the Native
// boundary disables this optional field while preserving the selected effort.
const CODEX_SECURITY_REASONING_SUMMARY_OVERRIDES = [
  "model_supports_reasoning_summaries=false",
  'model_reasoning_summary="none"',
] as const;

/**
 * Portable scans intentionally use a separate local worker, never the Codex
 * Security CLI. Its config contains only revalidatable identifiers and static
 * execution limits; credential material stays in the backend vault.
 */
export function preparePortableCodexSecurityLaunch(
  input: PortableCodexSecurityLaunchInput,
): ScannerLaunch {
  const configuration: PortableCodexSecurityWorkerConfiguration = {
    outputDir: input.outputDir,
    repositoryPath: input.repositoryPath,
    paths: (input.request.paths ?? []).map((item) => item.trim()).filter(Boolean),
    sourceRef: PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
    mode: input.mode,
    providerPlan: {
      ...input.portableCodexSecurityProviderPlan,
    },
    limits: input.mode === "deep" ? { ...PORTABLE_DEEP_LIMITS } : { ...PORTABLE_STANDARD_LIMITS },
    ...(input.effort === null ? {} : { reasoningEffort: input.effort }),
  };
  // This happens before the child can make its first provider call. Reconcile
  // reads only this immutable local snapshot, never a current provider catalog.
  writePortableCodexSecurityPricing(
    input.outputDir,
    input.pricing,
    input.capturedAt,
    input.portableCodexSecurityProviderPlan.modelId,
  );
  if (input.pricingQuote !== undefined) {
    writeScannerPricingQuote(input.outputDir, input.pricingQuote);
  }
  const configPath = path.join(input.outputDir, "portable-codex-security-run.json");
  fs.writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(configPath, 0o600);
  return {
    engine: "codex-security",
    authMode: null,
    provider: input.providerKind,
    scannerVersion: PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
    recipeHash: recipeHash({
      engine: "codex-security",
      authMode: null,
      model: input.portableCodexSecurityProviderPlan.modelId,
      effort: input.effort,
      mode: input.mode,
      paths: configuration.paths,
      scannerVersion: PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
      provider: input.providerKind,
    }),
    command: PORTABLE_CODEX_SECURITY_WORKER_BIN,
    args: [PORTABLE_CODEX_SECURITY_WORKER_ENTRY, configPath],
    cwd: ROOT_DIR,
    env: portableCodexSecurityWorkerEnvironment(input.environment),
    displayCommand: `sentinel-portable-codex-security ${path.basename(configPath)}`,
  };
}

function prepareCodexSecurity(
  input: ScannerLaunchInput,
  environment: NodeJS.ProcessEnv = codexSecurityEnvironment(),
  providerOptions: {
    provider?: string;
    codexOverrides?: readonly string[];
  } = {},
): ScannerLaunch {
  const authMode = input.request.authMode ?? "chatgpt";
  const nativeReasoningOverride = input.effort !== null &&
    !CODEX_SECURITY_EFFORT_FLAG_VALUES.has(input.effort)
    ? `model_reasoning_effort=${JSON.stringify(input.effort)}`
    : null;
  const providerOverrides = (providerOptions.codexOverrides ?? []).filter((override) =>
    !isModelReasoningSummaryOverride(override) &&
    (input.effort === null || !isModelReasoningEffortOverride(override))
  );
  const args = [
    ...CODEX_SECURITY_ARGS_PREFIX,
    "scan",
    input.repositoryPath,
    "--auth",
    authMode,
    "--model",
    input.model,
    ...(input.effort === null || nativeReasoningOverride !== null
      ? []
      : ["--effort", input.effort]),
    "--mode",
    input.mode,
    "--output-dir",
    input.outputDir,
    "--json",
  ];
  for (const override of providerOverrides) {
    args.push("--codex", override);
  }
  for (const override of CODEX_SECURITY_REASONING_SUMMARY_OVERRIDES) {
    args.push("--codex", override);
  }
  if (nativeReasoningOverride !== null) {
    args.push("--codex", nativeReasoningOverride);
  }
  if (input.request.maxCostUsd != null && input.request.maxCostUsd > 0) {
    args.push("--max-cost", String(input.request.maxCostUsd));
  }
  for (const scopePath of input.request.paths ?? []) {
    if (scopePath.trim()) args.push("--path", scopePath.trim());
  }
  const hash = recipeHash({
    engine: "codex-security",
    authMode,
    model: input.model,
    effort: input.effort,
    mode: input.mode,
    paths: input.request.paths ?? [],
    scannerVersion: null,
    ...(providerOptions.provider === undefined
      ? {}
      : { provider: providerOptions.provider }),
  });
  return {
    engine: "codex-security",
    authMode,
    provider: providerOptions.provider ?? "openai",
    scannerVersion: null,
    recipeHash: hash,
    command: CODEX_SECURITY_BIN,
    args,
    cwd: input.repositoryPath,
    env: explicitAuthEnvironment(authMode, environment),
    displayCommand: `${CODEX_SECURITY_BIN} ${args.join(" ")}`,
  };
}

function isModelReasoningEffortOverride(override: string): boolean {
  return /^model_reasoning_effort\s*=/.test(override);
}

function isModelReasoningSummaryOverride(override: string): boolean {
  return /^(?:model_reasoning_summary|model_supports_reasoning_summaries)\s*=/.test(override);
}

/**
 * Builds the official Codex Security API-key CLI invocation from a secret that
 * was already resolved from the selected vault. The key is child-env only.
 */
export function prepareCodexSecurityApiLaunch(
  input: CodexSecurityApiLaunchInput,
): ScannerLaunch {
  if (!input.apiKey.trim()) throw new Error("Codex Security API credential is unavailable");
  const environment = { ...(input.environment ?? codexSecurityEnvironment()) };
  delete environment.CODEX_API_KEY;
  environment.OPENAI_API_KEY = input.apiKey;
  return prepareCodexSecurity({
    request: { ...input.request, authMode: "api-key" },
    repositoryPath: input.repositoryPath,
    outputDir: input.outputDir,
    model: input.model,
    effort: input.effort,
    mode: input.mode,
    ...(input.vulnhunterProviderPlan === undefined
      ? {}
      : { vulnhunterProviderPlan: input.vulnhunterProviderPlan }),
    ...(input.providerKind === undefined ? {} : { providerKind: input.providerKind }),
  }, environment, input.codexOverrides === undefined
    ? {}
    : { codexOverrides: input.codexOverrides });
}

function prepareMantis(input: ScannerLaunchInput): ScannerLaunch {
  const authMode = input.request.authMode ?? "chatgpt";
  const configuration: MantisRunConfiguration = {
    outputDir: input.outputDir,
    repositoryPath: input.repositoryPath,
    model: input.model,
    ...(input.effort === null ? {} : { effort: input.effort }),
    paths: (input.request.paths ?? []).map((item) => item.trim()).filter(Boolean),
    source: {
      repositoryUrl: MANTIS_REPOSITORY_URL,
      ref: MANTIS_SOURCE_REF,
      cacheDir: MANTIS_CACHE_DIR,
    },
  };
  const configPath = path.join(input.outputDir, "mantis-run.json");
  fs.writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const hash = recipeHash({
    engine: "mantis",
    authMode,
    model: input.model,
    effort: input.effort,
    mode: input.mode,
    paths: configuration.paths,
    scannerVersion: MANTIS_SOURCE_REF,
  });
  const args = [MANTIS_WORKER_ENTRY, configPath];
  return {
    engine: "mantis",
    authMode,
    provider: "openai",
    scannerVersion: MANTIS_SOURCE_REF,
    recipeHash: hash,
    command: MANTIS_WORKER_BIN,
    args,
    cwd: ROOT_DIR,
    env: explicitAuthEnvironment(authMode, {
      ...process.env,
      NO_COLOR: "1",
      CI: "1",
    }),
    displayCommand: `sentinel-mantis ${path.basename(configPath)}`,
  };
}

/**
 * HTTP agent sessions run in their own worker. Its config has no provider
 * secret or mutable model data; it receives only the server-originated plan
 * and re-resolves the snapshot, catalog, capability report, and native
 * credential boundary later (vault or the dedicated xAI OAuth resolver).
 */
export function prepareMantisHttpLaunch(input: MantisHttpLaunchInput): ScannerLaunch {
  const configuration: MantisHttpWorkerConfiguration = {
    outputDir: input.outputDir,
    repositoryPath: input.repositoryPath,
    paths: (input.request.paths ?? []).map((item) => item.trim()).filter(Boolean),
    sourceRef: MANTIS_SOURCE_REF,
    providerPlan: input.mantisProviderPlan,
    ...(input.effort === null ? {} : { reasoningEffort: input.effort }),
  };
  const configPath = path.join(input.outputDir, "mantis-http-run.json");
  fs.writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (input.pricingQuote !== undefined) {
    writeScannerPricingQuote(input.outputDir, input.pricingQuote);
  }
  const authMode: ScannerAuthMode = "api-key";
  const hash = recipeHash({
    engine: "mantis",
    authMode,
    model: input.mantisProviderPlan.modelId,
    effort: input.effort,
    mode: input.mode,
    paths: configuration.paths,
    scannerVersion: MANTIS_SOURCE_REF,
  });
  return {
    engine: "mantis",
    authMode,
    provider: input.providerKind,
    scannerVersion: MANTIS_SOURCE_REF,
    recipeHash: hash,
    command: MANTIS_HTTP_WORKER_BIN,
    args: [MANTIS_HTTP_WORKER_ENTRY, configPath],
    cwd: ROOT_DIR,
    // API-key labels are accounting metadata here, never a request to source
    // an API key from this process. The worker reads either its selected vault
    // ref or the dedicated xAI OAuth resolver after plan revalidation.
    env: explicitAuthEnvironment("chatgpt", { ...process.env, NO_COLOR: "1", CI: "1" }),
    displayCommand: `sentinel-mantis-http ${path.basename(configPath)}`,
  };
}

/**
 * Writes the identifier-only contract for the argv-locked Claude worker.
 * The exact source ref has already been checked by the launch preflight.
 */
export function prepareMantisLocalLaunch(input: MantisLocalLaunchInput): ScannerLaunch {
  const plan = copyMantisLocalProviderPlan(input.mantisLocalProviderPlan);
  const configuration = {
    outputDir: input.outputDir,
    repositoryPath: input.repositoryPath,
    paths: (input.request.paths ?? []).map((item) => item.trim()).filter(Boolean),
    sourceRef: MANTIS_SOURCE_REF,
    sourceCacheDir: input.sourceCacheDir,
    providerPlan: plan,
  };
  const configPath = path.join(input.outputDir, "mantis-local-run.json");
  fs.writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const hash = recipeHash({
    engine: "mantis",
    authMode: "existing-session",
    model: plan.modelId ?? "runtime-default",
    effort: input.effort,
    mode: input.mode,
    paths: configuration.paths,
    scannerVersion: MANTIS_SOURCE_REF,
  });
  return {
    engine: "mantis",
    authMode: "existing-session",
    provider: "anthropic",
    scannerVersion: MANTIS_SOURCE_REF,
    recipeHash: hash,
    command: MANTIS_LOCAL_WORKER_BIN,
    args: [MANTIS_LOCAL_WORKER_ENTRY, configPath],
    cwd: ROOT_DIR,
    env: localMantisWorkerEnvironment(input.environment),
    displayCommand: `sentinel-mantis-local ${path.basename(configPath)}`,
  };
}

function prepareVulnHunter(input: ScannerLaunchInput): ScannerLaunch {
  const authMode = input.vulnhunterProviderPlan === undefined
    ? input.request.authMode ?? "chatgpt"
    : "api-key";
  const configuration: VulnHunterRunConfiguration = {
    outputDir: input.outputDir,
    repositoryPath: input.repositoryPath,
    model: input.model,
    ...(input.effort === null ? {} : { effort: input.effort }),
    paths: (input.request.paths ?? []).map((item) => item.trim()).filter(Boolean),
    readOnly: true,
    profileVersion: VULNHUNTER_PROFILE_VERSION,
    source: {
      repositoryUrl: VULNHUNTER_REPOSITORY_URL,
      ref: VULNHUNTER_SOURCE_REF,
    },
    ...(input.vulnhunterProviderPlan === undefined
      ? {}
      : { providerPlan: copyVulnHunterProviderPlan(input.vulnhunterProviderPlan) }),
  };
  const configPath = path.join(input.outputDir, "vulnhunter-run.json");
  fs.writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (input.vulnhunterProviderPlan !== undefined && input.pricingQuote !== undefined) {
    writeScannerPricingQuote(input.outputDir, input.pricingQuote);
  }
  const hash = recipeHash({
    engine: "vulnhunter",
    authMode,
    model: input.model,
    effort: input.effort,
    mode: input.mode,
    paths: configuration.paths,
    scannerVersion: VULNHUNTER_PROFILE_VERSION,
  });
  const args = [VULNHUNTER_WORKER_ENTRY, configPath];
  return {
    engine: "vulnhunter",
    authMode,
    provider: input.providerKind ?? "openai",
    scannerVersion: VULNHUNTER_PROFILE_VERSION,
    recipeHash: hash,
    command: VULNHUNTER_WORKER_BIN,
    args,
    cwd: ROOT_DIR,
    env: input.vulnhunterProviderPlan === undefined
      ? explicitAuthEnvironment(authMode, workerEnvironment())
      : workerEnvironmentWithoutOpenAiKeys(),
    displayCommand: `sentinel-vulnhunter ${path.basename(configPath)}`,
  };
}

function workerEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    CI: "1",
  };
}

const LOCAL_MANTIS_CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_CONFIG_DIR",
] as const;

const PORTABLE_CODEX_SECURITY_CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
] as const;

/**
 * Portable worker configuration and all provider credentials are server-owned.
 * Start from an allowlist so endpoint overrides, provider secrets, preload
 * hooks, and future ambient variables cannot silently cross the child boundary.
 */
export function portableCodexSecurityWorkerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1", CI: "1" };
  for (const key of PORTABLE_CODEX_SECURITY_CHILD_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

/**
 * A local Claude session authenticates through its private config directory.
 * The child receives only OS paths needed to find that session; all provider
 * credentials, endpoint overrides, preload hooks, and unrelated runtime
 * knobs are absent by construction.
 */
export function localMantisWorkerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1", CI: "1" };
  for (const key of LOCAL_MANTIS_CHILD_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

function copyMantisLocalProviderPlan(
  plan: MantisLocalProviderPlan,
): MantisLocalProviderPlan {
  if (
    !safeIdentifier(plan.scanId) ||
    !safeIdentifier(plan.connectionId) ||
    plan.routeKind !== "claude-code-local" ||
    plan.protocol !== "claude-code-cli" ||
    (plan.modelSelectionMode !== "catalog" && plan.modelSelectionMode !== "runtime-default") ||
    (plan.modelSelectionMode === "catalog"
      ? !safeIdentifier(plan.modelId)
      : plan.modelId !== null)
  ) throw new Error("Mantis local provider plan is invalid");
  return {
    scanId: plan.scanId,
    connectionId: plan.connectionId,
    routeKind: plan.routeKind,
    protocol: plan.protocol,
    modelSelectionMode: plan.modelSelectionMode,
    modelId: plan.modelId,
  };
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
}

/** HTTP credentials are read by the child from the native vault, never inherited. */
function workerEnvironmentWithoutOpenAiKeys(): NodeJS.ProcessEnv {
  const env = workerEnvironment();
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

function copyVulnHunterProviderPlan(
  plan: SafeVulnHunterProviderPlan,
): SafeVulnHunterProviderPlan {
  return {
    scanId: plan.scanId,
    connectionId: plan.connectionId,
    routeKind: plan.routeKind,
    protocol: plan.protocol,
    modelId: plan.modelId,
    capabilityCheckId: plan.capabilityCheckId,
  };
}

export function prepareScannerLaunch(input: ScannerLaunchInput): ScannerLaunch {
  const engine = input.request.engine ?? "codex-security";
  if (engine === "codex-security") return prepareCodexSecurity(input);
  if (engine === "mantis") return prepareMantis(input);
  if (engine === "vulnhunter") return prepareVulnHunter(input);
  throw new Error(`Scanner não suportado: ${engine}`);
}
