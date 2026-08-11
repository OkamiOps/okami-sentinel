import { randomUUID } from "node:crypto";

import {
  isSafeProviderErrorCode,
  type CapabilityReport,
  type ModelCapabilities,
  type ModelPricing,
  type ProviderModel,
  type ProviderProtocol,
  type SafeProviderError,
  type SafeProviderErrorCode,
  type ScanConnectionSelection,
} from "@csb/shared";
import type { StoredProviderConnection } from "../connections-store.js";
import {
  VaultError,
  type ConnectionSecretBundle,
  type CredentialVault,
  type SecretRedactorRegistry,
} from "../credentials/credential-vault.js";
import type { RouteAdapter } from "./route-adapter.js";
import {
  discoverAnthropicModels,
  discoverDeepSeekModels,
  discoverGeminiModels,
  discoverMimoTokenPlanModels,
  discoverOpenAiModels,
  discoverOpenRouterModels,
  discoverXaiModels,
  isMimoTokenPlanApiKey,
  mimoTokenPlanOpenAiBase,
  unknownCapabilities,
  withBundleRedaction,
  type DiscoveryCredentials,
  type HttpFetch,
  type HttpModelDiscoveryResult,
} from "./http-model-discovery.js";

export const HTTP_ROUTE_KINDS = [
  "openai-api",
  "xai-api",
  "anthropic-api",
  "openrouter-api",
  "gemini-api",
  "deepseek-api",
  "minimax-token-plan",
  "mimo-token-plan",
  "custom-openai-compatible",
  "custom-anthropic-compatible",
] as const;

export type HttpRouteKind = (typeof HTTP_ROUTE_KINDS)[number];

const MINIMAX_TOKEN_PLAN_ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic";

export interface HttpRouteInspection {
  available: boolean;
  reason: SafeProviderErrorCode | null;
  supportsRuntimeDefault: false;
  protocol: ProviderProtocol | null;
  /** A path is safe to display; the vault-resident origin is deliberately absent. */
  inferencePath: string | null;
  capabilities: ModelCapabilities;
  endpointConfigured: boolean;
  endpointKind: "preset" | "custom" | null;
}

export interface HttpRouteDiscoveryDependencies {
  vault: CredentialVault;
  transport?: HttpFetch;
  now?: () => Date;
  /** Cached rows supplied by the service, never read across connection IDs. */
  staleModels?: readonly ProviderModel[];
}

export interface HttpModelRefreshResult extends HttpModelDiscoveryResult {
  status: "ready" | "stale";
}

export interface AgentLoopEvidence {
  workspaceToolRequested: boolean;
  workspaceToolResultConsumed: boolean;
  resultsWriteRequested: boolean;
  artifactProduced: boolean;
  structuredResultProduced: boolean;
}

export interface HttpProbeRuntimeEvidence {
  authoritativeDeadlineEnforced: boolean;
  authoritativeCancellationEnforced: boolean;
  privatePinnedRootsEnforced: boolean;
  closedToolSurfaceEnforced: boolean;
}

/** Facts supplied by Task 5's bounded, user-triggered session probe. */
export interface HttpProbeMeasurement {
  capabilities?: Partial<ModelCapabilities>;
  /** A probe cannot prove a fact if its configured limits were not enforced. */
  limitsEnforced?: boolean;
  /** Required for a positive API-agent result; a chat reply alone is insufficient. */
  agentLoop?: AgentLoopEvidence;
  /** Local runtime facts measured by the same probe, never inferred from provider identity. */
  runtimeEvidence?: HttpProbeRuntimeEvidence;
  contextWindow?: number | null;
  pricing?: ModelPricing | null;
}

/** Trusted internal callback; credentials never leave this adapter's process boundary. */
export interface HttpProbeSessionInput {
  connectionId: string;
  routeKind: string;
  protocol: ProviderProtocol;
  inferencePath: string;
  model: ProviderModel;
  credentials: ConnectionSecretBundle;
}

export type HttpProbeSession = (
  input: HttpProbeSessionInput,
) => Promise<HttpProbeMeasurement>;

