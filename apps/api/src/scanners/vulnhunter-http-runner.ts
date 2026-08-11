import type {
  CapabilityReport,
  ModelCapabilities,
  ProviderModel,
  ProviderProtocol,
  ScanConnectionSnapshot,
} from "@csb/shared";

import {
  createHttpAgentUpstream,
  isHttpAgentRouteProtocolSupported,
  type HttpAgentProtocol,
  type HttpAgentUpstreamOptions,
} from "../agent/http-agent-upstream.js";
import {
  DEFAULT_AGENT_LIMITS,
  createAgentSession,
} from "../agent/session-runner.js";
import {
  AgentSessionError,
  validateAgentSessionLimits,
  type AgentEvent,
  type AgentSession,
  type AgentSessionLimits,
  type AgentUpstream,
  type CreateAgentSessionInput,
} from "../agent/session-types.js";
import type { StoredProviderConnection } from "../connections-store.js";
import { DEFAULT_CAPABILITY_PROBE_MAX_AGE_MS } from "../connections/compatibility-resolver.js";
import type { XaiOAuthFlow } from "../connections/xai-oauth-flow.js";
import type {
  ConnectionSecretBundle,
  CredentialVault,
} from "../credentials/credential-vault.js";
import type { SafeVulnHunterProviderPlan } from "./vulnhunter-runtime.js";

export type { SafeVulnHunterProviderPlan } from "./vulnhunter-runtime.js";

/**
 * This is the only provider material allowed to cross from the API launcher
 * into the VulnHunter child process. Endpoints, headers, and credentials stay
 * in native storage and are re-resolved only after this reference validates.
 */
export type VulnHunterHttpRunnerErrorCode = "provider_plan_invalid";

/** Stable, secret-free failure for every invalid re-resolution condition. */
export class VulnHunterHttpRunnerError extends Error {
  constructor(readonly code: VulnHunterHttpRunnerErrorCode) {
    super(code);
    this.name = "VulnHunterHttpRunnerError";
  }
}

export interface VulnHunterHttpPlanStore {
  getSnapshot(scanId: string): ScanConnectionSnapshot | null;
  get(id: string): StoredProviderConnection | null;
  getModel(connectionId: string, modelId: string): ProviderModel | null;
  getLatestCapabilityCheck(
    connectionId: string,
    modelId: string | null,
    protocol: ProviderProtocol,
  ): CapabilityReport | null;
}

export interface VulnHunterHttpRunnerDependencies {
  store: VulnHunterHttpPlanStore;
  vault: Pick<CredentialVault, "get">;
  /** xAI OAuth stays in its dedicated native credential namespace. */
  xaiOAuth?: Pick<XaiOAuthFlow, "getAccessToken">;
  createUpstream?: (options: HttpAgentUpstreamOptions) => AgentUpstream;
  createSession?: (
    input: CreateAgentSessionInput,
    upstream: AgentUpstream,
  ) => Promise<AgentSession>;
  /** Private test seam; production always uses bounded default session limits. */
  limits?: Partial<AgentSessionLimits>;
  /** Private test seams; production uses the shared probe TTL and wall clock. */
  now?: () => Date;
  maxProbeAgeMs?: number;
}

