import { randomUUID } from "node:crypto";

import type {
  ConnectionAuthKind,
  ConnectionDisplay,
  ConnectionStatus,
  ConnectionTransport,
  CreateProviderConnectionRequest,
  ModelSelectionMode,
  CapabilityReport,
  ProviderConnection,
  ProviderModel,
  ProviderProtocol,
  SafeProviderErrorCode,
  ScanConnectionSelection,
  UpdateProviderConnectionRequest,
} from "@csb/shared";
import {
  deleteConnectionRecord,
  ConnectionStore,
  getConnection,
  insertConnection,
  listConnections,
  type ConnectionRecordPatch,
  type StoredProviderConnection,
  updateConnectionRecord,
} from "./connections-store.js";
import type { RouteAdapter, RouteInspection, DiscoveryResult } from "./connections/route-adapter.js";
import {
  createRouteRegistry,
  type RouteManifest,
} from "./connections/route-registry.js";
import {
  connectionSecretValues,
  type ConnectionSecretBundle,
  type CredentialVault,
  validateConnectionSecretBundle,
  VaultError,
} from "./credentials/credential-vault.js";

const TRANSPORTS = new Set<ConnectionTransport>([
  "local-cli",
  "codex-app-server",
  "http-inference",
  "remote-agent-api",
]);
const AUTH_KINDS = new Set<ConnectionAuthKind>([
  "existing-session",
  "browser-oauth",
  "device-code",
  "api-key",
  "custom-headers",
]);
const PROTOCOLS = new Set<ProviderProtocol>([
  "codex-cli",
  "codex-app-server",
  "claude-code-cli",
  "cursor-agent-cli",
  "grok-build-cli",
  "xai-oauth-responses",
  "openai-responses",
  "openai-chat",
  "anthropic-messages",
  "cursor-background-agents",
]);
const MODEL_SELECTIONS = new Set<ModelSelectionMode>([
  "catalog",
  "runtime-default",
]);
const LOCAL_CLI_PROTOCOLS = new Set<ProviderProtocol>([
  "codex-cli",
  "claude-code-cli",
  "cursor-agent-cli",
  "grok-build-cli",
]);
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const URL_OR_HOSTNAME = /(?:https?:\/\/|(?:^|\s)(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#\s]|$))/i;
const CREDENTIAL_SHAPED = /(?:authorization\s*[:=]|\b(?:bearer|basic)\s+\S+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]|[?&](?:api[_-]?key|token|password|secret)=|\bsk-[a-z0-9_-]{4,}|\bxai-(?!grok-build-local\b)[a-z0-9_-]{4,})/i;
const CREATE_KEYS = new Set([
  "name",
  "providerKind",
  "routeKind",
  "transport",
  "authKind",
  "protocol",
  "modelSelectionMode",
  "secret",
]);

export type ConnectionErrorCode =
  | "invalid_connection"
  | "invalid_model_selection"
  | "model_not_found"
  | "model_catalog_stale"
  | "model_discovery_unsupported"
  | "connection_not_found"
  | "connection_write_failed"
  | "connection_state_inconsistent"
  | "secure_storage_unavailable"
  | SafeProviderErrorCode;

export class ConnectionServiceError extends Error {
  constructor(readonly code: ConnectionErrorCode) {
    super(code);
    this.name = "ConnectionServiceError";
  }
}

export interface ConnectionsStore {
  list(): StoredProviderConnection[];
  get(id: string): StoredProviderConnection | null;
  insert(connection: StoredProviderConnection): void;
  update(id: string, patch: ConnectionRecordPatch): StoredProviderConnection;
  delete(id: string): boolean;
}

/** The model/probe persistence boundary consumed only after an adapter returns safe facts. */
export interface ConnectionCatalogStore {
  getModels(connectionId: string): ProviderModel[];
  getModel(connectionId: string, modelId: string): ProviderModel | null;
  replaceModels(connectionId: string, models: readonly ProviderModel[]): void;
  markModelCatalogStale(connectionId: string): void;
  writeCapabilityCheck(report: CapabilityReport): void;
}

export interface ConnectionRouteRegistry {
  get(routeKind: string): RouteAdapter | undefined;
  getManifest(routeKind: string): RouteManifest | undefined;
}

export interface ConnectionInspectionResult {
  connection: ProviderConnection;
  inspection: RouteInspection;
}

export interface ConnectionModelRefreshResult {
  connection: ProviderConnection;
  discovery: DiscoveryResult;
}

export interface ConnectionProbeResult {
  connection: ProviderConnection;
  report: CapabilityReport;
}

export interface ConnectionsService {
  list(): ProviderConnection[];
  get(id: string): ProviderConnection | null;
  create(input: CreateProviderConnectionRequest): Promise<ProviderConnection>;
  update(
    id: string,
    input: UpdateProviderConnectionRequest,
  ): Promise<ProviderConnection | null>;
  remove(id: string): Promise<boolean>;
  inspect(id: string): Promise<ConnectionInspectionResult | null>;
  listModels(id: string): ProviderModel[] | null;
  refreshModels(id: string): Promise<ConnectionModelRefreshResult | null>;
  probe(
    id: string,
    selection: ScanConnectionSelection,
  ): Promise<ConnectionProbeResult | null>;
}

export interface ConnectionsServiceDependencies {
  vault: CredentialVault;
  store?: ConnectionsStore;
  catalog?: ConnectionCatalogStore;
  routes?: ConnectionRouteRegistry;
  recovery?: ConnectionRecoverySink;
}

/** Facts obtained server-side from the selected route adapter and model store. */
export interface ScanConnectionSelectionFacts {
  routeKind?: string;
  transport: ConnectionTransport;
  supportsRuntimeDefault: boolean;
  model?: ProviderModel | null;
  modelCatalogStale?: boolean;
  modelDiscoverySupported?: boolean;
}

export function validateScanConnectionSelection(
  selection: ScanConnectionSelection,
  facts: ScanConnectionSelectionFacts,
): void {
  if (!isPlainDataRecord(selection) || !isPlainDataRecord(facts)) {
    throw new ConnectionServiceError("invalid_model_selection");
  }
  if (
    typeof selection.connectionId !== "string" ||
    selection.connectionId.length === 0 ||
    (selection.modelSelectionMode !== "catalog" && selection.modelSelectionMode !== "runtime-default")
  ) throw new ConnectionServiceError("invalid_model_selection");

  if (selection.modelSelectionMode === "runtime-default") {
    if (
      selection.modelId !== null ||
      facts.transport === "http-inference" ||
      facts.routeKind !== "claude-code-local" ||
      facts.supportsRuntimeDefault !== true
    ) throw new ConnectionServiceError("invalid_model_selection");
    return;
  }

  if (typeof selection.modelId !== "string" || selection.modelId.length === 0) {
    throw new ConnectionServiceError("invalid_model_selection");
  }
  if (facts.modelDiscoverySupported === false) {
    throw new ConnectionServiceError("model_discovery_unsupported");
  }
  if (facts.modelCatalogStale === true) {
    throw new ConnectionServiceError("model_catalog_stale");
  }
  if (
    facts.model === null ||
    facts.model === undefined ||
    facts.model.connectionId !== selection.connectionId ||
    facts.model.id !== selection.modelId
  ) throw new ConnectionServiceError("model_not_found");
}

export type ConnectionInconsistencyOperation =
  | "create-rollback"
  | "update-rollback"
  | "delete-rollback";

export interface ConnectionInconsistencyRecord {
  connectionId: string;
  credentialRef: string;
  operation: ConnectionInconsistencyOperation;
  recordedAt: string;
}

export interface ConnectionRecoverySink {
  record(record: ConnectionInconsistencyRecord): void;
}

const processRecoveryRecords: ConnectionInconsistencyRecord[] = [];
const processRecoverySink: ConnectionRecoverySink = {
  record(record) {
    processRecoveryRecords.push(Object.freeze({ ...record }));
  },
};

export function listConnectionRecoveryRecords(): readonly ConnectionInconsistencyRecord[] {
  return processRecoveryRecords.map((record) => ({ ...record }));
}

export function createConnectionsService(
  deps: ConnectionsServiceDependencies,
): ConnectionsService {
  const store = deps.store ?? sqliteConnectionsStore;
  const catalog = deps.catalog ?? new ConnectionStore();
  const routes = deps.routes ?? createRouteRegistry();
  const recovery = deps.recovery ?? processRecoverySink;

  return {
    list: () => store.list().map(toPublicConnection),
    get: (id) => {
      const connection = store.get(id);
      return connection === null ? null : toPublicConnection(connection);
    },
    async create(input) {
      const validated = validateCreateInput(input);
      registeredAdapterFor(validated, routes, "invalid_connection");
      const id = randomUUID();
      const credentialRef = validated.secret === undefined ? null : `connection/${id}`;
      const stored = makeStoredConnection(id, credentialRef, validated);

      if (credentialRef !== null) {
        try {
          await deps.vault.put(credentialRef, validated.secret!);
        } catch (error) {
          throw normalizeVaultError(error);
        }
      }

      try {
        store.insert(stored);
      } catch {
        if (
          credentialRef !== null &&
          !await discardNewCredential(deps.vault, credentialRef)
        ) {
          throw inconsistentState(recovery, id, credentialRef, "create-rollback");
        }
        throw new ConnectionServiceError("connection_write_failed");
      }

      return toPublicConnection(stored);
    },
    async update(id, input) {
      const current = store.get(id);
      if (current === null) return null;
      const patch = validateUpdateInput(input);
      registeredAdapterFor(current, routes, "invalid_connection");

      if (patch.secret !== undefined) {
        rejectSecretBearingLabels(
          [patch.name ?? current.name, current.providerKind, current.routeKind],
          patch.secret,
        );
        validateCombination({
          transport: current.transport,
          authKind: current.authKind,
          protocol: current.protocol,
          secret: patch.secret,
        });
      }

      if (patch.secret === undefined) {
        if (patch.name !== undefined && current.credentialRef !== null) {
          const currentBundle = await readOptionalBundle(
            deps.vault,
            current.credentialRef,
          );
          if (currentBundle !== undefined) {
            rejectSecretBearingLabels([patch.name], currentBundle);
          }
        }
        try {
          return toPublicConnection(store.update(id, { name: patch.name }));
        } catch {
          throw new ConnectionServiceError("connection_write_failed");
        }
      }

      const credentialRef = current.credentialRef ?? `connection/${current.id}`;
      const previousBundle = current.credentialRef === null
        ? undefined
        : await readOptionalBundle(deps.vault, current.credentialRef);
      try {
        await deps.vault.put(credentialRef, patch.secret);
      } catch (error) {
        throw normalizeVaultError(error);
      }

      const recordPatch: ConnectionRecordPatch = {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        credentialRef,
        display: displayFor(current, patch.secret),
      };
      try {
        return toPublicConnection(store.update(id, recordPatch));
      } catch {
        if (!await restoreCredential(deps.vault, credentialRef, previousBundle)) {
          throw inconsistentState(recovery, id, credentialRef, "update-rollback");
        }
        throw new ConnectionServiceError("connection_write_failed");
      }
    },
    async remove(id) {
      const current = store.get(id);
      if (current === null) return false;

      let removedBundle: ConnectionSecretBundle | undefined;
      if (current.credentialRef !== null) {
        removedBundle = await readOptionalBundle(deps.vault, current.credentialRef);
        try {
          await deps.vault.delete(current.credentialRef);
        } catch (error) {
          throw normalizeVaultError(error);
        }
      }

      try {
        const deleted = store.delete(id);
        if (
          !deleted &&
          current.credentialRef !== null &&
          removedBundle !== undefined &&
          !await restoreCredential(deps.vault, current.credentialRef, removedBundle)
        ) {
          throw inconsistentState(
            recovery,
            id,
            current.credentialRef,
            "delete-rollback",
          );
        }
        return deleted;
      } catch (error) {
        if (error instanceof ConnectionServiceError) throw error;
        if (
          current.credentialRef !== null &&
          removedBundle !== undefined &&
          !await restoreCredential(deps.vault, current.credentialRef, removedBundle)
        ) {
          throw inconsistentState(
            recovery,
            id,
            current.credentialRef,
            "delete-rollback",
          );
        }
        throw new ConnectionServiceError("connection_write_failed");
      }
    },
    async inspect(id) {
      const connection = store.get(id);
      if (connection === null) return null;
      const adapter = adapterFor(connection, routes);
      const inspection = await adapter.inspect(connection);
      const updated = updateRuntimeStatus(store, connection, inspection);
      return { connection: toPublicConnection(updated), inspection };
    },
    listModels(id) {
      const connection = store.get(id);
      if (connection === null) return null;
      adapterFor(connection, routes);
      return catalog.getModels(id);
    },
    async refreshModels(id) {
      const connection = store.get(id);
      if (connection === null) return null;
      const adapter = adapterFor(connection, routes);
      const discovered = await adapter.discoverModels(connection);
      const discovery = validDiscovery(connection, discovered);
      if (discovery.safeError !== undefined) {
        catalog.markModelCatalogStale(connection.id);
        const updated = store.update(connection.id, { status: "degraded" });
        return { connection: toPublicConnection(updated), discovery };
      }
      catalog.replaceModels(connection.id, discovery.models);
      const updated = store.update(connection.id, { status: "ready" });
      return { connection: toPublicConnection(updated), discovery };
    },
    async probe(id, selection) {
      const connection = store.get(id);
      if (connection === null) return null;
      const adapter = adapterFor(connection, routes);
      const inspection = await adapter.inspect(connection);
      validateScanConnectionSelection(selection, {
        routeKind: connection.routeKind,
        transport: connection.transport,
        supportsRuntimeDefault: inspection.supportsRuntimeDefault,
        model: selection.modelId === null ? null : catalog.getModel(connection.id, selection.modelId),
        modelCatalogStale: connection.modelCatalogStale,
      });
      const report = await adapter.probe(connection, selection);
      catalog.writeCapabilityCheck(report);
      const updated = store.update(connection.id, {
        status: report.status === "passed" ? "ready" : "degraded",
        lastTestedAt: report.checkedAt,
      });
      return { connection: toPublicConnection(updated), report };
    },
  };
}

const sqliteConnectionsStore: ConnectionsStore = {
  list: listConnections,
  get: getConnection,
  insert: insertConnection,
  update: updateConnectionRecord,
  delete: deleteConnectionRecord,
};

function adapterFor(
  connection: StoredProviderConnection,
  routes: ConnectionRouteRegistry,
): RouteAdapter {
  return registeredAdapterFor(connection, routes, "protocol_unsupported");
}

function registeredAdapterFor(
  connection: Pick<StoredProviderConnection, "providerKind" | "routeKind" | "transport" | "authKind" | "protocol">,
  routes: ConnectionRouteRegistry,
  errorCode: "invalid_connection" | "protocol_unsupported",
): RouteAdapter {
  const manifest = routes.getManifest(connection.routeKind);
  const adapter = routes.get(connection.routeKind);
  if (
    manifest === undefined ||
    adapter === undefined ||
    manifest.providerKind !== connection.providerKind ||
    manifest.transport !== connection.transport ||
    manifest.protocol !== connection.protocol ||
    !manifest.authKinds.includes(connection.authKind) ||
    adapter.transport !== connection.transport ||
    adapter.protocol !== connection.protocol
  ) throw new ConnectionServiceError(errorCode);
  return adapter;
}

function validDiscovery(
  connection: StoredProviderConnection,
  discovery: DiscoveryResult,
): DiscoveryResult {
  if (discovery.models.some((model) => model.connectionId !== connection.id)) {
    return {
      models: [],
      supportsRuntimeDefault: false,
      safeError: { code: "protocol_unsupported" },
    };
  }
  return discovery;
}

function updateRuntimeStatus(
  store: ConnectionsStore,
  connection: StoredProviderConnection,
  inspection: RouteInspection,
): StoredProviderConnection {
  const status: ConnectionStatus = inspection.available
    ? "ready"
    : inspection.reason === "credential_expired"
      ? "expired"
      : inspection.reason === "credential_rejected"
        ? "authentication-required"
        : "unavailable";
  return store.update(connection.id, {
    status,
    lastTestedAt: new Date().toISOString(),
  });
}

function validateCreateInput(input: CreateProviderConnectionRequest): ValidatedCreateInput {
  if (!isPlainDataRecord(input)) invalidConnection();
  const keys = Object.getOwnPropertyNames(input);
  if (keys.some((key) => !CREATE_KEYS.has(key))) invalidConnection();
  const name = connectionName(input.name);
  const providerKind = connectionIdentifier(input.providerKind);
  const routeKind = connectionIdentifier(input.routeKind);
  const transport = enumValue(input.transport, TRANSPORTS);
  const authKind = enumValue(input.authKind, AUTH_KINDS);
  const protocol = enumValue(input.protocol, PROTOCOLS);
  const modelSelectionMode = enumValue(input.modelSelectionMode, MODEL_SELECTIONS);
  const secret = input.secret === undefined
    ? undefined
    : validateSecret(input.secret);

  if (secret !== undefined) {
    rejectSecretBearingLabels([name, providerKind, routeKind], secret);
  }

  validateCombination({ transport, authKind, protocol, secret });
  return {
    name,
    providerKind,
    routeKind,
    transport,
    authKind,
    protocol,
    modelSelectionMode,
    secret,
  };
}

function validateUpdateInput(input: UpdateProviderConnectionRequest): {
  name: string | undefined;
  secret: ConnectionSecretBundle | undefined;
} {
  if (!isPlainDataRecord(input)) invalidConnection();
  const allowed = new Set(["name", "secret"]);
  if (
    Object.getOwnPropertyNames(input).length === 0 ||
    Object.getOwnPropertyNames(input).some((key) => !allowed.has(key))
  ) invalidConnection();

  const name = input.name === undefined ? undefined : connectionName(input.name);
  const secret = input.secret === undefined ? undefined : validateSecret(input.secret);
  if (name === undefined && secret === undefined) invalidConnection();
  return { name, secret };
}

function validateCombination(input: {
  transport: ConnectionTransport;
  authKind: ConnectionAuthKind;
  protocol: ProviderProtocol;
  secret: ConnectionSecretBundle | undefined;
}): void {
  if (input.transport === "http-inference" && input.secret === undefined) {
    invalidConnection();
  }
  if (
    input.authKind === "existing-session" &&
    input.transport !== "local-cli" &&
    input.transport !== "codex-app-server"
  ) {
    invalidConnection();
  }
  if (input.transport === "codex-app-server" && input.secret !== undefined) {
    invalidConnection();
  }
  if (
    input.transport === "local-cli" &&
    !LOCAL_CLI_PROTOCOLS.has(input.protocol)
  ) {
    invalidConnection();
  }
  if (
    input.transport === "local-cli" &&
    input.authKind === "existing-session" &&
    input.secret !== undefined
  ) {
    invalidConnection();
  }
}

function makeStoredConnection(
  id: string,
  credentialRef: string | null,
  input: ValidatedCreateInput,
): StoredProviderConnection {
  const display = displayFor(input, input.secret);
  return {
    id,
    scopeId: "local",
    name: input.name,
    providerKind: input.providerKind,
    routeKind: input.routeKind,
    transport: input.transport,
    authKind: input.authKind,
    protocol: input.protocol,
    status: initialStatus(input.secret),
    modelSelectionMode: input.modelSelectionMode,
    defaultModelId: null,
    lastTestedAt: null,
    lastModelSyncAt: null,
    modelCatalogStale: false,
    display,
    credentialRef,
  };
}

function displayFor(
  connection: Pick<ProviderConnection, "providerKind" | "routeKind" | "display"> | Pick<ValidatedCreateInput, "providerKind" | "routeKind">,
  secret: ConnectionSecretBundle | undefined,
): ConnectionDisplay {
  const endpointConfigured = secret?.baseUrl !== undefined || secret?.discoveryUrl !== undefined;
  return {
    providerLabel: "display" in connection ? connection.display.providerLabel : connection.providerKind,
    routeLabel: "display" in connection ? connection.display.routeLabel : connection.routeKind,
    secretConfigured: secret !== undefined,
    endpointConfigured,
    endpointKind: endpointConfigured ? "custom" : null,
  };
}

function initialStatus(secret: ConnectionSecretBundle | undefined): ConnectionStatus {
  return secret === undefined ? "authentication-required" : "draft";
}

function toPublicConnection(connection: StoredProviderConnection): ProviderConnection {
  const { credentialRef: _credentialRef, ...publicConnection } = connection;
  return publicConnection;
}

function requiredText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 160 ||
    CONTROL_CHARACTER.test(value)
  ) invalidConnection();
  return value.trim();
}

