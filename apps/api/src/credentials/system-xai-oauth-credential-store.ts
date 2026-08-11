import { randomUUID } from "node:crypto";

import type {
  XaiOAuthCredentials,
  XaiOAuthCredentialStore,
} from "../connections/xai-oauth-flow.js";
import type { SecretRedactorRegistry } from "./credential-vault.js";
import { VaultError, type NativeCredentialBackend } from "./system-credential-vault.js";

const SERVICE = "com.okamiops.sentinel.oauth.xai";
const IDENTIFIER = /^[A-Za-z0-9-]{1,100}$/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;

export interface SystemXaiOAuthCredentialStoreDependencies {
  redactor: SecretRedactorRegistry;
  loadBackend?: () => Promise<NativeCredentialBackend>;
  platform?: NodeJS.Platform;
}

/** Native-only OAuth token store. It deliberately does not share the API-key bundle schema. */
export class SystemXaiOAuthCredentialStore implements XaiOAuthCredentialStore {
  readonly #redactor: SecretRedactorRegistry;
  readonly #loadBackend: () => Promise<NativeCredentialBackend>;
  readonly #platform: NodeJS.Platform;
  #backend: Promise<NativeCredentialBackend> | undefined;

  constructor(dependencies: SystemXaiOAuthCredentialStoreDependencies) {
    this.#redactor = dependencies.redactor;
    this.#loadBackend = dependencies.loadBackend ?? loadKeytarBackend;
    this.#platform = dependencies.platform ?? process.platform;
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
    let backend: NativeCredentialBackend;
    try {
      backend = await this.#resolveBackend();
    } catch (error) {
      safeUnregister(this.#redactor, pendingScope);
      throw asVaultError(error, "secure_storage_unavailable");
    }
    try {
      await backend.setPassword(SERVICE, id, JSON.stringify(credentials));
    } catch {
      // A rejected native promise does not prove the backend failed before
      // committing. Preserve the pending scope so those bytes stay redacted.
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
    let encoded: string | null;
    try {
      encoded = await (await this.#resolveBackend()).getPassword(SERVICE, id);
    } catch (error) {
      throw asVaultError(error, "secure_storage_unavailable");
    }
    if (encoded === null) return null;
    try {
      const credentials = validCredentials(JSON.parse(encoded));
      this.#redactor.register(scopeFor(id), [credentials.accessToken, credentials.refreshToken]);
      return { ...credentials };
    } catch {
      throw new VaultError("secure_storage_unavailable");
    }
  }

  async delete(connectionId: string): Promise<void> {
    const id = validConnectionId(connectionId);
    try {
      await (await this.#resolveBackend()).deletePassword(SERVICE, id);
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
