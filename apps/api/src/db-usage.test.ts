import assert from "node:assert/strict";
import test from "node:test";

import { scanEstimatedUsd, type ScanRun } from "@csb/shared";

import { rowToScanRun, type BenchmarkRow } from "./db.js";

function subscriptionRow(tokens: Partial<Pick<
  BenchmarkRow,
  "input_tokens" | "cached_input_tokens" | "cache_write_tokens" | "output_tokens"
>>): BenchmarkRow {
  return {
    id: "vulnhunter-run",
    display_name: "fixture",
    repository_path: "/repo",
    revision: "abc",
    scan_dir: "/scan",
    status: "failed",
    model: "gpt-5.6-sol",
    effort: "high",
    mode: "standard",
    engine: "vulnhunter",
    provider: "openai",
    auth_mode: "chatgpt",
    scanner_version: "sentinel-static-v1",
    recipe_hash: "fixture",
    started_at: "2026-08-10T18:00:00.000Z",
    completed_at: "2026-08-10T18:01:00.000Z",
    duration_ms: 60_000,
    estimated_usd: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    severity_critical: 0,
    severity_high: 0,
    severity_medium: 0,
    severity_low: 0,
    severity_info: 0,
    severity_unknown: 0,
    severity_total: 0,
    source: "benchmark",
    pid: null,
    created_at: "2026-08-10T18:00:00.000Z",
    updated_at: "2026-08-10T18:01:00.000Z",
    ...tokens,
  };
}

test("maps historical subscription rows without reported tokens to unavailable usage", () => {
  const run = rowToScanRun(subscriptionRow({}));
  assert.equal(run.cost, null);
  assert.equal(run.usage, null);
});

test("keeps historical subscription usage and adds a matching OpenRouter estimate", () => {
  const run = rowToScanRun(subscriptionRow({ input_tokens: 120, output_tokens: 30 }));

  assert.equal(run.cost?.estimatedUsd, 0.0015);
  assert.equal(run.cost?.pricingSource, "openrouter");
  assert.equal(run.cost?.pricingBasis, "payg-equivalent");
  assert.equal(run.usage?.inputTokens, 120);
  assert.equal(run.usage?.outputTokens, 30);
});

test("restores frozen provider-catalog pricing without substituting OpenRouter rates", () => {
  const run = rowToScanRun({
    ...subscriptionRow({ input_tokens: 1_000, cached_input_tokens: 200, output_tokens: 100 }),
    engine: "codex-security",
    auth_mode: "api-key",
    cost_json: JSON.stringify({
      estimatedUsd: 0.0014,
      inputTokens: 1_000,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 50,
      outputTokens: 100,
      model: "mimo-v2.5",
      pricingSource: "provider-catalog",
      pricingSnapshot: {
        currency: "USD",
        capturedAt: "2026-08-11T08:59:00.000Z",
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 0.25,
        cacheWriteInputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: 4,
      },
    }),
  } as BenchmarkRow);

  assert.deepEqual(run.cost, {
    estimatedUsd: 0.0014,
    inputTokens: 1_000,
    cachedInputTokens: 200,
    cacheWriteInputTokens: 50,
    outputTokens: 100,
    model: "mimo-v2.5",
    pricingSource: "provider-catalog",
    pricingSnapshot: {
      currency: "USD",
      capturedAt: "2026-08-11T08:59:00.000Z",
      inputUsdPerMillionTokens: 1,
      cachedInputUsdPerMillionTokens: 0.25,
      cacheWriteInputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: 4,
    },
  });
});

test("restores official PAYG-equivalent provenance without calling it an invoiced cost", () => {
  const run = rowToScanRun({
    ...subscriptionRow({ input_tokens: 70_306, cached_input_tokens: 39_296, output_tokens: 5_411 }),
    provider: "minimax",
    auth_mode: "api-key",
    model: "MiniMax-M3",
    cost_json: JSON.stringify({
      estimatedUsd: 0.01815396,
      inputTokens: 70_306,
      cachedInputTokens: 39_296,
      cacheWriteInputTokens: 0,
      outputTokens: 5_411,
      model: "MiniMax-M3",
      pricingSource: "official-rate-card",
      pricingBasis: "payg-equivalent",
      billingMode: "subscription",
      pricingRateCardId: "minimax.m3.payg.2026-08-11",
      pricingTiming: "post-hoc",
    }),
  } as BenchmarkRow);

  assert.equal(run.cost?.pricingSource, "official-rate-card");
  assert.equal(run.cost?.pricingBasis, "payg-equivalent");
  assert.equal(run.cost?.billingMode, "subscription");
  assert.equal(run.cost?.pricingRateCardId, "minimax.m3.payg.2026-08-11");
  assert.equal(run.cost?.pricingTiming, "post-hoc");
  assert.equal(scanEstimatedUsd(run), 0.01815396);
});

test("restores a MiMo PAYG-equivalent upper bound with its audited rate card", () => {
  const run = rowToScanRun({
    ...subscriptionRow({ input_tokens: 170_680, cached_input_tokens: 121_344, output_tokens: 5_267 }),
    engine: "codex-security",
    provider: "xiaomi",
    auth_mode: null,
    model: "mimo-v2.5-pro",
    cost_json: JSON.stringify({
      estimatedUsd: 0.07882809,
      inputTokens: 170_680,
      cachedInputTokens: 121_344,
      cacheWriteInputTokens: 0,
      outputTokens: 5_267,
      model: "mimo-v2.5-pro",
      pricingSource: "official-rate-card",
      pricingBasis: "payg-equivalent",
      billingMode: "subscription",
      pricingRateCardId: "xiaomi.mimo-v2.5-pro.payg.2026-08-06",
      pricingTiming: "post-hoc",
      estimateKind: "upper-bound",
    }),
  } as BenchmarkRow);

  assert.equal(run.cost?.pricingRateCardId, "xiaomi.mimo-v2.5-pro.payg.2026-08-06");
  assert.equal(run.cost?.estimateKind, "upper-bound");
});

test("never assigns OpenRouter-like cost to a local existing-session scan", () => {
  const run = rowToScanRun({
    ...subscriptionRow({ input_tokens: 120, output_tokens: 30 }),
    engine: "mantis",
    provider: "anthropic",
    auth_mode: "existing-session",
    model: null,
  });

  assert.equal(run.cost, null);
});

test("never displays a local existing-session Mantis amount as USD", () => {
  const run: ScanRun = {
    ...rowToScanRun(subscriptionRow({})),
    engine: "mantis",
    provider: "anthropic",
    authMode: "existing-session",
    cost: {
      estimatedUsd: 12.34,
      inputTokens: 120,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 30,
    },
  };

  assert.equal(scanEstimatedUsd(run), null);
});

test("does not present reported provider usage as a real zero without trusted pricing", () => {
  const run: ScanRun = {
    ...rowToScanRun(subscriptionRow({})),
    engine: "mantis",
    provider: "custom",
    authMode: "api-key",
    cost: {
      estimatedUsd: 0,
      inputTokens: 12_000,
      cachedInputTokens: 2_000,
      cacheWriteInputTokens: 0,
      outputTokens: 800,
    },
  };

  assert.equal(scanEstimatedUsd(run), null);
});
