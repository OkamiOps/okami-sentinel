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

function responsesBody(request: AgentWireRequest): {
  tools: Array<{ name: string }>;
} {
  assert.equal(request.operation, "responses");
  return request.body as { tools: Array<{ name: string }> };
}

function responseBody(request: AgentWireRequest): Record<string, unknown> {
  assert.equal(request.operation, "responses");
  return request.body as Record<string, unknown>;
}

function model(id: string): ProviderModel {
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
  };
}
