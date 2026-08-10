import type Database from "better-sqlite3";
import type {
  ConnectionDisplay,
  ConnectionStatus,
  ModelSelectionMode,
  ProviderConnection,
} from "@csb/shared";
import { getDb } from "./db.js";

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
  display?: ConnectionDisplay;
}

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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_connections_by_scope_updated
      ON provider_connections(scope_id, updated_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS provider_models (
      connection_id TEXT NOT NULL,
      id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      context_window INTEGER,
      capabilities_json TEXT NOT NULL,
      pricing_json TEXT,
      discovered_at TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (connection_id, id),
      FOREIGN KEY (connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS provider_models_by_connection
      ON provider_models(connection_id, discovered_at DESC, id);

    CREATE TABLE IF NOT EXISTS connection_capability_checks (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      evidence TEXT,
      error TEXT,
      checked_at TEXT NOT NULL,
      FOREIGN KEY (connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS connection_capability_checks_by_connection
      ON connection_capability_checks(connection_id, checked_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS scan_connection_snapshots (
      scan_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      provider_kind TEXT NOT NULL,
      route_kind TEXT NOT NULL,
      transport TEXT NOT NULL,
      auth_kind TEXT NOT NULL,
      protocol TEXT NOT NULL,
      model_id TEXT,
      capabilities_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scan_connection_snapshots_by_connection
      ON scan_connection_snapshots(connection_id, created_at DESC, scan_id DESC);
  `);
}

export function listConnections(
  database: Database.Database = getDb(),
): StoredProviderConnection[] {
  ensureConnectionSchema(database);
  const rows = database
    .prepare(
      `SELECT * FROM provider_connections
       WHERE scope_id = 'local'
       ORDER BY updated_at DESC, id DESC`,
    )
    .all() as ProviderConnectionRow[];
  return rows.map(rowToStoredProviderConnection);
}

export function getConnection(
  id: string,
  database: Database.Database = getDb(),
): StoredProviderConnection | null {
  ensureConnectionSchema(database);
  const row = database
    .prepare(
      `SELECT * FROM provider_connections
       WHERE id = ? AND scope_id = 'local'`,
    )
    .get(id) as ProviderConnectionRow | undefined;
  return row === undefined ? null : rowToStoredProviderConnection(row);
}

export function insertConnection(
  connection: StoredProviderConnection,
  database: Database.Database = getDb(),
): void {
  ensureConnectionSchema(database);
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO provider_connections (
        id, scope_id, name, provider_kind, route_kind, transport, auth_kind,
        protocol, status, credential_ref, model_selection_mode, default_model_id,
        provider_label, route_label, secret_configured, endpoint_configured,
        endpoint_kind, last_tested_at, last_model_sync_at, created_at, updated_at
      ) VALUES (
        @id, @scope_id, @name, @provider_kind, @route_kind, @transport, @auth_kind,
        @protocol, @status, @credential_ref, @model_selection_mode, @default_model_id,
        @provider_label, @route_label, @secret_configured, @endpoint_configured,
        @endpoint_kind, @last_tested_at, @last_model_sync_at, @created_at, @updated_at
      )`,
    )
    .run(connectionToParams(connection, now));
}

export function updateConnectionRecord(
  id: string,
  patch: ConnectionRecordPatch,
  database: Database.Database = getDb(),
): StoredProviderConnection {
  ensureConnectionSchema(database);
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
  if (patch.display !== undefined) {
    assign(assignments, params, "provider_label", patch.display.providerLabel);
    assign(assignments, params, "route_label", patch.display.routeLabel);
    assign(assignments, params, "secret_configured", patch.display.secretConfigured ? 1 : 0);
    assign(assignments, params, "endpoint_configured", patch.display.endpointConfigured ? 1 : 0);
    assign(assignments, params, "endpoint_kind", patch.display.endpointKind);
  }

  if (assignments.length > 0) {
    assignments.push("updated_at = @updated_at");
    database
      .prepare(
        `UPDATE provider_connections
         SET ${assignments.join(", ")}
         WHERE id = @id AND scope_id = 'local'`,
      )
      .run(params);
  }

  const connection = getConnection(id, database);
  if (connection === null) throw new Error("Provider connection not found");
  return connection;
}

export function deleteConnectionRecord(
  id: string,
  database: Database.Database = getDb(),
): boolean {
  ensureConnectionSchema(database);
  const remove = database.transaction((connectionId: string) =>
    database
      .prepare(
        "DELETE FROM provider_connections WHERE id = ? AND scope_id = 'local'",
      )
      .run(connectionId),
  );
  return remove(id).changes > 0;
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
