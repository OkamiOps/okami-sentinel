import { randomUUID } from "node:crypto";

import type { SafeProviderErrorCode } from "@csb/shared";
import type { SecretRedactorRegistry } from "../credentials/credential-vault.js";
import { globalSecretRedactor } from "../redaction.js";

/**
 * Server-only xAI OAuth contract. These values intentionally do not accept a
 * URL, client id, scope, endpoint, or model value from configuration or UI.
 */
export const XAI_PUBLIC_OAUTH_PRESET = Object.freeze({
  issuer: "https://auth.x.ai",
  deviceAuthorizationPath: "/oauth2/device/code",
  tokenPath: "/oauth2/token",
  revocationPath: "/oauth2/revoke",
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  scopes: "openid profile email offline_access grok-cli:access api:access",
  inferenceOrigin: "https://api.x.ai",
  modelsPath: "/v1/models",
  responsesPath: "/v1/responses",
  allowedOrigins: Object.freeze(["https://auth.x.ai", "https://api.x.ai"]),
} as const);

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const XAI_DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code" as const;
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token" as const;
const XAI_REVOCATION_URL = "https://auth.x.ai/oauth2/revoke" as const;
const OAUTH_HTTP_TIMEOUT_MS = 8_000;
const OAUTH_RESPONSE_LIMIT_BYTES = 1_024 * 1_024;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;
const REFRESH_SKEW_MS = 30_000;

export type XaiOAuthFlowStatus =
  | "pending-device"
  | "exchanging"
  | "completed"
  | "cancelled"
  | "expired"
  | "denied"
  | "failed";

/** The only xAI device-flow state suitable for a UI, API response, or log. */
export interface XaiOAuthFlowPublic {
  flowId: string;
  status: XaiOAuthFlowStatus;
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
}

/** Private credentials; these must only be implemented by a vault boundary. */
export interface XaiOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string | null;
}

/**
 * An intentionally separate vault namespace. Task integration supplies a
 * codec backed by CredentialVault; xAI OAuth never reinterprets the bearer as
 * an API key or serializes it through the public connection bundle.
 */
export interface XaiOAuthCredentialStore {
  put(connectionId: string, value: XaiOAuthCredentials): Promise<void>;
  get(connectionId: string): Promise<XaiOAuthCredentials | null>;
  delete(connectionId: string): Promise<void>;
}

export interface XaiDeviceCodeResponse {
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresIn: number;
  interval?: number;
}

