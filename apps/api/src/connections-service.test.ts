import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type {
  CreateProviderConnectionRequest,
  ProviderModel,
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
  type ConnectionRouteRegistry,
  type ConnectionInconsistencyRecord,
  createConnectionsService as createConnectionsServiceBase,
  type ConnectionsServiceDependencies,
  listConnectionRecoveryRecords,
  type ConnectionsStore,
  type ConnectionCatalogStore,
  validateScanConnectionSelection,
} from "./connections-service.js";
import { createLocalRuntimeAdapter } from "./connections/local-runtime-adapters.js";
import { AgentSessionError } from "./agent/session-types.js";
import {
  createRouteRegistry,
  type RouteManifest,
} from "./connections/route-registry.js";
import type { RouteAdapter } from "./connections/route-adapter.js";
import type {
  ConnectionSecretBundle,
  CredentialVault,
} from "./credentials/credential-vault.js";
import { VaultError } from "./credentials/credential-vault.js";

class FakeVault implements CredentialVault {
  readonly values = new Map<string, ConnectionSecretBundle>();
  putError: Error | undefined;
  putErrorAtCall = new Map<number, Error>();
  putCalls = 0;
  getError: Error | undefined;
  deleteError: Error | undefined;
  deleteErrorAtCall = new Map<number, Error>();
  deleteCalls = 0;

  async available() {
    return { available: true, backend: "keychain" as const };
  }

  async put(ref: string, value: ConnectionSecretBundle) {
    this.putCalls += 1;
    const scheduled = this.putErrorAtCall.get(this.putCalls);
    if (scheduled) throw scheduled;
    if (this.putError) throw this.putError;
    this.values.set(ref, structuredClone(value));
  }

  async get(ref: string) {
    if (this.getError) throw this.getError;
    const value = this.values.get(ref);
    if (!value) throw new VaultError("credential_not_found");
    return structuredClone(value);
  }

  async delete(ref: string) {
    this.deleteCalls += 1;
    const scheduled = this.deleteErrorAtCall.get(this.deleteCalls);
    if (scheduled) throw scheduled;
    if (this.deleteError) throw this.deleteError;
    this.values.delete(ref);
  }
}

