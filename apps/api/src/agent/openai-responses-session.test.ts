import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderModel } from "@csb/shared";

import { createOpenAiResponsesWireAdapter } from "./openai-responses-session.js";
import type { AgentWireRequest } from "./session-types.js";

test("OpenAI Responses encodes declared tool names and decodes only portable wire calls", () => {
  const adapter = createOpenAiResponsesWireAdapter({
    model: model("gpt-5"),
    instructions: "Use only the declared workspace tools.",
  });

  const request = responsesBody(adapter.nextRequest([]));
  assert.deepEqual(request.tools.map((tool) => tool.name), [
    "workspace_list",
    "workspace_read",
    "workspace_search",
    "results_write",
  ]);
  assert.match(request.tools[0]!.description, /virtual root.*\./i);
  assert.match(request.tools[1]!.description, /repository-relative/i);
  assert.match(request.tools[2]!.description, /repository-relative/i);
  assert.match(request.tools[3]!.description, /result-relative/i);

  const normalized = adapter.readResponse({
    id: "response-1",
    output: [{
      type: "function_call",
      call_id: "call-read-1",
      name: "workspace_read",
      arguments: '{"path":"report.txt"}',
    }],
  });
  assert.deepEqual(normalized.toolCalls, [{
    id: "call-read-1",
    name: "workspace.read",
    input: { path: "report.txt" },
  }]);

  assert.throws(() => adapter.readResponse({
    id: "response-2",
    output: [{
      type: "function_call",
      call_id: "call-dotted-1",
      name: "workspace.read",
      arguments: "{}",
    }],
  }), { code: "agent_protocol_error" });
});

test("OpenAI Responses continuation omits instructions while preserving response and tool-call state", () => {
  const adapter = createOpenAiResponsesWireAdapter({
    model: model("grok-4.5"),
    instructions: "Inspect only the supplied workspace snapshot.",
  });

  const firstRequest = responseBody(adapter.nextRequest([]));
  assert.equal(firstRequest.instructions, "Inspect only the supplied workspace snapshot.");
  assert.deepEqual(firstRequest.input, [{
    role: "user",
    content: "Inspect only the supplied workspace snapshot.",
  }]);

  adapter.readResponse({
    id: "response-turn-1",
    output: [
      {
        type: "function_call",
        call_id: "call-list-1",
        name: "workspace_list",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call-read-1",
        name: "workspace_read",
        arguments: '{"path":"package.json"}',
      },
    ],
  });

  const continuation = responseBody(adapter.nextRequest([
    { callId: "call-list-1", name: "workspace.list", content: "package.json" },
    { callId: "call-read-1", name: "workspace.read", content: "{\"name\":\"fixture\"}" },
  ]));

  assert.equal("instructions" in continuation, false);
  assert.equal(continuation.previous_response_id, "response-turn-1");
  assert.deepEqual(continuation.input, [
    {
      type: "function_call_output",
      call_id: "call-list-1",
      output: "package.json",
    },
    {
      type: "function_call_output",
      call_id: "call-read-1",
      output: "{\"name\":\"fixture\"}",
    },
  ]);
});

test("OpenAI Responses writes reasoning effort only when the exact model publishes it", () => {
  const published = createOpenAiResponsesWireAdapter({
    model: model("gpt-5", {
      reasoningEffort: { options: ["low", "high"], default: "high" },
    }),
    instructions: "Inspect the snapshot.",
    reasoningEffort: "high",
  });
  const unmanaged = createOpenAiResponsesWireAdapter({
    model: model("gpt-5"),
    instructions: "Inspect the snapshot.",
  });

  assert.deepEqual(responseBody(published.nextRequest([])).reasoning, { effort: "high" });
  assert.equal("reasoning" in responseBody(unmanaged.nextRequest([])), false);
});