export interface XaiTokenSuccess {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

export interface XaiTokenError {
  /** Raw provider codes remain only inside this server-side transport boundary. */
  error: string;
}

export type XaiTokenResult = XaiTokenSuccess | XaiTokenError;

export interface XaiOAuthTransport {
  requestDeviceCode(input: {
    url: "https://auth.x.ai/oauth2/device/code";
    clientId: typeof XAI_PUBLIC_OAUTH_PRESET.clientId;
    scope: typeof XAI_PUBLIC_OAUTH_PRESET.scopes;
    signal: AbortSignal;
  }): Promise<XaiDeviceCodeResponse>;
  requestToken(input: {
    url: "https://auth.x.ai/oauth2/token";
    clientId: typeof XAI_PUBLIC_OAUTH_PRESET.clientId;
    grantType: typeof DEVICE_GRANT | "refresh_token";
    deviceCode?: string;
    refreshToken?: string;
    signal: AbortSignal;
  }): Promise<XaiTokenResult>;
  revoke(input: {
    url: "https://auth.x.ai/oauth2/revoke";
    clientId: typeof XAI_PUBLIC_OAUTH_PRESET.clientId;
    token: string;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface XaiOAuthFlowDependencies {
  transport: XaiOAuthTransport;
  credentialStore: XaiOAuthCredentialStore;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  openExternal?: (url: string) => Promise<void> | void;
  createId?: () => string;
  redactor?: SecretRedactorRegistry;
}

export interface XaiOAuthHttpTransportDependencies {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type XaiOAuthCredentialStatus = "ready" | "authentication-required" | "expired";
export type XaiOAuthDisconnectResult = "revoked" | "revoke_pending" | "local_removed";

export interface XaiOAuthFlow {
  start(connectionId: string): Promise<XaiOAuthFlowPublic>;
  get(connectionId: string, flowId: string): XaiOAuthFlowPublic | null;
  cancel(connectionId: string, flowId: string): Promise<void>;
  waitForTerminal(connectionId: string, flowId: string): Promise<XaiOAuthFlowPublic>;
  credentialStatus(connectionId: string): Promise<XaiOAuthCredentialStatus>;
  getAccessToken(connectionId: string): Promise<string>;
  disconnect(connectionId: string): Promise<XaiOAuthDisconnectResult>;
}

export class XaiOAuthFlowError extends Error {
  constructor(readonly code: SafeProviderErrorCode) {
    super(code);
    this.name = "XaiOAuthFlowError";
  }
}

/** Internal-only race outcomes; no instance is returned outside this module. */
class OAuthOperationAbortedError extends Error {}
class OAuthOperationDeadlineError extends Error {}

interface PrivateFlow {
  id: string;
  connectionId: string;
  deviceCode: string;
  verificationUrl: string;
  verificationUriComplete: string | null;
  userCode: string;
  expiresAtMs: number;
  intervalMs: number;
  status: XaiOAuthFlowStatus;
  controller: AbortController;
  completion: Promise<void>;
  redactionScope: string;
}

/**
 * A completed/cancelled flow remains available to the UI without keeping its
 * one-time device code or complete verification URI alive in memory.
 */
interface TerminalFlow {
  connectionId: string;
  value: XaiOAuthFlowPublic;
}

export function createXaiOAuthFlow(
  dependencies: XaiOAuthFlowDependencies,
): XaiOAuthFlow {
  return new ManagedXaiOAuthFlow(dependencies);
}

/**
 * Concrete RFC 8628 transport used by the Sentinel-managed xAI route. It is
 * intentionally incapable of following redirects or accepting an alternate
 * OAuth host/path; a caller can only exercise the immutable preset above.
 */
export function createXaiOAuthHttpTransport(
  dependencies: XaiOAuthHttpTransportDependencies = {},
): XaiOAuthTransport {
  const transport = dependencies.fetch ?? fetch;
  const timeoutMs = validHttpTimeout(dependencies.timeoutMs);
  return {
    async requestDeviceCode(input) {
      if (
        input.url !== XAI_DEVICE_AUTHORIZATION_URL ||
        input.clientId !== XAI_PUBLIC_OAUTH_PRESET.clientId ||
        input.scope !== XAI_PUBLIC_OAUTH_PRESET.scopes
      ) throw new XaiOAuthFlowError("oauth_metadata_invalid");
      const payload = await postOAuthForm(transport, input.url, new URLSearchParams({
        client_id: input.clientId,
        scope: input.scope,
      }), input.signal, timeoutMs);
      if (!payload.ok) throw new XaiOAuthFlowError(safeHttpError(payload.status));
      const data = asRecord(payload.data);
      const response: XaiDeviceCodeResponse = {
        deviceCode: stringField(data.device_code),
        verificationUri: stringField(data.verification_uri),
        ...(typeof data.verification_uri_complete === "string"
          ? { verificationUriComplete: data.verification_uri_complete }
          : {}),
        userCode: stringField(data.user_code),
        expiresIn: numberField(data.expires_in),
        ...(typeof data.interval === "number" ? { interval: data.interval } : {}),
      };
      // Validate fields at the transport boundary so an invalid response cannot
      // be opened in a browser by a future caller.
      normalizeDeviceResponse(response);
      return response;
    },
    async requestToken(input) {
      if (
        input.url !== XAI_TOKEN_URL ||
        input.clientId !== XAI_PUBLIC_OAUTH_PRESET.clientId ||
        (input.grantType !== DEVICE_GRANT && input.grantType !== "refresh_token") ||
        (input.grantType === DEVICE_GRANT && !isNonEmptyText(input.deviceCode)) ||
        (input.grantType === "refresh_token" && !isNonEmptyText(input.refreshToken))
      ) throw new XaiOAuthFlowError("oauth_metadata_invalid");
      const body = new URLSearchParams({
        client_id: input.clientId,
        grant_type: input.grantType,
        ...(input.deviceCode === undefined ? {} : { device_code: input.deviceCode }),
        ...(input.refreshToken === undefined ? {} : { refresh_token: input.refreshToken }),
      });
      const payload = await postOAuthForm(transport, input.url, body, input.signal, timeoutMs);
      const data = asRecordOrNull(payload.data);
      if (!payload.ok) {
        const error = typeof data?.error === "string" ? data.error : "invalid_response";
        return { error };
      }
      try {
        return {
          accessToken: stringField(data?.access_token),
          ...(typeof data?.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
          ...(typeof data?.expires_in === "number" ? { expiresIn: data.expires_in } : {}),
        };
      } catch {
        return { error: "invalid_response" };
      }
    },
    async revoke(input) {
      if (
        input.url !== XAI_REVOCATION_URL ||
        input.clientId !== XAI_PUBLIC_OAUTH_PRESET.clientId ||
        !isNonEmptyText(input.token)
      ) throw new XaiOAuthFlowError("oauth_metadata_invalid");
      const payload = await postOAuthForm(transport, input.url, new URLSearchParams({
        client_id: input.clientId,
        token: input.token,
      }), input.signal, timeoutMs);
      if (!payload.ok) throw new XaiOAuthFlowError(safeHttpError(payload.status));
    },
  };
}

class ManagedXaiOAuthFlow implements XaiOAuthFlow {
  readonly #transport: XaiOAuthTransport;
  readonly #credentialStore: XaiOAuthCredentialStore;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #openExternal: ((url: string) => Promise<void> | void) | undefined;
  readonly #createId: () => string;
  readonly #redactor: SecretRedactorRegistry;
  readonly #flows = new Map<string, PrivateFlow>();
  readonly #terminalFlows = new Map<string, TerminalFlow>();
  readonly #refreshes = new Map<string, Promise<string>>();

  constructor(dependencies: XaiOAuthFlowDependencies) {
    this.#transport = dependencies.transport;
    this.#credentialStore = dependencies.credentialStore;
    this.#now = dependencies.now ?? (() => new Date());
    this.#sleep = dependencies.sleep ?? sleepWithAbort;
    this.#openExternal = dependencies.openExternal;
    this.#createId = dependencies.createId ?? randomUUID;
    this.#redactor = dependencies.redactor ?? globalSecretRedactor;
  }

  async start(connectionId: string): Promise<XaiOAuthFlowPublic> {
    const safeConnectionId = requiredConnectionId(connectionId);
    const controller = new AbortController();
    let device: XaiDeviceCodeResponse;
    try {
      device = await this.#transport.requestDeviceCode({
        url: XAI_DEVICE_AUTHORIZATION_URL,
        clientId: XAI_PUBLIC_OAUTH_PRESET.clientId,
        scope: XAI_PUBLIC_OAUTH_PRESET.scopes,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof XaiOAuthFlowError) throw error;
      throw new XaiOAuthFlowError("provider_unreachable");
    }

    const normalized = normalizeDeviceResponse(device);
    const id = this.#createId();
    const expiresAtMs = this.#now().getTime() + normalized.expiresIn * 1_000;
    const redactionScope = `connections/xai-oauth/flow/${id}`;
    this.#redactor.register(redactionScope, [
      normalized.deviceCode,
      ...(normalized.verificationUriComplete === null ? [] : [normalized.verificationUriComplete]),
    ]);
    const flow: PrivateFlow = {
      id,
      connectionId: safeConnectionId,
      deviceCode: normalized.deviceCode,
      verificationUrl: normalized.verificationUri,
      verificationUriComplete: normalized.verificationUriComplete,
      userCode: normalized.userCode,
      expiresAtMs,
      intervalMs: normalizeInterval(normalized.interval),
      status: "pending-device",
      controller,
      completion: Promise.resolve(),
      redactionScope,
    };
    this.#flows.set(id, flow);

    if (flow.verificationUriComplete !== null && this.#openExternal !== undefined) {
      try {
        await this.#openExternal(flow.verificationUriComplete);
      } catch {
        // Opening a desktop browser is convenience only; it must not reveal a
        // private flow value or abort the manual device-code path.
      }
    }

    flow.completion = this.#poll(flow);
    return toPublicFlow(flow);
  }

  get(connectionId: string, flowId: string): XaiOAuthFlowPublic | null {
    const flow = this.#flow(connectionId, flowId);
    if (flow !== null) return toPublicFlow(flow);
    const terminal = this.#terminalFlow(connectionId, flowId);
    return terminal === null ? null : { ...terminal.value };
  }

  async cancel(connectionId: string, flowId: string): Promise<void> {
    const flow = this.#flow(connectionId, flowId);
    if (flow === null || isTerminal(flow.status)) return;
    flow.status = "cancelled";
    flow.controller.abort();
    await flow.completion;
  }

  async waitForTerminal(connectionId: string, flowId: string): Promise<XaiOAuthFlowPublic> {
    const flow = this.#flow(connectionId, flowId);
    if (flow === null) {
      const terminal = this.#terminalFlow(connectionId, flowId);
      if (terminal !== null) return { ...terminal.value };
      throw new XaiOAuthFlowError("oauth_flow_expired");
    }
    await flow.completion;
    const terminal = this.#terminalFlow(connectionId, flowId);
    return terminal === null ? toPublicFlow(flow) : { ...terminal.value };
  }

  async credentialStatus(connectionId: string): Promise<XaiOAuthCredentialStatus> {
    const credentials = await this.#safeReadCredentials(connectionId);
    if (credentials === null) return "authentication-required";
    return isExpiring(credentials.expiresAt, this.#now()) ? "expired" : "ready";
  }

  async getAccessToken(connectionId: string): Promise<string> {
    const safeConnectionId = requiredConnectionId(connectionId);
    const credentials = await this.#safeReadCredentials(safeConnectionId);
    if (credentials === null) throw new XaiOAuthFlowError("credential_rejected");
    if (!isExpiring(credentials.expiresAt, this.#now())) return credentials.accessToken;

    const current = this.#refreshes.get(safeConnectionId);
    if (current !== undefined) return current;
    const refresh = this.#refreshCredentials(safeConnectionId, credentials);
    this.#refreshes.set(safeConnectionId, refresh);
    try {
      return await refresh;
    } finally {
      this.#refreshes.delete(safeConnectionId);
    }
  }

  async disconnect(connectionId: string): Promise<XaiOAuthDisconnectResult> {
    const safeConnectionId = requiredConnectionId(connectionId);
    for (const flow of this.#flows.values()) {
      if (flow.connectionId === safeConnectionId && !isTerminal(flow.status)) {
        flow.status = "cancelled";
        flow.controller.abort();
      }
    }

    const credentials = await this.#safeReadCredentials(safeConnectionId);
    if (credentials === null) return "local_removed";
    let result: XaiOAuthDisconnectResult = "revoked";
    await this.#withRedaction(
      `connections/xai-oauth/revoke/${safeConnectionId}`,
      [credentials.accessToken, credentials.refreshToken],
      async () => {
        try {
          await this.#transport.revoke({
            url: XAI_REVOCATION_URL,
            clientId: XAI_PUBLIC_OAUTH_PRESET.clientId,
            token: credentials.refreshToken,
            signal: new AbortController().signal,
          });
        } catch {
          result = "revoke_pending";
        }
      },
    );
    try {
      await this.#credentialStore.delete(safeConnectionId);
    } catch {
      throw new XaiOAuthFlowError("secure_storage_unavailable");
    }
    return result;
  }

  async #poll(flow: PrivateFlow): Promise<void> {
    try {
      while (flow.status === "pending-device") {
        const remaining = flow.expiresAtMs - this.#now().getTime();
        if (remaining <= 0) {
          flow.status = "expired";
          return;
        }
        try {
          await this.#awaitFlowOperation(
            flow,
            this.#sleep(Math.min(flow.intervalMs, remaining), flow.controller.signal),
          );
        } catch (error) {
          if (this.#finishForPollingLimit(flow, error)) return;
          flow.intervalMs += SLOW_DOWN_INCREMENT_MS;
          continue;
        }
        if (flow.controller.signal.aborted) {
          flow.status = "cancelled";
          return;
        }
        if (flow.expiresAtMs <= this.#now().getTime()) {
          flow.status = "expired";
          return;
        }

        let token: XaiTokenResult;
        try {
          token = await this.#awaitFlowOperation(flow, this.#transport.requestToken({
            url: XAI_TOKEN_URL,
            clientId: XAI_PUBLIC_OAUTH_PRESET.clientId,
            grantType: DEVICE_GRANT,
            deviceCode: flow.deviceCode,
            signal: flow.controller.signal,
          }));
        } catch (error) {
          if (this.#finishForPollingLimit(flow, error)) return;
          flow.intervalMs += SLOW_DOWN_INCREMENT_MS;
          continue;
        }
        if (flow.controller.signal.aborted || flow.status !== "pending-device") {
          flow.status = "cancelled";
          return;
        }
        if (isTokenError(token)) {
          if (token.error === "authorization_pending") continue;
          if (token.error === "slow_down") {
            flow.intervalMs += SLOW_DOWN_INCREMENT_MS;
            continue;
          }
          flow.status = terminalStatusForTokenError(token.error);
          return;
        }

        const credentials = credentialsFromToken(token, this.#now());
        if (credentials === null) {
          flow.status = "failed";
          return;
        }
        if (flow.expiresAtMs <= this.#now().getTime()) {
          flow.status = "expired";
          return;
        }
        flow.status = "exchanging";
        try {
          await this.#writeCredentials(flow.connectionId, credentials);
          if (flow.controller.signal.aborted || flow.status !== "exchanging") {
            await this.#deleteAfterFailedRotation(flow.connectionId);
            flow.status = "cancelled";
            return;
          }
          flow.status = "completed";
        } catch {
          flow.status = "failed";
        }
        return;
      }
    } finally {
      if (isTerminal(flow.status)) {
        this.#archiveTerminalFlow(flow);
        try {
          this.#redactor.unregister(flow.redactionScope);
        } catch {
          // Redactor cleanup cannot alter the OAuth outcome or reveal data.
        }
      }
    }
  }