function recoverySink() {
  const records: ConnectionInconsistencyRecord[] = [];
  return {
    records,
    sink: {
      record(record: ConnectionInconsistencyRecord) {
        records.push(structuredClone(record));
      },
    },
  };
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

class FakeCatalog implements ConnectionCatalogStore {
  readonly models = new Map<string, ProviderModel[]>();
  readonly reports: unknown[] = [];
  stale: string[] = [];

  getModels(connectionId: string) {
    return this.models.get(connectionId) ?? [];
  }

  getModel(connectionId: string, modelId: string) {
    return this.getModels(connectionId).find((model) => model.id === modelId) ?? null;
  }

  replaceModels(connectionId: string, models: readonly ProviderModel[]) {
    this.models.set(connectionId, [...models]);
  }

  markModelCatalogStale(connectionId: string) {
    this.stale.push(connectionId);
  }

  writeCapabilityCheck(report: unknown) {
    this.reports.push(report);
  }
}

function catalogModel(connectionId: string, id: string): ProviderModel {
  return {
    connectionId,
    id,
    displayName: id,
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
  };
}

function runtimeRoute(
  overrides: Partial<RouteAdapter> = {},
): RouteAdapter {
  return {
    routeKind: "claude-code-local",
    transport: "local-cli",
    protocol: "claude-code-cli",
    inspect: async () => ({ available: true, reason: null, supportsRuntimeDefault: true }),
    discoverModels: async () => ({ models: [], supportsRuntimeDefault: true }),
    probe: async (connection, selection) => ({
      id: "check-1",
      connectionId: connection.id,
      modelId: selection.modelId,
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
    }),
    ...overrides,
  };
}

interface TestRouteEntry {
  adapter: RouteAdapter;
  providerKind: string;
  authKinds: RouteManifest["authKinds"];
}

function testRouteRegistry(...entries: TestRouteEntry[]): ConnectionRouteRegistry {
  const adapters = new Map(entries.map(({ adapter }) => [adapter.routeKind, adapter]));
  const manifests = new Map(entries.map(({ adapter, providerKind, authKinds }) => [
    adapter.routeKind,
    {
      routeKind: adapter.routeKind as RouteManifest["routeKind"],
      providerKind,
      transport: adapter.transport,
      protocol: adapter.protocol,
      authKinds,
    } satisfies RouteManifest,
  ]));
  return {
    get: (routeKind) => adapters.get(routeKind),
    getManifest: (routeKind) => manifests.get(routeKind),
  };
}

const TEST_ROUTES = testRouteRegistry(
  {
    adapter: runtimeRoute({
      routeKind: "openai-api",
      transport: "http-inference",
      protocol: "openai-responses",
    }),
    providerKind: "openai",
    authKinds: ["api-key"],
  },
  {
    adapter: runtimeRoute(),
    providerKind: "anthropic",
    authKinds: ["existing-session"],
  },
  {
    adapter: runtimeRoute({
      routeKind: "xai-oauth",
      transport: "http-inference",
      protocol: "xai-oauth-responses",
    }),
    providerKind: "xai",
    authKinds: ["device-code"],
  },
  {
    adapter: runtimeRoute({
      routeKind: "cursor-background-agents",
      transport: "remote-agent-api",
      protocol: "cursor-background-agents",
    }),
    providerKind: "cursor",
    authKinds: ["api-key"],
  },
);

function createConnectionsService(deps: ConnectionsServiceDependencies) {
  return createConnectionsServiceBase({
    ...deps,
    routes: deps.routes ?? TEST_ROUTES,
  });
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
    name: "Claude Code local",
    providerKind: "anthropic",
    routeKind: "claude-code-local",
    transport: "local-cli",
    authKind: "existing-session",
    protocol: "claude-code-cli",
    modelSelectionMode: "runtime-default",
  };
}

function storedCursorConnection(authKind: "existing-session" | "api-key" = "api-key") {
  return {
    id: "conn-cursor-invalid-auth",
    scopeId: "local" as const,
    name: "Cursor Agent local",
    providerKind: "cursor",
    routeKind: "cursor-agent-local",
    transport: "local-cli" as const,
    authKind,
    protocol: "cursor-agent-cli" as const,
    status: "authentication-required" as const,
    modelSelectionMode: "catalog" as const,
    defaultModelId: null,
    lastTestedAt: null,
    lastModelSyncAt: null,
    modelCatalogStale: false,
    display: {
      providerLabel: "cursor",
      routeLabel: "cursor-agent-local",
      secretConfigured: authKind === "api-key",
      endpointConfigured: false,
      endpointKind: null,
    },
    credentialRef: authKind === "api-key" ? "connection/conn-cursor-invalid-auth" : null,
  };
}

test("closed local registry rejects unknown routes and Cursor API keys before vault or SQLite", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsServiceBase({ vault, store: storeFor(db) });

    await assert.rejects(service.create({
      ...cliConnectionInput(),
      routeKind: "unknown-local-runtime",
    }), { code: "invalid_connection" });
    await assert.rejects(service.create({
      name: "Cursor Agent local",
      providerKind: "cursor",
      routeKind: "cursor-agent-local",
      transport: "local-cli",
      authKind: "api-key",
      protocol: "cursor-agent-cli",
      modelSelectionMode: "catalog",
      secret: { apiKey: "cursor-key-must-not-persist" },
    }), { code: "invalid_connection" });

    assert.equal(vault.putCalls, 0);
    assert.equal(listConnections(db).length, 0);
  } finally {
    db.close();
  }
});

test("default registry accepts the reviewed OpenAI API route before vault persistence", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsServiceBase({ vault, store: storeFor(db) });

    const connection = await service.create(apiConnectionInput());

    assert.equal(connection.routeKind, "openai-api");
    assert.equal(connection.protocol, "openai-responses");
    assert.equal(vault.putCalls, 1);
    assert.equal(listConnections(db).length, 1);
  } finally {
    db.close();
  }
});

