import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ModelCapabilities,
  ProviderModel,
  ProviderProtocol,
  SafeProviderErrorCode,
} from "@csb/shared";
import type { ConnectionSecretBundle } from "../credentials/credential-vault.js";
import { DEFAULT_AGENT_LIMITS, createAgentSession } from "./session-runner.js";
import { createWorkspaceToolHost } from "./workspace-tool-host.js";
import {
  AgentSessionError,
  WORKSPACE_TOOL_NAMES,
  type AgentEvent,
  type AgentSessionLimits,
  type AgentUpstream,
  type AgentUpstreamRequest,
  type AgentUsage,
  type AgentWireOperation,
} from "./session-types.js";

/** The provider body limit is independent from an agent-run output budget. */
export const HTTP_AGENT_BODY_LIMIT_BYTES = 1_048_576;

export type HttpAgentProtocol = Extract<ProviderProtocol,
  | "openai-responses"
  | "openai-chat"
  | "anthropic-messages"
  | "xai-oauth-responses"
>;

/**
 * Closed route/protocol vocabulary for server-side HTTP agent sessions. This
 * intentionally says nothing about credentials or custom endpoint validity;
 * those remain enforced by resolveRoute immediately before the HTTP request.
 */
export function isHttpAgentRouteProtocolSupported(
  routeKind: string,
  protocol: ProviderProtocol,
): protocol is HttpAgentProtocol {
  switch (routeKind) {
    case "openai-api":
      return protocol === "openai-responses" || protocol === "openai-chat";
    case "xai-api":
      return protocol === "openai-responses";
    case "xai-oauth":
      return protocol === "xai-oauth-responses";
    case "anthropic-api":
    case "minimax-token-plan":
    case "custom-anthropic-compatible":
      return protocol === "anthropic-messages";
    case "openrouter-api":
    case "gemini-api":
    case "deepseek-api":
      return protocol === "openai-chat";
    case "custom-openai-compatible":
      return protocol === "openai-responses" || protocol === "openai-chat";
    // MiMo remains discovery-only until it receives its own execution route.
    case "mimo-token-plan":
    default:
      return false;
  }
}

export interface HttpAgentUpstreamOptions {
  routeKind: string;
  protocol: HttpAgentProtocol;
  /** Passed only by trusted server code that has just read the vault. */
  credentials: ConnectionSecretBundle;
  /** Injectable solely for deterministic tests; production defaults to fetch. */
  transport?: typeof fetch;
}

/**
 * The HTTP layer exposes only a closed error vocabulary. It intentionally
 * carries neither a response body nor endpoint/header material.
 */
export class HttpAgentUpstreamError extends AgentSessionError {
  constructor(code: SafeProviderErrorCode) {
    super(code);
    this.name = "HttpAgentUpstreamError";
  }
}

/**
 * Resolves a route's execution endpoint inside the server process. The wire
 * request remains URL-free so model adapters cannot select an arbitrary host.
 */
export function createHttpAgentUpstream(options: HttpAgentUpstreamOptions): AgentUpstream {
  return new HttpAgentUpstream(options);
}

export interface HttpAgentProbeInput {
  connectionId: string;
  routeKind: string;
  protocol: ProviderProtocol;
  /** Kept for the HTTP route contract; never trusted as an endpoint. */
  inferencePath: string;
  model: ProviderModel;
  credentials: ConnectionSecretBundle;
}

export interface HttpAgentProbeMeasurement {
  capabilities: Partial<ModelCapabilities>;
  limitsEnforced: boolean;
  agentLoop: {
    workspaceToolRequested: boolean;
    workspaceToolResultConsumed: boolean;
    resultsWriteRequested: boolean;
    artifactProduced: boolean;
    structuredResultProduced: boolean;
  };
  runtimeEvidence: HttpAgentRuntimeEvidence;
  /** Last upstream-reported token usage, if the selected model returned it. */
  usage: AgentUsage | null;
}

export interface HttpAgentRuntimeEvidence {
  authoritativeDeadlineEnforced: boolean;
  authoritativeCancellationEnforced: boolean;
  privatePinnedRootsEnforced: boolean;
  closedToolSurfaceEnforced: boolean;
}

export interface HttpProbeSessionOptions {
  transport?: typeof fetch;
  /** Test seam. The factory creates and deletes only its own child directory. */
  temporaryParent?: string;
  limits?: Partial<AgentSessionLimits>;
}

