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

test("Anthropic Messages accepts one fenced JSON completion as structured output", () => {
  const adapter = createAnthropicMessagesWireAdapter({
    model: model("MiniMax-M3"),
    instructions: "Return the final result as JSON.",
  });

  const normalized = adapter.readResponse({
    content: [{ type: "text", text: "```json\n{\"ok\":true}\n```" }],
  });

  assert.deepEqual(normalized.structured, { ok: true });
});

test("Anthropic Messages writes output effort only when the exact model publishes it", () => {
  const published = createAnthropicMessagesWireAdapter({
    model: model("claude-sonnet", {
      reasoningEffort: { options: ["low", "high"], default: "high" },
    }),
    instructions: "Inspect the snapshot.",
    reasoningEffort: "high",
  });
  const unmanaged = createAnthropicMessagesWireAdapter({
    model: model("claude-sonnet"),
    instructions: "Inspect the snapshot.",
  });

  assert.deepEqual((published.nextRequest([]).body as Record<string, unknown>).output_config, { effort: "high" });
  assert.equal("output_config" in (unmanaged.nextRequest([]).body as Record<string, unknown>), false);
});

test("Anthropic Messages closes the tool surface after results.write is consumed", () => {
  const adapter = createAnthropicMessagesWireAdapter({
    model: model("MiniMax-M3"),
    instructions: "Write one artifact, then return JSON.",
  });
  adapter.readResponse({
    content: [{
      type: "tool_use",
      id: "write-1",
      name: "results_write",
      input: { path: "architecture.json", content: { stage: "architecture" } },
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
    content: [{ type: "tool_use", id: "late-list", name: "workspace_list", input: {} }],
  }), { code: "agent_protocol_error" });
});

function messagesBody(request: AgentWireRequest): {
  tools: Array<{ name: string }>;
} {
  assert.equal(request.operation, "messages");
  return request.body as { tools: Array<{ name: string }> };
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
