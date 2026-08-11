import { randomUUID } from "node:crypto";

import type {
  ModelCapabilities,
  ModelPricing,
  ProviderModel,
  SafeProviderError,
  SafeProviderErrorCode,
} from "@csb/shared";
import {
  connectionSecretValues,
  type ConnectionSecretBundle,
  type SecretRedactorRegistry,
} from "../credentials/credential-vault.js";
import { globalSecretRedactor } from "../redaction.js";

/** The only HTTP timeout used by live provider catalog discovery. */
export const HTTP_TIMEOUT_MS = 8_000;
/** A provider response must fit in memory before it can be parsed as JSON. */
export const HTTP_RESPONSE_LIMIT_BYTES = 1_024 * 1_024;
export const MAX_DISCOVERY_PAGES = 100;

export type HttpFetch = typeof fetch;

export interface SafeFetchJsonInput {
  /** Kept inside the adapter boundary; never copied into a result or error. */
  url: string;
  headers?: Record<string, string>;
  method?: "GET";
  /** Only exact loopback HTTP is allowed, and only when this is exactly true. */
  allowInsecureLocalhost?: boolean;
  /** Lets deterministic tests supply an in-memory transport. */
  transport?: HttpFetch;
  /** Selects the safe meaning of a 403 without exposing an upstream response. */
  forbiddenScope?: "endpoint" | "model";
  /** Values from the complete vault bundle, registered for the request lifetime. */
  secretValues?: readonly string[];
  redactor?: SecretRedactorRegistry;
}

export type SafeFetchJsonResult =
  | { data: unknown }
  | { safeError: SafeProviderError };

class HttpRequestAbortedError extends Error {}

export interface DiscoveryCredentials extends ConnectionSecretBundle {
  connectionId?: string;
  /** This is intentionally not persisted by this module. */
  allowInsecureLocalhost?: true;
  now?: () => Date;
  redactor?: SecretRedactorRegistry;
}

export interface DiscoveredProviderModel extends ProviderModel {
  /** Provider metadata is a display/probe hint, never a proved capability. */
  unverifiedHints?: {
    readonly supportedParameters: readonly string[];
    readonly pricingReported: boolean;
  };
}

export interface HttpModelDiscoveryResult {
  models: readonly DiscoveredProviderModel[];
  supportsRuntimeDefault: false;
  pageCount: number;
  safeError?: SafeProviderError;
}

interface PageResult {
  rows: readonly unknown[];
  next: CursorResult;
}

type CursorResult =
  | { kind: "done" }
  | { kind: "next"; value: string }
  | { kind: "invalid" };

interface CatalogRequest {
  url: string;
  headers: Record<string, string>;
  connectionId: string;
  allowInsecureLocalhost: boolean;
  now: () => Date;
  redactor?: SecretRedactorRegistry;
  secretValues: readonly string[];
  transport: HttpFetch;
  cursorQuery: string;
  readPage(payload: unknown): PageResult | null;
  normalize(
    rows: readonly unknown[],
    discoveredAt: string,
    sensitiveValues: readonly string[],
  ): DiscoveredProviderModel[];
}

const UNKNOWN_CAPABILITIES: ModelCapabilities = Object.freeze({
  tools: "unknown",
  artifactOutput: "unknown",
  structuredOutput: "unknown",
  boundedExecution: "unknown",
  osIsolation: "unknown",
  streaming: "unknown",
  usage: "unknown",
  cancellation: "unknown",
});

const OFFICIAL_GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const OFFICIAL_OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OFFICIAL_XAI_MODELS_URL = "https://api.x.ai/v1/models";
const OFFICIAL_DEEPSEEK_MODELS_URL = "https://api.deepseek.com/models";
const OFFICIAL_ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const OFFICIAL_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Fetches a JSON response with the provider boundary's non-negotiable safety
 * controls. The error union deliberately cannot retain response text, URLs,
 * headers, or credential values.
 */
