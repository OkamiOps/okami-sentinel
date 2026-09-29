import { randomUUID } from "node:crypto";

import { DATA_DIR } from "../config.js";
import type { SecretRedactorRegistry } from "./credential-vault.js";
import { VaultError } from "./credential-vault.js";
import { EncryptedSecretStore } from "./encrypted-secret-store.js";
import type { NativeCredentialBackend } from "./system-credential-vault.js";

const SERVICE = "com.okamiops.sentinel.email";
const ENCRYPTED_NAMESPACE = "email";
const IDENTIFIER = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_SECRET_LENGTH = 4_096;

type RuntimeMode = "local" | "server";

/** An SMTP password or a Resend API key. Never leaves this layer. */
export interface EmailProviderSecret {
  secret: string;
}

export interface EmailCredentialStore {
  put(ref: string, value: EmailProviderSecret): Promise<void>;
  get(ref: string): Promise<EmailProviderSecret | null>;
  delete(ref: string): Promise<void>;
}

export interface SystemEmailCredentialStoreDependencies {
  redactor: SecretRedactorRegistry;
  loadBackend?: () => Promise<NativeCredentialBackend>;
  platform?: NodeJS.Platform;
  runtimeMode?: RuntimeMode;
  encryptedStore?: EncryptedSecretStore;
  dataDir?: string;
  vaultKeyFile?: string;
}

/** A fresh reference per saved secret, so a replacement never reuses a slot. */
export function newEmailSecretRef(): string {
  return `email-${randomUUID()}`;
}

/**
 * The e-mail provider secret, in its own vault namespace — the same shape as the
 * model-connection vault and the GitHub App key store, and deliberately not
 * sharing a namespace with either: an operator revoking SMTP access must not be
 * able to touch a scanner credential, and vice versa.
 */
export class SystemEmailCredentialStore implements EmailCredentialStore {
  readonly #redactor: SecretRedactorRegistry;
  readonly #loadBackend: () => Promise<NativeCredentialBackend>;
  readonly #platform: NodeJS.Platform;
  readonly #runtimeMode: RuntimeMode;
  readonly #encryptedStore: EncryptedSecretStore | undefined;
  #backend: Promise<NativeCredentialBackend> | undefined;

  constructor(dependencies: SystemEmailCredentialStoreDependencies) {
    if (!dependencies?.redactor) throw new VaultError("secure_storage_unavailable");
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

  async put(ref: string, value: EmailProviderSecret): Promise<void> {
    const id = validRef(ref);
    const credentials = validSecret(value);
    const finalScope = scopeFor(id);
    const pendingScope = `${finalScope}:pending:${randomUUID()}`;
    try {
      this.#redactor.register(pendingScope, [credentials.secret]);
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
      // A rejected native promise does not prove the write was not committed, so
      // the pending scope stays registered in that case.
      if (error instanceof VaultError) {
        if (this.#runtimeMode !== "server") safeUnregister(this.#redactor, pendingScope);
        throw error;
      }
      throw new VaultError("credential_write_failed");
    }

    try {
      this.#redactor.register(finalScope, [credentials.secret]);
    } catch {
      throw new VaultError("credential_write_failed");
    }
    safeUnregister(this.#redactor, pendingScope);
  }

  async get(ref: string): Promise<EmailProviderSecret | null> {
    const id = validRef(ref);
    try {
      const stored = this.#runtimeMode === "server"
        ? await this.#resolveEncryptedStore().get(ENCRYPTED_NAMESPACE, id)
        : await (await this.#resolveBackend()).getPassword(SERVICE, id);
      if (stored === null) return null;
      const credentials = validSecret(typeof stored === "string" ? JSON.parse(stored) : stored);
      this.#redactor.register(scopeFor(id), [credentials.secret]);
      return { ...credentials };
    } catch (error) {
      throw asVaultError(error, "secure_storage_unavailable");
    }
  }

  async delete(ref: string): Promise<void> {
    const id = validRef(ref);
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

export function createSystemEmailCredentialStore(
  dependencies: SystemEmailCredentialStoreDependencies,
): EmailCredentialStore {
  return new SystemEmailCredentialStore(dependencies);
}

function configuredRuntimeMode(): RuntimeMode {
  return process.env.CSB_RUNTIME_MODE?.trim() === "server" ? "server" : "local";
}

function validRef(value: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new VaultError("secure_storage_unavailable");
  }
  return value;
}

function validSecret(value: unknown): EmailProviderSecret {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1 || !("secret" in value)) {
    throw new VaultError("secure_storage_unavailable");
  }
  const secret = value.secret;
  if (
    typeof secret !== "string" || secret.length === 0 ||
    secret.length > MAX_SECRET_LENGTH || /[\u0000-\u001F\u007F]/.test(secret)
  ) {
    throw new VaultError("secure_storage_unavailable");
  }
  return { secret };
}

function scopeFor(ref: string): string {
  return `email/${ref}`;
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
    // A still-active scope is safer than an unredacted secret after a failure.
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
