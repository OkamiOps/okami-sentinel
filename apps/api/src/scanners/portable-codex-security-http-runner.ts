import fs from "node:fs";
import path from "node:path";

import type {
  CapabilityReport,
  ProviderModel,
  ProviderProtocol,
  SafeProviderErrorCode,
  ScanConnectionSnapshot,
  ScanMode,
} from "@csb/shared";

import {
  createHttpAgentUpstream,
  isHttpAgentRouteProtocolSupported,
  type HttpAgentUpstreamOptions,
} from "../agent/http-agent-upstream.js";
import { PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT } from "../agent/result-artifact-contract.js";
import { createAgentSession } from "../agent/session-runner.js";
import {
  AgentSessionError,
  validateAgentSessionReasoningEffort,
  validateAgentSessionLimits,
  type AgentSession,
  type AgentSessionLimits,
  type AgentUpstream,
  type AgentSessionSpec,
} from "../agent/session-types.js";
import type { StoredProviderConnection } from "../connections-store.js";
import { resolveCompatibility } from "../connections/compatibility-resolver.js";
import type { XaiOAuthFlow } from "../connections/xai-oauth-flow.js";
import {
  VaultError,
  connectionSecretValues,
  type ConnectionSecretBundle,
  type CredentialVault,
  type SecretRedactorRegistry,
} from "../credentials/credential-vault.js";
import { globalSecretRedactor } from "../redaction.js";
import { normalizePortableCodexSecurityWorkspace } from "./portable-codex-security-normalize.js";
import {
  PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
  PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
  PORTABLE_CODEX_SECURITY_STAGES,
  buildPortableCodexSecurityStagePrompt,
  createSafePortableCodexSecurityProviderPlan,
  isPortableCodexSecurityRoute,
  type SafePortableCodexSecurityProviderPlan,
} from "./portable-codex-security-profile.js";
import {
  assertPortableCodexSecuritySnapshot,
  createPortableCodexSecurityAnchorValidationCache,
  createPortableCodexSecuritySnapshot,
  observePortableCodexSecurityStage,
  PORTABLE_CODEX_SECURITY_TOOL_SURFACE,
  PortableCodexSecurityStageError,
  type PortableCodexSecuritySnapshot,
} from "./portable-codex-security-worker-support.js";
import {
  createPortableCodexSecurityDossier,
  portableCodexSecurityDossierBase64,
  writePortableCodexSecurityDossier,
} from "./portable-codex-security-dossier.js";
import {
  createPortableCodexSecurityReportShards,
  writePortableCodexSecurityReportShards,
  type PortableCodexSecurityReportShardResult,
} from "./portable-codex-security-report-shards.js";
import { portableCodexSecurityReportCompletionTokens } from "./portable-codex-security-report-budget.js";
import {
  writePortableCodexSecurityRuntime,
  type PortableCodexSecurityRuntimeState,
} from "./portable-codex-security-runtime.js";
import type { ScannerUsage } from "./usage.js";
import {
  estimateFrozenScannerUsageCost,
  frozenScannerPricingSupportsCostBudget,
  isFrozenScannerPricing,
  type FrozenScannerPricing,
} from "../model-pricing.js";

export interface PortableCodexSecurityExecutionLimits {
  totalTimeoutMs: number;
  maxModelTurns: number;
  maxToolCalls: number;
  maxInputBytes: number;
  maxOutputBytes: number;
}

export interface PortableCodexSecurityCostBudget {
  /** Estimated USD ceiling: a response already in flight can exceed it once. */
  maxCostUsd: number;
  /** Frozen before the worker is spawned and contains no credential material. */
  pricing: FrozenScannerPricing;
}

/** The only child-process configuration: route identifiers and explicit local budgets. */
export interface PortableCodexSecurityWorkerConfiguration {
  outputDir: string;
  repositoryPath: string;
  paths: string[];
  sourceRef: string;
  mode: ScanMode;
  providerPlan: SafePortableCodexSecurityProviderPlan;
  limits: PortableCodexSecurityExecutionLimits;
  /** Published by the exact selected model; no provider credential material. */
  reasoningEffort?: string;
  /** Optional local ceiling that is enforceable only against frozen reported usage. */
  costBudget?: PortableCodexSecurityCostBudget;
}

