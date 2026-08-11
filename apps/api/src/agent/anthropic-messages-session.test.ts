import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderModel } from "@csb/shared";

import { createAnthropicMessagesWireAdapter } from "./anthropic-messages-session.js";
import type { AgentWireRequest } from "./session-types.js";

test("Anthropic Messages encodes declared tool names and decodes only portable wire calls", () => {
  const adapter = createAnthropicMessagesWireAdapter({
    model: model("claude-sonnet"),
    instructions: "Use only the declared workspace tools.",
  });

  const request = messagesBody(adapter.nextRequest([]));
  assert.deepEqual(request.tools.map((tool) => tool.name), [
    "workspace_list",
    "workspace_read",
    "workspace_search",
    "results_write",
  ]);

  const normalized = adapter.readResponse({
    content: [{
      type: "tool_use",
      id: "tool-read-1",
      name: "workspace_read",
      input: { path: "report.txt" },
    }],
  });
  assert.deepEqual(normalized.toolCalls, [{
    id: "tool-read-1",
    name: "workspace.read",
    input: { path: "report.txt" },
  }]);

  assert.throws(() => adapter.readResponse({
    content: [{
      type: "tool_use",
      id: "tool-dotted-1",
      name: "workspace.read",
      input: {},
    }],
  }), { code: "agent_protocol_error" });
});

function messagesBody(request: AgentWireRequest): {
  tools: Array<{ name: string }>;
} {
  assert.equal(request.operation, "messages");
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
