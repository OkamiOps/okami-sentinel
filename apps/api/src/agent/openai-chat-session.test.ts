import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderModel } from "@csb/shared";
import * as openAiChat from "./openai-chat-session.js";
import type { AgentWireRequest } from "./session-types.js";

test("MiMo replays an opaque reasoning field and wire-safe tool call from its first response", () => {
  const adapter = openAiChat.createOpenAiChatWireAdapter({
    model: model("mimo-v2.5-pro"),
    instructions: "Use only the declared workspace tools.",
    routeKind: "mimo-token-plan",
  });

  const firstRequest = chatBody(adapter.nextRequest([]));
  assert.deepEqual(firstRequest.tools.map((tool) => tool.function.name), [
    "workspace_list",
    "workspace_read",
    "workspace_search",
    "results_write",
  ]);

  const reasoning = "opaque provider reasoning: do not render or execute this";
  const firstResponse = {
    choices: [{
      message: {
        content: null,
        reasoning_content: reasoning,
        tool_calls: [{
          id: "call-read-1",
          type: "function",
          function: { name: "workspace_read", arguments: '{"path":"report.txt"}' },
        }],
      },
    }],
  };

  const normalized = adapter.readResponse(firstResponse);
  assert.deepEqual(normalized.toolCalls, [{
    id: "call-read-1",
    name: "workspace.read",
    input: { path: "report.txt" },
  }]);
  assert.equal(JSON.stringify(normalized).includes(reasoning), false);

  const secondRequest = chatBody(adapter.nextRequest([{
    callId: "call-read-1",
    name: "workspace.read",
    content: "quarterly report",
  }]));
  assert.deepEqual(secondRequest.messages, [
    { role: "system", content: "Use only the declared workspace tools." },
    {
      role: "assistant",
      content: null,
      reasoning_content: reasoning,
      tool_calls: firstResponse.choices[0].message.tool_calls,
    },
    { role: "tool", tool_call_id: "call-read-1", content: "quarterly report" },
  ]);
});

test("OpenAI chat rejects unknown wire names instead of treating internal names as wire protocol", () => {
  const adapter = openAiChat.createOpenAiChatWireAdapter({
    model: model("mimo-v2.5-pro"),
    instructions: "Use only the declared workspace tools.",
    routeKind: "mimo-token-plan",
  });

  assert.throws(() => adapter.readResponse({
    choices: [{
      message: {
        tool_calls: [{
          id: "call-unknown-1",
          type: "function",
          function: { name: "workspace.read", arguments: "{}" },
        }],
      },
    }],
  }), { code: "agent_protocol_error" });
});

test("non-MiMo OpenAI chat keeps dotted names and never replays provider reasoning", () => {
  const adapter = openAiChat.createOpenAiChatWireAdapter({
    model: model("gemini-2.5-pro"),
    instructions: "Use only the declared workspace tools.",
    routeKind: "gemini-api",
  });

  const firstRequest = chatBody(adapter.nextRequest([]));
  assert.deepEqual(firstRequest.tools.map((tool) => tool.function.name), [
    "workspace.list",
    "workspace.read",
    "workspace.search",
    "results.write",
  ]);

  const reasoning = "untrusted provider text that must remain inert";
  const firstResponse = {
    choices: [{
      message: {
        content: null,
        reasoning_content: reasoning,
        tool_calls: [{
          id: "call-list-1",
          type: "function",
          function: { name: "workspace.list", arguments: "{}" },
        }],
      },
    }],
  };
  const normalized = adapter.readResponse(firstResponse);
  assert.deepEqual(normalized.toolCalls, [{ id: "call-list-1", name: "workspace.list", input: {} }]);

  const secondRequest = chatBody(adapter.nextRequest([{
    callId: "call-list-1",
    name: "workspace.list",
    content: "[]",
  }]));
  assert.deepEqual(secondRequest.messages, [
    { role: "system", content: "Use only the declared workspace tools." },
    { role: "assistant", content: null, tool_calls: firstResponse.choices[0].message.tool_calls },
    { role: "tool", tool_call_id: "call-list-1", content: "[]" },
  ]);
  assert.equal(JSON.stringify(secondRequest).includes(reasoning), false);
});

function chatBody(request: AgentWireRequest): {
  tools: Array<{ function: { name: string } }>;
  messages: unknown[];
} {
  assert.equal(request.operation, "chat-completions");
  return request.body as {
    tools: Array<{ function: { name: string } }>;
    messages: unknown[];
  };
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