export type PortableCodexSecurityRunnerErrorCode =
  | "provider_plan_invalid"
  | "provider_plan_revalidation_failed"
  | "credential_rejected"
  | "secure_storage_unavailable"
  | "agent_cancelled"
  | "agent_time_limit"
  | "agent_turn_limit"
  | "agent_tool_limit"
  | "agent_input_byte_limit"
  | "agent_output_byte_limit"
  | "cost_budget_unavailable"
  | "cost_limit_reached"
  | "agent_session_failed"
  | "stage_evidence_incomplete"
  | "stage_artifact_invalid"
  | "snapshot_invalid";

export class PortableCodexSecurityRunnerError extends Error {
  constructor(readonly code: PortableCodexSecurityRunnerErrorCode) {
    super(code);
    this.name = "PortableCodexSecurityRunnerError";
  }
}

export interface PortableCodexSecuritySessionInput {
  connection: StoredProviderConnection;
  model: ProviderModel;
  capability: CapabilityReport;
  credentials: ConnectionSecretBundle;
  spec: AgentSessionSpec;
  toolSurface: readonly string[];
}

export interface PortableCodexSecurityRunnerDependencies {
  getSnapshot(scanId: string): ScanConnectionSnapshot | null;
  getConnection(connectionId: string): StoredProviderConnection | null;
  getModel(connectionId: string, modelId: string): ProviderModel | null;
  getLatestCapabilityCheck(
    connectionId: string,
    modelId: string | null,
    protocol: ProviderProtocol,
  ): CapabilityReport | null;
  vault: Pick<CredentialVault, "get">;
  xaiOAuth?: Pick<XaiOAuthFlow, "getAccessToken">;
  createSession?: (input: PortableCodexSecuritySessionInput) => Promise<AgentSession>;
  createUpstream?: (options: HttpAgentUpstreamOptions) => AgentUpstream;
  signal?: AbortSignal;
  now?: () => Date;
  log?: (safeLine: string) => void;
  redactor?: SecretRedactorRegistry;
  /** Test seam for the synchronous, local normalization boundary. */
  normalizeWorkspace?: typeof normalizePortableCodexSecurityWorkspace;
  /** Monotonic wall-clock seam used by the single scan deadline. */
  clockMs?: () => number;
}

export interface PortableCodexSecurityRunResult {
  runtime: PortableCodexSecurityRuntimeState;
}

interface ResolvedPortablePlan {
  connection: StoredProviderConnection;
  model: ProviderModel;
  capability: CapabilityReport;
  directXaiOAuth: boolean;
}

interface TotalDeadline {
  signal: AbortSignal;
  timedOut(): boolean;
  remainingMs(): number;
  dispose(): void;
}

const MAX_CONFIG_PATHS = 256;
const MAX_PATH_LENGTH = 1_024;