  async #refreshCredentials(
    connectionId: string,
    existing: XaiOAuthCredentials,
  ): Promise<string> {
    let token: XaiTokenResult;
    try {
      token = await this.#withRedaction(
        `connections/xai-oauth/refresh/${connectionId}`,
        [existing.accessToken, existing.refreshToken],
        async () => this.#transport.requestToken({
          url: XAI_TOKEN_URL,
          clientId: XAI_PUBLIC_OAUTH_PRESET.clientId,
          grantType: "refresh_token",
          refreshToken: existing.refreshToken,
          signal: new AbortController().signal,
        }),
      );
    } catch {
      // A network error after the upstream accepted a refresh can leave the
      // server-side refresh token rotated. Never retry the old pair.
      await this.#deleteAfterFailedRotation(connectionId);
      throw new XaiOAuthFlowError("credential_expired");
    }
    if (isTokenError(token) || !isNonEmptyText(token.accessToken)) {
      if (isTokenError(token) && token.error === "invalid_grant") {
        await this.#deleteAfterFailedRotation(connectionId);
        throw new XaiOAuthFlowError("credential_expired");
      }
      throw new XaiOAuthFlowError("credential_expired");
    }
    const credentials = credentialsFromToken(token, this.#now(), existing.refreshToken);
    if (credentials === null) throw new XaiOAuthFlowError("credential_expired");
    try {
      await this.#writeCredentials(connectionId, credentials);
    } catch {
      await this.#deleteAfterFailedRotation(connectionId);
      throw new XaiOAuthFlowError("credential_expired");
    }
    return credentials.accessToken;
  }

  async #writeCredentials(connectionId: string, credentials: XaiOAuthCredentials): Promise<void> {
    await this.#withRedaction(
      `connections/xai-oauth/credentials/${connectionId}`,
      [credentials.accessToken, credentials.refreshToken],
      async () => this.#credentialStore.put(connectionId, { ...credentials }),
    );
  }

  async #deleteAfterFailedRotation(connectionId: string): Promise<void> {
    try {
      await this.#credentialStore.delete(connectionId);
    } catch {
      // A failed cleanup must not make a failed refresh appear usable.
    }
  }

  async #safeReadCredentials(connectionId: string): Promise<XaiOAuthCredentials | null> {
    try {
      const credentials = await this.#credentialStore.get(requiredConnectionId(connectionId));
      return credentials === null ? null : validCredentials(credentials) ? { ...credentials } : null;
    } catch {
      throw new XaiOAuthFlowError("secure_storage_unavailable");
    }
  }

  async #withRedaction<T>(
    scope: string,
    values: readonly string[],
    callback: () => Promise<T>,
  ): Promise<T> {
    this.#redactor.register(scope, values);
    try {
      return await callback();
    } finally {
      this.#redactor.unregister(scope);
    }
  }

  #flow(connectionId: string, flowId: string): PrivateFlow | null {
    if (!isNonEmptyText(connectionId) || !isNonEmptyText(flowId)) return null;
    const flow = this.#flows.get(flowId);
    return flow?.connectionId === connectionId ? flow : null;
  }

  #terminalFlow(connectionId: string, flowId: string): TerminalFlow | null {
    if (!isNonEmptyText(connectionId) || !isNonEmptyText(flowId)) return null;
    const terminal = this.#terminalFlows.get(flowId);
    return terminal?.connectionId === connectionId ? terminal : null;
  }

  #archiveTerminalFlow(flow: PrivateFlow): void {
    this.#terminalFlows.set(flow.id, {
      connectionId: flow.connectionId,
      value: toPublicFlow(flow),
    });
    this.#flows.delete(flow.id);
    // The safe terminal DTO above is all that needs to survive polling. Clear
    // the one-time values even while a caller still holds the local flow ref.
    flow.deviceCode = "";
    flow.verificationUriComplete = null;
  }

  async #awaitFlowOperation<T>(flow: PrivateFlow, operation: Promise<T>): Promise<T> {
    const remaining = flow.expiresAtMs - this.#now().getTime();
    try {
      return await raceWithLimits(operation, {
        signal: flow.controller.signal,
        deadlineMs: remaining,
      });
    } catch (error) {
      if (error instanceof OAuthOperationDeadlineError) flow.controller.abort();
      throw error;
    }
  }

  #finishForPollingLimit(flow: PrivateFlow, error: unknown): boolean {
    if (error instanceof OAuthOperationDeadlineError) {
      flow.status = "expired";
      return true;
    }
    if (error instanceof OAuthOperationAbortedError || flow.controller.signal.aborted) {
      flow.status = "cancelled";
      return true;
    }
    return false;
  }
}