/**
 * Returns a connection-route-compatible probe callback. It creates an empty,
 * private fixture so no user workspace or secret-bearing file is ever sent to
 * a provider while proving the actual bounded tool loop.
 */
export function createHttpProbeSession(
  options: HttpProbeSessionOptions = {},
): (input: HttpAgentProbeInput) => Promise<HttpAgentProbeMeasurement> {
  const limits = boundedProbeLimits(options.limits);
  return async (input) => {
    if (!isHttpAgentProtocol(input.protocol) || input.model.connectionId !== input.connectionId) {
      throw new HttpAgentUpstreamError("protocol_unsupported");
    }
    const root = await createPrivateProbeRoot(options.temporaryParent);
    try {
      const snapshotRoot = join(root, "snapshot");
      const artifactRoot = join(root, "artifacts");
      const boundaryArtifactRoot = join(root, "boundary-artifacts");
      const deadlineArtifactRoot = join(root, "deadline-artifacts");
      const cancellationArtifactRoot = join(root, "cancellation-artifacts");
      await mkdir(snapshotRoot, { mode: 0o700 });
      await mkdir(artifactRoot, { mode: 0o700 });
      await mkdir(boundaryArtifactRoot, { mode: 0o700 });
      await mkdir(deadlineArtifactRoot, { mode: 0o700 });
      await mkdir(cancellationArtifactRoot, { mode: 0o700 });
      await chmod(snapshotRoot, 0o700);
      await chmod(artifactRoot, 0o700);
      await chmod(boundaryArtifactRoot, 0o700);
      await chmod(deadlineArtifactRoot, 0o700);
      await chmod(cancellationArtifactRoot, 0o700);
      await writeFile(join(snapshotRoot, "probe-input.txt"), "Sentinel HTTP probe fixture.\n", {
        encoding: "utf8",
        mode: 0o600,
      });

      const runtimeEvidence = await collectRuntimeEvidence({
        connectionId: input.connectionId,
        routeKind: input.routeKind,
        protocol: input.protocol,
        model: input.model,
        snapshotRoot,
        artifactRoot,
        boundaryArtifactRoot,
        deadlineArtifactRoot,
        cancellationArtifactRoot,
      });

      const session = await createAgentSession({
        connectionId: input.connectionId,
        routeKind: input.routeKind,
        protocol: input.protocol,
        model: input.model,
        snapshotRoot,
        artifactRoot,
        instructions: PROBE_INSTRUCTIONS,
        limits,
        signal: new AbortController().signal,
        // This gate enables the measurement session itself. The returned facts
        // below are derived only from events observed in this fresh run.
        probe: provisionalProbeCapabilities(),
      }, createHttpAgentUpstream({
        routeKind: input.routeKind,
        protocol: input.protocol,
        credentials: input.credentials,
        transport: options.transport,
      }));

      return await collectProbeMeasurement(session.run(), runtimeEvidence);
    } finally {
      await removePrivateProbeRoot(root);
    }
  };
}

class HttpAgentUpstream implements AgentUpstream {
  readonly #endpoint: string | null;
  readonly #headers: Record<string, string>;
  readonly #operation: AgentWireOperation | null;
  readonly #transport: typeof fetch;
  readonly #active = new Set<AbortController>();

  constructor(options: HttpAgentUpstreamOptions) {
    const route = resolveRoute(options.routeKind, options.protocol, options.credentials);
    this.#endpoint = route?.endpoint ?? null;
    this.#headers = route?.headers ?? {};
    this.#operation = route?.operation ?? null;
    this.#transport = options.transport ?? fetch;
  }

  async request(request: AgentUpstreamRequest): Promise<unknown> {
    if (this.#endpoint === null || this.#operation === null || request.operation !== this.#operation) {
      throw new HttpAgentUpstreamError("protocol_unsupported");
    }
    const serialized = serializeBody(request.body);
    const controller = new AbortController();
    const detach = followAbort(request.signal, controller);
    this.#active.add(controller);
    try {
      let response: Response;
      try {
        response = await raceWithAbort(
          Promise.resolve().then(() => this.#transport(this.#endpoint as string, {
            method: "POST",
            headers: this.#headers,
            body: serialized,
            redirect: "error",
            signal: controller.signal,
          })),
          controller.signal,
        );
      } catch (error) {
        if (error instanceof AgentSessionError || error instanceof HttpAgentUpstreamError) throw error;
        throw new HttpAgentUpstreamError("provider_unreachable");
      }
      const statusCode = statusError(response.status);
      if (statusCode !== null) throw new HttpAgentUpstreamError(statusCode);
      try {
        return await readBoundedJson(response, controller.signal);
      } catch (error) {
        if (error instanceof AgentSessionError || error instanceof HttpAgentUpstreamError) throw error;
        throw new HttpAgentUpstreamError("protocol_unsupported");
      }
    } finally {
      this.#active.delete(controller);
      detach();
    }
  }

  async cancel(): Promise<boolean> {
    for (const controller of this.#active) controller.abort();
    // These inference routes document no cancellation endpoint. Abort is local.
    return false;
  }
}

