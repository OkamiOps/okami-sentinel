import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScanRun } from "@csb/shared";
import * as config from "./config.js";
import { buildScannerCatalog } from "./scanners/catalog.js";
import {
  explicitAuthEnvironment,
  prepareScannerLaunch,
} from "./scanners/launch.js";
import { normalizeMantisWorkspace } from "./scanners/mantis-normalize.js";
import { refreshMantisRunFromDisk } from "./scanners/mantis-reconcile.js";
import { writeMantisRuntime } from "./scanners/mantis-runtime.js";
import { parseCliPhaseHint } from "./progress.js";

test("Codex binary resolution prefers an explicit override, then the ChatGPT bundle", () => {
  const resolveCodexBin = (
    config as unknown as {
      resolveCodexBin?: (
        explicit: string | undefined,
        bundledCandidates: string[],
        isExecutable: (candidate: string) => boolean,
      ) => string;
    }
  ).resolveCodexBin;

  assert.equal(typeof resolveCodexBin, "function");
  assert.equal(
    resolveCodexBin?.(" /custom/codex ", ["/bundle/codex"], () => true),
    "/custom/codex",
  );
  assert.equal(
    resolveCodexBin?.(
      undefined,
      ["/bundle/codex", "/other/codex"],
      (candidate) => candidate === "/bundle/codex",
    ),
    "/bundle/codex",
  );
  assert.equal(
    resolveCodexBin?.(undefined, ["/missing/codex"], () => false),
    "codex",
  );
});

test("catalog exposes only routes that have a real phase-one adapter", () => {
  const catalog = buildScannerCatalog({
    codexSecurityReady: true,
    codexSecurityChatGpt: true,
    codexReady: true,
    codexChatGpt: true,
    apiKeyAvailable: false,
  });

  const codexSecurity = catalog.scanners.find((scanner) => scanner.engine === "codex-security");
  const mantis = catalog.scanners.find((scanner) => scanner.engine === "mantis");
  const vulnhunter = catalog.scanners.find((scanner) => scanner.engine === "vulnhunter");

  assert.equal(codexSecurity?.available, true);
  assert.equal(codexSecurity?.authModes.find((auth) => auth.id === "api-key")?.available, false);
  assert.deepEqual(mantis?.authModes.map((auth) => auth.id), ["chatgpt"]);
  assert.equal(mantis?.stageCount, 9);
  assert.equal(mantis?.writesTarget, false);
  assert.equal(mantis?.executesGeneratedCode, false);
  assert.equal(vulnhunter?.enabled, false);
  assert.equal(vulnhunter?.maturity, "experimental");
});

test("ChatGPT authentication never inherits API credentials", () => {
  const env = explicitAuthEnvironment("chatgpt", {
    PATH: "/bin",
    OPENAI_API_KEY: "must-not-leak",
    CODEX_API_KEY: "must-not-leak-either",
  });

  assert.equal(env.PATH, "/bin");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.throws(
    () => explicitAuthEnvironment("api-key", { PATH: "/bin" }),
    /OPENAI_API_KEY\/CODEX_API_KEY/,
  );
});

