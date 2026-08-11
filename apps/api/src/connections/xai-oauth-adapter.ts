import { randomUUID } from "node:crypto";

import type {
  CapabilityReport,
  ModelCapabilities,
  ProviderModel,
  SafeProviderErrorCode,
  ScanConnectionSelection,
} from "@csb/shared";
import type { StoredProviderConnection } from "../connections-store.js";
import type { SecretRedactorRegistry } from "../credentials/credential-vault.js";
import { globalSecretRedactor } from "../redaction.js";
import {
  discoverXaiModels,
  type HttpFetch,
} from "./http-model-discovery.js";
import {
  createHttpProbeResult,
  isExactHttpCatalogSelection,
  safeHttpProbeErrorCode,
  type HttpProbeSession,
} from "./http-route-adapters.js";
import type {
  DiscoveryResult,
  RouteAdapter,
  RouteInspection,
  SafeAuthFlow,
} from "./route-adapter.js";
import type {
  XaiOAuthCredentialStatus,
  XaiOAuthDisconnectResult,
  XaiOAuthFlowPublic,
} from "./xai-oauth-flow.js";

/** Narrow, direct seam: it deliberately has no CLI, filesystem, or process API. */
export interface XaiOAuthAdapterFlow {
  start(connectionId: string): Promise<XaiOAuthFlowPublic>;
  get(connectionId: string, flowId: string): XaiOAuthFlowPublic | null;
  cancel(connectionId: string, flowId: string): Promise<void>;
  credentialStatus(connectionId: string): Promise<XaiOAuthCredentialStatus>;
  getAccessToken(connectionId: string, signal?: AbortSignal): Promise<string>;
  disconnect(connectionId: string): Promise<XaiOAuthDisconnectResult>;
}

export interface XaiOAuthAdapterDependencies {
  flow: XaiOAuthAdapterFlow;
  /** Deterministic seam; production defaults to the fixed api.x.ai catalog. */
  discover?: (
    connection: StoredProviderConnection,
    accessToken: string,
  ) => Promise<DiscoveryResult>;
  now?: () => Date;
  transport?: HttpFetch;
  redactor?: SecretRedactorRegistry;
  resolveModel?: (
    connectionId: string,
    modelId: string,
  ) => ProviderModel | null | Promise<ProviderModel | null>;
  /** The same trusted bounded probe factory used by regular HTTP API routes. */
  probeSession?: HttpProbeSession;
}

export interface XaiOAuthRouteAdapter extends RouteAdapter {
  startAuth(
    connection: StoredProviderConnection,
    mode: "browser-oauth" | "device-code",
  ): Promise<SafeAuthFlow>;
  getAuth(connection: StoredProviderConnection, flowId: string): Promise<SafeAuthFlow | null>;
  cancelAuth(connection: StoredProviderConnection, flowId: string): Promise<void>;
  disconnectAuth(connection: StoredProviderConnection): Promise<{ status: XaiOAuthDisconnectResult }>;
}

export class XaiOAuthAdapterError extends Error {
  constructor(readonly code: SafeProviderErrorCode) {
    super(code);
    this.name = "XaiOAuthAdapterError";
  }
}

