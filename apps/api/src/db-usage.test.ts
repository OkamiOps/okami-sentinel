import assert from "node:assert/strict";
import test from "node:test";

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
  assert.equal(rowToScanRun(subscriptionRow({})).cost, null);
});

test("keeps historical subscription usage when the provider reported tokens", () => {
  const run = rowToScanRun(subscriptionRow({ input_tokens: 120, output_tokens: 30 }));

  assert.equal(run.cost?.inputTokens, 120);
  assert.equal(run.cost?.outputTokens, 30);
});
