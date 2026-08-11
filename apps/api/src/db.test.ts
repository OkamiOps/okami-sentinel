import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import * as dbModule from "./db.js";
import { deleteRun, getRun, hideRun, parseCostJson, upsertRun } from "./db.js";
import type { ScanRun } from "@csb/shared";

test("hides a run from the ledger, preserves its audit row and clears its baseline", () => {
  const database = new Database(":memory:");

  try {
    database.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY);
      CREATE TABLE hidden_runs (id TEXT PRIMARY KEY, hidden_at TEXT NOT NULL);
      CREATE TABLE repository_baselines (
        repository_key TEXT PRIMARY KEY,
        scan_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO runs (id) VALUES ('failed-scan');
      INSERT INTO repository_baselines (repository_key, scan_id, updated_at)
      VALUES ('/repo', 'failed-scan', '2026-08-11T00:00:00.000Z');
    `);

    hideRun("failed-scan", database);

    assert.deepEqual(
      database.prepare("SELECT id FROM runs").all(),
      [{ id: "failed-scan" }],
    );
    assert.deepEqual(
      database.prepare("SELECT id FROM hidden_runs").all(),
      [{ id: "failed-scan" }],
    );
    assert.deepEqual(
      database.prepare("SELECT scan_id FROM repository_baselines").all(),
      [],
    );
  } finally {
    database.close();
  }
});

test("round-trips frozen provider-catalog pricing and null costs", () => {
  const pricedRun: ScanRun = {
    id: "portable-pricing-round-trip",
    displayName: "Portable pricing fixture",
    repositoryPath: "/repo",
    revision: "abc123",
    scanDir: "/scan",
    status: "completed",
    model: "mimo-v2.5",
    effort: "high",
    mode: "standard",
    engine: "codex-security",
    provider: "xiaomi",
    authMode: "api-key",
    scannerVersion: "fixture",
    recipeHash: "fixture",
    startedAt: "2026-08-11T09:00:00.000Z",
    completedAt: "2026-08-11T09:01:00.000Z",
    durationMs: 60_000,
    cost: {
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
    },
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
    source: "benchmark",
    pid: null,
    execution: {
      executionProfile: "portable",
      profileVersion: "sentinel-codex-security-portable-v1",
      methodologyRef: "sentinel/codex-security-methodology@v1",
      capabilityCheckId: "cap-1",
      connectionId: "connection-1",
      routeKind: "mimo-token-plan",
      protocol: "openai-chat",
      authKind: "api-key",
    },
    connection: {
      connectionId: "connection-1",
      routeKind: "mimo-token-plan",
      protocol: "openai-chat",
      authKind: "api-key",
      capabilityCheckId: "cap-1",
    },
    launchSelection: {
      modelSelectionMode: "catalog",
      modelId: "mimo-v2.5",
      paths: ["src/auth"],
    },
  };
  const nullCostRun: ScanRun = {
    ...pricedRun,
    id: "portable-null-cost-round-trip",
    cost: null,
    usage: {
      inputTokens: 321,
      cachedInputTokens: null,
      cacheWriteInputTokens: 0,
      outputTokens: 45,
    },
  };

  try {
    upsertRun(pricedRun);
    upsertRun(nullCostRun);

    assert.deepEqual(getRun(pricedRun.id)?.cost, pricedRun.cost);
    assert.deepEqual(getRun(pricedRun.id)?.execution, pricedRun.execution);
    assert.deepEqual(getRun(pricedRun.id)?.connection, pricedRun.connection);
    assert.deepEqual(getRun(pricedRun.id)?.launchSelection, pricedRun.launchSelection);
    assert.equal(getRun(nullCostRun.id)?.cost, null);
    assert.deepEqual(getRun(nullCostRun.id)?.usage, nullCostRun.usage);
  } finally {
    deleteRun(pricedRun.id);
    deleteRun(nullCostRun.id);
  }
});

test("round-trips approved OpenRouter alias provenance safely", () => {
  const aliasRun: ScanRun = {
    id: "openrouter-alias-round-trip",
    displayName: "OpenRouter alias fixture",
    repositoryPath: "/repo",
    revision: "abc123",
    scanDir: "/scan",
    status: "completed",
    model: "gpt-5.3-codex-spark",
    effort: "high",
    mode: "standard",
    engine: "codex-security",
    provider: "openai",
    authMode: "api-key",
    scannerVersion: "fixture",
    recipeHash: "fixture",
    startedAt: "2026-08-11T09:00:00.000Z",
    completedAt: "2026-08-11T09:01:00.000Z",
    durationMs: 60_000,
    cost: {
      estimatedUsd: 15.75,
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000_000,
      model: "gpt-5.3-codex-spark",
      pricingSource: "openrouter",
      pricingMatch: "approved-alias",
      pricingAliasId: "openai.spark-to-gpt-5.3-codex.v1",
      pricingSnapshot: {
        currency: "USD",
        capturedAt: "2026-08-11T16:49:02.000Z",
        inputUsdPerMillionTokens: 1.75,
        cachedInputUsdPerMillionTokens: 0.175,
        cacheWriteInputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: 14,
      },
      pricingModel: "openai/gpt-5.3-codex",
      pricingUpdatedAt: "2026-08-11T16:49:02.000Z",
      inputUsd: 1.75,
      outputUsd: 14,
    },
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
    source: "benchmark",
    pid: null,
    execution: null,
  };

  try {
    upsertRun(aliasRun);

    assert.deepEqual(getRun(aliasRun.id)?.cost, aliasRun.cost);
    const unreviewedAlias = parseCostJson(JSON.stringify({
      ...aliasRun.cost,
      pricingAliasId: "openai.unreviewed-alias.v1",
    }));
    assert.equal(unreviewedAlias?.pricingMatch, undefined);
    assert.equal(unreviewedAlias?.pricingAliasId, undefined);
  } finally {
    deleteRun(aliasRun.id);
  }
});

test("adds complete execution columns to legacy run schemas idempotently", () => {
  const ensureRunMetadataColumns = (
    dbModule as typeof dbModule & {
      ensureRunMetadataColumns?: (database: Database.Database) => void;
    }
  ).ensureRunMetadataColumns;

  assert.equal(typeof ensureRunMetadataColumns, "function");
  if (typeof ensureRunMetadataColumns !== "function") return;

  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE runs (id TEXT PRIMARY KEY)");
    ensureRunMetadataColumns(database);
    ensureRunMetadataColumns(database);

    const columns = new Set(
      (database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    for (const column of [
      "execution_profile",
      "profile_version",
      "methodology_ref",
      "capability_check_id",
      "connection_id",
      "route_kind",
      "protocol",
      "auth_kind",
      "launch_selection_json",
      "cost_json",
    ]) {
      assert.equal(columns.has(column), true);
    }
  } finally {
    database.close();
  }
});