export interface HttpProbeDependencies {
  vault: CredentialVault;
  selectedModel: ProviderModel | null | undefined;
  probeSession?: HttpProbeSession;
  now?: () => Date;
  redactor?: SecretRedactorRegistry;
}

export interface HttpProbeResult {
  report: CapabilityReport;
  contextWindow: number | null;
  pricing: ModelPricing | null;
}

/**
 * Produces a capability report only from one exact catalog selection and a
 * complete local agent measurement. Both HTTP API routes and direct OAuth
 * routes use this boundary so a provider identity can never promote itself.
 */
export function createHttpProbeResult(input: {
  connectionId: string;
  protocol: ProviderProtocol;
  selection: ScanConnectionSelection;
  selectedModel: ProviderModel | null | undefined;
  measurement?: HttpProbeMeasurement;
  errorCode?: SafeProviderErrorCode;
  now?: () => Date;
}): HttpProbeResult {
  if (!isExactHttpCatalogSelection(input.connectionId, input.selection, input.selectedModel)) {
    return failedHttpProbeResult(input, "model_access_denied");
  }
  if (input.errorCode !== undefined) return failedHttpProbeResult(input, input.errorCode);
  if (input.measurement === undefined || !hasCompleteAgentEvidence(input.measurement)) {
    return failedHttpProbeResult(input, "protocol_unsupported");
  }
  const measurement = input.measurement;
  const model = input.selectedModel;
  return {
    report: {
      id: randomUUID(),
      connectionId: input.connectionId,
      modelId: model.id,
      protocol: input.protocol,
      status: "passed",
      capabilities: measuredCapabilities(measurement),
      errorCode: null,
      checkedAt: (input.now ?? (() => new Date()))().toISOString(),
    },
    contextWindow: validContextWindow(measurement.contextWindow),
    pricing: validPricing(measurement.pricing),
  };
}

/** This check intentionally runs before any direct OAuth credential read. */
export function isExactHttpCatalogSelection(
  connectionId: string,
  selection: ScanConnectionSelection,
  model: ProviderModel | null | undefined,
): model is ProviderModel {
  return selection.connectionId === connectionId &&
    selection.modelSelectionMode === "catalog" &&
    typeof selection.modelId === "string" &&
    selection.modelId.length > 0 &&
    model !== null &&
    model !== undefined &&
    model.connectionId === connectionId &&
    model.id === selection.modelId;
}

/** Maps untrusted upstream failures to the sole persisted probe vocabulary. */
export function safeHttpProbeErrorCode(error: unknown): SafeProviderErrorCode {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; status?: unknown };
    if (isSafeProviderErrorCode(candidate.code)) return candidate.code;
    if (typeof candidate.status === "number") {
      if (candidate.status === 401) return "credential_rejected";
      if (candidate.status === 403) return "model_access_denied";
      if (candidate.status === 429) return "rate_limited";
      if (candidate.status >= 500) return "provider_unreachable";
    }
  }
  return "protocol_unsupported";
}

export interface HttpRouteAdapterDependencies {
  vault: CredentialVault;
  transport?: HttpFetch;
  now?: () => Date;
  resolveModel?: (
    connectionId: string,
    modelId: string,
  ) => ProviderModel | null | Promise<ProviderModel | null>;
  probeSession?: HttpProbeSession;
  redactor?: SecretRedactorRegistry;
}

/**
 * Reads the vault only while dispatching the selected HTTP route. Results are
 * safe DTOs: neither this function nor its callers receive the bundle back.
 */
