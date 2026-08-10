import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type {
  CreateProviderConnectionRequest,
  UpdateProviderConnectionRequest,
} from "@csb/shared";
import {
  deleteConnectionRecord,
  getConnection,
  insertConnection,
  listConnections,
  updateConnectionRecord,
} from "./connections-store.js";
import {
  createConnectionsService,
  type ConnectionsStore,
} from "./connections-service.js";
import type {
  ConnectionSecretBundle,
  CredentialVault,
} from "./credentials/credential-vault.js";

class FakeVault implements CredentialVault {
  readonly values = new Map<string, ConnectionSecretBundle>();
  putError: Error | undefined;
  deleteError: Error | undefined;

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
    if (this.deleteError) throw this.deleteError;
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

function apiConnectionInput(
  apiKey = "sk-write-only",
): CreateProviderConnectionRequest {
  return {
    name: "OpenAI production",
    providerKind: "openai",
    routeKind: "openai-api",
    transport: "http-inference",
    authKind: "api-key",
    protocol: "openai-responses",
    modelSelectionMode: "catalog",
    secret: {
      apiKey,
      baseUrl: "https://private.example/v1",
      headers: { "X-Workspace": "private-header" },
    },
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

test("creates a write-only HTTP connection with server generated identifiers", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });

    const connection = await service.create(apiConnectionInput());

    assert.match(connection.id, /^[0-9a-f-]{36}$/i);
    assert.equal(connection.display.secretConfigured, true);
    assert.equal(connection.display.endpointConfigured, true);
    assert.equal(JSON.stringify(connection).includes("sk-write-only"), false);
    assert.equal(JSON.stringify(connection).includes("private.example"), false);
    assert.equal(JSON.stringify(connection).includes("credentialRef"), false);
    assert.equal(vault.values.size, 1);
    assert.equal(getConnection(connection.id, db)?.credentialRef, `connection/${connection.id}`);
  } finally {
    db.close();
  }
});

test("permits an existing local CLI session without a vault secret", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });

    const connection = await service.create(cliConnectionInput());

    assert.equal(connection.display.secretConfigured, false);
    assert.equal(getConnection(connection.id, db)?.credentialRef, null);
    assert.equal(vault.values.size, 0);
  } finally {
    db.close();
  }
});

test("requires a validated secret bundle for HTTP inference", async () => {
  const db = new Database(":memory:");
  try {
    const service = createConnectionsService({ vault: new FakeVault(), store: storeFor(db) });

    await assert.rejects(
      service.create({ ...apiConnectionInput(), secret: undefined }),
      { code: "invalid_connection" },
    );
  } finally {
    db.close();
  }
});

test("rejects invalid local CLI route combinations before persistence", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });

    await assert.rejects(
      service.create({ ...cliConnectionInput(), protocol: "openai-responses" }),
      { code: "invalid_connection" },
    );
    assert.equal(vault.values.size, 0);
    assert.equal(listConnections(db).length, 0);
  } finally {
    db.close();
  }
});

test("create rolls back the vault when metadata insertion fails", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const base = storeFor(db);
    const service = createConnectionsService({
      vault,
      store: { ...base, insert: () => { throw new Error("insert failed"); } },
    });

    await assert.rejects(service.create(apiConnectionInput()), { code: "connection_write_failed" });
    assert.equal(vault.values.size, 0);
  } finally {
    db.close();
  }
});

test("update restores the previous vault bundle when metadata update fails", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const base = storeFor(db);
    const service = createConnectionsService({ vault, store: base });
    const created = await service.create(apiConnectionInput("old-secret"));
    const stored = getConnection(created.id, db)!;

    const failing = createConnectionsService({
      vault,
      store: { ...base, update: () => { throw new Error("private metadata failure"); } },
    });
    await assert.rejects(
      failing.update(created.id, { secret: { apiKey: "new-secret" } }),
      { code: "connection_write_failed" },
    );

    assert.deepEqual(await vault.get(stored.credentialRef!), {
      apiKey: "old-secret",
      baseUrl: "https://private.example/v1",
      headers: { "X-Workspace": "private-header" },
    });
  } finally {
    db.close();
  }
});

test("delete removes the secret before metadata while keeping scan snapshots outside the service", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });
    const created = await service.create(apiConnectionInput());
    const ref = getConnection(created.id, db)!.credentialRef!;

    assert.equal(await service.remove(created.id), true);
    assert.equal(vault.values.has(ref), false);
    assert.equal(getConnection(created.id, db), null);
    assert.equal(await service.remove(created.id), false);
  } finally {
    db.close();
  }
});

test("update keeps write-only request values out of its public DTO", async () => {
  const db = new Database(":memory:");
  try {
    const service = createConnectionsService({ vault: new FakeVault(), store: storeFor(db) });
    const created = await service.create(apiConnectionInput());
    const patch: UpdateProviderConnectionRequest = {
      name: "OpenAI renamed",
      secret: { apiKey: "update-secret", discoveryUrl: "https://private.example/models" },
    };

    const updated = await service.update(created.id, patch);

    assert.equal(updated?.name, "OpenAI renamed");
    const serialized = JSON.stringify(updated);
    assert.equal(serialized.includes("update-secret"), false);
    assert.equal(serialized.includes("private.example"), false);
    assert.equal(serialized.includes("credentialRef"), false);
  } finally {
    db.close();
  }
});