test("launch adapters produce explicit, reproducible recipes without executing a scanner", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-launch-"));
  const repositoryPath = path.join(fixtureRoot, "repository");
  const codexOutput = path.join(fixtureRoot, "codex-output");
  const mantisOutput = path.join(fixtureRoot, "mantis-output");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(codexOutput);
  fs.mkdirSync(mantisOutput);

  try {
    const codexSecurity = prepareScannerLaunch({
      request: {
        repositoryPath,
        engine: "codex-security",
        provider: "openai",
        authMode: "chatgpt",
        model: "gpt-5.6-sol",
        effort: "high",
        mode: "standard",
        maxCostUsd: 100,
        paths: ["src/auth"],
      },
      repositoryPath,
      outputDir: codexOutput,
      model: "gpt-5.6-sol",
      effort: "high",
      mode: "standard",
    });
    assert.equal(codexSecurity.engine, "codex-security");
    assert.ok(codexSecurity.args.includes("--auth"));
    assert.equal(codexSecurity.args[codexSecurity.args.indexOf("--auth") + 1], "chatgpt");
    assert.ok(codexSecurity.args.includes("--max-cost"));
    assert.match(codexSecurity.recipeHash, /^[a-f0-9]{64}$/);

    const mantis = prepareScannerLaunch({
      request: {
        repositoryPath,
        engine: "mantis",
        provider: "openai",
        authMode: "chatgpt",
        model: "gpt-5.6-terra",
        effort: "medium",
        mode: "standard",
        paths: ["src"],
      },
      repositoryPath,
      outputDir: mantisOutput,
      model: "gpt-5.6-terra",
      effort: "medium",
      mode: "standard",
    });
    const config = JSON.parse(
      fs.readFileSync(path.join(mantisOutput, "mantis-run.json"), "utf8"),
    ) as { repositoryPath: string; paths: string[]; source: { ref: string } };
    assert.equal(mantis.engine, "mantis");
    assert.equal(config.repositoryPath, repositoryPath);
    assert.deepEqual(config.paths, ["src"]);
    assert.match(config.source.ref, /^[a-f0-9]{40}$/);
    assert.match(mantis.recipeHash, /^[a-f0-9]{64}$/);
    assert.equal(mantis.env.OPENAI_API_KEY, undefined);
    assert.equal(mantis.env.CODEX_API_KEY, undefined);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Mantis normalization keeps reportable evidence and preserves raw pipeline output", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mantis-normalize-"));
  const stateRoot = path.join(fixtureRoot, "state");
  const outputDir = path.join(fixtureRoot, "output");
  const findingsDir = path.join(stateRoot, "workspace", "findings");
  fs.mkdirSync(findingsDir, { recursive: true });
  fs.mkdirSync(outputDir);

  fs.writeFileSync(
    path.join(findingsDir, "valid.json"),
    JSON.stringify({
      id: "auth-bypass",
      title: "Authorization bypass",
      description: "A tenant check is missing.",
      severity: "HIGH",
      status: "VALID",
      production_viability: "VIABLE",
      code_paths: ["src/auth.ts:10-12"],
      cwe: "CWE-862",
      mitigation: "Enforce the tenant boundary before data access.",
    }),
  );
  fs.writeFileSync(
    path.join(findingsDir, "false-positive.json"),
    JSON.stringify({
      id: "noise",
      title: "Noise",
      severity: "LOW",
      status: "FALSE_POSITIVE",
    }),
  );

  try {
    assert.equal(normalizeMantisWorkspace(stateRoot, outputDir), 1);
    const payload = JSON.parse(fs.readFileSync(path.join(outputDir, "findings.json"), "utf8")) as {
      sourceFindings: number;
      findings: Array<Record<string, unknown>>;
    };
    assert.equal(payload.sourceFindings, 2);
    assert.equal(payload.findings.length, 1);
    assert.equal(payload.findings[0]?.findingId, "mantis-auth-bypass");
    assert.deepEqual(payload.findings[0]?.severity, {
      level: "high",
      rationale: null,
    });
    assert.equal(fs.existsSync(path.join(findingsDir, "false-positive.json")), true);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("failed Mantis runs with normalized findings remain explicit partial results", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mantis-partial-"));
  const startedAt = "2026-08-10T10:00:00.000Z";
  fs.writeFileSync(
    path.join(fixtureRoot, "findings.json"),
    JSON.stringify({ findings: [{ severity: { level: "critical" } }] }),
  );
  writeMantisRuntime(fixtureRoot, {
    engine: "mantis",
    status: "failed",
    stage: "review",
    stageLabel: "Independent review",
    percent: 72,
    detail: "review failed",
    startedAt,
    updatedAt: "2026-08-10T10:03:00.000Z",
    completedAt: "2026-08-10T10:03:00.000Z",
    snapshotId: "content:abc",
    sourceRef: "a".repeat(40),
    findings: 1,
    usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
    error: "review failed",
  });
  const run: ScanRun = {
    id: "mantis-partial",
    displayName: "fixture",
    repositoryPath: fixtureRoot,
    revision: null,
    scanDir: fixtureRoot,
    status: "running",
    model: "gpt-5.6-sol",
    effort: "high",
    mode: "standard",
    engine: "mantis",
    provider: "openai",
    authMode: "chatgpt",
    scannerVersion: null,
    recipeHash: "fixture",
    startedAt,
    completedAt: null,
    durationMs: null,
    cost: null,
    severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
    source: "benchmark",
    pid: null,
  };

  try {
    const refreshed = refreshMantisRunFromDisk(run);
    assert.equal(refreshed.status, "incomplete");
    assert.equal(refreshed.severity.critical, 1);
    assert.equal(refreshed.cost?.inputTokens, 10);
    assert.equal(refreshed.revision, "content:abc");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Sentinel progress markers map Mantis stages without parsing prose", () => {
  const parsed = parseCliPhaseHint(
    'SENTINEL_PROGRESS {"percent":58,"phaseLabel":"Deduplication","detail":"running mantis-dedupe","stage":"dedupe","findings":4}',
  );
  assert.equal(parsed?.percent, 58);
  assert.equal(parsed?.phase, "dedupe");
  assert.equal(parsed?.phaseLabel, "Deduplication");
  assert.equal(parsed?.reportableFindings, 4);
});