export async function runPortableCodexSecurity(
  configuration: PortableCodexSecurityWorkerConfiguration,
  dependencies: PortableCodexSecurityRunnerDependencies,
): Promise<PortableCodexSecurityRunResult> {
  const safeConfiguration = validateConfiguration(configuration);
  const now = dependencies.now ?? (() => new Date());
  const externalSignal = dependencies.signal ?? new AbortController().signal;
  const deadline = createTotalDeadline(
    externalSignal,
    safeConfiguration.limits.totalTimeoutMs,
    dependencies.clockMs,
  );
  const outputDir = path.resolve(safeConfiguration.outputDir);
  const log = dependencies.log ?? (() => undefined);
  const authorizationTime = now();
  const startedAt = authorizationTime.toISOString();
  let runtime: PortableCodexSecurityRuntimeState = {
    engine: "codex-security",
    executionProfile: "portable",
    profileVersion: PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
    methodologyRef: PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
    status: "preparing",
    stage: "inventory",
    stageLabel: "Portable Codex Security bootstrap",
    percent: 1,
    detail: "revalidating the selected portable profile",
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    snapshotId: null,
    sourceRef: safeConfiguration.sourceRef,
    findings: 0,
    usage: emptyUsage(),
    error: null,
    errorCode: null,
  };
  // A rejected persisted plan must be indistinguishable from no attempted
  // launch: no runtime ledger or output directory exists before revalidation.
  let runtimeWritable = false;
  const update = (patch: Partial<PortableCodexSecurityRuntimeState>) => {
    runtime = { ...runtime, ...patch, updatedAt: now().toISOString() };
    if (!runtimeWritable) return;
    writePortableCodexSecurityRuntime(outputDir, runtime);
    log(globalSecretRedactor.redactText(`SENTINEL_PROGRESS ${JSON.stringify({
      percent: runtime.percent,
      phaseLabel: runtime.stageLabel,
      detail: runtime.detail,
      stage: runtime.stage,
      findings: runtime.findings,
    })}`));
  };
  let activeSession: AgentSession | null = null;
  let sessionCancelled = false;
  const cancelActive = () => {
    if (activeSession !== null && !sessionCancelled) {
      sessionCancelled = true;
      void activeSession.cancel().catch(() => undefined);
    }
  };
  deadline.signal.addEventListener("abort", cancelActive, { once: true });

  let releaseRedaction = () => undefined;
  let costBudgetStop: "cost_budget_unavailable" | "cost_limit_reached" | null = null;
  try {
    throwIfStopped(deadline);
    const plan = createSafePortableCodexSecurityProviderPlan(safeConfiguration.providerPlan);
    let resolved = revalidatePortablePlan(
      plan,
      safeConfiguration.reasoningEffort,
      dependencies,
      authorizationTime,
    );
    assertPortableCostBudget(safeConfiguration.costBudget, plan, resolved);
    const snapshot = createPortableCodexSecuritySnapshot(
      safeConfiguration.repositoryPath,
      outputDir,
    );
    assertPortableCodexSecuritySnapshot(snapshot);
    throwIfStopped(deadline);
    // Snapshotting is local-only; repeat metadata validation immediately
    // before crossing into the vault/network credential boundary.
    resolved = revalidatePortablePlan(
      plan,
      safeConfiguration.reasoningEffort,
      dependencies,
      authorizationTime,
    );
    throwIfStopped(deadline);
    runtime = {
      ...runtime,
      percent: 5,
      detail: "immutable source snapshot pinned",
      snapshotId: snapshot.snapshotId,
      updatedAt: now().toISOString(),
    };
    runtimeWritable = true;
    writePortableCodexSecurityRuntime(outputDir, runtime);

    const credentials = resolved.directXaiOAuth
      ? await readXaiOAuthCredentials(resolved.connection, dependencies.xaiOAuth, deadline)
      : await readVaultCredentials(resolved.connection.credentialRef, dependencies.vault, deadline);
    const scope = `portable-codex-security/${plan.scanId}`;
    const values = connectionSecretValues(credentials);
    const configuredRedactor = dependencies.redactor ?? globalSecretRedactor;
    configuredRedactor.register(scope, values);
    if (configuredRedactor !== globalSecretRedactor) globalSecretRedactor.register(scope, values);
    releaseRedaction = () => {
      configuredRedactor.unregister(scope);
      if (configuredRedactor !== globalSecretRedactor) globalSecretRedactor.unregister(scope);
    };

    const artifactsRoot = path.join(outputDir, "portable-codex-security-artifacts");
    fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
    update({
      status: "running",
      percent: 8,
      detail: "snapshot pinned; starting bounded portable stages",
      snapshotId: snapshot.snapshotId,
    });

    const createSession = dependencies.createSession ?? productionSessionFactory(dependencies.createUpstream);
    const anchorValidationCache = createPortableCodexSecurityAnchorValidationCache();
    let dossier = createPortableCodexSecurityDossier();
    let dossierStateBase64: string | null = null;
    let reportShardResults: PortableCodexSecurityReportShardResult[] | null = null;
    for (const stage of PORTABLE_CODEX_SECURITY_STAGES) {
      throwIfStopped(deadline);
      resolved = revalidatePortablePlan(
        plan,
        safeConfiguration.reasoningEffort,
        dependencies,
        authorizationTime,
      );
      assertPortableCodexSecuritySnapshot(snapshot);
      const remaining = deadline.remainingMs();
      if (remaining <= 0) throw new PortableCodexSecurityRunnerError("agent_time_limit");
      update({
        stage: stage.id,
        stageLabel: stage.label,
        percent: stage.startPercent,
        detail: `running ${stage.label.toLowerCase()}`,
      });
      const shards = stage.id === "report"
        ? createPortableCodexSecurityReportShards(dossier, {
          maxShards: Math.max(1, Math.floor(safeConfiguration.limits.maxModelTurns / 4)),
        })
        : null;
      const pageResults: PortableCodexSecurityReportShardResult[] = [];
      for (const shard of shards ?? [null]) {
        const stageDossier = shard?.dossier ?? dossier;
        const stageDossierStateBase64 = shard === null
          ? dossierStateBase64
          : portableCodexSecurityDossierBase64(stageDossier);
        const artifactRoot = path.join(
          artifactsRoot,
          shard === null ? stage.id : `${stage.id}-${String(shard.index + 1).padStart(2, "0")}`,
        );
        fs.mkdirSync(artifactRoot, { recursive: false, mode: 0o700 });
        const spec: AgentSessionSpec = {
        connectionId: resolved.connection.id,
        routeKind: resolved.connection.routeKind,
        protocol: resolved.connection.protocol as AgentSessionSpec["protocol"],
        model: resolved.model,
        ...(safeConfiguration.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: safeConfiguration.reasoningEffort }),
        terminalMode: "artifact-write",
        ...(stage.id === "report"
          ? { maxCompletionTokens: portableCodexSecurityReportCompletionTokens(stageDossier) }
          : {}),
        resultArtifactContract: PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT,
        resultArtifactValidationContext: {
          dossier: stageDossier,
          ...(shard === null ? {} : { reportShard: shard }),
        },
        snapshotRoot: snapshot.snapshotRoot,
        artifactRoot,
        instructions: buildPortableCodexSecurityStagePrompt(stage, {
          snapshotRoot: snapshot.snapshotRoot,
          artifactRoot,
          scopePaths: safeConfiguration.paths,
          dossierStateBase64: stageDossierStateBase64,
          candidateIds: stageDossier.candidates.map((candidate) => candidate.id),
          ...(shard === null ? {} : { reportShard: shard }),
        }),
        limits: shard === null
          ? sessionLimits(safeConfiguration.limits, remaining)
          : reportShardSessionLimits(safeConfiguration.limits, remaining, shards!.length),
        signal: deadline.signal,
        };
        activeSession = await raceWithDeadline(
        createSession({
          connection: resolved.connection,
          model: resolved.model,
          capability: resolved.capability,
          credentials,
          spec,
          toolSurface: PORTABLE_CODEX_SECURITY_TOOL_SURFACE,
        }),
        deadline,
        );
        sessionCancelled = false;
        const observed = await observePortableCodexSecurityStage({
        session: activeSession,
        stage,
        artifactRoot,
        dossier: stageDossier,
        snapshotRoot: snapshot.snapshotRoot,
        usage: runtime.usage,
        signal: deadline.signal,
        remainingMs: deadline.remainingMs,
        anchorValidationCache,
        redact: globalSecretRedactor.redactText.bind(globalSecretRedactor),
        onEvent: (safeEvent) => log(safeEvent),
        onUsage: (usage) => {
          runtime = { ...runtime, usage, updatedAt: now().toISOString() };
          if (runtimeWritable) writePortableCodexSecurityRuntime(outputDir, runtime);
          const stop = costBudgetStopCode(safeConfiguration.costBudget, usage);
          if (stop !== null) {
            costBudgetStop = stop;
            cancelActive();
            return false;
          }
          return true;
        },
        });
        activeSession = null;
        sessionCancelled = false;
        runtime = { ...runtime, usage: observed.usage };
        if (shard === null) {
          dossier = observed.dossier;
          dossierStateBase64 = observed.dossierStateBase64;
        } else {
          if (observed.report === undefined) throw new PortableCodexSecurityRunnerError("stage_artifact_invalid");
          pageResults.push({ shard, report: observed.report });
        }
      }
      if (shards !== null) reportShardResults = pageResults;
      update({ percent: stage.completePercent, detail: `${stage.label} complete` });
    }

    throwIfStopped(deadline);
    if (reportShardResults === null) throw new PortableCodexSecurityRunnerError("stage_artifact_invalid");
    update({
      stage: "normalize",
      stageLabel: "Normalize evidence",
      percent: 99,
      detail: "mapping portable findings into Sentinel's canonical schema",
    });
    const resultsDir = path.join(outputDir, "portable-codex-security-results");
    writePortableCodexSecurityReportShards(resultsDir, dossier, reportShardResults);
    writePortableCodexSecurityDossier(resultsDir, dossier);
    const findings = (dependencies.normalizeWorkspace ?? normalizePortableCodexSecurityWorkspace)(
      resultsDir,
      outputDir,
      {
        redactor: globalSecretRedactor,
      },
    );
    throwIfStopped(deadline);
    update({
      status: "completed",
      stage: "report",
      stageLabel: "Complete",
      percent: 100,
      detail: `${findings} reportable findings normalized`,
      findings,
      completedAt: now().toISOString(),
    });
    return { runtime };
  } catch (error) {
    const normalized = normalizeRunnerError(error, deadline, costBudgetStop);
    runtime = {
      ...runtime,
      status: normalized.code === "agent_cancelled" ? "cancelled" : "failed",
      detail: normalized.code,
      error: normalized.code,
      errorCode: safeProviderCode(normalized.code),
      completedAt: now().toISOString(),
      updatedAt: now().toISOString(),
    };
    if (runtimeWritable) writePortableCodexSecurityRuntime(outputDir, runtime);
    throw normalized;
  } finally {
    deadline.signal.removeEventListener("abort", cancelActive);
    cancelActive();
    releaseRedaction();
    deadline.dispose();
  }
}

