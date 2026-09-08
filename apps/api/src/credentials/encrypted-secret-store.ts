import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { VaultError } from "./credential-vault.js";

const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MASTER_KEY_BYTES = 32;
const PROBE_NAMESPACE = "availability";
const SENTINEL_NAMESPACE = "_vault";
const SENTINEL_REF = "sentinel-v1";
const SENTINEL_VALUE = "csb-encrypted-secret-store-sentinel-v1";
const AAD_PREFIX = "csb-encrypted-secret-store:v1";

export interface EncryptedSecretStoreDependencies {
  /** Persistent private directory. Defaults are resolved by the caller. */
  dataDir: string;
  /** External 32-byte material: raw bytes, 64 hexadecimal chars, or Base64. */
  keyFile: string;
}

/**
 * Small encrypted file store for server-only credentials. Each record receives
 * an independent AES-GCM nonce and binds its namespace and reference as AAD.
 * Names are hashed so neither file names nor directory names disclose logical
 * credential identifiers.
 */
export class EncryptedSecretStore {
  readonly #dataDir: string;
  readonly #keyFile: string;
  #key: Promise<Buffer> | undefined;

  constructor(dependencies: EncryptedSecretStoreDependencies) {
    if (!dependencies?.dataDir || !dependencies?.keyFile) {
      throw new VaultError("secure_storage_unavailable");
    }
    this.#dataDir = path.resolve(dependencies.dataDir);
    this.#keyFile = path.resolve(dependencies.keyFile);
  }

  async available(): Promise<boolean> {
    const ref = `probe-${randomUUID()}`;
    try {
      await this.#ensureSentinel();
      await this.put(PROBE_NAMESPACE, ref, { probe: true });
      const probe = await this.get(PROBE_NAMESPACE, ref);
      if (!isProbe(probe)) return false;
      await this.delete(PROBE_NAMESPACE, ref);
      return true;
    } catch {
      try {
        await this.delete(PROBE_NAMESPACE, ref);
      } catch {
        // The failed availability probe must not reveal storage internals.
      }
      return false;
    }
  }

  async put(namespace: string, ref: string, value: unknown): Promise<void> {
    await this.#ensureSentinel();
    const location = this.#location(namespace, ref);
    const encoded = await this.#seal(namespace, ref, value);
    try {
      await this.#writeAtomically(location, encoded);
    } catch (error) {
      throw asVaultError(error, "credential_write_failed");
    } finally {
      encoded.fill(0);
    }
  }

