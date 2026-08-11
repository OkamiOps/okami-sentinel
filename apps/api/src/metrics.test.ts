import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { ScanRun } from "@csb/shared";

import { deleteRun, upsertRun } from "./db.js";
import { buildMetricsSummary, measuredTokenCounts } from "./metrics.js";

test("counts measured tokens even when pricing is unavailable", () => {
  assert.deepEqual(measuredTokenCounts({
    cost: null,
    usage: {
      inputTokens: 1_250,
      cachedInputTokens: 250,
      cacheWriteInputTokens: null,
      outputTokens: 75,
    },
  }), { inputTokens: 1_250, outputTokens: 75 });
});

test("marks aggregate and trend costs when any priced run is an upper bound", () => {
  const id = `metrics-upper-bound-${randomUUID()}`;
  const run: ScanRun = {
    id,
    displayName: "Upper-bound fixture",
    repositoryPath: "/repository",
    revision: null,
    scanDir: `/nonexistent/${id}`,
    status: "failed",
    model: "mimo-v2.5-pro",
    effort: null,
    mode: "standard",
    engine: "codex-security",
    provider: "xiaomi",
    authMode: null,
    scannerVersion: null,
    recipeHash: null,
    startedAt: "2099-08-11T22:00:00.000Z",
    completedAt: "2099-08-11T22:01:00.000Z",
    durationMs: 60_000,
    cost: {
      estimatedUsd: 0.08,
      inputTokens: 170_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 5_000,
      pricingSource: "official-rate-card",
      pricingBasis: "payg-equivalent",
      billingMode: "subscription",
      estimateKind: "upper-bound",
    },
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
    source: "benchmark",
    pid: null,
    execution: null,
  };
  try {
    upsertRun(run);
    const summary = buildMetricsSummary();
    assert.equal(summary.hasUpperBoundCost, true);
    assert.equal(summary.costTrend.find((point) => point.scanId === id)?.estimateKind, "upper-bound");
  } finally {
    deleteRun(id);
  }
});