export async function safeFetchJson(
  input: SafeFetchJsonInput,
): Promise<SafeFetchJsonResult> {
  const redactor = input.redactor ?? globalSecretRedactor;
  const scope = `connections/http/${randomUUID()}`;
  redactor.register(scope, secretValuesForRequest(input));

  try {
    if (!isPermittedProviderUrl(input.url, input.allowInsecureLocalhost === true)) {
      return safeError("protocol_unsupported");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await raceWithAbort(Promise.resolve().then(() => (input.transport ?? fetch)(input.url, {
          method: input.method ?? "GET",
          headers: input.headers,
          redirect: "error",
          signal: controller.signal,
        })), controller.signal);
      } catch {
        return safeError("provider_unreachable");
      }

      const responseError = safeErrorForHttpStatus(response.status, input.forbiddenScope ?? "endpoint");
      if (responseError !== null) return safeError(responseError);

      let text: string;
      try {
        text = await readBoundedResponse(response, HTTP_RESPONSE_LIMIT_BYTES, controller.signal);
      } catch (error) {
        if (error instanceof HttpRequestAbortedError) return safeError("provider_unreachable");
        return safeError("protocol_unsupported");
      }

      try {
        return { data: JSON.parse(text) as unknown };
      } catch {
        return safeError("protocol_unsupported");
      }
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    redactor.unregister(scope);
  }
}

/** Uses the complete vault bundle only during the supplied callback. */
export async function withBundleRedaction<T>(
  bundle: ConnectionSecretBundle,
  callback: (secretValues: readonly string[]) => Promise<T>,
  redactor: SecretRedactorRegistry = globalSecretRedactor,
): Promise<T> {
  const scope = `connections/http-bundle/${randomUUID()}`;
  const values = allBundleSecretValues(bundle);
  redactor.register(scope, values);
  try {
    return await callback(values);
  } finally {
    redactor.unregister(scope);
  }
}

/** OpenAI-compatible catalogs use only an authenticated `/models` result. */
export async function discoverOpenAiModels(
  credentials: DiscoveryCredentials,
  transport: HttpFetch = fetch,
): Promise<HttpModelDiscoveryResult> {
  const bundle = bundleFromCredentials(credentials);
  return withBundleRedaction(bundle, async (secretValues) => {
    const url = credentials.discoveryUrl ?? appendUrlPath(
      credentials.baseUrl ?? OFFICIAL_OPENAI_BASE_URL,
      "models",
    );
    if (url === null) return unsupportedDiscovery();

    return discoverCatalog({
      url,
      headers: bearerHeaders(credentials.headers, credentials.apiKey),
      connectionId: credentials.connectionId ?? "unbound",
      allowInsecureLocalhost: credentials.allowInsecureLocalhost === true,
      now: credentials.now ?? (() => new Date()),
      redactor: credentials.redactor,
      secretValues,
      transport,
      cursorQuery: "after",
      readPage: readOpenAiPage,
      normalize: (rows, discoveredAt, sensitiveValues) => normalizeOpenAiRows(rows, {
        connectionId: credentials.connectionId ?? "unbound",
        discoveredAt,
      }, sensitiveValues),
    });
  }, credentials.redactor);
}

/** xAI's API may return OpenAI-style `data` or a top-level `models` array. */
export async function discoverXaiModels(
  credentials: DiscoveryCredentials,
  transport: HttpFetch = fetch,
): Promise<HttpModelDiscoveryResult> {
  const bundle = bundleFromCredentials(credentials);
  return withBundleRedaction(bundle, async (secretValues) => discoverCatalog({
    url: OFFICIAL_XAI_MODELS_URL,
    headers: bearerHeaders(credentials.headers, credentials.apiKey),
    connectionId: credentials.connectionId ?? "unbound",
    allowInsecureLocalhost: false,
    now: credentials.now ?? (() => new Date()),
    redactor: credentials.redactor,
    secretValues,
    transport,
    cursorQuery: "after",
    readPage: readXaiPage,
    normalize: (rows, discoveredAt, sensitiveValues) => normalizeOpenAiRows(rows, {
      connectionId: credentials.connectionId ?? "unbound",
      discoveredAt,
    }, sensitiveValues),
  }), credentials.redactor);
}

/** Anthropic list pages are normalized without assigning a model fallback. */
export async function discoverAnthropicModels(
  credentials: DiscoveryCredentials,
  transport: HttpFetch = fetch,
  official = false,
): Promise<HttpModelDiscoveryResult> {
  const bundle = bundleFromCredentials(credentials);
  return withBundleRedaction(bundle, async (secretValues) => {
    const baseUrl = official ? OFFICIAL_ANTHROPIC_MODELS_URL : credentials.discoveryUrl ?? anthropicModelsUrl(credentials.baseUrl);
    if (baseUrl === null) return unsupportedDiscovery();
    const headers = mergeHeaders(credentials.headers, {
      ...(credentials.apiKey === undefined ? {} : { "x-api-key": credentials.apiKey }),
      "anthropic-version": "2023-06-01",
    });
    return discoverCatalog({
      url: baseUrl,
      headers,
      connectionId: credentials.connectionId ?? "unbound",
      allowInsecureLocalhost: credentials.allowInsecureLocalhost === true,
      now: credentials.now ?? (() => new Date()),
      redactor: credentials.redactor,
      secretValues,
      transport,
      cursorQuery: "after_id",
      readPage: readAnthropicPage,
      normalize: (rows, discoveredAt, sensitiveValues) => normalizeAnthropicRows(rows, {
        connectionId: credentials.connectionId ?? "unbound",
        discoveredAt,
      }, sensitiveValues),
    });
  }, credentials.redactor);
}

