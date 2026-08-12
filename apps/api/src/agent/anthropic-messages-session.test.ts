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
  assert.match(request.tools[0]!.description, /virtual root.*\./i);
  assert.match(request.tools[1]!.description, /repository-relative/i);
  assert.match(request.tools[2]!.description, /repository-relative/i);
  assert.match(request.tools[3]!.description, /result-relative/i);

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

test("Anthropic Messages accepts one fenced JSON completion surrounded by provider prose", () => {
  const adapter = createAnthropicMessagesWireAdapter({
    model: model("MiniMax-M3"),
    instructions: "Return the final result as JSON.",
  });

  const normalized = adapter.readResponse({
    content: [{
      type: "text",
      text: "Artifact written. Structured completion follows.\n```json\n{\"ok\":true}\n```",
    }],
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

test("Anthropic Messages gives long-horizon published efforts enough response budget", () => {
  const xhigh = createAnthropicMessagesWireAdapter({
    model: model("long-horizon-model", {
      reasoningEffort: { options: ["low", "high", "xhigh", "max"], default: "high" },
    }),
    instructions: "Inspect the snapshot.",
    reasoningEffort: "xhigh",
  });
  const providerManaged = createAnthropicMessagesWireAdapter({
    model: model("provider-managed-model"),
    instructions: "Inspect the snapshot.",
  });

  assert.equal((xhigh.nextRequest([]).body as Record<string, unknown>).max_tokens, 65_536);
  assert.equal((providerManaged.nextRequest([]).body as Record<string, unknown>).max_tokens, 4_096);
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

test("Anthropic Messages exposes only the required artifact tool during reserved finalization", () => {
  const adapter = createAnthropicMessagesWireAdapter({
    model: model("portable-model"),
    instructions: "Write the required artifact before completing.",
  });
  const request = (adapter.nextRequest as (
    results: readonly [],
    control: { finalizationRequired: true },
  ) => AgentWireRequest)([], { finalizationRequired: true });
  const body = request.body as Record<string, unknown>;
  const tools = body.tools as Array<{ name: string }>;

  assert.deepEqual(tools.map((tool) => tool.name), ["results_write"]);
  assert.deepEqual(body.tool_choice, { type: "any" });
});

test("Anthropic Messages keeps the VulnHunter result tool on the universal string contract", () => {
  const structured = createAnthropicMessagesWireAdapter({
    model: model("generic-messages-model"),
    instructions: "Submit one structured result artifact.",
    resultArtifactContract: "vulnhunter-report-v1",
  });
  const legacy = createAnthropicMessagesWireAdapter({
    model: model("generic-messages-model"),
    instructions: "Submit one text result artifact.",
  });

  const structuredTool = messagesBody(structured.nextRequest([])).tools[3]!;
  const legacyTool = messagesBody(legacy.nextRequest([])).tools[3]!;
  const structuredProperties = (structuredTool.input_schema as { properties: Record<string, unknown> }).properties;
  const legacyProperties = (legacyTool.input_schema as { properties: Record<string, unknown> }).properties;

  assert.deepEqual(structuredProperties.content, { type: "string", minLength: 1 });
  assert.deepEqual(structuredProperties.path, { type: "string", minLength: 1 });
  assert.deepEqual(legacyProperties.content, { type: "string", minLength: 1 });
  assert.equal(messagesBody(structured.nextRequest([{
    callId: "invalid-write",
    name: "results.write",
    content: JSON.stringify({ error: "tool_argument_invalid" }),
    ok: false,
  }])).tools.length, 4);
});

function messagesBody(request: AgentWireRequest): {
  tools: Array<{ name: string; description: string; input_schema?: unknown }>;
} {
  assert.equal(request.operation, "messages");
  return request.body as {
    tools: Array<{ name: string; description: string; input_schema?: unknown }>;
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