function validateConfiguration(
  value: PortableCodexSecurityWorkerConfiguration,
): PortableCodexSecurityWorkerConfiguration {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set([
    "outputDir", "repositoryPath", "paths", "sourceRef", "mode", "providerPlan", "limits", "reasoningEffort", "costBudget",
  ]))) invalidPlan();
  if (
    !isSafeText(value.outputDir, MAX_PATH_LENGTH * 4) ||
    !isSafeText(value.repositoryPath, MAX_PATH_LENGTH * 4) ||
    !isSafeText(value.sourceRef, 256) ||
    (value.mode !== "standard" && value.mode !== "deep") ||
    !Array.isArray(value.paths) ||
    value.paths.length > MAX_CONFIG_PATHS ||
    !value.paths.every((item) => isSafeRelativePath(item, MAX_PATH_LENGTH)) ||
    !validLimits(value.limits) ||
    (value.reasoningEffort !== undefined && !isSafeText(value.reasoningEffort, 64)) ||
    (value.costBudget !== undefined && !validCostBudget(value.costBudget))
  ) invalidPlan();
  try {
    return {
      outputDir: value.outputDir,
      repositoryPath: value.repositoryPath,
      paths: [...value.paths],
      sourceRef: value.sourceRef,
      mode: value.mode,
      providerPlan: createSafePortableCodexSecurityProviderPlan(value.providerPlan),
      limits: { ...value.limits },
      ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
      ...(value.costBudget === undefined ? {} : { costBudget: value.costBudget }),
    };
  } catch {
    invalidPlan();
  }
}

