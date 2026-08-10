import type { ModelCapabilities, ProviderModel } from "@csb/shared";

import { createWorkspaceToolHost } from "./workspace-tool-host.js";
import {
  AgentSessionError,
  createConstrainedWireSession,
  isWorkspaceToolName,
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

export const GEMINI_OPENAI_CHAT_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

export interface OpenAiChatSessionSpec {
  connectionId: string;
  routeKind: string;
  model: ProviderModel;
  instructions: string;
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
  const endpoint = openAiChatEndpoint(spec.routeKind);
  const messages: unknown[] = [{ role: "system", content: spec.instructions }];

  return {
    nextRequest(toolResults: readonly AgentToolResult[]): AgentWireRequest {
      for (const result of toolResults) {
        messages.push({ role: "tool", tool_call_id: result.callId, content: result.content });
      }
      return {
        url: endpoint,
        body: {
          model: spec.model.id,
          messages,
          tools: openAiChatTools(),
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
      const text = textValue(message.content);
      const structured = structuredValue(message.parsed ?? root.output_parsed, text);
      messages.push({
        role: "assistant",
        content: text,
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
        connectionId: route.connectionId,
        routeKind: route.routeKind,
        model,
        instructions: spec.instructions,
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

export function openAiChatEndpoint(routeKind: string): string {
  switch (routeKind) {
    case "gemini-api":
      return GEMINI_OPENAI_CHAT_ENDPOINT;
    case "openai-api":
      return "https://api.openai.com/v1/chat/completions";
    case "openrouter-api":
      return "https://openrouter.ai/api/v1/chat/completions";
    case "deepseek-api":
      return "https://api.deepseek.com/chat/completions";
    default:
      throw new AgentSessionError("runner_protocol_unsupported");
  }
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
        name: "workspace.list",
        description: "List read-only files from the supplied workspace snapshot.",
        parameters: objectSchema({ path: stringSchema(), maxEntries: integerSchema(), maxDepth: integerSchema() }),
      },
    },
    {
      type: "function",
      function: {
        name: "workspace.read",
        description: "Read a file from the supplied workspace snapshot.",
        parameters: objectSchema({ path: requiredStringSchema(), maxBytes: integerSchema() }, ["path"]),
      },
    },
    {
      type: "function",
      function: {
        name: "workspace.search",
        description: "Search read-only workspace files for literal text.",
        parameters: objectSchema({ query: requiredStringSchema(), path: stringSchema(), maxResults: integerSchema(), maxBytes: integerSchema() }, ["query"]),
      },
    },
    {
      type: "function",
      function: {
        name: "results.write",
        description: "Write a result artifact below the run artifact directory.",
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
    if (typeof call.id !== "string" || call.id.length === 0 || !isWorkspaceToolName(functionCall.name)) {
      throw protocolError();
    }
    return {
      id: call.id,
      name: functionCall.name,
      input: objectArguments(functionCall.arguments),
    };
  });
}

function openAiUsage(value: unknown) {
  const usage = optionalRecord(value);
  const inputDetails = optionalRecord(usage?.prompt_tokens_details);
  const outputDetails = optionalRecord(usage?.completion_tokens_details);
  return {
    inputTokens: finiteNumber(usage?.prompt_tokens),
    cachedInputTokens: finiteNumber(inputDetails?.cached_tokens),
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

function structuredValue(value: unknown, text: string | null): unknown | null {
  if (value !== undefined && value !== null && (Array.isArray(value) || isPlainRecord(value))) return value;
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) || isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
