import assert from "node:assert/strict";
import test from "node:test";
import type { ScanRun } from "@csb/shared";
import { buildDecisionRanking } from "./compare-decision";

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

test("selects different leaders for coverage and cost efficiency", () => {
  const scans = [scan("wide", 30, 12, 30, 30_000), scan("efficient", 15, 8, 4, 20_000)];
  assert.equal(buildDecisionRanking(scans, "coverage")[0].scan.id, "wide");
  assert.equal(buildDecisionRanking(scans, "efficiency")[0].scan.id, "efficient");
});

test("does not treat missing cost or duration as the best result", () => {
  const scans = [scan("unknown", 30, 12, null, null), scan("measured", 15, 8, 4, 20_000)];
  assert.equal(buildDecisionRanking(scans, "efficiency")[0].scan.id, "measured");
  assert.equal(buildDecisionRanking(scans, "speed")[0].scan.id, "measured");
});

test("keeps the balanced score bounded and ordered", () => {
  const ranking = buildDecisionRanking([scan("wide", 30, 12, 30, 30_000), scan("efficient", 15, 8, 4, 20_000)], "balanced");
  assert.ok(ranking[0].score >= ranking[1].score);
  assert.ok(ranking.every((row) => row.score >= 0 && row.score <= 100));
});