test("update validates the persisted route contract before vault or SQLite writes", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const stored = storedCursorConnection();
    insertConnection(stored, db);
    vault.values.set(stored.credentialRef!, { apiKey: "existing-cursor-key" });
    const service = createConnectionsServiceBase({ vault, store: storeFor(db) });

    await assert.rejects(
      service.update(stored.id, { name: "Cursor renamed" }),
      { code: "invalid_connection" },
    );

    assert.equal(vault.putCalls, 0);
    assert.equal(getConnection(stored.id, db)?.name, "Cursor Agent local");
  } finally {
    db.close();
  }
});

test("route usage rejects a persisted auth mismatch before launching Cursor", async () => {
  const db = new Database(":memory:");
  try {
    const calls: string[][] = [];
    const local = createLocalRuntimeAdapter({
      execFile: async (binary, args) => {
        calls.push([binary, ...args]);
        return { stdout: "cursor-agent 1.0", stderr: "" };
      },
    });
    const routes = createRouteRegistry({ local });
    const stored = storedCursorConnection();
    insertConnection(stored, db);
    const service = createConnectionsServiceBase({
      vault: new FakeVault(),
      store: storeFor(db),
      routes,
    });

    await assert.rejects(service.inspect(stored.id), { code: "protocol_unsupported" });
    assert.deepEqual(calls, []);
  } finally {
    db.close();
  }
});

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

test("permits a managed device flow without inventing an API key", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });

    const connection = await service.create({
      name: "xAI subscription",
      providerKind: "xai",
      routeKind: "xai-oauth",
      transport: "http-inference",
      authKind: "device-code",
      protocol: "xai-oauth-responses",
      modelSelectionMode: "catalog",
    });

    assert.equal(connection.status, "authentication-required");
    assert.equal(connection.display.secretConfigured, false);
    assert.equal(getConnection(connection.id, db)?.credentialRef, null);
    assert.equal(vault.values.size, 0);
  } finally {
    db.close();
  }
});

test("still requires a vault secret for API-key HTTP and remote routes", async () => {
  const db = new Database(":memory:");
  try {
    const service = createConnectionsService({ vault: new FakeVault(), store: storeFor(db) });
    const withoutSecret = apiConnectionInput();
    delete withoutSecret.secret;

    await assert.rejects(() => service.create(withoutSecret), { code: "invalid_connection" });
    await assert.rejects(() => service.create({
      name: "Cursor Cloud",
      providerKind: "cursor",
      routeKind: "cursor-background-agents",
      transport: "remote-agent-api",
      authKind: "api-key",
      protocol: "cursor-background-agents",
      modelSelectionMode: "catalog",
    }), { code: "invalid_connection" });
  } finally {
    db.close();
  }
});

test("runtime-default is rejected for an HTTP connection", () => {
  assert.throws(() => validateScanConnectionSelection({
    connectionId: "conn-http",
    modelSelectionMode: "runtime-default",
    modelId: null,
  }, {
    transport: "http-inference",
    supportsRuntimeDefault: false,
  }), { code: "invalid_model_selection" });
});

test("runtime-default is allowed only when the Claude local adapter reports it", () => {
  assert.throws(() => validateScanConnectionSelection({
    connectionId: "conn-local",
    modelSelectionMode: "runtime-default",
    modelId: null,
  }, {
    routeKind: "xai-grok-build-local",
    transport: "local-cli",
    supportsRuntimeDefault: true,
  }), { code: "invalid_model_selection" });

  assert.doesNotThrow(() => validateScanConnectionSelection({
    connectionId: "conn-claude",
    modelSelectionMode: "runtime-default",
    modelId: null,
  }, {
    routeKind: "claude-code-local",
    transport: "local-cli",
    supportsRuntimeDefault: true,
  }));
});

