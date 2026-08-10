import type { ModelCapabilities, ProviderModel, ProviderProtocol } from "@csb/shared";

export const WORKSPACE_TOOL_NAMES = [
  "workspace.list",
  "workspace.read",
  "workspace.search",
  "results.write",
] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export function isWorkspaceToolName(value: unknown): value is WorkspaceToolName {
  return typeof value === "string" &&
    (WORKSPACE_TOOL_NAMES as readonly string[]).includes(value);
}

export type AgentSessionErrorCode =
  | "agent_turn_limit"
  | "agent_tool_limit"
  | "agent_input_byte_limit"
  | "agent_output_byte_limit"
  | "agent_time_limit"
  | "agent_protocol_error"
  | "agent_cancelled"
  | "runner_capability_missing"
  | "runner_protocol_unsupported"
  | "runner_invalid_spec"
  | "runner_upstream_required"
  | "tool_path_denied"
  | "tool_name_denied"
  | "tool_argument_invalid"
  | "tool_read_limit"
  | "tool_output_limit"
  | "tool_write_denied";

export class AgentSessionError extends Error {
  constructor(readonly code: AgentSessionErrorCode) {
    super(code);
    this.name = "AgentSessionError";
  }
}

export interface WorkspaceArtifact {
  path: string;
  bytes: number;
}

export interface WorkspaceToolResult {
  content: string;
  artifact?: WorkspaceArtifact;
}

export interface WorkspaceToolHost {
  call(name: WorkspaceToolName, input: unknown): Promise<WorkspaceToolResult>;
}

export interface WorkspaceToolHostOptions {
  snapshotRoot: string;
  artifactRoot: string;
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxListEntries?: number;
  maxSearchResults?: number;
  maxSearchBytes?: number;
  maxRecursionDepth?: number;
}

export interface AgentSessionLimits {
  maxModelTurns: number;
  maxToolCalls: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface AgentSessionSpec {
  connectionId: string;
  routeKind: string;
  protocol: Extract<ProviderProtocol, "openai-responses" | "openai-chat" | "anthropic-messages">;
  model: ProviderModel;
  snapshotRoot: string;
  artifactRoot: string;
  instructions: string;
  limits: AgentSessionLimits;
  signal: AbortSignal;
}

export interface AgentUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

export type AgentEvent =
  | { type: "tool"; phase: "requested" | "result" | "consumed"; callId: string; name: WorkspaceToolName }
  | { type: "artifact"; path: string; bytes: number }
  | { type: "usage"; usage: AgentUsage }
  | { type: "completion"; text: string | null; structured: unknown | null }
  | { type: "failure"; code: AgentSessionErrorCode }
  | { type: "cancellation"; remote: boolean };

export interface AgentSession {
  run(): AsyncIterable<AgentEvent>;
  cancel(): Promise<{ remote: boolean }>;
}

export interface AgentSessionRunner {
  probe(input: ProbeInput): Promise<ProbeResult>;
  createSession(input: CreateAgentSessionInput): Promise<AgentSession>;
}

export interface ProbeInput {
  spec: AgentSessionSpec;
}

export interface ProbeResult {
  capabilities: Partial<ModelCapabilities>;
}

export interface CreateAgentSessionInput extends AgentSessionSpec {
  probe: ModelCapabilities | { capabilities: ModelCapabilities };
}

export interface AgentWireRequest {
  url: string;
  body: unknown;
}

export interface AgentUpstreamRequest extends AgentWireRequest {
  signal: AbortSignal;
}

/** The only provider boundary used by this package. Callers inject it; no fetch fallback exists. */
export interface AgentUpstream {
  request(request: AgentUpstreamRequest): Promise<unknown>;
  cancel?(): Promise<boolean | void>;
}

export interface AgentToolCall {
  id: string;
  name: WorkspaceToolName;
  input: Record<string, unknown>;
}

export interface AgentToolResult {
  callId: string;
  name: WorkspaceToolName;
  content: string;
}

export interface NormalizedModelReply {
  toolCalls: readonly AgentToolCall[];
  text: string | null;
  structured: unknown | null;
  usage: AgentUsage | null;
}

export interface WireSessionAdapter {
  nextRequest(toolResults: readonly AgentToolResult[]): AgentWireRequest;
  readResponse(response: unknown): NormalizedModelReply;
}

export interface ConstrainedWireSessionOptions {
  limits: AgentSessionLimits;
  signal: AbortSignal;
  host: WorkspaceToolHost;
  upstream: AgentUpstream;
  adapter: WireSessionAdapter;
  now?: () => number;
}

/**
 * Shared finite-state loop for every provider wire adapter. Adapters can only
 * translate messages; all local side effects and safety budgets remain here.
 */
export function createConstrainedWireSession(
  options: ConstrainedWireSessionOptions,
): AgentSession {
  validateAgentSessionLimits(options.limits);
  return new ConstrainedWireSession(options);
}

export function validateAgentSessionLimits(limits: AgentSessionLimits): void {
  const entries: ReadonlyArray<[keyof AgentSessionLimits, number]> = [
    ["maxModelTurns", 256],
    ["maxToolCalls", 1_024],
    ["maxInputBytes", 67_108_864],
    ["maxOutputBytes", 16_777_216],
    ["timeoutMs", 5_400_000],
  ];
  for (const [key, maximum] of entries) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new AgentSessionError("runner_invalid_spec");
    }
  }
}

class ConstrainedWireSession implements AgentSession {
  readonly #controller = new AbortController();
  readonly #options: ConstrainedWireSessionOptions;
  readonly #now: () => number;
  #deadline: number | null = null;
  #started = false;
  #completed = false;
  #externallyCancelled = false;
  #remoteCancellation: Promise<boolean> | undefined;