/** Gemini's `baseModelId` is the upstream-selected identifier sent to generation. */
export async function discoverGeminiModels(
  credentials: DiscoveryCredentials,
  transport: HttpFetch = fetch,
): Promise<HttpModelDiscoveryResult> {
  const bundle = bundleFromCredentials(credentials);
  return withBundleRedaction(bundle, async (secretValues) => discoverCatalog({
    url: OFFICIAL_GEMINI_MODELS_URL,
    headers: mergeHeaders(credentials.headers, credentials.apiKey === undefined
      ? {}
      : { "x-goog-api-key": credentials.apiKey }),
    connectionId: credentials.connectionId ?? "unbound",
    allowInsecureLocalhost: false,
    now: credentials.now ?? (() => new Date()),
    redactor: credentials.redactor,
    secretValues,
    transport,
    cursorQuery: "pageToken",
    readPage: readGeminiPage,
    normalize: (rows, discoveredAt, sensitiveValues) => normalizeGeminiRows(rows, {
      connectionId: credentials.connectionId ?? "unbound",
      discoveredAt,
    }, sensitiveValues),
  }), credentials.redactor);
}

/** OpenRouter metadata stays an unverified hint until an explicit probe proves it. */
export async function discoverOpenRouterModels(
  credentials: DiscoveryCredentials,
  transport: HttpFetch = fetch,
): Promise<HttpModelDiscoveryResult> {
  const bundle = bundleFromCredentials(credentials);
  return withBundleRedaction(bundle, async (secretValues) => discoverCatalog({
    url: OFFICIAL_OPENROUTER_MODELS_URL,
    headers: bearerHeaders(credentials.headers, credentials.apiKey),
    connectionId: credentials.connectionId ?? "unbound",
    allowInsecureLocalhost: false,
    now: credentials.now ?? (() => new Date()),
    redactor: credentials.redactor,
    secretValues,
    transport,
    cursorQuery: "after",
    readPage: readOpenRouterPage,
    normalize: (rows, discoveredAt, sensitiveValues) => normalizeOpenRouterRows(rows, {
      connectionId: credentials.connectionId ?? "unbound",
      discoveredAt,
    }, sensitiveValues),
  }), credentials.redactor);
}

/** DeepSeek's official Models endpoint is OpenAI-compatible but still live-only. */
export async function discoverDeepSeekModels(
  credentials: DiscoveryCredentials,
  transport: HttpFetch = fetch,
): Promise<HttpModelDiscoveryResult> {
  const bundle = bundleFromCredentials(credentials);
  return withBundleRedaction(bundle, async (secretValues) => discoverCatalog({
    url: OFFICIAL_DEEPSEEK_MODELS_URL,
    headers: bearerHeaders(credentials.headers, credentials.apiKey),
    connectionId: credentials.connectionId ?? "unbound",
    allowInsecureLocalhost: false,
    now: credentials.now ?? (() => new Date()),
    redactor: credentials.redactor,
    secretValues,
    transport,
    cursorQuery: "after",
    readPage: readOpenAiPage,
    normalize: (rows, discoveredAt, sensitiveValues) => normalizeOpenAiRows(rows, {
      connectionId: credentials.connectionId ?? "unbound",
      discoveredAt,
    }, sensitiveValues),
  }), credentials.redactor);
}

/** Returns a newly composed URL or null instead of accepting an invalid route. */
export function appendUrlPath(baseUrl: string, suffix: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    url.pathname += suffix.replace(/^\/+/, "");
    return url.toString();
  } catch {
    return null;
  }
}

export function safeErrorForHttpStatus(
  status: number,
  forbiddenScope: "endpoint" | "model" = "endpoint",
): SafeProviderErrorCode | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return "credential_rejected";
  if (status === 403) {
    return forbiddenScope === "model" ? "model_access_denied" : "endpoint_access_denied";
  }
  if (status === 429) return "rate_limited";
  if (status >= 500 || status === 408 || status === 504) return "provider_unreachable";
  return "protocol_unsupported";
}

