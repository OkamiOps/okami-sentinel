import { randomUUID, sign as signBytes } from "node:crypto";

import type { SecretRedactorRegistry } from "../credentials/credential-vault.js";
import type { GitHubAppCredentialStore } from "../credentials/system-github-app-credential-store.js";
import type {
  GitHubAppConnectionMetadata,
  GitHubAppInstallationMetadata,
  GitHubInstallationRepositoryMetadata,
} from "../gate-store.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TOKEN_EARLY_EXPIRY_MS = 60_000;

const MAX_PERMISSION = Object.freeze({
  actions: "write",
  checks: "write",
  contents: "read",
  metadata: "read",
  pull_requests: "read",
} as const);

export type GitHubInstallationPermission = keyof typeof MAX_PERMISSION;
export type GitHubInstallationPermissions = Partial<Record<
  GitHubInstallationPermission,
  "read" | "write"
>>;

export type GitHubAppClientErrorCode =
  | "github_connection_revoked"
  | "github_credential_rejected"
  | "github_credential_unavailable"
  | "github_host_not_allowed"
  | "github_not_found"
  | "github_protocol_error"
  | "github_request_rejected"
  | "github_unavailable";

export class GitHubAppClientError extends Error {
  constructor(readonly code: GitHubAppClientErrorCode) {
    super(code);
    this.name = "GitHubAppClientError";
  }
}

export interface GitHubHttpRequest {
  url: string;
  method: "DELETE" | "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: string;
}

export interface GitHubHttpResponse {
  status: number;
  body: unknown;
}

export type GitHubHttpTransport = (request: GitHubHttpRequest) => Promise<GitHubHttpResponse>;

export interface ManifestAppExchange {
  appId: string;
  appSlug: string;
  clientId: string;
  privateKeyPem: string;
}

export interface GitHubInstallationToken {
  token: string;
  expiresAt: string;
}

export interface GitHubAppClientDependencies {
  credentials: GitHubAppCredentialStore;
  redactor: SecretRedactorRegistry;
  transport?: GitHubHttpTransport;
  apiBaseUrl?: string;
  now?: () => Date;
}

interface CachedInstallationToken extends GitHubInstallationToken {
  validUntilMs: number;
  redactionScope: string;
}

export class GitHubAppClient {
  readonly #credentials: GitHubAppCredentialStore;
  readonly #redactor: SecretRedactorRegistry;
  readonly #transport: GitHubHttpTransport;
  readonly #apiBaseUrl: string;
  readonly #now: () => Date;
  readonly #tokens = new Map<string, CachedInstallationToken>();

  constructor(dependencies: GitHubAppClientDependencies) {
    this.#credentials = dependencies.credentials;
    this.#redactor = dependencies.redactor;
    this.#transport = dependencies.transport ?? fetchGitHubJson;
    this.#apiBaseUrl = validApiBaseUrl(dependencies.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.#now = dependencies.now ?? (() => new Date());
  }

