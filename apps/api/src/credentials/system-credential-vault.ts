import { randomUUID } from "node:crypto";

import { DATA_DIR } from "../config.js";
import {
  connectionSecretValues,
  type ConnectionSecretBundle,
  type CredentialVault,
  type SecretRedactorRegistry,
  validateConnectionSecretBundle,
  VaultError,
} from "./credential-vault.js";
import { EncryptedSecretStore } from "./encrypted-secret-store.js";

export { VaultError } from "./credential-vault.js";

const SERVICE = "com.okamiops.sentinel.connections";
const AVAILABILITY_PROBE_VALUE = "okami-sentinel-vault-probe";
const ENCRYPTED_NAMESPACE = "connections";

type RuntimeMode = "local" | "server";
type VaultBackend = "keychain" | "secret-service" | "encrypted-file" | "unsupported";

export interface NativeCredentialBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export interface SystemCredentialVaultDependencies {
  redactor: SecretRedactorRegistry;
  loadBackend?: () => Promise<NativeCredentialBackend>;
  /** Testable composition hook. Production selection comes from CSB_RUNTIME_MODE. */
  runtimeMode?: RuntimeMode;
  encryptedStore?: EncryptedSecretStore;
  dataDir?: string;
  vaultKeyFile?: string;
}

export class SystemCredentialVault implements CredentialVault {
  private readonly redactor: SecretRedactorRegistry;
  private readonly loadBackend: () => Promise<NativeCredentialBackend>;
  private readonly mode: RuntimeMode;
  private readonly encryptedStore: EncryptedSecretStore | undefined;
  private backendPromise: Promise<NativeCredentialBackend> | undefined;

  constructor(deps: SystemCredentialVaultDependencies) {
    if (!deps?.redactor) throw new VaultError("secure_storage_unavailable");
    this.redactor = deps.redactor;
    this.loadBackend = deps.loadBackend ?? loadKeytarBackend;
    this.mode = deps.runtimeMode ?? configuredRuntimeMode();
    this.encryptedStore = this.mode === "server"
      ? deps.encryptedStore ?? new EncryptedSecretStore({
        dataDir: deps.dataDir ?? DATA_DIR,
        keyFile: deps.vaultKeyFile ?? process.env.CSB_VAULT_KEY_FILE?.trim() ?? "",
      })
      : undefined;
  }

  async available() {
    if (this.mode === "server") {
      return {
        available: await this.resolveEncryptedStore().available(),
        backend: "encrypted-file" as const,
      };
    }
    const backendName = nativeBackend();
    if (backendName === "unsupported") {
      return { available: false, backend: backendName };
    }

    const probeAccount = randomUUID();
    let backend: NativeCredentialBackend | undefined;
    let available = false;

    try {
      backend = await this.resolveBackend();
      await backend.setPassword(
        SERVICE,
        probeAccount,
        AVAILABILITY_PROBE_VALUE,
      );
      available =
        (await backend.getPassword(SERVICE, probeAccount)) ===
        AVAILABILITY_PROBE_VALUE;
    } catch {
      available = false;
    } finally {
      if (backend) {
        try {
          const deleted = await backend.deletePassword(SERVICE, probeAccount);
          if (!deleted) available = false;
        } catch {
          available = false;
        }
      }
    }

    return { available, backend: backendName };
  }

