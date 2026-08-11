import assert from "node:assert/strict";
import test from "node:test";

import { scanCostPresentation, scanTokenUsage } from "./scan-cost.js";
import { formatScanUsd } from "../format.js";

test("presents Token Plan pricing as a PAYG equivalent rather than a scan charge", () => {
  assert.deepEqual(scanCostPresentation({
    estimatedUsd: 0.01815396,
    inputTokens: 70_306,
    cachedInputTokens: 39_296,
    cacheWriteInputTokens: 0,
    outputTokens: 5_411,
    pricingSource: "official-rate-card",
    pricingBasis: "payg-equivalent",
    billingMode: "subscription",
  }), {
    labelKey: "scanCost.paygEquivalent",
    rateKey: "scanCost.officialRate",
    disclaimerKey: "scanCost.planDisclaimer",
  });
});

test("presents trusted catalog pricing as an estimate and leaves unpriced usage neutral", () => {
  assert.deepEqual(scanCostPresentation({
    estimatedUsd: 0.4,
    inputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1,
    pricingSource: "provider-catalog",
  }), {
    labelKey: "scanCost.estimated",
    rateKey: "scanCost.providerRate",
    disclaimerKey: null,
  });
  assert.deepEqual(scanCostPresentation({
    estimatedUsd: 0,
    inputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1,
  }), {
    labelKey: "scanCost.cost",
    rateKey: null,
    disclaimerKey: null,
  });
});

test("keeps measured tokens visible when pricing is unavailable", () => {
  assert.deepEqual(scanTokenUsage({
    cost: null,
    usage: {
      inputTokens: 1_200,
      cachedInputTokens: 200,
      cacheWriteInputTokens: null,
      outputTokens: 80,
    },
  }), {
    inputTokens: 1_200,
    cachedInputTokens: 200,
    cacheWriteInputTokens: null,
    outputTokens: 80,
  });
});

test("does not promote a partial cost bucket over an explicitly unknown usage bucket", () => {
  assert.deepEqual(scanTokenUsage({
    cost: {
      estimatedUsd: 0.08,
      inputTokens: 170_680,
      cachedInputTokens: 121_344,
      cacheWriteInputTokens: 0,
      outputTokens: 5_267,
      estimateKind: "upper-bound",
    },
    usage: {
      inputTokens: 170_680,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: 5_267,
    },
  }), {
    inputTokens: 170_680,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: 5_267,
  });
});

test("renders a partial-usage cost as an upper bound", () => {
  const formatted = formatScanUsd({
    engine: "codex-security",
    authMode: null,
    cost: {
      estimatedUsd: 0.07882809,
      inputTokens: 170_680,
      cachedInputTokens: 121_344,
      cacheWriteInputTokens: 0,
      outputTokens: 5_267,
      estimateKind: "upper-bound",
      pricingSource: "official-rate-card",
      pricingBasis: "payg-equivalent",
      billingMode: "subscription",
    },
  });
  assert.match(formatted, /^≤ /);
  assert.match(formatted, /0[,.]08$/);
});