function normalizeDeviceResponse(value: XaiDeviceCodeResponse): Omit<XaiDeviceCodeResponse, "verificationUriComplete"> & {
  verificationUriComplete: string | null;
} {
  if (
    !isNonEmptyText(value?.deviceCode) ||
    !isNonEmptyText(value?.verificationUri) ||
    !isNonEmptyText(value?.userCode) ||
    !Number.isFinite(value?.expiresIn) ||
    value.expiresIn <= 0
  ) throw new XaiOAuthFlowError("oauth_metadata_invalid");
  const verificationUrl = safeVerificationUrl(value.verificationUri);
  if (verificationUrl === null) throw new XaiOAuthFlowError("oauth_metadata_invalid");
  const verificationUriComplete = value.verificationUriComplete === undefined
    ? null
    : safeCompleteVerificationUrl(value.verificationUriComplete);
  if (value.verificationUriComplete !== undefined && verificationUriComplete === null) {
    throw new XaiOAuthFlowError("oauth_metadata_invalid");
  }
  return {
    ...value,
    verificationUri: verificationUrl,
    verificationUriComplete,
  };
}

function safeVerificationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== XAI_PUBLIC_OAUTH_PRESET.issuer) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function safeCompleteVerificationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === XAI_PUBLIC_OAUTH_PRESET.issuer ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeInterval(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value * 1_000)
    : DEFAULT_POLL_INTERVAL_MS;
}

