import { randomBytes, timingSafeEqual } from "node:crypto";

import { Hono, type Context } from "hono";
import type {
  CreateProviderConnectionRequest,
  ResolveScanCompatibilityRequest,
  UpdateProviderConnectionRequest,
} from "@csb/shared";
import { globalSecretRedactor, redactErrorMessage } from "./redaction.js";
import {
  ConnectionServiceError,
  createConnectionsService,
  type ConnectionsService,
} from "./connections-service.js";
import { createSystemCredentialVault } from "./credentials/system-credential-vault.js";
import {
  AuthFlowServiceError,
  type AuthFlowService,
} from "./connections/auth-flow-service.js";
import type { ScanCompatibilityResolver } from "./connections/scan-compatibility.js";

export interface ConnectionsApiDependencies {
  service: ConnectionsService;
  authFlows?: AuthFlowService;
  compatibility?: ScanCompatibilityResolver;
}

export function createConnectionsApp(
  supplied?: Partial<ConnectionsApiDependencies>,
): Hono {
  const deps: ConnectionsApiDependencies = {
    service: supplied?.service ?? createConnectionsService({
      vault: createSystemCredentialVault({ redactor: globalSecretRedactor }),
    }),
    authFlows: supplied?.authFlows,
    compatibility: supplied?.compatibility,
  };
  const csrfToken = randomBytes(32).toString("base64url");
  const connections = new Hono();

  connections.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  connections.get("/connections/security-session", (c) => c.json({ csrfToken }));
  connections.get("/connections", (c) => {
    try {
      return c.json({ connections: deps.service.list() });
    } catch (error) {
      return connectionError(c, error);
    }
  });
  connections.get("/connections/:id", (c) => {
    try {
      const connection = deps.service.get(connectionId(c.req.param("id")));
      if (connection === null) return c.json({ error: "connection_not_found" }, 404);
      return c.json({ connection });
    } catch (error) {
      return connectionError(c, error);
    }
  });
  connections.get("/connections/:id/models", (c) => {
    try {
      const models = deps.service.listModels(connectionId(c.req.param("id")));
      if (models === null) return c.json({ error: "connection_not_found" }, 404);
      return c.json({ models });
    } catch (error) {
      return connectionError(c, error);
    }
  });

  connections.post("/connections/compatibility", async (c) => {
    try {
      if (deps.compatibility === undefined) {
        throw new ConnectionServiceError("invalid_model_selection");
      }
      const input = compatibilityRequest(
        await requestJson<ResolveScanCompatibilityRequest>(c.req.raw),
      );
      return c.json(deps.compatibility.resolve(input));
    } catch (error) {
      return connectionError(c, error);
    }
  });

  connections.post("/connections/:id/auth/start", async (c) => {
    if (!hasValidCsrfToken(c.req.header("X-CSRF-Token"), csrfToken)) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    try {
      if (deps.authFlows === undefined) throw new AuthFlowServiceError("protocol_unsupported");
      const body = await requestJson<{ mode?: unknown }>(c.req.raw);
      if (body.mode !== "browser-oauth" && body.mode !== "device-code") {
        throw new AuthFlowServiceError("protocol_unsupported");
      }
      const flow = await deps.authFlows.start(connectionId(c.req.param("id")), body.mode);
      return c.json({ flow }, 201);
    } catch (error) {
      return connectionError(c, error);
    }
  });

  connections.get("/connections/:id/auth/:flowId", async (c) => {
    try {
      if (deps.authFlows === undefined) throw new AuthFlowServiceError("protocol_unsupported");
      const id = connectionId(c.req.param("id"));
      const flow = await deps.authFlows.get(id, connectionId(c.req.param("flowId")));
      if (flow === null) return c.json({ error: "oauth_flow_expired" }, 404);
      if (flow.status === "completed") await deps.service.inspect(id);
      return c.json({ flow });
    } catch (error) {
      return connectionError(c, error);
    }
  });

  connections.post("/connections/:id/auth/:flowId/cancel", async (c) => {
    if (!hasValidCsrfToken(c.req.header("X-CSRF-Token"), csrfToken)) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    try {
      if (deps.authFlows === undefined) throw new AuthFlowServiceError("protocol_unsupported");
      await deps.authFlows.cancel(
        connectionId(c.req.param("id")),
        connectionId(c.req.param("flowId")),
      );
      return c.json({ ok: true });
    } catch (error) {
      return connectionError(c, error);
    }
  });

  connections.post("/connections/:id/auth/disconnect", async (c) => {
    if (!hasValidCsrfToken(c.req.header("X-CSRF-Token"), csrfToken)) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    try {
      if (deps.authFlows === undefined) throw new AuthFlowServiceError("protocol_unsupported");
      const id = connectionId(c.req.param("id"));
      const result = await deps.authFlows.disconnect(id);
      await deps.service.inspect(id);
      return c.json({ result });
    } catch (error) {
      return connectionError(c, error);
    }
  });

  connections.post("/connections/:id/inspect", async (c) => {
    if (!hasValidCsrfToken(c.req.header("X-CSRF-Token"), csrfToken)) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    try {
      const result = await deps.service.inspect(connectionId(c.req.param("id")));
      if (result === null) return c.json({ error: "connection_not_found" }, 404);
      return c.json(result);
    } catch (error) {
      return connectionError(c, error);
    }
  });

  connections.post("/connections/:id/models/refresh", async (c) => {
    if (!hasValidCsrfToken(c.req.header("X-CSRF-Token"), csrfToken)) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    try {
      const result = await deps.service.refreshModels(connectionId(c.req.param("id")));
      if (result === null) return c.json({ error: "connection_not_found" }, 404);
      return c.json(result);
    } catch (error) {
      return connectionError(c, error);
    }
  });

  connections.post("/connections/:id/probe", async (c) => {
    if (!hasValidCsrfToken(c.req.header("X-CSRF-Token"), csrfToken)) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    try {
      const id = connectionId(c.req.param("id"));
      const selection = await requestJson<{ connectionId?: unknown; modelSelectionMode?: unknown; modelId?: unknown }>(
        c.req.raw,
      );
      if (selection.connectionId !== id) throw new ConnectionServiceError("invalid_model_selection");
      const result = await deps.service.probe(id, selection as never);
      if (result === null) return c.json({ error: "connection_not_found" }, 404);
      return c.json(result);
    } catch (error) {
      return connectionError(c, error);
    }
  });

  connections.post("/connections", async (c) => {
    if (!hasValidCsrfToken(c.req.header("X-CSRF-Token"), csrfToken)) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    try {
      const connection = await deps.service.create(
        await requestJson<CreateProviderConnectionRequest>(c.req.raw),
      );
      return c.json({ connection }, 201);
    } catch (error) {
      return connectionError(c, error);
    }
  });

  connections.patch("/connections/:id", async (c) => {
    if (!hasValidCsrfToken(c.req.header("X-CSRF-Token"), csrfToken)) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    try {
      const connection = await deps.service.update(
        connectionId(c.req.param("id")),
        await requestJson<UpdateProviderConnectionRequest>(c.req.raw),
      );
      if (connection === null) return c.json({ error: "connection_not_found" }, 404);
      return c.json({ connection });
    } catch (error) {
      return connectionError(c, error);
    }
  });

  connections.delete("/connections/:id", async (c) => {
    if (!hasValidCsrfToken(c.req.header("X-CSRF-Token"), csrfToken)) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    try {
      if (!await deps.service.remove(connectionId(c.req.param("id")))) {
        return c.json({ error: "connection_not_found" }, 404);
      }
      return c.body(null, 204);
    } catch (error) {
      return connectionError(c, error);
    }
  });

  return connections;
}

