import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { CreateProviderConnectionRequest, ProviderConnection } from "@csb/shared";
import {
  deleteConnectionRecord,
  getConnection,
  insertConnection,
  listConnections,
  updateConnectionRecord,
} from "./connections-store.js";
import {
  ConnectionServiceError,
  createConnectionsService,
  type ConnectionsService,
  type ConnectionsStore,
} from "./connections-service.js";
import { createConnectionsApp } from "./connections-api.js";
import { app } from "./app.js";
import type {
  ConnectionSecretBundle,
  CredentialVault,
} from "./credentials/credential-vault.js";

class FakeVault implements CredentialVault {
  readonly values = new Map<string, ConnectionSecretBundle>();
  putError: Error | undefined;

  async available() {
    return { available: true, backend: "keychain" as const };
  }

  async put(ref: string, value: ConnectionSecretBundle) {
    if (this.putError) throw this.putError;
    this.values.set(ref, structuredClone(value));
  }

  async get(ref: string) {
    const value = this.values.get(ref);
    if (!value) throw new Error("credential_not_found");
    return structuredClone(value);
  }

  async delete(ref: string) {
    this.values.delete(ref);
  }
}

function storeFor(db: Database.Database): ConnectionsStore {
  return {
    list: () => listConnections(db),
    get: (id) => getConnection(id, db),
    insert: (connection) => insertConnection(connection, db),
    update: (id, patch) => updateConnectionRecord(id, patch, db),
    delete: (id) => deleteConnectionRecord(id, db),
  };
}

function cliConnectionInput(): CreateProviderConnectionRequest {
  return {
    name: "Codex local",
    providerKind: "openai",
    routeKind: "codex-local",
    transport: "local-cli",
    authKind: "existing-session",
    protocol: "codex-cli",
    modelSelectionMode: "runtime-default",
  };
}

function runtimeConnection(): ProviderConnection {
  return {
    id: "conn-local",
    scopeId: "local",
    name: "Claude local",
    providerKind: "anthropic",
    routeKind: "claude-code-local",
    transport: "local-cli",
    authKind: "existing-session",
    protocol: "claude-code-cli",
    status: "ready",
    modelSelectionMode: "runtime-default",
    defaultModelId: null,
    lastTestedAt: "2026-08-11T00:00:00.000Z",
    lastModelSyncAt: null,
    modelCatalogStale: false,
    display: {
      providerLabel: "Anthropic",
      routeLabel: "Claude Code local",
      secretConfigured: false,
      endpointConfigured: false,
      endpointKind: null,
    },
  };
}

function fixture() {
  const db = new Database(":memory:");
  const vault = new FakeVault();
  const service = createConnectionsService({ vault, store: storeFor(db) });
  return { api: createConnectionsApp({ service }), db, vault };
}

async function csrfToken(api: ReturnType<typeof createConnectionsApp>) {
  const response = await api.request("/connections/security-session");
  assert.equal(response.status, 200);
  return (await response.json() as { csrfToken: string }).csrfToken;
}

test("mutations require the per-process CSRF token and every response is no-store", async () => {
  const { api, db } = fixture();
  try {
    const denied = await api.request("/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cliConnectionInput()),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("Cache-Control"), "no-store");

    const token = await csrfToken(api);
    const allowed = await api.request("/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify(cliConnectionInput()),
    });
    assert.equal(allowed.status, 201);
    assert.equal(allowed.headers.get("Cache-Control"), "no-store");
  } finally {
    db.close();
  }
});

test("a multibyte CSRF value returns 403 without throwing", async () => {
  const { api, db } = fixture();
  try {
    const denied = await api.request("/connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": "é".repeat(43),
      },
      body: JSON.stringify(cliConnectionInput()),
    });

    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "csrf_invalid" });
  } finally {
    db.close();
  }
});

test("HTTP CRUD returns only public DTOs and accepts encoded path identifiers", async () => {
  const { api, db } = fixture();
  try {
    const token = await csrfToken(api);
    const created = await api.request("/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify(cliConnectionInput()),
    });
    const body = await created.json() as { connection: { id: string } };
    const path = `/connections/${encodeURIComponent(body.connection.id)}`;

    const loaded = await api.request(path);
    assert.equal(loaded.status, 200);
    assert.equal(JSON.stringify(await loaded.json()).includes("credentialRef"), false);

    const patched = await api.request(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ name: "Codex renamed" }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json() as { connection: { name: string } }).connection.name, "Codex renamed");

    const deleted = await api.request(path, {
      method: "DELETE",
      headers: { "X-CSRF-Token": token },
    });
    assert.equal(deleted.status, 204);
    assert.equal((await api.request(path)).status, 404);
  } finally {
    db.close();
  }
});

test("normalizes validation and vault exceptions without echoing a secret", async () => {
  const { api, db, vault } = fixture();
  try {
    const token = await csrfToken(api);
    const invalid = await api.request("/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ name: "bad" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(JSON.stringify(await invalid.json()).includes("bad"), false);

    vault.putError = new Error("native write failed: super-secret-value");
    const failed = await api.request("/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({
        name: "OpenAI private",
        providerKind: "openai",
        routeKind: "openai-api",
        transport: "http-inference",
        authKind: "api-key",
        protocol: "openai-responses",
        modelSelectionMode: "catalog",
        secret: { apiKey: "super-secret-value" },
      }),
    });
    assert.equal(failed.status, 503);
    const serialized = JSON.stringify(await failed.json());
    assert.equal(serialized.includes("super-secret-value"), false);
    assert.equal(serialized.includes("native write failed"), false);
  } finally {
    db.close();
  }
});

