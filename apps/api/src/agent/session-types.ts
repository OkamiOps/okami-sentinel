import type {
  ModelCapabilities,
  ProviderModel,
  ProviderProtocol,
  SafeProviderErrorCode,
} from "@csb/shared";

import {
  normalizeResultArtifactInput,
  PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT,
  type AgentResultArtifactContract,
  type PortableResultArtifactValidationContext,
  type ResultArtifactValidationIssue,
  type ResultArtifactRepairDetail,
} from "./result-artifact-contract.js";
import { MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT } from "../scanners/mantis-report-contract.js";

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
  | "tool_write_denied"
  /** A sanitized upstream status can safely cross the agent boundary. */
  | SafeProviderErrorCode;

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

export interface WorkspaceToolBudget {
  maxOutputBytes: number;
}

export interface WorkspaceToolHost {
  minimumOutputBytes(name: WorkspaceToolName, input: unknown): number;
  call(
    name: WorkspaceToolName,
    input: unknown,
    budget?: WorkspaceToolBudget,
  ): Promise<WorkspaceToolResult>;
}

export interface WorkspaceToolHostOptions {
  snapshotRoot: string;
  /** Existing, unique 0700 directory provisioned for this one session only. */
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

export type AgentSessionTerminalMode = "provider-completion" | "artifact-write";

/** Closed upper bound for a server-selected provider completion request. */
export const MAX_AGENT_SESSION_COMPLETION_TOKENS = 65_536;

export interface AgentSessionSpec {
  connectionId: string;
  routeKind: string;
  protocol: Extract<ProviderProtocol,
    | "openai-responses"
    | "openai-chat"
    | "anthropic-messages"
    | "xai-oauth-responses"
  >;
  model: ProviderModel;
  /** Optional only when the exact selected model published this value. */
  reasoningEffort?: string;
  /** Server-selected artifact contract; never inferred from provider/model. */
  resultArtifactContract?: AgentResultArtifactContract;
  /** Server-owned Portable dossier used to reject semantic terminal artifacts before host I/O. */
  resultArtifactValidationContext?: PortableResultArtifactValidationContext;
  /** Scanner sessions may finish on a locally accepted artifact; probes still verify provider completion. */
  terminalMode?: AgentSessionTerminalMode;
  /** Optional server-owned completion budget; wire adapters use it only when their proven protocol supports one. */
  maxCompletionTokens?: number;
  snapshotRoot: string;
  /** Existing, unique 0700 directory reserved by the session owner. */
  artifactRoot: string;
  instructions: string;
  limits: AgentSessionLimits;
  signal: AbortSignal;
}

/**
 * Positive registry of provider routes whose exact wire contract can carry an
 * effort level. A generic compatibility protocol is not proof that an
 * arbitrary gateway accepts the same field.
 */
export function hasAgentSessionReasoningEffortCodec(
  routeKind: string,
  protocol: ProviderProtocol,
): boolean {
  switch (routeKind) {
    case "openai-api":
      return protocol === "openai-responses" || protocol === "openai-chat";
    case "xai-api":
      return protocol === "openai-responses";
    case "xai-oauth":
      return protocol === "xai-oauth-responses";
    case "anthropic-api":
      return protocol === "anthropic-messages";
    case "openrouter-api":
    case "gemini-api":
      return protocol === "openai-chat";
    default:
      return false;
  }
}

/**
 * A reasoning value is model metadata, never a provider-name convention. The
 * session boundary repeats this check so stale or forged worker configs cannot
 * reach a wire adapter.
 */
export function validateAgentSessionReasoningEffort(
  model: ProviderModel,
  reasoningEffort: string | undefined,
  routeKind?: string,
  protocol?: ProviderProtocol,
): void {
  if (reasoningEffort === undefined) return;
  if (
    routeKind !== undefined &&
    (protocol === undefined || !hasAgentSessionReasoningEffortCodec(routeKind, protocol))
  ) {
    throw new AgentSessionError("runner_invalid_spec");
  }
  if (
    typeof reasoningEffort !== "string" ||
    !model.reasoningEffort?.options.includes(reasoningEffort)
  ) {
    throw new AgentSessionError("runner_invalid_spec");
  }
}

export interface AgentUsage {
  /** Total input tokens, including cache-read and cache-write tokens when reported. */
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

export type AgentEvent =
  | {
    type: "tool";
    phase: "requested" | "result" | "consumed";
    callId: string;
    name: WorkspaceToolName;
    /** False only when the tool result is a safe local rejection, not host evidence. */
    ok?: boolean;
    /** Closed, non-content diagnostic for a rejected terminal artifact. */
    reason?: ResultArtifactValidationIssue;
  }
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

export type AgentWireOperation = "responses" | "chat-completions" | "messages";

export interface AgentWireRequest {
  operation: AgentWireOperation;
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
  /** False only for a safe pre-I/O validation failure the model may correct. */
  ok?: boolean;
  /** Closed, non-content diagnostic retained only for safe telemetry. */
  validationIssue?: ResultArtifactValidationIssue;
}

export interface NormalizedModelReply {
  toolCalls: readonly AgentToolCall[];
  text: string | null;
  structured: unknown | null;
  usage: AgentUsage | null;
}

export interface AgentWireRequestControl {
  /** Exploration is closed; the provider must write the declared artifact now. */
  finalizationRequired: boolean;
  /** The previous repair reply omitted results.write; restate the terminal action. */
  artifactRepairReminder?: boolean;
}

export const AGENT_ARTIFACT_REPAIR_REMINDER =
  "The previous reply did not call results.write. Call results.write now with one complete corrected artifact and no other tool call.";

export interface WireSessionAdapter {
  nextRequest(
    toolResults: readonly AgentToolResult[],
    control?: AgentWireRequestControl,
  ): AgentWireRequest;
  readResponse(response: unknown): NormalizedModelReply;
}

/** Bump whenever a fresh provider probe must prove a changed wire/session contract. */
export const CURRENT_AGENT_SESSION_CONTRACT_VERSION = 1;

/** A rejected terminal artifact gets a small, bounded correction window outside exploration. */
const MIN_ARTIFACT_REPAIR_MODEL_TURNS = 4;
const MAX_ARTIFACT_REPAIR_INSPECTION_CALLS = 1;

export interface ConstrainedWireSessionOptions {
  limits: AgentSessionLimits;
  signal: AbortSignal;
  host: WorkspaceToolHost;
  upstream: AgentUpstream;
  adapter: WireSessionAdapter;
  terminalMode?: AgentSessionTerminalMode;
  resultArtifactContract?: AgentResultArtifactContract;
  /** Snapshot boundary used to prove report evidence before artifact I/O. */
  resultArtifactSnapshotRoot?: string;
  /** Server-owned Portable dossier used to reject semantic terminal artifacts before host I/O. */
  resultArtifactValidationContext?: PortableResultArtifactValidationContext;
  now?: () => number;
  timer?: AgentSessionTimer;
}

/** Injectable timer boundary keeps deadline and cancellation tests deterministic. */
export interface AgentSessionTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Shared finite-state loop for every provider wire adapter. Adapters can only
 * translate messages; all local side effects and safety budgets remain here.
 */
export function createConstrainedWireSession(
  options: ConstrainedWireSessionOptions,
): AgentSession {
  validateAgentSessionLimits(options.limits);
  validateResultArtifactValidationContext(options);
  return new ConstrainedWireSession(options);
}

function validateResultArtifactValidationContext(options: ConstrainedWireSessionOptions): void {
  if (
    options.resultArtifactContract === PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT &&
    options.resultArtifactValidationContext === undefined
  ) {
    throw new AgentSessionError("runner_invalid_spec");
  }
  if (
    options.resultArtifactContract !== PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT &&
    options.resultArtifactValidationContext !== undefined
  ) {
    throw new AgentSessionError("runner_invalid_spec");
  }
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
  readonly #timer: AgentSessionTimer;
  #deadline: number | null = null;
  #started = false;
  #completed = false;
  #externallyCancelled = false;
  #timedOut = false;
  #remoteCancellation: Promise<boolean> | undefined;

  constructor(options: ConstrainedWireSessionOptions) {
    this.#options = options;
    this.#now = this.#options.now ?? Date.now;
    this.#timer = this.#options.timer ?? SYSTEM_TIMER;
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
    const timeout = this.#timer.setTimeout(
      () => {
        this.#timedOut = true;
        this.#controller.abort();
      },
      Math.max(0, this.#deadline - this.#now()),
    );
    const seenCallIds = new Set<string>();
    let modelTurns = 0;
    let toolCalls = 0;
    let inputBytes = 0;
    let outputBytes = 0;
    let toolResults: AgentToolResult[] = [];
    let artifactWritten = false;
    let artifactRepairActive = false;
    let artifactRepairTurns = 0;
    let artifactRepairInspectionAvailable = false;
    let artifactRepairReminder = false;
    const finalizationReserveTurns = Math.max(
      3,
      Math.min(8, Math.ceil(this.#options.limits.maxModelTurns / 8)),
    );
    const artifactRepairTurnLimit = Math.max(
      MIN_ARTIFACT_REPAIR_MODEL_TURNS,
      finalizationReserveTurns,
    );

    try {
      for (;;) {
        this.#throwIfStopped();
        if (
          toolResults.length > 0 &&
          toolCalls >= this.#options.limits.maxToolCalls &&
          !artifactWritten
        ) {
          throw new AgentSessionError("agent_tool_limit");
        }
        if (artifactRepairActive && artifactRepairTurns >= artifactRepairTurnLimit) {
          throw new AgentSessionError("agent_turn_limit");
        }
        if (modelTurns >= this.#options.limits.maxModelTurns) {
          throw new AgentSessionError("agent_turn_limit");
        }

        const repairInspectionAllowed = artifactRepairActive && artifactRepairInspectionAvailable;
        const finalizationRequired = !artifactWritten && !repairInspectionAllowed && (
          artifactRepairActive ||
          this.#options.limits.maxModelTurns - modelTurns <= finalizationReserveTurns ||
          this.#options.limits.maxToolCalls - toolCalls <= 2
        );
        const requestInArtifactRepair = artifactRepairActive;
        const request = this.#options.adapter.nextRequest(
          toolResults,
          finalizationRequired
            ? {
              finalizationRequired: true,
              ...(artifactRepairReminder ? { artifactRepairReminder: true } : {}),
            }
            : undefined,
        );
        artifactRepairReminder = false;
        const requestBytes = serializedByteLength(request.body);
        if (inputBytes + requestBytes > this.#options.limits.maxInputBytes) {
          throw new AgentSessionError("agent_input_byte_limit");
        }
        inputBytes += requestBytes;
        for (const result of toolResults) {
          yield {
            type: "tool",
            phase: "consumed",
            callId: result.callId,
            name: result.name,
            ...(result.ok === false ? { ok: false } : {}),
            ...(result.validationIssue === undefined ? {} : { reason: result.validationIssue }),
          };
        }
        modelTurns += 1;
        if (requestInArtifactRepair) {
          artifactRepairTurns += 1;
          artifactRepairInspectionAvailable = false;
        }
        const response = await raceWithAbort(
          Promise.resolve().then(() => this.#options.upstream.request({
            ...request,
            signal: this.#controller.signal,
          })),
          this.#controller.signal,
        );
        this.#throwIfStopped();
        let reply: NormalizedModelReply;
        try {
          const responseBytes = serializedByteLength(response);
          if (outputBytes + responseBytes > this.#options.limits.maxOutputBytes) {
            throw new AgentSessionError("agent_output_byte_limit");
          }
          outputBytes += responseBytes;
          reply = this.#options.adapter.readResponse(response);
        } catch (error) {
          if (
            artifactRepairActive &&
            error instanceof AgentSessionError &&
            error.code === "agent_protocol_error"
          ) {
            artifactRepairInspectionAvailable = false;
            artifactRepairReminder = true;
            toolResults = [];
            continue;
          }
          throw error;
        }
        const usage = reply.usage ?? emptyUsage();
        yield { type: "usage", usage };

        if (reply.toolCalls.length === 0) {
          if (artifactRepairActive && !artifactWritten) {
            artifactRepairInspectionAvailable = false;
            artifactRepairReminder = true;
            toolResults = [];
            continue;
          }
          if (finalizationRequired && !artifactWritten) {
            throw new AgentSessionError("agent_protocol_error");
          }
          yield { type: "completion", text: reply.text, structured: reply.structured };
          this.#completed = true;
          return;
        }

        validateTerminalResultsWrite(reply.toolCalls);
        if (this.#options.terminalMode === "artifact-write") {
          validateArtifactTerminalWrite(reply.toolCalls);
        }
        if (
          repairInspectionAllowed &&
          reply.toolCalls.length > MAX_ARTIFACT_REPAIR_INSPECTION_CALLS
        ) {
          throw new AgentSessionError("agent_protocol_error");
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
          const remainingOutputBytes = this.#options.limits.maxOutputBytes - outputBytes;
          let result: WorkspaceToolResult;
          let recoveredBeforeIo = false;
          let hostCallStarted = false;
          let artifactValidationIssue: ResultArtifactValidationIssue | undefined;
          let artifactRepairDetail: ResultArtifactRepairDetail | undefined;
          try {
            if (finalizationRequired && call.name !== "results.write") {
              result = terminalArtifactRequiredResult();
              recoveredBeforeIo = true;
            } else {
              const normalizedInput = call.name === "results.write"
                ? normalizeResultArtifactInput(
                  call.input,
                  this.#options.resultArtifactContract,
                  this.#options.resultArtifactSnapshotRoot,
                  this.#options.resultArtifactValidationContext,
                  (issue, detail) => {
                    artifactValidationIssue = issue;
                    artifactRepairDetail = detail;
                  },
                )
                : call.input;
              if (normalizedInput === null) throw new AgentSessionError("tool_argument_invalid");
              if (this.#options.host.minimumOutputBytes(call.name, normalizedInput) > remainingOutputBytes) {
                throw new AgentSessionError("agent_output_byte_limit");
              }
              hostCallStarted = true;
              result = await this.#options.host.call(call.name, normalizedInput, {
                maxOutputBytes: remainingOutputBytes,
              });
            }
          } catch (error) {
            const recovered = recoverableWorkspaceToolFailure(
              call,
              error,
              !hostCallStarted,
              this.#options.resultArtifactContract,
              artifactValidationIssue,
              artifactRepairDetail,
              this.#options.resultArtifactValidationContext?.reportShard !== undefined,
            );
            if (recovered === null) throw error;
            result = recovered;
            recoveredBeforeIo = true;
          }
          if (
            call.name === "results.write" && recoveredBeforeIo &&
            this.#options.terminalMode === "artifact-write"
          ) {
            artifactRepairActive = true;
            artifactRepairInspectionAvailable = true;
          } else if (call.name === "results.write" && !recoveredBeforeIo) {
            artifactRepairActive = false;
          }
          this.#throwIfStopped();
          const resultBytes = Buffer.byteLength(result.content, "utf8");
          if (outputBytes + resultBytes > this.#options.limits.maxOutputBytes) {
            throw new AgentSessionError("agent_output_byte_limit");
          }
          outputBytes += resultBytes;
          toolResults.push({
            callId: call.id,
            name: call.name,
            content: result.content,
            ...(recoveredBeforeIo ? { ok: false } : {}),
            ...(artifactValidationIssue === undefined ? {} : { validationIssue: artifactValidationIssue }),
          });
          yield {
            type: "tool",
            phase: "result",
            callId: call.id,
            name: call.name,
            ...(recoveredBeforeIo ? { ok: false } : {}),
            ...(artifactValidationIssue === undefined ? {} : { reason: artifactValidationIssue }),
          };
          if (result.artifact !== undefined) {
            if (call.name === "results.write" && !recoveredBeforeIo) artifactWritten = true;
            yield { type: "artifact", path: result.artifact.path, bytes: result.artifact.bytes };
          }
        }
        if (artifactWritten && this.#options.terminalMode === "artifact-write") {
          this.#completed = true;
          return;
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
      this.#timer.clearTimeout(timeout);
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
    return !this.#externallyCancelled && (this.#timedOut ||
      (this.#deadline !== null && this.#now() >= this.#deadline));
  }

  #requestRemoteCancellation(): Promise<boolean> {
    if (this.#remoteCancellation === undefined) {
      const operation = Promise.resolve().then(() => this.#options.upstream.cancel?.());
      this.#remoteCancellation = boundedCancellation(operation, this.#timer);
    }
    return this.#remoteCancellation;
  }
}

function terminalArtifactRequiredResult(): WorkspaceToolResult {
  return {
    content: JSON.stringify({
      error: "finalization_required",
      hint: "Exploration is closed. Call results.write with the declared artifact now.",
    }),
  };
}

function validateTerminalResultsWrite(toolCalls: readonly AgentToolCall[]): void {
  let sawResultsWrite = false;
  for (const [index, call] of toolCalls.entries()) {
    if (call.name !== "results.write") continue;
    if (sawResultsWrite || index !== toolCalls.length - 1) {
      throw new AgentSessionError("agent_protocol_error");
    }
    sawResultsWrite = true;
  }
}

/** A terminal artifact cannot rely on a tool result the provider has not consumed. */
function validateArtifactTerminalWrite(toolCalls: readonly AgentToolCall[]): void {
  if (
    toolCalls.some((call) => call.name === "results.write") &&
    toolCalls.length !== 1
  ) {
    throw new AgentSessionError("agent_protocol_error");
  }
}

const RECOVERABLE_WORKSPACE_TOOL_ERRORS = new Set<AgentSessionErrorCode>([
  "tool_path_denied",
  "tool_argument_invalid",
  "tool_read_limit",
  "tool_output_limit",
]);

function recoverableWorkspaceToolFailure(
  call: AgentToolCall,
  error: unknown,
  beforeHostIo = false,
  resultArtifactContract?: AgentResultArtifactContract,
  artifactValidationIssue?: ResultArtifactValidationIssue,
  artifactRepairDetail?: ResultArtifactRepairDetail,
  reportShard = false,
): WorkspaceToolResult | null {
  if ((call.name === "results.write" && !beforeHostIo) || !(error instanceof AgentSessionError) ||
      !RECOVERABLE_WORKSPACE_TOOL_ERRORS.has(error.code)) return null;
  const hint = error.code === "tool_path_denied"
    ? "Use '.' for the virtual root or a repository-relative path."
    : call.name === "results.write"
      ? resultArtifactContract === PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT
        ? reportShard
          ? "Use the declared result path and pass one complete compact JSON object containing only schemaVersion:1, optional stage:'report', and findings. Include exactly one substantive finding for every carried candidateId, with non-empty rootCause, impact, remediation, and pinned anchors. Do not include summary, observations, scope, coverage, disposition, or reason fields."
          : artifactRepairDetail?.kind === "candidate-contract"
            ? "Discovery candidates must be an array of at most 100 exact objects with only id, category, and anchors. IDs must be unique identifiers. Each anchors value must be an array of exact path, startLine, endLine, role, and optional explanation objects. Correct the indicated item and do not add extra keys."
          : artifactValidationIssue === "dossier-semantics-invalid"
          ? "Use the declared result path and pass one complete compact JSON object. For dataflow and validation, omit candidates and use only candidateId values from BEGIN_PORTABLE_CANDIDATE_IDS_JSON exactly as listed. Do not rename or invent candidate ids."
          : "Use the declared result path and pass one complete compact JSON object with schemaVersion 1 and the stage matching that path. Include a non-empty summary, observations [], and scope paths as '.' or repository-relative paths. Candidate, assessment, finding, coverage, and evidence fields must match the declared stage contract and pinned line ranges."
        : resultArtifactContract === MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT
          ? "Write report.json as one complete compact JSON object with schemaVersion:1, engine:'mantis', stage:'report', and findings. Every finding needs id, title, severity, remediation or mitigation, and code_paths. Every code_paths entry must be a repository-relative path followed by :line or :start-end. Correct the indicated finding and locator; do not remove a finding to bypass evidence validation."
          : "Use the declared result path and pass one complete compact JSON artifact matching the declared stage contract."
      : "Correct the tool arguments and stay within the declared read limits.";
  return {
    content: JSON.stringify({
      error: error.code,
      ...(artifactValidationIssue === undefined ? {} : { reason: artifactValidationIssue }),
      ...(artifactRepairDetail === undefined ? {} : { repair: artifactRepairDetail }),
      hint,
    }),
  };
}

const REMOTE_CANCELLATION_GRACE_MS = 100;

const SYSTEM_TIMER: AgentSessionTimer = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Remote providers may ignore cancellation indefinitely. The local session
 * must finish on its own deadline, while these handlers consume late settle.
 */
function boundedCancellation(
  operation: Promise<boolean | void>,
  timer: AgentSessionTimer,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: unknown;
    const finish = (remote: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) timer.clearTimeout(timeout);
      resolve(remote);
    };
    timeout = timer.setTimeout(() => finish(false), REMOTE_CANCELLATION_GRACE_MS);
    if (settled) timer.clearTimeout(timeout);
    void operation.then(
      (value) => finish(value === true),
      () => finish(false),
    );
  });
}

/**
 * AbortSignal is advisory at the provider boundary. This race makes the local
 * deadline authoritative while retaining a rejection handler on late upstream
 * settlement so a non-cooperative client cannot hang the session or leak an
 * unhandled rejection.
 */
function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new AgentSessionError("agent_cancelled"));
    };

    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function emptyUsage(): AgentUsage {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
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
