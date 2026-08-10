import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { SafeProviderErrorCode } from "@csb/shared";
import { redactText } from "../redaction.js";

export interface AppServerNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface AppServerJsonRpc {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  onNotification?(listener: (notification: AppServerNotification) => void): () => void;
}

/** Minimal newline-delimited transport used by the official Codex app-server. */
export interface AppServerLineTransport {
  send(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): void;
}

export interface CodexAppServerJsonRpc extends AppServerJsonRpc {
  onNotification(listener: (notification: AppServerNotification) => void): () => void;
  close(): void;
}

export interface CodexAppServerJsonRpcOptions {
  /** Injection seam for deterministic tests; production starts `codex app-server --stdio`. */
  transport?: AppServerLineTransport;
  createTransport?: () => AppServerLineTransport;
  timeoutMs?: number;
}

export interface CodexDeviceLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface CodexBrowserLogin {
  loginId: string;
  authUrl: string;
}

export interface CodexLoginState {
  flowId: string;
  status: "pending" | "completed" | "cancelled" | "expired" | "denied" | "failed";
}

export interface CodexAccount {
  status: "ready" | "expired" | "unavailable";
  planLabel: string | null;
  syncedAt: string;
}

/** The only account/login fields allowed to cross the app-server persistence boundary. */
export interface CodexAppServerSafeState {
  loginId: string | null;
  status: CodexLoginState["status"] | CodexAccount["status"];
  planLabel: string | null;
  syncedAt: string;
}

export interface CodexAppServerStateSink {
  record(state: CodexAppServerSafeState): void;
}

export interface CodexAppServerBridgeOptions {
  now?: () => Date;
  stateSink?: CodexAppServerStateSink;
}

export interface CodexRuntimeModel {
  id: string;
  displayName: string;
}

export class CodexAppServerBridgeError extends Error {
  constructor(
    readonly code: SafeProviderErrorCode,
    readonly diagnostic: string,
  ) {
    super(code);
    this.name = "CodexAppServerBridgeError";
  }
}

const APP_SERVER_TIMEOUT_MS = 20_000;
const APP_SERVER_LINE_CAP_BYTES = 2 * 1024 * 1024;

/**
 * A deliberately small Codex app-server JSON-RPC client. The app-server wire
 * uses newline-delimited request objects without a `jsonrpc` field. It always
 * initializes before an account or model request and never records stderr.
 */
export function createCodexAppServerJsonRpc(
  options: CodexAppServerJsonRpcOptions = {},
): CodexAppServerJsonRpc {
  return new StdioCodexAppServerJsonRpc(options);
}

class StdioCodexAppServerJsonRpc implements CodexAppServerJsonRpc {
  readonly #makeTransport: () => AppServerLineTransport;
  readonly #timeoutMs: number;
  readonly #notificationListeners = new Set<(notification: AppServerNotification) => void>();
  readonly #pending = new Map<number, PendingRequest>();
  #transport: AppServerLineTransport | undefined;
  #initialized: Promise<void> | undefined;
  #nextId = 1;
  #lineSubscription: (() => void) | undefined;
  #closeSubscription: (() => void) | undefined;

  constructor(options: CodexAppServerJsonRpcOptions) {
    this.#makeTransport = options.createTransport ?? (() => options.transport ?? createStdioTransport());
    this.#timeoutMs = validTimeout(options.timeoutMs);
    if (options.transport !== undefined) this.#bind(options.transport);
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (typeof method !== "string" || method.length === 0 || !isSafeParams(params)) {
      throw new Error("invalid app-server request");
    }
    this.#ensureTransport();
    if (method !== "initialize") await this.#ensureInitialized();
    return this.#send(method, params);
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  close(): void {
    this.#failAll();
    this.#lineSubscription?.();
    this.#closeSubscription?.();
    this.#lineSubscription = undefined;
    this.#closeSubscription = undefined;
    this.#transport?.close();
    this.#transport = undefined;
    this.#initialized = undefined;
  }

  #ensureTransport(): AppServerLineTransport {
    if (this.#transport !== undefined) return this.#transport;
    const transport = this.#makeTransport();
    this.#bind(transport);
    return transport;
  }

  #bind(transport: AppServerLineTransport): void {
    this.#transport = transport;
    this.#lineSubscription = transport.onLine((line) => this.#handleLine(line));
    this.#closeSubscription = transport.onClose(() => this.#failAll());
  }

