import type { PortableAnchorContractRepairDetail } from "../scanners/portable-codex-security-dossier.js";
import type { GraphIndex } from "../graphify/graph-index.js";
import path from "node:path";
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
  type DiscoveryScopeIssue,
} from "./result-artifact-contract.js";
import { MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT } from "../scanners/mantis-report-contract.js";

export const WORKSPACE_TOOL_NAMES = [
  "workspace.list",
  "workspace.read",
  "workspace.search",
  "workspace.graph",
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
  constructor(readonly code: AgentSessionErrorCode, readonly protocolIssue?: string) {
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
  /** Server-built index for this immutable snapshot; never provider supplied. */
  graphIndex?: GraphIndex;
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
  /** Zero disables elapsed-time expiration; cancellation and usage limits still apply. */
  timeoutMs: number;
}

export type AgentSessionTerminalMode = "provider-completion" | "artifact-write";

/** Closed upper bound for a server-selected provider completion request. */
export const MAX_AGENT_SESSION_COMPLETION_TOKENS = 65_536;

export interface AgentSessionSpec {
  /** Server-built index for this immutable snapshot. */
  graphIndex?: GraphIndex;
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
  /** After this many model replies, artifact-write sessions expose only results.write. */
  artifactWriteByTurn?: number;
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

/** Codes that are safe to expose in local tool telemetry after a recoverable rejection. */
export type RecoverableWorkspaceToolErrorCode = Extract<
  AgentSessionErrorCode,
  "tool_path_denied" | "tool_argument_invalid" | "tool_read_limit" | "tool_output_limit"
>;

export type AgentEvent =
  | {
    type: "tool";
    phase: "requested" | "result" | "consumed";
    callId: string;
    name: WorkspaceToolName;
    /** False only when the tool result is a safe local rejection, not host evidence. */
    ok?: boolean;
    /** Closed, non-content code for a recoverable workspace tool rejection. */
    errorCode?: RecoverableWorkspaceToolErrorCode;
    /** Closed, non-content diagnostic for a rejected terminal artifact. */
    reason?: ResultArtifactValidationIssue;
    scopeIssue?: DiscoveryScopeIssue;
    anchorIssue?: PortableAnchorContractRepairDetail;
  }
  | { type: "artifact"; path: string; bytes: number }
  | { type: "usage"; usage: AgentUsage }
  | { type: "completion"; text: string | null; structured: unknown | null }
  | { type: "failure"; code: AgentSessionErrorCode; reason?: ResultArtifactValidationIssue; protocolIssue?: string }
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
  /** Closed, non-content code for a recoverable workspace tool rejection. */
  errorCode?: RecoverableWorkspaceToolErrorCode;
  /** Closed, non-content diagnostic retained only for safe telemetry. */
  validationIssue?: ResultArtifactValidationIssue;
  scopeIssue?: DiscoveryScopeIssue;
  anchorIssue?: PortableAnchorContractRepairDetail;
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

export const AGENT_PORTABLE_FINALIZATION_REMINDER =
  "Exploration is ending. Consolidate the evidence already collected into the complete declared stage artifact now. Preserve all candidate hypotheses and findings; do not discard work or emit a placeholder to finish. Discovery must include a substantive review summary, explicit candidates (empty only if the reviewed evidence supports no leads), and exact inspected source files plus honest unexamined scope. Do not claim a directory listing or search snippet as a completed file review. Call results.write alone with the complete artifact.";

export interface WireSessionAdapter {
  nextRequest(
    toolResults: readonly AgentToolResult[],
    control?: AgentWireRequestControl,
  ): AgentWireRequest;
  readResponse(response: unknown): NormalizedModelReply;
  readUsage?(response: unknown): AgentUsage;
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
  artifactWriteByTurn?: number;
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
    if (!Number.isSafeInteger(value) || value < (key === "timeoutMs" ? 0 : 1) || value > maximum) {
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
    this.#deadline = this.#options.limits.timeoutMs === 0
      ? null : this.#now() + this.#options.limits.timeoutMs;
    const detachAbort = this.#attachExternalAbort();
    const timeout = this.#deadline === null ? undefined : this.#timer.setTimeout(
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
    // Small probe/test budgets retain their original behavior. This reserve is
    // for terminal model output and bounded repair, not extra total capacity.
    const outputReserve = this.#options.terminalMode === "artifact-write" &&
      this.#options.limits.maxOutputBytes >= 65_536
      ? Math.min(262_144, Math.floor(this.#options.limits.maxOutputBytes / 4)) : 0;
    let outputFinalizationRequired = false;
    let toolResults: AgentToolResult[] = [];
    let artifactWritten = false;
    let artifactRepairActive = false;
    let protocolRepairAttempts = 0;
    let lastArtifactValidationIssue: ResultArtifactValidationIssue | undefined;
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
          artifactRepairActive || outputFinalizationRequired ||
          (outputReserve > 0 && outputBytes >= this.#options.limits.maxOutputBytes - outputReserve) ||
          (this.#options.artifactWriteByTurn !== undefined &&
            modelTurns >= this.#options.artifactWriteByTurn) ||
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
            ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
            ...(result.validationIssue === undefined ? {} : { reason: result.validationIssue }),
            ...(result.scopeIssue === undefined ? {} : { scopeIssue: result.scopeIssue }),
            ...(result.anchorIssue === undefined ? {} : { anchorIssue: result.anchorIssue }),
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
          if (this.#options.adapter.readUsage !== undefined) {
            yield { type: "usage", usage: this.#options.adapter.readUsage(response) };
          }
          if (
            this.#options.terminalMode === "artifact-write" &&
            !artifactWritten && protocolRepairAttempts < 2 &&
            error instanceof AgentSessionError &&
            error.code === "agent_protocol_error"
          ) {
            protocolRepairAttempts += 1;
            artifactRepairActive = true;
            artifactRepairInspectionAvailable = false;
            artifactRepairReminder = true;
            toolResults = [];
            continue;
          }
          throw error;
        }
        const usage = reply.usage ?? emptyUsage();
        yield { type: "usage", usage };

        // Reject the entire batch before I/O. The adapter has recorded every tool_use,
        // so return one failed result per unique ID before requesting an isolated write.
        if (this.#options.terminalMode === "artifact-write" &&
            reply.toolCalls.length > 1 &&
            reply.toolCalls.some((call) => call.name === "results.write")) {
          const batchIds = new Set<string>();
          for (const call of reply.toolCalls) {
            if (seenCallIds.has(call.id) || batchIds.has(call.id)) {
              throw new AgentSessionError("agent_protocol_error", "duplicate_tool_call_id");
            }
            batchIds.add(call.id);
          }
          if (protocolRepairAttempts >= 2) throw new AgentSessionError("agent_protocol_error", "artifact_terminal_batch_invalid");
          if (toolCalls + reply.toolCalls.length > this.#options.limits.maxToolCalls) {
            throw new AgentSessionError("agent_tool_limit");
          }
          const content = JSON.stringify({
            error: "artifact_terminal_batch_invalid",
            hint: "No calls in this batch were executed. Call results.write alone, after consuming any required inspection results.",
          });
          const resultBytes = Buffer.byteLength(content, "utf8") * reply.toolCalls.length;
          if (outputBytes + resultBytes > this.#options.limits.maxOutputBytes) {
            throw new AgentSessionError("agent_output_byte_limit");
          }
          outputBytes += resultBytes;
          toolResults = [];
          for (const call of reply.toolCalls) {
            seenCallIds.add(call.id);
            toolCalls += 1;
            yield { type: "tool", phase: "requested", callId: call.id, name: call.name };
            toolResults.push({ callId: call.id, name: call.name, content, ok: false });
            yield { type: "tool", phase: "result", callId: call.id, name: call.name, ok: false };
          }
          protocolRepairAttempts += 1;
          artifactRepairActive = true;
          artifactRepairInspectionAvailable = false;
          artifactRepairReminder = true;
          continue;
        }

        const exhaustiveDeepReadRepair = repairInspectionAllowed &&
          this.#options.resultArtifactValidationContext?.deepCoverage !== undefined &&
          reply.toolCalls.length > 0 &&
          reply.toolCalls.every((call) => call.name === "workspace.read");
        if (
          repairInspectionAllowed &&
          reply.toolCalls.length > MAX_ARTIFACT_REPAIR_INSPECTION_CALLS &&
          !exhaustiveDeepReadRepair
        ) {
          toolResults = [];
          for (const call of reply.toolCalls) {
            if (seenCallIds.has(call.id) || toolCalls >= this.#options.limits.maxToolCalls) {
              throw new AgentSessionError(toolCalls >= this.#options.limits.maxToolCalls
                ? "agent_tool_limit"
                : "agent_protocol_error");
            }
            seenCallIds.add(call.id);
            toolCalls += 1;
            yield { type: "tool", phase: "requested", callId: call.id, name: call.name };
            toolResults.push({
              callId: call.id,
              name: call.name,
              content: JSON.stringify({
                error: "artifact_repair_batch_invalid",
                hint: "Artifact repair permits exactly one inspection tool call. Call results.write alone on the next reply.",
              }),
              ok: false,
            });
            yield { type: "tool", phase: "result", callId: call.id, name: call.name, ok: false };
          }
          artifactRepairInspectionAvailable = false;
          artifactRepairReminder = true;
          continue;
        }

        if (reply.toolCalls.length === 0) {
          if (artifactRepairActive && !artifactWritten) {
            artifactRepairInspectionAvailable = false;
            artifactRepairReminder = true;
            toolResults = [];
            continue;
          }
          if (this.#options.terminalMode === "artifact-write" && !artifactWritten) {
            artifactRepairActive = true;
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
          const explorationBudget = call.name !== "results.write" && !artifactRepairActive && outputReserve > 0
            ? Math.max(0, remainingOutputBytes - outputReserve) : remainingOutputBytes;
          let result: WorkspaceToolResult;
          let recoveredBeforeIo = false;
          let recoveredWorkspaceErrorCode: RecoverableWorkspaceToolErrorCode | undefined;
          let hostCallStarted = false;
          let artifactValidationIssue: ResultArtifactValidationIssue | undefined;
          let artifactRepairDetail: ResultArtifactRepairDetail | undefined;
          try {
            if (call.name !== "results.write" && (finalizationRequired ||
                (outputReserve > 0 && !artifactRepairActive &&
                  (outputFinalizationRequired ||
                    this.#options.host.minimumOutputBytes(call.name, call.input) > explorationBudget)))) {
              if (!finalizationRequired) outputFinalizationRequired = true;
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
                maxOutputBytes: explorationBudget,
              });
              if (call.name === "workspace.read" && typeof normalizedInput.path === "string") {
                // workspace.read returns a complete file or throws. Listings,
                // search hits, failed reads and denied finalization calls do
                // not establish file review coverage.
                this.#options.resultArtifactValidationContext?.discoveryCoverage?.observedReadPaths
                  .add(path.posix.normalize(normalizedInput.path.replaceAll("\\", "/")));
              }
              if (call.name === "workspace.read" &&
                  this.#options.resultArtifactValidationContext?.deepCoverage !== undefined &&
                  typeof normalizedInput.path === "string") {
                const deepCoverage = this.#options.resultArtifactValidationContext.deepCoverage;
                const requiredBytes = deepCoverage.requiredBytes[normalizedInput.path];
                const requestedBytes = normalizedInput.maxBytes;
                if (requiredBytes !== undefined &&
                    (requestedBytes === undefined ||
                      (typeof requestedBytes === "number" && requestedBytes >= requiredBytes))) {
                  deepCoverage.observedReadPaths.add(normalizedInput.path);
                }
              }
            }
          } catch (error) {
            if (call.name !== "results.write" && !artifactRepairActive && outputReserve > 0 &&
                error instanceof AgentSessionError && error.code === "tool_output_limit") {
              outputFinalizationRequired = true;
            }
            if (
              call.name === "results.write" &&
              artifactValidationIssue === "deep-coverage-incomplete" &&
              artifactRepairDetail === undefined &&
              this.#options.resultArtifactValidationContext?.deepCoverage !== undefined
            ) {
              const deepCoverage = this.#options.resultArtifactValidationContext.deepCoverage;
              artifactRepairDetail = {
                kind: "deep-coverage",
                missingPaths: deepCoverage.requiredPaths.filter(
                  (path) => !deepCoverage.observedReadPaths.has(path),
                ),
              };
            }
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
            recoveredWorkspaceErrorCode = recoverableWorkspaceToolErrorCode(error);
          }
          if (
            call.name === "results.write" && recoveredBeforeIo &&
            this.#options.terminalMode === "artifact-write"
          ) {
            artifactRepairActive = true;
            lastArtifactValidationIssue = artifactValidationIssue;
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
          const anchorIssue = artifactRepairDetail?.kind === "anchor-contract" ? artifactRepairDetail : undefined;
          const scopeIssue = artifactRepairDetail?.kind === "discovery-review" && artifactRepairDetail.reason === "scope"
            ? artifactRepairDetail.scopeIssue : undefined;
          toolResults.push({
            callId: call.id,
            name: call.name,
            content: result.content,
            ...(recoveredBeforeIo ? { ok: false } : {}),
            ...(recoveredWorkspaceErrorCode === undefined ? {} : { errorCode: recoveredWorkspaceErrorCode }),
            ...(artifactValidationIssue === undefined ? {} : { validationIssue: artifactValidationIssue }),
            ...(scopeIssue === undefined ? {} : { scopeIssue }),
            ...(anchorIssue === undefined ? {} : { anchorIssue }),
          });
          yield {
            type: "tool",
            phase: "result",
            callId: call.id,
            name: call.name,
            ...(recoveredBeforeIo ? { ok: false } : {}),
            ...(recoveredWorkspaceErrorCode === undefined ? {} : { errorCode: recoveredWorkspaceErrorCode }),
            ...(artifactValidationIssue === undefined ? {} : { reason: artifactValidationIssue }),
            ...(scopeIssue === undefined ? {} : { scopeIssue }),
            ...(anchorIssue === undefined ? {} : { anchorIssue }),
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
      yield {
        type: "failure",
        code: failure.code,
        ...(failure.protocolIssue === undefined ? {} : { protocolIssue: failure.protocolIssue }),
        ...(failure.code === "agent_turn_limit" && artifactRepairActive &&
          lastArtifactValidationIssue !== undefined ? { reason: lastArtifactValidationIssue } : {}),
      };
      yield { type: "cancellation", remote };
      this.#completed = true;
      throw failure;
    } finally {
      if (timeout !== undefined) this.#timer.clearTimeout(timeout);
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

const RECOVERABLE_WORKSPACE_TOOL_ERRORS = new Set<RecoverableWorkspaceToolErrorCode>([
  "tool_path_denied",
  "tool_argument_invalid",
  "tool_read_limit",
  "tool_output_limit",
]);

function recoverableWorkspaceToolErrorCode(error: unknown): RecoverableWorkspaceToolErrorCode | undefined {
  return error instanceof AgentSessionError &&
    RECOVERABLE_WORKSPACE_TOOL_ERRORS.has(error.code as RecoverableWorkspaceToolErrorCode)
    ? error.code as RecoverableWorkspaceToolErrorCode
    : undefined;
}

function recoverableWorkspaceToolFailure(
  call: AgentToolCall,
  error: unknown,
  beforeHostIo = false,
  resultArtifactContract?: AgentResultArtifactContract,
  artifactValidationIssue?: ResultArtifactValidationIssue,
  artifactRepairDetail?: ResultArtifactRepairDetail,
  reportShard = false,
): WorkspaceToolResult | null {
  const errorCode = recoverableWorkspaceToolErrorCode(error);
  if ((call.name === "results.write" && !beforeHostIo) || errorCode === undefined) return null;
  const hint = errorCode === "tool_path_denied"
    ? call.name === "workspace.read"
      ? "Use a repository-relative path to one regular file. Use workspace.list to inspect directories; do not pass '.' or a directory to workspace.read."
      : "Use '.' for the virtual root or a repository-relative path."
    : errorCode === "tool_read_limit" && call.name === "workspace.read"
      ? "workspace.read returns the whole file and never truncates. Omit maxBytes if a smaller ceiling risks rejection, or increase it only up to the declared limit. If the file still does not fit, record it as unexamined instead of repeating the read."
    : call.name === "results.write"
      ? artifactRepairDetail?.kind === "json"
        ? "The content could not be decoded as structured JSON. Repair the complete content value: use valid JSON syntax with quoted keys, correctly escaped strings, and closed delimiters. Return one complete JSON object matching the declared stage contract, not a scalar, multiple values, or multiple code fences. Do not discard supported findings to shorten the repair."
        : resultArtifactContract === PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT
        ? reportShard
          ? "Use the declared result path and pass one complete compact JSON object containing only schemaVersion:1, optional stage:'report', and findings. Include exactly one substantive finding for every carried candidateId, with non-empty rootCause, impact, remediation, and pinned anchors. Do not include summary, observations, scope, coverage, disposition, or reason fields."
          : artifactRepairDetail?.kind === "anchor-contract"
            ? "Repair only the anchor field identified by repair.field according to repair.code. Use a real repository-relative regular source file already verified with workspace.read, positive integer startLine/endLine within the file, and one role from repair.allowedRoles when supplied. Anchors contain only path, startLine, endLine, role and optional explanation. Graph symbol IDs and labels are not source paths. Preserve every candidate and its security claim; correct the locator without dropping the finding."
          : artifactRepairDetail?.kind === "anchor-ranges-out-of-bounds"
            ? "Correct each range listed in repair.violations using the supplied maxLine and the actual source location. Re-read only the relevant file if needed to locate the evidence. Do not blindly clamp a range to make it pass, invent line numbers, or discard the candidate."
          : artifactRepairDetail?.kind === "candidate-contract"
            ? "Discovery candidates must be an array of at most 100 objects with id, category, anchors and the declared hypothesis, attacker, prerequisites, expectedImpact and controlHypothesis fields. Preserve the security claim and correct the indicated item; never remove candidates to bypass validation. IDs must be unique. Anchors contain path, startLine, endLine, role and optional explanation. Follow the supplied schema for bounded field lengths and attacker values."
          : artifactRepairDetail?.kind === "discovery-review"
            ? artifactRepairDetail.reason === "summary"
              ? "Replace the placeholder with a substantive review summary of at least 40 characters explaining the actual inspected attack surfaces, controls and remaining uncertainty. Preserve supported candidates; an empty candidate array is not proof of a completed review."
              : "Correct the exact structural field identified by repair.scopeIssue.field according to repair.scopeIssue.code. For invalid-reason, choose an honest value from repair.scopeIssue.allowedReasons; do not invent reason codes. Set scope.inspected to exact paths from repair.successfulReadPaths; graph queries and search matches are not successful source reads. scope.unexamined entries contain only path and reason, use actual repository-relative files, and remain disjoint from inspected. Preserve every candidate and its claim. If successfulReadPaths is empty, make one workspace.read call for a regular source file before writing again. Do not repeat unrelated exploration to repair a structural field."
          : artifactValidationIssue === "stage-assessments-invalid"
          ? "Each assessment must contain only candidateId, status, reason, and evidence. status MUST be confirmed, rejected, or inconclusive; not-vulnerable is a reason, NEVER a status. reason MUST be control-not-present, untrusted-flow-reaches-sink, no-untrusted-source, not-reachable, sanitized, requires-privilege, out-of-scope, insufficient-evidence, or not-vulnerable. Reevaluate the assessment and choose the appropriate status and reason; do not blindly substitute a verdict. Preserve every carried candidateId and its pinned evidence. Evidence must be a non-empty array of anchors containing only path, startLine, endLine, role, and optional explanation. Return the full corrected artifact as an object."
          : artifactValidationIssue === "stage-fields-invalid"
          ? "Remove undeclared top-level fields. Non-report artifacts permit only schemaVersion, stage, summary, observations, scope, candidates, and assessments. Dataflow and validation must include assessments, omit candidates and scope, and keep observations as the empty array []. Return the full corrected artifact as an object."
          : artifactValidationIssue === "dossier-semantics-invalid"
          ? "Use the declared result path and pass one complete compact JSON object. For dataflow and validation, omit candidates and use only candidateId values from BEGIN_PORTABLE_CANDIDATE_IDS_JSON exactly as listed. Do not rename or invent candidate ids."
          : artifactValidationIssue === "report-candidate-assessment-inconclusive"
          ? "Validation must include exactly one decisive assessment for every carried candidateId. Set each status to confirmed or rejected with a valid reason and pinned evidence; do not leave any candidate inconclusive."
          : artifactValidationIssue === "deep-coverage-incomplete"
          ? "Deep discovery cannot finish until every assigned file has been read completely with workspace.read. Read only the exact repair.missingPaths entries without truncating maxBytes, then write the complete discovery artifact again."
          : "Use the declared result path and pass one complete compact JSON object with schemaVersion 1 and the stage matching that path. Include a non-empty summary, observations [], and scope paths as '.' or repository-relative paths. Candidate, assessment, finding, coverage, and evidence fields must match the declared stage contract and pinned line ranges."
        : resultArtifactContract === MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT
          ? "Write report.json as one complete compact JSON object with schemaVersion:1, engine:'mantis', stage:'report', and findings. Every finding needs id, title, severity, remediation or mitigation, and code_paths. Every code_paths entry must be a repository-relative path followed by :line or :start-end. Correct the indicated finding and locator; do not remove a finding to bypass evidence validation."
          : artifactRepairDetail?.kind === "vulnhunter-report"
            ? artifactRepairDetail.reason === "evidence"
              ? "Write sentinel-findings.json as one complete compact JSON object with schemaVersion:1 and findings. Every evidence entry must use an existing repository-relative regular file and exact positive line range previously verified with workspace_read; correct invalid paths or ranges without dropping a supported finding."
              : artifactRepairDetail.reason === "finding"
                ? "Write sentinel-findings.json as one complete compact JSON object with schemaVersion:1 and findings. Every finding must contain only the declared fields and include id, title, severity, confidence, CWE array, substantive summary, rootCause, entryPoint, dataFlow, impact, remediation, severityRationale, validation, and evidence."
                : "Write sentinel-findings.json at the declared result path as one complete compact JSON object containing only schemaVersion:1 and a findings array. Do not add Markdown, coverage, stage, summary, or provider fields."
            : "Use the declared result path and pass one complete compact JSON artifact matching the declared stage contract."
      : "Correct the tool arguments and stay within the declared read limits.";
  return {
    content: JSON.stringify({
      error: errorCode,
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