function revalidatePortablePlan(
  plan: SafePortableCodexSecurityProviderPlan,
  reasoningEffort: string | undefined,
  dependencies: PortableCodexSecurityRunnerDependencies,
  now: Date,
): ResolvedPortablePlan {
  const snapshot = dependencies.getSnapshot(plan.scanId);
  const connection = dependencies.getConnection(plan.connectionId);
  if (
    !matchesSnapshot(snapshot, plan) ||
    connection === null ||
    connection.id !== plan.connectionId ||
    connection.routeKind !== plan.routeKind ||
    connection.protocol !== plan.protocol ||
    connection.transport !== "http-inference" ||
    !isPortableCodexSecurityRoute(connection.routeKind, connection.protocol) ||
    snapshot.protocol !== connection.protocol ||
    snapshot.authKind !== connection.authKind
  ) {
    throw new PortableCodexSecurityRunnerError("provider_plan_revalidation_failed");
  }
  const directXaiOAuth = isExactXaiOAuth(connection);
  if (
    (plan.routeKind === "xai-oauth" || plan.protocol === "xai-oauth-responses") && !directXaiOAuth ||
    (!directXaiOAuth && !isIdentifier(connection.credentialRef))
  ) {
    throw new PortableCodexSecurityRunnerError("provider_plan_revalidation_failed");
  }
  const model = dependencies.getModel(connection.id, plan.modelId);
  if (model === null || model.connectionId !== connection.id || model.id !== plan.modelId) {
    throw new PortableCodexSecurityRunnerError("provider_plan_revalidation_failed");
  }
  try {
    validateAgentSessionReasoningEffort(
      model,
      reasoningEffort,
      connection.routeKind,
      connection.protocol,
    );
  } catch {
    throw new PortableCodexSecurityRunnerError("provider_plan_revalidation_failed");
  }
  const capability = dependencies.getLatestCapabilityCheck(connection.id, model.id, connection.protocol);
  if (capability === null || capability.id !== plan.capabilityCheckId) {
    throw new PortableCodexSecurityRunnerError("provider_plan_revalidation_failed");
  }
  const compatibility = resolveCompatibility({
    engine: "codex-security",
    connection,
    selection: { connectionId: plan.connectionId, modelSelectionMode: "catalog", modelId: plan.modelId },
    model,
    probe: capability,
    now,
    executionProfilePreference: "portable",
  });
  if (
    !compatibility.eligible ||
    compatibility.selectedProfile !== "portable" ||
    compatibility.runnerKind !== "agent-session" ||
    compatibility.protocol !== plan.protocol ||
    compatibility.capabilityCheckId !== plan.capabilityCheckId ||
    compatibility.profileVersion !== plan.profileVersion ||
    compatibility.methodologyRef !== plan.methodologyRef
  ) {
    throw new PortableCodexSecurityRunnerError("provider_plan_revalidation_failed");
  }
  return { connection, model, capability, directXaiOAuth };
}