function connectionName(value: unknown): string {
  const name = requiredText(value);
  if (URL_OR_HOSTNAME.test(name) || CREDENTIAL_SHAPED.test(name)) {
    invalidConnection();
  }
  return name;
}

function connectionIdentifier(value: unknown): string {
  const identifier = requiredText(value);
  if (!IDENTIFIER.test(identifier) || CREDENTIAL_SHAPED.test(identifier)) {
    invalidConnection();
  }
  return identifier;
}

function rejectSecretBearingLabels(
  labels: readonly string[],
  secret: ConnectionSecretBundle,
): void {
  const normalizedLabels = labels.map((label) =>
    label.normalize("NFKC").toLocaleLowerCase("en-US"),
  );
  for (const value of connectionSecretValues(secret)) {
    const normalizedSecret = value.normalize("NFKC").toLocaleLowerCase("en-US");
    if (normalizedSecret.length < 4) continue;
    if (normalizedLabels.some((label) => label.includes(normalizedSecret))) {
      invalidConnection();
    }
  }
}

function enumValue<T extends string>(value: unknown, values: Set<T>): T {
  if (typeof value !== "string" || !values.has(value as T)) invalidConnection();
  return value as T;
}

function validateSecret(value: unknown): ConnectionSecretBundle {
  try {
    return validateConnectionSecretBundle(value);
  } catch {
    invalidConnection();
  }
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor,
  );
}