export async function discoverModels(
  connection: StoredProviderConnection,
  deps: HttpRouteDiscoveryDependencies,
): Promise<HttpModelDiscoveryResult> {
  const metadata = routeMetadata(connection);
  if (metadata === null) return unsupportedDiscovery();

  const bundle = await readBundle(connection, deps.vault);
  if ("safeError" in bundle) return failedDiscovery(bundle.safeError);

  const credentials = discoveryCredentials(connection, bundle.bundle, deps.now);
  const transport = deps.transport ?? fetch;
  switch (connection.routeKind) {
    case "openai-api":
      return discoverOpenAiModels({
        ...credentials,
        baseUrl: undefined,
        discoveryUrl: undefined,
      }, transport);
    case "custom-openai-compatible":
      return bundle.bundle.baseUrl === undefined && bundle.bundle.discoveryUrl === undefined
        ? unsupportedDiscovery()
        : discoverOpenAiModels(credentials, transport);
    case "xai-api":
      return discoverXaiModels(credentials, transport);
    case "anthropic-api":
      return discoverAnthropicModels(credentials, transport, true);
    case "custom-anthropic-compatible":
      return discoverAnthropicModels(credentials, transport);
    case "openrouter-api":
      return discoverOpenRouterModels(credentials, transport);
    case "gemini-api":
      return discoverGeminiModels(credentials, transport);
    case "deepseek-api":
      return discoverDeepSeekModels(credentials, transport);
    case "minimax-token-plan":
      return discoverAnthropicModels({
        ...credentials,
        // Token Plan credentials are only ever sent to MiniMax's documented
        // Anthropic-compatible catalog; vault URLs and custom headers do not apply.
        baseUrl: MINIMAX_TOKEN_PLAN_ANTHROPIC_BASE_URL,
        discoveryUrl: undefined,
        headers: credentials.apiKey === undefined ? undefined : { "X-Api-Key": credentials.apiKey },
      }, transport);
    case "mimo-token-plan":
      return discoverMimoTokenPlanModels(credentials, transport);
    default:
      return unsupportedDiscovery();
  }
}

/** A failed refresh leaves caller-provided rows intact and marks them stale. */
export async function refreshConnectionModels(
  connection: StoredProviderConnection,
  deps: HttpRouteDiscoveryDependencies,
): Promise<HttpModelRefreshResult> {
  const result = await discoverModels(connection, deps);
  if (result.safeError === undefined) return { ...result, status: "ready" };
  const staleModels = (deps.staleModels ?? []).filter((model) => model.connectionId === connection.id);
  return { ...result, models: staleModels, status: "stale" };
}

/**
 * Safe route metadata. No URL, header name/value, vault ref, or model catalog
 * is included, so it may be returned to the UI.
 */
export async function inspectHttpRoute(
  connection: StoredProviderConnection,
  vault: CredentialVault,
): Promise<HttpRouteInspection> {
  const metadata = routeMetadata(connection);
  if (metadata === null) return unavailableInspection("protocol_unsupported");
  const bundle = await readBundle(connection, vault);
  if ("safeError" in bundle) return unavailableInspection(bundle.safeError.code, metadata);
  const mimoError = mimoTokenPlanError(connection, bundle.bundle);
  if (mimoError !== null) {
    return unavailableInspection(mimoError, metadata);
  }
  if (!hasCredential(bundle.bundle)) return unavailableInspection("credential_rejected", metadata);
  if (metadata.endpointKind === "custom" && !hasCustomEndpoint(bundle.bundle)) {
    return unavailableInspection("model_discovery_unsupported", metadata);
  }
  return {
    available: true,
    reason: null,
    supportsRuntimeDefault: false,
    protocol: metadata.protocol,
    inferencePath: metadata.inferencePath,
    capabilities: unknownCapabilities(),
    endpointConfigured: true,
    endpointKind: metadata.endpointKind,
  };
}

/**
 * Produces a report only for the exact selected catalog row. Provider identity,
 * HTTP support claims, and a plain completion never promote a capability.
 */