export function createXaiOAuthAdapter(
  dependencies: XaiOAuthAdapterDependencies,
): XaiOAuthRouteAdapter {
  const now = dependencies.now ?? (() => new Date());
  const redactor = dependencies.redactor ?? globalSecretRedactor;
  const discover = dependencies.discover ?? ((connection, accessToken) => discoverXaiModels({
    connectionId: connection.id,
    apiKey: accessToken,
    redactor,
  }, dependencies.transport));

  return {
    routeKind: "xai-oauth",
    transport: "http-inference",
    protocol: "xai-oauth-responses",
    async inspect(connection): Promise<RouteInspection> {
      requireXaiOAuthConnection(connection);
      try {
        const status = await dependencies.flow.credentialStatus(connection.id);
        return inspectionForStatus(status);
      } catch (error) {
        return {
          available: false,
          reason: safeErrorCode(error),
          supportsRuntimeDefault: false,
        };
      }
    },
    async startAuth(connection, mode): Promise<SafeAuthFlow> {
      requireXaiOAuthConnection(connection);
      if (mode !== "device-code") throw new XaiOAuthAdapterError("protocol_unsupported");
      try {
        return toSafeAuthFlow(await dependencies.flow.start(connection.id));
      } catch (error) {
        throw new XaiOAuthAdapterError(safeErrorCode(error));
      }
    },
    async getAuth(connection, flowId): Promise<SafeAuthFlow | null> {
      requireXaiOAuthConnection(connection);
      const flow = dependencies.flow.get(connection.id, flowId);
      return flow === null ? null : toSafeAuthFlow(flow);
    },
    async cancelAuth(connection, flowId): Promise<void> {
      requireXaiOAuthConnection(connection);
      try {
        await dependencies.flow.cancel(connection.id, flowId);
      } catch (error) {
        throw new XaiOAuthAdapterError(safeErrorCode(error));
      }
    },
    async disconnectAuth(connection): Promise<{ status: XaiOAuthDisconnectResult }> {
      requireXaiOAuthConnection(connection);
      try {
        return { status: await dependencies.flow.disconnect(connection.id) };
      } catch (error) {
        throw new XaiOAuthAdapterError(safeErrorCode(error));
      }
    },
    async discoverModels(connection): Promise<DiscoveryResult> {
      requireXaiOAuthConnection(connection);
      let accessToken: string;
      try {
        accessToken = await dependencies.flow.getAccessToken(connection.id);
      } catch (error) {
        return failedDiscovery(safeErrorCode(error));
      }
      const scope = `connections/xai-oauth/discovery/${randomUUID()}`;
      redactor.register(scope, [accessToken]);
      try {
        const result = await discover(connection, accessToken);
        return sanitizeDiscovery(connection, result);
      } catch (error) {
        return failedDiscovery(safeErrorCode(error));
      } finally {
        redactor.unregister(scope);
      }
    },
    async probe(connection, selection, options): Promise<CapabilityReport> {
      requireXaiOAuthConnection(connection);
      let selectedModel: ProviderModel | null = null;
      try {
        selectedModel = selection.modelId === null || dependencies.resolveModel === undefined
          ? null
          : await dependencies.resolveModel(connection.id, selection.modelId);
      } catch (error) {
        return createHttpProbeResult({
          connectionId: connection.id,
          protocol: "xai-oauth-responses",
          selection,
          selectedModel,
          errorCode: safeHttpProbeErrorCode(error),
          now,
        }).report;
      }
      if (!isExactHttpCatalogSelection(connection.id, selection, selectedModel)) {
        return createHttpProbeResult({
          connectionId: connection.id,
          protocol: "xai-oauth-responses",
          selection,
          selectedModel,
          errorCode: "model_access_denied",
          now,
        }).report;
      }
      if (dependencies.probeSession === undefined) {
        return createHttpProbeResult({
          connectionId: connection.id,
          protocol: "xai-oauth-responses",
          selection,
          selectedModel,
          errorCode: "protocol_unsupported",
          now,
        }).report;
      }

      let accessToken: string;
      try {
        accessToken = await dependencies.flow.getAccessToken(connection.id, options?.signal);
      } catch (error) {
        return createHttpProbeResult({
          connectionId: connection.id,
          protocol: "xai-oauth-responses",
          selection,
          selectedModel,
          errorCode: safeHttpProbeErrorCode(error),
          now,
        }).report;
      }

      const scope = `connections/xai-oauth/probe/${randomUUID()}`;
      redactor.register(scope, [accessToken]);
      try {
        const measurement = await dependencies.probeSession({
          connectionId: connection.id,
          routeKind: "xai-oauth",
          protocol: "xai-oauth-responses",
          inferencePath: "/v1/responses",
          model: selectedModel,
          credentials: { apiKey: accessToken },
          signal: options?.signal,
        });
        return createHttpProbeResult({
          connectionId: connection.id,
          protocol: "xai-oauth-responses",
          selection,
          selectedModel,
          measurement,
          now,
        }).report;
      } catch (error) {
        return createHttpProbeResult({
          connectionId: connection.id,
          protocol: "xai-oauth-responses",
          selection,
          selectedModel,
          errorCode: safeHttpProbeErrorCode(error),
          now,
        }).report;
      } finally {
        redactor.unregister(scope);
      }
    },
  };
}

