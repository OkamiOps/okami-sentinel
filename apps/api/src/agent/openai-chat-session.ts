import type { ModelCapabilities, ProviderModel } from "@csb/shared";

import { createWorkspaceToolHost } from "./workspace-tool-host.js";
import {
  AgentSessionError,
  validateAgentSessionReasoningEffort,
  createConstrainedWireSession,
  type AgentEvent,
  type AgentSession,
  type AgentSessionLimits,
  type AgentToolCall,
  type AgentToolResult,
  type AgentUpstream,
  type AgentWireRequest,
  type NormalizedModelReply,
  type WireSessionAdapter,
} from "./session-types.js";
import {
  WORKSPACE_TOOL_WIRE_CODEC,
  WORKSPACE_TOOL_WIRE_DESCRIPTIONS,
} from "./workspace-tool-wire-codec.js";
import { parseStructuredResult } from "./structured-result.js";

export interface OpenAiChatSessionSpec {
  model: ProviderModel;
  instructions: string;
  routeKind: string;
  reasoningEffort?: string;
}

export interface OpenAiChatProbeSpec {
  snapshotRoot: string;
  artifactRoot: string;
  instructions: string;
  limits: AgentSessionLimits;
  signal: AbortSignal;
}

export interface OpenAiChatProbeRoute {
  connectionId: string;
  routeKind: string;
}

export interface AgentProbeMeasurement {
  capabilities: Partial<ModelCapabilities>;
  limitsEnforced: boolean;
  agentLoop: {
    workspaceToolRequested: boolean;
    workspaceToolResultConsumed: boolean;
    resultsWriteRequested: boolean;
    artifactProduced: boolean;
    structuredResultProduced: boolean;
  };
}

/** Creates the wire translator only; all local side effects remain in the runner. */
export function createOpenAiChatWireAdapter(spec: OpenAiChatSessionSpec): WireSessionAdapter {
  validateAgentSessionReasoningEffort(
    spec.model,
    spec.reasoningEffort,
    spec.routeKind,
    "openai-chat",
  );
  const messages: unknown[] = [{ role: "system", content: spec.instructions }];
  const replayMimoReasoning = spec.routeKind === "mimo-token-plan";
  let finalizing = false;

  return {
    nextRequest(toolResults: readonly AgentToolResult[]): AgentWireRequest {
      if (toolResults.some((result) => result.name === "results.write")) finalizing = true;
      for (const result of toolResults) {
        messages.push({ role: "tool", tool_call_id: result.callId, content: result.content });
      }
      return {
        operation: "chat-completions",
        body: {
          model: spec.model.id,
          messages,
          ...(finalizing
            ? { response_format: { type: "json_object" } }
            : {
              tools: openAiChatTools(),
              tool_choice: "required",
            }),
          ...reasoningField(spec.routeKind, spec.reasoningEffort),
        },
      };
    },
    readResponse(response: unknown): NormalizedModelReply {
      const root = record(response);
      const choices = root.choices;
      if (!Array.isArray(choices) || choices.length === 0) throw protocolError();
      const choice = record(choices[0]);
      const message = record(choice.message);
      const calls = readOpenAiChatCalls(message.tool_calls);
      if (finalizing && calls.length > 0) throw protocolError();
      const text = textValue(message.content);
      const structured = parseStructuredResult(message.parsed ?? root.output_parsed, text);
      const reasoningContent = replayMimoReasoning ? opaqueReasoningContent(message.reasoning_content) : undefined;
      messages.push({
        role: "assistant",
        content: text,
        ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent }),
        ...(calls.length === 0 ? {} : { tool_calls: message.tool_calls }),
      });
      return {
        toolCalls: calls,
        text,
        structured,
        usage: openAiUsage(root.usage),
      };
    },
  };
}

function reasoningField(
  routeKind: string,
  reasoningEffort: string | undefined,
): Record<string, unknown> {
  if (reasoningEffort === undefined) return {};
  return routeKind === "openrouter-api"
    ? { reasoning: { effort: reasoningEffort } }
    : { reasoning_effort: reasoningEffort };
}

/**
 * A probe is deliberately measured through the exact same tool loop used by a
 * real session. It never infers capability from a provider name or model ID.
 */
export async function probeOpenAiChatSession(
  route: OpenAiChatProbeRoute,
  model: ProviderModel,
  spec: OpenAiChatProbeSpec,
  upstream: AgentUpstream,
): Promise<AgentProbeMeasurement> {
  const evidence = {
    workspaceToolRequested: false,
    workspaceToolResultConsumed: false,
    resultsWriteRequested: false,
    artifactProduced: false,
    structuredResultProduced: false,
  };
  let stage = 0;
  let limitsEnforced = false;
  try {
    const host = await createWorkspaceToolHost({
      snapshotRoot: spec.snapshotRoot,
      artifactRoot: spec.artifactRoot,
      maxReadBytes: Math.min(spec.limits.maxOutputBytes, 1_048_576),
      maxWriteBytes: spec.limits.maxOutputBytes,
    });
    const session: AgentSession = createConstrainedWireSession({
      limits: spec.limits,
      signal: spec.signal,
      host,
      upstream,
      adapter: createOpenAiChatWireAdapter({
        model,
        instructions: spec.instructions,
        routeKind: route.routeKind,
      }),
    });
    limitsEnforced = true;
    for await (const event of session.run()) advanceProbeEvidence(event, evidence, (next) => { stage = next; }, stage);
  } catch {
    // A failed or malformed probe remains unknown. Do not leak provider errors.
  }

  const complete = stage === 5;
  return {
    capabilities: {
      tools: complete ? "supported" : "unknown",
      artifactOutput: complete ? "supported" : "unknown",
      structuredOutput: complete ? "supported" : "unknown",
      boundedExecution: limitsEnforced ? "supported" : "unknown",
    },
    limitsEnforced,
    agentLoop: evidence,
  };
}

