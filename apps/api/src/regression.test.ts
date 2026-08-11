import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScanRun, ScannerEngine } from "@csb/shared";
import { deleteRun, upsertRun } from "./db.js";
import { buildRegressionSummary } from "./regression.js";

const EMPTY_SEVERITY = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
  unknown: 0,
  total: 0,
};

function writeFinding(scanDir: string, id: string, fingerprint: string): void {
  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(path.join(scanDir, "findings.json"), JSON.stringify({
    schemaVersion: 1,
    findings: [{
      findingId: id,
      occurrenceId: id,
      title: `Finding ${id}`,
      summary: `Current evidence for ${id}.`,
      severity: { level: "high" },
      confidence: { level: "high" },
      ruleId: "fixture/rule",
      remediation: "Apply the verified defensive control.",
      locations: [{ path: "src/app.ts", startLine: 1, endLine: 1 }],
      codeEvidence: [],
      taxonomy: { category: "Fixture", cwe: ["CWE-20"] },
      fingerprints: { algorithm: "fixture/v1", primary: fingerprint },
    }],
  }));
}

function run(
  root: string,
  id: string,
  engine: ScannerEngine,
  startedAt: string,
  patch: Partial<ScanRun> = {},
): ScanRun {
  return {
    id,
    displayName: "Lifecycle fixture",
    repositoryPath: path.join(root, "repository"),
    revision: "content:canonical-source",
    scanDir: path.join(root, id),
    status: "completed",
    model: "MiniMax-M3",
    effort: null,
    mode: "standard",
    engine,
    provider: "minimax",
    authMode: "api-key",
    scannerVersion: "fixture-1",
    recipeHash: engine === "codex-security" ? "portable-recipe" : "mantis-recipe",
    startedAt,
    completedAt: startedAt,
    durationMs: 1_000,
    cost: null,
    usage: null,
    severity: { ...EMPTY_SEVERITY, high: 1, total: 1 },
    source: "benchmark",
    pid: null,
    execution: engine === "codex-security" ? {
      executionProfile: "portable",
      profileVersion: "sentinel-portable-v1",
      methodologyRef: "sentinel/codex-security-portable@v1",
      capabilityCheckId: "capability-fixture",
      connectionId: "connection-fixture",
      routeKind: "minimax-token-plan",
      protocol: "anthropic-messages",
      authKind: "api-key",
    } : null,
    connection: {
      connectionId: "connection-fixture",
      routeKind: "minimax-token-plan",
      protocol: "anthropic-messages",
      authKind: "api-key",
      capabilityCheckId: "capability-fixture",
    },
    launchSelection: {
      modelSelectionMode: "catalog",
      modelId: "MiniMax-M3",
      paths: [],
    },
    ...patch,
  };
}

test("a new scan never imports findings from an incompatible engine baseline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "regression-cross-engine-"));
  const baseline = run(root, "baseline-mantis", "mantis", "2026-08-11T20:00:00.000Z");
  const current = run(root, "current-portable", "codex-security", "2026-08-11T21:00:00.000Z");
  writeFinding(baseline.scanDir, "baseline-only", "mantis:fingerprint:baseline-only");
  writeFinding(current.scanDir, "current-only", "portable:fingerprint:current-only");

  try {
    upsertRun(baseline);
    upsertRun(current);
    const summary = buildRegressionSummary(current.id);

    assert.equal(summary.baseline, null);
    assert.equal(summary.baselineSource, "none");
    assert.equal(summary.counts.fixed, 0);
    assert.deepEqual(summary.findings.map((finding) => finding.findingId), ["current-only"]);
    assert.equal(summary.findings[0]?.sourceScanId, current.id);
  } finally {
    deleteRun(current.id);
    deleteRun(baseline.id);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("standard and deep scans expose current findings only even with a comparable baseline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "regression-current-only-"));
  const baseline = run(root, "baseline-portable", "codex-security", "2026-08-11T20:00:00.000Z");
  const current = run(root, "current-portable-same-lineage", "codex-security", "2026-08-11T21:00:00.000Z", {
    revision: "content:changed-source",
  });
  writeFinding(baseline.scanDir, "baseline-only", "portable:fingerprint:baseline-only");
  writeFinding(current.scanDir, "current-only", "portable:fingerprint:current-only");

  try {
    upsertRun(baseline);
    upsertRun(current);
    const summary = buildRegressionSummary(current.id);

    assert.equal(summary.baseline?.id, baseline.id);
    assert.equal(summary.baselineSource, "automatic");
    assert.equal(summary.counts.fixed, 0);
    assert.deepEqual(summary.findings.map((finding) => finding.findingId), ["current-only"]);
    assert.equal(summary.findings.every((finding) => finding.sourceScanId === current.id), true);
  } finally {
    deleteRun(current.id);
    deleteRun(baseline.id);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the same source revision never turns model variance into a regressed finding", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "regression-same-revision-"));
  const historical = run(root, "historical-portable", "codex-security", "2026-08-11T19:00:00.000Z");
  const baseline = run(root, "baseline-portable-empty-of-a", "codex-security", "2026-08-11T20:00:00.000Z");
  const current = run(root, "current-portable-repeat", "codex-security", "2026-08-11T21:00:00.000Z");
  writeFinding(historical.scanDir, "finding-a", "portable:fingerprint:finding-a");
  writeFinding(baseline.scanDir, "finding-b", "portable:fingerprint:finding-b");
  writeFinding(current.scanDir, "finding-a", "portable:fingerprint:finding-a");

  try {
    upsertRun(historical);
    upsertRun(baseline);
    upsertRun(current);
    const summary = buildRegressionSummary(current.id);

    assert.equal(summary.baseline?.id, baseline.id);
    assert.equal(summary.counts.regressed, 0);
    assert.equal(summary.counts.new, 1);
    assert.equal(summary.findings[0]?.lifecycle, "new");
  } finally {
    deleteRun(current.id);
    deleteRun(baseline.id);
    deleteRun(historical.id);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
