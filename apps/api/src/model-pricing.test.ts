import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ModelPricing } from "@csb/shared";

import {
  estimateCatalogUsageCost,
  portableCodexSecurityPricingPath,
  readPortableCodexSecurityPricing,
  writePortableCodexSecurityPricing,
} from "./model-pricing.js";
import type { ScannerUsage } from "./scanners/usage.js";

const CAPTURED_AT = "2026-08-11T16:30:00.000Z";
const MODEL_ID = "mimo-v2.5";

const pricing: ModelPricing = {
  inputUsdPerMillionTokens: 2,
  cachedInputUsdPerMillionTokens: 0.5,
  cacheWriteInputUsdPerMillionTokens: null,
  outputUsdPerMillionTokens: 4,
};

const pricingWithCacheWrite: ModelPricing = {
  ...pricing,
  cacheWriteInputUsdPerMillionTokens: 6,
};

test("frozen catalog pricing charges each input bucket exactly once", () => {
  const cost = estimateCatalogUsageCost({
    reported: true,
    inputTokens: 1_000_000,
    inputTokensKnown: true,
    cachedInputTokens: 500_000,
    cachedInputTokensKnown: true,
    cacheWriteInputTokens: 200_000,
    cacheWriteInputTokensKnown: true,
    outputTokens: 1_000_000,
    outputTokensKnown: true,
  } satisfies ScannerUsage, pricingWithCacheWrite, CAPTURED_AT, MODEL_ID);

  assert.equal(cost?.inputUsd, 0.6);
  assert.equal(cost?.cachedInputUsd, 0.25);
  assert.equal(cost?.cacheWriteInputUsd, 1.2);
  assert.equal(cost?.outputUsd, 4);
  assert.equal(cost?.estimatedUsd, 6.05);
  assert.deepEqual(cost?.pricingSnapshot, {
    currency: "USD",
    capturedAt: CAPTURED_AT,
    inputUsdPerMillionTokens: 2,
    cachedInputUsdPerMillionTokens: 0.5,
    cacheWriteInputUsdPerMillionTokens: 6,
    outputUsdPerMillionTokens: 4,
  });
});

test("frozen catalog pricing refuses a positive cache-write count without a published rate", () => {
  const cost = estimateCatalogUsageCost({
    reported: true,
    inputTokens: 1_000_000,
    inputTokensKnown: true,
    cachedInputTokens: 500_000,
    cachedInputTokensKnown: true,
    cacheWriteInputTokens: 2_000_000,
    cacheWriteInputTokensKnown: true,
    outputTokens: 2_000_000,
    outputTokensKnown: true,
  } satisfies ScannerUsage, pricing, CAPTURED_AT, MODEL_ID);

  assert.equal(cost, null);
});

test("frozen catalog pricing calculates only fully known zero cache-write usage", () => {
  const cost = estimateCatalogUsageCost({
    reported: true,
    inputTokens: 1_000_000,
    inputTokensKnown: true,
    cachedInputTokens: 500_000,
    cachedInputTokensKnown: true,
    cacheWriteInputTokens: 0,
    cacheWriteInputTokensKnown: true,
    outputTokens: 2_000_000,
    outputTokensKnown: true,
  } satisfies ScannerUsage, pricing, CAPTURED_AT, MODEL_ID);

  assert.deepEqual(cost, {
    estimatedUsd: 9.25,
    inputTokens: 1_000_000,
    cachedInputTokens: 500_000,
    cacheWriteInputTokens: 0,
    outputTokens: 2_000_000,
    model: MODEL_ID,
    pricingSource: "provider-catalog",
    pricingSnapshot: {
      currency: "USD",
      capturedAt: CAPTURED_AT,
      inputUsdPerMillionTokens: 2,
      cachedInputUsdPerMillionTokens: 0.5,
      cacheWriteInputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: 4,
    },
    pricingModel: MODEL_ID,
    pricingUpdatedAt: CAPTURED_AT,
    inputUsd: 1,
    cachedInputUsd: 0.25,
    outputUsd: 8,
  });
  assert.equal(cost?.cacheWriteInputUsd, undefined);
});

test("fully known zero usage remains a zero cost when catalog rates are unavailable", () => {
  const cost = estimateCatalogUsageCost({
    reported: true,
    inputTokens: 0,
    inputTokensKnown: true,
    cachedInputTokens: 0,
    cachedInputTokensKnown: true,
    cacheWriteInputTokens: 0,
    cacheWriteInputTokensKnown: true,
    outputTokens: 0,
    outputTokensKnown: true,
  } satisfies ScannerUsage, {
    inputUsdPerMillionTokens: null,
    cachedInputUsdPerMillionTokens: null,
    cacheWriteInputUsdPerMillionTokens: null,
    outputUsdPerMillionTokens: null,
  }, CAPTURED_AT, MODEL_ID);

  assert.equal(cost?.estimatedUsd, 0);
});

