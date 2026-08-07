import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildGateArtifact,
  buildOperationalErrorArtifact,
  defaultGuardrailPolicy,
  evaluateGate,
  parseGateArtifact,
  type BuildGateArtifactInput,
  type BuildOperationalErrorArtifactInput,
  type EvaluateGateInput,
  type EvaluateGateResult,
} from "@csb/gate-core";
import {
  parseGuardrailPolicy,
  readGuardrailExceptions,
  resolveChangeSet,
  type ResolveChangeSetInput,
} from "@csb/gate-runtime";
import type {
  ChangeSet,
  GateArtifact,
  GuardrailException,
  GuardrailPolicy,
} from "@csb/shared";

import type { RunGateCliOptions } from "./args.js";
import { defaultScannerAdapter, type ScannerAdapter, type ScannerResult } from "./scanner.js";

export type { RunGateCliOptions } from "./args.js";

export interface RunGateCliResult {
  exitCode: 0 | 2 | 3;
  artifact: GateArtifact;
  output: string;
}

export interface RunGateCliDependencies {
  createGateId(): string;
  now(): string;
  readPolicy(options: RunGateCliOptions): GuardrailPolicy;
  readExceptions(repositoryPath: string): GuardrailException[];
  resolveChangeSet(input: ResolveChangeSetInput): Promise<ChangeSet>;
  readBaseline(baselinePath: string | null): GateArtifact | null;
  scanner: ScannerAdapter;
  evaluateGate(input: EvaluateGateInput): EvaluateGateResult;
  buildGateArtifact(input: BuildGateArtifactInput): GateArtifact;
  buildOperationalErrorArtifact(input: BuildOperationalErrorArtifactInput): GateArtifact;
  writeArtifact(output: string, artifact: GateArtifact): void;
}

const productionDependencies: RunGateCliDependencies = {
  createGateId: randomUUID,
  now: () => new Date().toISOString(),
  readPolicy: readPolicyFile,
  readExceptions: readGuardrailExceptions,
  resolveChangeSet,
  readBaseline: readBaselineArtifact,
  scanner: defaultScannerAdapter,
  evaluateGate,
  buildGateArtifact,
  buildOperationalErrorArtifact,
  writeArtifact: writeArtifactAtomically,
};

export async function runGateCli(
  options: RunGateCliOptions,
  overrides: Partial<RunGateCliDependencies> = {},
): Promise<RunGateCliResult> {
  const deps = { ...productionDependencies, ...overrides };
  const gateId = options.gateId ?? deps.createGateId();
  let policy = defaultGuardrailPolicy();
  let changeSet = emptyErrorChangeSet(options);
  let baseline: GateArtifact | null = null;
  let scan: ScannerResult | null = null;

  try {
    policy = deps.readPolicy(options);
    changeSet = await deps.resolveChangeSet({
      repositoryPath: options.repository,
      baseRef: options.baseRef,
      headRef: options.headRef,
      maxChangedPaths: policy.scope.maxChangedPaths,
      fallback: policy.scope.fallback,
    });
    baseline = deps.readBaseline(options.baseline);
    const exceptions = deps.readExceptions(options.repository);

    if (changeSet.files.length > 0) {
      const outputDir = path.join(path.dirname(path.resolve(options.output)), `.csb-scan-${gateId}`);
      scan = await deps.scanner.run({
        repositoryPath: options.repository,
        paths: changeSet.scopeMode === "changed" ? changeSet.scanPaths : [],
        policy,
        outputDir,
      });
      if (scan.status !== "completed") throw new Error("Security scanner did not complete");
    }

    const evaluation = deps.evaluateGate({
      policy,
      branch: options.defaultBranch,
      changeSet,
      currentFindings: scan?.findings ?? [],
      baselineFindings: baseline?.findings ?? null,
      historicalFindings: [],
      triageByIdentity: new Map(),
      exceptions,
      sourceScanId: scan?.scanId ?? "no-scan",
      baselineScanId: baseline?.scan.id ?? null,
      now: deps.now(),
    });
    const artifact = deps.buildGateArtifact({
      ...artifactEnvelope(options, gateId, policy, changeSet, scan, baseline, deps.now()),
      evaluation,
    });
    deps.writeArtifact(options.output, artifact);
    return {
      exitCode: artifact.decision.outcome === "blocked" ? 2 : 0,
      artifact,
      output: options.output,
    };
  } catch (error) {
    const failedScan = scan === null
      ? { id: null, cost: null, status: "failed" }
      : { id: scan.scanId, cost: scan.cost, status: "failed" };
    const artifact = deps.buildOperationalErrorArtifact({
      ...artifactEnvelope(options, gateId, policy, changeSet, null, baseline, deps.now()),
      scan: failedScan,
      versions: { gateCore: "0.1.0", scanner: scan?.scannerVersion ?? null },
      operationalSummary: errorMessage(error),
    });
    deps.writeArtifact(options.output, artifact);
    return { exitCode: 3, artifact, output: options.output };
  }
}

function artifactEnvelope(
  options: RunGateCliOptions,
  gateId: string,
  policy: GuardrailPolicy,
  changeSet: ChangeSet,
  scan: ScannerResult | null,
  baseline: GateArtifact | null,
  createdAt: string,
): Omit<BuildGateArtifactInput, "evaluation"> {
  return {
    gateId,
    repository: {
      key: options.repositoryKey,
      owner: options.owner,
      name: options.repositoryName,
      defaultBranch: options.defaultBranch,
    },
    source: "github",
    changeSet,
    policy,
    scan: scan === null
      ? { id: null, cost: null, status: "not_run" }
      : { id: scan.scanId, cost: scan.cost, status: scan.status },
    baselineCommit: baseline?.changeSet.headSha ?? null,
    versions: { gateCore: "0.1.0", scanner: scan?.scannerVersion ?? null },
    createdAt,
  };
}

function readPolicyFile(options: RunGateCliOptions): GuardrailPolicy {
  const policyPath = path.isAbsolute(options.policy)
    ? options.policy
    : path.join(options.repository, options.policy);
  return parseGuardrailPolicy(JSON.parse(fs.readFileSync(policyPath, "utf8")));
}

function readBaselineArtifact(baselinePath: string | null): GateArtifact | null {
  if (baselinePath === null) return null;
  return parseGateArtifact(JSON.parse(fs.readFileSync(baselinePath, "utf8")));
}

function writeArtifactAtomically(output: string, artifact: GateArtifact): void {
  const destination = path.resolve(output);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, destination);
}

function emptyErrorChangeSet(options: RunGateCliOptions): ChangeSet {
  return {
    baseRef: options.baseRef,
    headRef: options.headRef,
    baseSha: options.baseRef,
    headSha: options.headRef,
    files: [],
    scanPaths: [],
    scopeMode: "changed",
    fallbackReason: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Security gate failed operationally";
}
