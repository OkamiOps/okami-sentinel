import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderModel } from "@csb/shared";
import { createOpenAiChatWireAdapter } from "./openai-chat-session.js";
import { createOpenAiResponsesWireAdapter } from "./openai-responses-session.js";
import { createAnthropicMessagesWireAdapter } from "./anthropic-messages-session.js";
import { WORKSPACE_TOOL_WIRE_CODEC } from "./workspace-tool-wire-codec.js";

const model: ProviderModel = {
  connectionId: "test", id: "test-model", displayName: "test-model", contextWindow: null,
  capabilities: { tools: "unknown", artifactOutput: "unknown", structuredOutput: "unknown",
    boundedExecution: "unknown", osIsolation: "unknown", streaming: "unknown", usage: "unknown", cancellation: "unknown" },
  pricing: null, discoveredAt: "2026-09-09T00:00:00.000Z", source: "provider-api",
};

test("all provider wires expose bounded graph navigation only with a supplied index", () => {
  const factories = [createOpenAiChatWireAdapter, createOpenAiResponsesWireAdapter, createAnthropicMessagesWireAdapter];
  for (const factory of factories) {
    const spec = { model, instructions: "Inspect source", routeKind: "openai-api" };
    const tools = (body: unknown) => (body as { tools: Array<{ name?: string; function?: { name: string } }> }).tools;
    const name = (tool: { name?: string; function?: { name: string } }) => tool.name ?? tool.function?.name;
    assert.equal(tools(factory(spec).nextRequest([]).body).some(tool => name(tool) === "workspace_graph"), false);
    const adapter = factory({ ...spec, graphIndex: { nodes: [], edges: [] } });
    const graphTool = tools(adapter.nextRequest([]).body).find(tool => name(tool) === "workspace_graph");
    assert.ok(graphTool);
    assert.match(JSON.stringify(graphTool), /"maxLength":200/);
    assert.match(JSON.stringify(graphTool), /"maximum":20/);
    assert.deepEqual(tools(adapter.nextRequest([], { finalizationRequired: true }).body).map(name), ["results_write"]);
  }
  assert.equal(WORKSPACE_TOOL_WIRE_CODEC.toInternal("workspace_graph"), "workspace.graph");
  assert.equal(WORKSPACE_TOOL_WIRE_CODEC.toWire("workspace.graph"), "workspace_graph");
  assert.equal(WORKSPACE_TOOL_WIRE_CODEC.toInternal("workspace.graph"), null);
});
