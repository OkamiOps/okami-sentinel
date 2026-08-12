import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  buildGateArtifactV2,
  buildScanLineage,
  classifyGateFindings,
  defaultGuardrailPolicy,
} from "@csb/gate-core";
import type {
  ChangeSet,
  FindingSummary,
  GateArtifactV2,
  GateOutcome,
} from "@csb/shared";

import { parseArgs } from "./args.js";
import {
  runGateCli,
  type RunGateCliDependencies,
  type RunGateCliOptions,
} from "./run.js";
import { createScannerAdapter, type SpawnCommand } from "./scanner.js";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);

function tempOutput(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "csb-gate-cli-")), "result.json");
}

function options(overrides: Partial<RunGateCliOptions> = {}): RunGateCliOptions {
  return {
    repository: "/checkout/head",
    policyRoot: "/checkout/policy",
    policy: ".csb/guardrails.json",
    exceptions: ".csb/guardrails-exceptions.json",
    output: tempOutput(),
    repositoryId: "991122",
    repositoryKey: "github:991122",
    repositoryName: "example",
    defaultBranch: "main",
    owner: "okami",
    executor: "github-actions",
    targetKind: "pull_request",
    baseRef: "main",
    headRef: "feature/security",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    policySha: BASE_SHA,
    protectedBranch: "main",
    baseline: "/artifacts/baseline.json",
    baselineState: "available",
    baselineReason: null,
    gateId: "gate-test",
    pullRequest: 42,
    workflowRunId: "778899",
    workflowRunAttempt: 1,
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
  additions: null,
  deletions: null,
}]): ChangeSet {
  return {
    baseRef: "main",
    headRef: "feature/security",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    files,
    scanPaths: files.filter((file) => file.status !== "deleted").map((file) => file.path),
    scopeMode: "changed",
    fallbackReason: null,
  };
}

function comparableBaseline(findings: FindingSummary[]): GateArtifactV2 {
  const policy = defaultGuardrailPolicy();
  const baselineChangeSet: ChangeSet = {
    ...changeSet([]),
    baseRef: "main",
    headRef: "main",
    baseSha: BASE_SHA,
    headSha: BASE_SHA,
  };
  const evaluationInput = {
    policy,
    branch: "main",
    changeSet: baselineChangeSet,
    currentFindings: findings,
    baselineFindings: null,
    baseline: { kind: "absent" as const },
    historicalFindings: [],
    triageByIdentity: new Map(),
    exceptions: [],
    sourceScanId: "scan-baseline",
    baselineScanId: null,
    now: "2026-08-12T12:00:00.000Z",
  };
  return buildGateArtifactV2({
    gateId: "baseline-gate",
    repository: {
      id: "github:991122",
      key: "github:991122",
      owner: "okami",
      name: "example",
      defaultBranch: "main",
      locator: { kind: "github", repositoryId: "991122", owner: "okami", name: "example" },
    },
    source: "github",
    executor: "github-actions",
    target: { kind: "protected_branch", ref: "main" },
    resolvedTarget: {
      baseRef: "main",
      headRef: "main",
      baseSha: BASE_SHA,
      headSha: BASE_SHA,
      policySha: BASE_SHA,
      pullRequestNumber: null,
    },
    policySource: "protected_branch",
    changeSet: baselineChangeSet,
    policy,
    scan: { id: "scan-baseline", cost: null, status: "completed" },
    baselineCommit: null,
    evaluation: {
      deltas: classifyGateFindings(evaluationInput),
      decision: {
        outcome: "bootstrap",
        summary: `Protected baseline initialized with ${findings.length} finding(s).`,
        violations: [],
        warnings: [],
        exceptionsApplied: [],
        githubConclusion: "neutral",
      },
    },
    lineage: actionsLineage(),
    coverage: completeCoverage(),
    snapshot: { identity: hash("baseline"), materializerVersion: "actions-git-index-v1" },
    workflowRun: { id: "111", attempt: 1 },
    versions: { gateCore: "0.2.0", scanner: "test" },
    createdAt: "2026-08-12T12:00:00.000Z",
  });
}

