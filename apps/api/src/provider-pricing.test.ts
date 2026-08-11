import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  estimateFrozenScannerUsageCost,
  readScannerPricingQuote,
  scannerPricingQuotePath,
  writeScannerPricingQuote,
} from "./model-pricing.js";
import {
  resolveHistoricalOfficialCost,
  resolveScannerPricingQuote,
} from "./provider-pricing.js";
import { discoverOpenAiModels } from "./connections/http-model-discovery.js";

const CAPTURED_AT = "2026-08-11T17:30:00.000Z";

test("freezes the official Grok 4.5 PAYG equivalent for the exact xAI OAuth tuple", () => {
  const quote = resolveScannerPricingQuote({
    connectionId: "xai-connection",
    providerKind: "xai",
    routeKind: "xai-oauth",
    protocol: "xai-oauth-responses",
    modelId: "grok-4.5",
    modelPricing: null,
    capturedAt: CAPTURED_AT,
  });

  assert.equal(quote?.pricingSource, "official-rate-card");
  assert.equal(quote?.pricingBasis, "payg-equivalent");
  assert.equal(quote?.billingMode, "subscription");
  assert.equal(quote?.pricingRateCardId, "xai.grok-4.5.2026-07-03");
  assert.equal(quote?.maximumInputTokensInclusive, 200_000);

  const cost = estimateFrozenScannerUsageCost({
    reported: true,
    inputTokens: 75_312,
    inputTokensKnown: true,
    cachedInputTokens: 45_056,
    cachedInputTokensKnown: true,
    cacheWriteInputTokens: 0,
    cacheWriteInputTokensKnown: true,
    outputTokens: 5_498,
    outputTokensKnown: true,
  }, quote);

  assert.equal(cost?.estimatedUsd, 0.1070168);
  assert.equal(cost?.pricingBasis, "payg-equivalent");
  assert.equal(cost?.pricingSource, "official-rate-card");
  assert.equal(cost?.pricingTiming, "launch");
});

test("freezes MiniMax Token Plan as a PAYG equivalent rather than an invoiced scan cost", () => {
  const quote = resolveScannerPricingQuote({
    connectionId: "minimax-connection",
    providerKind: "minimax",
    routeKind: "minimax-token-plan",
    protocol: "anthropic-messages",
    modelId: "MiniMax-M3",
    modelPricing: null,
    capturedAt: CAPTURED_AT,
  });

  assert.equal(quote?.pricingSource, "official-rate-card");
  assert.equal(quote?.pricingBasis, "payg-equivalent");
  assert.equal(quote?.billingMode, "subscription");
  assert.equal(quote?.pricingRateCardId, "minimax.m3.payg.2026-08-11");
  assert.equal(quote?.maximumInputTokensInclusive, 512_000);

  const cost = estimateFrozenScannerUsageCost({
    reported: true,
    inputTokens: 70_306,
    inputTokensKnown: true,
    cachedInputTokens: 39_296,
    cachedInputTokensKnown: true,
    cacheWriteInputTokens: 0,
    cacheWriteInputTokensKnown: true,
    outputTokens: 5_411,
    outputTokensKnown: true,
  }, quote);

  assert.equal(cost?.estimatedUsd, 0.01815396);
  assert.equal(cost?.pricingBasis, "payg-equivalent");
  assert.equal(cost?.pricingTiming, "launch");
});

test("prices multiple short requests by their maximum request size, not their scan total", () => {
  const quote = resolveScannerPricingQuote({
    connectionId: "xai-connection",
    providerKind: "xai",
    routeKind: "xai-api",
    protocol: "openai-responses",
    modelId: "grok-4.5",
    modelPricing: null,
    capturedAt: CAPTURED_AT,
  });
  const common = {
    reported: true,
    inputTokens: 300_000,
    inputTokensKnown: true,
    cachedInputTokens: 0,
    cachedInputTokensKnown: true,
    cacheWriteInputTokens: 0,
    cacheWriteInputTokensKnown: true,
    outputTokens: 2,
    outputTokensKnown: true,
  } as const;
  assert.notEqual(estimateFrozenScannerUsageCost({
    ...common,
    maximumInputTokensPerRequest: 150_000,
  }, quote), null);
  assert.notEqual(estimateFrozenScannerUsageCost({
    ...common,
    maximumInputTokensPerRequest: 200_000,
  }, quote), null);
  assert.equal(estimateFrozenScannerUsageCost({
    ...common,
    maximumInputTokensPerRequest: 200_001,
  }, quote), null);
});

