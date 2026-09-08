import { createPrivateKey, randomUUID } from "node:crypto";

import { DATA_DIR } from "../config.js";
import type { SecretRedactorRegistry } from "./credential-vault.js";
import { VaultError } from "./credential-vault.js";
import { EncryptedSecretStore } from "./encrypted-secret-store.js";
import type { NativeCredentialBackend } from "./system-credential-vault.js";

const SERVICE = "com.okamiops.sentinel.scm.github-app";
const ENCRYPTED_NAMESPACE = "scm/github-app";
const IDENTIFIER = /^[A-Za-z0-9-]{1,100}$/;

type RuntimeMode = "local" | "server";

export interface GitHubAppCredentials {
  privateKeyPem: string;
}

export interface GitHubAppCredentialStore {
  put(connectionId: string, value: GitHubAppCredentials): Promise<void>;
  get(connectionId: string): Promise<GitHubAppCredentials | null>;
  delete(connectionId: string): Promise<void>;
}

export interface SystemGitHubAppCredentialStoreDependencies {
  redactor: SecretRedactorRegistry;
  loadBackend?: () => Promise<NativeCredentialBackend>;
  platform?: NodeJS.Platform;
  runtimeMode?: RuntimeMode;
  encryptedStore?: EncryptedSecretStore;
  dataDir?: string;
  vaultKeyFile?: string;
}

/** GitHub App private-key store, isolated from model credentials. */
export class SystemGitHubAppCredentialStore implements GitHubAppCredentialStore {
  readonly #redactor: SecretRedactorRegistry;
  readonly #loadBackend: () => Promise<NativeCredentialBackend>;
  readonly #platform: NodeJS.Platform;
  readonly #runtimeMode: RuntimeMode;
  readonly #encryptedStore: EncryptedSecretStore | undefined;
  #backend: Promise<NativeCredentialBackend> | undefined;

  constructor(dependencies: SystemGitHubAppCredentialStoreDependencies) {
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

  async put(connectionId: string, value: GitHubAppCredentials): Promise<void> {
    const id = validConnectionId(connectionId);
    const credentials = validCredentials(value);
    const finalScope = scopeFor(id);
    const pendingScope = `${finalScope}:pending:${randomUUID()}`;
    try {
      this.#redactor.register(pendingScope, [credentials.privateKeyPem]);
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
      // Native rejection does not prove the write was not committed.
      if (error instanceof VaultError) {
        if (this.#runtimeMode !== "server") safeUnregister(this.#redactor, pendingScope);
        throw error;
      }
      throw new VaultError("credential_write_failed");
    }
    try {
      this.#redactor.register(finalScope, [credentials.privateKeyPem]);
    } catch {
      // Keep the pending scope active because the native secret now exists.
      throw new VaultError("credential_write_failed");
    }
    safeUnregister(this.#redactor, pendingScope);
  }

  async get(connectionId: string): Promise<GitHubAppCredentials | null> {
    const id = validConnectionId(connectionId);
    try {
      const value = this.#runtimeMode === "server"
        ? await this.#resolveEncryptedStore().get(ENCRYPTED_NAMESPACE, id)
        : await (await this.#resolveBackend()).getPassword(SERVICE, id);
      if (value === null) return null;
      const credentials = validCredentials(
        typeof value === "string" ? JSON.parse(value) : value,
      );
      this.#redactor.register(scopeFor(id), [credentials.privateKeyPem]);
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

function validCredentials(value: unknown): GitHubAppCredentials {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1 || !("privateKeyPem" in value)) {
    throw new VaultError("secure_storage_unavailable");
  }
  const privateKeyPem = value.privateKeyPem;
  if (typeof privateKeyPem !== "string" || privateKeyPem.length < 128 || privateKeyPem.length > 131_072 || privateKeyPem.includes("\0")) {
    throw new VaultError("secure_storage_unavailable");
  }
  try {
    const key = createPrivateKey(privateKeyPem);
    if (key.type !== "private" || key.asymmetricKeyType !== "rsa") {
      throw new Error("not an RSA private key");
    }
  } catch {
    throw new VaultError("secure_storage_unavailable");
  }
  return { privateKeyPem };
}

function scopeFor(connectionId: string): string {
  return `scm/github-app/${connectionId}`;
}

function asVaultError(
  error: unknown,
  fallback: "credential_write_failed" | "secure_storage_unavailable",
): VaultError {
  return error instanceof VaultError ? error : new VaultError(fallback);
}

function safeUnregister(redactor: SecretRedactorRegistry, scope: string): void {
  try {
    redactor.unregister(scope);
  } catch {
    // A still-active scope is safer than exposing a secret after cleanup failure.
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
