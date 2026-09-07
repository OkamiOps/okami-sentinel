import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import type { ScanRun } from "@csb/shared";

// Large-history and startup fixtures must not share a database with other test workers.
const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-metrics-suite-"));
process.env.CSB_DATA_DIR = path.join(isolatedRoot, "data");
process.env.CODEX_SECURITY_STATE_DIR = path.join(isolatedRoot, "state");
process.env.CSB_NPM_CACHE_DIR = path.join(isolatedRoot, "cache");
after(async () => {
  const { getDb } = await import("./db.js");
  getDb().close();
  fs.rmSync(isolatedRoot, { recursive: true, force: true });
});

const { backfillRunMetricProjections,
  deleteRun,
  getDb,
  getRun,
  hideRun,
  upsertRun } = await import("./db.js");
const { backfillFindingCategoryMetrics, indexFindingCategoryMetrics } = await import("./ingest.js");
const { buildMetricsSummary,
  filterMetricRuns,
  measuredTokenCounts,
  METRICS_COST_TREND_LIMIT,
  METRICS_RECENT_LIMIT } = await import("./metrics.js");

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

test("keeps Date.parse day boundaries for offsets, milliseconds, and invalid timestamps", () => {
  const ids = ["before", "offset", "after", "invalid"].map((suffix) => `metrics-day-${suffix}-${randomUUID()}`);
  try {
    const [before, offset, after, invalid] = ids;
    [
      metricRun(before, { displayName: "Metric day fixture", startedAt: "2026-09-07T10:00:00Z" }),
      metricRun(offset, { displayName: "Metric day fixture", startedAt: "2026-09-07T12:00:00+02:00" }),
      metricRun(after, { displayName: "Metric day fixture", startedAt: "2026-09-07T12:00:01+02:00" }),
      metricRun(invalid, { displayName: "Metric day fixture", startedAt: "not-a-date" }),
    ].forEach(upsertRun);
    const filters = {
      repository: "Metric day fixture",
      days: 7 as const,
      now: new Date("2026-09-14T10:00:00.500Z"),
    };
    const expected = filterMetricRuns(
      [before, offset, after, invalid].map((id) => getRun(id)!),
      filters,
    ).map((run) => run.id);
    const summary = buildMetricsSummary(filters);
    assert.deepEqual(expected, [after]);
    assert.equal(summary.totalScans, expected.length);
    assert.deepEqual(summary.recent.map((run) => run.id), expected);
  } finally {
    ids.forEach(deleteRun);
  }
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

function metricRun(
  id: string,
  options: Partial<ScanRun> = {},
): ScanRun {
  return {
    id,
    displayName: "Metric category fixture",
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
    startedAt: "2097-01-01T00:00:00.000Z",
    completedAt: "2097-01-01T00:01:00.000Z",
    durationMs: 60_000,
    cost: {
      estimatedUsd: 0.01,
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
      pricingSource: "official-rate-card",
    },
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
    source: "benchmark",
    pid: null,
    execution: null,
    ...options,
  };
}

test("uses the persisted category cache across filters and records empty artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-metric-categories-"));
  const ids = ["first", "second", "hidden", "missing"].map((suffix) => `metrics-category-${suffix}-${randomUUID()}`);
  const [first, second, hidden, missing] = ids;
  try {
    const firstDir = path.join(root, "first");
    const secondDir = path.join(root, "second");
    fs.mkdirSync(firstDir, { recursive: true });
    fs.mkdirSync(secondDir, { recursive: true });
    fs.writeFileSync(path.join(firstDir, "findings.json"), JSON.stringify({ findings: [
      { severity: "high", taxonomy: { category: "Injection" } },
      { severity: "low", taxonomy: { category: "Injection" } },
      { severity: "critical", taxonomy: { category: "Auth" } },
    ] }));
    fs.writeFileSync(path.join(secondDir, "findings.json"), JSON.stringify({ findings: [
      { severity: "medium", taxonomy: { category: "Auth" } },
    ] }));
    const firstRun = metricRun(first, {
      scanDir: firstDir,
      severity: { critical: 1, high: 1, medium: 0, low: 1, info: 0, unknown: 0, total: 3 },
    });
    const secondRun = metricRun(second, {
      scanDir: secondDir,
      severity: { critical: 0, high: 0, medium: 1, low: 0, info: 0, unknown: 0, total: 1 },
      engine: "mantis",
    });
    const hiddenRun = metricRun(hidden, {
      scanDir: firstDir,
      severity: firstRun.severity,
    });
    const missingRun = metricRun(missing, {
      scanDir: path.join(root, "missing"),
      severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
    });
    [firstRun, secondRun, hiddenRun, missingRun].forEach(upsertRun);
    assert.equal(indexFindingCategoryMetrics(firstRun), true);
    assert.equal(indexFindingCategoryMetrics(secondRun), true);
    assert.equal(indexFindingCategoryMetrics(hiddenRun), true);
    assert.equal(indexFindingCategoryMetrics(missingRun), true);
    assert.equal(indexFindingCategoryMetrics(missingRun), false);
    hideRun(hidden);

    const all = buildMetricsSummary({ repository: "Metric category fixture" });
    assert.equal(all.totalScans, 3);
    assert.deepEqual(all.topCategories, [
      { category: "Auth", count: 2, high: 1 },
      { category: "Injection", count: 2, high: 1 },
    ]);
    const mantis = buildMetricsSummary({ repository: "Metric category fixture", engine: "mantis" });
    assert.deepEqual(mantis.topCategories, [{ category: "Auth", count: 1, high: 0 }]);
    upsertRun({ ...secondRun, status: "incomplete" });
    assert.deepEqual(buildMetricsSummary({ repository: "Metric category fixture", status: "attention" }).topCategories, []);
    assert.deepEqual(buildMetricsSummary({ repository: "Metric category fixture" }).topCategories, [
      { category: "Injection", count: 2, high: 1 }, { category: "Auth", count: 1, high: 1 },
    ]);
  } finally {
    ids.forEach(deleteRun);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps all SQL totals while bounding recent runs and trend payloads", () => {
  const count = Math.max(METRICS_RECENT_LIMIT, METRICS_COST_TREND_LIMIT) + 25;
  const ids = Array.from({ length: count }, (_, index) => `metrics-bounded-${index}-${randomUUID()}`);
  try {
    ids.forEach((id, index) => upsertRun(metricRun(id, {
      displayName: "Metric bounded fixture",
      startedAt: `2096-01-${String((index % 28) + 1).padStart(2, "0")}T${String(Math.floor(index / 28)).padStart(2, "0")}:00:00.000Z`,
      severity: { critical: 0, high: index % 2, medium: 0, low: 0, info: 0, unknown: 0, total: index % 2 },
    })));
    const summary = buildMetricsSummary({ repository: "Metric bounded fixture" });
    assert.equal(summary.totalScans, count);
    assert.equal(summary.recentTotal, count);
    assert.equal(summary.costTrendTotal, count);
    assert.equal(summary.recent.length, METRICS_RECENT_LIMIT);
    assert.equal(summary.costTrend.length, METRICS_COST_TREND_LIMIT);
    assert.equal(summary.severity.high, Math.floor(count / 2));
    assert.equal(summary.totalEstimatedUsd, count * 0.01);
  } finally {
    ids.forEach(deleteRun);
  }
});