  async put(ref: string, value: ConnectionSecretBundle): Promise<void> {
    if (this.mode !== "server") this.assertSupported();
    const bundle = validateConnectionSecretBundle(value);
    const values = connectionSecretValues(bundle);
    const pendingScope = `${ref}:pending:${randomUUID()}`;

    try {
      this.redactor.register(pendingScope, values);
    } catch {
      this.safeUnregister(pendingScope);
      throw new VaultError("credential_write_failed");
    }

    try {
      if (this.mode === "server") {
        await this.resolveEncryptedStore().put(ENCRYPTED_NAMESPACE, ref, bundle);
      } else {
        this.assertSupported();
        const backend = await this.resolveBackend();
        await backend.setPassword(SERVICE, ref, JSON.stringify(bundle));
      }
    } catch (error) {
      // Keep the pending scope registered: a rejected native promise does not
      // prove that the backend failed before committing the replacement.
      if (error instanceof VaultError) {
        if (this.mode !== "server") this.safeUnregister(pendingScope);
        throw error;
      }
      throw new VaultError("credential_write_failed");
    }

    try {
      this.redactor.register(ref, values);
    } catch {
      // The pending scope remains active, so the committed value stays redacted.
      throw new VaultError("credential_write_failed");
    }

    try {
      this.redactor.unregister(pendingScope);
    } catch {
      // The final scope is already active; never expose the registry error.
      throw new VaultError("credential_write_failed");
    }
  }

  async get(ref: string): Promise<ConnectionSecretBundle> {
    let bundle: ConnectionSecretBundle;
    try {
      if (this.mode === "server") {
        const stored = await this.resolveEncryptedStore().get(ENCRYPTED_NAMESPACE, ref);
        if (stored === null) throw new VaultError("credential_not_found");
        bundle = validateConnectionSecretBundle(stored);
      } else {
        this.assertSupported();
        const backend = await this.resolveBackend();
        const encoded = await backend.getPassword(SERVICE, ref);
        if (encoded === null) throw new VaultError("credential_not_found");
        bundle = validateConnectionSecretBundle(JSON.parse(encoded));
      }
      this.redactor.register(ref, connectionSecretValues(bundle));
    } catch (error) {
      if (error instanceof VaultError && error.code === "credential_not_found") throw error;
      throw new VaultError("secure_storage_unavailable");
    }
    return bundle;
  }

  async delete(ref: string): Promise<void> {
    try {
      if (this.mode === "server") {
        await this.resolveEncryptedStore().delete(ENCRYPTED_NAMESPACE, ref);
      } else {
        this.assertSupported();
        await (await this.resolveBackend()).deletePassword(SERVICE, ref);
      }
    } catch {
      throw new VaultError("secure_storage_unavailable");
    }

    try {
      this.redactor.unregister(ref);
    } catch {
      throw new VaultError("secure_storage_unavailable");
    }
  }

  private assertSupported(): void {
    if (nativeBackend() === "unsupported") {
      throw new VaultError("secure_storage_unavailable");
    }
  }

  private async resolveBackend(): Promise<NativeCredentialBackend> {
    this.assertSupported();
    this.backendPromise ??= Promise.resolve().then(this.loadBackend);

    try {
      return await this.backendPromise;
    } catch {
      this.backendPromise = undefined;
      throw new VaultError("secure_storage_unavailable");
    }
  }

  private resolveEncryptedStore(): EncryptedSecretStore {
    if (this.encryptedStore === undefined) throw new VaultError("secure_storage_unavailable");
    return this.encryptedStore;
  }

  private safeUnregister(scope: string): void {
    try {
      this.redactor.unregister(scope);
    } catch {
      // A cleanup failure is deliberately masked by the caller's VaultError.
    }
  }
}

export function createSystemCredentialVault(
  deps: SystemCredentialVaultDependencies,
): CredentialVault {
  return new SystemCredentialVault(deps);
}

async function loadKeytarBackend(): Promise<NativeCredentialBackend> {
  const imported = (await import("keytar")) as unknown as {
    default?: NativeCredentialBackend;
  } & NativeCredentialBackend;
  return imported.default ?? imported;
}

function configuredRuntimeMode(): RuntimeMode {
  return process.env.CSB_RUNTIME_MODE?.trim() === "server" ? "server" : "local";
}

function nativeBackend(): Exclude<VaultBackend, "encrypted-file"> {
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "linux") return "secret-service";
  return "unsupported";
}