interface ResolvedRoute {
  endpoint: string;
  headers: Record<string, string>;
  operation: AgentWireOperation;
}

function resolveRoute(
  routeKind: string,
  protocol: HttpAgentProtocol,
  credentials: ConnectionSecretBundle,
): ResolvedRoute | null {
  const openAiHeaders = jsonHeaders(credentials.headers, credentials.apiKey === undefined
    ? {}
    : { Authorization: `Bearer ${credentials.apiKey}` });
  const anthropicHeaders = jsonHeaders(credentials.headers, {
    ...(credentials.apiKey === undefined ? {} : { "x-api-key": credentials.apiKey }),
    "anthropic-version": "2023-06-01",
  });
  switch (routeKind) {
    case "openai-api":
      return openAiRoute("https://api.openai.com/v1", protocol, openAiHeaders);
    case "xai-api":
      return protocol === "openai-responses"
        ? { endpoint: "https://api.x.ai/v1/responses", headers: openAiHeaders, operation: "responses" }
        : null;
    case "xai-oauth":
      return protocol === "xai-oauth-responses"
        ? {
          endpoint: "https://api.x.ai/v1/responses",
          // Direct OAuth never accepts caller-supplied endpoint or headers.
          // The adapter obtains this bearer from the native OAuth store only.
          headers: jsonHeaders(undefined, credentials.apiKey === undefined
            ? {}
            : { Authorization: `Bearer ${credentials.apiKey}` }),
          operation: "responses",
        }
        : null;
    case "anthropic-api":
      return protocol === "anthropic-messages"
        ? { endpoint: "https://api.anthropic.com/v1/messages", headers: anthropicHeaders, operation: "messages" }
        : null;
    case "openrouter-api":
      return protocol === "openai-chat"
        ? { endpoint: "https://openrouter.ai/api/v1/chat/completions", headers: openAiHeaders, operation: "chat-completions" }
        : null;
    case "gemini-api":
      return protocol === "openai-chat"
        ? { endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", headers: openAiHeaders, operation: "chat-completions" }
        : null;
    case "deepseek-api":
      return protocol === "openai-chat"
        ? { endpoint: "https://api.deepseek.com/chat/completions", headers: openAiHeaders, operation: "chat-completions" }
        : null;
    case "minimax-token-plan":
      return protocol === "anthropic-messages"
        ? {
          endpoint: "https://api.minimax.io/anthropic/v1/messages",
          headers: jsonHeaders(credentials.headers, {
            ...(credentials.apiKey === undefined ? {} : { "X-Api-Key": credentials.apiKey }),
            "anthropic-version": "2023-06-01",
          }),
          operation: "messages",
        }
        : null;
    case "custom-openai-compatible": {
      const endpoint = customEndpoint(credentials, protocol === "openai-responses" ? "/responses" : "/chat/completions");
      return endpoint === null || (protocol !== "openai-responses" && protocol !== "openai-chat")
        ? null
        : { endpoint, headers: openAiHeaders, operation: protocol === "openai-responses" ? "responses" : "chat-completions" };
    }
    case "custom-anthropic-compatible": {
      const endpoint = customEndpoint(credentials, "/v1/messages");
      return endpoint === null || protocol !== "anthropic-messages"
        ? null
        : { endpoint, headers: anthropicHeaders, operation: "messages" };
    }
    // MiMo's regional execution base/protocol must be supplied by a dedicated
    // route contract. Never infer one from a discovery-only bundle.
    case "mimo-token-plan":
    default:
      return null;
  }
}

function openAiRoute(
  base: string,
  protocol: HttpAgentProtocol,
  headers: Record<string, string>,
): ResolvedRoute | null {
  if (protocol === "openai-responses") {
    return { endpoint: `${base}/responses`, headers, operation: "responses" };
  }
  if (protocol === "openai-chat") {
    return { endpoint: `${base}/chat/completions`, headers, operation: "chat-completions" };
  }
  return null;
}

function customEndpoint(credentials: ConnectionSecretBundle, path: string): string | null {
  if (credentials.baseUrl === undefined) return null;
  try {
    const url = new URL(credentials.baseUrl);
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
    if (!isPermittedCustomUrl(url, credentials.allowInsecureLocalhost === true)) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    return url.toString();
  } catch {
    return null;
  }
}

function isPermittedCustomUrl(url: URL, allowInsecureLocalhost: boolean): boolean {
  const scope = deterministicHostScope(url.hostname);
  if (scope === "blocked") return false;
  if (scope === "loopback") return allowInsecureLocalhost;
  return url.protocol === "https:";
}

type DeterministicHostScope = "public" | "loopback" | "blocked";

/**
 * This is deliberately deterministic and performs no DNS lookup. Public
 * custom hostnames remain susceptible to DNS rebinding unless a later
 * transport pins resolution; callers must not treat this check as DNS pinning.
 */
function deterministicHostScope(value: string): DeterministicHostScope {
  const host = value.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  const version = isIP(host);
  if (version === 4) return host.startsWith("127.") ? "loopback" : "blocked";
  if (version === 6) return host === "::1" ? "loopback" : "blocked";
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (isObviousLocalHostname(host)) return "blocked";
  return "public";
}

function isObviousLocalHostname(host: string): boolean {
  if (!host.includes(".")) return true;
  return [
    ".local",
    ".localdomain",
    ".internal",
    ".lan",
    ".home",
    ".home.arpa",
    ".svc",
    ".cluster.local",
  ].some((suffix) => host.endsWith(suffix));
}

function jsonHeaders(
  source: Record<string, string> | undefined,
  defaults: Record<string, string>,
): Record<string, string> {
  const headers = { ...(source ?? {}) };
  for (const [name, value] of Object.entries(defaults)) {
    if (!hasHeader(headers, name)) headers[name] = value;
  }
  // The wire contract is always JSON, including on custom provider routes.
  headers[headerKey(headers, "content-type") ?? "content-type"] = "application/json";
  return headers;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return headerKey(headers, name) !== undefined;
}

function headerKey(headers: Record<string, string>, name: string): string | undefined {
  return Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

function serializeBody(body: unknown): string {
  try {
    const serialized = JSON.stringify(body);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > HTTP_AGENT_BODY_LIMIT_BYTES) {
      throw new Error("body invalid");
    }
    return serialized;
  } catch {
    throw new HttpAgentUpstreamError("protocol_unsupported");
  }
}

function statusError(status: number): SafeProviderErrorCode | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return "credential_rejected";
  if (status === 403) return "model_access_denied";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504 || status >= 500) return "provider_unreachable";
  return "protocol_unsupported";
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) throw new HttpAgentUpstreamError("protocol_unsupported");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  if (signal.aborted) cancelReader();
  else signal.addEventListener("abort", cancelReader, { once: true });
  try {
    for (;;) {
      const next = await raceWithAbort(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > HTTP_AGENT_BODY_LIMIT_BYTES) {
        cancelReader();
        throw new HttpAgentUpstreamError("protocol_unsupported");
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new HttpAgentUpstreamError("protocol_unsupported");
  }
}

/** The promise handlers remain attached after an abort to consume late errors. */
function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new AgentSessionError("agent_cancelled")));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function followAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort();
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

