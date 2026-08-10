import type { ProviderModel } from "@csb/shared";

import {
  AgentSessionError,
  isWorkspaceToolName,
  type AgentToolCall,
  type AgentToolResult,
  type AgentWireRequest,
  type NormalizedModelReply,
  type WireSessionAdapter,
} from "./session-types.js";

export interface OpenAiResponsesSessionSpec {
  routeKind: string;
  model: ProviderModel;
  instructions: string;
}

/** Translates the four fixed local tools to OpenAI Responses wire objects. */
export function createOpenAiResponsesWireAdapter(
  spec: OpenAiResponsesSessionSpec,
): WireSessionAdapter {
  const endpoint = openAiResponsesEndpoint(spec.routeKind);
  let previousResponseId: string | undefined;

  return {
    nextRequest(toolResults: readonly AgentToolResult[]): AgentWireRequest {
      const input = toolResults.length === 0
        ? [{ role: "user", content: spec.instructions }]
        : toolResults.map((result) => ({
          type: "function_call_output",
          call_id: result.callId,
          output: result.content,
        }));
      return {
        url: endpoint,
        body: {
          model: spec.model.id,
          instructions: spec.instructions,
          input,
          tools: openAiResponsesTools(),
          ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
        },
      };
    },
    readResponse(response: unknown): NormalizedModelReply {
      const root = record(response);
      if (typeof root.id === "string" && root.id.length > 0) previousResponseId = root.id;
      const output = root.output;
      if (!Array.isArray(output)) throw protocolError();
      const toolCalls: AgentToolCall[] = [];
      const textParts: string[] = [];
      for (const rawItem of output) {
        const item = record(rawItem);
        if (item.type === "function_call") {
          toolCalls.push(readFunctionCall(item));
          continue;
        }
        if (item.type === "message") textParts.push(...responseMessageText(item.content));
      }
      const text = textParts.join("") || optionalText(root.output_text);
      return {
        toolCalls,
        text,
        structured: structuredValue(root.output_parsed ?? root.parsed, text),
        usage: responseUsage(root.usage),
      };
    },
  };
}

export function openAiResponsesEndpoint(routeKind: string): string {
  switch (routeKind) {
    case "openai-api":
      return "https://api.openai.com/v1/responses";
    case "xai-api":
      return "https://api.x.ai/v1/responses";
    default:
      throw new AgentSessionError("runner_protocol_unsupported");
  }
}

function openAiResponsesTools(): readonly unknown[] {
  return [
    responseTool("workspace.list", "List read-only files from the workspace snapshot.", {
      path: stringSchema(), maxEntries: integerSchema(), maxDepth: integerSchema(),
    }),
    responseTool("workspace.read", "Read a file from the workspace snapshot.", {
      path: requiredStringSchema(), maxBytes: integerSchema(),
    }, ["path"]),
    responseTool("workspace.search", "Search read-only workspace files for literal text.", {
      query: requiredStringSchema(), path: stringSchema(), maxResults: integerSchema(), maxBytes: integerSchema(),
    }, ["query"]),
    responseTool("results.write", "Write a result artifact below the run artifact directory.", {
      path: requiredStringSchema(), content: requiredStringSchema(),
    }, ["path", "content"]),
  ];
}

function responseTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[] = [],
) {
  return {
    type: "function",
    name,
    description,
    strict: true,
    parameters: { type: "object", additionalProperties: false, properties, required },
  };
}

function readFunctionCall(value: Record<string, unknown>): AgentToolCall {
  if (typeof value.call_id !== "string" || value.call_id.length === 0 || !isWorkspaceToolName(value.name)) {
    throw protocolError();
  }
  return {
    id: value.call_id,
    name: value.name,
    input: argumentsObject(value.arguments),
  };
}

function responseMessageText(value: unknown): string[] {
  if (!Array.isArray(value)) throw protocolError();
  return value.flatMap((raw) => {
    const block = record(raw);
    if (block.type !== "output_text") return [];
    return typeof block.text === "string" ? [block.text] : [];
  });
}

function argumentsObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw protocolError();
  try {
    return record(JSON.parse(value));
  } catch {
    throw protocolError();
  }
}

function responseUsage(value: unknown) {
  const usage = optionalRecord(value);
  const inputDetails = optionalRecord(usage?.input_tokens_details);
  const outputDetails = optionalRecord(usage?.output_tokens_details);
  return {
    inputTokens: finiteNumber(usage?.input_tokens),
    cachedInputTokens: finiteNumber(inputDetails?.cached_tokens),
    outputTokens: finiteNumber(usage?.output_tokens),
    reasoningTokens: finiteNumber(outputDetails?.reasoning_tokens),
  };
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

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
