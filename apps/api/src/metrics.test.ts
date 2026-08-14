import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { ScanRun } from "@csb/shared";

import { deleteRun, upsertRun } from "./db.js";
import { buildMetricsSummary, filterMetricRuns, measuredTokenCounts } from "./metrics.js";

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

test("filters the metrics population without truncating historical runs", () => {
  const fixture = (id: string, startedAt: string, status: ScanRun["status"], engine: ScanRun["engine"], displayName: string): ScanRun => ({
    id,
    displayName,
    repositoryPath: `/repositories/${displayName}`,
    revision: null,
    scanDir: `/nonexistent/${id}`,
    status,
    model: engine === "mantis" ? "MiniMax-M3" : "mimo-v2.5",
    effort: null,
    mode: "standard",
    engine,
    provider: "fixture",
    authMode: null,
    scannerVersion: null,
    recipeHash: null,
    startedAt,
    completedAt: status === "running" ? null : startedAt,
    durationMs: null,
    cost: null,
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
    source: "benchmark",
    pid: null,
    execution: null,
  });
  const runs = [
    fixture("old", "2026-07-01T00:00:00.000Z", "completed", "codex-security", "alpha"),
    fixture("recent", "2026-08-10T00:00:00.000Z", "running", "mantis", "beta"),
    fixture("failed", "2026-08-09T00:00:00.000Z", "failed", "mantis", "beta"),
  ];

  assert.deepEqual(filterMetricRuns(runs, { now: new Date("2026-08-14T00:00:00.000Z") }).map((run) => run.id), ["old", "recent", "failed"]);
  assert.deepEqual(filterMetricRuns(runs, { days: 7, now: new Date("2026-08-14T00:00:00.000Z") }).map((run) => run.id), ["recent", "failed"]);
  assert.deepEqual(filterMetricRuns(runs, { status: "attention" }).map((run) => run.id), ["failed"]);
  assert.deepEqual(filterMetricRuns(runs, { engine: "mantis", repository: "beta", query: "minimax" }).map((run) => run.id), ["recent", "failed"]);
});

test("returns every visible run and every priced trend point", () => {
  const ids = Array.from({ length: 13 }, (_, index) => `metrics-history-${index}-${randomUUID()}`);
  try {
    ids.forEach((id, index) => upsertRun({
      id,
      displayName: "Historical project",
      repositoryPath: "/repository",
      revision: null,
      scanDir: `/nonexistent/${id}`,
      status: "completed",
      model: "mimo-v2.5",
      effort: null,
      mode: "standard",
      engine: "codex-security",
      provider: "xiaomi",
      authMode: null,
      scannerVersion: null,
      recipeHash: null,
      startedAt: `2098-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      completedAt: `2098-08-${String(index + 1).padStart(2, "0")}T00:01:00.000Z`,
      durationMs: 60_000,
      cost: {
        estimatedUsd: 0.01,
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        pricingSource: "official-rate-card",
      },
      severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
      source: "benchmark",
      pid: null,
      execution: null,
    }));
    const summary = buildMetricsSummary({ repository: "Historical project" });
    assert.equal(summary.recent.length, 13);
    assert.equal(summary.costTrend.length, 13);
    assert.deepEqual(new Set(summary.recent.map((run) => run.id)), new Set(ids));
  } finally {
    ids.forEach(deleteRun);
  }
});
