import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderModel } from "@csb/shared";

import { createAnthropicMessagesWireAdapter } from "./anthropic-messages-session.js";
import { createOpenAiChatWireAdapter } from "./openai-chat-session.js";
import { createOpenAiResponsesWireAdapter } from "./openai-responses-session.js";

test("OpenAI chat preserves documented cache-read and cache-write usage", () => {
  const adapter = createOpenAiChatWireAdapter({
    model: model("openrouter/account-visible"),
    instructions: "Inspect only the snapshot.",
    routeKind: "openrouter-api",
  });

  const response = adapter.readResponse({
    choices: [{ message: { content: "done" } }],
    usage: {
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: 20 },
      completion_tokens: 10,
    },
  });

  assert.deepEqual(response.usage, {
    inputTokens: 100,
    cachedInputTokens: 70,
    cacheWriteInputTokens: 20,
    outputTokens: 10,
    reasoningTokens: null,
  });
});

test("OpenAI Responses preserves documented cache-read and cache-write usage", () => {
  const adapter = createOpenAiResponsesWireAdapter({
    model: model("account-visible"),
    instructions: "Inspect only the snapshot.",
  });

  const response = adapter.readResponse({
    id: "response-1",
    output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 70, cache_write_tokens: 20 },
      output_tokens: 10,
    },
  });

  assert.deepEqual(response.usage, {
    inputTokens: 100,
    cachedInputTokens: 70,
    cacheWriteInputTokens: 20,
    outputTokens: 10,
    reasoningTokens: null,
  });
});

test("Anthropic normalizes total input from uncached, cache-read, and cache-write counters", () => {
  const adapter = createAnthropicMessagesWireAdapter({
    model: model("claude-account-visible"),
    instructions: "Inspect only the snapshot.",
  });

  const response = adapter.readResponse({
    content: [{ type: "text", text: "done" }],
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 70,
      cache_creation_input_tokens: 20,
      output_tokens: 5,
    },
  });

  assert.deepEqual(response.usage, {
    inputTokens: 100,
    cachedInputTokens: 70,
    cacheWriteInputTokens: 20,
    outputTokens: 5,
    reasoningTokens: null,
  });
});

test("Anthropic preserves raw input while optional cache counters remain unknown", () => {
  const adapter = createAnthropicMessagesWireAdapter({
    model: model("claude-account-visible"),
    instructions: "Inspect only the snapshot.",
  });

  const response = adapter.readResponse({
    content: [{ type: "text", text: "done" }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
    },
  });

  assert.deepEqual(response.usage, {
    inputTokens: 10,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: 5,
    reasoningTokens: null,
  });
});

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