  async #ensureInitialized(): Promise<void> {
    if (this.#initialized === undefined) {
      this.#initialized = this.#send("initialize", {
        clientInfo: { name: "okami-sentinel", version: "0.1.0" },
      }).then(() => undefined, (error) => {
        this.#initialized = undefined;
        throw error;
      });
    }
    await this.#initialized;
  }

  #send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("app-server request timed out"));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#ensureTransport().send(`${payload}\n`);
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new Error("app-server transport unavailable"));
      }
    });
  }

  #handleLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > APP_SERVER_LINE_CAP_BYTES) {
      this.#failAll();
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (typeof message.method === "string" && message.id === undefined) {
      const params = isSafeParams(message.params) ? message.params : {};
      for (const listener of this.#notificationListeners) listener({ method: message.method, params });
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(new Error("app-server RPC failed"));
      return;
    }
    pending.resolve(message.result);
  }

  #failAll(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("app-server transport unavailable"));
    }
    this.#pending.clear();
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: NodeJS.Timeout;
}

function validTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, APP_SERVER_TIMEOUT_MS)
    : APP_SERVER_TIMEOUT_MS;
}

function isSafeParams(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createStdioTransport(): AppServerLineTransport {
  const child = spawn("codex", ["app-server", "--stdio"], {
    cwd: process.cwd(),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new ChildLineTransport(child);
}

class ChildLineTransport implements AppServerLineTransport {
  readonly #lineListeners = new Set<(line: string) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();
  #buffer = "";
  #closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#read(chunk));
    // Drain stderr without retaining arbitrary app-server diagnostics.
    child.stderr.on("data", () => undefined);
    child.once("error", () => this.#close());
    child.once("exit", () => this.#close());
  }

  send(line: string): void {
    if (this.#closed || !this.child.stdin.writable) throw new Error("app-server transport closed");
    this.child.stdin.write(line);
  }

  onLine(listener: (line: string) => void): () => void {
    this.#lineListeners.add(listener);
    return () => this.#lineListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    if (!this.#closed) this.child.kill();
    this.#close();
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      for (const listener of this.#lineListeners) listener(line);
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > APP_SERVER_LINE_CAP_BYTES) this.#close();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
    this.#closeListeners.clear();
  }
}

/**
 * Narrow façade over Codex app-server. It intentionally returns only fields a
 * caller needs to render a device-login journey; Codex retains OAuth tokens.
 */
export class CodexAppServerBridge {
  readonly #flows = new Map<string, CodexLoginState>();
  readonly #now: () => Date;
  readonly #stateSink: CodexAppServerStateSink;
  #unsubscribe: (() => void) | undefined;
  #lastSyncedAt: string | null = null;
  #planLabel: string | null = null;

  constructor(
    private readonly rpc: AppServerJsonRpc,
    options: CodexAppServerBridgeOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#stateSink = options.stateSink ?? NOOP_STATE_SINK;
    this.#unsubscribe = rpc.onNotification?.((notification) => this.handleNotification(notification));
  }

  async startDeviceLogin(): Promise<CodexDeviceLogin> {
    try {
      const response = asRecord(await this.rpc.request("account/login/start", {
        type: "chatgptDeviceCode",
      }));
      const loginId = requiredIdentifier(response.loginId);
      const login = {
        loginId,
        verificationUrl: requiredHttpsUrl(response.verificationUrl),
        userCode: requiredText(response.userCode),
      };
      this.#flows.set(loginId, { flowId: loginId, status: "pending" });
      this.#recordState(loginId, "pending");
      return login;
    } catch (error) {
      throw normalizeBridgeError(error);
    }
  }

  async startBrowserLogin(): Promise<CodexBrowserLogin> {
    try {
      const response = asRecord(await this.rpc.request("account/login/start", { type: "chatgpt" }));
      const loginId = requiredIdentifier(response.loginId);
      const login = { loginId, authUrl: requiredHttpsUrl(response.authUrl) };
      this.#flows.set(loginId, { flowId: loginId, status: "pending" });
      this.#recordState(loginId, "pending");
      return login;
    } catch (error) {
      throw normalizeBridgeError(error);
    }
  }

  async cancelLogin(loginId: string): Promise<void> {
    try {
      const safeLoginId = requiredIdentifier(loginId);
      await this.rpc.request("account/login/cancel", { loginId: safeLoginId });
      this.#flows.set(safeLoginId, { flowId: safeLoginId, status: "cancelled" });
      this.#recordState(safeLoginId, "cancelled");
    } catch (error) {
      throw normalizeBridgeError(error);
    }
  }

  getLoginFlow(loginId: string): CodexLoginState | null {
    const flow = this.#flows.get(loginId);
    return flow === undefined ? null : { ...flow };
  }

  async readAccount(): Promise<CodexAccount> {
    try {
      const result = await this.rpc.request("account/read", {});
      const account = accountRecord(result);
      const summary = toCodexAccount(account, this.#now().toISOString());
      this.#lastSyncedAt = summary.syncedAt;
      this.#planLabel = summary.planLabel;
      this.#recordState(null, summary.status, summary.planLabel, summary.syncedAt);
      return summary;
    } catch (error) {
      throw normalizeBridgeError(error);
    }
  }

  async listModels(): Promise<readonly CodexRuntimeModel[]> {
    const models = new Map<string, CodexRuntimeModel>();
    let cursor: string | undefined;
    const visitedCursors = new Set<string>();

    try {
      for (let page = 0; page < 100; page += 1) {
        const response = asRecord(await this.rpc.request(
          "model/list",
          cursor === undefined ? {} : { cursor },
        ));
        for (const model of modelsFromResponse(response)) models.set(model.id, model);
        const next = nextCursor(response);
        if (next === undefined) {
          this.#lastSyncedAt = this.#now().toISOString();
          return [...models.values()];
        }
        if (visitedCursors.has(next)) {
          throw new CodexAppServerBridgeError("protocol_unsupported", "repeated model cursor");
        }
        visitedCursors.add(next);
        cursor = next;
      }
      throw new CodexAppServerBridgeError("protocol_unsupported", "model pagination limit reached");
    } catch (error) {
      throw normalizeBridgeError(error);
    }
  }

  handleNotification(notification: AppServerNotification): void {
    if (!notification || typeof notification.method !== "string") return;
    if (notification.method === "account/login/completed") {
      const loginId = optionalIdentifier(notification.params?.loginId);
      if (loginId === undefined) return;
      this.#flows.set(loginId, {
        flowId: loginId,
        status: notificationStatus(notification.params),
      });
      this.#recordState(loginId, notificationStatus(notification.params));
      return;
    }
    if (notification.method === "account/updated") {
      const syncedAt = this.#now().toISOString();
      this.#lastSyncedAt = syncedAt;
      try {
        const summary = toCodexAccount(accountRecord(notification.params), syncedAt);
        this.#planLabel = summary.planLabel;
        this.#recordState(null, summary.status, summary.planLabel, syncedAt);
      } catch {
        this.#recordState(null, "unavailable", this.#planLabel, syncedAt);
      }
    }
  }

  isStale(maxAgeMs = 5 * 60_000): boolean {
    if (this.#lastSyncedAt === null || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return true;
    return this.#now().getTime() - Date.parse(this.#lastSyncedAt) > maxAgeMs;
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  #recordState(
    loginId: string | null,
    status: CodexAppServerSafeState["status"],
    planLabel = this.#planLabel,
    syncedAt = this.#now().toISOString(),
  ): void {
    this.#stateSink.record({ loginId, status, planLabel, syncedAt });
  }
}

const NOOP_STATE_SINK: CodexAppServerStateSink = Object.freeze({
  record: () => undefined,
});

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex app-server returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1_000) {
    throw new CodexAppServerBridgeError("protocol_unsupported", "invalid app-server response");
  }
  return value.trim();
}

function requiredIdentifier(value: unknown): string {
  const identifier = requiredText(value);
  if (!/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(identifier)) {
    throw new CodexAppServerBridgeError("protocol_unsupported", "invalid app-server identifier");
  }
  return identifier;
}

function optionalIdentifier(value: unknown): string | undefined {
  try {
    return requiredIdentifier(value);
  } catch {
    return undefined;
  }
}

function requiredHttpsUrl(value: unknown): string {
  const url = requiredText(value);
  try {
    if (new URL(url).protocol !== "https:") throw new Error("non-https URL");
    return url;
  } catch {
    throw new CodexAppServerBridgeError("protocol_unsupported", "invalid app-server URL");
  }
}

function accountRecord(value: unknown): Record<string, unknown> | null {
  const response = asRecord(value);
  const account = response.account === undefined ? response : response.account;
  if (account === null) return null;
  return asRecord(account);
}

function toCodexAccount(account: Record<string, unknown> | null, syncedAt: string): CodexAccount {
  if (account === null) return { status: "unavailable", planLabel: null, syncedAt };
  const rawStatus = optionalText(account.status)?.toLowerCase();
  const status = rawStatus === "expired" || rawStatus === "logged_out"
    ? "expired"
    : "ready";
  return {
    status,
    planLabel: safePlanLabel(account.planLabel ?? account.planType ?? account.plan),
    syncedAt,
  };
}

function safePlanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return /^[a-z0-9][a-z0-9 ._-]{0,79}$/i.test(label) ? label : null;
}

function modelsFromResponse(response: Record<string, unknown>): CodexRuntimeModel[] {
  const rows = Array.isArray(response.data)
    ? response.data
    : Array.isArray(response.models)
      ? response.models
      : [];
  const models: CodexRuntimeModel[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const id = optionalModelId(record.id);
    if (id === undefined) continue;
    models.push({ id, displayName: optionalText(record.displayName ?? record.name) ?? id });
  }
  return models;
}

function optionalModelId(value: unknown): string | undefined {
  const id = optionalText(value);
  if (id === undefined || id.length > 200 || /[\u0000-\u001F\u007F]/.test(id)) return undefined;
  return id;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nextCursor(response: Record<string, unknown>): string | undefined {
  const cursor = optionalText(response.nextCursor ?? response.next_cursor);
  if (cursor === undefined) return undefined;
  if (cursor.length > 1_000 || /[\u0000-\u001F\u007F]/.test(cursor)) {
    throw new CodexAppServerBridgeError("protocol_unsupported", "invalid model cursor");
  }
  return cursor;
}

function notificationStatus(params: Record<string, unknown>): CodexLoginState["status"] {
  const value = optionalText(params.status)?.toLowerCase();
  if (value === "completed" || params.success === true) return "completed";
  if (value === "cancelled") return "cancelled";
  if (value === "expired") return "expired";
  if (value === "denied" || params.success === false) return "denied";
  return "failed";
}

function normalizeBridgeError(error: unknown): CodexAppServerBridgeError {
  if (error instanceof CodexAppServerBridgeError) return error;
  const diagnostic = redactText(error instanceof Error ? error.message : "app-server failure");
  return new CodexAppServerBridgeError("provider_unreachable", diagnostic);
}