function fakeDeps(input: {
  outcome?: Exclude<GateOutcome, "error">;
  scannerError?: string;
} = {}): Partial<RunGateCliDependencies> {
  const outcome = input.outcome ?? "pass";
  const baselineFindings = outcome === "warning" || outcome === "pass" ? [finding()] : [];
  const currentFindings = outcome === "warning" || outcome === "blocked" || outcome === "bootstrap"
    ? [finding()]
    : [];
  return {
    now: () => "2026-08-12T12:00:00.000Z",
    readPolicy: () => ({
      policy: defaultGuardrailPolicy(),
      exceptions: [],
      source: "base",
    }),
    inspectSnapshots: () => ({
      changeSet: changeSet(outcome === "no_changes" ? [] : undefined),
      coverage: completeCoverage(),
      identity: hash("head"),
    }),
    readBaseline: () => outcome === "bootstrap"
      ? { kind: "absent" }
      : { kind: "artifact", artifact: comparableBaseline(baselineFindings) },
    scanner: {
      run: async () => {
        if (input.scannerError) throw new Error(input.scannerError);
        return {
          scanId: "scan-current",
          scanDir: "/tmp/scan-current",
          status: "completed",
          findings: currentFindings,
          cost: null,
          scannerVersion: "test",
        };
      },
    },
  };
}

test("writes a validated blocked artifact v2 and returns exit code 2", async () => {
  const output = tempOutput();
  const result = await runGateCli(options({ output }), fakeDeps({ outcome: "blocked" }));
  assert.equal(result.exitCode, 2);
  const artifact = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.executor, "github-actions");
  assert.equal(artifact.resolvedTarget.headSha, HEAD_SHA);
  assert.equal(artifact.decision.outcome, "blocked");
  assert.equal(JSON.stringify(artifact).includes("/checkout/"), false);
});

test("returns exit code 3 and writes action_required v2 evidence when the scanner fails", async () => {
  const output = tempOutput();
  const result = await runGateCli(options({ output }), fakeDeps({ scannerError: "scanner_secret_missing" }));
  assert.equal(result.exitCode, 3);
  assert.equal(result.artifact.schemaVersion, 2);
  assert.equal(result.artifact.decision.outcome, "error");
  assert.equal(result.artifact.decision.githubConclusion, "action_required");
});

test("returns zero for pass, warning, bootstrap and no_changes using the shared baseline selector", async () => {
  for (const outcome of ["pass", "warning", "bootstrap", "no_changes"] as const) {
    const baselineState = outcome === "bootstrap" ? "absent" as const : "available" as const;
    const result = await runGateCli(options({
      output: tempOutput(),
      baselineState,
      baseline: baselineState === "available" ? "/artifacts/baseline.json" : null,
    }), fakeDeps({ outcome }));
    assert.equal(result.exitCode, 0, outcome);
    assert.equal(result.artifact.decision.outcome, outcome, outcome);
  }
});

test("reads policy and exceptions only from the frozen base checkout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-actions-policy-authority-"));
  const head = path.join(root, "head");
  const policyRoot = path.join(root, "policy");
  fs.mkdirSync(path.join(head, ".csb"), { recursive: true });
  fs.mkdirSync(path.join(policyRoot, ".csb"), { recursive: true });
  const protectedPolicy = defaultGuardrailPolicy();
  protectedPolicy.scan.maxCostUsd = 7;
  const selfRelaxed = defaultGuardrailPolicy();
  selfRelaxed.scan.maxCostUsd = 999;
  fs.writeFileSync(path.join(policyRoot, ".csb", "guardrails.json"), JSON.stringify(protectedPolicy));
  fs.writeFileSync(path.join(head, ".csb", "guardrails.json"), JSON.stringify(selfRelaxed));

  const result = await runGateCli(options({
    repository: head,
    policyRoot,
    baseline: null,
    baselineState: "absent",
    output: path.join(root, "result.json"),
  }), {
    inspectSnapshots: () => ({ changeSet: changeSet(), coverage: completeCoverage(), identity: hash("head") }),
    readBaseline: () => ({ kind: "absent" }),
    scanner: fakeDeps({ outcome: "bootstrap" }).scanner,
    now: () => "2026-08-12T12:00:00.000Z",
  });

  assert.equal(result.artifact.policy.scan.maxCostUsd, 7);
  assert.notEqual(result.artifact.policy.scan.maxCostUsd, 999);
  assert.equal(result.artifact.policySource, "base");
});

