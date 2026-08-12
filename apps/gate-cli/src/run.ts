import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildGateArtifactV2,
  buildOperationalErrorArtifactV2,
  buildScanLineage,
  classifyGateFindings,
  defaultGuardrailPolicy,
  evaluateGate,
  parseGateArtifact,
  selectGateBaseline,
  type BuildGateArtifactV2Input,
  type BuildOperationalErrorArtifactV2Input,
  type EvaluateGateInput,
  type EvaluateGateResult,
  type GateBaselineCandidate,
  type GateBaselineSelection,
} from "@csb/gate-core";
import {
  readGuardrailExceptionsFile,
  readGuardrailPolicyFile,
} from "@csb/gate-runtime";
import type {
  ChangeSet,
  EffectiveScanLineage,
  FindingSummary,
  GateArtifactV2,
  GateCoverageEnvelope,
  GateFindingDelta,
  GateTarget,
  GuardrailException,
  GuardrailPolicy,
  ResolvedGateTarget,
} from "@csb/shared";

import type { RunGateCliOptions } from "./args.js";
import {
  inspectActionsSnapshots,
  type ActionsSnapshotInspection,
} from "./actions-snapshot.js";
import { defaultScannerAdapter, type ScannerAdapter, type ScannerResult } from "./scanner.js";

export type { RunGateCliOptions } from "./args.js";

const GATE_CORE_VERSION = "0.2.0";
const ACTIONS_MATERIALIZER_VERSION = "actions-git-index-v1";

export interface RunGateCliResult {
  exitCode: 0 | 2 | 3;
  artifact: GateArtifactV2;
  output: string;
}

export interface ActionsPolicyBundle {
  policy: GuardrailPolicy;
  exceptions: GuardrailException[];
  source: GateArtifactV2["policySource"];
}

export interface RunGateCliDependencies {
  now(): string;
  readPolicy(options: RunGateCliOptions): ActionsPolicyBundle;
  inspectSnapshots(options: RunGateCliOptions, policy: GuardrailPolicy): ActionsSnapshotInspection;
  readBaseline(options: RunGateCliOptions): GateBaselineCandidate;
  scanner: ScannerAdapter;
  evaluateGate(input: EvaluateGateInput): EvaluateGateResult;
  buildGateArtifact(input: BuildGateArtifactV2Input): GateArtifactV2;
  buildOperationalErrorArtifact(input: BuildOperationalErrorArtifactV2Input): GateArtifactV2;
  writeArtifact(output: string, artifact: GateArtifactV2): void;
}

const productionDependencies: RunGateCliDependencies = {
  now: () => new Date().toISOString(),
  readPolicy: readPolicyBundle,
  inspectSnapshots: (options, policy) => inspectActionsSnapshots({
    baseRoot: options.policyRoot,
    headRoot: options.repository,
    baseRef: options.baseRef,
    headRef: options.headRef,
    baseSha: options.baseSha,
    headSha: options.headSha,
    policy,
  }),
  readBaseline: readBaselineCandidate,
  scanner: defaultScannerAdapter,
  evaluateGate,
  buildGateArtifact: buildGateArtifactV2,
  buildOperationalErrorArtifact: buildOperationalErrorArtifactV2,
  writeArtifact: writeArtifactAtomically,
};

