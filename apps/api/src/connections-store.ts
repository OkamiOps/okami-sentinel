import type Database from "better-sqlite3";
import { isSafeProviderErrorCode } from "@csb/shared";
import type {
  CapabilityReport,
  ConnectionDisplay,
  ConnectionStatus,
  ModelCapabilities,
  ModelPricing,
  ModelSelectionMode,
  ProviderConnection,
  ProviderModel,
  SafeProviderErrorCode,
  ScanConnectionSnapshot,
} from "@csb/shared";
import { getDb } from "./db.js";
import type {
  CodexAppServerSafeState,
  CodexAppServerStateSink,
} from "./connections/codex-app-server-bridge.js";

interface ProviderConnectionRow {
  id: string;
  scope_id: "local";
  name: string;
  provider_kind: string;
  route_kind: string;
  transport: ProviderConnection["transport"];
  auth_kind: ProviderConnection["authKind"];
  protocol: ProviderConnection["protocol"];
  status: ConnectionStatus;
  credential_ref: string | null;
  model_selection_mode: ModelSelectionMode;
  default_model_id: string | null;
  provider_label: string;
  route_label: string;
  secret_configured: number;
  endpoint_configured: number;
  endpoint_kind: ConnectionDisplay["endpointKind"];
  last_tested_at: string | null;
  last_model_sync_at: string | null;
  model_catalog_stale: number;
}

interface ProviderModelRow {
  connection_id: string;
  model_id: string;
  display_name: string;
  context_window: number | null;
  capabilities_json: string;
  pricing_json: string | null;
  discovered_at: string;
  source: ProviderModel["source"];
}

interface CapabilityReportRow {
  id: string;
  connection_id: string;
  model_id: string | null;
  protocol: CapabilityReport["protocol"];
  status: CapabilityReport["status"];
  capabilities_json: string;
  error_code: string | null;
  checked_at: string;
}

interface SnapshotRow {
  scan_id: string;
  connection_id: string;
  route_kind: string;
  model_selection_mode: ScanConnectionSnapshot["modelSelectionMode"];
  model_id: string | null;
  capability_check_id: string | null;
  captured_at: string;
}

/** API-internal connection metadata. Its vault reference never leaves this module layer. */
export interface StoredProviderConnection extends ProviderConnection {
  credentialRef: string | null;
}

export interface ConnectionRecordPatch {
  name?: string;
  status?: ConnectionStatus;
  credentialRef?: string | null;
  modelSelectionMode?: ModelSelectionMode;
  defaultModelId?: string | null;
  lastTestedAt?: string | null;
  lastModelSyncAt?: string | null;
  modelCatalogStale?: boolean;
  display?: ConnectionDisplay;
}

const unknownCapabilities: ModelCapabilities = Object.freeze({
  tools: "unknown",
  artifactOutput: "unknown",
  structuredOutput: "unknown",
  boundedExecution: "unknown",
  osIsolation: "unknown",
  streaming: "unknown",
  usage: "unknown",
  cancellation: "unknown",
});

