import type {
  CapabilityReport,
  ModelCapabilities,
  ProviderModel,
  ProviderProtocol,
  ScanConnectionSnapshot,
} from "@csb/shared";

import {
  createHttpAgentUpstream,
  type HttpAgentUpstreamOptions,
} from "../agent/http-agent-upstream.js";
import {
  DEFAULT_AGENT_LIMITS,
  createAgentSession,
} from "../agent/session-runner.js";
import type {
  AgentEvent,
  AgentSession,
  AgentSessionLimits,
  AgentUpstream,
  CreateAgentSessionInput,
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

type SupportedHttpAgentProtocol = Extract<ProviderProtocol,
  | "openai-responses"
  | "openai-chat"
  | "anthropic-messages"
  | "xai-oauth-responses"
>;

const SUPPORTED_PROTOCOLS = new Set<SupportedHttpAgentProtocol>([
  "openai-responses",
  "openai-chat",
  "anthropic-messages",
  "xai-oauth-responses",
]);

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
      const resolved = await resolvePlan(
        input.plan,
        dependencies.store,
        dependencies.vault,
        dependencies.xaiOAuth,
        now(),
        maxProbeAgeMs,
      );
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
        limits,
        signal: input.signal,
        probe: resolved.capability.capabilities,
      }, upstream);

      for await (const event of session.run()) {
        await input.onEvent?.(event);
      }
    },
  };
}

interface ResolvedVulnHunterHttpPlan {
  connection: StoredProviderConnection;
  model: ProviderModel;
  capability: CapabilityReport;
  protocol: Extract<ProviderProtocol,
    | "openai-responses"
    | "openai-chat"
    | "anthropic-messages"
    | "xai-oauth-responses"
  >;
  credentials: ConnectionSecretBundle;
}

async function resolvePlan(
  plan: SafeVulnHunterProviderPlan,
  store: VulnHunterHttpPlanStore,
  vault: Pick<CredentialVault, "get">,
  xaiOAuth: Pick<XaiOAuthFlow, "getAccessToken"> | undefined,
  now: Date,
  maxProbeAgeMs: number,
): Promise<ResolvedVulnHunterHttpPlan> {
  if (!isSafePlan(plan) || !isSupportedHttpProtocol(plan.protocol)) invalidPlan();
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
  if (!isSupportedHttpProtocol(connection.protocol)) invalidPlan();
  const directXaiOAuth = isDirectXaiOAuthConnection(connection);
  if (connection.protocol === "xai-oauth-responses" && !directXaiOAuth) invalidPlan();
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
    ? await resolveXaiOAuthCredentials(connection, xaiOAuth)
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
): Promise<ConnectionSecretBundle> {
  if (xaiOAuth === undefined) invalidPlan();
  try {
    const accessToken = await xaiOAuth.getAccessToken(connection.id);
    if (!isNonEmptyText(accessToken)) invalidPlan();
    return { apiKey: accessToken };
  } catch {
    invalidPlan();
  }
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

function isSupportedHttpProtocol(value: ProviderProtocol): value is SupportedHttpAgentProtocol {
  return SUPPORTED_PROTOCOLS.has(value as SupportedHttpAgentProtocol);
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