export function unknownCapabilities(): ModelCapabilities {
  return { ...UNKNOWN_CAPABILITIES };
}

function bundleFromCredentials(credentials: DiscoveryCredentials): ConnectionSecretBundle {
  return {
    ...(credentials.apiKey === undefined ? {} : { apiKey: credentials.apiKey }),
    ...(credentials.baseUrl === undefined ? {} : { baseUrl: credentials.baseUrl }),
    ...(credentials.discoveryUrl === undefined ? {} : { discoveryUrl: credentials.discoveryUrl }),
    ...(credentials.headers === undefined ? {} : { headers: credentials.headers }),
  };
}

async function discoverCatalog(request: CatalogRequest): Promise<HttpModelDiscoveryResult> {
  let currentUrl = request.url;
  const visitedCursors = new Set<string>();
  const models: DiscoveredProviderModel[] = [];

  for (let pageCount = 1; pageCount <= MAX_DISCOVERY_PAGES; pageCount += 1) {
    const response = await safeFetchJson({
      url: currentUrl,
      headers: request.headers,
      allowInsecureLocalhost: request.allowInsecureLocalhost,
      transport: request.transport,
      secretValues: request.secretValues,
      redactor: request.redactor,
    });
    if ("safeError" in response) return failedDiscovery(response.safeError, pageCount - 1);

    const page = request.readPage(response.data);
    if (page === null || page.next.kind === "invalid") {
      return failedDiscovery({ code: "protocol_unsupported" }, pageCount - 1);
    }
    const bodySecrets = sensitiveBodyValues(response.data);
    const bodyScope = `connections/http-body/${randomUUID()}`;
    const redactor = request.redactor ?? globalSecretRedactor;
    redactor.register(bodyScope, bodySecrets);
    try {
      models.push(...request.normalize(
        page.rows,
        request.now().toISOString(),
        [...request.secretValues, ...bodySecrets],
      ));
    } finally {
      redactor.unregister(bodyScope);
    }
    if (page.next.kind === "done") return successfulDiscovery(models, pageCount);
    if (visitedCursors.has(page.next.value)) {
      return failedDiscovery({ code: "protocol_unsupported" }, pageCount);
    }
    visitedCursors.add(page.next.value);
    currentUrl = appendQuery(request.url, request.cursorQuery, page.next.value);
  }

  return failedDiscovery({ code: "protocol_unsupported" }, MAX_DISCOVERY_PAGES);
}

function readOpenAiPage(payload: unknown): PageResult | null {
  const record = recordOf(payload);
  if (record === null) return null;
  const rows = record.data;
  if (!Array.isArray(rows)) return null;
  return { rows, next: cursorFromHasMore(record, "last_id") };
}

function readXaiPage(payload: unknown): PageResult | null {
  const record = recordOf(payload);
  if (record === null) return null;
  const rows = record.data ?? record.models;
  if (!Array.isArray(rows)) return null;
  return { rows, next: cursorFromHasMore(record, "last_id") };
}

function readAnthropicPage(payload: unknown): PageResult | null {
  const record = recordOf(payload);
  if (record === null) return null;
  const rows = record.data;
  if (!Array.isArray(rows)) return null;
  return { rows, next: cursorFromHasMore(record, "last_id") };
}

function readGeminiPage(payload: unknown): PageResult | null {
  const record = recordOf(payload);
  if (record === null) return null;
  const rows = record.models;
  if (!Array.isArray(rows)) return null;
  const token = record.nextPageToken;
  if (token === undefined || token === null || token === "") return { rows, next: { kind: "done" } };
  return typeof token === "string" ? { rows, next: { kind: "next", value: token } } : null;
}

function readOpenRouterPage(payload: unknown): PageResult | null {
  const record = recordOf(payload);
  if (record === null) return null;
  const rows = record.data;
  if (!Array.isArray(rows)) return null;
  // OpenRouter's documented catalog is a single page. Never follow an arbitrary URL.
  return { rows, next: { kind: "done" } };
}

function cursorFromHasMore(
  record: Record<string, unknown>,
  cursorField: string,
): CursorResult {
  if (record.has_more !== true) return { kind: "done" };
  const cursor = record[cursorField];
  return typeof cursor === "string" && cursor.length > 0
    ? { kind: "next", value: cursor }
    : { kind: "invalid" };
}

