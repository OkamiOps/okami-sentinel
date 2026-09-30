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

const WEBHOOK_SECRET_MIN_LENGTH = 16;
const WEBHOOK_SECRET_MAX_LENGTH = 256;

export interface GitHubAppCredentials {
  privateKeyPem: string;
  /** Webhook signing secret of this App connection. Same custody as the key. */
  webhookSecret?: string;
}

export interface GitHubAppCredentialStore {
  put(connectionId: string, value: GitHubAppCredentials): Promise<void>;
  get(connectionId: string): Promise<GitHubAppCredentials | null>;
  /** Merges a webhook secret into the stored bundle without losing the key. */
  putWebhookSecret(connectionId: string, secret: string): Promise<void>;
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
      this.#redactor.register(pendingScope, redactionValues(credentials));
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
      this.#redactor.register(finalScope, redactionValues(credentials));
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
      this.#redactor.register(scopeFor(id), redactionValues(credentials));
      return { ...credentials };
    } catch (error) {
      throw asVaultError(error, "secure_storage_unavailable");
    }
  }

  /**
   * Reads, merges and writes, so replacing the webhook secret never drops the
   * private key the connection needs to mint installation tokens.
   */
  async putWebhookSecret(connectionId: string, secret: string): Promise<void> {
    const id = validConnectionId(connectionId);
    const webhookSecret = validWebhookSecret(secret);
    const current = await this.get(id);
    if (current === null) throw new VaultError("credential_not_found");
    await this.put(id, { privateKeyPem: current.privateKeyPem, webhookSecret });
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

/** Accepts `{ privateKeyPem }` or `{ privateKeyPem, webhookSecret }`, nothing else. */
function validCredentials(value: unknown): GitHubAppCredentials {
  if (!isPlainRecord(value)) throw new VaultError("secure_storage_unavailable");
  const keys = Object.keys(value).sort();
  const shape = keys.length === 1
    ? keys[0] === "privateKeyPem"
    : keys.length === 2 && keys[0] === "privateKeyPem" && keys[1] === "webhookSecret";
  if (!shape) throw new VaultError("secure_storage_unavailable");
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
  // An explicitly undefined field is no secret, not an invalid one.
  if (value.webhookSecret === undefined) return { privateKeyPem };
  return { privateKeyPem, webhookSecret: validWebhookSecret(value.webhookSecret) };
}

/**
 * Callers that hold a secret of unknown provenance — the manifest conversion
 * response — ask this before writing, so an unusable value degrades to "no
 * secret configured" instead of failing the whole connection.
 */
export function isStorableWebhookSecret(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= WEBHOOK_SECRET_MIN_LENGTH &&
    value.length <= WEBHOOK_SECRET_MAX_LENGTH &&
    !value.includes("\0");
}

function validWebhookSecret(value: unknown): string {
  if (!isStorableWebhookSecret(value)) throw new VaultError("secure_storage_unavailable");
  return value;
}

/** The webhook secret is redacted exactly like the PEM it travels with. */
function redactionValues(credentials: GitHubAppCredentials): string[] {
  return credentials.webhookSecret === undefined
    ? [credentials.privateKeyPem]
    : [credentials.privateKeyPem, credentials.webhookSecret];
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