export async function probeHttpRoute(
  connection: StoredProviderConnection,
  selection: ScanConnectionSelection,
  deps: HttpProbeDependencies,
): Promise<HttpProbeResult> {
  const metadata = routeMetadata(connection);
  if (metadata === null || metadata.inferencePath === null || metadata.protocol === null) {
    return createHttpProbeResult({
      connectionId: connection.id,
      protocol: connection.protocol,
      selection,
      selectedModel: deps.selectedModel,
      errorCode: "protocol_unsupported",
      now: deps.now,
    });
  }
  const selectedModel = deps.selectedModel;
  if (!isExactHttpCatalogSelection(connection.id, selection, selectedModel)) {
    return createHttpProbeResult({
      connectionId: connection.id,
      protocol: metadata.protocol,
      selection,
      selectedModel,
      errorCode: "model_access_denied",
      now: deps.now,
    });
  }
  const bundle = await readBundle(connection, deps.vault);
  if ("safeError" in bundle) return createHttpProbeResult({
    connectionId: connection.id,
    protocol: metadata.protocol,
    selection,
    selectedModel,
    errorCode: bundle.safeError.code,
    now: deps.now,
  });
  const mimoError = mimoTokenPlanError(connection, bundle.bundle);
  if (mimoError !== null) return createHttpProbeResult({
    connectionId: connection.id,
    protocol: metadata.protocol,
    selection,
    selectedModel,
    errorCode: mimoError,
    now: deps.now,
  });
  if (!hasCredential(bundle.bundle)) return createHttpProbeResult({
    connectionId: connection.id,
    protocol: metadata.protocol,
    selection,
    selectedModel,
    errorCode: "credential_rejected",
    now: deps.now,
  });
  const probeSession = deps.probeSession;
  if (probeSession === undefined) return createHttpProbeResult({
    connectionId: connection.id,
    protocol: metadata.protocol,
    selection,
    selectedModel,
    errorCode: "protocol_unsupported",
    now: deps.now,
  });

  try {
    const measurement = await withBundleRedaction(bundle.bundle, async () => probeSession({
      connectionId: connection.id,
      routeKind: connection.routeKind,
      protocol: metadata.protocol,
      inferencePath: metadata.inferencePath,
      model: selectedModel,
      credentials: bundle.bundle,
    }), deps.redactor);
    return createHttpProbeResult({
      connectionId: connection.id,
      protocol: metadata.protocol,
      selection,
      selectedModel,
      measurement,
      now: deps.now,
    });
  } catch (error) {
    return createHttpProbeResult({
      connectionId: connection.id,
      protocol: metadata.protocol,
      selection,
      selectedModel,
      errorCode: safeHttpProbeErrorCode(error),
      now: deps.now,
    });
  }
}

/** Creates one protocol-only RouteAdapter for registry integration in Task 2. */
export function createHttpRouteAdapter(
  routeKind: HttpRouteKind,
  deps: HttpRouteAdapterDependencies,
): RouteAdapter {
  const metadata = routeMetadataFor(routeKind, defaultProtocolForRoute(routeKind));
  if (metadata === null) throw new TypeError("Unsupported HTTP route kind");
  return {
    routeKind,
    transport: "http-inference",
    protocol: metadata.protocol,
    async inspect(connection) {
      return inspectHttpRoute(connection, deps.vault);
    },
    async discoverModels(connection) {
      return discoverModels(connection, {
        vault: deps.vault,
        transport: deps.transport,
        now: deps.now,
      });
    },
    async probe(connection, selection) {
      const selectedModel = selection.modelId === null || deps.resolveModel === undefined
        ? null
        : await deps.resolveModel(connection.id, selection.modelId);
      return (await probeHttpRoute(connection, selection, {
        vault: deps.vault,
        selectedModel,
        probeSession: deps.probeSession,
        now: deps.now,
        redactor: deps.redactor,
      })).report;
    },
  };
}

function defaultProtocolForRoute(routeKind: HttpRouteKind): ProviderProtocol {
  switch (routeKind) {
    case "openai-api":
    case "xai-api":
      return "openai-responses";
    case "anthropic-api":
    case "custom-anthropic-compatible":
    case "minimax-token-plan":
      return "anthropic-messages";
    default:
      return "openai-chat";
  }
}

export function createHttpRouteAdapters(
  deps: HttpRouteAdapterDependencies,
): readonly RouteAdapter[] {
  return HTTP_ROUTE_KINDS.map((routeKind) => createHttpRouteAdapter(routeKind, deps));
}

/** Small registry seam so the Task 2 owner can serially register this module. */
export function registerHttpRouteAdapters(
  register: (adapter: RouteAdapter) => void,
  deps: HttpRouteAdapterDependencies,
): void {
  for (const adapter of createHttpRouteAdapters(deps)) register(adapter);
}