test("HTTP create rejects unknown fields and URL-shaped identifiers", async () => {
  const { api, db } = fixture();
  try {
    const token = await csrfToken(api);
    for (const body of [
      { ...cliConnectionInput(), credentialRef: "connection/client-value" },
      { ...cliConnectionInput(), routeKind: "https://secret.example/v1?token=leak" },
    ]) {
      const response = await api.request("/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      const serialized = JSON.stringify(await response.json());
      assert.equal(serialized.includes("secret.example"), false);
      assert.equal(serialized.includes("client-value"), false);
    }
  } finally {
    db.close();
  }
});

test("HTTP create rejects an opaque secret copied into a public label", async () => {
  const { api, db, vault } = fixture();
  try {
    const token = await csrfToken(api);
    const secret = "opaque-http-value-12345";
    const response = await api.request("/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({
        name: `Production ${secret}`,
        providerKind: "openai",
        routeKind: "openai-api",
        transport: "http-inference",
        authKind: "api-key",
        protocol: "openai-responses",
        modelSelectionMode: "catalog",
        secret: { apiKey: secret },
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(JSON.stringify(await response.json()).includes(secret), false);
    assert.equal(vault.values.size, 0);
    assert.equal(listConnections(db).length, 0);
    assert.equal(db.serialize().toString("utf8").includes(secret), false);
  } finally {
    db.close();
  }
});

test("unknown connections use normalized 404s without reflecting encoded paths", async () => {
  const { api, db } = fixture();
  try {
    const response = await api.request("/connections/%3Cprivate-path%3E");
    assert.equal(response.status, 404);
    assert.equal(JSON.stringify(await response.json()).includes("private-path"), false);
  } finally {
    db.close();
  }
});

test("read failures are normalized without exposing secret exception text", async () => {
  const service: ConnectionsService = {
    list() {
      throw new Error("database lost super-secret-value");
    },
    get() {
      throw new Error("database lost super-secret-value");
    },
    create: async () => { throw new Error("unused"); },
    update: async () => { throw new Error("unused"); },
    remove: async () => { throw new Error("unused"); },
    inspect: async () => { throw new Error("unused"); },
    listModels: () => { throw new Error("unused"); },
    refreshModels: async () => { throw new Error("unused"); },
    probe: async () => { throw new Error("unused"); },
  };
  const api = createConnectionsApp({ service });

  const response = await api.request("/connections");

  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(await response.json()).includes("super-secret-value"), false);
});

test("reports a compensation inconsistency with an explicit safe code", async () => {
  const service: ConnectionsService = {
    list: () => [],
    get: () => null,
    create: async () => {
      throw new ConnectionServiceError("connection_state_inconsistent");
    },
    update: async () => null,
    remove: async () => false,
    inspect: async () => null,
    listModels: () => null,
    refreshModels: async () => null,
    probe: async () => null,
  };
  const api = createConnectionsApp({ service });
  const token = await csrfToken(api);

  const response = await api.request("/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify(cliConnectionInput()),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "connection_state_inconsistent" });
});

test("local runtime refresh returns a no-store safe catalog result without a model fallback", async () => {
  const connection = runtimeConnection();
  const service: ConnectionsService = {
    list: () => [connection],
    get: () => connection,
    create: async () => connection,
    update: async () => connection,
    remove: async () => false,
    inspect: async () => ({
      connection,
      inspection: { available: true, reason: null, supportsRuntimeDefault: true },
    }),
    listModels: () => [],
    refreshModels: async () => ({
      connection,
      discovery: {
        models: [],
        supportsRuntimeDefault: true,
      },
    }),
    probe: async () => ({
      connection,
      report: {
        id: "check-local",
        connectionId: connection.id,
        modelId: null,
        protocol: "claude-code-cli",
        status: "failed",
        capabilities: {
          tools: "unknown",
          artifactOutput: "unknown",
          structuredOutput: "unknown",
          boundedExecution: "unknown",
          osIsolation: "unknown",
          streaming: "unknown",
          usage: "unknown",
          cancellation: "unknown",
        },
        errorCode: "protocol_unsupported",
        checkedAt: "2026-08-11T00:00:00.000Z",
      },
    }),
  };
  const api = createConnectionsApp({ service });
  const token = await csrfToken(api);

  const response = await api.request("/connections/conn-local/models/refresh", {
    method: "POST",
    headers: { "X-CSRF-Token": token },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json() as {
    discovery: { models: unknown[]; supportsRuntimeDefault: boolean };
    connection: { defaultModelId: string | null; modelSelectionMode: string };
  };
  assert.deepEqual(body.discovery.models, []);
  assert.equal(body.discovery.supportsRuntimeDefault, true);
  assert.equal(body.connection.defaultModelId, null);
  assert.equal(body.connection.modelSelectionMode, "runtime-default");
});

test("the root app mounts connections and permits PATCH with the CSRF header", async () => {
  const session = await app.request("/connections/security-session");
  assert.equal(session.status, 200);
  assert.equal(session.headers.get("Cache-Control"), "no-store");

  const preflight = await app.request("/connections", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "Content-Type, X-CSRF-Token",
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("Access-Control-Allow-Methods") ?? "", /PATCH/);
  assert.match(preflight.headers.get("Access-Control-Allow-Headers") ?? "", /X-CSRF-Token/i);
});