  async get(namespace: string, ref: string): Promise<unknown | null> {
    const key = await this.#masterKey();
    const location = this.#location(namespace, ref);
    let encoded: Buffer;
    try {
      encoded = await readFile(location.file);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new VaultError("secure_storage_unavailable");
    }

    try {
      if (encoded.length < 1 + NONCE_BYTES + TAG_BYTES || encoded[0] !== FORMAT_VERSION) {
        throw new Error("invalid encrypted credential format");
      }
      const nonce = encoded.subarray(1, 1 + NONCE_BYTES);
      const sealed = encoded.subarray(1 + NONCE_BYTES);
      const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
      const tag = sealed.subarray(sealed.length - TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(this.#aad(namespace, ref));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        return JSON.parse(plaintext.toString("utf8"));
      } finally {
        plaintext.fill(0);
      }
    } catch {
      // Authentication failures, malformed ciphertext, and incorrect master
      // keys intentionally share one safe error surface.
      throw new VaultError("secure_storage_unavailable");
    } finally {
      encoded.fill(0);
    }
  }

  async delete(namespace: string, ref: string): Promise<void> {
    // Authenticate the existing record before deleting it. A process supplied
    // with a different but well-formed 32-byte key must not be able to erase a
    // credential it cannot read.
    await this.get(namespace, ref);
    const location = this.#location(namespace, ref);
    try {
      await rm(location.file, { force: true });
    } catch {
      throw new VaultError("secure_storage_unavailable");
    }
  }

  async #seal(namespace: string, ref: string, value: unknown): Promise<Buffer> {
    const key = await this.#masterKey();
    let plaintext = Buffer.alloc(0);
    try {
      plaintext = Buffer.from(JSON.stringify(value), "utf8");
    } catch {
      throw new VaultError("credential_write_failed");
    }

    const nonce = randomBytes(NONCE_BYTES);
    let ciphertext: Buffer;
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(this.#aad(namespace, ref));
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    } catch {
      throw new VaultError("credential_write_failed");
    } finally {
      plaintext.fill(0);
    }

    const encoded = Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, ciphertext]);
    return encoded;
  }

  #location(namespace: string, ref: string): { directory: string; file: string } {
    const namespaceDigest = digest(this.#identifier(namespace));
    const refDigest = digest(this.#identifier(ref));
    const directory = path.join(this.#dataDir, "vault", namespaceDigest);
    return { directory, file: path.join(directory, `${refDigest}.secret`) };
  }

  #identifier(value: string): string {
    if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\0")) {
      throw new VaultError("secure_storage_unavailable");
    }
    return value;
  }

  #aad(namespace: string, ref: string): Buffer {
    return Buffer.from(JSON.stringify([
      AAD_PREFIX,
      this.#identifier(namespace),
      this.#identifier(ref),
    ]), "utf8");
  }

  async #masterKey(): Promise<Buffer> {
    this.#key ??= readMasterKey(this.#keyFile);
    try {
      return await this.#key;
    } catch {
      this.#key = undefined;
      throw new VaultError("secure_storage_unavailable");
    }
  }

  async #writeAtomically(location: { directory: string; file: string }, value: Buffer): Promise<void> {
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    await chmod(location.directory, 0o700);
    const temp = path.join(location.directory, `.${path.basename(location.file)}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(value);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, location.file);
      await chmod(location.file, 0o600);
      const fileStatus = await stat(location.file);
      if ((fileStatus.mode & 0o077) !== 0) throw new Error("private credential file permissions were not applied");
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  async #ensureSentinel(): Promise<void> {
    const existing = await this.get(SENTINEL_NAMESPACE, SENTINEL_REF);
    if (isSentinel(existing)) return;
    if (existing !== null) throw new VaultError("secure_storage_unavailable");

    const location = this.#location(SENTINEL_NAMESPACE, SENTINEL_REF);
    const encoded = await this.#seal(SENTINEL_NAMESPACE, SENTINEL_REF, { value: SENTINEL_VALUE });
    try {
      try {
        await this.#writeExclusively(location, encoded);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      if (!isSentinel(await this.get(SENTINEL_NAMESPACE, SENTINEL_REF))) {
        throw new VaultError("secure_storage_unavailable");
      }
    } finally {
      encoded.fill(0);
    }
  }

  async #writeExclusively(location: { directory: string; file: string }, value: Buffer): Promise<void> {
    await mkdir(location.directory, { recursive: true, mode: 0o700 });
    await chmod(location.directory, 0o700);
    const temp = path.join(location.directory, `.${path.basename(location.file)}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(value);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temp, location.file);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }
}

async function readMasterKey(keyFile: string): Promise<Buffer> {
  let encoded: Buffer;
  try {
    encoded = await readFile(keyFile);
  } catch {
    throw new VaultError("secure_storage_unavailable");
  }
  const key = decodeMasterKey(encoded);
  encoded.fill(0);
  if (key === null) {
    throw new VaultError("secure_storage_unavailable");
  }
  return key;
}

function decodeMasterKey(value: Buffer): Buffer | null {
  if (value.length === MASTER_KEY_BYTES) return Buffer.from(value);
  const text = value.toString("ascii").replace(/\r?\n$/, "");
  if (/^[a-fA-F0-9]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(text)) {
    const decoded = Buffer.from(text, "base64");
    if (decoded.length === MASTER_KEY_BYTES) return decoded;
    decoded.fill(0);
  }
  return null;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isProbe(value: unknown): value is { probe: true } {
  return typeof value === "object" && value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 1 &&
    (value as { probe?: unknown }).probe === true;
}

function isSentinel(value: unknown): value is { value: string } {
  return typeof value === "object" && value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 1 &&
    (value as { value?: unknown }).value === SENTINEL_VALUE;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as NodeJS.ErrnoException).code === "EEXIST";
}

function asVaultError(
  error: unknown,
  fallback: "credential_write_failed" | "secure_storage_unavailable",
): VaultError {
  return error instanceof VaultError ? error : new VaultError(fallback);
}