function discoveryCredentials(
  connection: StoredProviderConnection,
  bundle: ConnectionSecretBundle,
  now: (() => Date) | undefined,
): DiscoveryCredentials {
  return {
    ...bundle,
    connectionId: connection.id,
    ...(allowInsecureLocalhost(connection, bundle)
      ? { allowInsecureLocalhost: true as const }
      : {}),
    ...(now === undefined ? {} : { now }),
  };
}

function routeMetadata(connection: StoredProviderConnection): RouteMetadata | null {
  return routeMetadataFor(connection.routeKind, connection.protocol);
}

interface RouteMetadata {
  protocol: ProviderProtocol;
  inferencePath: string;
  endpointKind: "preset" | "custom";
}

function routeMetadataFor(
  routeKind: string,
  connectionProtocol: ProviderProtocol,
): RouteMetadata | null {
  switch (routeKind) {
    case "openai-api":
      return connectionProtocol === "openai-chat"
        ? { protocol: "openai-chat", inferencePath: "/chat/completions", endpointKind: "preset" }
        : { protocol: "openai-responses", inferencePath: "/responses", endpointKind: "preset" };
    case "custom-openai-compatible":
      return connectionProtocol === "openai-responses"
        ? { protocol: "openai-responses", inferencePath: "/responses", endpointKind: "custom" }
        : { protocol: "openai-chat", inferencePath: "/chat/completions", endpointKind: "custom" };
    case "xai-api":
      return { protocol: "openai-responses", inferencePath: "/v1/responses", endpointKind: "preset" };
    case "anthropic-api":
      return { protocol: "anthropic-messages", inferencePath: "/v1/messages", endpointKind: "preset" };
    case "custom-anthropic-compatible":
      return { protocol: "anthropic-messages", inferencePath: "/v1/messages", endpointKind: "custom" };
    case "openrouter-api":
      return { protocol: "openai-chat", inferencePath: "/api/v1/chat/completions", endpointKind: "preset" };
    case "gemini-api":
      return { protocol: "openai-chat", inferencePath: "/v1beta/openai/chat/completions", endpointKind: "preset" };
    case "deepseek-api":
      return { protocol: "openai-chat", inferencePath: "/chat/completions", endpointKind: "preset" };
    case "minimax-token-plan":
      return { protocol: "anthropic-messages", inferencePath: "/v1/messages", endpointKind: "preset" };
    case "mimo-token-plan":
      return connectionProtocol === "openai-chat"
        ? { protocol: "openai-chat", inferencePath: "/chat/completions", endpointKind: "preset" }
        : null;
    default:
      return null;
  }
}

function hasCredential(bundle: ConnectionSecretBundle): boolean {
  return typeof bundle.apiKey === "string" && bundle.apiKey.length > 0 ||
    Object.keys(bundle.headers ?? {}).length > 0;
}

function mimoTokenPlanError(
  connection: StoredProviderConnection,
  bundle: ConnectionSecretBundle,
): SafeProviderErrorCode | null {
  if (connection.routeKind !== "mimo-token-plan") return null;
  if (!isMimoTokenPlanApiKey(bundle.apiKey)) return "credential_rejected";
  return mimoTokenPlanOpenAiBase(bundle.baseUrl) === null
    ? "model_discovery_unsupported"
    : null;
}

function hasCustomEndpoint(bundle: ConnectionSecretBundle): boolean {
  return bundle.baseUrl !== undefined || bundle.discoveryUrl !== undefined;
}

function allowInsecureLocalhost(
  connection: StoredProviderConnection,
  bundle: ConnectionSecretBundle,
): boolean {
  if (connection.routeKind !== "custom-openai-compatible" &&
      connection.routeKind !== "custom-anthropic-compatible") return false;
  return bundle.allowInsecureLocalhost === true;
}

async function readBundle(
  connection: StoredProviderConnection,
  vault: CredentialVault,
): Promise<{ bundle: ConnectionSecretBundle } | { safeError: SafeProviderError }> {
  if (connection.credentialRef === null) return { safeError: { code: "credential_rejected" } };
  try {
    return { bundle: await vault.get(connection.credentialRef) };
  } catch (error) {
    if (error instanceof VaultError && error.code === "secure_storage_unavailable") {
      return { safeError: { code: "secure_storage_unavailable" } };
    }
    return { safeError: { code: "credential_rejected" } };
  }
}

