export interface ConnectionSecretBundle {
  apiKey?: string;
  baseUrl?: string;
  discoveryUrl?: string;
  headers?: Record<string, string>;
  /** Explicit opt-in for plain HTTP on loopback hosts only. */
  allowInsecureLocalhost?: true;
}

export interface CredentialVault {
  available(): Promise<{
    available: boolean;
    backend: "keychain" | "secret-service" | "unsupported";
  }>;
  put(ref: string, value: ConnectionSecretBundle): Promise<void>;
  get(ref: string): Promise<ConnectionSecretBundle>;
  delete(ref: string): Promise<void>;
}

export class VaultError extends Error {
  constructor(
    readonly code:
      | "secure_storage_unavailable"
      | "credential_not_found"
      | "credential_write_failed",
  ) {
    super(code);
    this.name = "VaultError";
  }
}

/**
 * Integration point for Task 1: pass globalSecretRedactor here at the API
 * composition root. Keeping this dependency injected lets the vault stay
 * native-only without duplicating the redaction implementation.
 */
export interface SecretRedactorRegistry {
  register(scope: string, values: readonly string[]): void;
  unregister(scope: string): void;
}

const ALLOWED_KEYS = new Set([
  "apiKey",
  "baseUrl",
  "discoveryUrl",
  "headers",
  "allowInsecureLocalhost",
]);
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;

export function validateConnectionSecretBundle(
  value: unknown,
): ConnectionSecretBundle {
  if (!isPlainRecord(value)) invalidBundle();

  const keys = Object.getOwnPropertyNames(value);
  if (
    keys.length === 0 ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    keys.some((key) => !ALLOWED_KEYS.has(key))
  ) {
    invalidBundle();
  }

  const bundle: ConnectionSecretBundle = {};

  if (hasOwn(value, "apiKey")) {
    bundle.apiKey = requiredString(value.apiKey);
  }
  if (hasOwn(value, "baseUrl")) {
    bundle.baseUrl = httpUrl(value.baseUrl);
  }
  if (hasOwn(value, "discoveryUrl")) {
    bundle.discoveryUrl = httpUrl(value.discoveryUrl);
  }
  if (hasOwn(value, "headers")) {
    bundle.headers = validatedHeaders(value.headers);
  }
  if (hasOwn(value, "allowInsecureLocalhost")) {
    if (value.allowInsecureLocalhost !== true) invalidBundle();
    bundle.allowInsecureLocalhost = true;
  }

  if (
    bundle.apiKey === undefined &&
    bundle.baseUrl === undefined &&
    bundle.discoveryUrl === undefined &&
    bundle.headers === undefined
  ) {
    invalidBundle();
  }

  return bundle;
}

export function connectionSecretValues(
  bundle: ConnectionSecretBundle,
): string[] {
  return [
    bundle.baseUrl,
    bundle.apiKey,
    bundle.discoveryUrl,
    ...Object.values(bundle.headers ?? {}),
  ].filter((value): value is string => value !== undefined);
}

function validatedHeaders(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) invalidBundle();

  const entries = Object.entries(value);
  if (entries.length === 0 || Object.getOwnPropertySymbols(value).length > 0) {
    invalidBundle();
  }

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (!HEADER_NAME.test(name)) invalidBundle();
    headers[name] = requiredString(headerValue);
  }
  return headers;
}

function requiredString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    CONTROL_CHARACTER.test(value)
  ) {
    invalidBundle();
  }
  return value;
}

function httpUrl(value: unknown): string {
  const url = requiredString(value);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") invalidBundle();
  } catch {
    invalidBundle();
  }
  return url;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidBundle(): never {
  throw new TypeError("Invalid connection secret bundle");
}
