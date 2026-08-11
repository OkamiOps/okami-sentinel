import type { ModelReasoningEffort } from "@csb/shared";
import type {
  CursorBackgroundAgentCreateInput,
  CursorBackgroundAgentCreateResult,
  CursorBackgroundAgentRequest,
  CursorBackgroundAgentsClient,
  RemoteAgentJobStatus,
  RemoteAgentStatus,
} from "./remote-agent-job-runner.js";
import { reasoningEffortFromModelRecord } from "./model-reasoning-metadata.js";

/** The pinned origin documented for Cursor Cloud Agents API v1. */
export const CURSOR_CLOUD_AGENTS_ORIGIN = "https://api.cursor.com";
export const CURSOR_BACKGROUND_AGENT_TIMEOUT_MS = 8_000;
export const CURSOR_BACKGROUND_AGENT_RESPONSE_MAX_BYTES = 1_048_576;

export type CursorBackgroundFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface CursorBackgroundCatalogModel {
  id: string;
  displayName: string;
  reasoningEffort?: ModelReasoningEffort;
}

export type CursorBackgroundAgentsErrorCode =
  | "credential_rejected"
  | "endpoint_access_denied"
  | "rate_limited"
  | "provider_unreachable"
  | "run_not_cancellable"
  | "protocol_unsupported";

/** Deliberately omits response text, headers, and URLs. */
export class CursorBackgroundAgentsError extends Error {
  constructor(readonly code: CursorBackgroundAgentsErrorCode) {
    super(code);
    this.name = "CursorBackgroundAgentsError";
  }
}

export interface CursorBackgroundAgentsAdapter {
  create(input: CursorBackgroundAgentCreateInput): Promise<CursorBackgroundAgentCreateResult>;
  status(input: CursorBackgroundAgentRequest): Promise<RemoteAgentStatus>;
  cancel(input: CursorBackgroundAgentRequest): Promise<void>;
  listModels(input: { apiKey: string; signal?: AbortSignal }): Promise<readonly CursorBackgroundCatalogModel[]>;
}

export interface CursorBackgroundAgentsAdapterDependencies {
  transport?: CursorBackgroundFetch;
  timeoutMs?: number;
  responseMaxBytes?: number;
}

/**
 * Pinned v1 Cloud Agents client. This is intentionally not a Cursor CLI
 * wrapper, and it never retains credentials after the request settles.
 */