test("frozen catalog pricing rejects cache counters that exceed total input", () => {
  const cost = estimateCatalogUsageCost({
    reported: true,
    inputTokens: 100,
    inputTokensKnown: true,
    cachedInputTokens: 70,
    cachedInputTokensKnown: true,
    cacheWriteInputTokens: 40,
    cacheWriteInputTokensKnown: true,
    outputTokens: 0,
    outputTokensKnown: true,
  } satisfies ScannerUsage, pricingWithCacheWrite, CAPTURED_AT, MODEL_ID);

  assert.equal(cost, null);
});

test("missing usage or either required frozen rate keeps Portable cost unavailable", () => {
  const completeUsage: ScannerUsage = {
    reported: true,
    inputTokens: 1,
    inputTokensKnown: true,
    cachedInputTokens: 0,
    cachedInputTokensKnown: true,
    cacheWriteInputTokens: 0,
    cacheWriteInputTokensKnown: true,
    outputTokens: 1,
    outputTokensKnown: true,
  };

  assert.equal(estimateCatalogUsageCost({
    ...completeUsage,
    reported: false,
  }, pricing, CAPTURED_AT, MODEL_ID), null);
  assert.equal(estimateCatalogUsageCost({
    ...completeUsage,
    outputTokensKnown: false,
  }, pricing, CAPTURED_AT, MODEL_ID), null);
  assert.equal(estimateCatalogUsageCost(completeUsage, null, CAPTURED_AT, MODEL_ID), null);
  assert.equal(estimateCatalogUsageCost(completeUsage, {
    ...pricing,
    inputUsdPerMillionTokens: null,
  }, CAPTURED_AT, MODEL_ID), null);
  assert.equal(estimateCatalogUsageCost(completeUsage, {
    ...pricing,
    outputUsdPerMillionTokens: null,
  }, CAPTURED_AT, MODEL_ID), null);

  assert.equal(estimateCatalogUsageCost({
    ...completeUsage,
    cachedInputTokensKnown: false,
  }, pricing, CAPTURED_AT, MODEL_ID), null);
  assert.equal(estimateCatalogUsageCost({
    ...completeUsage,
    cacheWriteInputTokensKnown: false,
  }, pricing, CAPTURED_AT, MODEL_ID), null);
});

test("pricing sidecar is private and ignores files opened beyond owner access", () => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-pricing-"));
  try {
    writePortableCodexSecurityPricing(scanDir, pricingWithCacheWrite, CAPTURED_AT, MODEL_ID);
    const target = portableCodexSecurityPricingPath(scanDir);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(readPortableCodexSecurityPricing(scanDir)?.modelId, MODEL_ID);
    assert.equal(readPortableCodexSecurityPricing(scanDir)?.cacheWriteInputUsdPerMillionTokens, 6);

    fs.chmodSync(target, 0o644);
    assert.equal(readPortableCodexSecurityPricing(scanDir), null);
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test("pricing reader rejects symlinks and closes an lstat-to-open replacement", () => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-pricing-pinned-"));
  const aliasDir = path.join(scanDir, "alias");
  const replacement = path.join(scanDir, "replacement.json");
  const target = portableCodexSecurityPricingPath(scanDir);
  try {
    writePortableCodexSecurityPricing(scanDir, pricing, CAPTURED_AT, MODEL_ID);
    fs.mkdirSync(aliasDir, { mode: 0o700 });
    fs.symlinkSync(target, portableCodexSecurityPricingPath(aliasDir));
    assert.equal(readPortableCodexSecurityPricing(aliasDir), null);

    fs.writeFileSync(replacement, JSON.stringify({
      schemaVersion: 1,
      pricing: {
        currency: "USD",
        capturedAt: CAPTURED_AT,
        modelId: "replacement-model",
        inputUsdPerMillionTokens: 1,
        cachedInputUsdPerMillionTokens: 1,
        cacheWriteInputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: 1,
      },
    }), { mode: 0o600 });
    fs.chmodSync(replacement, 0o600);

    const mutableFs = fs as unknown as {
      openSync: (...args: unknown[]) => number;
    };
    const originalOpen = mutableFs.openSync;
    let swapped = false;
    mutableFs.openSync = (...args) => {
      if (!swapped && String(args[0]) === target) {
        swapped = true;
        fs.renameSync(replacement, target);
      }
      return originalOpen(...args);
    };
    try {
      assert.equal(readPortableCodexSecurityPricing(scanDir), null);
    } finally {
      mutableFs.openSync = originalOpen;
    }
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});