  async exchangeManifestCode<T>(
    code: string,
    consume: (app: ManifestAppExchange) => Promise<T> | T,
  ): Promise<T> {
    const safeCode = manifestCode(code);
    const response = await this.#request({
      method: "POST",
      path: `/app-manifests/${encodeURIComponent(safeCode)}/conversions`,
    });
    const body = record(response);
    const app: ManifestAppExchange = {
      appId: positiveIdentifier(body.id),
      appSlug: identifier(body.slug, 100),
      clientId: identifier(body.client_id, 200),
      privateKeyPem: nonEmptyString(body.pem, 131_072),
    };
    const transientSecrets = [
      app.privateKeyPem,
      optionalSecret(body.client_secret),
      optionalSecret(body.webhook_secret),
    ].filter((value): value is string => value !== null);
    const scope = `scm/github-app/manifest-exchange/${randomUUID()}`;
    try {
      this.#redactor.register(scope, transientSecrets);
      return await consume(app);
    } finally {
      safeUnregister(this.#redactor, scope);
    }
  }

  async listInstallations(
    connection: GitHubAppConnectionMetadata,
  ): Promise<GitHubAppInstallationMetadata[]> {
    assertReadyConnection(connection);
    const privateKeyPem = await this.#privateKey(connection.id);
    const jwt = createGitHubAppJwt(connection.clientId, privateKeyPem, this.#now());
    const now = this.#now().toISOString();
    const installations: GitHubAppInstallationMetadata[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const response = array(await this.#request({
        method: "GET",
        path: `/app/installations?per_page=100${page === 1 ? "" : `&page=${page}`}`,
        authorization: `Bearer ${jwt}`,
      }));
      installations.push(...response.map((value) => {
        const item = record(value);
        const account = record(item.account);
        const suspended = item.suspended_at !== null && item.suspended_at !== undefined;
        return {
          id: positiveIdentifier(item.id),
          connectionId: connection.id,
          accountLogin: identifier(account.login, 255),
          accountType: accountType(account.type),
          status: suspended ? "suspended" as const : "ready" as const,
          createdAt: isoTimestamp(item.created_at, now),
          updatedAt: isoTimestamp(item.updated_at, now),
        };
      }));
      if (response.length < 100) return installations;
    }
    throw new GitHubAppClientError("github_protocol_error");
  }

  async listInstallationRepositories(
    connection: GitHubAppConnectionMetadata,
    installationId: string,
  ): Promise<GitHubInstallationRepositoryMetadata[]> {
    assertReadyConnection(connection);
    const safeInstallationId = positiveIdentifier(installationId);
    const privateKeyPem = await this.#privateKey(connection.id);
    const jwt = createGitHubAppJwt(connection.clientId, privateKeyPem, this.#now());
    const tokenResponse = record(await this.#request({
      method: "POST",
      path: `/app/installations/${encodeURIComponent(safeInstallationId)}/access_tokens`,
      authorization: `Bearer ${jwt}`,
      body: { permissions: { metadata: "read" } },
    }));
    const token = nonEmptyString(tokenResponse.token, 16_384);
    const expiresAt = isoTimestamp(tokenResponse.expires_at);
    if (Date.parse(expiresAt) - TOKEN_EARLY_EXPIRY_MS <= this.#now().getTime()) {
      throw new GitHubAppClientError("github_protocol_error");
    }
    const scope = `scm/github-app/catalog-token/${connection.id}/${safeInstallationId}/${randomUUID()}`;
    try {
      this.#redactor.register(scope, [token]);
    } catch {
      throw new GitHubAppClientError("github_credential_unavailable");
    }
    try {
      const now = this.#now().toISOString();
      const repositories: GitHubInstallationRepositoryMetadata[] = [];
      for (let page = 1; page <= 100; page += 1) {
        const root = record(await this.#request({
          method: "GET",
          path: `/installation/repositories?per_page=100${page === 1 ? "" : `&page=${page}`}`,
          authorization: `Bearer ${token}`,
        }));
        const total = nonNegativeInteger(root.total_count, 10_000);
        const response = array(root.repositories);
        repositories.push(...response.map((value) => {
          const repository = record(value);
          const owner = record(repository.owner);
          return {
            repositoryId: positiveIdentifier(repository.id),
            installationId: safeInstallationId,
            owner: identifier(owner.login, 255),
            name: identifier(repository.name, 255),
            defaultBranch: identifier(repository.default_branch, 255),
            private: booleanValue(repository.private),
            archived: booleanValue(repository.archived),
            updatedAt: isoTimestamp(repository.updated_at, now),
          };
        }));
        if (repositories.length > total) throw new GitHubAppClientError("github_protocol_error");
        if (repositories.length === total) return repositories;
        if (response.length < 100) throw new GitHubAppClientError("github_protocol_error");
      }
      throw new GitHubAppClientError("github_protocol_error");
    } finally {
      try {
        await this.#request({
          method: "DELETE",
          path: "/installation/token",
          authorization: `Bearer ${token}`,
        });
      } finally {
        safeUnregister(this.#redactor, scope);
      }
    }
  }

  async createRepositoryToken(
    connection: GitHubAppConnectionMetadata,
    installationId: string,
    repositoryId: string,
    permissions: GitHubInstallationPermissions,
  ): Promise<GitHubInstallationToken> {
    return this.#createInstallationToken(
      connection,
      installationId,
      "repository",
      numericRepositoryId(repositoryId),
      permissions,
    );
  }

  clearConnection(connectionId: string): void {
    for (const [key, cached] of this.#tokens) {
      if (!key.startsWith(`${connectionId}:`)) continue;
      safeUnregister(this.#redactor, cached.redactionScope);
      this.#tokens.delete(key);
    }
  }

  async #createInstallationToken(
    connection: GitHubAppConnectionMetadata,
    installationId: string,
    purpose: "repository",
    repositoryId: number | undefined,
    permissions: GitHubInstallationPermissions,
  ): Promise<GitHubInstallationToken> {
    assertReadyConnection(connection);
    const safeInstallationId = positiveIdentifier(installationId);
    const safePermissions = installationPermissions(permissions);
    const permissionKey = JSON.stringify(safePermissions);
    const cacheKey = `${connection.id}:${safeInstallationId}:${purpose}:${repositoryId ?? "all"}:${permissionKey}`;
    const nowMs = this.#now().getTime();
    const cached = this.#tokens.get(cacheKey);
    if (cached && cached.validUntilMs > nowMs) {
      return { token: cached.token, expiresAt: cached.expiresAt };
    }
    if (cached) {
      safeUnregister(this.#redactor, cached.redactionScope);
      this.#tokens.delete(cacheKey);
    }

    const privateKeyPem = await this.#privateKey(connection.id);
    const jwt = createGitHubAppJwt(connection.clientId, privateKeyPem, this.#now());
    const response = await this.#request({
      method: "POST",
      path: `/app/installations/${encodeURIComponent(safeInstallationId)}/access_tokens`,
      authorization: `Bearer ${jwt}`,
      body: {
        ...(repositoryId === undefined ? {} : { repository_ids: [repositoryId] }),
        permissions: safePermissions,
      },
    });
    const root = record(response);
    const token = nonEmptyString(root.token, 16_384);
    const expiresAt = isoTimestamp(root.expires_at);
    const validUntilMs = Date.parse(expiresAt) - TOKEN_EARLY_EXPIRY_MS;
    if (validUntilMs <= nowMs) throw new GitHubAppClientError("github_protocol_error");
    const redactionScope = `scm/github-app/token/${cacheKey}`;
    try {
      this.#redactor.register(redactionScope, [token]);
    } catch {
      throw new GitHubAppClientError("github_credential_unavailable");
    }
    this.#tokens.set(cacheKey, { token, expiresAt, validUntilMs, redactionScope });
    return { token, expiresAt };
  }

  async #privateKey(connectionId: string): Promise<string> {
    try {
      const credentials = await this.#credentials.get(connectionId);
      if (credentials === null) throw new GitHubAppClientError("github_credential_unavailable");
      return credentials.privateKeyPem;
    } catch (error) {
      if (error instanceof GitHubAppClientError) throw error;
      throw new GitHubAppClientError("github_credential_unavailable");
    }
  }

  async #request(input: {
    method: "DELETE" | "GET" | "POST";
    path: string;
    authorization?: string;
    body?: unknown;
  }): Promise<unknown> {
    const url = new URL(input.path, `${this.#apiBaseUrl}/`).toString();
    assertAllowedGitHubApiUrl(url);
    let response: GitHubHttpResponse;
    try {
      response = await this.#transport({
        url,
        method: input.method,
        headers: {
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "okami-sentinel",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          ...(input.authorization ? { Authorization: input.authorization } : {}),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
    } catch {
      throw new GitHubAppClientError("github_unavailable");
    }
    if (response.status >= 200 && response.status < 300) return response.body;
    if (response.status === 401 || response.status === 403) {
      throw new GitHubAppClientError("github_credential_rejected");
    }
    if (response.status === 404) throw new GitHubAppClientError("github_not_found");
    if (response.status === 409 || response.status === 422) {
      throw new GitHubAppClientError("github_request_rejected");
    }
    throw new GitHubAppClientError("github_unavailable");
  }
}

