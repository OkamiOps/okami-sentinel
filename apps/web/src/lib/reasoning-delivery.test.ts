import assert from "node:assert/strict";
import test from "node:test";
import type { ScanRun } from "@csb/shared";

import {
  connectionReasoningDelivery,
  reasoningDeliveryCopy,
  reasoningWireField,
  scanReasoningDelivery,
} from "./reasoning-delivery.js";

test("reports the exact proven reasoning wire field", () => {
  assert.equal(reasoningWireField("openrouter-api", "openai-chat"), "reasoning.effort");
  assert.equal(reasoningWireField("xai-api", "openai-responses"), "reasoning.effort");
  assert.equal(reasoningWireField("anthropic-api", "anthropic-messages"), "output_config.effort");
  assert.equal(reasoningWireField("gemini-api", "openai-chat"), "reasoning_effort");
  assert.equal(reasoningWireField("minimax-token-plan", "anthropic-messages"), null);
});

test("distinguishes a sent effort from a provider default", () => {
  const route = { routeKind: "openrouter-api", protocol: "openai-chat" as const };
  assert.deepEqual(connectionReasoningDelivery(route, "xhigh"), {
    kind: "sent", effort: "xhigh", wire: "reasoning.effort",
  });
  assert.deepEqual(connectionReasoningDelivery(route, null), {
    kind: "provider-default", effort: null, wire: null,
  });
  assert.deepEqual(reasoningDeliveryCopy(connectionReasoningDelivery(route, "xhigh")), {
    key: "reasoning.sent",
    variables: { effort: "xhigh", wire: "reasoning.effort" },
  });
});

test("reads immutable delivery from the frozen launch record", () => {
  const scan = {
    effort: "high",
    connection: {
      connectionId: "connection-a",
      routeKind: "anthropic-api",
      protocol: "anthropic-messages",
      authKind: "api-key",
      capabilityCheckId: "probe-a",
    },
    execution: null,
    launchSelection: {
      modelSelectionMode: "catalog" as const,
      modelId: "claude-opus-5",
      paths: [],
      reasoning: { kind: "sent" as const, effort: "high", wire: "output_config.effort" as const },
    },
  } satisfies Pick<ScanRun, "effort" | "connection" | "execution" | "launchSelection">;
  assert.deepEqual(scanReasoningDelivery(scan), {
    kind: "sent", effort: "high", wire: "output_config.effort",
  });
});

test("never claims a historical effort was sent without launch-time proof", () => {
  assert.deepEqual(scanReasoningDelivery({
    effort: "high",
    connection: null,
    execution: null,
    launchSelection: null,
  }), {
    kind: "legacy-unverified", effort: "high", wire: null,
  });
  assert.deepEqual(reasoningDeliveryCopy({
    kind: "legacy-unverified", effort: "high", wire: null,
  }), {
    key: "reasoning.legacyUnverified",
    variables: { effort: "high" },
  });
});
