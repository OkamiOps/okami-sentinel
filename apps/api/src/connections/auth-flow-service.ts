import type { SafeProviderErrorCode } from "@csb/shared";
import type { StoredProviderConnection } from "../connections-store.js";
import type { RouteAdapter, SafeAuthFlow } from "./route-adapter.js";

export interface AuthFlowConnectionStore {
  get(connectionId: string): StoredProviderConnection | null;
}

export interface AuthFlowRouteRegistry {
  get(routeKind: string): RouteAdapter | undefined;
}

export interface DisconnectResult {
  status: "revoked" | "revoke_pending" | "local_removed" | "not_supported";
}

interface ManagedAuthRouteAdapter extends RouteAdapter {
  getAuth?(connection: StoredProviderConnection, flowId: string): Promise<SafeAuthFlow | null>;
  disconnectAuth?(connection: StoredProviderConnection): Promise<DisconnectResult>;
}

export interface AuthFlowService {
  start(
    connectionId: string,
    mode: "browser-oauth" | "device-code",
  ): Promise<SafeAuthFlow>;
  get(connectionId: string, flowId: string): Promise<SafeAuthFlow | null>;
  cancel(connectionId: string, flowId: string): Promise<void>;
  disconnect(connectionId: string): Promise<DisconnectResult>;
}

export class AuthFlowServiceError extends Error {
  constructor(readonly code: SafeProviderErrorCode) {
    super(code);
    this.name = "AuthFlowServiceError";
  }
}

export function createAuthFlowService(dependencies: {
  connections: AuthFlowConnectionStore;
  routes: AuthFlowRouteRegistry;
}): AuthFlowService {
  const flows = new Map<string, SafeAuthFlow>();

  return {
    async start(connectionId, mode) {
      const { connection, adapter } = resolveConnection(connectionId, dependencies);
      if (connection.authKind !== mode || adapter.startAuth === undefined) {
        throw new AuthFlowServiceError("protocol_unsupported");
      }
      try {
        const flow = sanitizeFlow(await adapter.startAuth(connection, mode));
        flows.set(flowKey(connection.id, flow.flowId), flow);
        return { ...flow };
      } catch (error) {
        throw normalizedError(error);
      }
    },
    async get(connectionId, flowId) {
      const { connection, adapter } = resolveConnection(connectionId, dependencies);
      const managed = adapter as ManagedAuthRouteAdapter;
      if (managed.getAuth !== undefined) {
        try {
          const flow = await managed.getAuth(connection, flowId);
          if (flow === null) return null;
          const safe = sanitizeFlow(flow);
          flows.set(flowKey(connection.id, safe.flowId), safe);
          return { ...safe };
        } catch (error) {
          throw normalizedError(error);
        }
      }
      const flow = flows.get(flowKey(connection.id, flowId));
      if (flow === undefined) return null;
      if (flow.status !== "pending") return { ...flow };
      try {
        const inspection = await adapter.inspect(connection);
        const status = statusFromInspection(inspection);
        const current = status === "pending" ? flow : { ...flow, status };
        flows.set(flowKey(connection.id, flowId), current);
        return { ...current };
      } catch (error) {
        throw normalizedError(error);
      }
    },
    async cancel(connectionId, flowId) {
      const { connection, adapter } = resolveConnection(connectionId, dependencies);
      const key = flowKey(connection.id, flowId);
      const previous = flows.get(key);
      if (previous === undefined || adapter.cancelAuth === undefined) {
        throw new AuthFlowServiceError("protocol_unsupported");
      }
      try {
        await adapter.cancelAuth(connection, flowId);
        flows.set(key, { ...previous, status: "cancelled" });
      } catch (error) {
        throw normalizedError(error);
      }
    },
    async disconnect(connectionId) {
      const { connection, adapter } = resolveConnection(connectionId, dependencies);
      const managed = adapter as ManagedAuthRouteAdapter;
      if (managed.disconnectAuth === undefined) return { status: "not_supported" };
      try {
        const result = await managed.disconnectAuth(connection);
        return sanitizeDisconnectResult(result);
      } catch (error) {
        throw normalizedError(error);
      }
    },
  };
}

function resolveConnection(
  connectionId: string,
  dependencies: { connections: AuthFlowConnectionStore; routes: AuthFlowRouteRegistry },
): { connection: StoredProviderConnection; adapter: RouteAdapter } {
  if (!isIdentifier(connectionId)) throw new AuthFlowServiceError("protocol_unsupported");
  const connection = dependencies.connections.get(connectionId);
  if (connection === null) throw new AuthFlowServiceError("protocol_unsupported");
  const adapter = dependencies.routes.get(connection.routeKind);
  if (adapter === undefined || adapter.routeKind !== connection.routeKind) {
    throw new AuthFlowServiceError("protocol_unsupported");
  }
  return { connection, adapter };
}

function sanitizeFlow(value: SafeAuthFlow): SafeAuthFlow {
  if (!isPlainRecord(value) || !isIdentifier(value.flowId) || !isFlowStatus(value.status)) {
    throw new AuthFlowServiceError("provider_unreachable");
  }
  return {
    flowId: value.flowId,
    status: value.status,
    authUrl: safeUrl(value.authUrl),
    verificationUrl: safeUrl(value.verificationUrl),
    userCode: safeText(value.userCode),
    expiresAt: safeDate(value.expiresAt),
  };
}

function sanitizeDisconnectResult(value: DisconnectResult): DisconnectResult {
  if (!isPlainRecord(value) || ![
    "revoked",
    "revoke_pending",
    "local_removed",
    "not_supported",
  ].includes(value.status as string)) {
    throw new AuthFlowServiceError("provider_unreachable");
  }
  return { status: value.status };
}

function normalizedError(error: unknown): AuthFlowServiceError {
  if (error instanceof AuthFlowServiceError) return error;
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (isSafeErrorCode(candidate)) return new AuthFlowServiceError(candidate);
  return new AuthFlowServiceError("provider_unreachable");
}

function isSafeErrorCode(value: unknown): value is SafeProviderErrorCode {
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

function statusFromInspection(value: {
  available: boolean;
  reason: string | null;
}): SafeAuthFlow["status"] {
  if (value.available) return "completed";
  if (value.reason === "credential_expired") return "expired";
  if (value.reason === "credential_rejected") return "denied";
  return "pending";
}

function flowKey(connectionId: string, flowId: string): string {
  return `${connectionId}:${flowId}`;
}

function isFlowStatus(value: unknown): value is SafeAuthFlow["status"] {
  return value === "pending" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "expired" ||
    value === "denied" ||
    value === "failed";
}

function safeUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 4_096) {
    throw new AuthFlowServiceError("provider_unreachable");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("invalid url");
    return url.toString();
  } catch {
    throw new AuthFlowServiceError("provider_unreachable");
  }
}

function safeText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 160 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new AuthFlowServiceError("provider_unreachable");
  }
  return value;
}

function safeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) {
    throw new AuthFlowServiceError("provider_unreachable");
  }
  return new Date(value).toISOString();
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
