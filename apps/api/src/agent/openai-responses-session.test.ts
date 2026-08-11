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

function responsesBody(request: AgentWireRequest): {
  tools: Array<{ name: string }>;
} {
  assert.equal(request.operation, "responses");
  return request.body as { tools: Array<{ name: string }> };
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