function normalizeOpenAiRows(
  rows: readonly unknown[],
  metadata: { connectionId: string; discoveredAt: string },
  sensitiveValues: readonly string[],
): DiscoveredProviderModel[] {
  return normalizeRows(rows, metadata, (row) => ({
    id: stringAt(row, "id"),
    displayName: stringAt(row, "name") ?? stringAt(row, "id"),
    contextWindow: numberAt(row, "context_window") ?? numberAt(row, "context_length"),
    pricing: null,
  }), sensitiveValues);
}

function normalizeAnthropicRows(
  rows: readonly unknown[],
  metadata: { connectionId: string; discoveredAt: string },
  sensitiveValues: readonly string[],
): DiscoveredProviderModel[] {
  return normalizeRows(rows, metadata, (row) => ({
    id: stringAt(row, "id"),
    displayName: stringAt(row, "display_name") ?? stringAt(row, "id"),
    contextWindow: null,
    pricing: null,
  }), sensitiveValues);
}

function normalizeGeminiRows(
  rows: readonly unknown[],
  metadata: { connectionId: string; discoveredAt: string },
  sensitiveValues: readonly string[],
): DiscoveredProviderModel[] {
  return normalizeRows(rows, metadata, (row) => ({
    id: stringAt(row, "baseModelId"),
    displayName: stringAt(row, "displayName") ?? stringAt(row, "baseModelId"),
    contextWindow: numberAt(row, "inputTokenLimit"),
    pricing: null,
  }), sensitiveValues);
}

function normalizeOpenRouterRows(
  rows: readonly unknown[],
  metadata: { connectionId: string; discoveredAt: string },
  sensitiveValues: readonly string[],
): DiscoveredProviderModel[] {
  return normalizeRows(rows, metadata, (row) => {
    const supportedParameters = stringArrayAt(row, "supported_parameters");
    const pricing = openRouterPricing(recordOf(row)?.pricing);
    return {
      id: stringAt(row, "id"),
      displayName: stringAt(row, "name") ?? stringAt(row, "id"),
      contextWindow: numberAt(row, "context_length"),
      pricing,
      unverifiedHints: supportedParameters.length > 0 || pricing !== null
        ? { supportedParameters, pricingReported: pricing !== null }
        : undefined,
    };
  }, sensitiveValues);
}

function normalizeRows(
  rows: readonly unknown[],
  metadata: { connectionId: string; discoveredAt: string },
  fields: (row: Record<string, unknown>) => {
    id: string | null;
    displayName: string | null;
    contextWindow: number | null;
    pricing: ModelPricing | null;
    unverifiedHints?: DiscoveredProviderModel["unverifiedHints"];
  },
  sensitiveValues: readonly string[],
): DiscoveredProviderModel[] {
  const secrets = catalogSecretMatcher(sensitiveValues);
  const ids = new Set<string>();
  const normalized: DiscoveredProviderModel[] = [];
  for (const value of rows) {
    const row = recordOf(value);
    if (row === null) continue;
    const result = fields(row);
    if (result.id === null || secrets.contains(result.id) || ids.has(result.id)) continue;
    ids.add(result.id);
    normalized.push({
      connectionId: metadata.connectionId,
      id: result.id,
      displayName: secrets.redact(result.displayName ?? result.id),
      contextWindow: result.contextWindow,
      capabilities: unknownCapabilities(),
      pricing: result.pricing,
      discoveredAt: metadata.discoveredAt,
      source: "provider-api",
      ...(result.unverifiedHints === undefined ? {} : {
        unverifiedHints: {
          ...result.unverifiedHints,
          supportedParameters: result.unverifiedHints.supportedParameters.filter(
            (parameter) => !secrets.contains(parameter),
          ),
        },
      }),
    });
  }
  return normalized;
}

function openRouterPricing(value: unknown): ModelPricing | null {
  const pricing = recordOf(value);
  if (pricing === null) return null;
  const input = perMillion(pricing.prompt);
  const cachedInput = perMillion(pricing.input_cache_read ?? pricing.cache_read);
  const output = perMillion(pricing.completion);
  if (input === null && cachedInput === null && output === null) return null;
  return {
    inputUsdPerMillionTokens: input,
    cachedInputUsdPerMillionTokens: cachedInput,
    outputUsdPerMillionTokens: output,
  };
}

function perMillion(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Number((parsed * 1_000_000).toFixed(12));
}

function successfulDiscovery(
  models: readonly DiscoveredProviderModel[],
  pageCount: number,
): HttpModelDiscoveryResult {
  return { models, supportsRuntimeDefault: false, pageCount };
}

