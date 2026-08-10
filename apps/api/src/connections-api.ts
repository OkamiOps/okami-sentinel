import { randomBytes, timingSafeEqual } from "node:crypto";

import { Hono, type Context } from "hono";
import type {
  CreateProviderConnectionRequest,
  UpdateProviderConnectionRequest,
} from "@csb/shared";
import { globalSecretRedactor, redactErrorMessage } from "./redaction.js";
import {
  ConnectionServiceError,
  createConnectionsService,
  type ConnectionsService,
} from "./connections-service.js";
import { createSystemCredentialVault } from "./credentials/system-credential-vault.js";

export interface ConnectionsApiDependencies {
  service: ConnectionsService;
}

export function createConnectionsApp(
  supplied?: Partial<ConnectionsApiDependencies>,
): Hono {
  const deps: ConnectionsApiDependencies = {
    service: supplied?.service ?? createConnectionsService({
      vault: createSystemCredentialVault({ redactor: globalSecretRedactor }),
    }),
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
    : safeMessage === "credential_not_found"
      ? "connection_not_found"
      : "secure_storage_unavailable";
  if (code === "connection_not_found") return c.json({ error: code }, 404);
  if (code === "connection_state_inconsistent") return c.json({ error: code }, 409);
  if (code === "secure_storage_unavailable") return c.json({ error: code }, 503);
  return c.json({ error: code }, 400);
}