export interface RunVulnHunterHttpPlanInput {
  plan: SafeVulnHunterProviderPlan;
  snapshotRoot: string;
  resultsDir: string;
  instructions: string;
  signal: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface VulnHunterHttpRunner {
  run(input: RunVulnHunterHttpPlanInput): Promise<void>;
}

/**
 * Resolves the immutable connection snapshot again inside the child process.
 * xAI OAuth uses its isolated credential store only after this validation.
 */
export function createVulnHunterHttpRunner(
  dependencies: VulnHunterHttpRunnerDependencies,
): VulnHunterHttpRunner {
  const createUpstream = dependencies.createUpstream ?? createHttpAgentUpstream;
  const createSession = dependencies.createSession ?? createAgentSession;
  const limits: AgentSessionLimits = {
    ...DEFAULT_AGENT_LIMITS,
    ...(dependencies.limits ?? {}),
  };
  const now = dependencies.now ?? (() => new Date());
  const maxProbeAgeMs = dependencies.maxProbeAgeMs ?? DEFAULT_CAPABILITY_PROBE_MAX_AGE_MS;

  return {
    async run(input) {
      validateAgentSessionLimits(limits);
      const startedAt = Date.now();
      const preflight = createPreflightGuard(input.signal, limits.timeoutMs);
      try {
        if (preflight.signal.aborted) throw preflight.stopError();
        const resolved = await racePreflight(
          resolvePlan(
            input.plan,
            dependencies.store,
            dependencies.vault,
            dependencies.xaiOAuth,
            preflight.signal,
            now(),
            maxProbeAgeMs,
          ),
          preflight,
        );
        if (preflight.signal.aborted || input.signal.aborted) throw preflight.stopError();
        const remainingTimeoutMs = limits.timeoutMs - (Date.now() - startedAt);
        if (remainingTimeoutMs <= 0) throw new AgentSessionError("agent_time_limit");
        preflight.dispose();

        const upstream = createUpstream({
          routeKind: resolved.connection.routeKind,
          protocol: resolved.protocol,
          credentials: resolved.credentials,
        });
        const session = await createSession({
          connectionId: resolved.connection.id,
          routeKind: resolved.connection.routeKind,
          protocol: resolved.protocol,
          model: resolved.model,
          snapshotRoot: input.snapshotRoot,
          artifactRoot: input.resultsDir,
          instructions: input.instructions,
          limits: { ...limits, timeoutMs: remainingTimeoutMs },
          signal: input.signal,
          probe: resolved.capability.capabilities,
        }, upstream);

        for await (const event of session.run()) {
          await input.onEvent?.(event);
        }
      } finally {
        preflight.dispose();
      }
    },
  };
}

interface ResolvedVulnHunterHttpPlan {
  connection: StoredProviderConnection;
  model: ProviderModel;
  capability: CapabilityReport;
  protocol: HttpAgentProtocol;
  credentials: ConnectionSecretBundle;
}

async function resolvePlan(
  plan: SafeVulnHunterProviderPlan,
  store: VulnHunterHttpPlanStore,
  vault: Pick<CredentialVault, "get">,
  xaiOAuth: Pick<XaiOAuthFlow, "getAccessToken"> | undefined,
  signal: AbortSignal,
  now: Date,
  maxProbeAgeMs: number,
): Promise<ResolvedVulnHunterHttpPlan> {
  if (!isSafePlan(plan) || !isHttpAgentRouteProtocolSupported(plan.routeKind, plan.protocol)) {
    invalidPlan();
  }
  const snapshot = store.getSnapshot(plan.scanId);
  if (!matchesSnapshot(plan, snapshot)) invalidPlan();

  const connection = store.get(plan.connectionId);
  if (
    connection === null ||
    connection.status !== "ready" ||
    connection.transport !== "http-inference" ||
    connection.routeKind !== plan.routeKind ||
    connection.protocol !== plan.protocol ||
    connection.modelCatalogStale === true
  ) invalidPlan();
  if (!isHttpAgentRouteProtocolSupported(connection.routeKind, connection.protocol)) invalidPlan();
  const directXaiOAuth = isDirectXaiOAuthConnection(connection);
  if (
    (connection.routeKind === "xai-oauth" || connection.protocol === "xai-oauth-responses") &&
    !directXaiOAuth
  ) invalidPlan();
  if (!directXaiOAuth && connection.credentialRef === null) invalidPlan();

  const model = store.getModel(plan.connectionId, plan.modelId);
  if (model === null || model.connectionId !== connection.id || model.id !== plan.modelId) {
    invalidPlan();
  }
  const capability = store.getLatestCapabilityCheck(
    connection.id,
    model.id,
    connection.protocol,
  );
  if (!matchesCapability(plan, capability, connection.protocol, now, maxProbeAgeMs)) invalidPlan();

  const credentials = directXaiOAuth
    ? await resolveXaiOAuthCredentials(connection, xaiOAuth, signal)
    : await resolveVaultCredentials(connection.credentialRef!, vault);
  return {
    connection,
    model,
    capability,
    protocol: connection.protocol,
    credentials,
  };
}

async function resolveXaiOAuthCredentials(
  connection: StoredProviderConnection,
  xaiOAuth: Pick<XaiOAuthFlow, "getAccessToken"> | undefined,
  signal: AbortSignal,
): Promise<ConnectionSecretBundle> {
  if (xaiOAuth === undefined) invalidPlan();
  try {
    const accessToken = await xaiOAuth.getAccessToken(connection.id, signal);
    if (!isNonEmptyText(accessToken)) invalidPlan();
    return { apiKey: accessToken };
  } catch {
    invalidPlan();
  }
}

interface PreflightGuard {
  signal: AbortSignal;
  stopError(): AgentSessionError;
  dispose(): void;
}

function createPreflightGuard(signal: AbortSignal, timeoutMs: number): PreflightGuard {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref();
  return {
    signal: controller.signal,
    stopError: () => new AgentSessionError(timedOut ? "agent_time_limit" : "agent_cancelled"),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    },
  };
}

