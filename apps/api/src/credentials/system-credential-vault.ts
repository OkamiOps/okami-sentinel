import { randomUUID } from "node:crypto";

import {
  connectionSecretValues,
  type ConnectionSecretBundle,
  type CredentialVault,
  type SecretRedactorRegistry,
  validateConnectionSecretBundle,
  VaultError,
} from "./credential-vault.js";

export { VaultError } from "./credential-vault.js";

const SERVICE = "com.okamiops.sentinel.connections";
const AVAILABILITY_PROBE_VALUE = "okami-sentinel-vault-probe";

export interface NativeCredentialBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export interface SystemCredentialVaultDependencies {
  redactor: SecretRedactorRegistry;
  loadBackend?: () => Promise<NativeCredentialBackend>;
}

export class SystemCredentialVault implements CredentialVault {
  private readonly redactor: SecretRedactorRegistry;
  private readonly loadBackend: () => Promise<NativeCredentialBackend>;
  private backendPromise: Promise<NativeCredentialBackend> | undefined;

  constructor(deps: SystemCredentialVaultDependencies) {
    if (!deps?.redactor) throw new VaultError("secure_storage_unavailable");
    this.redactor = deps.redactor;
    this.loadBackend = deps.loadBackend ?? loadKeytarBackend;
  }

  async available() {
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
    this.assertSupported();
    const bundle = validateConnectionSecretBundle(value);
    const values = connectionSecretValues(bundle);
    const pendingScope = `${ref}:pending:${randomUUID()}`;

    try {
      this.redactor.register(pendingScope, values);
    } catch {
      this.safeUnregister(pendingScope);
      throw new VaultError("credential_write_failed");
    }

    let backend: NativeCredentialBackend;
    try {
      backend = await this.resolveBackend();
    } catch {
      this.safeUnregister(pendingScope);
      throw new VaultError("secure_storage_unavailable");
    }

    try {
      await backend.setPassword(SERVICE, ref, JSON.stringify(bundle));
    } catch {
      // Keep the pending scope registered: a rejected native promise does not
      // prove that the backend failed before committing the replacement.
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
    this.assertSupported();
    const backend = await this.resolveBackend();
    let encoded: string | null;

    try {
      encoded = await backend.getPassword(SERVICE, ref);
    } catch {
      throw new VaultError("secure_storage_unavailable");
    }

    if (encoded === null) throw new VaultError("credential_not_found");

    let bundle: ConnectionSecretBundle;
    try {
      bundle = validateConnectionSecretBundle(JSON.parse(encoded));
      this.redactor.register(ref, connectionSecretValues(bundle));
    } catch {
      throw new VaultError("secure_storage_unavailable");
    }
    return bundle;
  }

  async delete(ref: string): Promise<void> {
    this.assertSupported();
    const backend = await this.resolveBackend();

    try {
      await backend.deletePassword(SERVICE, ref);
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

function nativeBackend(): "keychain" | "secret-service" | "unsupported" {
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "linux") return "secret-service";
  return "unsupported";
}