export async function runGateCli(
  options: RunGateCliOptions,
  overrides: Partial<RunGateCliDependencies> = {},
): Promise<RunGateCliResult> {
  const deps = { ...productionDependencies, ...overrides };
  const target = gateTarget(options);
  const resolvedTarget = resolvedGateTarget(options);
  let policy = defaultGuardrailPolicy();
  let policySource: GateArtifactV2["policySource"] = defaultPolicySource(options);
  let exceptions: GuardrailException[] = [];
  let changeSet = emptyErrorChangeSet(options);
  let coverage = incompleteCoverage();
  let snapshotIdentity = hash({ headSha: options.headSha, state: "uninspected" });
  let lineage = plannedLineage(options, policy, null);
  let baseline: GateBaselineSelection = { kind: "absent" };
  let scan: ScannerResult | null = null;

  try {
    const bundle = deps.readPolicy(options);
    policy = bundle.policy;
    exceptions = bundle.exceptions;
    policySource = bundle.source;
    const inspection = deps.inspectSnapshots(options, policy);
    changeSet = inspection.changeSet;
    coverage = inspection.coverage;
    snapshotIdentity = inspection.identity;

    const establishesProtectedBaseline = options.targetKind === "protected_branch";
    if (changeSet.files.length > 0 || establishesProtectedBaseline) {
      const outputDir = path.join(path.dirname(path.resolve(options.output)), `.csb-scan-${options.gateId}`);
      scan = await deps.scanner.run({
        repositoryPath: path.resolve(options.repository),
        paths: changeSet.scopeMode === "changed" ? changeSet.scanPaths : [],
        policy,
        outputDir,
      });
      if (scan.status !== "completed") throw new Error("managed_scan_failed");
    }
    lineage = plannedLineage(options, policy, scan);

    const baselineCandidate = changeSet.files.length === 0 || establishesProtectedBaseline
      ? { kind: "absent" } as const
      : deps.readBaseline(options);
    baseline = selectGateBaseline({
      repositoryId: repositoryIdentity(options),
      protectedBranch: options.protectedBranch,
      lineage,
      policySchemaVersion: policy.schemaVersion,
      coverage,
    }, baselineCandidate);
    const envelope = artifactEnvelope({
      options,
      target,
      resolvedTarget,
      policy,
      policySource,
      changeSet,
      scan,
      baseline,
      lineage,
      coverage,
      snapshotIdentity,
      createdAt: deps.now(),
    });
    const operational = operationalReason(scan, coverage, baseline);
    const artifact = operational === null
      ? deps.buildGateArtifact({
          ...envelope,
          evaluation: evaluation({
            options,
            policy,
            exceptions,
            changeSet,
            scan,
            baseline,
            now: deps.now(),
          }, deps),
        })
      : deps.buildOperationalErrorArtifact({ ...envelope, operationalSummary: operational });
    const parsed = parseGateArtifact(artifact);
    if (parsed.schemaVersion !== 2 || parsed.executor !== "github-actions") {
      throw new Error("actions_artifact_invalid");
    }
    deps.writeArtifact(options.output, parsed);
    return {
      exitCode: parsed.decision.outcome === "blocked"
        ? 2
        : parsed.decision.outcome === "error" ? 3 : 0,
      artifact: parsed,
      output: options.output,
    };
  } catch (error) {
    const artifact = deps.buildOperationalErrorArtifact({
      ...artifactEnvelope({
        options,
        target,
        resolvedTarget,
        policy,
        policySource,
        changeSet,
        scan,
        baseline,
        lineage,
        coverage,
        snapshotIdentity,
        createdAt: deps.now(),
      }),
      scan: scan === null
        ? { id: null, cost: null, status: "failed" }
        : { id: scan.scanId, cost: scan.cost, status: "failed" },
      operationalSummary: errorMessage(error),
    });
    const parsed = parseGateArtifact(artifact);
    if (parsed.schemaVersion !== 2) throw new Error("actions_artifact_invalid");
    deps.writeArtifact(options.output, parsed);
    return { exitCode: 3, artifact: parsed, output: options.output };
  }
}