test("refresh persists only models returned by the selected route and marks an error stale", async () => {
  const db = new Database(":memory:");
  try {
    const catalog = new FakeCatalog();
    const adapter = runtimeRoute({
      routeKind: "xai-grok-build-local",
      protocol: "grok-build-cli",
      discoverModels: async (connection) => ({
        models: [{
          connectionId: connection.id,
          id: "runtime-reported-model",
          displayName: "Runtime reported model",
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
          source: "runtime",
        }],
        supportsRuntimeDefault: false,
      }),
    });
    const service = createConnectionsService({
      vault: new FakeVault(),
      store: storeFor(db),
      catalog,
      routes: testRouteRegistry({
        adapter,
        providerKind: "xai",
        authKinds: ["existing-session"],
      }),
    });
    const created = await service.create({
      name: "Grok local",
      providerKind: "xai",
      routeKind: "xai-grok-build-local",
      transport: "local-cli",
      authKind: "existing-session",
      protocol: "grok-build-cli",
      modelSelectionMode: "catalog",
    });
    catalog.models.set(created.id, [{
      connectionId: created.id,
      id: "removed-model",
      displayName: "Removed model",
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
      discoveredAt: "2026-08-10T00:00:00.000Z",
      source: "runtime",
    }]);

    const refreshed = await service.refreshModels(created.id);

    assert.deepEqual(refreshed?.discovery.models.map((model) => model.id), ["runtime-reported-model"]);
    assert.deepEqual(catalog.getModels(created.id).map((model) => model.id), ["runtime-reported-model"]);

    const degradedService = createConnectionsService({
      vault: new FakeVault(),
      store: storeFor(db),
      catalog,
      routes: testRouteRegistry({
        adapter: runtimeRoute({
          routeKind: "xai-grok-build-local",
          protocol: "grok-build-cli",
          discoverModels: async () => ({
            models: [],
            supportsRuntimeDefault: false,
            safeError: { code: "model_discovery_unsupported" },
          }),
        }),
        providerKind: "xai",
        authKinds: ["existing-session"],
      }),
    });
    const degraded = await degradedService.refreshModels(created.id);
    assert.equal(degraded?.discovery.safeError?.code, "model_discovery_unsupported");
    assert.deepEqual(catalog.stale, [created.id]);
  } finally {
    db.close();
  }
});

test("a cancelled probe never persists a capability report after adapter cancellation", async () => {
  const db = new Database(":memory:");
  try {
    const catalog = new FakeCatalog();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const adapter = runtimeRoute({
      routeKind: "openai-api",
      transport: "http-inference",
      protocol: "openai-responses",
      async probe(_connection, _selection, options) {
        observedSignal = options?.signal;
        controller.abort();
        throw new AgentSessionError("agent_cancelled");
      },
    });
    const service = createConnectionsService({
      vault: new FakeVault(),
      store: storeFor(db),
      catalog,
      routes: testRouteRegistry({ adapter, providerKind: "openai", authKinds: ["api-key"] }),
    });
    const connection = await service.create(apiConnectionInput());
    catalog.models.set(connection.id, [catalogModel(connection.id, "account-visible")]);

    await assert.rejects(
      service.probe(connection.id, {
        connectionId: connection.id,
        modelSelectionMode: "catalog",
        modelId: "account-visible",
      }, { signal: controller.signal }),
      { code: "agent_cancelled" },
    );

    assert.equal(observedSignal, controller.signal);
    assert.deepEqual(catalog.reports, []);
    assert.equal(getConnection(connection.id, db)?.lastTestedAt, null);
  } finally {
    db.close();
  }
});

test("catalog selection requires a live model from the selected connection", () => {
  assert.throws(() => validateScanConnectionSelection({
    connectionId: "conn-a",
    modelSelectionMode: "catalog",
    modelId: "model-owned-by-conn-b",
  }, {
    transport: "http-inference",
    supportsRuntimeDefault: false,
    model: {
      connectionId: "conn-b",
      id: "model-owned-by-conn-b",
      displayName: "Model B",
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
    },
  }), { code: "model_not_found" });
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

test("rejects URL and credential-shaped connection metadata before vault or SQLite", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });
    const invalid = [
      { ...cliConnectionInput(), name: "Authorization: Bearer private-token" },
      { ...cliConnectionInput(), providerKind: "https://private.example/v1" },
      { ...cliConnectionInput(), routeKind: "private.example" },
      { ...cliConnectionInput(), routeKind: "codex/local?token=private" },
    ];

    for (const input of invalid) {
      await assert.rejects(service.create(input), { code: "invalid_connection" });
    }
    assert.equal(vault.values.size, 0);
    assert.equal(listConnections(db).length, 0);
  } finally {
    db.close();
  }
});

