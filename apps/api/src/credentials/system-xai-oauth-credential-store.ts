import { randomUUID } from "node:crypto";

import { DATA_DIR } from "../config.js";
import type {
  XaiOAuthCredentials,
  XaiOAuthCredentialStore,
} from "../connections/xai-oauth-flow.js";
import type { SecretRedactorRegistry } from "./credential-vault.js";
import { EncryptedSecretStore } from "./encrypted-secret-store.js";
import { VaultError, type NativeCredentialBackend } from "./system-credential-vault.js";

const SERVICE = "com.okamiops.sentinel.oauth.xai";
const ENCRYPTED_NAMESPACE = "oauth/xai";
const IDENTIFIER = /^[A-Za-z0-9-]{1,100}$/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;

type RuntimeMode = "local" | "server";

export interface SystemXaiOAuthCredentialStoreDependencies {
  redactor: SecretRedactorRegistry;
  loadBackend?: () => Promise<NativeCredentialBackend>;
  platform?: NodeJS.Platform;
  runtimeMode?: RuntimeMode;
  encryptedStore?: EncryptedSecretStore;
  dataDir?: string;
  vaultKeyFile?: string;
}

/** Native-only OAuth token store. It deliberately does not share the API-key bundle schema. */
export class SystemXaiOAuthCredentialStore implements XaiOAuthCredentialStore {
  readonly #redactor: SecretRedactorRegistry;
  readonly #loadBackend: () => Promise<NativeCredentialBackend>;
  readonly #platform: NodeJS.Platform;
  readonly #runtimeMode: RuntimeMode;
  readonly #encryptedStore: EncryptedSecretStore | undefined;
  #backend: Promise<NativeCredentialBackend> | undefined;

  constructor(dependencies: SystemXaiOAuthCredentialStoreDependencies) {
    this.#redactor = dependencies.redactor;
    this.#loadBackend = dependencies.loadBackend ?? loadKeytarBackend;
    this.#platform = dependencies.platform ?? process.platform;
    this.#runtimeMode = dependencies.runtimeMode ?? configuredRuntimeMode();
    this.#encryptedStore = this.#runtimeMode === "server"
      ? dependencies.encryptedStore ?? new EncryptedSecretStore({
        dataDir: dependencies.dataDir ?? DATA_DIR,
        keyFile: dependencies.vaultKeyFile ?? process.env.CSB_VAULT_KEY_FILE?.trim() ?? "",
      })
      : undefined;
  }

  async put(connectionId: string, value: XaiOAuthCredentials): Promise<void> {
    const id = validConnectionId(connectionId);
    const credentials = validCredentials(value);
    const finalScope = scopeFor(id);
    const pendingScope = `${finalScope}:pending:${randomUUID()}`;
    const values = [credentials.accessToken, credentials.refreshToken];
    try {
      this.#redactor.register(pendingScope, values);
    } catch {
      safeUnregister(this.#redactor, pendingScope);
      throw new VaultError("credential_write_failed");
    }
    try {
      if (this.#runtimeMode === "server") {
        await this.#resolveEncryptedStore().put(ENCRYPTED_NAMESPACE, id, credentials);
      } else {
        await (await this.#resolveBackend()).setPassword(SERVICE, id, JSON.stringify(credentials));
      }
    } catch (error) {
      // A rejected native promise does not prove the backend failed before
      // committing. Preserve the pending scope so those bytes stay redacted.
      if (error instanceof VaultError) {
        if (this.#runtimeMode !== "server") safeUnregister(this.#redactor, pendingScope);
        throw error;
      }
      throw new VaultError("credential_write_failed");
    }
    try {
      this.#redactor.register(finalScope, values);
    } catch {
      // The native value exists; the pending scope must remain active.
      throw new VaultError("credential_write_failed");
    }
    safeUnregister(this.#redactor, pendingScope);
  }

  async get(connectionId: string): Promise<XaiOAuthCredentials | null> {
    const id = validConnectionId(connectionId);
    try {
      const value = this.#runtimeMode === "server"
        ? await this.#resolveEncryptedStore().get(ENCRYPTED_NAMESPACE, id)
        : await (await this.#resolveBackend()).getPassword(SERVICE, id);
      if (value === null) return null;
      const credentials = validCredentials(
        typeof value === "string" ? JSON.parse(value) : value,
      );
      this.#redactor.register(scopeFor(id), [credentials.accessToken, credentials.refreshToken]);
      return { ...credentials };
    } catch (error) {
      throw asVaultError(error, "secure_storage_unavailable");
    }
  }

  async delete(connectionId: string): Promise<void> {
    const id = validConnectionId(connectionId);
    try {
      if (this.#runtimeMode === "server") {
        await this.#resolveEncryptedStore().delete(ENCRYPTED_NAMESPACE, id);
      } else {
        await (await this.#resolveBackend()).deletePassword(SERVICE, id);
      }
      this.#redactor.unregister(scopeFor(id));
    } catch (error) {
      throw asVaultError(error, "secure_storage_unavailable");
    }
  }

  async #resolveBackend(): Promise<NativeCredentialBackend> {
    if (this.#platform !== "darwin" && this.#platform !== "linux") {
      throw new VaultError("secure_storage_unavailable");
    }
    this.#backend ??= Promise.resolve().then(this.#loadBackend);
    try {
      return await this.#backend;
    } catch {
      this.#backend = undefined;
      throw new VaultError("secure_storage_unavailable");
    }
  }

  #resolveEncryptedStore(): EncryptedSecretStore {
    if (this.#encryptedStore === undefined) throw new VaultError("secure_storage_unavailable");
    return this.#encryptedStore;
  }
}

function configuredRuntimeMode(): RuntimeMode {
  return process.env.CSB_RUNTIME_MODE?.trim() === "server" ? "server" : "local";
}

function validConnectionId(value: string): string {
  if (!IDENTIFIER.test(value)) throw new VaultError("secure_storage_unavailable");
  return value;
}

function validCredentials(value: unknown): XaiOAuthCredentials {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !["accessToken", "refreshToken", "expiresAt"].includes(key))) {
    throw new VaultError("secure_storage_unavailable");
  }
  const accessToken = secret(value.accessToken);
  const refreshToken = secret(value.refreshToken);
  const expiresAt = value.expiresAt === null
    ? null
    : typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))
      ? new Date(value.expiresAt).toISOString()
      : invalidCredentials();
  return { accessToken, refreshToken, expiresAt };
}

function secret(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384 || CONTROL_CHARACTER.test(value)) {
    return invalidCredentials();
  }
  return value;
}

function invalidCredentials(): never {
  throw new VaultError("secure_storage_unavailable");
}

function scopeFor(connectionId: string): string {
  return `oauth/xai/${connectionId}`;
}

function asVaultError(error: unknown, fallback: "credential_write_failed" | "secure_storage_unavailable"): VaultError {
  return error instanceof VaultError ? error : new VaultError(fallback);
}

function safeUnregister(redactor: SecretRedactorRegistry, scope: string): void {
  try {
    redactor.unregister(scope);
  } catch {
    // Final scopes remain active if cleanup fails; no secret is exposed.
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function loadKeytarBackend(): Promise<NativeCredentialBackend> {
  const imported = (await import("keytar")) as unknown as {
    default?: NativeCredentialBackend;
  } & NativeCredentialBackend;
  return imported.default ?? imported;
}
