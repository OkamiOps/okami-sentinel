import type { GraphIndex } from "../graphify/graph-index.js";
import type { ProviderModel } from "@csb/shared";

import {
  AGENT_ARTIFACT_REPAIR_REMINDER,
  AGENT_PORTABLE_MISSING_CANDIDATES_REPAIR_REMINDER,
  AGENT_PORTABLE_FINALIZATION_REMINDER,
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
  PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT,
  resultArtifactContentSchema,
  resultArtifactPathSchema,
  type AgentResultArtifactContract,
  type PortableResultArtifactValidationContext,
} from "./result-artifact-contract.js";
import {
  WORKSPACE_TOOL_WIRE_CODEC,
  WORKSPACE_TOOL_WIRE_DESCRIPTIONS,
} from "./workspace-tool-wire-codec.js";
import { parseStructuredResult } from "./structured-result.js";

export interface OpenAiResponsesSessionSpec {
  graphIndex?: GraphIndex;
  model: ProviderModel;
  instructions: string;
  reasoningEffort?: string;
  maxCompletionTokens?: number;
  resultArtifactContract?: AgentResultArtifactContract;
  resultArtifactValidationContext?: PortableResultArtifactValidationContext;
}

/** Translates the four fixed local tools to OpenAI Responses wire objects. */
export function createOpenAiResponsesWireAdapter(
  spec: OpenAiResponsesSessionSpec,
): WireSessionAdapter {
  validateAgentSessionReasoningEffort(spec.model, spec.reasoningEffort);
  let previousResponseId: string | undefined;
  let finalizing = false;
  // Outputs remain pending until a valid response advances the server-side history.
  let pendingToolResults: readonly AgentToolResult[] = [];

  return {
    nextRequest(
      toolResults: readonly AgentToolResult[],
      control?: AgentWireRequestControl,
    ): AgentWireRequest {
      if (toolResults.some((result) => result.name === "results.write" && result.ok !== false)) finalizing = true;
      if (toolResults.length > 0) pendingToolResults = toolResults;
      const missingDiscoveryCandidates = pendingToolResults.some((result) =>
        result.name === "results.write" &&
        result.ok === false &&
        result.validationIssue === "stage-candidates-invalid" &&
        result.candidateIssue?.reason === "array-or-limit" &&
        result.candidateIssue.field === "candidates" &&
        result.candidateIssue.actualType === "missing",
      );
      const input = pendingToolResults.length === 0
        ? [...(previousResponseId === undefined ? [{ role: "system", content: spec.instructions }] : []), {
          role: "user",
          content: control?.artifactRepairReminder === true
            ? AGENT_ARTIFACT_REPAIR_REMINDER
            : "Continue the assigned task using the supplied instructions and tool results.",
        }]
        : [...pendingToolResults.map((result) => ({
          type: "function_call_output",
          call_id: result.callId,
          output: result.content,
        })), ...(missingDiscoveryCandidates
          ? [{ role: "user", content: AGENT_PORTABLE_MISSING_CANDIDATES_REPAIR_REMINDER }]
          : []), ...(toolResults.length === 0 && control?.artifactRepairReminder === true
          ? [{ role: "user", content: AGENT_ARTIFACT_REPAIR_REMINDER }] : [])];
      if (!finalizing && control?.finalizationRequired === true &&
          spec.resultArtifactContract === PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT) {
        input.push({ role: "user", content: AGENT_PORTABLE_FINALIZATION_REMINDER });
      }
      return {
        operation: "responses",
        body: {
          model: spec.model.id,
          ...(spec.maxCompletionTokens === undefined ? {} : { max_output_tokens: spec.maxCompletionTokens }),
          // Keep the full task/source once as a persistent system input item.
          // The top-level instructions field is not carried by Responses
          // continuations; duplicating it into user input doubled every page.
          input,
          ...(finalizing
            ? {}
            : {
              tools: openAiResponsesTools(
                spec.resultArtifactContract,
                control?.finalizationRequired === true,
                spec.resultArtifactValidationContext,
                spec.graphIndex !== undefined,
              ),
              ...(control?.finalizationRequired === true ? { tool_choice: "required" } : {}),
            }),
          ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
          ...(spec.reasoningEffort === undefined ? {} : { reasoning: { effort: spec.reasoningEffort } }),
        },
      };
    },
    readUsage(response: unknown) {
      return responseUsage(optionalRecord(response)?.usage);
    },
    readResponse(response: unknown): NormalizedModelReply {
      const root = record(response);
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
      if (typeof root.id === "string" && root.id.length > 0) previousResponseId = root.id;
      pendingToolResults = [];
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
  context?: PortableResultArtifactValidationContext,
  graphAvailable = false,
): readonly unknown[] {
  const strictPortableStage = resultArtifactContract === PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT &&
    context?.expectedArtifactPath !== undefined;
  const contentSchema = resultArtifactContentSchema(resultArtifactContract, context);
  const tools = [
    responseTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.list"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.list"], {
      path: stringSchema(), maxEntries: integerSchema(), maxDepth: integerSchema(),
    }),
    responseTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.read"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.read"], {
      path: requiredStringSchema(), startLine: integerSchema(), endLine: integerSchema(), maxBytes: integerSchema(),
    }, ["path"]),
    responseTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.search"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.search"], {
      query: requiredStringSchema(), path: stringSchema(), maxResults: integerSchema(), maxBytes: integerSchema(),
    }, ["query"]),
    responseTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("results.write"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["results.write"], {
      path: resultArtifactPathSchema(resultArtifactContract, context),
      content: strictPortableStage ? requireAllSchemaProperties(contentSchema) : contentSchema,
    }, ["path", "content"], strictPortableStage || resultArtifactContract !== PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT),
    ...(graphAvailable ? [responseTool(WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.graph"), WORKSPACE_TOOL_WIRE_DESCRIPTIONS["workspace.graph"], {
      query: { type: "string", minLength: 1, maxLength: 200 }, maxResults: { type: "integer", minimum: 1, maximum: 20 },
    }, ["query"])] : []),
  ];
  return resultsWriteOnly ? [tools[3]!] : tools;
}

/**
 * Responses strict function schemas require every declared property, including
 * nested ones. A concrete stage can supply its optional explanatory fields;
 * the legacy multi-stage union must remain optional to avoid mixing stages.
 * This narrows generation only: source/coverage/evidence validation is unchanged.
 */
function requireAllSchemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    if (result.type === "object" && result.properties !== null && typeof result.properties === "object") {
      result.required = Object.keys(result.properties);
    }
    return result;
  };
  return visit(schema) as Record<string, unknown>;
}

function responseTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[] = [],
  strict = true,
) {
  return {
    type: "function",
    name,
    description,
    strict,
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
