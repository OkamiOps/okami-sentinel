import assert from "node:assert/strict";
import test from "node:test";

import type { ScanRun } from "@csb/shared";
import {
  calculateOpenRouterCost,
  estimateScanWithOpenRouterPricing,
  refreshOpenRouterPricing,
  withOpenRouterPricingEstimate,
  type OpenRouterModel,
} from "./openrouter-pricing.js";

const sol: OpenRouterModel = {
  id: "openai/gpt-5.6-sol",
  pricing: {
    prompt: "0.000005",
    completion: "0.00003",
    input_cache_read: "0.0000005",
    input_cache_write: "0.00000625",
  },
};

test("calculates uncached input, cache reads, cache writes, and output separately", () => {
  const cost = calculateOpenRouterCost(
    {
      inputTokens: 18_033_340,
      cachedInputTokens: 17_135_104,
      cacheWriteInputTokens: 10_000,
      outputTokens: 169_376,
    },
    sol.pricing,
  );

  assert.equal(cost?.uncachedInputTokens, 888_236);
  assert.equal(cost?.uncachedInputUsd, 4.44118);
  assert.equal(cost?.cachedInputUsd, 8.567552);
  assert.equal(cost?.cacheWriteInputUsd, 0.0625);
  assert.equal(cost?.outputUsd, 5.08128);
  assert.equal(cost?.inputUsd, 13.071232);
  assert.equal(cost?.totalUsd, 18.152512);
});

test("rejects OpenRouter cache buckets that exceed reported total input", () => {
  assert.equal(calculateOpenRouterCost({
    inputTokens: 100,
    cachedInputTokens: 70,
    cacheWriteInputTokens: 40,
    outputTokens: 10,
  }, sol.pricing), null);
});

test("annotates ChatGPT Mantis usage as an OpenRouter estimate for the exact model", () => {
  const run: ScanRun = {
    id: "mantis-run",
    displayName: "fixture",
    repositoryPath: "/repo",
    revision: "abc",
    scanDir: "/scan",
    status: "completed",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    mode: "standard",
    engine: "mantis",
    provider: "openai",
    authMode: "chatgpt",
    scannerVersion: null,
    recipeHash: null,
    startedAt: "2026-08-10T15:00:00.000Z",
    completedAt: "2026-08-10T16:00:00.000Z",
    durationMs: 3_600_000,
    cost: {
      estimatedUsd: 0,
      inputTokens: 18_033_340,
      cachedInputTokens: 17_135_104,
      cacheWriteInputTokens: 0,
      outputTokens: 169_376,
      model: "gpt-5.6-sol",
    },
    severity: { critical: 4, high: 16, medium: 7, low: 0, info: 0, unknown: 0, total: 27 },
    source: "benchmark",
    pid: null,
    execution: null,
  };

  const estimated = estimateScanWithOpenRouterPricing(
    run,
    [sol],
    "2026-08-10T18:00:00.000Z",
  );

  assert.equal(estimated.cost?.estimatedUsd, 18.140012);
  assert.equal(estimated.cost?.pricingSource, "openrouter");
  assert.equal(estimated.cost?.pricingModel, "openai/gpt-5.6-sol");
  assert.equal(estimated.cost?.pricingUpdatedAt, "2026-08-10T18:00:00.000Z");
  assert.equal(estimated.cost?.inputUsd, 13.058732);
  assert.equal(estimated.cost?.cachedInputUsd, 8.567552);
  assert.equal(estimated.cost?.outputUsd, 5.08128);
});

test("annotates ChatGPT VulnHunter usage with the same explicit OpenRouter estimate", () => {
  const run = {
    engine: "vulnhunter",
    provider: "openai",
    authMode: "chatgpt",
    model: "gpt-5.6-sol",
    cost: {
      estimatedUsd: 0,
      inputTokens: 1_000_000,
      cachedInputTokens: 250_000,
      cacheWriteInputTokens: 0,
      outputTokens: 100_000,
    },
  } as ScanRun;

  const estimated = estimateScanWithOpenRouterPricing(
    run,
    [sol],
    "2026-08-10T18:00:00.000Z",
  );

  assert.notStrictEqual(estimated, run);
  assert.equal(estimated.cost?.estimatedUsd, 6.875);
  assert.equal(estimated.cost?.pricingSource, "openrouter");
  assert.equal(estimated.cost?.pricingModel, "openai/gpt-5.6-sol");
});

test("does not invent a price when OpenRouter has no exact model", () => {
  const run = {
    engine: "mantis",
    provider: "openai",
    authMode: "chatgpt",
    model: "private-model",
    cost: {
      estimatedUsd: 0,
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
    },
  } as ScanRun;

  assert.strictEqual(
    estimateScanWithOpenRouterPricing(run, [sol], "2026-08-10T18:00:00.000Z"),
    run,
  );
});

test("does not label unreported zero usage as a zero-dollar OpenRouter estimate", () => {
  const run = {
    engine: "vulnhunter",
    provider: "openai",
    authMode: "chatgpt",
    model: "gpt-5.6-sol",
    cost: {
      estimatedUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
    },
  } as ScanRun;

  assert.strictEqual(
    estimateScanWithOpenRouterPricing(run, [sol], "2026-08-10T18:00:00.000Z"),
    run,
  );
});

test("refreshes the public catalog used by response-side estimates", async () => {
  const refreshed = await refreshOpenRouterPricing(
    async () => new Response(JSON.stringify({
      data: [{
        id: "openai/gpt-5.6-sol",
        pricing: {
          prompt: "0.000004",
          completion: "0.00002",
          input_cache_read: "0.0000004",
        },
      }],
    })),
    Date.parse("2026-08-10T18:30:00.000Z"),
  );
  const run = {
    engine: "mantis",
    provider: "openai",
    authMode: "chatgpt",
    model: "gpt-5.6-sol",
    cost: {
      estimatedUsd: 0,
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      cacheWriteInputTokens: 0,
      outputTokens: 100_000,
    },
  } as ScanRun;

  const estimated = withOpenRouterPricingEstimate(run);

  assert.equal(refreshed, true);
  assert.equal(estimated.cost?.estimatedUsd, 4.2);
  assert.equal(estimated.cost?.pricingUpdatedAt, "2026-08-10T18:30:00.000Z");
});