export function createCursorBackgroundAgentsAdapter(
  deps: CursorBackgroundAgentsAdapterDependencies = {},
): CursorBackgroundAgentsAdapter & CursorBackgroundAgentsClient {
  const transport = deps.transport ?? ((url, init) => fetch(url, init));
  const timeoutMs = positiveBoundedInteger(
    deps.timeoutMs ?? CURSOR_BACKGROUND_AGENT_TIMEOUT_MS,
    CURSOR_BACKGROUND_AGENT_TIMEOUT_MS,
  );
  const responseMaxBytes = positiveBoundedInteger(
    deps.responseMaxBytes ?? CURSOR_BACKGROUND_AGENT_RESPONSE_MAX_BYTES,
    CURSOR_BACKGROUND_AGENT_RESPONSE_MAX_BYTES,
  );

  return {
    async create(input) {
      validateCreateInput(input);
      const apiKey = requiredApiKey(input.apiKey);
      const selectedModelId = modelId(input.modelId, apiKey);
      const payload = await requestJson(
        transport,
        "/v1/agents",
        {
          method: "POST",
          apiKey,
          body: JSON.stringify({
            prompt: { text: input.instructions },
            repos: [{ url: input.repositoryUrl, startingRef: input.branch }],
            model: { id: selectedModelId },
          }),
          signal: input.signal,
        },
        timeoutMs,
        responseMaxBytes,
      );
      const response = record(payload);
      const agent = record(response.agent);
      const run = record(response.run);
      return {
        agentId: opaqueId(agent.id, apiKey),
        runId: opaqueId(run.id, apiKey),
        status: initialStatus(run.status),
      };
    },

    async status(input) {
      const apiKey = requiredApiKey(input.apiKey);
      const agentId = opaqueId(input.agentId);
      const runId = opaqueId(input.runId);
      const payload = await requestJson(
        transport,
        `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
        { method: "GET", apiKey, signal: input.signal },
        timeoutMs,
        responseMaxBytes,
      );
      const response = record(payload);
      if (opaqueId(response.id) !== runId || opaqueId(response.agentId) !== agentId) {
        throw new CursorBackgroundAgentsError("protocol_unsupported");
      }
      const status = remoteStatus(response.status);
      return { status, terminal: isTerminal(status) };
    },

    async cancel(input) {
      const apiKey = requiredApiKey(input.apiKey);
      const agentId = opaqueId(input.agentId);
      const runId = opaqueId(input.runId);
      const payload = await requestJson(
        transport,
        `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST", apiKey, signal: input.signal, allowRunNotCancellable: true },
        timeoutMs,
        responseMaxBytes,
      );
      if (opaqueId(record(payload).id) !== runId) {
        throw new CursorBackgroundAgentsError("protocol_unsupported");
      }
    },

    async listModels(input) {
      const payload = await requestJson(
        transport,
        "/v1/models",
        { method: "GET", apiKey: requiredApiKey(input.apiKey), signal: input.signal },
        timeoutMs,
        responseMaxBytes,
      );
      const items = record(payload).items;
      if (!Array.isArray(items)) throw new CursorBackgroundAgentsError("protocol_unsupported");
      const seen = new Set<string>();
      return items.map((item) => {
        const model = record(item);
        const id = modelId(model.id, input.apiKey);
        if (seen.has(id)) throw new CursorBackgroundAgentsError("protocol_unsupported");
        seen.add(id);
        const displayName = safeModelDisplayName(model.displayName, input.apiKey) ?? id;
        const reasoningEffort = reasoningEffortFromModelRecord(model, [input.apiKey]);
        return {
          id,
          displayName,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        };
      });
    },
  };
}

async function requestJson(
  transport: CursorBackgroundFetch,
  path: string,
  input: {
    method: "GET" | "POST";
    apiKey: string;
    body?: string;
    signal?: AbortSignal;
    allowRunNotCancellable?: boolean;
  },
  timeoutMs: number,
  responseMaxBytes: number,
): Promise<unknown> {
  const controlled = withDeadline(input.signal, timeoutMs);
  try {
    if (controlled.signal.aborted) throw new CursorBackgroundAgentsError("provider_unreachable");
    let response: Response;
    try {
      const pendingResponse = transport(`${CURSOR_CLOUD_AGENTS_ORIGIN}${path}`, {
        method: input.method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: input.body }),
        signal: controlled.signal,
      });
      void pendingResponse.then(
        (lateResponse) => {
          if (controlled.signal.aborted) cancelBody(lateResponse.body);
        },
        () => undefined,
      ).catch(() => undefined);
      response = await awaitWithin(pendingResponse, controlled.signal);
    } catch (error) {
      if (controlled.signal.aborted) throw new CursorBackgroundAgentsError("provider_unreachable");
      throw normalizeTransportError(error);
    }
    if (!response.ok) throw statusError(response.status, input.allowRunNotCancellable === true);
    const text = await readBoundedText(response, responseMaxBytes, controlled.signal);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CursorBackgroundAgentsError("protocol_unsupported");
    }
  } finally {
    controlled.dispose();
  }
}

function withDeadline(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (response.body === null) throw new CursorBackgroundAgentsError("protocol_unsupported");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await awaitWithin(reader.read(), signal, () => cancelReader(reader));
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        cancelReader(reader);
        throw new CursorBackgroundAgentsError("protocol_unsupported");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof CursorBackgroundAgentsError) throw error;
    throw new CursorBackgroundAgentsError("provider_unreachable");
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function statusError(status: number, allowRunNotCancellable: boolean): CursorBackgroundAgentsError {
  if (status === 401) return new CursorBackgroundAgentsError("credential_rejected");
  if (status === 403) return new CursorBackgroundAgentsError("endpoint_access_denied");
  if (status === 429) return new CursorBackgroundAgentsError("rate_limited");
  if (status >= 500) return new CursorBackgroundAgentsError("provider_unreachable");
  if (status === 409 && allowRunNotCancellable) return new CursorBackgroundAgentsError("run_not_cancellable");
  return new CursorBackgroundAgentsError("protocol_unsupported");
}