function toPublicFlow(flow: PrivateFlow): XaiOAuthFlowPublic {
  return {
    flowId: flow.id,
    status: flow.status,
    verificationUrl: flow.verificationUrl,
    userCode: flow.userCode,
    expiresAt: new Date(flow.expiresAtMs).toISOString(),
  };
}

function isTerminal(status: XaiOAuthFlowStatus): boolean {
  return status !== "pending-device" && status !== "exchanging";
}

function isTokenError(value: XaiTokenResult): value is XaiTokenError {
  return "error" in value;
}

function terminalStatusForTokenError(error: string): XaiOAuthFlowStatus {
  if (error === "access_denied") return "denied";
  if (error === "expired_token") return "expired";
  return "failed";
}

function credentialsFromToken(
  value: XaiTokenSuccess,
  now: Date,
  previousRefreshToken?: string,
): XaiOAuthCredentials | null {
  if (!isNonEmptyText(value.accessToken)) return null;
  const refreshToken = isNonEmptyText(value.refreshToken) ? value.refreshToken : previousRefreshToken;
  if (!isNonEmptyText(refreshToken)) return null;
  return {
    accessToken: value.accessToken,
    refreshToken,
    expiresAt: typeof value.expiresIn === "number" && Number.isFinite(value.expiresIn) && value.expiresIn > 0
      ? new Date(now.getTime() + Math.floor(value.expiresIn * 1_000)).toISOString()
      : null,
  };
}