function assertPortableCostBudget(
  budget: PortableCodexSecurityCostBudget | undefined,
  plan: SafePortableCodexSecurityProviderPlan,
  resolved: ResolvedPortablePlan,
): void {
  if (budget === undefined) return;
  const pricing = budget.pricing;
  if (
    resolved.capability.capabilities.usage !== "supported" ||
    pricing.connectionId !== plan.connectionId ||
    pricing.routeKind !== plan.routeKind ||
    pricing.protocol !== plan.protocol ||
    pricing.modelId !== plan.modelId ||
    pricing.providerKind !== resolved.connection.providerKind ||
    !frozenScannerPricingSupportsCostBudget(pricing)
  ) {
    throw new PortableCodexSecurityRunnerError("cost_budget_unavailable");
  }
}

function costBudgetStopCode(
  budget: PortableCodexSecurityCostBudget | undefined,
  usage: ScannerUsage,
): "cost_budget_unavailable" | "cost_limit_reached" | null {
  if (budget === undefined) return null;
  const estimate = estimateFrozenScannerUsageCost(usage, budget.pricing);
  if (estimate === null) return "cost_budget_unavailable";
  return estimate.estimatedUsd >= budget.maxCostUsd ? "cost_limit_reached" : null;
}

function productionSessionFactory(
  createUpstream: (options: HttpAgentUpstreamOptions) => AgentUpstream = createHttpAgentUpstream,
): (input: PortableCodexSecuritySessionInput) => Promise<AgentSession> {
  return async (input) => {
    if (!isHttpAgentRouteProtocolSupported(input.connection.routeKind, input.connection.protocol)) {
      throw new PortableCodexSecurityRunnerError("provider_plan_revalidation_failed");
    }
    const upstream = createUpstream({
      routeKind: input.connection.routeKind,
      protocol: input.connection.protocol,
      credentials: input.credentials,
    });
    return createAgentSession({ ...input.spec, probe: input.capability.capabilities }, upstream);
  };
}

async function readXaiOAuthCredentials(
  connection: StoredProviderConnection,
  xaiOAuth: Pick<XaiOAuthFlow, "getAccessToken"> | undefined,
  deadline: TotalDeadline,
): Promise<ConnectionSecretBundle> {
  if (xaiOAuth === undefined) throw new PortableCodexSecurityRunnerError("credential_rejected");
  try {
    const token = await raceWithDeadline(
      xaiOAuth.getAccessToken(connection.id, deadline.signal),
      deadline,
    );
    if (!isSafeText(token, 32_768)) throw new PortableCodexSecurityRunnerError("credential_rejected");
    return { apiKey: token };
  } catch (error) {
    if (error instanceof PortableCodexSecurityRunnerError) throw error;
    throw new PortableCodexSecurityRunnerError("credential_rejected");
  }
}