function connectionId(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!/^[0-9a-z-]{1,100}$/i.test(decoded)) throw new Error("invalid id");
    return decoded;
  } catch {
    return "";
  }
}

function hasValidCsrfToken(value: string | undefined, token: string): boolean {
  if (value === undefined) return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(token);
  if (supplied.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(supplied, expected);
}

function compatibilityRequest(value: ResolveScanCompatibilityRequest): ResolveScanCompatibilityRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !["codex-security", "mantis", "vulnhunter"].includes(value.engine) ||
    typeof value.selection !== "object" ||
    value.selection === null ||
    !/^[0-9a-z-]{1,100}$/i.test(value.selection.connectionId) ||
    (value.selection.modelSelectionMode !== "catalog" &&
      value.selection.modelSelectionMode !== "runtime-default") ||
    (value.selection.modelId !== null &&
      (typeof value.selection.modelId !== "string" ||
        value.selection.modelId.length === 0 ||
        value.selection.modelId.length > 320 ||
        /[\u0000-\u001F\u007F]/.test(value.selection.modelId))) ||
    (value.remoteRepositoryConfirmed !== undefined &&
      typeof value.remoteRepositoryConfirmed !== "boolean") ||
    (value.executionProfilePreference !== undefined &&
      value.executionProfilePreference !== "auto" &&
      value.executionProfilePreference !== "native" &&
      value.executionProfilePreference !== "portable")
  ) throw new ConnectionServiceError("invalid_model_selection");
  return {
    engine: value.engine,
    selection: {
      connectionId: value.selection.connectionId,
      modelSelectionMode: value.selection.modelSelectionMode,
      modelId: value.selection.modelId,
    },
    ...(value.remoteRepositoryConfirmed === undefined
      ? {}
      : { remoteRepositoryConfirmed: value.remoteRepositoryConfirmed }),
    ...(value.executionProfilePreference === undefined
      ? {}
      : { executionProfilePreference: value.executionProfilePreference }),
  };
}

async function requestJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new ConnectionServiceError("invalid_connection");
  }
}

function connectionError(c: Context, error: unknown): Response {
  // Normalize and redact before classifying. The sanitized text is deliberately
  // never returned, logged, or otherwise persisted by this API boundary.
  const safeMessage = redactErrorMessage(error);
  const code = error instanceof ConnectionServiceError
    ? error.code
    : error instanceof AuthFlowServiceError
      ? error.code
    : safeMessage === "credential_not_found"
      ? "connection_not_found"
      : "secure_storage_unavailable";
  if (code === "connection_not_found") return c.json({ error: code }, 404);
  if (code === "connection_state_inconsistent") return c.json({ error: code }, 409);
  if (code === "oauth_flow_expired") return c.json({ error: code }, 410);
  if (code === "oauth_access_denied" || code === "credential_rejected") {
    return c.json({ error: code }, 401);
  }
  if (code === "rate_limited") return c.json({ error: code }, 429);
  if (code === "provider_unreachable") return c.json({ error: code }, 503);
  if (code === "protocol_unsupported" || code === "oauth_metadata_invalid") {
    return c.json({ error: code }, 400);
  }
  if (code === "secure_storage_unavailable") return c.json({ error: code }, 503);
  return c.json({ error: code }, 400);
}
