import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { StoredProviderConnection } from "./connections-store.js";
import {
  deleteConnectionRecord,
  ensureConnectionSchema,
  getConnection,
  insertConnection,
  listConnections,
  updateConnectionRecord,
} from "./connections-store.js";

function connectionFixture(
  overrides: Partial<StoredProviderConnection> = {},
): StoredProviderConnection {
  return {
    id: "conn-1",
    scopeId: "local",
    name: "OpenAI production",
    providerKind: "openai",
    routeKind: "openai-api",
    transport: "http-inference",
    authKind: "api-key",
    protocol: "openai-responses",
    status: "ready",
    modelSelectionMode: "catalog",
    defaultModelId: null,
    lastTestedAt: null,
    lastModelSyncAt: null,
    display: {
      providerLabel: "OpenAI",
      routeLabel: "OpenAI API",
      secretConfigured: true,
      endpointConfigured: true,
      endpointKind: "custom",
    },
    credentialRef: "connection/conn-1",
    ...overrides,
  };
}

test("schema stores only closed connection metadata", () => {
  const db = new Database(":memory:");

  try {
    ensureConnectionSchema(db);
    ensureConnectionSchema(db);
    const withUnexpectedSecrets = Object.assign(connectionFixture(), {
      apiKey: "sk-secret",
      baseUrl: "https://private.example/v1",
      discoveryUrl: "https://private.example/v1/models",
      headers: { "X-Private": "header-secret" },
    });
    insertConnection(withUnexpectedSecrets, db);

    const sql = db.serialize().toString("utf8");
    assert.equal(sql.includes("sk-secret"), false);
    assert.equal(sql.includes("private.example"), false);
    assert.equal(sql.includes("header-secret"), false);
    assert.deepEqual(Object.keys(getConnection("conn-1", db)!.display).sort(), [
      "endpointConfigured",
      "endpointKind",
      "providerLabel",
      "routeLabel",
      "secretConfigured",
    ]);
  } finally {
    db.close();
  }
});

test("keeps multiple connections for the same provider isolated", () => {
  const db = new Database(":memory:");

  try {
    insertConnection(connectionFixture(), db);
    insertConnection(
      connectionFixture({
        id: "conn-2",
        name: "OpenAI staging",
        credentialRef: "connection/conn-2",
      }),
      db,
    );

    assert.deepEqual(
      listConnections(db).map((connection) => connection.id).sort(),
      ["conn-1", "conn-2"],
    );
    const updated = updateConnectionRecord(
      "conn-1",
      { name: "OpenAI primary", status: "degraded" },
      db,
    );
    assert.equal(updated.name, "OpenAI primary");
    assert.equal(getConnection("conn-2", db)?.name, "OpenAI staging");
    assert.equal(getConnection("conn-2", db)?.status, "ready");
  } finally {
    db.close();
  }
});

test("deletion cascades models and checks while scan snapshots remain", () => {
  const db = new Database(":memory:");

  try {
    ensureConnectionSchema(db);
    insertConnection(connectionFixture(), db);
    db.prepare(
      `INSERT INTO provider_models (
        connection_id, id, display_name, context_window, capabilities_json,
        pricing_json, discovered_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "conn-1",
      "model-1",
      "Model one",
      null,
      "{}",
      null,
      "2026-08-10T12:00:00.000Z",
      "provider-api",
    );
    db.prepare(
      `INSERT INTO connection_capability_checks (
        id, connection_id, kind, status, evidence, error, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "check-1",
      "conn-1",
      "models",
      "passed",
      "Catalog reachable",
      null,
      "2026-08-10T12:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO scan_connection_snapshots (
        scan_id, connection_id, provider_kind, route_kind, transport,
        auth_kind, protocol, model_id, capabilities_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "scan-1",
      "conn-1",
      "openai",
      "openai-api",
      "http-inference",
      "api-key",
      "openai-responses",
      "model-1",
      "{}",
      "2026-08-10T12:00:00.000Z",
    );

    assert.equal(deleteConnectionRecord("conn-1", db), true);
    assert.equal(
      (db.prepare("SELECT count(*) AS count FROM provider_models").get() as { count: number })
        .count,
      0,
    );
    assert.equal(
      (db
        .prepare("SELECT count(*) AS count FROM connection_capability_checks")
        .get() as { count: number }).count,
      0,
    );
    assert.equal(
      (db
        .prepare("SELECT count(*) AS count FROM scan_connection_snapshots")
        .get() as { count: number }).count,
      1,
    );
    assert.equal(deleteConnectionRecord("conn-1", db), false);
  } finally {
    db.close();
  }
});
