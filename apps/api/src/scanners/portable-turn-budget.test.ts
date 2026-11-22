import assert from "node:assert/strict";
import test from "node:test";
import type { FrozenScannerPricing } from "../model-pricing.js";
import { createPortableTurnBudget, reservePortableTurn } from "./portable-turn-budget.js";

const pricing: FrozenScannerPricing = {
  currency: "USD", capturedAt: "2026-08-11T12:00:00.000Z", modelId: "model-a",
  inputUsdPerMillionTokens: 1, cachedInputUsdPerMillionTokens: 0,
  cacheWriteInputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 1,
  connectionId: "connection-a", providerKind: "custom", routeKind: "custom-openai-compatible",
  protocol: "openai-chat", pricingSource: "provider-catalog", pricingBasis: "payg-equivalent",
  billingMode: "unknown", pricingRateCardId: null, rateCardUpdatedAt: null,
  maximumInputTokensInclusive: null,
};

test("reservations include the entire input window, not a byte/token heuristic or a Responses delta", () => {
  for (const body of [{ messages: [{ role: "user", content: "你".repeat(200) }] }, { previous_response_id: "history" }, {}]) {
    assert.equal(reservePortableTurn({ operation: "responses", body }, pricing, 0.05, 128_000), null);
    const bounded = reservePortableTurn({ operation: "responses", body }, pricing, 0.15, 128_000)!;
    const output = (bounded.body as Record<string, number>).max_output_tokens!;
    assert.ok(output >= 1_024);
    assert.ok((128_000 + output) / 1_000_000 <= 0.15);
  }
});

test("missing input bounds and invalid prices fail closed before dispatch", () => {
  const request = { operation: "responses" as const, body: {} };
  for (const bound of [null, 0, -1, NaN, Infinity]) assert.equal(reservePortableTurn(request, pricing, 1, bound), null);
  for (const rate of [null, -1, Infinity, NaN]) assert.equal(reservePortableTurn(request, { ...pricing, inputUsdPerMillionTokens: rate }, 1, 128_000), null);
  assert.equal(reservePortableTurn(request, { ...pricing, maximumInputTokensInclusive: 100_000 }, 1, 128_000), null);
});

test("simultaneous calls atomically reserve remaining money before any upstream awaits", async () => {
  const budget = createPortableTurnBudget();
  const cap = 0.3;
  let spent = 0;
  let dispatched = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    const hold = budget.reserve({ operation: "responses", body: { previous_response_id: "history", max_output_tokens: 40_000 } }, pricing, cap - spent, 100_000);
    if (!hold) return;
    dispatched++;
    await Promise.resolve();
    spent += (100_000 + (hold.request.body as Record<string, number>).max_output_tokens!) / 1_000_000;
    assert.ok(spent <= cap);
    hold.settle();
    hold.settle();
  }));
  assert.equal(dispatched, 2);
  assert.equal(spent, 0.28);
  assert.equal(budget.reserve({ operation: "responses", body: {} }, pricing, cap - spent, 100_000), null);
});

test("failed or unreported calls keep their worst-case debit; reported calls reclaim only their own hold", () => {
  let durable = 0;
  const budget = createPortableTurnBudget(0, value => { durable = value; });
  const request = { operation: "responses" as const, body: { max_output_tokens: 40_000 } };
  const failed = budget.reserve(request, pricing, 0.2, 100_000)!;
  assert.ok(failed);
  assert.equal(durable, 0.14);
  const restarted = createPortableTurnBudget(durable);
  assert.equal(restarted.reserve(request, pricing, 0.2, 100_000), null);
  assert.equal(budget.reserve(request, pricing, 0.2, 100_000), null);
  failed.settle();
  assert.equal(durable, 0);
  assert.ok(budget.reserve(request, pricing, 0.2 - 0.01, 100_000));
});