function validCredentials(value: XaiOAuthCredentials): boolean {
  return isNonEmptyText(value.accessToken) &&
    isNonEmptyText(value.refreshToken) &&
    (value.expiresAt === null || Number.isFinite(new Date(value.expiresAt).getTime()));
}

function isExpiring(expiresAt: string | null, now: Date): boolean {
  if (expiresAt === null) return false;
  const timestamp = new Date(expiresAt).getTime();
  return !Number.isFinite(timestamp) || timestamp <= now.getTime() + REFRESH_SKEW_MS;
}

function requiredConnectionId(value: string): string {
  if (!isNonEmptyText(value)) throw new XaiOAuthFlowError("protocol_unsupported");
  return value;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001F\u007F]/.test(value);
}

interface OAuthHttpPayload {
  ok: boolean;
  status: number;
  data: unknown | null;
}

async function postOAuthForm(
  transport: typeof fetch,
  url: string,
  body: URLSearchParams,
  upstreamSignal: AbortSignal,
  timeoutMs: number,
): Promise<OAuthHttpPayload> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  if (upstreamSignal.aborted) abort();
  else upstreamSignal.addEventListener("abort", abort, { once: true });
  try {
    let response: Response;
    try {
      response = await raceWithLimits(
        Promise.resolve().then(() => transport(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          redirect: "error",
          signal: controller.signal,
        })),
        { signal: controller.signal },
      );
    } catch {
      throw new XaiOAuthFlowError("provider_unreachable");
    }
    const text = await readBoundedResponse(response, controller.signal);
    if (text === null) throw new XaiOAuthFlowError("provider_unreachable");
    if (text.length === 0) return { ok: response.ok, status: response.status, data: null };
    try {
      return { ok: response.ok, status: response.status, data: JSON.parse(text) };
    } catch {
      throw new XaiOAuthFlowError("oauth_metadata_invalid");
    }
  } finally {
    clearTimeout(timer);
    upstreamSignal.removeEventListener("abort", abort);
  }
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string | null> {
  if (response.body === null) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    return null;
  }
  const cancelReader = () => {
    try {
      void Promise.resolve(reader.cancel()).catch(() => undefined);
    } catch {
      // A misbehaving stream must not delay the safe timeout/cancellation path.
    }
  };
  if (signal.aborted) {
    cancelReader();
    return null;
  }
  signal.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await raceWithLimits(reader.read(), { signal });
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > OAUTH_RESPONSE_LIMIT_BYTES) {
        cancelReader();
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", cancelReader);
  }
  return new TextDecoder().decode(concatBytes(chunks, bytes));
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function validHttpTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, OAUTH_HTTP_TIMEOUT_MS)
    : OAUTH_HTTP_TIMEOUT_MS;
}