test("parses the frozen v2 CLI identity and rejects ambiguous baseline or target input", () => {
  const argv = [
    "--repository", "/checkout/head",
    "--policy-root", "/checkout/policy",
    "--policy", ".csb/guardrails.json",
    "--exceptions", ".csb/guardrails-exceptions.json",
    "--output", "csb-gate-result.json",
    "--repository-id", "991122",
    "--repository-key", "github:991122",
    "--repository-name", "example",
    "--default-branch", "main",
    "--owner", "okami",
    "--executor", "github-actions",
    "--target-kind", "pull_request",
    "--base-ref", "main",
    "--head-ref", "feature/security",
    "--base-sha", BASE_SHA,
    "--head-sha", HEAD_SHA,
    "--policy-sha", BASE_SHA,
    "--protected-branch", "main",
    "--baseline-state", "available",
    "--baseline", "baseline.json",
    "--gate-id", "gate-42",
    "--pull-request", "42",
    "--workflow-run-id", "778899",
    "--workflow-run-attempt", "2",
  ];
  const parsed = parseArgs(argv);
  assert.equal(parsed.executor, "github-actions");
  assert.equal(parsed.pullRequest, 42);
  assert.equal(parsed.workflowRunAttempt, 2);
  assert.throws(() => parseArgs(argv.filter((value) => value !== "baseline.json")), /Missing value|baseline/);
  assert.throws(() => parseArgs(argv.map((value) => value === "github-actions" ? "sentinel-managed" : value)), /executor/);
  assert.throws(() => parseArgs(argv.map((value) => value === "feature/security" ? "HEAD" : value)), /head-ref/);
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
    repositoryPath: "/checkout/head",
    paths: ["src/report.ts"],
    policy: defaultGuardrailPolicy(),
    outputDir,
  });

  const captured = calls[0];
  assert.equal(captured?.command, "npx");
  assert.equal(captured?.shell, false);
  assert.deepEqual(captured?.args.slice(0, 4), ["--yes", "@openai/codex-security", "scan", "/checkout/head"]);
  assert.deepEqual(captured?.args.slice(-2), ["--path", "src/report.ts"]);
  assert.equal(result.scanId, "scan-42");
});

function actionsLineage() {
  const policy = defaultGuardrailPolicy();
  return buildScanLineage({
    engine: "codex-security",
    engineVersion: "test",
    route: "openai-api",
    protocol: "codex-security-cli",
    provider: "openai",
    model: policy.scan.model,
    reasoningEffort: policy.scan.effort,
    methodology: "openai/codex-security",
    profile: policy.scan.mode,
    recipeHash: hash({
      engine: "codex-security",
      model: policy.scan.model,
      effort: policy.scan.effort,
      mode: policy.scan.mode,
      maxCostUsd: policy.scan.maxCostUsd,
    }),
    sourceRevision: hash({ scannerVersion: "test" }),
  });
}

function completeCoverage() {
  return {
    status: "complete" as const,
    repositoryFileCount: 1,
    inspectedFileCount: 1,
    unexaminedFileCount: 0,
    submodules: [],
    lfsPointers: [],
  };
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
