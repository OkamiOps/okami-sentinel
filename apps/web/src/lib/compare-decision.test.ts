import assert from "node:assert/strict";
import test from "node:test";
import type { ScanRun } from "@csb/shared";
import { buildDecisionRanking, buildMarginalEconomics, isComparableScan, isPartialComparableScan } from "./compare-decision";

function scan(id: string, total: number, high: number, cost: number | null, durationMs: number | null): ScanRun {
  return {
    id,
    displayName: id,
    repositoryPath: "/repo",
    revision: "abc",
    scanDir: `/scan/${id}`,
    status: "completed",
    model: id,
    effort: "high",
    mode: "standard",
    startedAt: "2026-08-08T00:00:00.000Z",
    completedAt: "2026-08-08T00:01:00.000Z",
    durationMs,
    cost: cost == null ? null : { estimatedUsd: cost, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 },
    severity: { critical: 0, high, medium: total - high, low: 0, info: 0, unknown: 0, total },
    source: "workbench",
    pid: null,
  };
}

test("selects different leaders for coverage and unit cost", () => {
  const scans = [scan("wide", 30, 12, 30, 30_000), scan("efficient", 15, 8, 4, 20_000)];
  assert.equal(buildDecisionRanking(scans, "coverage")[0].scan.id, "wide");
  assert.equal(buildDecisionRanking(scans, "cost_per_finding")[0].scan.id, "efficient");
  assert.equal(buildDecisionRanking(scans, "cost_per_high")[0].scan.id, "efficient");
});

test("does not treat missing cost or duration as the best result", () => {
  const scans = [scan("unknown", 30, 12, null, null), scan("measured", 15, 8, 4, 20_000)];
  assert.equal(buildDecisionRanking(scans, "cost_per_finding")[0].scan.id, "measured");
  assert.equal(buildDecisionRanking(scans, "cost_per_high")[0].scan.id, "measured");
  assert.equal(buildDecisionRanking(scans, "speed")[0].scan.id, "measured");
});

test("calculates unit cost and hourly throughput", () => {
  const row = buildDecisionRanking([scan("measured", 10, 4, 5, 1_800_000)], "coverage")[0];
  assert.equal(row.costPerFinding, 0.5);
  assert.equal(row.costPerHighPlus, 1.25);
  assert.equal(row.findingsPerHour, 20);
  assert.equal(row.highPerHour, 8);
});

test("calculates marginal cost against the selected baseline", () => {
  const rows = buildDecisionRanking([scan("baseline", 10, 2, 5, 1_800_000), scan("candidate", 20, 7, 12, 2_400_000)], "coverage");
  const marginal = buildMarginalEconomics(rows, "baseline")[0];
  assert.equal(marginal.extraCostUsd, 7);
  assert.equal(marginal.extraFindings, 10);
  assert.equal(marginal.extraHighPlus, 5);
  assert.equal(marginal.costPerExtraFinding, 0.7);
  assert.equal(marginal.costPerExtraHighPlus, 1.4);
});

test("keeps the balanced score bounded and ordered", () => {
  const ranking = buildDecisionRanking([scan("wide", 30, 12, 30, 30_000), scan("efficient", 15, 8, 4, 20_000)], "balanced");
  assert.ok(ranking[0].score >= ranking[1].score);
  assert.ok(ranking.every((row) => row.score >= 0 && row.score <= 100));
});

test("accepts failed scans only when they preserved findings", () => {
  const partial = { ...scan("partial", 12, 4, 20, 30_000), status: "failed" as const };
  const emptyFailure = { ...scan("empty", 0, 0, 2, 10_000), status: "failed" as const };

  assert.equal(isComparableScan(partial), true);
  assert.equal(isPartialComparableScan(partial), true);
  assert.equal(isComparableScan(emptyFailure), false);
  assert.equal(isPartialComparableScan(emptyFailure), false);
  assert.equal(isComparableScan(scan("complete", 0, 0, 1, 10_000)), true);
});