function racePreflight<T>(operation: Promise<T>, guard: PreflightGuard): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      reject(guard.stopError());
    };
    if (guard.signal.aborted) stop();
    else guard.signal.addEventListener("abort", stop, { once: true });
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        guard.signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        guard.signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

async function resolveVaultCredentials(
  credentialRef: string,
  vault: Pick<CredentialVault, "get">,
): Promise<ConnectionSecretBundle> {
  try {
    return await vault.get(credentialRef);
  } catch {
    invalidPlan();
  }
}

function isSafePlan(value: SafeVulnHunterProviderPlan): boolean {
  return isIdentifier(value.scanId) &&
    isIdentifier(value.connectionId) &&
    isIdentifier(value.routeKind) &&
    isIdentifier(value.modelId) &&
    isIdentifier(value.capabilityCheckId) &&
    typeof value.protocol === "string";
}

function matchesSnapshot(
  plan: SafeVulnHunterProviderPlan,
  snapshot: ScanConnectionSnapshot | null,
): snapshot is ScanConnectionSnapshot {
  return snapshot !== null &&
    snapshot.scanId === plan.scanId &&
    snapshot.connectionId === plan.connectionId &&
    snapshot.routeKind === plan.routeKind &&
    snapshot.modelSelectionMode === "catalog" &&
    snapshot.modelId === plan.modelId &&
    snapshot.capabilityCheckId === plan.capabilityCheckId;
}

function matchesCapability(
  plan: SafeVulnHunterProviderPlan,
  capability: CapabilityReport | null,
  protocol: ProviderProtocol,
  now: Date,
  maxProbeAgeMs: number,
): capability is CapabilityReport {
  if (capability === null || !isCurrentCapability(capability, now, maxProbeAgeMs)) return false;
  return capability !== null &&
    capability.id === plan.capabilityCheckId &&
    capability.connectionId === plan.connectionId &&
    capability.modelId === plan.modelId &&
    capability.protocol === protocol &&
    capability.status === "passed" &&
    supportsBoundedAgent(capability.capabilities);
}

function supportsBoundedAgent(capabilities: ModelCapabilities): boolean {
  return capabilities.tools === "supported" &&
    capabilities.artifactOutput === "supported" &&
    capabilities.structuredOutput === "supported" &&
    capabilities.boundedExecution === "supported" &&
    capabilities.cancellation === "supported" &&
    capabilities.osIsolation === "supported";
}

function isCurrentCapability(
  capability: CapabilityReport,
  now: Date,
  maxProbeAgeMs: number,
): boolean {
  const checkedAt = Date.parse(capability.checkedAt);
  const nowMs = now.getTime();
  return Number.isFinite(checkedAt) &&
    Number.isSafeInteger(nowMs) &&
    Number.isSafeInteger(maxProbeAgeMs) &&
    maxProbeAgeMs > 0 &&
    checkedAt <= nowMs &&
    nowMs - checkedAt <= maxProbeAgeMs;
}

function isDirectXaiOAuthConnection(connection: StoredProviderConnection): boolean {
  return connection.providerKind === "xai" &&
    connection.routeKind === "xai-oauth" &&
    connection.transport === "http-inference" &&
    connection.authKind === "device-code" &&
    connection.protocol === "xai-oauth-responses";
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001F\u007F]/.test(value);
}

function invalidPlan(): never {
  throw new VulnHunterHttpRunnerError("provider_plan_invalid");
}