export function createGitHubAppJwt(
  clientId: string,
  privateKeyPem: string,
  now: Date = new Date(),
): string {
  const safeClientId = identifier(clientId, 200);
  if (!Number.isFinite(now.getTime())) throw new GitHubAppClientError("github_protocol_error");
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: safeClientId,
  });
  const unsigned = `${header}.${payload}`;
  try {
    const signature = signBytes("RSA-SHA256", Buffer.from(unsigned), privateKeyPem).toString("base64url");
    return `${unsigned}.${signature}`;
  } catch {
    throw new GitHubAppClientError("github_credential_unavailable");
  }
}

export function assertAllowedGitHubApiUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubAppClientError("github_host_not_allowed");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new GitHubAppClientError("github_host_not_allowed");
  }
}

function validApiBaseUrl(value: string): string {
  assertAllowedGitHubApiUrl(value);
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new GitHubAppClientError("github_host_not_allowed");
  }
  return url.origin;
}

function assertReadyConnection(connection: GitHubAppConnectionMetadata): void {
  if (connection.status !== "ready") {
    throw new GitHubAppClientError("github_connection_revoked");
  }
}

function installationPermissions(value: GitHubInstallationPermissions): Record<string, "read" | "write"> {
  if (!isPlainRecord(value)) throw new GitHubAppClientError("github_request_rejected");
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) throw new GitHubAppClientError("github_request_rejected");
  const output: Record<string, "read" | "write"> = {};
  for (const [name, level] of entries) {
    if (!(name in MAX_PERMISSION) || (level !== "read" && level !== "write")) {
      throw new GitHubAppClientError("github_request_rejected");
    }
    const maximum = MAX_PERMISSION[name as GitHubInstallationPermission];
    if (maximum === "read" && level === "write") {
      throw new GitHubAppClientError("github_request_rejected");
    }
    output[name] = level;
  }
  return output;
}