const PROBE_LIMITS: Readonly<AgentSessionLimits> = Object.freeze({
  ...DEFAULT_AGENT_LIMITS,
  maxModelTurns: 4,
  maxToolCalls: 4,
  maxInputBytes: 1_048_576,
  maxOutputBytes: 1_048_576,
  timeoutMs: 30_000,
});

const PROBE_INSTRUCTIONS = [
  "This is a bounded Sentinel capability probe.",
  "First read probe-input.txt or list the workspace.",
  "Then write results.write path probe.json with a compact JSON result.",
  "Finally return a JSON object as the completion.",
].join(" ");

function boundedProbeLimits(overrides: Partial<AgentSessionLimits> | undefined): AgentSessionLimits {
  return { ...PROBE_LIMITS, ...(overrides ?? {}) };
}

function provisionalProbeCapabilities(): ModelCapabilities {
  return {
    tools: "supported",
    artifactOutput: "supported",
    structuredOutput: "supported",
    boundedExecution: "supported",
    osIsolation: "unknown",
    streaming: "unknown",
    usage: "unknown",
    cancellation: "unknown",
  };
}

async function collectProbeMeasurement(
  events: AsyncIterable<AgentEvent>,
  runtimeEvidence: HttpAgentRuntimeEvidence,
): Promise<HttpAgentProbeMeasurement> {
  const evidence = {
    workspaceToolRequested: false,
    workspaceToolResultConsumed: false,
    resultsWriteRequested: false,
    artifactProduced: false,
    structuredResultProduced: false,
  };
  let stage = 0;
  let usage: AgentUsage | null = null;
  for await (const event of events) {
    if (event.type === "usage") {
      usage = event.usage;
      continue;
    }
    if (event.type === "tool" && event.phase === "requested" &&
        (event.name === "workspace.list" || event.name === "workspace.read") && stage === 0) {
      evidence.workspaceToolRequested = true;
      stage = 1;
      continue;
    }
    if (event.type === "tool" && event.phase === "consumed" &&
        (event.name === "workspace.list" || event.name === "workspace.read") && stage === 1) {
      evidence.workspaceToolResultConsumed = true;
      stage = 2;
      continue;
    }
    if (event.type === "tool" && event.phase === "requested" && event.name === "results.write" && stage === 2) {
      evidence.resultsWriteRequested = true;
      stage = 3;
      continue;
    }
    if (event.type === "artifact" && stage === 3) {
      evidence.artifactProduced = true;
      stage = 4;
      continue;
    }
    if (event.type === "completion" && event.structured !== null && stage === 4) {
      evidence.structuredResultProduced = true;
      stage = 5;
    }
  }
  const complete = stage === 5;
  return {
    capabilities: {
      tools: complete ? "supported" : "unknown",
      artifactOutput: complete ? "supported" : "unknown",
      structuredOutput: complete ? "supported" : "unknown",
      boundedExecution: "supported",
      usage: usageHasTokens(usage) ? "supported" : "unknown",
      cancellation: complete && runtimeEvidence.authoritativeDeadlineEnforced &&
          runtimeEvidence.authoritativeCancellationEnforced
        ? "supported"
        : "unknown",
      osIsolation: complete && runtimeEvidence.privatePinnedRootsEnforced &&
          runtimeEvidence.closedToolSurfaceEnforced
        ? "supported"
        : "unknown",
    },
    limitsEnforced: true,
    agentLoop: evidence,
    runtimeEvidence,
    usage,
  };
}