test("OpenAI Responses accepts one fenced JSON completion as structured output", () => {
  const adapter = createOpenAiResponsesWireAdapter({
    model: model("grok-4.5"),
    instructions: "Return the final result as JSON.",
  });

  const normalized = adapter.readResponse({
    id: "response-final",
    output: [{
      type: "message",
      content: [{ type: "output_text", text: "```json\n{\"ok\":true}\n```" }],
    }],
  });

  assert.deepEqual(normalized.structured, { ok: true });
});

test("OpenAI Responses closes the tool surface after results.write is consumed", () => {
  const adapter = createOpenAiResponsesWireAdapter({
    model: model("grok-4.5"),
    instructions: "Write one artifact, then return JSON.",
  });
  adapter.readResponse({
    id: "response-write",
    output: [{
      type: "function_call",
      call_id: "write-1",
      name: "results_write",
      arguments: '{"path":"architecture.json","content":{"stage":"architecture"}}',
    }],
  });

  const finalRequest = adapter.nextRequest([{
    callId: "write-1",
    name: "results.write",
    content: '{"path":"architecture.json","bytes":24}',
  }]);

  const body = finalRequest.body as Record<string, unknown>;
  assert.equal("tools" in body, false);
  assert.throws(() => adapter.readResponse({
    id: "response-late-tool",
    output: [{
      type: "function_call",
      call_id: "late-list",
      name: "workspace_list",
      arguments: "{}",
    }],
  }), { code: "agent_protocol_error" });
});

test("OpenAI Responses keeps the VulnHunter result tool on the strict string contract", () => {
  const structured = createOpenAiResponsesWireAdapter({
    model: model("generic-responses-model"),
    instructions: "Submit one structured result artifact.",
    resultArtifactContract: "vulnhunter-report-v1",
  });
  const legacy = createOpenAiResponsesWireAdapter({
    model: model("generic-responses-model"),
    instructions: "Submit one text result artifact.",
  });

  const structuredTool = responsesBody(structured.nextRequest([])).tools[3]!;
  const legacyTool = responsesBody(legacy.nextRequest([])).tools[3]!;
  const structuredProperties = (structuredTool.parameters as { properties: Record<string, unknown> }).properties;
  const legacyProperties = (legacyTool.parameters as { properties: Record<string, unknown> }).properties;

  assert.equal(structuredTool.strict, true);
  assert.deepEqual(structuredProperties.content, { type: "string", minLength: 1 });
  assert.deepEqual(structuredProperties.path, { type: "string", minLength: 1 });
  assert.equal(legacyTool.strict, true);
  assert.deepEqual(legacyProperties.content, { type: "string", minLength: 1 });
  assert.equal(responsesBody(structured.nextRequest([{
    callId: "invalid-write",
    name: "results.write",
    content: JSON.stringify({ error: "tool_argument_invalid" }),
    ok: false,
  }])).tools.length, 4);
});

function responsesBody(request: AgentWireRequest): {
  tools: Array<{ name: string; description: string; strict?: boolean; parameters?: unknown }>;
} {
  assert.equal(request.operation, "responses");
  return request.body as {
    tools: Array<{ name: string; description: string; strict?: boolean; parameters?: unknown }>;
  };
}

function responseBody(request: AgentWireRequest): Record<string, unknown> {
  assert.equal(request.operation, "responses");
  return request.body as Record<string, unknown>;
}

function model(id: string, patch: Partial<ProviderModel> = {}): ProviderModel {
  return {
    connectionId: "connection-a",
    id,
    displayName: id,
    contextWindow: null,
    capabilities: {
      tools: "unknown",
      artifactOutput: "unknown",
      structuredOutput: "unknown",
      boundedExecution: "unknown",
      osIsolation: "unknown",
      streaming: "unknown",
      usage: "unknown",
      cancellation: "unknown",
    },
    pricing: null,
    discoveredAt: "2026-08-11T00:00:00.000Z",
    source: "provider-api",
    ...patch,
  };
}