function numericRepositoryId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== value) {
    throw new GitHubAppClientError("github_request_rejected");
  }
  return id;
}

function manifestCode(value: string): string {
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(value)) {
    throw new GitHubAppClientError("github_request_rejected");
  }
  return value;
}

function positiveIdentifier(value: unknown): string {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !/^[1-9][0-9]{0,30}$/.test(normalized)) {
    throw new GitHubAppClientError("github_protocol_error");
  }
  return normalized;
}

function identifier(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new GitHubAppClientError("github_protocol_error");
  }
  return value;
}

function nonEmptyString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new GitHubAppClientError("github_protocol_error");
  }
  return value;
}

function optionalSecret(value: unknown): string | null {
  return value === undefined || value === null ? null : nonEmptyString(value, 16_384);
}

function isoTimestamp(value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new GitHubAppClientError("github_protocol_error");
  }
  return new Date(value).toISOString();
}

function accountType(value: unknown): "User" | "Organization" {
  if (value === "User" || value === "Organization") return value;
  throw new GitHubAppClientError("github_protocol_error");
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new GitHubAppClientError("github_protocol_error");
}

function nonNegativeInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new GitHubAppClientError("github_protocol_error");
  }
  return value as number;
}

function record(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new GitHubAppClientError("github_protocol_error");
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new GitHubAppClientError("github_protocol_error");
  }
  return value;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function safeUnregister(redactor: SecretRedactorRegistry, scope: string): void {
  try {
    redactor.unregister(scope);
  } catch {
    // Never replace a successful remote operation with redactor cleanup detail.
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function fetchGitHubJson(request: GitHubHttpRequest): Promise<GitHubHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(30_000),
  });
  const encoded = await response.text();
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESPONSE_BYTES) {
    throw new GitHubAppClientError("github_protocol_error");
  }
  let body: unknown = null;
  if (encoded.length > 0) {
    try {
      body = JSON.parse(encoded);
    } catch {
      throw new GitHubAppClientError("github_protocol_error");
    }
  }
  return { status: response.status, body };
}
