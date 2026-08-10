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

export interface AnthropicMessagesSessionSpec {
  model: ProviderModel;
  instructions: string;
}

/** Translates the four fixed local tools to Anthropic Messages wire objects. */
export function createAnthropicMessagesWireAdapter(
  spec: AnthropicMessagesSessionSpec,
): WireSessionAdapter {
  const messages: unknown[] = [{ role: "user", content: spec.instructions }];

  return {
    nextRequest(toolResults: readonly AgentToolResult[]): AgentWireRequest {
      if (toolResults.length > 0) {
        messages.push({
          role: "user",
          content: toolResults.map((result) => ({
            type: "tool_result",
            tool_use_id: result.callId,
            content: result.content,
          })),
        });
      }
      return {
        operation: "messages",
        body: {
          model: spec.model.id,
          max_tokens: 4_096,
          messages,
          tools: anthropicTools(),
        },
      };
    },
    readResponse(response: unknown): NormalizedModelReply {
      const root = record(response);
      const content = root.content;
      if (!Array.isArray(content)) throw protocolError();
      const toolCalls: AgentToolCall[] = [];
      const textParts: string[] = [];
      for (const rawBlock of content) {
        const block = record(rawBlock);
        if (block.type === "tool_use") {
          toolCalls.push(readToolUse(block));
        } else if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        }
      }
      messages.push({ role: "assistant", content });
      const text = textParts.join("") || null;
      return {
        toolCalls,
        text,
        structured: structuredValue(root.structured_output ?? root.parsed, text),
        usage: anthropicUsage(root.usage),
      };
    },
  };
}

function anthropicTools(): readonly unknown[] {
  return [
    anthropicTool("workspace.list", "List read-only files from the workspace snapshot.", {
      path: stringSchema(), maxEntries: integerSchema(), maxDepth: integerSchema(),
    }),
    anthropicTool("workspace.read", "Read a file from the workspace snapshot.", {
      path: requiredStringSchema(), maxBytes: integerSchema(),
    }, ["path"]),
    anthropicTool("workspace.search", "Search read-only workspace files for literal text.", {
      query: requiredStringSchema(), path: stringSchema(), maxResults: integerSchema(), maxBytes: integerSchema(),
    }, ["query"]),
    anthropicTool("results.write", "Write a result artifact below the run artifact directory.", {
      path: requiredStringSchema(), content: requiredStringSchema(),
    }, ["path", "content"]),
  ];
}

function anthropicTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[] = [],
) {
  return {
    name,
    description,
    input_schema: { type: "object", additionalProperties: false, properties, required },
  };
}

function readToolUse(value: Record<string, unknown>): AgentToolCall {
  if (typeof value.id !== "string" || value.id.length === 0 || !isWorkspaceToolName(value.name)) {
    throw protocolError();
  }
  return { id: value.id, name: value.name, input: record(value.input) };
}

function anthropicUsage(value: unknown) {
  const usage = optionalRecord(value);
  return {
    inputTokens: finiteNumber(usage?.input_tokens),
    cachedInputTokens: finiteNumber(usage?.cache_read_input_tokens),
    outputTokens: finiteNumber(usage?.output_tokens),
    reasoningTokens: finiteNumber(usage?.reasoning_tokens),
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