interface RuntimeEvidenceSpec {
  connectionId: string;
  routeKind: string;
  protocol: HttpAgentProtocol;
  model: ProviderModel;
  snapshotRoot: string;
  artifactRoot: string;
  boundaryArtifactRoot: string;
  deadlineArtifactRoot: string;
  cancellationArtifactRoot: string;
}

async function collectRuntimeEvidence(spec: RuntimeEvidenceSpec): Promise<HttpAgentRuntimeEvidence> {
  const workspace = await proveWorkspaceBoundary(spec.snapshotRoot, [
    spec.artifactRoot,
    spec.boundaryArtifactRoot,
    spec.deadlineArtifactRoot,
    spec.cancellationArtifactRoot,
  ], spec.boundaryArtifactRoot);
  const deadline = await proveAuthoritativeDeadline(spec);
  const cancellation = await proveAuthoritativeCancellation(spec);
  return {
    authoritativeDeadlineEnforced: deadline,
    authoritativeCancellationEnforced: cancellation,
    privatePinnedRootsEnforced: workspace.privatePinnedRootsEnforced,
    closedToolSurfaceEnforced: workspace.closedToolSurfaceEnforced,
  };
}

async function proveWorkspaceBoundary(
  snapshotRoot: string,
  privateArtifactRoots: readonly string[],
  boundaryArtifactRoot: string,
): Promise<Pick<HttpAgentRuntimeEvidence, "privatePinnedRootsEnforced" | "closedToolSurfaceEnforced">> {
  try {
    const privatePinnedRootsEnforced = (await Promise.all([
      lstat(join(boundaryArtifactRoot, "..")),
      lstat(snapshotRoot),
      ...privateArtifactRoots.map((root) => lstat(root)),
    ])).every(isPrivateOwnedDirectory);
    const host = await createWorkspaceToolHost({ snapshotRoot, artifactRoot: boundaryArtifactRoot });
    await host.call("workspace.list", { path: ".", maxEntries: 4, maxDepth: 1 });
    await host.call("results.write", { path: "runtime-boundary.json", content: "{}" });
    let extraToolDenied = false;
    try {
      await host.call("shell.exec" as never, {});
    } catch (error) {
      extraToolDenied = error instanceof AgentSessionError && error.code === "tool_name_denied";
    }
    const closedToolSurfaceEnforced = extraToolDenied &&
      WORKSPACE_TOOL_NAMES.length === 4 &&
      WORKSPACE_TOOL_NAMES.join("|") === "workspace.list|workspace.read|workspace.search|results.write";
    return { privatePinnedRootsEnforced, closedToolSurfaceEnforced };
  } catch {
    return { privatePinnedRootsEnforced: false, closedToolSurfaceEnforced: false };
  }
}

