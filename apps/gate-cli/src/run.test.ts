import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  buildGateArtifact,
  defaultGuardrailPolicy,
  evaluateGate,
} from "@csb/gate-core";
import type {
  ChangeSet,
  FindingSummary,
  GateArtifact,
  GateOutcome,
} from "@csb/shared";

import {
  runGateCli,
  type RunGateCliDependencies,
  type RunGateCliOptions,
} from "./run.js";
import { parseArgs } from "./args.js";
import { createScannerAdapter, type SpawnCommand } from "./scanner.js";

function tempOutput(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "csb-gate-cli-")), "result.json");
}

function options(overrides: Partial<RunGateCliOptions> = {}): RunGateCliOptions {
  return {
    repository: "/checkout/repository",
    baseRef: "1111111111111111111111111111111111111111",
    headRef: "2222222222222222222222222222222222222222",
    policy: ".csb/guardrails.json",
    output: tempOutput(),
    repositoryKey: "github.com/okami/example",
    repositoryName: "example",
    defaultBranch: "main",
    owner: "okami",
    baseline: null,
    gateId: "gate-test",
    pullRequest: 42,
    ...overrides,
  };
}

function finding(): FindingSummary {
  return {
    findingId: "finding-1",
    occurrenceId: null,
    title: "Stored XSS",
    severity: "high",
    confidence: "high",
    ruleId: "CWE-79",
    summary: null,
    primaryPath: "src/report.ts:88",
    fingerprints: ["sha256:stable-xss"],
    category: "Stored cross-site scripting",
    cwe: ["CWE-79"],
  };
}

function changeSet(files: ChangeSet["files"] = [{
  status: "modified",
  path: "src/report.ts",
  previousPath: null,
  additions: 1,
  deletions: 0,
}]): ChangeSet {
  return {
    baseRef: "1111111111111111111111111111111111111111",
    headRef: "2222222222222222222222222222222222222222",
    baseSha: "1111111111111111111111111111111111111111",
    headSha: "2222222222222222222222222222222222222222",
    files,
    scanPaths: files.map((file) => file.path),
    scopeMode: "changed",
    fallbackReason: null,
  };
}

function baselineArtifact(withFinding: boolean): GateArtifact {
  const policy = defaultGuardrailPolicy();
  const currentFindings = withFinding ? [finding()] : [];
  const baselineChangeSet = changeSet();
  const evaluation = evaluateGate({
    policy,
    branch: "main",
    changeSet: baselineChangeSet,
    currentFindings,
    baselineFindings: null,
    historicalFindings: [],
    triageByIdentity: new Map(),
    exceptions: [],
    sourceScanId: "scan-baseline",
    baselineScanId: null,
    now: "2026-08-07T00:00:00.000Z",
  });
  return buildGateArtifact({
    gateId: "baseline-gate",
    repository: { key: "github.com/okami/example", owner: "okami", name: "example", defaultBranch: "main" },
    source: "github",
    changeSet: baselineChangeSet,
    policy,
    scan: { id: "scan-baseline", cost: null, status: "completed" },
    baselineCommit: null,
    evaluation,
    versions: { gateCore: "0.1.0", scanner: "test" },
    createdAt: "2026-08-07T00:00:00.000Z",
  });
}

function fakeDeps(input: {
  outcome?: Exclude<GateOutcome, "error">;
  scannerError?: string;
} = {}): Partial<RunGateCliDependencies> {
  const outcome = input.outcome ?? "pass";
  const baseline = outcome === "bootstrap" ? null : baselineArtifact(outcome === "warning");
  return {
    createGateId: () => "gate-test",
    now: () => "2026-08-07T12:00:00.000Z",
    readPolicy: () => defaultGuardrailPolicy(),
    readExceptions: () => [],
    resolveChangeSet: async () => changeSet(outcome === "no_changes" ? [] : undefined),
    readBaseline: () => baseline,
    scanner: {
      run: async () => {
        if (input.scannerError) throw new Error(input.scannerError);
        return {
          scanId: "scan-current",
          scanDir: "/tmp/scan-current",
          status: "completed",
          findings: outcome === "blocked" || outcome === "warning" ? [finding()] : [],
          cost: null,
          scannerVersion: "test",
        };
      },
    },
  };
}