test("rejects opaque bundle values copied into any create metadata label", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });
    const cases: CreateProviderConnectionRequest[] = [
      {
        ...apiConnectionInput("opaque-value-12345"),
        name: "opaque-value-12345",
      },
      {
        ...apiConnectionInput("provider-opaque-12345"),
        providerKind: "provider-opaque-12345",
      },
      {
        ...apiConnectionInput("opaque-route-12345"),
        routeKind: "prefix-opaque-route-12345",
      },
      {
        ...apiConnectionInput("unrelated-api-key"),
        name: "Production header-opaque-12345 connection",
        secret: {
          apiKey: "unrelated-api-key",
          headers: { "X-Workspace": "header-opaque-12345" },
        },
      },
    ];

    for (const input of cases) {
      await assert.rejects(service.create(input), { code: "invalid_connection" });
    }
    assert.equal(vault.values.size, 0);
    assert.equal(listConnections(db).length, 0);
    const serialized = db.serialize().toString("utf8");
    assert.equal(serialized.includes("opaque-value-12345"), false);
    assert.equal(serialized.includes("header-opaque-12345"), false);
  } finally {
    db.close();
  }
});

test("rejects unknown create fields and non-plain request objects", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });
    const unknown = Object.assign(cliConnectionInput(), {
      credentialRef: "connection/attacker-controlled",
    });
    const inherited = Object.assign(Object.create({ status: "ready" }), cliConnectionInput());

    await assert.rejects(service.create(unknown as never), { code: "invalid_connection" });
    await assert.rejects(service.create(inherited), { code: "invalid_connection" });
    assert.equal(vault.values.size, 0);
    assert.equal(listConnections(db).length, 0);
  } finally {
    db.close();
  }
});

test("rejects a secret patch for a local existing-session connection", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });
    const created = await service.create(cliConnectionInput());

    await assert.rejects(
      service.update(created.id, { secret: { apiKey: "must-not-persist" } }),
      { code: "invalid_connection" },
    );
    assert.equal(vault.values.size, 0);
    assert.equal(getConnection(created.id, db)?.credentialRef, null);
  } finally {
    db.close();
  }
});

test("rejects a name and replacement secret that contain the same opaque value", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });
    const created = await service.create(apiConnectionInput("old-opaque-value"));
    const ref = getConnection(created.id, db)!.credentialRef!;

    await assert.rejects(
      service.update(created.id, {
        name: "replacement-opaque-value-12345",
        secret: { apiKey: "opaque-value-12345" },
      }),
      { code: "invalid_connection" },
    );
    assert.equal(getConnection(created.id, db)?.name, "OpenAI production");
    assert.deepEqual(await vault.get(ref), apiConnectionInput("old-opaque-value").secret);
    assert.equal(db.serialize().toString("utf8").includes("opaque-value-12345"), false);
  } finally {
    db.close();
  }
});

test("rejects a name-only patch containing an opaque secret already in the vault", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });
    const created = await service.create(apiConnectionInput("opaque-existing-12345"));

    await assert.rejects(
      service.update(created.id, { name: "Production opaque-existing-12345" }),
      { code: "invalid_connection" },
    );
    assert.equal(getConnection(created.id, db)?.name, "OpenAI production");
    assert.equal(db.serialize().toString("utf8").includes("opaque-existing-12345"), false);
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

