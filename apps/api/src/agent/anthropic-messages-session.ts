import type { ProviderModel } from "@csb/shared";

import {
  AgentSessionError,
  validateAgentSessionReasoningEffort,
  type AgentToolCall,
  type AgentToolResult,
  type AgentWireRequestControl,
  type AgentWireRequest,
  type NormalizedModelReply,
  type WireSessionAdapter,
} from "./session-types.js";
import {
  resultArtifactContentSchema,
  resultArtifactPathSchema,
  type AgentResultArtifactContract,
} from "./result-artifact-contract.js";
import {
  WORKSPACE_TOOL_WIRE_CODEC,
  WORKSPACE_TOOL_WIRE_DESCRIPTIONS,
} from "./workspace-tool-wire-codec.js";
import { parseStructuredResult } from "./structured-result.js";

export interface AnthropicMessagesSessionSpec {
  model: ProviderModel;
  instructions: string;
  reasoningEffort?: string;
  resultArtifactContract?: AgentResultArtifactContract;
}

/** Translates the four fixed local tools to Anthropic Messages wire objects. */
export function createAnthropicMessagesWireAdapter(
  spec: AnthropicMessagesSessionSpec,
): WireSessionAdapter {
  validateAgentSessionReasoningEffort(spec.model, spec.reasoningEffort);
  const messages: unknown[] = [{ role: "user", content: spec.instructions }];
  let finalizing = false;

  return {
    nextRequest(
      toolResults: readonly AgentToolResult[],
      control?: AgentWireRequestControl,
    ): AgentWireRequest {
      if (toolResults.some((result) => result.name === "results.write" && result.ok !== false)) finalizing = true;
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
          ...(finalizing
            ? {}
            : {
              tools: anthropicTools(
                spec.resultArtifactContract,
                control?.finalizationRequired === true,
              ),
              ...(control?.finalizationRequired === true
                ? { tool_choice: { type: "any" } }
                : {}),
            }),
          ...(spec.reasoningEffort === undefined ? {} : { output_config: { effort: spec.reasoningEffort } }),
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
      if (finalizing && toolCalls.length > 0) throw protocolError();
      messages.push({ role: "assistant", content });
      const text = textParts.join("") || null;
      return {
        toolCalls,
        text,
        structured: parseStructuredResult(root.structured_output ?? root.parsed, text),
        usage: anthropicUsage(root.usage),
      };
    },
  };
}

function anthropicTools(
  resultArtifactContract?: AgentResultArtifactContract,
  resultsWriteOnly = false,
): readonly unknown[] {
  const tools = [
    anthropicTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.list"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.list"], {
      path: stringSchema(), maxEntries: integerSchema(), maxDepth: integerSchema(),
    }),
    anthropicTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.read"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.read"], {
      path: requiredStringSchema(), maxBytes: integerSchema(),
    }, ["path"]),
    anthropicTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.search"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.search"], {
      query: requiredStringSchema(), path: stringSchema(), maxResults: integerSchema(), maxBytes: integerSchema(),
    }, ["query"]),
    anthropicTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("results.write"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["results.write"], {
      path: resultArtifactPathSchema(resultArtifactContract),
      content: resultArtifactContentSchema(resultArtifactContract),
    }, ["path", "content"]),
  ];
  return resultsWriteOnly ? [tools[3]!] : tools;
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
  if (typeof value.id !== "string" || value.id.length === 0 || typeof value.name !== "string") {
    throw protocolError();
  }
  const name = WORKSPACE_TOOL_WIRE_CODEC.toInternal(value.name);
  if (name === null) throw protocolError();
  return { id: value.id, name, input: record(value.input) };
}

function anthropicUsage(value: unknown) {
  const usage = optionalRecord(value);
  const uncachedInputTokens = finiteNumber(usage?.input_tokens);
  const cachedInputTokens = finiteNumber(usage?.cache_read_input_tokens);
  const cacheWriteInputTokens = finiteNumber(usage?.cache_creation_input_tokens);
  return {
    inputTokens: normalizedAnthropicInputTokens(
      uncachedInputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
    ),
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens: finiteNumber(usage?.output_tokens),
    reasoningTokens: finiteNumber(usage?.reasoning_tokens),
  };
}

/**
 * Anthropic's input_tokens is only uncached input. When both optional cache
 * counters are present, normalize to total input. If either is absent, retain
 * the raw counter and leave the missing cache bucket null so pricing remains
 * unavailable instead of treating unknown cache use as zero.
 */
function normalizedAnthropicInputTokens(
  uncachedInputTokens: number | null,
  cachedInputTokens: number | null,
  cacheWriteInputTokens: number | null,
): number | null {
  if (uncachedInputTokens === null) return null;
  if (cachedInputTokens === null || cacheWriteInputTokens === null) return uncachedInputTokens;
  return uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens;
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
