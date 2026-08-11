import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScanProgress, ScanRun } from "@csb/shared";
import * as config from "./config.js";
import { readFindingsFile } from "./ingest.js";
import { buildScannerCatalog } from "./scanners/catalog.js";
import {
  explicitAuthEnvironment,
  prepareMantisLocalLaunch,
  prepareMantisHttpLaunch,
  prepareScannerLaunch,
} from "./scanners/launch.js";
import { createSafeMantisProviderPlan } from "./scanners/mantis-http-runner.js";
import {
  normalizeMantisFinding,
  normalizeMantisWorkspace,
} from "./scanners/mantis-normalize.js";
import { refreshMantisRunFromDisk } from "./scanners/mantis-reconcile.js";
import { refreshVulnHunterRunFromDisk } from "./scanners/vulnhunter-reconcile.js";
import {
  createResilientLineWriter,
  MANTIS_CODEX_ISOLATION_ARGS,
  summarizeMantisEvent,
  writeMantisRuntime,
} from "./scanners/mantis-runtime.js";
import { writeVulnHunterRuntime } from "./scanners/vulnhunter-runtime.js";
import {
  isInternalProgressMarker,
  parseCliPhaseHint,
  progressEventMessage,
  progressForStatus,
} from "./progress.js";

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

test("catalog exposes every scanner backed by a real local adapter", () => {
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
  assert.equal(vulnhunter?.enabled, true);
  assert.equal(vulnhunter?.available, true);
  assert.equal(vulnhunter?.maturity, "experimental");
  assert.deepEqual(vulnhunter?.authModes.map((auth) => auth.id), ["chatgpt"]);
  assert.deepEqual(vulnhunter?.models.map((model) => model.id), ["gpt-5.6-sol"]);
  assert.deepEqual(vulnhunter?.efforts, ["high", "xhigh"]);
  assert.deepEqual(vulnhunter?.modes, ["standard"]);
  assert.equal(vulnhunter?.stageCount, 6);
  assert.equal(vulnhunter?.writesTarget, false);
  assert.equal(vulnhunter?.executesGeneratedCode, false);
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

test("Mantis local launch permits only the minimal existing-session environment", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mantis-local-launch-"));
  const repositoryPath = path.join(fixtureRoot, "repository");
  const outputDir = path.join(fixtureRoot, "output");
  const sourceCacheDir = path.join(fixtureRoot, "cache");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(outputDir);
  fs.mkdirSync(sourceCacheDir, { mode: 0o700 });
  const environment = {
    PATH: "/private/claude-bin",
    HOME: "/private/claude-home",
    TMPDIR: "/private/claude-tmp",
    XDG_CONFIG_HOME: "/private/claude-config",
    OPENAI_API_KEY: "openai-key-must-not-reach-local-worker",
    CODEX_API_KEY: "codex-key-must-not-reach-local-worker",
    ANTHROPIC_API_KEY: "anthropic-key-must-not-reach-local-worker",
    XAI_API_KEY: "xai-key-must-not-reach-local-worker",
    CURSOR_API_KEY: "cursor-key-must-not-reach-local-worker",
    OPENROUTER_API_KEY: "openrouter-key-must-not-reach-local-worker",
    GOOGLE_API_KEY: "google-key-must-not-reach-local-worker",
    GEMINI_API_KEY: "gemini-key-must-not-reach-local-worker",
    DEEPSEEK_API_KEY: "deepseek-key-must-not-reach-local-worker",
    MINIMAX_API_KEY: "minimax-key-must-not-reach-local-worker",
    MIMO_API_KEY: "mimo-key-must-not-reach-local-worker",
    CUSTOM_API_KEY: "custom-key-must-not-reach-local-worker",
    ANTHROPIC_AUTH_TOKEN: "anthropic-token-must-not-reach-local-worker",
    GOOGLE_TOKEN: "google-token-must-not-reach-local-worker",
    CUSTOM_TOKEN: "custom-token-must-not-reach-local-worker",
    OPENAI_BASE_URL: "https://openai.example.invalid",
    ANTHROPIC_BASE_URL: "https://anthropic.example.invalid",
    OPENROUTER_BASE_URL: "https://openrouter.example.invalid",
    GOOGLE_BASE_URL: "https://google.example.invalid",
    GEMINI_BASE_URL: "https://gemini.example.invalid",
    DEEPSEEK_BASE_URL: "https://deepseek.example.invalid",
    MINIMAX_BASE_URL: "https://minimax.example.invalid",
    MIMO_BASE_URL: "https://mimo.example.invalid",
    NODE_OPTIONS: "--require /private/untrusted-hook.cjs",
    CLAUDE_CONFIG_DIR: "/private/session-kept-for-existing-login",
  };

  try {
    const launch = prepareMantisLocalLaunch({
      request: {
        repositoryPath,
        engine: "mantis",
        provider: "browser-injected-provider",
        model: "browser-injected-model",
        authMode: "api-key",
        paths: ["src"],
      },
      repositoryPath,
      outputDir,
      effort: "high",
      mode: "standard",
      sourceCacheDir,
      environment,
      mantisLocalProviderPlan: {
        scanId: "scan-local",
        connectionId: "claude-local",
        routeKind: "claude-code-local",
        protocol: "claude-code-cli",
        modelSelectionMode: "runtime-default",
        modelId: null,
      },
    });
    const configPath = path.join(outputDir, "mantis-local-run.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;

    assert.equal(launch.engine, "mantis");
    assert.equal(launch.provider, "anthropic");
    assert.equal(launch.authMode, "existing-session");
    assert.match(launch.displayCommand, /^sentinel-mantis-local /);
    assert.equal(launch.args.at(-1), configPath);
    assert.deepEqual(Object.keys(config).sort(), [
      "outputDir", "paths", "providerPlan", "repositoryPath", "sourceCacheDir", "sourceRef",
    ]);
    assert.equal(config.sourceCacheDir, sourceCacheDir);
    assert.deepEqual(config.providerPlan, {
      scanId: "scan-local",
      connectionId: "claude-local",
      routeKind: "claude-code-local",
      protocol: "claude-code-cli",
      modelSelectionMode: "runtime-default",
      modelId: null,
    });
    assert.equal("model" in config, false);
    assert.equal(fs.statSync(configPath).mode & 0o077, 0);
    for (const key of Object.keys(environment).filter((key) =>
      key.endsWith("_API_KEY") || key.endsWith("_TOKEN") || key.endsWith("_BASE_URL") || key === "NODE_OPTIONS",
    )) {
      assert.equal(launch.env[key], undefined, `${key} must not reach local worker`);
    }
    assert.deepEqual(Object.keys(launch.env).sort(), [
      "CI", "CLAUDE_CONFIG_DIR", "HOME", "NO_COLOR", "PATH", "TMPDIR", "XDG_CONFIG_HOME",
    ]);
    assert.equal(launch.env.PATH, environment.PATH);
    assert.equal(launch.env.HOME, environment.HOME);
    assert.equal(launch.env.TMPDIR, environment.TMPDIR);
    assert.equal(launch.env.XDG_CONFIG_HOME, environment.XDG_CONFIG_HOME);
    assert.equal(launch.env.CLAUDE_CONFIG_DIR, environment.CLAUDE_CONFIG_DIR);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("launch adapters produce explicit, reproducible recipes without executing a scanner", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-launch-"));
  const repositoryPath = path.join(fixtureRoot, "repository");
  const codexOutput = path.join(fixtureRoot, "codex-output");
  const mantisOutput = path.join(fixtureRoot, "mantis-output");
  const vulnhunterOutput = path.join(fixtureRoot, "vulnhunter-output");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(codexOutput);
  fs.mkdirSync(mantisOutput);
  fs.mkdirSync(vulnhunterOutput);

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

    let vulnhunter: ReturnType<typeof prepareScannerLaunch>;
    try {
      vulnhunter = prepareScannerLaunch({
        request: {
          repositoryPath,
          engine: "vulnhunter",
          provider: "openai",
          authMode: "chatgpt",
          model: "gpt-5.6-sol",
          effort: "high",
          mode: "standard",
          paths: ["src/api"],
        },
        repositoryPath,
        outputDir: vulnhunterOutput,
        model: "gpt-5.6-sol",
        effort: "high",
        mode: "standard",
      });
    } catch (error) {
      assert.fail(`VulnHunter launch adapter is missing: ${String(error)}`);
    }
    const vulnhunterConfig = JSON.parse(
      fs.readFileSync(path.join(vulnhunterOutput, "vulnhunter-run.json"), "utf8"),
    ) as {
      repositoryPath: string;
      paths: string[];
      readOnly: boolean;
      profileVersion: string;
      source: { ref: string };
    };
    assert.equal(vulnhunter.engine, "vulnhunter");
    assert.equal(vulnhunterConfig.repositoryPath, repositoryPath);
    assert.deepEqual(vulnhunterConfig.paths, ["src/api"]);
    assert.equal(vulnhunterConfig.readOnly, true);
    assert.equal(vulnhunterConfig.profileVersion, "sentinel-static-v1");
    assert.match(vulnhunterConfig.source.ref, /^[a-f0-9]{40}$/);
    assert.equal(vulnhunter.scannerVersion, "sentinel-static-v1");
    assert.match(vulnhunter.recipeHash, /^[a-f0-9]{64}$/);
    assert.equal(vulnhunter.env.OPENAI_API_KEY, undefined);
    assert.equal(vulnhunter.env.CODEX_API_KEY, undefined);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("VulnHunter direct xAI OAuth launch serializes only the immutable provider reference", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-http-launch-"));
  const repositoryPath = path.join(fixtureRoot, "repository");
  const outputDir = path.join(fixtureRoot, "output");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(outputDir);
  const providerPlan = {
    scanId: "scan-vulnhunter-xai",
    connectionId: "connection-xai",
    routeKind: "xai-oauth",
    protocol: "xai-oauth-responses" as const,
    modelId: "grok-live",
    capabilityCheckId: "capability-xai",
  };
  const oauthToken = "private-xai-oauth-token-must-not-reach-worker-config";
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousCodexKey = process.env.CODEX_API_KEY;
  process.env.OPENAI_API_KEY = "global-openai-key-must-not-reach-vulnhunter";
  process.env.CODEX_API_KEY = "global-codex-key-must-not-reach-vulnhunter";

  try {
    const launch = prepareScannerLaunch({
      request: {
        repositoryPath,
        engine: "vulnhunter",
        connection: {
          connectionId: "connection-xai",
          modelSelectionMode: "catalog",
          modelId: "grok-live",
        },
      },
      repositoryPath,
      outputDir,
      model: "grok-live",
      effort: "high",
      mode: "standard",
      vulnhunterProviderPlan: providerPlan,
      providerKind: "xai",
    });
    const config = JSON.parse(
      fs.readFileSync(path.join(outputDir, "vulnhunter-run.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(config.providerPlan, providerPlan);
    const serialized = JSON.stringify(config);
    assert.equal(serialized.includes("apiKey"), false);
    assert.equal(serialized.includes("baseUrl"), false);
    assert.equal(serialized.includes("headers"), false);
    assert.equal(serialized.includes(oauthToken), false);
    assert.equal(serialized.includes("global-openai-key-must-not-reach-vulnhunter"), false);
    assert.equal(serialized.includes("global-codex-key-must-not-reach-vulnhunter"), false);
    assert.equal(launch.provider, "xai");
    assert.equal(launch.authMode, "api-key");
    assert.equal(launch.env.OPENAI_API_KEY, undefined);
    assert.equal(launch.env.CODEX_API_KEY, undefined);
  } finally {
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousCodexKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previousCodexKey;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Mantis HTTP launch serializes only the revalidated provider identifiers", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mantis-http-launch-"));
  const repositoryPath = path.join(fixtureRoot, "repository");
  const outputDir = path.join(fixtureRoot, "output");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(outputDir);

  try {
    const providerPlan = createSafeMantisProviderPlan({
      engine: "mantis",
      connectionId: "connection-a",
      providerKind: "openai",
      routeKind: "openai-api",
      runnerKind: "agent-session",
      protocol: "openai-responses",
      model: {
        connectionId: "connection-a",
        id: "gpt-live",
        displayName: "GPT Live",
        contextWindow: null,
        capabilities: {
          tools: "supported", artifactOutput: "supported", structuredOutput: "supported",
          boundedExecution: "supported", osIsolation: "supported", streaming: "supported",
          usage: "supported", cancellation: "supported",
        },
        pricing: null,
        discoveredAt: "2026-08-11T12:00:00.000Z",
        source: "provider-api",
      },
      capabilityCheckId: "capability-a",
      snapshot: {
        scanId: "scan-a",
        connectionId: "connection-a",
        routeKind: "openai-api",
        modelSelectionMode: "catalog",
        modelId: "gpt-live",
        capabilityCheckId: "capability-a",
        capturedAt: "2026-08-11T12:00:00.000Z",
      },
    });
    const launch = prepareMantisHttpLaunch({
      request: { repositoryPath, engine: "mantis", paths: ["src"] },
      repositoryPath,
      outputDir,
      model: "gpt-live",
      effort: "high",
      mode: "standard",
      providerKind: "openai",
      mantisProviderPlan: providerPlan,
    });
    const config = JSON.parse(fs.readFileSync(path.join(outputDir, "mantis-http-run.json"), "utf8")) as Record<string, unknown>;

    assert.equal(launch.engine, "mantis");
    assert.equal(launch.authMode, "api-key");
    assert.equal(launch.provider, "openai");
    assert.equal(config.model, undefined);
    assert.equal(config.effort, undefined);
    assert.equal(config.providerPlan instanceof Object, true);
    assert.deepEqual(Object.keys(config.providerPlan as object).sort(), [
      "capabilityCheckId", "connectionId", "modelId", "protocol", "routeKind", "scanId",
    ]);
    assert.equal(JSON.stringify(config).includes("apiKey"), false);
    assert.equal(JSON.stringify(config).includes("secret"), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Mantis normalization keeps reportable evidence and preserves raw pipeline output", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mantis-normalize-"));
  const stateRoot = path.join(fixtureRoot, "state");
  const outputDir = path.join(fixtureRoot, "output");
  const findingsDir = path.join(stateRoot, "workspace", "findings");
  const snapshotDir = path.join(outputDir, "mantis-snapshot", "src");
  fs.mkdirSync(findingsDir, { recursive: true });
  fs.mkdirSync(outputDir);
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(
    path.join(snapshotDir, "auth.ts"),
    Array.from({ length: 14 }, (_, index) =>
      index === 9 ? "return db.users.findMany();" : `// line ${index + 1}`
    ).join("\n"),
  );

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
      reasoning: "The handler reads all tenants without an ownership predicate.",
      critic_reasoning: "Independent review confirmed the production route is reachable.",
      attacker_position: "EXTERNAL",
      privileges_required: "LOW",
      user_interaction: "NONE",
      impact: "A tenant can enumerate records owned by other tenants.",
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
    assert.deepEqual(payload.findings[0]?.rootCause, {
      summary: "The handler reads all tenants without an ownership predicate.",
    });
    assert.deepEqual(payload.findings[0]?.validation, {
      status: "VALID",
      summary: "The handler reads all tenants without an ownership predicate.",
      method: "Mantis review: VALID · production viability: VIABLE",
      productionViability: "VIABLE",
      supportingEvidence: [
        "Independent review confirmed the production route is reachable.",
      ],
    });
    assert.deepEqual(payload.findings[0]?.codeEvidence, [{
      id: "evidence-1",
      label: "Evidence at src/auth.ts:10–12",
      path: "src/auth.ts",
      startLine: 10,
      endLine: 12,
      lines: "10-12",
      role: "evidence",
      code: "return db.users.findMany();\n// line 11\n// line 12",
      language: "typescript",
      explanation: "The handler reads all tenants without an ownership predicate. Independent review confirmed the production route is reachable.",
    }]);
    assert.deepEqual(payload.findings[0]?.attackPath, {
      summary: "The handler reads all tenants without an ownership predicate.",
      evidenceRefs: ["evidence-1"],
      reachability: {
        attacker: "EXTERNAL",
        preconditions: "Privileges required: LOW · user interaction: NONE",
      },
      dataflow: {
        summary: "The handler reads all tenants without an ownership predicate.",
        outcome: "A tenant can enumerate records owned by other tenants.",
        evidenceRefs: ["evidence-1"],
      },
    });
    assert.equal(fs.existsSync(path.join(findingsDir, "false-positive.json")), true);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Mantis evidence hydration cannot read outside the immutable snapshot", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mantis-evidence-"));
  const snapshotRoot = path.join(fixtureRoot, "snapshot");
  fs.mkdirSync(snapshotRoot);
  fs.writeFileSync(path.join(fixtureRoot, "secret.ts"), "do-not-expose");

  try {
    const normalized = normalizeMantisFinding({
      id: "escape-attempt",
      title: "Unsafe evidence locator",
      severity: "HIGH",
      status: "VALID",
      code_paths: ["../secret.ts:1"],
    }, snapshotRoot) as { codeEvidence: Array<{ code: string | null }> };

    assert.equal(normalized.codeEvidence[0]?.code, null);
    assert.equal(JSON.stringify(normalized).includes("do-not-expose"), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("VulnHunter normalization hydrates Inspector evidence without claiming runtime proof", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-normalize-"));
  const outputDir = path.join(fixtureRoot, "output");
  const resultsDir = path.join(outputDir, "vulnhunter", "results");
  const snapshotDir = path.join(outputDir, "vulnhunter-snapshot", "src");
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(
    path.join(snapshotDir, "login.ts"),
    [
      "export async function login(req) {",
      "  const email = req.body.email;",
      "  const sql = `SELECT * FROM users WHERE email = '${email}'`;",
      "  return db.query(sql);",
      "}",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(fixtureRoot, "secret.ts"), "do-not-expose");
  fs.writeFileSync(
    path.join(resultsDir, "sentinel-findings.json"),
    JSON.stringify({
      schemaVersion: 1,
      findings: [{
        id: "VULN-001",
        title: "Login query accepts attacker-controlled SQL",
        severity: "High",
        confidence: "high",
        cwe: ["CWE-89"],
        summary: "The public login route interpolates an attacker-controlled email into SQL.",
        rootCause: "The query is assembled with string interpolation instead of parameters.",
        entryPoint: "POST /login",
        dataFlow: "req.body.email → template literal → db.query",
        impact: "An unauthenticated attacker can alter the login query.",
        remediation: "Use a parameterized query.",
        severityRationale: "The route is unauthenticated and reaches a database query.",
        validation: {
          summary: "Static falsification found no sanitizer or parameter binding.",
          limitations: ["The database dialect is unavailable in the snapshot."],
        },
        evidence: [
          {
            path: "src/login.ts",
            startLine: 2,
            endLine: 2,
            role: "source",
            explanation: "The request body controls email.",
          },
          {
            path: "src/login.ts",
            startLine: 4,
            endLine: 4,
            role: "sink",
            explanation: "The interpolated query reaches db.query.",
          },
          {
            path: "../secret.ts",
            startLine: 1,
            endLine: 1,
            role: "evidence",
            explanation: "This locator must stay confined to the snapshot.",
          },
        ],
      }],
    }),
  );

  try {
    const modulePath = `./scanners/${"vulnhunter-normalize"}.js`;
    let normalizer: {
      normalizeVulnHunterWorkspace(resultsDir: string, outputDir: string): number;
    };
    try {
      normalizer = await import(modulePath) as typeof normalizer;
    } catch (error) {
      assert.fail(`VulnHunter normalizer is missing: ${String(error)}`);
    }

    assert.equal(normalizer.normalizeVulnHunterWorkspace(resultsDir, outputDir), 1);
    const payload = JSON.parse(
      fs.readFileSync(path.join(outputDir, "findings.json"), "utf8"),
    ) as { engine: string; findings: Array<Record<string, unknown>> };
    const finding = payload.findings[0] as {
      findingId: string;
      severity: { level: string };
      confidence: { level: string; rationale: string };
      ruleId: string;
      rootCause: { summary: string };
      validation: { summary: string; method: string; limitations: string[] };
      codeEvidence: Array<{ role: string; code: string | null; explanation: string }>;
      attackPath: { evidenceRefs: string[]; dataflow: { summary: string; outcome: string } };
      fingerprints: { primary: string };
    };
    assert.equal(payload.engine, "vulnhunter");
    assert.equal(finding.findingId, "vulnhunter-VULN-001");
    assert.equal(finding.severity.level, "high");
    assert.equal(finding.confidence.level, "high");
    assert.match(finding.confidence.rationale, /static/i);
    assert.equal(finding.ruleId, "vulnhunter/CWE-89");
    assert.equal(
      finding.rootCause.summary,
      "The query is assembled with string interpolation instead of parameters.",
    );
    assert.equal(finding.validation.summary, "Static falsification found no sanitizer or parameter binding.");
    assert.match(finding.validation.method, /read-only static/i);
    assert.deepEqual(finding.validation.limitations, [
      "The database dialect is unavailable in the snapshot.",
      "No exploit payload, PoC code, or exploit test was generated or executed by Sentinel's read-only Codex port.",
    ]);
    assert.equal(finding.codeEvidence[0]?.role, "source");
    assert.equal(finding.codeEvidence[0]?.code, "  const email = req.body.email;");
    assert.equal(finding.codeEvidence[1]?.role, "sink");
    assert.equal(finding.codeEvidence[1]?.code, "  return db.query(sql);");
    assert.equal(finding.codeEvidence.length, 2);
    assert.equal(JSON.stringify(finding).includes("do-not-expose"), false);
    assert.deepEqual(finding.attackPath.evidenceRefs, ["evidence-1", "evidence-2"]);
    assert.equal(finding.attackPath.dataflow.summary, "req.body.email → template literal → db.query");
    assert.equal(finding.attackPath.dataflow.outcome, "An unauthenticated attacker can alter the login query.");
    assert.match(finding.fingerprints.primary, /^capitalone-vulnhunter\/v1:sha256:[a-f0-9]{64}$/);
    const inspector = readFindingsFile(outputDir)[0];
    assert.equal(inspector?.primaryPath, "src/login.ts");
    assert.equal(inspector?.codeEvidence.length, 2);
    assert.equal(inspector?.attackPathModel?.lanes[0]?.nodes.some((node) => node.kind === "sink"), true);
    const stableFingerprint = finding.fingerprints.primary;
    const handoffPath = path.join(resultsDir, "sentinel-findings.json");
    const reworded = JSON.parse(fs.readFileSync(handoffPath, "utf8")) as {
      findings: Array<{ title: string; rootCause: string }>;
    };
    reworded.findings[0]!.title = "Same sink with different generated wording";
    reworded.findings[0]!.rootCause = "Equivalent explanation with different prose.";
    fs.writeFileSync(handoffPath, JSON.stringify(reworded));
    normalizer.normalizeVulnHunterWorkspace(resultsDir, outputDir);
    const rerun = JSON.parse(fs.readFileSync(path.join(outputDir, "findings.json"), "utf8")) as {
      findings: Array<{ fingerprints: { primary: string } }>;
    };
    assert.equal(rerun.findings[0]?.fingerprints.primary, stableFingerprint);
    fs.writeFileSync(handoffPath, JSON.stringify({ schemaVersion: 1, findings: "invalid" }));
    assert.throws(
      () => normalizer.normalizeVulnHunterWorkspace(resultsDir, outputDir),
      /does not match schemaVersion 1/,
    );
    fs.writeFileSync(handoffPath, JSON.stringify({
      schemaVersion: 1,
      findings: [{ id: "VULN-001", title: "Missing evidence", severity: "High", evidence: [] }],
    }));
    assert.throws(
      () => normalizer.normalizeVulnHunterWorkspace(resultsDir, outputDir),
      /has no confined line-level evidence/,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("VulnHunter progress reports stage and liveness instead of a fabricated percentage", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-progress-"));
  const staleAt = "2026-08-10T18:00:00.000Z";
  const recentAt = new Date("2026-08-10T18:09:55.000Z");
  const now = Date.parse("2026-08-10T18:10:00.000Z");

  try {
    const modulePath = `./scanners/${"vulnhunter-runtime"}.js`;
    const runtimeModule = await import(modulePath) as {
      writeVulnHunterRuntime(scanDir: string, state: Record<string, unknown>): void;
      readVulnHunterRuntime(scanDir: string): Record<string, unknown> | null;
      latestVulnHunterActivityAt(scanDir: string, state: Record<string, unknown>): string;
      vulnhunterRuntimeProgress(
        state: Record<string, unknown>,
        lastActivityAt: string,
        nowMs: number,
      ): ScanProgress;
    };
    const state = {
      engine: "vulnhunter",
      status: "running",
      stage: "hunt",
      stageLabel: "Parallel hunt",
      percent: 24,
      detail: "Trace agents are reviewing partitions",
      startedAt: staleAt,
      updatedAt: staleAt,
      completedAt: null,
      snapshotId: "content:abc",
      sourceRef: "a".repeat(40),
      findings: 0,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      error: null,
    };
    runtimeModule.writeVulnHunterRuntime(fixtureRoot, state);
    const logsDir = path.join(fixtureRoot, "vulnhunter-logs");
    fs.mkdirSync(logsDir);
    const logPath = path.join(logsDir, "scan.jsonl");
    fs.writeFileSync(logPath, '{"type":"item.completed"}\n');
    fs.utimesSync(logPath, recentAt, recentAt);

    const persisted = runtimeModule.readVulnHunterRuntime(fixtureRoot);
    assert.equal(persisted?.stage, "hunt");
    const lastActivityAt = runtimeModule.latestVulnHunterActivityAt(fixtureRoot, state);
    const progress = runtimeModule.vulnhunterRuntimeProgress(state, lastActivityAt, now);
    assert.equal(progress.indeterminate, true);
    assert.equal(progress.phase, "discovery");
    assert.equal(progress.currentItem, 2);
    assert.equal(progress.itemsCompleted, 1);
    assert.equal(progress.itemsTotal, 6);
    assert.equal(progress.activityState, "active");
    assert.match(progressEventMessage(progress), /stage 2\/6/);
    assert.doesNotMatch(progressEventMessage(progress), /24%/);
  } catch (error) {
    assert.fail(`VulnHunter runtime telemetry is missing: ${String(error)}`);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("public scan progress reads VulnHunter artifact-backed runtime telemetry", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-progress-"));
  const now = new Date().toISOString();
  try {
    writeVulnHunterRuntime(fixtureRoot, {
      engine: "vulnhunter",
      status: "running",
      stage: "verify",
      stageLabel: "Candidate verification",
      percent: 45,
      detail: "falsifying candidate traces",
      startedAt: now,
      updatedAt: now,
      lastActivityAt: now,
      completedAt: null,
      snapshotId: "content:abc",
      sourceRef: "a".repeat(40),
      findings: 2,
      usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 },
      error: null,
    });

    const progress = progressForStatus("running", fixtureRoot, "standard", now);
    assert.equal(progress?.phase, "validation");
    assert.equal(progress?.phaseLabel, "Candidate verification");
    assert.equal(progress?.indeterminate, true);
    assert.equal(progress?.currentItem, 3);
    assert.equal(progress?.itemsTotal, 6);
    assert.equal(progress?.reportableFindings, 2);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("VulnHunter kickoff uses a local static methodology profile on an immutable snapshot", async () => {
  const runtimeModule = await import(`./scanners/${"vulnhunter-runtime"}.js`) as {
    VULNHUNTER_CODEX_ISOLATION_ARGS: readonly string[];
    buildVulnHunterPrompt?: (input: Record<string, unknown>) => string;
  };
  assert.deepEqual(runtimeModule.VULNHUNTER_CODEX_ISOLATION_ARGS, [
    "--disable", "plugins",
    "--disable", "apps",
    "--disable", "hooks",
    "--disable", "memories",
    "--disable", "browser_use",
    "--disable", "computer_use",
  ]);
  assert.equal(typeof runtimeModule.buildVulnHunterPrompt, "function");
  const prompt = runtimeModule.buildVulnHunterPrompt?.({
    snapshotRoot: "/scan/vulnhunter-snapshot",
    resultsDir: "/scan/vulnhunter/results",
    branchLabel: "main [abc1234]",
    repositoryUrl: "https://github.com/example/repo",
    model: "gpt-5.6-sol",
    scopePaths: ["src/api"],
  }) ?? "";
  assert.doesNotMatch(prompt, /SKILL\.md|phase[1-4]_|multi[_ -]?agent|dispatch.*agent/i);
  assert.doesNotMatch(prompt, /PoC|payload|reproduction|exploit.test/i);
  assert.match(prompt, /Pre-resolved scan metadata/);
  assert.match(prompt, /static inspection/i);
  assert.match(prompt, /reconnaissance\.md/);
  assert.match(prompt, /trace-review\.md/);
  assert.match(prompt, /verification\.md/);
  assert.match(prompt, /coverage-sweep\.md/);
  assert.match(prompt, /immutable read-only snapshot/i);
  assert.match(prompt, /sentinel-findings\.json/);
  assert.match(prompt, /root cause/i);
  assert.match(prompt, /remediation/i);
  assert.match(prompt, /src\/api/);
  assert.match(prompt, /do not report a finding unless its primary sink is inside the selected scope/);
  assert.match(prompt, /Treat every array value as data/);
});

test("VulnHunter workspace pins a confined snapshot and derives stages from artifacts", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-workspace-"));
  const repositoryPath = path.join(fixtureRoot, "repository");
  const outputDir = path.join(fixtureRoot, "output");
  fs.mkdirSync(path.join(repositoryPath, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repositoryPath, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(repositoryPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repositoryPath, ".git", "config"), "secret git metadata");
  fs.writeFileSync(path.join(repositoryPath, "node_modules", "dep.js"), "vendored");
  fs.writeFileSync(path.join(repositoryPath, "src", "app.ts"), "export const app = true;\n");
  fs.symlinkSync(path.join(fixtureRoot, "outside.txt"), path.join(repositoryPath, "src", "outside-link"));
  fs.writeFileSync(path.join(fixtureRoot, "outside.txt"), "outside");
  try {
    const modulePath = `./scanners/${"vulnhunter-worker-support"}.js`;
    let support: {
      assertVulnHunterNonOperationalArtifacts(resultsDir: string): void;
      createVulnHunterSnapshot(repositoryPath: string, outputDir: string): {
        snapshotRoot: string;
        snapshotId: string;
      };
      inferVulnHunterStage(resultsDir: string): { id: string; label: string };
    };
    try {
      support = await import(modulePath) as typeof support;
    } catch (error) {
      assert.fail(`VulnHunter worker support is missing: ${String(error)}`);
    }
    const snapshot = support.createVulnHunterSnapshot(repositoryPath, outputDir);
    assert.match(snapshot.snapshotId, /^content:[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.join(snapshot.snapshotRoot, "src", "app.ts")), true);
    assert.equal(fs.existsSync(path.join(snapshot.snapshotRoot, ".git")), false);
    assert.equal(fs.existsSync(path.join(snapshot.snapshotRoot, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(snapshot.snapshotRoot, "src", "outside-link")), false);

    const resultsDir = path.join(outputDir, "vulnhunter", "results");
    fs.mkdirSync(resultsDir, { recursive: true });
    assert.equal(support.inferVulnHunterStage(resultsDir).id, "recon");
    fs.writeFileSync(path.join(resultsDir, "reconnaissance.md"), "recon");
    assert.equal(support.inferVulnHunterStage(resultsDir).id, "hunt");
    fs.writeFileSync(path.join(resultsDir, "trace-review.md"), "candidate");
    assert.equal(support.inferVulnHunterStage(resultsDir).id, "verify");
    fs.writeFileSync(path.join(resultsDir, "verification.md"), "verified");
    assert.equal(support.inferVulnHunterStage(resultsDir).id, "validation-notes");
    fs.writeFileSync(path.join(resultsDir, "validation-notes.md"), "static evidence only");
    assert.equal(support.inferVulnHunterStage(resultsDir).id, "sweep");
    fs.writeFileSync(path.join(resultsDir, "coverage-sweep.md"), "sweep");
    assert.equal(support.inferVulnHunterStage(resultsDir).id, "report");
    fs.writeFileSync(path.join(resultsDir, "README.md"), "Defensive report.");
    fs.writeFileSync(path.join(resultsDir, "sentinel-findings.json"), '{"schemaVersion":1,"findings":[]}');
    assert.doesNotThrow(() => support.assertVulnHunterNonOperationalArtifacts(resultsDir));
    fs.writeFileSync(path.join(resultsDir, "validation.sh"), "echo unsafe");
    assert.throws(
      () => support.assertVulnHunterNonOperationalArtifacts(resultsDir),
      /rejected operational artifact/,
    );
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

test("Mantis reconciliation preserves cache-write usage from a legacy reported runtime", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mantis-cost-"));
  const startedAt = "2026-08-10T10:00:00.000Z";
  try {
    writeMantisRuntime(fixtureRoot, {
      engine: "mantis",
      status: "completed",
      stage: "report",
      stageLabel: "Evidence report",
      percent: 100,
      detail: null,
      startedAt,
      updatedAt: "2026-08-10T10:01:00.000Z",
      completedAt: "2026-08-10T10:01:00.000Z",
      snapshotId: "content:abc",
      sourceRef: "a".repeat(40),
      findings: 0,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 60,
        cacheWriteInputTokens: 15,
        outputTokens: 10,
      },
      error: null,
    });
    const refreshed = refreshMantisRunFromDisk({
      id: "mantis-cost",
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
    });

    assert.equal(refreshed.cost?.cacheWriteInputTokens, 15);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Mantis reconciliation leaves an unreported zero usage runtime without a cost", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mantis-cost-"));
  const startedAt = "2026-08-10T10:00:00.000Z";
  try {
    writeMantisRuntime(fixtureRoot, {
      engine: "mantis",
      status: "failed",
      stage: "architecture",
      stageLabel: "Architecture",
      percent: 10,
      detail: null,
      startedAt,
      updatedAt: "2026-08-10T10:01:00.000Z",
      completedAt: "2026-08-10T10:01:00.000Z",
      snapshotId: "content:abc",
      sourceRef: "a".repeat(40),
      findings: 0,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      error: "provider stopped before usage was reported",
    });
    const refreshed = refreshMantisRunFromDisk({
      id: "mantis-no-usage",
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
    });

    assert.equal(refreshed.cost, null);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("failed VulnHunter runs preserve normalized findings as incomplete evidence", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-partial-"));
  const startedAt = "2026-08-10T18:00:00.000Z";
  fs.writeFileSync(
    path.join(fixtureRoot, "findings.json"),
    JSON.stringify({ findings: [{ severity: { level: "high" } }] }),
  );
  const runtimeModule = await import(`./scanners/${"vulnhunter-runtime"}.js`) as {
    writeVulnHunterRuntime(scanDir: string, state: Record<string, unknown>): void;
  };
  runtimeModule.writeVulnHunterRuntime(fixtureRoot, {
    engine: "vulnhunter",
    status: "failed",
    stage: "verify",
    stageLabel: "Adversarial verification",
    percent: 52,
    detail: "verification session failed",
    startedAt,
    updatedAt: "2026-08-10T18:05:00.000Z",
    completedAt: "2026-08-10T18:05:00.000Z",
    snapshotId: "content:def",
    sourceRef: "b".repeat(40),
    findings: 1,
    usage: { inputTokens: 120, cachedInputTokens: 80, outputTokens: 30 },
    error: "verification session failed",
  });
  const run: ScanRun = {
    id: "vulnhunter-partial",
    displayName: "fixture",
    repositoryPath: fixtureRoot,
    revision: null,
    scanDir: fixtureRoot,
    status: "running",
    model: "gpt-5.6-sol",
    effort: "high",
    mode: "standard",
    engine: "vulnhunter",
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
    const modulePath = `./scanners/${"vulnhunter-reconcile"}.js`;
    let reconciler: { refreshVulnHunterRunFromDisk(run: ScanRun): ScanRun };
    try {
      reconciler = await import(modulePath) as typeof reconciler;
    } catch (error) {
      assert.fail(`VulnHunter reconciler is missing: ${String(error)}`);
    }
    const refreshed = reconciler.refreshVulnHunterRunFromDisk(run);
    assert.equal(refreshed.status, "incomplete");
    assert.equal(refreshed.severity.high, 1);
    assert.equal(refreshed.cost?.inputTokens, 120);
    assert.equal(refreshed.cost?.cachedInputTokens, 80);
    assert.equal(refreshed.cost?.outputTokens, 30);
    assert.equal(refreshed.revision, "content:def");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("VulnHunter reconciliation preserves cache-write usage from a legacy reported runtime", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-cost-"));
  const startedAt = "2026-08-10T18:00:00.000Z";
  try {
    writeVulnHunterRuntime(fixtureRoot, {
      engine: "vulnhunter",
      status: "completed",
      stage: "report",
      stageLabel: "Evidence report",
      percent: 100,
      detail: null,
      startedAt,
      updatedAt: "2026-08-10T18:01:00.000Z",
      completedAt: "2026-08-10T18:01:00.000Z",
      snapshotId: "content:def",
      sourceRef: "b".repeat(40),
      findings: 0,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 60,
        cacheWriteInputTokens: 15,
        outputTokens: 10,
      },
      error: null,
    });
    const refreshed = refreshVulnHunterRunFromDisk({
      id: "vulnhunter-cost",
      displayName: "fixture",
      repositoryPath: fixtureRoot,
      revision: null,
      scanDir: fixtureRoot,
      status: "running",
      model: "gpt-5.6-sol",
      effort: "high",
      mode: "standard",
      engine: "vulnhunter",
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
    });

    assert.equal(refreshed.cost?.cacheWriteInputTokens, 15);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("VulnHunter reconciliation leaves an unreported zero usage runtime without a cost", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-cost-"));
  const startedAt = "2026-08-10T18:00:00.000Z";
  try {
    writeVulnHunterRuntime(fixtureRoot, {
      engine: "vulnhunter",
      status: "failed",
      stage: "recon",
      stageLabel: "Repository reconnaissance",
      percent: 8,
      detail: null,
      startedAt,
      updatedAt: "2026-08-10T18:01:00.000Z",
      completedAt: "2026-08-10T18:01:00.000Z",
      snapshotId: "content:def",
      sourceRef: "b".repeat(40),
      findings: 0,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      error: "provider stopped before usage was reported",
    });
    const refreshed = refreshVulnHunterRunFromDisk({
      id: "vulnhunter-no-usage",
      displayName: "fixture",
      repositoryPath: fixtureRoot,
      revision: null,
      scanDir: fixtureRoot,
      status: "running",
      model: "gpt-5.6-sol",
      effort: "high",
      mode: "standard",
      engine: "vulnhunter",
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
    });

    assert.equal(refreshed.cost, null);
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

test("Mantis progress uses real Codex log activity instead of presenting a frozen percentage", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mantis-activity-"));
  const staleAt = "2026-08-10T15:05:56.000Z";
  const recentAt = new Date();

  try {
    writeMantisRuntime(fixtureRoot, {
      engine: "mantis",
      status: "running",
      stage: "architecture",
      stageLabel: "Architecture",
      percent: 10,
      detail: "running mantis-architecture",
      startedAt: staleAt,
      updatedAt: staleAt,
      completedAt: null,
      snapshotId: "content:abc",
      sourceRef: "a".repeat(40),
      findings: 0,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      error: null,
    });
    const logsDir = path.join(fixtureRoot, "mantis-logs");
    fs.mkdirSync(logsDir);
    const stageLog = path.join(logsDir, "architecture.jsonl");
    fs.writeFileSync(stageLog, '{"type":"item.completed"}\n');
    fs.utimesSync(stageLog, recentAt, recentAt);

    const progress = progressForStatus(
      "running",
      fixtureRoot,
      "standard",
      staleAt,
    );

    assert.equal(progress?.indeterminate, true);
    assert.equal(progress?.currentItem, 1);
    assert.equal(progress?.itemsCompleted, 0);
    assert.equal(progress?.itemsTotal, 9);
    assert.equal(progress?.activityState, "active");
    assert.ok(progress?.lastActivityAt);
    assert.ok(Math.abs(Date.parse(progress!.lastActivityAt!) - recentAt.getTime()) < 1_000);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Mantis heartbeat descriptions expose useful activity without leaking command contents", () => {
  const summary = summarizeMantisEvent({
    type: "item.completed",
    item: {
      id: "item_33",
      type: "command_execution",
      command: "cat /private/secret.txt",
    },
  });

  assert.equal(summary, "Command execution completed");
  assert.doesNotMatch(summary ?? "", /secret|private|cat/i);
});

test("Mantis telemetry survives a closed parent stdout pipe", () => {
  class BrokenOutput extends EventEmitter {
    writes = 0;
    write(): boolean {
      this.writes += 1;
      const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      this.emit("error", error);
      return false;
    }
  }

  const output = new BrokenOutput();
  const writeLine = createResilientLineWriter(output);

  assert.doesNotThrow(() => writeLine("first heartbeat"));
  assert.doesNotThrow(() => writeLine("second heartbeat"));
  assert.equal(output.writes, 1);
});

test("Mantis progress events describe stages without repeating the internal percentage", () => {
  const progress: ScanProgress = {
    percent: 10,
    phase: "threat_model",
    phaseLabel: "Architecture",
    detail: "Command execution completed",
    unit: "stages",
    itemsCompleted: 0,
    itemsTotal: 9,
    currentItem: 1,
    indeterminate: true,
  };
  const message = progressEventMessage(progress);

  assert.equal(
    message,
    "Architecture · Command execution completed (stage 1/9)",
  );
  assert.doesNotMatch(message, /10%/);
});

test("internal Sentinel progress markers are not presented as operator log lines", () => {
  assert.equal(
    isInternalProgressMarker(
      '[stdout] SENTINEL_PROGRESS {"percent":10,"stage":"architecture"}',
    ),
    true,
  );
  assert.equal(
    isInternalProgressMarker("[mantis/architecture] Command execution completed"),
    false,
  );
});

test("Mantis Codex sessions disable unrelated user plugins", () => {
  assert.deepEqual(MANTIS_CODEX_ISOLATION_ARGS, ["--disable", "plugins"]);
});