function requireXaiOAuthConnection(connection: StoredProviderConnection): void {
  if (
    connection.providerKind !== "xai" ||
    connection.routeKind !== "xai-oauth" ||
    connection.transport !== "http-inference" ||
    connection.authKind !== "device-code" ||
    connection.protocol !== "xai-oauth-responses"
  ) throw new XaiOAuthAdapterError("protocol_unsupported");
}

function inspectionForStatus(status: XaiOAuthCredentialStatus): RouteInspection {
  if (status === "ready") {
    return { available: true, reason: null, supportsRuntimeDefault: false };
  }
  return {
    available: false,
    reason: status === "expired" ? "credential_expired" : "credential_rejected",
    supportsRuntimeDefault: false,
  };
}

function toSafeAuthFlow(flow: XaiOAuthFlowPublic): SafeAuthFlow {
  return {
    flowId: flow.flowId,
    status: flow.status === "pending-device" || flow.status === "exchanging"
      ? "pending"
      : flow.status,
    authUrl: null,
    verificationUrl: flow.verificationUrl,
    userCode: flow.userCode,
    expiresAt: flow.expiresAt,
  };
}

function sanitizeDiscovery(
  connection: StoredProviderConnection,
  result: DiscoveryResult,
): DiscoveryResult {
  if (
    result.supportsRuntimeDefault !== false ||
    result.models.some((model) => !isSafeModel(connection.id, model))
  ) return failedDiscovery("protocol_unsupported");
  if (result.safeError !== undefined) return failedDiscovery(result.safeError.code);
  return {
    models: result.models.map((model) => ({ ...model, capabilities: { ...model.capabilities } })),
    supportsRuntimeDefault: false,
  };
}

function isSafeModel(connectionId: string, model: ProviderModel): boolean {
  return model.connectionId === connectionId &&
    typeof model.id === "string" && model.id.length > 0 &&
    typeof model.displayName === "string" && model.displayName.length > 0;
}

function failedDiscovery(code: SafeProviderErrorCode): DiscoveryResult {
  return {
    models: [],
    supportsRuntimeDefault: false,
    safeError: { code },
  };
}

function unknownCapabilities(): ModelCapabilities {
  return {
    tools: "unknown",
    artifactOutput: "unknown",
    structuredOutput: "unknown",
    boundedExecution: "unknown",
    osIsolation: "unknown",
    streaming: "unknown",
    usage: "unknown",
    cancellation: "unknown",
  };
}

function safeErrorCode(error: unknown): SafeProviderErrorCode {
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return isSafeProviderErrorCode(candidate) ? candidate : "provider_unreachable";
}

function isSafeProviderErrorCode(value: unknown): value is SafeProviderErrorCode {
  return typeof value === "string" && [
    "credential_rejected",
    "credential_expired",
    "provider_unreachable",
    "model_discovery_unsupported",
    "model_access_denied",
    "endpoint_access_denied",
    "rate_limited",
    "secure_storage_unavailable",
    "runtime_missing",
    "runtime_version_unsupported",
    "oauth_flow_expired",
    "oauth_access_denied",
    "oauth_metadata_invalid",
    "protocol_unsupported",
  ].includes(value);
}