async function proveAuthoritativeCancellation(spec: RuntimeEvidenceSpec): Promise<boolean> {
  const started = deferred<void>();
  const events: AgentEvent[] = [];
  try {
    const session = await createRuntimeEvidenceSession(spec, {
      request() {
        started.resolve();
        return new Promise(() => undefined);
      },
      async cancel() {
        return false;
      },
    }, { timeoutMs: 1_000 }, spec.cancellationArtifactRoot);
    const running = collectRuntimeEvents(session.run(), events);
    await withinLocalEvidenceDeadline(started.promise);
    const cancellation = await withinLocalEvidenceDeadline(session.cancel());
    await withinLocalEvidenceDeadline(running);
    return cancellation.remote === false && events.some((event) =>
      event.type === "cancellation" && event.remote === false);
  } catch {
    return false;
  }
}

async function proveAuthoritativeDeadline(spec: RuntimeEvidenceSpec): Promise<boolean> {
  const events: AgentEvent[] = [];
  try {
    const session = await createRuntimeEvidenceSession(spec, {
      request() {
        return new Promise(() => undefined);
      },
      async cancel() {
        return false;
      },
    }, { timeoutMs: 1 }, spec.deadlineArtifactRoot);
    await withinLocalEvidenceDeadline(collectRuntimeEvents(session.run(), events));
    return false;
  } catch (error) {
    return error instanceof AgentSessionError && error.code === "agent_time_limit" &&
      events.some((event) => event.type === "failure" && event.code === "agent_time_limit") &&
      events.some((event) => event.type === "cancellation" && event.remote === false);
  }
}

function createRuntimeEvidenceSession(
  spec: RuntimeEvidenceSpec,
  upstream: AgentUpstream,
  limits: Partial<AgentSessionLimits>,
  artifactRoot: string,
) {
  return createAgentSession({
    connectionId: spec.connectionId,
    routeKind: spec.routeKind,
    protocol: spec.protocol,
    model: spec.model,
    snapshotRoot: spec.snapshotRoot,
    artifactRoot,
    instructions: PROBE_INSTRUCTIONS,
    limits: { ...PROBE_LIMITS, ...limits },
    signal: new AbortController().signal,
    probe: provisionalProbeCapabilities(),
  }, upstream);
}

async function collectRuntimeEvents(
  events: AsyncIterable<AgentEvent>,
  output: AgentEvent[],
): Promise<void> {
  for await (const event of events) output.push(event);
}

async function withinLocalEvidenceDeadline<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new AgentSessionError("agent_time_limit")),
          250,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function isPrivateOwnedDirectory(info: Stats): boolean {
  return info.isDirectory() && !info.isSymbolicLink() &&
    (info.mode & 0o777) === 0o700 &&
    (typeof process.getuid !== "function" || info.uid === process.getuid());
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function usageHasTokens(usage: AgentUsage | null): boolean {
  return usage !== null && Object.values(usage).some((value) => value !== null);
}

function isHttpAgentProtocol(value: ProviderProtocol): value is HttpAgentProtocol {
  return value === "openai-responses" || value === "openai-chat" ||
    value === "anthropic-messages" || value === "xai-oauth-responses";
}

async function createPrivateProbeRoot(parent: string | undefined): Promise<string> {
  const root = await mkdtemp(join(parent ?? tmpdir(), "csb-agent-probe-"));
  try {
    await chmod(root, 0o700);
    const stats = await lstat(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("unsafe probe root");
    }
    return root;
  } catch {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw new HttpAgentUpstreamError("protocol_unsupported");
  }
}

async function removePrivateProbeRoot(root: string): Promise<void> {
  try {
    const stats = await lstat(root);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !root.split("/").at(-1)?.startsWith("csb-agent-probe-")) {
      throw new Error("unexpected probe root");
    }
    await rm(root, { recursive: true, force: false, maxRetries: 1 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw new HttpAgentUpstreamError("protocol_unsupported");
  }
}
