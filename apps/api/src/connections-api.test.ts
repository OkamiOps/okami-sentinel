import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { CreateProviderConnectionRequest } from "@csb/shared";
import {
  deleteConnectionRecord,
  getConnection,
  insertConnection,
  listConnections,
  updateConnectionRecord,
} from "./connections-store.js";
import {
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
  };
  const api = createConnectionsApp({ service });

  const response = await api.request("/connections");

  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(await response.json()).includes("super-secret-value"), false);
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