test("create reports and records inconsistency when vault compensation fails", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    vault.deleteError = new Error("delete compensation failed with sk-write-only");
    const recoveryCount = listConnectionRecoveryRecords().length;
    const base = storeFor(db);
    const service = createConnectionsService({
      vault,
      store: { ...base, insert: () => { throw new Error("insert failed"); } },
    });

    await assert.rejects(service.create(apiConnectionInput()), {
      code: "connection_state_inconsistent",
    });
    assert.equal(vault.values.size, 1);
    const recorded = listConnectionRecoveryRecords().at(recoveryCount);
    assert.equal(recorded?.operation, "create-rollback");
    assert.equal(JSON.stringify(recorded).includes("sk-write-only"), false);
    assert.match(recorded?.credentialRef ?? "", /^connection\/[0-9a-f-]{36}$/i);
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

test("update reports inconsistency when restoring the prior secret fails", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const recovery = recoverySink();
    const base = storeFor(db);
    const service = createConnectionsService({ vault, recovery: recovery.sink, store: base });
    const created = await service.create(apiConnectionInput("old-secret"));
    const ref = getConnection(created.id, db)!.credentialRef!;
    vault.putErrorAtCall.set(3, new Error("restore failed with old-secret"));
    const failing = createConnectionsService({
      vault,
      recovery: recovery.sink,
      store: { ...base, update: () => { throw new Error("metadata failed"); } },
    });

    await assert.rejects(
      failing.update(created.id, { secret: { apiKey: "new-secret" } }),
      { code: "connection_state_inconsistent" },
    );
    assert.deepEqual(await vault.get(ref), { apiKey: "new-secret" });
    assert.equal(recovery.records.at(-1)?.operation, "update-rollback");
    assert.equal(JSON.stringify(recovery.records).includes("old-secret"), false);
    assert.equal(JSON.stringify(recovery.records).includes("new-secret"), false);
  } finally {
    db.close();
  }
});

test("rotates a secret when metadata exists but the vault entry is missing", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });
    const created = await service.create(apiConnectionInput("old-secret"));
    const ref = getConnection(created.id, db)!.credentialRef!;
    vault.values.delete(ref);

    const updated = await service.update(created.id, { secret: { apiKey: "replacement-secret" } });

    assert.equal(updated?.id, created.id);
    assert.deepEqual(await vault.get(ref), { apiKey: "replacement-secret" });
  } finally {
    db.close();
  }
});

test("real vault unavailability still blocks rotate and delete", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });
    const created = await service.create(apiConnectionInput());
    vault.getError = new VaultError("secure_storage_unavailable");

    await assert.rejects(
      service.update(created.id, { secret: { apiKey: "replacement-secret" } }),
      { code: "secure_storage_unavailable" },
    );
    await assert.rejects(service.remove(created.id), {
      code: "secure_storage_unavailable",
    });
    assert.notEqual(getConnection(created.id, db), null);
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

test("deletes stale metadata when its vault entry is already missing", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const service = createConnectionsService({ vault, store: storeFor(db) });
    const created = await service.create(apiConnectionInput());
    const ref = getConnection(created.id, db)!.credentialRef!;
    vault.values.delete(ref);

    assert.equal(await service.remove(created.id), true);
    assert.equal(getConnection(created.id, db), null);
  } finally {
    db.close();
  }
});

test("delete reports inconsistency when restoring a removed secret fails", async () => {
  const db = new Database(":memory:");
  try {
    const vault = new FakeVault();
    const recovery = recoverySink();
    const base = storeFor(db);
    const service = createConnectionsService({ vault, recovery: recovery.sink, store: base });
    const created = await service.create(apiConnectionInput("old-secret"));
    const ref = getConnection(created.id, db)!.credentialRef!;
    vault.putErrorAtCall.set(2, new Error("restore failed with old-secret"));
    const failing = createConnectionsService({
      vault,
      recovery: recovery.sink,
      store: { ...base, delete: () => { throw new Error("metadata delete failed"); } },
    });

    await assert.rejects(failing.remove(created.id), {
      code: "connection_state_inconsistent",
    });
    assert.equal(vault.values.has(ref), false);
    assert.notEqual(getConnection(created.id, db), null);
    assert.equal(recovery.records.at(-1)?.operation, "delete-rollback");
    assert.equal(JSON.stringify(recovery.records).includes("old-secret"), false);
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
