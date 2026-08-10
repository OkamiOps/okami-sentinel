import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { StoredProviderConnection } from "./connections-store.js";
import {
  ConnectionStore,
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
    modelCatalogStale: false,
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

test("model rows and snapshots never serialize a vault bundle", () => {
  const db = new Database(":memory:");

  try {
    ensureConnectionSchema(db);
    const store = new ConnectionStore(db);
    store.insert(connectionFixture({
      id: "conn-openrouter",
      credentialRef: "connection/conn-openrouter",
    }));
    store.replaceModels("conn-openrouter", [{
      connectionId: "conn-openrouter",
      id: "vendor/model-a",
      displayName: "Model A",
      contextWindow: 128_000,
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
      pricing: null,
      discoveredAt: "2026-08-11T00:00:00.000Z",
      source: "provider-api",
    }]);
    store.writeSnapshot({
      scanId: "scan-a",
      connectionId: "conn-openrouter",
      routeKind: "openrouter-api",
      modelSelectionMode: "catalog",
      modelId: "vendor/model-a",
      capabilityCheckId: "check-a",
      capturedAt: "2026-08-11T00:00:00.000Z",
    });

    const inspected = JSON.stringify({
      schema: db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      models: db.prepare("SELECT connection_id, model_id, display_name, discovered_at, source FROM provider_models ORDER BY connection_id, model_id").all(),
      snapshots: db.prepare("SELECT scan_id, connection_id, route_kind, model_selection_mode, model_id, capability_check_id, captured_at FROM scan_connection_snapshots ORDER BY scan_id").all(),
      snapshotDto: store.getSnapshot("scan-a"),
    });
    assert.equal(inspected.includes("sk-secret"), false);
    assert.equal(inspected.includes("https://private.example/v1"), false);
    assert.equal(store.getSnapshot("scan-a")?.modelId, "vendor/model-a");
  } finally {
    db.close();
  }
});

test("model refreshes are atomic and only a failed refresh marks the catalog stale", () => {
  const db = new Database(":memory:");

  try {
    const store = new ConnectionStore(db);
    store.insert(connectionFixture());
    store.replaceModels("conn-1", [{
      connectionId: "conn-1",
      id: "model-a",
      displayName: "Model A",
      contextWindow: null,
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
      pricing: null,
      discoveredAt: "2026-08-11T00:00:00.000Z",
      source: "provider-api",
    }]);

    assert.equal(store.get("conn-1")?.modelCatalogStale, false);
    assert.equal(store.getModels("conn-1").length, 1);

    store.markModelCatalogStale("conn-1");
    assert.equal(store.get("conn-1")?.modelCatalogStale, true);

    store.replaceModels("conn-1", []);
    assert.equal(store.get("conn-1")?.modelCatalogStale, false);
    assert.deepEqual(store.getModels("conn-1"), []);
  } finally {
    db.close();
  }
});

test("canonicalizes capability and pricing metadata at the store boundary", () => {
  const db = new Database(":memory:");
  const privateMarker = "sk-capability-metadata-secret";
  const privateUrl = "https://private.example/v1";

  try {
    const store = new ConnectionStore(db);
    store.insert(connectionFixture());
    store.replaceModels("conn-1", [{
      connectionId: "conn-1",
      id: "model-safe",
      displayName: "Safe model",
      contextWindow: null,
      capabilities: Object.assign({
        tools: "supported", artifactOutput: "unknown", structuredOutput: "unknown",
        boundedExecution: "unknown", osIsolation: "unknown", streaming: "unknown",
        usage: "unknown", cancellation: "unknown",
      } as const, {
        providerSecret: privateMarker,
      }),
      pricing: Object.assign({
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: 2,
      }, {
        endpoint: privateUrl,
      }),
      discoveredAt: "2026-08-11T00:00:00.000Z",
      source: "provider-api",
    }]);
    store.writeCapabilityCheck({
      id: "check-safe",
      connectionId: "conn-1",
      modelId: "model-safe",
      protocol: "openai-responses",
      status: "passed",
      capabilities: Object.assign({
        tools: "supported", artifactOutput: "unknown", structuredOutput: "unknown",
        boundedExecution: "unknown", osIsolation: "unknown", streaming: "unknown",
        usage: "unknown", cancellation: "unknown",
      } as const, {
        authorization: privateMarker,
      }),
      errorCode: "rate_limited",
      checkedAt: "2026-08-11T00:00:00.000Z",
    });

    const persisted = JSON.stringify({
      model: db.prepare("SELECT capabilities_json, pricing_json FROM provider_models WHERE model_id = ?").get("model-safe"),
      check: db.prepare("SELECT capabilities_json, error_code FROM connection_capability_checks WHERE id = ?").get("check-safe"),
    });
    assert.equal(persisted.includes(privateMarker), false);
    assert.equal(persisted.includes(privateUrl), false);

    db.prepare("UPDATE provider_models SET capabilities_json = ?, pricing_json = ? WHERE model_id = ?").run(
      JSON.stringify({ tools: "supported", ignored: "supported" }),
      JSON.stringify({
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: 2,
        endpoint: privateUrl,
      }),
      "model-safe",
    );
    db.prepare("UPDATE connection_capability_checks SET capabilities_json = ?, error_code = ? WHERE id = ?").run(
      JSON.stringify({ tools: "supported", leakedHeader: privateMarker }),
      "unknown_snake_case",
      "check-safe",
    );

    const model = store.getModel("conn-1", "model-safe")!;
    const check = store.getCapabilityCheck("check-safe")!;
    assert.deepEqual(Object.keys(model.capabilities).sort(), [
      "artifactOutput", "boundedExecution", "cancellation", "osIsolation",
      "streaming", "structuredOutput", "tools", "usage",
    ]);
    assert.deepEqual(Object.keys(model.pricing!).sort(), [
      "cachedInputUsdPerMillionTokens", "inputUsdPerMillionTokens", "outputUsdPerMillionTokens",
    ]);
    assert.deepEqual(Object.keys(check.capabilities).sort(), [
      "artifactOutput", "boundedExecution", "cancellation", "osIsolation",
      "streaming", "structuredOutput", "tools", "usage",
    ]);
    assert.equal(check.errorCode, null);
  } finally {
    db.close();
  }
});

test("rejects secret and unknown capability error codes before persistence", () => {
  const db = new Database(":memory:");
  const secret = "sk_error_code_secret";

  try {
    const store = new ConnectionStore(db);
    store.insert(connectionFixture());

    for (const [id, errorCode] of [
      ["check-secret", secret],
      ["check-unknown", "unknown_snake_case"],
    ] as const) {
      assert.throws(() => store.writeCapabilityCheck({
        id,
        connectionId: "conn-1",
        modelId: null,
        protocol: "openai-responses",
        status: "failed",
        capabilities: {
          tools: "unknown", artifactOutput: "unknown", structuredOutput: "unknown",
          boundedExecution: "unknown", osIsolation: "unknown", streaming: "unknown",
          usage: "unknown", cancellation: "unknown",
        },
        errorCode: errorCode as never,
        checkedAt: "2026-08-11T00:00:00.000Z",
      }), /safe capability error code/i);
    }
    assert.equal(db.serialize().toString("utf8").includes(secret), false);
    assert.equal(
      (db.prepare("SELECT count(*) AS count FROM connection_capability_checks").get() as { count: number }).count,
      0,
    );
  } finally {
    db.close();
  }
});

test("migrates legacy catalog, check, and snapshot tables idempotently", () => {
  const db = new Database(":memory:");

  try {
    db.exec(`
      CREATE TABLE provider_connections (
        id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, name TEXT NOT NULL,
        provider_kind TEXT NOT NULL, route_kind TEXT NOT NULL, transport TEXT NOT NULL,
        auth_kind TEXT NOT NULL, protocol TEXT NOT NULL, status TEXT NOT NULL,
        credential_ref TEXT, model_selection_mode TEXT NOT NULL, default_model_id TEXT,
        provider_label TEXT NOT NULL, route_label TEXT NOT NULL,
        secret_configured INTEGER NOT NULL, endpoint_configured INTEGER NOT NULL,
        endpoint_kind TEXT, last_tested_at TEXT, last_model_sync_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE provider_models (
        connection_id TEXT NOT NULL, id TEXT NOT NULL, display_name TEXT NOT NULL,
        context_window INTEGER, capabilities_json TEXT NOT NULL, pricing_json TEXT,
        discovered_at TEXT NOT NULL, source TEXT NOT NULL,
        PRIMARY KEY (connection_id, id)
      );
      CREATE INDEX provider_models_by_connection
        ON provider_models(connection_id, discovered_at DESC, id);
      CREATE TABLE connection_capability_checks (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, evidence TEXT, error TEXT, checked_at TEXT NOT NULL
      );
      CREATE INDEX connection_capability_checks_by_connection
        ON connection_capability_checks(connection_id, checked_at DESC, id DESC);
      CREATE TABLE scan_connection_snapshots (
        scan_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider_kind TEXT NOT NULL,
        route_kind TEXT NOT NULL, transport TEXT NOT NULL, auth_kind TEXT NOT NULL,
        protocol TEXT NOT NULL, model_id TEXT, capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX scan_connection_snapshots_by_connection
        ON scan_connection_snapshots(connection_id, created_at DESC, scan_id DESC);
    `);
    db.prepare(`
      INSERT INTO provider_connections VALUES (
        'conn-legacy', 'local', 'Legacy', 'openai', 'openai-api', 'http-inference',
        'api-key', 'openai-responses', 'ready', 'connection/conn-legacy', 'catalog',
        NULL, 'OpenAI', 'OpenAI API', 1, 1, 'custom', NULL, NULL,
        '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
      )
    `).run();
    db.prepare("INSERT INTO provider_models VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "conn-legacy", "legacy-model", "Legacy model", null, "{}", null,
      "2026-08-10T00:00:00.000Z", "provider-api",
    );
    db.prepare("INSERT INTO connection_capability_checks VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "check-legacy", "conn-legacy", "models", "passed", "safe", null,
      "2026-08-10T00:00:00.000Z",
    );
    db.prepare("INSERT INTO scan_connection_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "scan-legacy", "conn-legacy", "openai", "openai-api", "http-inference",
      "api-key", "openai-responses", "legacy-model", "{}", "2026-08-10T00:00:00.000Z",
    );
    db.prepare("INSERT INTO scan_connection_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "scan-legacy-http-null", "conn-legacy", "openai", "openai-api", "http-inference",
      "api-key", "openai-responses", null, "{}", "2026-08-10T00:00:00.000Z",
    );

    ensureConnectionSchema(db);
    ensureConnectionSchema(db);

    const store = new ConnectionStore(db);
    assert.equal(store.getModel("conn-legacy", "legacy-model")?.displayName, "Legacy model");
    assert.equal(store.getSnapshot("scan-legacy")?.modelSelectionMode, "catalog");
    assert.equal(store.getSnapshot("scan-legacy-http-null")?.modelSelectionMode, "legacy-unknown");
    assert.equal(store.getCapabilityCheck("check-legacy")?.modelId, null);
    assert.equal(store.getCapabilityCheck("check-legacy")?.protocol, "openai-responses");
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
    const store = new ConnectionStore(db);
    store.insert(connectionFixture());
    store.replaceModels("conn-1", [{
      connectionId: "conn-1",
      id: "model-1",
      displayName: "Model one",
      contextWindow: null,
      capabilities: {
        tools: "unknown", artifactOutput: "unknown", structuredOutput: "unknown",
        boundedExecution: "unknown", osIsolation: "unknown", streaming: "unknown",
        usage: "unknown", cancellation: "unknown",
      },
      pricing: null,
      discoveredAt: "2026-08-10T12:00:00.000Z",
      source: "provider-api",
    }]);
    store.writeCapabilityCheck({
      id: "check-1",
      connectionId: "conn-1",
      modelId: "model-1",
      protocol: "openai-responses",
      status: "passed",
      capabilities: {
        tools: "unknown", artifactOutput: "unknown", structuredOutput: "unknown",
        boundedExecution: "unknown", osIsolation: "unknown", streaming: "unknown",
        usage: "unknown", cancellation: "unknown",
      },
      errorCode: null,
      checkedAt: "2026-08-10T12:00:00.000Z",
    });
    store.writeSnapshot({
      scanId: "scan-1",
      connectionId: "conn-1",
      routeKind: "openai-api",
      modelSelectionMode: "catalog",
      modelId: "model-1",
      capabilityCheckId: "check-1",
      capturedAt: "2026-08-10T12:00:00.000Z",
    });

    assert.equal(store.delete("conn-1"), true);
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