test("carries an explicit compatible-catalog manifest into the frozen launch quote", async () => {
  const discovered = await discoverOpenAiModels({
    baseUrl: "https://custom.example/v1",
    apiKey: "secret-value",
  }, async () => new Response(JSON.stringify({
    data: [{
      id: "vendor/model-v1",
      pricing: {
        currency: "USD",
        unit: "per-million-tokens",
        pricingBasis: "payg-equivalent",
        billingMode: "subscription",
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.2,
        cacheWriteInputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: 3,
      },
    }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const model = discovered.models[0];
  assert.ok(model);
  const quote = resolveScannerPricingQuote({
    connectionId: "custom-connection",
    providerKind: "custom",
    routeKind: "custom-openai-compatible",
    protocol: "openai-chat",
    modelId: model.id,
    modelPricing: model.pricing,
    capturedAt: CAPTURED_AT,
  });
  assert.equal(quote?.pricingSource, "provider-catalog");
  assert.equal(quote?.modelId, "vendor/model-v1");
  assert.equal(quote?.pricingBasis, "payg-equivalent");
  assert.equal(quote?.billingMode, "subscription");
  assert.equal(JSON.stringify(quote).includes("secret-value"), false);
});

test("uses exact provider catalog pricing for a compatible API and refuses unknown or near-match models", () => {
  const catalogQuote = resolveScannerPricingQuote({
    connectionId: "custom-connection",
    providerKind: "custom",
    routeKind: "custom-openai-compatible",
    protocol: "openai-chat",
    modelId: "vendor/model-v1",
    modelPricing: {
      inputUsdPerMillionTokens: 1,
      cachedInputUsdPerMillionTokens: 0.2,
      cacheWriteInputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: 3,
    },
    capturedAt: CAPTURED_AT,
  });
  assert.equal(catalogQuote?.pricingSource, "provider-catalog");
  assert.equal(catalogQuote?.pricingBasis, "payg-equivalent");
  assert.equal(catalogQuote?.billingMode, "unknown");

  assert.equal(resolveScannerPricingQuote({
    connectionId: "custom-connection",
    providerKind: "custom",
    routeKind: "custom-openai-compatible",
    protocol: "openai-chat",
    modelId: "vendor/model-v1",
    modelPricing: null,
    capturedAt: CAPTURED_AT,
  }), null);
  assert.equal(resolveScannerPricingQuote({
    connectionId: "xai-connection",
    providerKind: "xai",
    routeKind: "xai-oauth",
    protocol: "xai-oauth-responses",
    modelId: "grok-4.5-preview",
    modelPricing: null,
    capturedAt: CAPTURED_AT,
  }), null);
});

test("fails closed when aggregated usage cannot prove the official per-request tier", () => {
  const quote = resolveScannerPricingQuote({
    connectionId: "xai-connection",
    providerKind: "xai",
    routeKind: "xai-api",
    protocol: "openai-responses",
    modelId: "grok-4.5",
    modelPricing: null,
    capturedAt: CAPTURED_AT,
  });
  assert.equal(estimateFrozenScannerUsageCost({
    reported: true,
    inputTokens: 200_001,
    inputTokensKnown: true,
    cachedInputTokens: 0,
    cachedInputTokensKnown: true,
    cacheWriteInputTokens: 0,
    cacheWriteInputTokensKnown: true,
    outputTokens: 1,
    outputTokensKnown: true,
  }, quote), null);
});

test("persists a private frozen scanner quote without endpoint or credential fields", () => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-pricing-"));
  try {
    const quote = resolveScannerPricingQuote({
      connectionId: "minimax-connection",
      providerKind: "minimax",
      routeKind: "minimax-token-plan",
      protocol: "anthropic-messages",
      modelId: "MiniMax-M3",
      modelPricing: null,
      capturedAt: CAPTURED_AT,
    });
    writeScannerPricingQuote(scanDir, quote);
    const target = scannerPricingQuotePath(scanDir);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(readScannerPricingQuote(scanDir), quote);
    const serialized = fs.readFileSync(target, "utf8");
    assert.doesNotMatch(serialized, /apiKey|authorization|headers|baseUrl|endpoint/i);
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test("labels an explicitly audited historical official estimate as post-hoc", () => {
  const cost = resolveHistoricalOfficialCost({
    connectionId: "minimax-connection",
    providerKind: "minimax",
    routeKind: "minimax-token-plan",
    protocol: "anthropic-messages",
    modelId: "MiniMax-M3",
    modelPricing: null,
    capturedAt: CAPTURED_AT,
    usage: {
      reported: true,
      inputTokensKnown: true,
      cachedInputTokensKnown: true,
      cacheWriteInputTokensKnown: true,
      outputTokensKnown: true,
      inputTokens: 70_306,
      cachedInputTokens: 39_296,
      cacheWriteInputTokens: 0,
      outputTokens: 5_411,
    },
  });
  assert.equal(cost?.estimatedUsd, 0.01815396);
  assert.equal(cost?.pricingTiming, "post-hoc");
});
