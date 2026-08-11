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

const minimaxM3: OpenRouterModel = {
  id: "minimax/minimax-m3",
  pricing: {
    prompt: "0.0000003",
    completion: "0.0000012",
    input_cache_read: "0.00000006",
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

test("estimates any engine from measured usage and the matching OpenRouter model", () => {
  const run = {
    engine: "mantis",
    provider: "minimax",
    authMode: "api-key",
    model: "MiniMax-M3",
    cost: null,
    usage: {
      inputTokens: 1_899_206,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: 24_962,
    },
    connection: {
      connectionId: "minimax-connection",
      routeKind: "minimax-token-plan",
      protocol: "anthropic-messages",
      authKind: "api-key",
      capabilityCheckId: null,
    },
  } as ScanRun;

  const estimated = estimateScanWithOpenRouterPricing(
    run,
    [minimaxM3],
    "2026-08-11T20:36:24.291Z",
  );

  assert.equal(estimated.cost?.estimatedUsd, 0.5997162);
  assert.equal(estimated.cost?.pricingSource, "openrouter");
  assert.equal(estimated.cost?.pricingBasis, "payg-equivalent");
  assert.equal(estimated.cost?.pricingModel, "minimax/minimax-m3");
  assert.equal(estimated.cost?.estimateKind, "upper-bound");
});

test("uses an exact full OpenRouter model id for a compatible custom provider", () => {
  const run = {
    engine: "vulnhunter",
    provider: "custom",
    authMode: "api-key",
    model: "vendor/model-v1",
    cost: null,
    usage: {
      inputTokens: 10_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 2_000,
    },
    connection: {
      connectionId: "custom-connection",
      routeKind: "custom-openai-compatible",
      protocol: "openai-chat",
      authKind: "api-key",
      capabilityCheckId: null,
    },
  } as ScanRun;
  const model: OpenRouterModel = {
    id: "vendor/model-v1",
    pricing: { prompt: "0.000001", completion: "0.000002" },
  };

  const estimated = estimateScanWithOpenRouterPricing(run, [model], "2026-08-11");
  assert.equal(estimated.cost?.estimatedUsd, 0.014);
  assert.equal(estimated.cost?.pricingModel, "vendor/model-v1");
  assert.equal(estimated.cost?.pricingMatch, "exact");
});

test("prices reported Codex Security usage with the approved Spark alias and freezes its rates", () => {
  const run = {
    engine: "codex-security",
    provider: "openai",
    authMode: "api-key",
    model: "gpt-5.3-codex-spark",
    cost: {
      estimatedUsd: 0,
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      cacheWriteInputTokens: 100_000,
      outputTokens: 1_000_000,
    },
  } as ScanRun;

  const estimated = withOpenRouterPricingEstimate(run);

  assert.equal(estimated.cost?.estimatedUsd, 14.9625);
  assert.equal(estimated.cost?.pricingSource, "openrouter");
  assert.equal(estimated.cost?.pricingModel, "openai/gpt-5.3-codex");
  assert.equal(estimated.cost?.pricingMatch, "approved-alias");
  assert.equal(estimated.cost?.pricingAliasId, "openai.spark-to-gpt-5.3-codex.v1");
  assert.deepEqual(estimated.cost?.pricingSnapshot, {
    currency: "USD",
    capturedAt: "2026-08-11T16:49:02.000Z",
    inputUsdPerMillionTokens: 1.75,
    cachedInputUsdPerMillionTokens: 0.175,
    cacheWriteInputUsdPerMillionTokens: 1.75,
    outputUsdPerMillionTokens: 14,
  });
});

test("prefers an exact model over an approved alias", () => {
  const spark: OpenRouterModel = {
    id: "openai/gpt-5.3-codex-spark",
    pricing: { prompt: "0.000001", completion: "0.000002" },
  };
  const codex: OpenRouterModel = {
    id: "openai/gpt-5.3-codex",
    pricing: { prompt: "0.00000175", completion: "0.000014" },
  };
  const run = {
    engine: "codex-security",
    provider: "openai",
    authMode: "api-key",
    model: "gpt-5.3-codex-spark",
    cost: {
      estimatedUsd: 0,
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000_000,
    },
  } as ScanRun;

  const estimated = estimateScanWithOpenRouterPricing(run, [spark, codex], "2026-08-11");

  assert.equal(estimated.cost?.estimatedUsd, 3);
  assert.equal(estimated.cost?.pricingModel, "openai/gpt-5.3-codex-spark");
  assert.equal(estimated.cost?.pricingMatch, "exact");
  assert.equal(estimated.cost?.pricingAliasId, undefined);
});

test("refuses absent alias targets, near matches, and cross-provider matches", () => {
  const codex: OpenRouterModel = {
    id: "openai/gpt-5.3-codex",
    pricing: { prompt: "0.00000175", completion: "0.000014" },
  };
  const base = {
    engine: "codex-security",
    provider: "openai",
    authMode: "api-key",
    model: "gpt-5.3-codex-spark",
    cost: {
      estimatedUsd: 0,
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
    },
  } as ScanRun;

  assert.strictEqual(
    estimateScanWithOpenRouterPricing(base, [], "2026-08-11"),
    base,
  );
  const nearMatch = { ...base, model: "gpt-5.3-codex-sparks" };
  assert.strictEqual(
    estimateScanWithOpenRouterPricing(nearMatch, [codex], "2026-08-11"),
    nearMatch,
  );
  const implicitVersionFallback = { ...base, model: "gpt-5.3" };
  assert.strictEqual(
    estimateScanWithOpenRouterPricing(implicitVersionFallback, [codex], "2026-08-11"),
    implicitVersionFallback,
  );
  const crossProvider = {
    ...base,
    engine: "mantis" as const,
    provider: "anthropic",
    authMode: "chatgpt" as const,
    model: "openai/gpt-5.3-codex",
  };
  assert.strictEqual(
    estimateScanWithOpenRouterPricing(crossProvider, [codex], "2026-08-11"),
    crossProvider,
  );
});

test("does not reprice an estimate that already has pricing provenance", () => {
  const run = {
    engine: "mantis",
    provider: "openai",
    authMode: "chatgpt",
    model: "gpt-5.6-sol",
    cost: {
      estimatedUsd: 2,
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000_000,
      pricingSource: "provider-catalog",
    },
  } as ScanRun;
  const snapshotRun = {
    ...run,
    cost: {
      ...run.cost,
      pricingSource: undefined,
      pricingSnapshot: {
        currency: "USD" as const,
        capturedAt: "2026-08-10T00:00:00.000Z",
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 1,
        cacheWriteInputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: 1,
      },
    },
  } as ScanRun;

  assert.strictEqual(withOpenRouterPricingEstimate(run), run);
  assert.strictEqual(withOpenRouterPricingEstimate(snapshotRun), snapshotRun);
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
  const aliasWithoutLiveTarget = {
    engine: "codex-security",
    provider: "openai",
    authMode: "api-key",
    model: "gpt-5.3-codex-spark",
    cost: {
      estimatedUsd: 0,
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000_000,
    },
  } as ScanRun;

  assert.equal(refreshed, true);
  assert.equal(estimated.cost?.estimatedUsd, 4.2);
  assert.equal(estimated.cost?.pricingUpdatedAt, "2026-08-10T18:30:00.000Z");
  assert.strictEqual(withOpenRouterPricingEstimate(aliasWithoutLiveTarget), aliasWithoutLiveTarget);
});