test("materializes the same cost and usage eligibility exposed by a persisted run", () => {
  const id = `metrics-session-${randomUUID()}`;
  try {
    upsertRun(metricRun(id, {
      displayName: "Metric session fixture",
      engine: "mantis",
      authMode: "existing-session",
      usage: {
        inputTokens: 12_000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 900,
      },
      cost: {
        estimatedUsd: 0.99,
        inputTokens: 12_000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 900,
        pricingSource: "official-rate-card",
      },
    }));
    const stored = getRun(id);
    assert.equal(stored?.usage, null);
    const summary = buildMetricsSummary({ repository: "Metric session fixture" });
    assert.equal(summary.pricedScans, 0);
    // rowToScanRun omits session usage, while the persisted cost still carries
    // the adapter-reported token snapshot used by the legacy metric rule.
    assert.equal(summary.totalInputTokens, 12_000);
    assert.equal(summary.totalOutputTokens, 900);
  } finally {
    deleteRun(id);
  }
});

test("drains more than one legacy backfill batch before metrics are read", () => {
  const count = 2_001;
  const ids = Array.from({ length: count }, (_, index) => `metrics-legacy-${index}-${randomUUID()}`);
  try {
    ids.forEach((id) => upsertRun(metricRun(id, {
      displayName: "Metric legacy fixture",
      severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
    })));
    const database = getDb();
    database.prepare(`
      UPDATE runs
      SET metric_pricing_version = NULL, metric_estimated_usd = NULL,
          metric_input_tokens = NULL, metric_output_tokens = NULL, metric_upper_bound = 0
      WHERE display_name = 'Metric legacy fixture'
    `).run();
    let projected = 0;
    let categorized = 0;
    for (;;) {
      const batch = backfillRunMetricProjections(2_000);
      projected += batch;
      if (batch < 2_000) break;
    }
    for (;;) {
      const batch = backfillFindingCategoryMetrics(2_000);
      categorized += batch;
      if (batch < 2_000) break;
    }
    assert.equal(projected, count);
    assert.equal(categorized, count);
    const summary = buildMetricsSummary({ repository: "Metric legacy fixture" });
    assert.equal(summary.totalScans, count);
    assert.equal(summary.pricedScans, count);
    assert.equal(summary.totalInputTokens, count * 100);
  } finally {
    ids.forEach(deleteRun);
  }
});