function unavailableInspection(
  reason: SafeProviderErrorCode,
  metadata: RouteMetadata | null = null,
): HttpRouteInspection {
  return {
    available: false,
    reason,
    supportsRuntimeDefault: false,
    protocol: metadata?.protocol ?? null,
    inferencePath: metadata?.inferencePath ?? null,
    capabilities: unknownCapabilities(),
    endpointConfigured: metadata !== null,
    endpointKind: metadata?.endpointKind ?? null,
  };
}

function hasCompleteAgentEvidence(measurement: HttpProbeMeasurement): boolean {
  const evidence = measurement.agentLoop;
  const runtime = measurement.runtimeEvidence;
  return measurement.limitsEnforced === true && evidence !== undefined &&
    evidence.workspaceToolRequested === true &&
    evidence.workspaceToolResultConsumed === true &&
    evidence.resultsWriteRequested === true &&
    evidence.artifactProduced === true &&
    evidence.structuredResultProduced === true &&
    runtime !== undefined &&
    runtime.authoritativeDeadlineEnforced === true &&
    runtime.authoritativeCancellationEnforced === true &&
    runtime.privatePinnedRootsEnforced === true &&
    runtime.closedToolSurfaceEnforced === true;
}

function measuredCapabilities(measurement: HttpProbeMeasurement): ModelCapabilities {
  const result = unknownCapabilities();
  const partial = measurement.capabilities;
  if (partial === undefined) return result;
  for (const key of Object.keys(result) as Array<keyof ModelCapabilities>) {
    if (key === "cancellation" || key === "osIsolation") continue;
    const value = partial[key];
    if (value === "supported" || value === "unsupported" || value === "unknown") result[key] = value;
  }
  const runtime = measurement.runtimeEvidence;
  if (runtime?.authoritativeDeadlineEnforced === true &&
      runtime.authoritativeCancellationEnforced === true) {
    result.cancellation = "supported";
  }
  if (runtime?.privatePinnedRootsEnforced === true &&
      runtime.closedToolSurfaceEnforced === true) {
    result.osIsolation = "supported";
  }
  return result;
}

function validContextWindow(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function validPricing(value: ModelPricing | null | undefined): ModelPricing | null {
  if (value === null || value === undefined) return null;
  const fields = [
    value.inputUsdPerMillionTokens,
    value.cachedInputUsdPerMillionTokens,
    value.outputUsdPerMillionTokens,
  ];
  if (!fields.every((field) => field === null || Number.isFinite(field) && field >= 0)) return null;
  return {
    inputUsdPerMillionTokens: value.inputUsdPerMillionTokens,
    cachedInputUsdPerMillionTokens: value.cachedInputUsdPerMillionTokens,
    outputUsdPerMillionTokens: value.outputUsdPerMillionTokens,
  };
}

function failedHttpProbeResult(
  input: {
    connectionId: string;
    protocol: ProviderProtocol;
    selection: ScanConnectionSelection;
    now?: () => Date;
  },
  errorCode: SafeProviderErrorCode,
): HttpProbeResult {
  return {
    report: {
      id: randomUUID(),
      connectionId: input.connectionId,
      modelId: input.selection.connectionId === input.connectionId && input.selection.modelSelectionMode === "catalog"
        ? input.selection.modelId
        : null,
      protocol: input.protocol,
      status: "failed",
      capabilities: unknownCapabilities(),
      errorCode,
      checkedAt: (input.now ?? (() => new Date()))().toISOString(),
    },
    contextWindow: null,
    pricing: null,
  };
}

function unsupportedDiscovery(): HttpModelDiscoveryResult {
  return failedDiscovery({ code: "model_discovery_unsupported" });
}

function failedDiscovery(safeError: SafeProviderError): HttpModelDiscoveryResult {
  return {
    models: [],
    supportsRuntimeDefault: false,
    pageCount: 0,
    safeError,
  };
}