function failedDiscovery(
  safeError: SafeProviderError,
  pageCount = 0,
): HttpModelDiscoveryResult {
  return { models: [], supportsRuntimeDefault: false, pageCount, safeError };
}

function unsupportedDiscovery(): HttpModelDiscoveryResult {
  return failedDiscovery({ code: "model_discovery_unsupported" });
}

function safeError(code: SafeProviderErrorCode): { safeError: SafeProviderError } {
  return { safeError: { code } };
}

function bearerHeaders(
  headers: Record<string, string> | undefined,
  apiKey: string | undefined,
): Record<string, string> {
  return mergeHeaders(headers, apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` });
}

function mergeHeaders(
  primary: Record<string, string> | undefined,
  defaults: Record<string, string>,
): Record<string, string> {
  const headers = { ...(primary ?? {}) };
  for (const [name, value] of Object.entries(defaults)) {
    if (!Object.keys(headers).some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      headers[name] = value;
    }
  }
  return headers;
}

function anthropicModelsUrl(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined) return null;
  try {
    const url = new URL(baseUrl);
    const trimmed = url.pathname.replace(/\/+$/, "");
    const suffix = trimmed.endsWith("/v1") ? "models" : "v1/models";
    return appendUrlPath(url.toString(), suffix);
  } catch {
    return null;
  }
}

function appendQuery(url: string, name: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(name, value);
  return parsed.toString();
}

function stringAt(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringArrayAt(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function numberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function isPermittedProviderUrl(value: string, allowInsecureLocalhost: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && allowInsecureLocalhost && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function catalogSecretMatcher(values: readonly string[]): {
  contains(value: string): boolean;
  redact(value: string): string;
} {
  const secrets = [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= 4))]
    .sort((left, right) => right.length - left.length);
  return {
    contains(value) {
      return secrets.some((secret) => value.includes(secret));
    },
    redact(value) {
      let redacted = value;
      for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
      return redacted;
    },
  };
}

function sensitiveBodyValues(payload: unknown): string[] {
  const values: string[] = [];
  visit(payload, false);
  return values;

  function visit(value: unknown, sensitiveField: boolean): void {
    if (typeof value === "string") {
      if (sensitiveField) values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, sensitiveField);
      return;
    }
    const record = recordOf(value);
    if (record === null) return;
    for (const [name, child] of Object.entries(record)) {
      visit(
        child,
        sensitiveField || /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)/i.test(name),
      );
    }
  }
}

function secretValuesForRequest(input: SafeFetchJsonInput): string[] {
  const values = [input.url, ...Object.values(input.headers ?? {}), ...(input.secretValues ?? [])];
  try {
    const url = new URL(input.url);
    values.push(url.username, url.password, ...url.searchParams.values());
  } catch {
    // URL validation below returns the safe protocol error; never surface this parse error.
  }
  return values;
}

function allBundleSecretValues(bundle: ConnectionSecretBundle): string[] {
  const values = connectionSecretValues(bundle);
  for (const candidate of [bundle.baseUrl, bundle.discoveryUrl]) {
    if (candidate === undefined) continue;
    try {
      const url = new URL(candidate);
      values.push(url.username, url.password, ...url.searchParams.values());
    } catch {
      // The vault validator rejects malformed URLs. This keeps the boundary fail-closed.
    }
  }
  return values;
}

async function readBoundedResponse(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (body === null) throw new Error("empty response");
  const reader = body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted) {
    cancelReader();
    throw new HttpRequestAbortedError();
  }
  signal?.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = signal === undefined
        ? await reader.read()
        : await raceWithAbort(reader.read(), signal);
      if (next.done) break;
      const chunk = next.value;
      length += chunk.byteLength;
      if (length > limit) {
        // A tee created by a test/client can keep cancel() pending; the cap must
        // still terminate this parser immediately and never retain more bytes.
        void reader.cancel().catch(() => undefined);
        throw new Error("response limit exceeded");
      }
      chunks.push(chunk);
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Transport shims occasionally ignore AbortSignal. Race the operation so the
 * provider boundary still settles at its deadline, while consuming a late
 * rejection from that ignored request or stream read.
 */
function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  void operation.catch(() => undefined);
  if (signal.aborted) return Promise.reject(new HttpRequestAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new HttpRequestAbortedError());
    };
    const onFulfilled = (value: T) => {
      cleanup();
      resolve(value);
    };
    const onRejected = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(onFulfilled, onRejected);
  });
}