function artifactEnvelope(context: {
  options: RunGateCliOptions;
  target: GateTarget;
  resolvedTarget: ResolvedGateTarget;
  policy: GuardrailPolicy;
  policySource: GateArtifactV2["policySource"];
  changeSet: ChangeSet;
  scan: ScannerResult | null;
  baseline: GateBaselineSelection;
  lineage: EffectiveScanLineage;
  coverage: GateCoverageEnvelope;
  snapshotIdentity: string;
  createdAt: string;
}): Omit<BuildGateArtifactV2Input, "evaluation"> {
  const { options } = context;
  return {
    gateId: options.gateId,
    repository: {
      id: repositoryIdentity(options),
      key: options.repositoryKey,
      owner: options.owner,
      name: options.repositoryName,
      defaultBranch: options.defaultBranch,
      locator: {
        kind: "github",
        repositoryId: options.repositoryId,
        owner: options.owner,
        name: options.repositoryName,
      },
    },
    source: "github",
    executor: "github-actions",
    target: context.target,
    resolvedTarget: context.resolvedTarget,
    policySource: context.policySource,
    changeSet: context.changeSet,
    policy: context.policy,
    scan: context.scan === null
      ? { id: null, cost: null, status: "not_run" }
      : { id: context.scan.scanId, cost: context.scan.cost, status: context.scan.status },
    baselineCommit: context.baseline.kind === "comparable"
      ? context.baseline.artifact.changeSet.headSha
      : null,
    lineage: context.lineage,
    coverage: context.coverage,
    snapshot: {
      identity: context.snapshotIdentity,
      materializerVersion: ACTIONS_MATERIALIZER_VERSION,
    },
    workflowRun: {
      id: options.workflowRunId,
      attempt: options.workflowRunAttempt,
    },
    versions: {
      gateCore: GATE_CORE_VERSION,
      scanner: context.scan?.scannerVersion ?? null,
    },
    createdAt: context.createdAt,
  };
}

function evaluation(
  context: {
    options: RunGateCliOptions;
    policy: GuardrailPolicy;
    exceptions: GuardrailException[];
    changeSet: ChangeSet;
    scan: ScannerResult | null;
    baseline: GateBaselineSelection;
    now: string;
  },
  deps: RunGateCliDependencies,
): EvaluateGateResult {
  const baseline = context.baseline.kind === "comparable"
    ? {
        kind: "comparable" as const,
        findings: context.baseline.artifact.findings
          .filter((finding) => finding.lifecycle !== "fixed")
          .map(findingSummary),
        scanId: context.baseline.artifact.scan.id ?? context.baseline.artifact.gateId,
      }
    : { kind: "absent" as const };
  const input: EvaluateGateInput = {
    policy: context.policy,
    branch: context.options.protectedBranch,
    changeSet: context.changeSet,
    currentFindings: context.scan?.findings ?? [],
    baselineFindings: null,
    baseline,
    historicalFindings: [],
    triageByIdentity: new Map(),
    exceptions: context.exceptions,
    sourceScanId: context.scan?.scanId ?? "no-scan",
    baselineScanId: baseline.kind === "comparable" ? baseline.scanId : null,
    now: context.now,
  };
  if (context.options.targetKind !== "protected_branch") return deps.evaluateGate(input);
  return {
    deltas: classifyGateFindings(input),
    decision: {
      outcome: "bootstrap",
      summary: `Protected baseline initialized with ${input.currentFindings.length} finding(s).`,
      violations: [],
      warnings: [],
      exceptionsApplied: [],
      githubConclusion: "neutral",
    },
  };
}

function operationalReason(
  scan: ScannerResult | null,
  coverage: GateCoverageEnvelope,
  baseline: GateBaselineSelection,
): string | null {
  if (scan !== null && scan.status !== "completed") return "managed_scan_failed";
  if (coverage.status !== "complete") return "coverage_incomplete";
  if (baseline.kind === "unavailable") return `baseline_unavailable:${baseline.reason}`;
  if (baseline.kind === "incompatible") return `baseline_incompatible:${baseline.reason}`;
  return null;
}

function readPolicyBundle(options: RunGateCliOptions): ActionsPolicyBundle {
  const policyPath = confinedPath(options.policyRoot, options.policy);
  const exceptionsPath = confinedPath(options.policyRoot, options.exceptions);
  const policyExists = fs.existsSync(policyPath);
  return {
    policy: readGuardrailPolicyFile(policyPath),
    exceptions: readGuardrailExceptionsFile(exceptionsPath),
    source: policyExists ? defaultPolicySource(options) : "default",
  };
}