async function readVaultCredentials(
  credentialRef: string | null,
  vault: Pick<CredentialVault, "get">,
  deadline: TotalDeadline,
): Promise<ConnectionSecretBundle> {
  if (!isIdentifier(credentialRef)) throw new PortableCodexSecurityRunnerError("provider_plan_revalidation_failed");
  try {
    return await raceWithDeadline(vault.get(credentialRef), deadline);
  } catch (error) {
    if (error instanceof PortableCodexSecurityRunnerError) throw error;
    if (error instanceof VaultError && error.code === "secure_storage_unavailable") {
      throw new PortableCodexSecurityRunnerError("secure_storage_unavailable");
    }
    throw new PortableCodexSecurityRunnerError("credential_rejected");
  }
}

function sessionLimits(
  limits: PortableCodexSecurityExecutionLimits,
  remainingMs: number,
): AgentSessionLimits {
  const result: AgentSessionLimits = {
    maxModelTurns: limits.maxModelTurns,
    maxToolCalls: limits.maxToolCalls,
    maxInputBytes: limits.maxInputBytes,
    maxOutputBytes: limits.maxOutputBytes,
    timeoutMs: Math.max(1, Math.floor(remainingMs)),
  };
  validateAgentSessionLimits(result);
  return result;
}

/** Normal report turns/tools are divided across pages; deadline and cost stay global. */
function reportShardSessionLimits(
  limits: PortableCodexSecurityExecutionLimits,
  remainingMs: number,
  shardCount: number,
): AgentSessionLimits {
  const maxModelTurns = Math.floor(limits.maxModelTurns / shardCount);
  const maxToolCalls = Math.floor(limits.maxToolCalls / shardCount);
  if (maxModelTurns < 4 || maxToolCalls < 2) {
    throw new PortableCodexSecurityRunnerError("agent_turn_limit");
  }
  return sessionLimits({ ...limits, maxModelTurns, maxToolCalls }, remainingMs);
}

function createTotalDeadline(
  signal: AbortSignal,
  timeoutMs: number,
  clockMs: () => number = Date.now,
): TotalDeadline {
  const controller = new AbortController();
  const deadlineAt = clockMs() + timeoutMs;
  let timeoutElapsed = false;
  const forwardAbort = () => controller.abort();
  if (signal.aborted) forwardAbort();
  else signal.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutElapsed = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutElapsed || clockMs() >= deadlineAt,
    remainingMs: () => Math.max(0, deadlineAt - clockMs()),
    dispose() {
      clearTimeout(timer);
      signal.removeEventListener("abort", forwardAbort);
    },
  };
}

function raceWithDeadline<T>(operation: Promise<T>, deadline: TotalDeadline): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      reject(new PortableCodexSecurityRunnerError(
        deadline.timedOut() ? "agent_time_limit" : "agent_cancelled",
      ));
    };
    if (deadline.signal.aborted) stop();
    else deadline.signal.addEventListener("abort", stop, { once: true });
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        deadline.signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        deadline.signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

function throwIfStopped(deadline: TotalDeadline): void {
  if (!deadline.signal.aborted && deadline.remainingMs() > 0) return;
  throw new PortableCodexSecurityRunnerError(
    deadline.timedOut() ? "agent_time_limit" : "agent_cancelled",
  );
}

function normalizeRunnerError(
  error: unknown,
  deadline: TotalDeadline,
  costBudgetStop: "cost_budget_unavailable" | "cost_limit_reached" | null,
): PortableCodexSecurityRunnerError {
  if (deadline.signal.aborted) {
    return new PortableCodexSecurityRunnerError(
      deadline.timedOut() ? "agent_time_limit" : "agent_cancelled",
    );
  }
  if (costBudgetStop !== null) return new PortableCodexSecurityRunnerError(costBudgetStop);
  if (error instanceof PortableCodexSecurityRunnerError) return error;
  if (error instanceof PortableCodexSecurityStageError) {
    return new PortableCodexSecurityRunnerError(error.code);
  }
  if (error instanceof AgentSessionError && error.code === "agent_cancelled") {
    return new PortableCodexSecurityRunnerError("agent_cancelled");
  }
  return new PortableCodexSecurityRunnerError("agent_session_failed");
}