function invalidConnection(): never {
  throw new ConnectionServiceError("invalid_connection");
}

async function readOptionalBundle(
  vault: CredentialVault,
  credentialRef: string,
): Promise<ConnectionSecretBundle | undefined> {
  try {
    return await vault.get(credentialRef);
  } catch (error) {
    if (error instanceof VaultError && error.code === "credential_not_found") {
      return undefined;
    }
    throw normalizeVaultError(error);
  }
}

async function discardNewCredential(
  vault: CredentialVault,
  credentialRef: string,
): Promise<boolean> {
  try {
    await vault.delete(credentialRef);
    return true;
  } catch {
    return false;
  }
}

async function restoreCredential(
  vault: CredentialVault,
  credentialRef: string,
  previous: ConnectionSecretBundle | undefined,
): Promise<boolean> {
  try {
    if (previous === undefined) await vault.delete(credentialRef);
    else await vault.put(credentialRef, previous);
    return true;
  } catch {
    return false;
  }
}

function inconsistentState(
  recovery: ConnectionRecoverySink,
  connectionId: string,
  credentialRef: string,
  operation: ConnectionInconsistencyOperation,
): ConnectionServiceError {
  try {
    recovery.record({
      connectionId,
      credentialRef,
      operation,
      recordedAt: new Date().toISOString(),
    });
  } catch {
    // The explicit inconsistency error remains authoritative if recording fails.
  }
  return new ConnectionServiceError("connection_state_inconsistent");
}

function normalizeVaultError(error: unknown): ConnectionServiceError {
  if (error instanceof ConnectionServiceError) return error;
  return new ConnectionServiceError("secure_storage_unavailable");
}

interface ValidatedCreateInput {
  name: string;
  providerKind: string;
  routeKind: string;
  transport: ConnectionTransport;
  authKind: ConnectionAuthKind;
  protocol: ProviderProtocol;
  modelSelectionMode: ModelSelectionMode;
  secret: ConnectionSecretBundle | undefined;
}