function safeHttpError(status: number): SafeProviderErrorCode {
  if (status === 401) return "credential_rejected";
  if (status === 403) return "endpoint_access_denied";
  if (status === 429) return "rate_limited";
  if (status >= 500 || status === 408 || status === 504) return "provider_unreachable";
  return "oauth_metadata_invalid";
}

function asRecord(value: unknown): Record<string, unknown> {
  const record = asRecordOrNull(value);
  if (record === null) throw new XaiOAuthFlowError("oauth_metadata_invalid");
  return record;
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: unknown): string {
  if (!isNonEmptyText(value)) throw new XaiOAuthFlowError("oauth_metadata_invalid");
  return value;
}

function numberField(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new XaiOAuthFlowError("oauth_metadata_invalid");
  }
  return value;
}

/**
 * Races an untrusted promise with cancellation/deadline signals while keeping
 * a rejection handler on the original operation. Some fetch/stream shims
 * ignore AbortSignal; without this race an OAuth cancel could hang forever.
 */
function raceWithLimits<T>(
  operation: Promise<T>,
  limits: { signal?: AbortSignal; deadlineMs?: number },
): Promise<T> {
  // The race may settle before an uncooperative implementation eventually
  // rejects. Keep that rejection consumed rather than surfacing it later.
  void operation.catch(() => undefined);

  const pending: Array<Promise<T>> = [operation];
  let onAbort: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  if (limits.signal !== undefined) {
    pending.push(new Promise<T>((_resolve, reject) => {
      onAbort = () => reject(new OAuthOperationAbortedError());
      if (limits.signal!.aborted) onAbort();
      else limits.signal!.addEventListener("abort", onAbort, { once: true });
    }));
  }
  if (limits.deadlineMs !== undefined) {
    pending.push(new Promise<T>((_resolve, reject) => {
      if (!Number.isFinite(limits.deadlineMs) || limits.deadlineMs! <= 0) {
        reject(new OAuthOperationDeadlineError());
        return;
      }
      deadline = setTimeout(() => reject(new OAuthOperationDeadlineError()), limits.deadlineMs);
    }));
  }

  return Promise.race(pending).finally(() => {
    if (onAbort !== undefined && limits.signal !== undefined) {
      limits.signal.removeEventListener("abort", onAbort);
    }
    if (deadline !== undefined) clearTimeout(deadline);
  });
}

function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