test("writes a blocked artifact and returns exit code 2", async () => {
  const output = tempOutput();
  const result = await runGateCli(options({ output }), fakeDeps({ outcome: "blocked" }));
  assert.equal(result.exitCode, 2);
  const artifact = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(artifact.decision.outcome, "blocked");
  assert.equal(artifact.schemaVersion, 1);
});

test("returns exit code 3 and writes an error artifact when the scanner fails", async () => {
  const output = tempOutput();
  const result = await runGateCli(options({ output }), fakeDeps({ scannerError: "OPENAI_API_KEY ausente" }));
  assert.equal(result.exitCode, 3);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).decision.outcome, "error");
});

test("returns zero for pass, warning, bootstrap and no_changes", async () => {
  for (const outcome of ["pass", "warning", "bootstrap", "no_changes"] as const) {
    const result = await runGateCli(options({ output: tempOutput() }), fakeDeps({ outcome }));
    assert.equal(result.exitCode, 0);
  }
});

test("parses required and optional CLI arguments", () => {
  const parsed = parseArgs([
    "--repository", "/checkout/repository",
    "--base-ref", "1111111111111111111111111111111111111111",
    "--head-ref", "2222222222222222222222222222222222222222",
    "--policy", ".csb/guardrails.json",
    "--output", "csb-gate-result.json",
    "--repository-key", "github.com/okami/example",
    "--repository-name", "example",
    "--default-branch", "main",
    "--owner", "okami",
    "--baseline", "baseline.json",
    "--gate-id", "gate-42",
    "--pull-request", "42",
  ]);

  assert.equal(parsed.pullRequest, 42);
  assert.equal(parsed.owner, "okami");
  assert.equal(parsed.baseline, "baseline.json");
});

test("rejects unknown, missing and non-numeric arguments", () => {
  assert.throws(() => parseArgs(["--unknown", "value"]), /Unknown flag/);
  assert.throws(() => parseArgs(["--repository"]), /Missing value/);
  assert.throws(() => parseArgs([
    "--repository", "/checkout/repository",
    "--base-ref", "1111111111111111111111111111111111111111",
    "--head-ref", "2222222222222222222222222222222222222222",
    "--policy", ".csb/guardrails.json",
    "--output", "csb-gate-result.json",
    "--repository-key", "github.com/okami/example",
    "--repository-name", "example",
    "--default-branch", "main",
    "--pull-request", "not-a-number",
  ]), /pull-request/);
});

test("spawns the scanner with argument arrays and shell disabled", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "csb-scanner-"));
  fs.writeFileSync(path.join(outputDir, "scan-manifest.json"), JSON.stringify({ scan: { id: "scan-42" } }));
  fs.writeFileSync(path.join(outputDir, "findings.json"), JSON.stringify({ findings: [] }));
  const calls: Array<{ command: string; args: readonly string[]; shell: boolean | string | undefined }> = [];
  const spawnCommand: SpawnCommand = (command, args, spawnOptions) => {
    calls.push({ command, args: [...args], shell: spawnOptions.shell });
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ReturnType<SpawnCommand>;
    queueMicrotask(() => emitter.emit("close", 0));
    return child;
  };

  const result = await createScannerAdapter(spawnCommand).run({
    repositoryPath: "/checkout/repository",
    paths: ["src/report.ts"],
    policy: defaultGuardrailPolicy(),
    outputDir,
  });

  const captured = calls[0];
  assert.equal(captured?.command, "npx");
  assert.equal(captured?.shell, false);
  assert.deepEqual(captured?.args.slice(0, 4), ["--yes", "@openai/codex-security", "scan", "/checkout/repository"]);
  assert.deepEqual(captured?.args.slice(-2), ["--path", "src/report.ts"]);
  assert.equal(result.scanId, "scan-42");
});