function validateCreateInput(input: CursorBackgroundAgentCreateInput): void {
  if (!isGithubRepositoryUrl(input.repositoryUrl) ||
      !isSafeText(input.branch, 240) ||
      !isSafeText(input.instructions, 32_000) ||
      !isSafeText(input.modelId, 240) ||
      !(input.signal instanceof AbortSignal)) {
    throw new CursorBackgroundAgentsError("protocol_unsupported");
  }
}

async function awaitWithin<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (signal.aborted) {
    onAbort?.();
    consumeLate(operation);
    throw new CursorBackgroundAgentsError("provider_unreachable");
  }
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      onAbort?.();
      consumeLate(operation);
      reject(new CursorBackgroundAgentsError("provider_unreachable"));
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
}

function consumeLate(operation: Promise<unknown>): void {
  void operation.then(() => undefined, () => undefined);
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().then(() => undefined, () => undefined);
  } catch {
    // Abort is still terminal even when an upstream body refuses cancellation.
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body === null) return;
  try {
    void body.cancel().then(() => undefined, () => undefined);
  } catch {
    // The late response is deliberately discarded either way.
  }
}

function normalizeTransportError(error: unknown): CursorBackgroundAgentsError {
  if (error instanceof CursorBackgroundAgentsError) return error;
  return new CursorBackgroundAgentsError("provider_unreachable");
}

function initialStatus(value: unknown): "queued" | "running" {
  const status = remoteStatus(value);
  if (status === "queued" || status === "running") return status;
  throw new CursorBackgroundAgentsError("protocol_unsupported");
}

function remoteStatus(value: unknown): RemoteAgentJobStatus {
  switch (value) {
    case "CREATING":
    case "QUEUED":
      return "queued";
    case "RUNNING":
      return "running";
    case "FINISHED":
      return "completed";
    case "ERROR":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    case "EXPIRED":
      return "expired";
    default:
      throw new CursorBackgroundAgentsError("protocol_unsupported");
  }
}

function isTerminal(status: RemoteAgentJobStatus): boolean {
  return status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired";
}

function requiredApiKey(value: unknown): string {
  return requiredText(value, 4_096);
}

function isGithubRepositoryUrl(value: unknown): value is string {
  if (!isSafeText(value, 2_048)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return false;
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return false;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part));
  } catch {
    return false;
  }
}

function opaqueId(value: unknown, forbidden?: string): string {
  const text = requiredText(value, 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(text) ||
      forbidden !== undefined && text.includes(forbidden)) {
    throw new CursorBackgroundAgentsError("protocol_unsupported");
  }
  return text;
}

function modelId(value: unknown, forbidden: string): string {
  const text = requiredText(value, 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/.test(text) || text.includes(forbidden)) {
    throw new CursorBackgroundAgentsError("protocol_unsupported");
  }
  return text;
}

function safeModelDisplayName(value: unknown, forbidden: string): string | undefined {
  const text = optionalText(value);
  return text === undefined || text.includes(forbidden) ? undefined : text;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > 240 || /[\u0000-\u001F\u007F]/.test(text)) return undefined;
  return text;
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001F\u007F]/.test(value);
}

function requiredText(value: unknown, maxLength: number): string {
  const text = optionalText(value);
  if (text === undefined || text.length > maxLength) {
    throw new CursorBackgroundAgentsError("protocol_unsupported");
  }
  return text;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CursorBackgroundAgentsError("protocol_unsupported");
  }
  return value as Record<string, unknown>;
}

function positiveBoundedInteger(value: unknown, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new TypeError("Invalid Cursor Background Agents adapter limit");
  }
  return value as number;
}
