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
    scanPaths: [],
    scopeMode: "repository",
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
    coverage: completeCoverage("repository"),
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

test("returns zero for pass, warning and no_changes using the shared baseline selector", async () => {
  for (const outcome of ["pass", "warning", "no_changes"] as const) {
    const baselineState = "available" as const;
    const result = await runGateCli(options({
      output: tempOutput(),
      baselineState,
      baseline: baselineState === "available" ? "/artifacts/baseline.json" : null,
    }), fakeDeps({ outcome }));
    assert.equal(result.exitCode, 0, outcome);
    assert.equal(result.artifact.decision.outcome, outcome, outcome);
  }
});

test("PR and compare without a baseline fail closed instead of publishing a neutral bootstrap", async () => {
  for (const targetKind of ["pull_request", "compare"] as const) {
    const result = await runGateCli(options({ targetKind, pullRequest: targetKind === "compare" ? null : 42,
      baselineState: "absent", baseline: null }), fakeDeps({ outcome: "bootstrap" }));
    assert.equal(result.exitCode, 3);
    assert.equal(result.artifact.decision.outcome, "error");
    assert.equal(result.artifact.decision.githubConclusion, "action_required");
    assert.match(result.artifact.decision.summary, /^baseline_absent:/);
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

test("forces a protected-branch Actions baseline to use the repository scan plan", async () => {
  let inspectedScope: string | null = null;
  const scanPaths: Array<readonly string[]> = [];
  const result = await runGateCli(options({
    targetKind: "protected_branch",
    baseRef: "main",
    headRef: "main",
    baseSha: HEAD_SHA,
    headSha: HEAD_SHA,
    policySha: HEAD_SHA,
    pullRequest: null,
    baseline: null,
    baselineState: "absent",
  }), {
    readPolicy: () => ({ policy: defaultGuardrailPolicy(), exceptions: [], source: "protected_branch" }),
    inspectSnapshots: (_options, policy) => {
      inspectedScope = policy.scope.mode;
      return {
        changeSet: {
          ...changeSet([]),
          baseRef: "main",
          headRef: "main",
          baseSha: HEAD_SHA,
          headSha: HEAD_SHA,
          scanPaths: [],
          scopeMode: "repository",
        },
        coverage: completeCoverage("repository"),
        identity: hash("protected-head"),
      };
    },
    readBaseline: () => ({ kind: "absent" }),
    scanner: {
      run: async (request) => {
        scanPaths.push([...request.paths]);
        return {
          scanId: "scan-protected",
          scanDir: "/tmp/scan-protected",
          status: "completed",
          findings: [],
          cost: null,
          scannerVersion: "test",
        };
      },
    },
    now: () => "2026-08-12T12:00:00.000Z",
  });

  assert.equal(inspectedScope, "repository");
  assert.deepEqual(scanPaths, [[]]);
  assert.equal(result.artifact.changeSet.scopeMode, "repository");
  assert.equal(result.artifact.coverage.scanScope, "repository");
  assert.equal(result.artifact.decision.outcome, "bootstrap");
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

test("spawns the locked scanner binary outside the target checkout with a minimal environment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-scanner-"));
  const repositoryPath = path.join(root, "head");
  const outputDir = path.join(root, "results");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, "scan-manifest.json"), JSON.stringify({
    documentType: "codex-security.scan-manifest",
    schemaVersion: "1.0",
    scan: {
      id: "scan-42",
      status: "completed",
      findingsRef: "findings.json",
      producer: { name: "codex-security-plugin", version: "0.1.29" },
    },
  }));
  fs.writeFileSync(path.join(outputDir, "findings.json"), JSON.stringify({
    documentType: "codex-security.findings",
    schemaVersion: "1.0",
    scanId: "scan-42",
    findings: [],
  }));
  const calls: Array<{
    command: string;
    args: readonly string[];
    cwd: string | undefined;
    env: NodeJS.ProcessEnv | undefined;
    shell: boolean | string | undefined;
  }> = [];
  const spawnCommand: SpawnCommand = (command, args, spawnOptions) => {
    calls.push({
      command,
      args: [...args],
      cwd: typeof spawnOptions.cwd === "string" ? spawnOptions.cwd : undefined,
      env: spawnOptions.env,
      shell: spawnOptions.shell,
    });
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ReturnType<SpawnCommand>;
    queueMicrotask(() => emitter.emit("close", 0));
    return child;
  };

  const result = await createScannerAdapter(spawnCommand).run({
    repositoryPath,
    paths: ["src/report.ts"],
    policy: defaultGuardrailPolicy(),
    outputDir,
  });

  const captured = calls[0];
  assert.equal(captured?.command, process.execPath);
  assert.equal(captured?.shell, false);
  assert.match(captured?.args[0] ?? "", /node_modules[\\/]@openai[\\/]codex-security[\\/]bin[\\/]codex-security\.mjs$/);
  assert.deepEqual(captured?.args.slice(1, 7), ["scan", repositoryPath, "--model", "gpt-5.6-sol", "--effort", "low"]);
  assert.deepEqual(captured?.args.slice(7, 9), ["--mode", "standard"]);
  assert.deepEqual(captured?.args.slice(-2), ["--path", "src/report.ts"]);
  assert.equal(captured?.cwd, fs.realpathSync(path.join(path.dirname(outputDir), ".csb-scanner-runtime")));
  assert.equal(captured?.env?.CI, "1");
  assert.equal(captured?.env?.NO_COLOR, "1");
  assert.equal(captured?.env?.OPENAI_API_KEY, process.env.OPENAI_API_KEY);
  assert.ok(Object.keys(captured?.env ?? {}).every((key) => [
    "CI", "NO_COLOR", "PATH", "HOME", "TMPDIR", "OPENAI_API_KEY",
  ].includes(key)));
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

function completeCoverage(scope: "changed" | "repository" = "changed") {
  return {
    status: "complete" as const,
    repositoryFileCount: 1,
    inspectedFileCount: 1,
    unexaminedFileCount: 0,
    submodules: [],
    lfsPointers: [],
    materializedFileCount: 1,
    unmaterializedFileCount: 0,
    scanScope: scope,
  };
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
