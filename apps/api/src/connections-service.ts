import { randomUUID } from "node:crypto";

import type {
  ConnectionAuthKind,
  ConnectionDisplay,
  ConnectionStatus,
  ConnectionTransport,
  CreateProviderConnectionRequest,
  ModelSelectionMode,
  ProviderConnection,
  ProviderProtocol,
  UpdateProviderConnectionRequest,
} from "@csb/shared";
import {
  deleteConnectionRecord,
  getConnection,
  insertConnection,
  listConnections,
  type ConnectionRecordPatch,
  type StoredProviderConnection,
  updateConnectionRecord,
} from "./connections-store.js";
import {
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

export type ConnectionErrorCode =
  | "invalid_connection"
  | "connection_not_found"
  | "connection_write_failed"
  | "secure_storage_unavailable";

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

export interface ConnectionsService {
  list(): ProviderConnection[];
  get(id: string): ProviderConnection | null;
  create(input: CreateProviderConnectionRequest): Promise<ProviderConnection>;
  update(
    id: string,
    input: UpdateProviderConnectionRequest,
  ): Promise<ProviderConnection | null>;
  remove(id: string): Promise<boolean>;
}

export interface ConnectionsServiceDependencies {
  vault: CredentialVault;
  store?: ConnectionsStore;
}

export function createConnectionsService(
  deps: ConnectionsServiceDependencies,
): ConnectionsService {
  const store = deps.store ?? sqliteConnectionsStore;

  return {
    list: () => store.list().map(toPublicConnection),
    get: (id) => {
      const connection = store.get(id);
      return connection === null ? null : toPublicConnection(connection);
    },
    async create(input) {
      const validated = validateCreateInput(input);
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
        if (credentialRef !== null) await discardNewCredential(deps.vault, credentialRef);
        throw new ConnectionServiceError("connection_write_failed");
      }

      return toPublicConnection(stored);
    },
    async update(id, input) {
      const current = store.get(id);
      if (current === null) return null;
      const patch = validateUpdateInput(input);

      if (patch.secret === undefined) {
        try {
          return toPublicConnection(store.update(id, { name: patch.name }));
        } catch {
          throw new ConnectionServiceError("connection_write_failed");
        }
      }

      const credentialRef = current.credentialRef ?? `connection/${current.id}`;
      const previousBundle = current.credentialRef === null
        ? undefined
        : await readPreviousBundle(deps.vault, current.credentialRef);
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
        await restoreCredential(deps.vault, credentialRef, previousBundle);
        throw new ConnectionServiceError("connection_write_failed");
      }
    },
    async remove(id) {
      const current = store.get(id);
      if (current === null) return false;

      let removedBundle: ConnectionSecretBundle | undefined;
      if (current.credentialRef !== null) {
        removedBundle = await readPreviousBundle(deps.vault, current.credentialRef);
        try {
          await deps.vault.delete(current.credentialRef);
        } catch (error) {
          throw normalizeVaultError(error);
        }
      }

      try {
        const deleted = store.delete(id);
        if (!deleted && current.credentialRef !== null) {
          await restoreCredential(deps.vault, current.credentialRef, removedBundle);
        }
        return deleted;
      } catch {
        if (current.credentialRef !== null) {
          await restoreCredential(deps.vault, current.credentialRef, removedBundle);
        }
        throw new ConnectionServiceError("connection_write_failed");
      }
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

function validateCreateInput(input: CreateProviderConnectionRequest): ValidatedCreateInput {
  if (!isRecord(input)) invalidConnection();
  const name = requiredText(input.name);
  const providerKind = requiredText(input.providerKind);
  const routeKind = requiredText(input.routeKind);
  const transport = enumValue(input.transport, TRANSPORTS);
  const authKind = enumValue(input.authKind, AUTH_KINDS);
  const protocol = enumValue(input.protocol, PROTOCOLS);
  const modelSelectionMode = enumValue(input.modelSelectionMode, MODEL_SELECTIONS);
  const secret = input.secret === undefined
    ? undefined
    : validateSecret(input.secret);

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
  if (!isRecord(input)) invalidConnection();
  const allowed = new Set(["name", "secret"]);
  if (
    Object.keys(input).length === 0 ||
    Object.keys(input).some((key) => !allowed.has(key))
  ) invalidConnection();

  const name = input.name === undefined ? undefined : requiredText(input.name);
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
  if (input.authKind === "existing-session" && input.transport !== "local-cli") {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConnection(): never {
  throw new ConnectionServiceError("invalid_connection");
}

async function readPreviousBundle(
  vault: CredentialVault,
  credentialRef: string,
): Promise<ConnectionSecretBundle> {
  try {
    return await vault.get(credentialRef);
  } catch (error) {
    throw normalizeVaultError(error);
  }
}

async function discardNewCredential(vault: CredentialVault, credentialRef: string): Promise<void> {
  try {
    await vault.delete(credentialRef);
  } catch {
    // Do not replace the original persistence error or disclose a vault failure.
  }
}

async function restoreCredential(
  vault: CredentialVault,
  credentialRef: string,
  previous: ConnectionSecretBundle | undefined,
): Promise<void> {
  try {
    if (previous === undefined) await vault.delete(credentialRef);
    else await vault.put(credentialRef, previous);
  } catch {
    // The caller already returns a normalized metadata failure. Never expose bundles.
  }
}

function normalizeVaultError(error: unknown): ConnectionServiceError {
  if (error instanceof ConnectionServiceError) return error;
  if (error instanceof VaultError && error.code === "credential_not_found") {
    return new ConnectionServiceError("connection_not_found");
  }
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