function matchesSnapshot(
  snapshot: ScanConnectionSnapshot | null,
  plan: SafePortableCodexSecurityProviderPlan,
): snapshot is ScanConnectionSnapshot {
  return snapshot !== null &&
    snapshot.scanId === plan.scanId &&
    snapshot.connectionId === plan.connectionId &&
    snapshot.routeKind === plan.routeKind &&
    snapshot.modelSelectionMode === "catalog" &&
    snapshot.modelId === plan.modelId &&
    snapshot.capabilityCheckId === plan.capabilityCheckId &&
    snapshot.executionProfile === "portable" &&
    snapshot.profileVersion === plan.profileVersion &&
    snapshot.methodologyRef === plan.methodologyRef &&
    snapshot.protocol === plan.protocol;
}

function isExactXaiOAuth(connection: StoredProviderConnection): boolean {
  return connection.providerKind === "xai" &&
    connection.routeKind === "xai-oauth" &&
    connection.transport === "http-inference" &&
    connection.authKind === "device-code" &&
    connection.protocol === "xai-oauth-responses" &&
    connection.credentialRef === null;
}

function emptyUsage(): ScannerUsage {
  return {
    reported: false,
    inputTokensKnown: false,
    cachedInputTokensKnown: false,
    cacheWriteInputTokensKnown: false,
    outputTokensKnown: false,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
}

function validLimits(value: unknown): value is PortableCodexSecurityExecutionLimits {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set([
    "totalTimeoutMs", "maxModelTurns", "maxToolCalls", "maxInputBytes", "maxOutputBytes",
  ]))) return false;
  const totalTimeoutMs = value.totalTimeoutMs;
  const maxModelTurns = value.maxModelTurns;
  const maxToolCalls = value.maxToolCalls;
  const maxInputBytes = value.maxInputBytes;
  const maxOutputBytes = value.maxOutputBytes;
  if (![totalTimeoutMs, maxModelTurns, maxToolCalls, maxInputBytes, maxOutputBytes].every(
    (item) => typeof item === "number" && Number.isSafeInteger(item) && item > 0,
  )) return false;
  const safeLimits: PortableCodexSecurityExecutionLimits = {
    totalTimeoutMs: totalTimeoutMs as number,
    maxModelTurns: maxModelTurns as number,
    maxToolCalls: maxToolCalls as number,
    maxInputBytes: maxInputBytes as number,
    maxOutputBytes: maxOutputBytes as number,
  };
  if (safeLimits.totalTimeoutMs > 5_400_000) return false;
  try {
    validateAgentSessionLimits({
      maxModelTurns: safeLimits.maxModelTurns,
      maxToolCalls: safeLimits.maxToolCalls,
      maxInputBytes: safeLimits.maxInputBytes,
      maxOutputBytes: safeLimits.maxOutputBytes,
      timeoutMs: safeLimits.totalTimeoutMs,
    });
    return true;
  } catch {
    return false;
  }
}

function validCostBudget(value: unknown): value is PortableCodexSecurityCostBudget {
  return isRecord(value) && hasOnlyKeys(value, new Set(["maxCostUsd", "pricing"])) &&
    typeof value.maxCostUsd === "number" && Number.isFinite(value.maxCostUsd) &&
    value.maxCostUsd > 0 && isFrozenScannerPricing(value.pricing);
}

function safeProviderCode(value: string): SafeProviderErrorCode | null {
  return value === "credential_rejected" || value === "secure_storage_unavailable"
    ? value
    : null;
}

function isSafeText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit &&
    !/[\u0000-\u001F\u007F]/.test(value);
}

function isSafeRelativePath(value: unknown, limit: number): value is string {
  if (!isSafeText(value, limit) || value !== value.trim() || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false;
  }
  return value.split(/[\\/]+/).every((segment) => segment !== "..");
}

function isIdentifier(value: unknown): value is string {
  return isSafeText(value, 256);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function invalidPlan(): never {
  throw new PortableCodexSecurityRunnerError("provider_plan_invalid");
}