  constructor(options: ConstrainedWireSessionOptions) {
    this.#options = options;
    this.#now = this.#options.now ?? Date.now;
  }

  async cancel(): Promise<{ remote: boolean }> {
    if (this.#completed) return { remote: false };
    this.#externallyCancelled = true;
    this.#controller.abort();
    return { remote: await this.#requestRemoteCancellation() };
  }

  async *run(): AsyncIterable<AgentEvent> {
    if (this.#started) throw new AgentSessionError("runner_invalid_spec");
    this.#started = true;
    this.#deadline = this.#now() + this.#options.limits.timeoutMs;
    const detachAbort = this.#attachExternalAbort();
    const timeout = setTimeout(
      () => this.#controller.abort(),
      Math.max(0, this.#deadline - this.#now()),
    );
    const seenCallIds = new Set<string>();
    let modelTurns = 0;
    let toolCalls = 0;
    let inputBytes = 0;
    let outputBytes = 0;
    let toolResults: AgentToolResult[] = [];

    try {
      for (;;) {
        this.#throwIfStopped();
        if (toolResults.length > 0 && toolCalls >= this.#options.limits.maxToolCalls) {
          throw new AgentSessionError("agent_tool_limit");
        }
        if (modelTurns >= this.#options.limits.maxModelTurns) {
          throw new AgentSessionError("agent_turn_limit");
        }

        const request = this.#options.adapter.nextRequest(toolResults);
        const requestBytes = serializedByteLength(request.body);
        if (inputBytes + requestBytes > this.#options.limits.maxInputBytes) {
          throw new AgentSessionError("agent_input_byte_limit");
        }
        inputBytes += requestBytes;
        for (const result of toolResults) {
          yield { type: "tool", phase: "consumed", callId: result.callId, name: result.name };
        }
        modelTurns += 1;
        const response = await this.#options.upstream.request({ ...request, signal: this.#controller.signal });
        this.#throwIfStopped();
        const responseBytes = serializedByteLength(response);
        if (outputBytes + responseBytes > this.#options.limits.maxOutputBytes) {
          throw new AgentSessionError("agent_output_byte_limit");
        }
        outputBytes += responseBytes;
        const reply = this.#options.adapter.readResponse(response);
        const usage = reply.usage ?? emptyUsage();
        yield { type: "usage", usage };

        if (reply.toolCalls.length === 0) {
          yield { type: "completion", text: reply.text, structured: reply.structured };
          this.#completed = true;
          return;
        }

        toolResults = [];
        for (const call of reply.toolCalls) {
          this.#throwIfStopped();
          if (seenCallIds.has(call.id) || toolCalls >= this.#options.limits.maxToolCalls) {
            throw new AgentSessionError(toolCalls >= this.#options.limits.maxToolCalls
              ? "agent_tool_limit"
              : "agent_protocol_error");
          }
          seenCallIds.add(call.id);
          toolCalls += 1;
          yield { type: "tool", phase: "requested", callId: call.id, name: call.name };
          const result = await this.#options.host.call(call.name, call.input);
          this.#throwIfStopped();
          const resultBytes = Buffer.byteLength(result.content, "utf8");
          if (outputBytes + resultBytes > this.#options.limits.maxOutputBytes) {
            throw new AgentSessionError("agent_output_byte_limit");
          }
          outputBytes += resultBytes;
          toolResults.push({ callId: call.id, name: call.name, content: result.content });
          yield { type: "tool", phase: "result", callId: call.id, name: call.name };
          if (result.artifact !== undefined) {
            yield { type: "artifact", path: result.artifact.path, bytes: result.artifact.bytes };
          }
        }
      }
    } catch (error) {
      const failure = normalizeFailure(error, this.#hasTimedOut());
      if (failure.code === "agent_cancelled") {
        yield { type: "cancellation", remote: await this.#requestRemoteCancellation() };
        this.#completed = true;
        return;
      }
      this.#controller.abort();
      const remote = await this.#requestRemoteCancellation();
      yield { type: "failure", code: failure.code };
      yield { type: "cancellation", remote };
      this.#completed = true;
      throw failure;
    } finally {
      clearTimeout(timeout);
      detachAbort();
    }
  }

  #attachExternalAbort(): () => void {
    const abort = () => {
      this.#externallyCancelled = true;
      this.#controller.abort();
    };
    if (this.#options.signal.aborted) abort();
    else this.#options.signal.addEventListener("abort", abort, { once: true });
    return () => this.#options.signal.removeEventListener("abort", abort);
  }

  #throwIfStopped(): void {
    if (this.#hasTimedOut()) throw new AgentSessionError("agent_time_limit");
    if (this.#externallyCancelled || this.#options.signal.aborted || this.#controller.signal.aborted) {
      throw new AgentSessionError("agent_cancelled");
    }
  }

  #hasTimedOut(): boolean {
    return this.#deadline !== null && this.#now() >= this.#deadline && !this.#externallyCancelled;
  }

  #requestRemoteCancellation(): Promise<boolean> {
    if (this.#remoteCancellation === undefined) {
      this.#remoteCancellation = Promise.resolve(this.#options.upstream.cancel?.())
        .then((value) => value === true)
        .catch(() => false);
    }
    return this.#remoteCancellation;
  }
}

function emptyUsage(): AgentUsage {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
  };
}

function serializedByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("unserializable");
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    throw new AgentSessionError("agent_protocol_error");
  }
}

function normalizeFailure(error: unknown, timedOut: boolean): AgentSessionError {
  if (timedOut) return new AgentSessionError("agent_time_limit");
  if (error instanceof AgentSessionError) return error;
  return new AgentSessionError("agent_protocol_error");
}