function advanceProbeEvidence(
  event: AgentEvent,
  evidence: AgentProbeMeasurement["agentLoop"],
  setStage: (stage: number) => void,
  stage: number,
): void {
  if (event.type === "tool" && event.phase === "requested" &&
      event.name !== "results.write" && stage === 0) {
    evidence.workspaceToolRequested = true;
    setStage(1);
    return;
  }
  if (event.type === "tool" && event.phase === "consumed" &&
      event.name !== "results.write" && stage === 1) {
    evidence.workspaceToolResultConsumed = true;
    setStage(2);
    return;
  }
  if (event.type === "tool" && event.phase === "requested" &&
      event.name === "results.write" && stage === 2) {
    evidence.resultsWriteRequested = true;
    setStage(3);
    return;
  }
  if (event.type === "artifact" && stage === 3) {
    evidence.artifactProduced = true;
    setStage(4);
    return;
  }
  if (event.type === "completion" && event.structured !== null && stage === 4) {
    evidence.structuredResultProduced = true;
    setStage(5);
  }
}

function openAiChatTools(): readonly unknown[] {
  return [
    {
      type: "function",
      function: {
        name: WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.list"),
        description: WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.list"],
        parameters: objectSchema({ path: stringSchema(), maxEntries: integerSchema(), maxDepth: integerSchema() }),
      },
    },
    {
      type: "function",
      function: {
        name: WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.read"),
        description: WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.read"],
        parameters: objectSchema({ path: requiredStringSchema(), maxBytes: integerSchema() }, ["path"]),
      },
    },
    {
      type: "function",
      function: {
        name: WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.search"),
        description: WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.search"],
        parameters: objectSchema({ query: requiredStringSchema(), path: stringSchema(), maxResults: integerSchema(), maxBytes: integerSchema() }, ["query"]),
      },
    },
    {
      type: "function",
      function: {
        name: WORKSPACE_TOOL_WIRE_CODEC.toWire("results.write"),
        description: WORKSPACE_TOOL_WIRE_DESCRIPTIONS["results.write"],
        parameters: objectSchema({ path: requiredStringSchema(), content: requiredStringSchema() }, ["path", "content"]),
      },
    },
  ];
}

function readOpenAiChatCalls(value: unknown): AgentToolCall[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw protocolError();
  return value.map((candidate) => {
    const call = record(candidate);
    const functionCall = record(call.function);
    if (typeof call.id !== "string" || call.id.length === 0 || typeof functionCall.name !== "string") {
      throw protocolError();
    }
    const name = WORKSPACE_TOOL_WIRE_CODEC.toInternal(functionCall.name);
    if (name === null) throw protocolError();
    return {
      id: call.id,
      name,
      input: objectArguments(functionCall.arguments),
    };
  });
}

/** Returns provider reasoning only for opaque replay in the next wire request. */
function opaqueReasoningContent(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function openAiUsage(value: unknown) {
  const usage = optionalRecord(value);
  const inputDetails = optionalRecord(usage?.prompt_tokens_details);
  const outputDetails = optionalRecord(usage?.completion_tokens_details);
  return {
    inputTokens: finiteNumber(usage?.prompt_tokens),
    cachedInputTokens: finiteNumber(inputDetails?.cached_tokens),
    cacheWriteInputTokens: finiteNumber(inputDetails?.cache_write_tokens),
    outputTokens: finiteNumber(usage?.completion_tokens),
    reasoningTokens: finiteNumber(outputDetails?.reasoning_tokens),
  };
}

function objectArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw protocolError();
  try {
    return record(JSON.parse(value));
  } catch {
    throw protocolError();
  }
}

function textValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map((part) => {
      const block = record(part);
      return typeof block.text === "string" ? block.text : "";
    }).join("");
    return text.length === 0 ? null : text;
  }
  throw protocolError();
}

function record(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw protocolError();
  return value;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function protocolError(): AgentSessionError {
  return new AgentSessionError("agent_protocol_error");
}

function stringSchema() {
  return { type: "string" };
}

function requiredStringSchema() {
  return { type: "string", minLength: 1 };
}

function integerSchema() {
  return { type: "integer", minimum: 1 };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
) {
  return { type: "object", additionalProperties: false, properties, required };
}
