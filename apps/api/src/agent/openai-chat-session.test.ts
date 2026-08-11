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
  assert.equal(firstRequest.tool_choice, "required");
  assert.equal("parallel_tool_calls" in firstRequest, false);
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

test("OpenAI chat rejects dotted internal names from a non-MiMo wire response", () => {
  const adapter = openAiChat.createOpenAiChatWireAdapter({
    model: model("gemini-2.5-pro"),
    instructions: "Use only the declared workspace tools.",
    routeKind: "gemini-api",
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

test("non-MiMo OpenAI chat uses portable wire names and never replays provider reasoning", () => {
  const adapter = openAiChat.createOpenAiChatWireAdapter({
    model: model("gemini-2.5-pro"),
    instructions: "Use only the declared workspace tools.",
    routeKind: "gemini-api",
  });

  const firstRequest = chatBody(adapter.nextRequest([]));
  assert.deepEqual(firstRequest.tools.map((tool) => tool.function.name), [
    "workspace_list",
    "workspace_read",
    "workspace_search",
    "results_write",
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
          function: { name: "workspace_list", arguments: "{}" },
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

test("OpenAI chat accepts one fenced JSON completion as structured output", () => {
  const adapter = openAiChat.createOpenAiChatWireAdapter({
    model: model("openrouter/free"),
    instructions: "Return the final result as JSON.",
    routeKind: "openrouter-api",
  });

  const normalized = adapter.readResponse({
    choices: [{ message: { content: "```json\n{\"ok\":true}\n```" } }],
  });

  assert.deepEqual(normalized.structured, { ok: true });
});

test("OpenAI chat uses the route-specific reasoning field only for a published effort", () => {
  const selected = model("account-visible", {
    reasoningEffort: { options: ["low", "high"], default: "high" },
  });
  const openRouter = openAiChat.createOpenAiChatWireAdapter({
    model: selected,
    instructions: "Inspect the snapshot.",
    routeKind: "openrouter-api",
    reasoningEffort: "high",
  });
  const mimoManaged = openAiChat.createOpenAiChatWireAdapter({
    model: selected,
    instructions: "Inspect the snapshot.",
    routeKind: "mimo-token-plan",
  });
  const unmanaged = openAiChat.createOpenAiChatWireAdapter({
    model: model("account-visible"),
    instructions: "Inspect the snapshot.",
    routeKind: "openrouter-api",
  });

  assert.deepEqual(chatBody(openRouter.nextRequest([])).reasoning, { effort: "high" });
  assert.equal("thinking" in chatBody(mimoManaged.nextRequest([])), false);
  assert.throws(() => openAiChat.createOpenAiChatWireAdapter({
    model: selected,
    instructions: "Inspect the snapshot.",
    routeKind: "mimo-token-plan",
    reasoningEffort: "high",
  }), { code: "runner_invalid_spec" });
  assert.equal("reasoning" in chatBody(unmanaged.nextRequest([])), false);
  assert.equal("reasoning_effort" in chatBody(unmanaged.nextRequest([])), false);
});

test("OpenAI chat closes tools and enables JSON mode after results.write is consumed", () => {
  const adapter = openAiChat.createOpenAiChatWireAdapter({
    model: model("cohere/north-mini-code:free"),
    instructions: "Write one artifact, then return JSON.",
    routeKind: "openrouter-api",
  });
  adapter.readResponse({
    choices: [{ message: { tool_calls: [{
      id: "write-1",
      type: "function",
      function: {
        name: "results_write",
        arguments: '{"path":"architecture.json","content":{"stage":"architecture"}}',
      },
    }] } }],
  });

  const finalRequest = adapter.nextRequest([{
    callId: "write-1",
    name: "results.write",
    content: '{"path":"architecture.json","bytes":24}',
  }]);

  const body = finalRequest.body as Record<string, unknown>;
  assert.equal("tools" in body, false);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.throws(() => adapter.readResponse({
    choices: [{ message: { tool_calls: [{
      id: "late-list",
      type: "function",
      function: { name: "workspace_list", arguments: "{}" },
    }] } }],
  }), { code: "agent_protocol_error" });
});

test("OpenAI chat rejects a results.write batch before any parallel tool side effect", () => {
  const adapter = openAiChat.createOpenAiChatWireAdapter({
    model: model("free-tool-model"),
    instructions: "Write exactly one artifact.",
    routeKind: "openrouter-api",
  });

  assert.throws(() => adapter.readResponse({
    choices: [{ message: { tool_calls: [
      {
        id: "read-1",
        type: "function",
        function: { name: "workspace_read", arguments: '{"path":"README.md"}' },
      },
      {
        id: "write-1",
        type: "function",
        function: {
          name: "results_write",
          arguments: '{"path":"architecture.json","content":{"stage":"architecture"}}',
        },
      },
    ] } }],
  }), { code: "agent_protocol_error" });
});

function chatBody(request: AgentWireRequest): {
  tools: Array<{ function: { name: string } }>;
  messages: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  reasoning?: unknown;
  reasoning_effort?: unknown;
  thinking?: unknown;
} {
  assert.equal(request.operation, "chat-completions");
  return request.body as {
    tools: Array<{ function: { name: string } }>;
    messages: unknown[];
    tool_choice?: unknown;
    parallel_tool_calls?: unknown;
    reasoning?: unknown;
    reasoning_effort?: unknown;
    thinking?: unknown;
  };
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
