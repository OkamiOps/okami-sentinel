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

export interface OpenAiResponsesSessionSpec {
  model: ProviderModel;
  instructions: string;
  reasoningEffort?: string;
  resultArtifactContract?: AgentResultArtifactContract;
}

/** Translates the four fixed local tools to OpenAI Responses wire objects. */
export function createOpenAiResponsesWireAdapter(
  spec: OpenAiResponsesSessionSpec,
): WireSessionAdapter {
  validateAgentSessionReasoningEffort(spec.model, spec.reasoningEffort);
  let previousResponseId: string | undefined;
  let finalizing = false;

  return {
    nextRequest(
      toolResults: readonly AgentToolResult[],
      control?: AgentWireRequestControl,
    ): AgentWireRequest {
      if (toolResults.some((result) => result.name === "results.write" && result.ok !== false)) finalizing = true;
      const input = toolResults.length === 0
        ? [{ role: "user", content: spec.instructions }]
        : toolResults.map((result) => ({
          type: "function_call_output",
          call_id: result.callId,
          output: result.content,
        }));
      return {
        operation: "responses",
        body: {
          model: spec.model.id,
          ...(previousResponseId === undefined ? { instructions: spec.instructions } : {}),
          input,
          ...(finalizing
            ? {}
            : {
              tools: openAiResponsesTools(
                spec.resultArtifactContract,
                control?.finalizationRequired === true,
              ),
              ...(control?.finalizationRequired === true ? { tool_choice: "required" } : {}),
            }),
          ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
          ...(spec.reasoningEffort === undefined ? {} : { reasoning: { effort: spec.reasoningEffort } }),
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
      if (finalizing && toolCalls.length > 0) throw protocolError();
      const text = textParts.join("") || optionalText(root.output_text);
      return {
        toolCalls,
        text,
        structured: parseStructuredResult(root.output_parsed ?? root.parsed, text),
        usage: responseUsage(root.usage),
      };
    },
  };
}

function openAiResponsesTools(
  resultArtifactContract?: AgentResultArtifactContract,
  resultsWriteOnly = false,
): readonly unknown[] {
  const tools = [
    responseTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.list"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.list"], {
      path: stringSchema(), maxEntries: integerSchema(), maxDepth: integerSchema(),
    }),
    responseTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.read"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.read"], {
      path: requiredStringSchema(), maxBytes: integerSchema(),
    }, ["path"]),
    responseTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.search"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.search"], {
      query: requiredStringSchema(), path: stringSchema(), maxResults: integerSchema(), maxBytes: integerSchema(),
    }, ["query"]),
    responseTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("results.write"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["results.write"], {
      path: resultArtifactPathSchema(resultArtifactContract),
      content: resultArtifactContentSchema(resultArtifactContract),
    }, ["path", "content"]),
  ];
  return resultsWriteOnly ? [tools[3]!] : tools;
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
  if (typeof value.call_id !== "string" || value.call_id.length === 0 || typeof value.name !== "string") {
    throw protocolError();
  }
  const name = WORKSPACE_TOOL_WIRE_CODEC.toInternal(value.name);
  if (name === null) throw protocolError();
  return {
    id: value.call_id,
    name,
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
    cacheWriteInputTokens: finiteNumber(inputDetails?.cache_write_tokens),
    outputTokens: finiteNumber(usage?.output_tokens),
    reasoningTokens: finiteNumber(outputDetails?.reasoning_tokens),
  };
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