function readBaselineCandidate(options: RunGateCliOptions): GateBaselineCandidate {
  if (options.baselineState === "absent") return { kind: "absent" };
  if (options.baselineState === "unavailable") {
    return { kind: "unavailable", reason: options.baselineReason ?? "artifact_unavailable" };
  }
  try {
    return {
      kind: "artifact",
      artifact: JSON.parse(readBoundedRegularFile(path.resolve(options.baseline!), 16 * 1024 * 1024)),
    };
  } catch {
    return { kind: "unavailable", reason: "artifact_unreadable" };
  }
}

function confinedPath(rootValue: string, relativeValue: string): string {
  const root = fs.realpathSync(path.resolve(rootValue));
  if (!fs.statSync(root).isDirectory()) throw new Error("policy_source_unavailable");
  const candidate = path.resolve(root, ...relativeValue.split("/"));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("policy_source_unavailable");
  }
  if (fs.existsSync(candidate)) {
    const resolved = fs.realpathSync(candidate);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("policy_source_unavailable");
  }
  return candidate;
}

function readBoundedRegularFile(filePath: string, maxBytes: number): string {
  let descriptor: number | null = null;
  try {
    const before = fs.lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
      throw new Error("actions_artifact_invalid");
    }
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("actions_artifact_invalid");
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function writeArtifactAtomically(output: string, artifact: GateArtifactV2): void {
  const destination = path.resolve(output);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, destination);
}

function gateTarget(options: RunGateCliOptions): GateTarget {
  if (options.targetKind === "pull_request") {
    return { kind: "pull_request", number: options.pullRequest! };
  }
  if (options.targetKind === "protected_branch") {
    return { kind: "protected_branch", ref: options.protectedBranch };
  }
  return { kind: "compare", baseRef: options.baseRef, headRef: options.headRef };
}

function resolvedGateTarget(options: RunGateCliOptions): ResolvedGateTarget {
  return {
    baseRef: options.baseRef,
    headRef: options.headRef,
    baseSha: options.baseSha,
    headSha: options.headSha,
    policySha: options.policySha,
    pullRequestNumber: options.pullRequest,
  };
}

function repositoryIdentity(options: RunGateCliOptions): string {
  return `github:${options.repositoryId}`;
}

function defaultPolicySource(options: RunGateCliOptions): GateArtifactV2["policySource"] {
  return options.targetKind === "protected_branch" ? "protected_branch" : "base";
}

function plannedLineage(
  options: RunGateCliOptions,
  policy: GuardrailPolicy,
  scan: ScannerResult | null,
): EffectiveScanLineage {
  const scannerVersion = scan?.scannerVersion ?? "unreported";
  return buildScanLineage({
    engine: "codex-security",
    engineVersion: scannerVersion,
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
    sourceRevision: hash({ scannerVersion }),
  });
}

function findingSummary(finding: GateFindingDelta): FindingSummary {
  return {
    findingId: finding.findingId,
    occurrenceId: finding.occurrenceId,
    title: finding.title,
    severity: finding.severity,
    confidence: finding.confidence,
    ruleId: finding.ruleId,
    summary: finding.summary,
    primaryPath: finding.primaryPath,
    fingerprints: [...finding.fingerprints],
    category: finding.category,
    cwe: [...finding.cwe],
  };
}

function emptyErrorChangeSet(options: RunGateCliOptions): ChangeSet {
  return {
    baseRef: options.baseRef,
    headRef: options.headRef,
    baseSha: options.baseSha,
    headSha: options.headSha,
    files: [],
    scanPaths: [],
    scopeMode: "changed",
    fallbackReason: null,
  };
}

function incompleteCoverage(): GateCoverageEnvelope {
  return {
    status: "partial",
    repositoryFileCount: 0,
    inspectedFileCount: 0,
    unexaminedFileCount: 0,
    submodules: [],
    lfsPointers: [],
  };
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : "actions_gate_failed";
  return /^[a-z][a-z0-9_:-]{0,200}$/.test(value) ? value : "actions_gate_failed";
}