export function ensureConnectionSchema(
  database: Database.Database = getDb(),
): void {
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS provider_connections (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL CHECK(scope_id = 'local'),
      name TEXT NOT NULL,
      provider_kind TEXT NOT NULL,
      route_kind TEXT NOT NULL,
      transport TEXT NOT NULL,
      auth_kind TEXT NOT NULL,
      protocol TEXT NOT NULL,
      status TEXT NOT NULL,
      credential_ref TEXT,
      model_selection_mode TEXT NOT NULL,
      default_model_id TEXT,
      provider_label TEXT NOT NULL,
      route_label TEXT NOT NULL,
      secret_configured INTEGER NOT NULL,
      endpoint_configured INTEGER NOT NULL,
      endpoint_kind TEXT,
      last_tested_at TEXT,
      last_model_sync_at TEXT,
      model_catalog_stale INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_connections_by_scope_updated
      ON provider_connections(scope_id, updated_at DESC, id DESC);
  `);
  addColumnIfMissing(
    database,
    "provider_connections",
    "model_catalog_stale",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureProviderModelsSchema(database);
  ensureCapabilityChecksSchema(database);
  ensureSnapshotsSchema(database);
  ensureCodexAppServerStateSchema(database);
}

/** Narrow persistence boundary for safe connection metadata and immutable snapshots. */
export class ConnectionStore {
  constructor(private readonly database: Database.Database = getDb()) {
    ensureConnectionSchema(database);
  }

  list(): StoredProviderConnection[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM provider_connections
         WHERE scope_id = 'local'
         ORDER BY updated_at DESC, id DESC`,
      )
      .all() as ProviderConnectionRow[];
    return rows.map(rowToStoredProviderConnection);
  }

  get(id: string): StoredProviderConnection | null {
    const row = this.database
      .prepare(
        `SELECT * FROM provider_connections
         WHERE id = ? AND scope_id = 'local'`,
      )
      .get(id) as ProviderConnectionRow | undefined;
    return row === undefined ? null : rowToStoredProviderConnection(row);
  }

  insert(connection: StoredProviderConnection): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO provider_connections (
          id, scope_id, name, provider_kind, route_kind, transport, auth_kind,
          protocol, status, credential_ref, model_selection_mode, default_model_id,
          provider_label, route_label, secret_configured, endpoint_configured,
          endpoint_kind, last_tested_at, last_model_sync_at, model_catalog_stale,
          created_at, updated_at
        ) VALUES (
          @id, @scope_id, @name, @provider_kind, @route_kind, @transport, @auth_kind,
          @protocol, @status, @credential_ref, @model_selection_mode, @default_model_id,
          @provider_label, @route_label, @secret_configured, @endpoint_configured,
          @endpoint_kind, @last_tested_at, @last_model_sync_at, @model_catalog_stale,
          @created_at, @updated_at
        )`,
      )
      .run(connectionToParams(connection, now));
  }

  update(id: string, patch: ConnectionRecordPatch): StoredProviderConnection {
    const assignments: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: new Date().toISOString() };

    if (patch.name !== undefined) assign(assignments, params, "name", patch.name);
    if (patch.status !== undefined) assign(assignments, params, "status", patch.status);
    if (patch.credentialRef !== undefined) {
      assign(assignments, params, "credential_ref", patch.credentialRef);
    }
    if (patch.modelSelectionMode !== undefined) {
      assign(assignments, params, "model_selection_mode", patch.modelSelectionMode);
    }
    if (patch.defaultModelId !== undefined) {
      assign(assignments, params, "default_model_id", patch.defaultModelId);
    }
    if (patch.lastTestedAt !== undefined) {
      assign(assignments, params, "last_tested_at", patch.lastTestedAt);
    }
    if (patch.lastModelSyncAt !== undefined) {
      assign(assignments, params, "last_model_sync_at", patch.lastModelSyncAt);
    }
    if (patch.modelCatalogStale !== undefined) {
      assign(assignments, params, "model_catalog_stale", patch.modelCatalogStale ? 1 : 0);
    }
    if (patch.display !== undefined) {
      assign(assignments, params, "provider_label", patch.display.providerLabel);
      assign(assignments, params, "route_label", patch.display.routeLabel);
      assign(assignments, params, "secret_configured", patch.display.secretConfigured ? 1 : 0);
      assign(assignments, params, "endpoint_configured", patch.display.endpointConfigured ? 1 : 0);
      assign(assignments, params, "endpoint_kind", patch.display.endpointKind);
    }

    if (assignments.length > 0) {
      assignments.push("updated_at = @updated_at");
      this.database
        .prepare(
          `UPDATE provider_connections
           SET ${assignments.join(", ")}
           WHERE id = @id AND scope_id = 'local'`,
        )
        .run(params);
    }

    const connection = this.get(id);
    if (connection === null) throw new Error("Provider connection not found");
    return connection;
  }

  delete(id: string): boolean {
    const remove = this.database.transaction((connectionId: string) =>
      this.database
        .prepare(
          "DELETE FROM provider_connections WHERE id = ? AND scope_id = 'local'",
        )
        .run(connectionId),
    );
    return remove(id).changes > 0;
  }

  getModels(connectionId: string): ProviderModel[] {
    const rows = this.database
      .prepare(
        `SELECT connection_id, model_id, display_name, context_window, capabilities_json,
          pricing_json, discovered_at, source
         FROM provider_models
         WHERE connection_id = ?
         ORDER BY discovered_at DESC, model_id ASC`,
      )
      .all(connectionId) as ProviderModelRow[];
    return rows.map(rowToProviderModel);
  }

  getModel(connectionId: string, modelId: string): ProviderModel | null {
    const row = this.database
      .prepare(
        `SELECT connection_id, model_id, display_name, context_window, capabilities_json,
          pricing_json, discovered_at, source
         FROM provider_models
         WHERE connection_id = ? AND model_id = ?`,
      )
      .get(connectionId, modelId) as ProviderModelRow | undefined;
    return row === undefined ? null : rowToProviderModel(row);
  }

  replaceModels(connectionId: string, models: readonly ProviderModel[]): void {
    if (models.some((model) => model.connectionId !== connectionId)) {
      throw new Error("Provider model connection mismatch");
    }
    const refreshedAt = new Date().toISOString();
    const replace = this.database.transaction(() => {
      this.database
        .prepare("DELETE FROM provider_models WHERE connection_id = ?")
        .run(connectionId);
      const insert = this.database.prepare(
        `INSERT INTO provider_models (
          connection_id, model_id, display_name, context_window, capabilities_json,
          pricing_json, discovered_at, source
        ) VALUES (
          @connection_id, @model_id, @display_name, @context_window, @capabilities_json,
          @pricing_json, @discovered_at, @source
        )`,
      );
      for (const model of models) insert.run(modelToParams(model));
      const update = this.database
        .prepare(
          `UPDATE provider_connections
           SET last_model_sync_at = ?, model_catalog_stale = 0, updated_at = ?
           WHERE id = ? AND scope_id = 'local'`,
        )
        .run(refreshedAt, refreshedAt, connectionId);
      if (update.changes !== 1) throw new Error("Provider connection not found");
    });
    replace();
  }

  /** Called by a refresh boundary only after its discovery operation has failed. */
  markModelCatalogStale(connectionId: string): void {
    const update = this.database
      .prepare(
        `UPDATE provider_connections
         SET model_catalog_stale = 1, updated_at = ?
         WHERE id = ? AND scope_id = 'local'`,
      )
      .run(new Date().toISOString(), connectionId);
    if (update.changes !== 1) throw new Error("Provider connection not found");
  }

  writeCapabilityCheck(report: CapabilityReport): void {
    this.database
      .prepare(
        `INSERT INTO connection_capability_checks (
          id, connection_id, model_id, protocol, status, capabilities_json,
          error_code, checked_at
        ) VALUES (
          @id, @connection_id, @model_id, @protocol, @status, @capabilities_json,
          @error_code, @checked_at
        )`,
      )
      .run(capabilityReportToParams(report));
  }

  getCapabilityCheck(id: string): CapabilityReport | null {
    const row = this.database
      .prepare(
        `SELECT id, connection_id, model_id, protocol, status, capabilities_json,
          error_code, checked_at
         FROM connection_capability_checks
         WHERE id = ?`,
      )
      .get(id) as CapabilityReportRow | undefined;
    return row === undefined ? null : rowToCapabilityReport(row);
  }

  writeSnapshot(snapshot: ScanConnectionSnapshot): void {
    this.database
      .prepare(
        `INSERT INTO scan_connection_snapshots (
          scan_id, connection_id, route_kind, model_selection_mode, model_id,
          capability_check_id, captured_at
        ) VALUES (
          @scan_id, @connection_id, @route_kind, @model_selection_mode, @model_id,
          @capability_check_id, @captured_at
        )`,
      )
      .run(snapshotToParams(snapshot));
  }

  getSnapshot(scanId: string): ScanConnectionSnapshot | null {
    const row = this.database
      .prepare(
        `SELECT scan_id, connection_id, route_kind, model_selection_mode, model_id,
          capability_check_id, captured_at
         FROM scan_connection_snapshots
         WHERE scan_id = ?`,
      )
      .get(scanId) as SnapshotRow | undefined;
    return row === undefined ? null : rowToSnapshot(row);
  }
}

/** SQLite sink for safe Codex app-server account state; OAuth handoffs are never accepted here. */
export class CodexAppServerStateStore implements CodexAppServerStateSink {
  constructor(private readonly database: Database.Database = getDb()) {
    ensureConnectionSchema(database);
  }

  record(state: CodexAppServerSafeState): void {
    const safe = codexAppServerStateToParams(state);
    this.database
      .prepare(
        `INSERT INTO codex_app_server_state (login_id, status, plan_label, synced_at)
         VALUES (@login_id, @status, @plan_label, @synced_at)`,
      )
      .run(safe);
  }
}

export function listConnections(
  database: Database.Database = getDb(),
): StoredProviderConnection[] {
  return new ConnectionStore(database).list();
}

export function getConnection(
  id: string,
  database: Database.Database = getDb(),
): StoredProviderConnection | null {
  return new ConnectionStore(database).get(id);
}

export function insertConnection(
  connection: StoredProviderConnection,
  database: Database.Database = getDb(),
): void {
  new ConnectionStore(database).insert(connection);
}

export function updateConnectionRecord(
  id: string,
  patch: ConnectionRecordPatch,
  database: Database.Database = getDb(),
): StoredProviderConnection {
  return new ConnectionStore(database).update(id, patch);
}

export function deleteConnectionRecord(
  id: string,
  database: Database.Database = getDb(),
): boolean {
  return new ConnectionStore(database).delete(id);
}

function ensureProviderModelsSchema(database: Database.Database): void {
  if (hasColumn(database, "provider_models", "model_id")) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS provider_models_by_connection
        ON provider_models(connection_id, discovered_at DESC, model_id);
    `);
    return;
  }
  if (tableExists(database, "provider_models")) {
    database.transaction(() => {
      database.exec("ALTER TABLE provider_models RENAME TO provider_models_legacy");
      createProviderModelsTable(database);
      database.exec(`
        INSERT INTO provider_models (
          connection_id, model_id, display_name, context_window, capabilities_json,
          pricing_json, discovered_at, source
        )
        SELECT connection_id, id, display_name, context_window, capabilities_json,
          pricing_json, discovered_at, source
        FROM provider_models_legacy
      `);
      database.exec("DROP TABLE provider_models_legacy");
    })();
  } else {
    createProviderModelsTable(database);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS provider_models_by_connection
      ON provider_models(connection_id, discovered_at DESC, model_id);
  `);
}

function createProviderModelsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE provider_models (
      connection_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      context_window INTEGER,
      capabilities_json TEXT NOT NULL,
      pricing_json TEXT,
      discovered_at TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (connection_id, model_id),
      FOREIGN KEY (connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE
    )
  `);
}

