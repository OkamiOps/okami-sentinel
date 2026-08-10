import { Entry } from "@napi-rs/keyring";

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

export interface EntryLike {
  setPassword(password: string): void;
  getPassword(): string | null;
  deletePassword(): boolean | void;
}

export interface SystemCredentialVaultDependencies {
  entry?: (account: string) => EntryLike;
  redactor?: SecretRedactorRegistry;
}

const noopRedactor: SecretRedactorRegistry = {
  register() {},
  unregister() {},
};

export class SystemCredentialVault implements CredentialVault {
  private readonly entry: (account: string) => EntryLike;
  private readonly redactor: SecretRedactorRegistry;

  constructor(deps: SystemCredentialVaultDependencies = {}) {
    this.entry = deps.entry ?? ((account) => new Entry(SERVICE, account));
    this.redactor = deps.redactor ?? noopRedactor;
  }

  async available() {
    const backend = nativeBackend();
    if (backend === "unsupported") return { available: false, backend };

    try {
      this.entry("availability-probe").getPassword();
      return { available: true, backend };
    } catch (error) {
      return { available: isMissingEntry(error), backend };
    }
  }

  async put(ref: string, value: ConnectionSecretBundle): Promise<void> {
    const bundle = validateConnectionSecretBundle(value);
    const entry = this.resolveEntry(ref);

    try {
      entry.setPassword(JSON.stringify(bundle));
    } catch {
      throw new VaultError("credential_write_failed");
    }

    this.redactor.register(ref, connectionSecretValues(bundle));
  }

  async get(ref: string): Promise<ConnectionSecretBundle> {
    const entry = this.resolveEntry(ref);
    let encoded: string | null;

    try {
      encoded = entry.getPassword();
    } catch (error) {
      if (isMissingEntry(error)) throw new VaultError("credential_not_found");
      throw new VaultError("secure_storage_unavailable");
    }

    if (encoded === null) throw new VaultError("credential_not_found");

    try {
      const bundle = validateConnectionSecretBundle(JSON.parse(encoded));
      this.redactor.register(ref, connectionSecretValues(bundle));
      return bundle;
    } catch {
      throw new VaultError("secure_storage_unavailable");
    }
  }

  async delete(ref: string): Promise<void> {
    const entry = this.resolveEntry(ref);

    try {
      entry.deletePassword();
    } catch (error) {
      if (!isMissingEntry(error)) {
        throw new VaultError("secure_storage_unavailable");
      }
    }

    this.redactor.unregister(ref);
  }

  private resolveEntry(ref: string): EntryLike {
    try {
      return this.entry(ref);
    } catch {
      throw new VaultError("secure_storage_unavailable");
    }
  }
}

export function createSystemCredentialVault(
  deps: SystemCredentialVaultDependencies = {},
): CredentialVault {
  return new SystemCredentialVault(deps);
}

export function isMissingEntry(error: unknown): boolean {
  if (error === null || error === undefined) return true;
  if (typeof error !== "object") return false;

  return (
    "code" in error &&
    (error.code === "NoEntry" || error.code === "ENOENT")
  );
}

function nativeBackend(): "keychain" | "secret-service" | "unsupported" {
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "linux") return "secret-service";
  return "unsupported";
}