function ensureCapabilityChecksSchema(database: Database.Database): void {
  if (!tableExists(database, "connection_capability_checks")) {
    database.exec(`
      CREATE TABLE connection_capability_checks (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        model_id TEXT,
        protocol TEXT NOT NULL,
        status TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        error_code TEXT,
        checked_at TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE
      );
      CREATE INDEX connection_capability_checks_by_connection
        ON connection_capability_checks(connection_id, checked_at DESC, id DESC);
    `);
    return;
  }
  if (!hasColumn(database, "connection_capability_checks", "model_id")) {
    database.transaction(() => {
      database.exec("ALTER TABLE connection_capability_checks RENAME TO connection_capability_checks_legacy");
      database.exec(`
        CREATE TABLE connection_capability_checks (
          id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL,
          model_id TEXT,
          protocol TEXT NOT NULL,
          status TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          error_code TEXT,
          checked_at TEXT NOT NULL,
          FOREIGN KEY (connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE
        );
        INSERT INTO connection_capability_checks (
          id, connection_id, model_id, protocol, status, capabilities_json,
          error_code, checked_at
        )
        SELECT legacy.id, legacy.connection_id, NULL, connection.protocol,
          legacy.status, '{}', NULL, legacy.checked_at
        FROM connection_capability_checks_legacy AS legacy
        INNER JOIN provider_connections AS connection
          ON connection.id = legacy.connection_id;
        DROP TABLE connection_capability_checks_legacy;
      `);
    })();
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS connection_capability_checks_by_connection
      ON connection_capability_checks(connection_id, checked_at DESC, id DESC);
  `);
}

function ensureSnapshotsSchema(database: Database.Database): void {
  if (!tableExists(database, "scan_connection_snapshots")) {
    createSnapshotsTable(database);
    createSnapshotsIndex(database);
    return;
  }
  if (!hasColumn(database, "scan_connection_snapshots", "model_selection_mode")) {
    database.transaction(() => {
      database.exec("ALTER TABLE scan_connection_snapshots RENAME TO scan_connection_snapshots_legacy");
      createSnapshotsTable(database);
      database.exec(`
        INSERT INTO scan_connection_snapshots (
          scan_id, connection_id, route_kind, model_selection_mode, model_id,
          capability_check_id, captured_at
        )
        SELECT scan_id, connection_id, route_kind,
          CASE WHEN model_id IS NULL THEN 'legacy-unknown' ELSE 'catalog' END,
          model_id, NULL, created_at
        FROM scan_connection_snapshots_legacy;
        DROP TABLE scan_connection_snapshots_legacy;
      `);
    })();
  }
  createSnapshotsIndex(database);
}

function ensureCodexAppServerStateSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS codex_app_server_state (
      login_id TEXT,
      status TEXT NOT NULL,
      plan_label TEXT,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS codex_app_server_state_by_synced_at
      ON codex_app_server_state(synced_at DESC);
  `);
}

function createSnapshotsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE scan_connection_snapshots (
      scan_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      route_kind TEXT NOT NULL,
      model_selection_mode TEXT NOT NULL,
      model_id TEXT,
      capability_check_id TEXT,
      captured_at TEXT NOT NULL
    )
  `);
}

function createSnapshotsIndex(database: Database.Database): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS scan_connection_snapshots_by_connection
      ON scan_connection_snapshots(connection_id, captured_at DESC, scan_id DESC);
  `);
}

function tableExists(database: Database.Database, name: string): boolean {
  return database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}

function hasColumn(database: Database.Database, table: string, column: string): boolean {
  if (!tableExists(database, table)) return false;
  const columns = database.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (!hasColumn(database, table, column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function assign(
  assignments: string[],
  params: Record<string, unknown>,
  column: string,
  value: unknown,
): void {
  assignments.push(`${column} = @${column}`);
  params[column] = value;
}

function connectionToParams(
  connection: StoredProviderConnection,
  timestamp: string,
): Record<string, unknown> {
  return {
    id: connection.id,
    scope_id: connection.scopeId,
    name: connection.name,
    provider_kind: connection.providerKind,
    route_kind: connection.routeKind,
    transport: connection.transport,
    auth_kind: connection.authKind,
    protocol: connection.protocol,
    status: connection.status,
    credential_ref: connection.credentialRef,
    model_selection_mode: connection.modelSelectionMode,
    default_model_id: connection.defaultModelId,
    provider_label: connection.display.providerLabel,
    route_label: connection.display.routeLabel,
    secret_configured: connection.display.secretConfigured ? 1 : 0,
    endpoint_configured: connection.display.endpointConfigured ? 1 : 0,
    endpoint_kind: connection.display.endpointKind,
    last_tested_at: connection.lastTestedAt,
    last_model_sync_at: connection.lastModelSyncAt,
    model_catalog_stale: connection.modelCatalogStale ? 1 : 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function rowToStoredProviderConnection(
  row: ProviderConnectionRow,
): StoredProviderConnection {
  return {
    id: row.id,
    scopeId: row.scope_id,
    name: row.name,
    providerKind: row.provider_kind,
    routeKind: row.route_kind,
    transport: row.transport,
    authKind: row.auth_kind,
    protocol: row.protocol,
    status: row.status,
    modelSelectionMode: row.model_selection_mode,
    defaultModelId: row.default_model_id,
    lastTestedAt: row.last_tested_at,
    lastModelSyncAt: row.last_model_sync_at,
    modelCatalogStale: row.model_catalog_stale === 1,
    display: {
      providerLabel: row.provider_label,
      routeLabel: row.route_label,
      secretConfigured: row.secret_configured === 1,
      endpointConfigured: row.endpoint_configured === 1,
      endpointKind: row.endpoint_kind,
    },
    credentialRef: row.credential_ref,
  };
}

function modelToParams(model: ProviderModel): Record<string, unknown> {
  const capabilities = canonicalizeCapabilities(model.capabilities);
  const pricing = canonicalizePricing(model.pricing);
  return {
    connection_id: model.connectionId,
    model_id: model.id,
    display_name: model.displayName,
    context_window: model.contextWindow,
    capabilities_json: JSON.stringify(capabilities),
    pricing_json: pricing === null ? null : JSON.stringify(pricing),
    discovered_at: model.discoveredAt,
    source: model.source,
  };
}

function rowToProviderModel(row: ProviderModelRow): ProviderModel {
  return {
    connectionId: row.connection_id,
    id: row.model_id,
    displayName: row.display_name,
    contextWindow: row.context_window,
    capabilities: parseCapabilities(row.capabilities_json),
    pricing: parsePricing(row.pricing_json),
    discoveredAt: row.discovered_at,
    source: row.source,
  };
}

function capabilityReportToParams(report: CapabilityReport): Record<string, unknown> {
  return {
    id: report.id,
    connection_id: report.connectionId,
    model_id: report.modelId,
    protocol: report.protocol,
    status: report.status,
    capabilities_json: JSON.stringify(canonicalizeCapabilities(report.capabilities)),
    error_code: requireSafeCapabilityErrorCode(report.errorCode),
    checked_at: report.checkedAt,
  };
}

function rowToCapabilityReport(row: CapabilityReportRow): CapabilityReport {
  return {
    id: row.id,
    connectionId: row.connection_id,
    modelId: row.model_id,
    protocol: row.protocol,
    status: row.status,
    capabilities: parseCapabilities(row.capabilities_json),
    errorCode: safeCapabilityErrorCode(row.error_code),
    checkedAt: row.checked_at,
  };
}

function snapshotToParams(snapshot: ScanConnectionSnapshot): Record<string, unknown> {
  return {
    scan_id: snapshot.scanId,
    connection_id: snapshot.connectionId,
    route_kind: snapshot.routeKind,
    model_selection_mode: snapshot.modelSelectionMode,
    model_id: snapshot.modelId,
    capability_check_id: snapshot.capabilityCheckId,
    captured_at: snapshot.capturedAt,
  };
}

function codexAppServerStateToParams(
  state: CodexAppServerSafeState,
): Record<string, string | null> {
  const loginId = state.loginId === null ? null : safeCodexLoginId(state.loginId);
  const status = safeCodexStateStatus(state.status);
  const planLabel = state.planLabel === null ? null : safeCodexPlanLabel(state.planLabel);
  const syncedAt = safeTimestamp(state.syncedAt);
  return {
    login_id: loginId,
    status,
    plan_label: planLabel,
    synced_at: syncedAt,
  };
}

function safeCodexLoginId(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(value)) {
    throw new Error("Invalid safe Codex login state");
  }
  return value;
}

function safeCodexStateStatus(value: CodexAppServerSafeState["status"]): string {
  if (
    value !== "pending" && value !== "completed" && value !== "cancelled" &&
    value !== "expired" && value !== "denied" && value !== "failed" &&
    value !== "ready" && value !== "unavailable"
  ) {
    throw new Error("Invalid safe Codex login state");
  }
  return value;
}

function safeCodexPlanLabel(value: string): string {
  if (!/^[a-z0-9][a-z0-9 ._-]{0,79}$/i.test(value)) {
    throw new Error("Invalid safe Codex login state");
  }
  return value;
}

function safeTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("Invalid safe Codex login state");
  }
  return value;
}

function rowToSnapshot(row: SnapshotRow): ScanConnectionSnapshot {
  return {
    scanId: row.scan_id,
    connectionId: row.connection_id,
    routeKind: row.route_kind,
    modelSelectionMode: row.model_selection_mode,
    modelId: row.model_id,
    capabilityCheckId: row.capability_check_id,
    capturedAt: row.captured_at,
  };
}

function parseCapabilities(value: string): ModelCapabilities {
  try {
    return canonicalizeCapabilities(JSON.parse(value));
  } catch {
    // Historical malformed rows are safely downgraded rather than trusted.
  }
  return { ...unknownCapabilities };
}

function parsePricing(value: string | null): ModelPricing | null {
  if (value === null) return null;
  try {
    return canonicalizePricing(JSON.parse(value));
  } catch {
    // Historical malformed rows do not become an invented price.
  }
  return null;
}

function canonicalizeCapabilities(value: unknown): ModelCapabilities {
  const candidate = isPlainRecord(value) ? value : {};
  return {
    tools: capabilityState(candidate.tools),
    artifactOutput: capabilityState(candidate.artifactOutput),
    structuredOutput: capabilityState(candidate.structuredOutput),
    boundedExecution: capabilityState(candidate.boundedExecution),
    osIsolation: capabilityState(candidate.osIsolation),
    streaming: capabilityState(candidate.streaming),
    usage: capabilityState(candidate.usage),
    cancellation: capabilityState(candidate.cancellation),
  };
}

function capabilityState(value: unknown): ModelCapabilities[keyof ModelCapabilities] {
  return value === "supported" || value === "unsupported" || value === "unknown"
    ? value
    : "unknown";
}

function canonicalizePricing(value: unknown): ModelPricing | null {
  if (!isPlainRecord(value)) return null;
  const inputUsdPerMillionTokens = nullableUsd(value.inputUsdPerMillionTokens);
  const cachedInputUsdPerMillionTokens = nullableUsd(value.cachedInputUsdPerMillionTokens);
  const outputUsdPerMillionTokens = nullableUsd(value.outputUsdPerMillionTokens);
  if (
    inputUsdPerMillionTokens === undefined ||
    cachedInputUsdPerMillionTokens === undefined ||
    outputUsdPerMillionTokens === undefined
  ) return null;
  return {
    inputUsdPerMillionTokens,
    cachedInputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
  };
}

function nullableUsd(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function requireSafeCapabilityErrorCode(value: unknown): SafeProviderErrorCode | null {
  const errorCode = safeCapabilityErrorCode(value);
  if (value !== null && errorCode === null) {
    throw new Error("Invalid safe capability error code");
  }
  return errorCode;
}

function safeCapabilityErrorCode(value: unknown): SafeProviderErrorCode | null {
  return isSafeProviderErrorCode(value) ? value : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
