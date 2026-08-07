import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildGateArtifact,
  buildOperationalErrorArtifact,
  evaluateGate,
  parseGateArtifact,
  type BuildGateArtifactInput,
  type BuildOperationalErrorArtifactInput,
  type EvaluateGateInput,
  type EvaluateGateResult,
} from "@csb/gate-core";
import {
  readGuardrailExceptions,
  readGuardrailPolicy,
  resolveChangeSet,
  type ResolveChangeSetInput,
} from "@csb/gate-runtime";
import type {
  FindingSummary,
  FindingTriage,
  GateArtifact,
  GateRun,
  GuardrailException,
  GuardrailPolicy,
  GuardrailRepository,
  ScanRun,
  StartScanRequest,
} from "@csb/shared";
import { nanoid } from "nanoid";

import { GATES_DIR } from "./config.js";
import {
  getFindingTriage,
  getRepositoryBaseline,
  getRun,
  listRuns,
} from "./db.js";
import {
  publishGateEvent,
  subscribePersistedGateEvents,
  type GateEventListener,
} from "./gate-events.js";
import {
  appendGateEvent,
  getGateRun,
  insertGateRun,
  listGateEvents,
  listGuardrailRepositories,
  updateGateRun,
  type GateEvent,
  type GateRunUpdate,
} from "./gate-store.js";
import {
  GitHubBaselineProvider,
  type BaselineProvider,
} from "./github-baseline.js";
import { readFindingsFile, toFindingSummaries } from "./ingest.js";
import {
  cancelScan,
  isScanActive,
  startScan,
  waitForScan,
} from "./runner.js";

export interface LocalGateRequest {
  repositoryKey: string;
  baseRef: string;
  headRef: string;
  baselineSource?: "local" | "github";
}

export interface LocalGateDependencies {
  createGateId(): string;
  now(): string;
  getRepository(repositoryKey: string): GuardrailRepository | null;
  insertGateRun(run: GateRun): void;
  updateGateRun(gateId: string, updates: GateRunUpdate): void;
  getGateRun(gateId: string): GateRun | null;
  listGateEvents(gateId: string): GateEvent[];
  appendGateEvent(gateId: string, event: GateEvent): void;
  readPolicy(repositoryPath: string): GuardrailPolicy;
  resolveChangeSet(input: ResolveChangeSetInput): Promise<import("@csb/shared").ChangeSet>;
  startScan(request: StartScanRequest): Promise<ScanRun>;
  waitForScan(scanId: string): Promise<ScanRun>;
  cancelScan(scanId: string): boolean;
  isScanActive(scanId: string): boolean;
  getBaselineScanId(repositoryKey: string): string | null;
  githubBaselineProvider: BaselineProvider;
  getScan(scanId: string): ScanRun | null;
  listScans(): ScanRun[];
  readFindings(scanDir: string): FindingSummary[];
  readTriage(repositoryKey: string): ReadonlyMap<string, FindingTriage>;
  readExceptions(repositoryPath: string): GuardrailException[];
  evaluateGate(input: EvaluateGateInput): EvaluateGateResult;
  buildGateArtifact(input: BuildGateArtifactInput): GateArtifact;
  buildOperationalErrorArtifact(input: BuildOperationalErrorArtifactInput): GateArtifact;
  writeArtifact(gateId: string, artifact: GateArtifact): string;
}

const activeGates = new Map<string, Promise<void>>();
const githubBaselineProvider = new GitHubBaselineProvider();

const productionDeps: LocalGateDependencies = {
  createGateId: () => nanoid(12),
  now: () => new Date().toISOString(),
  getRepository: (repositoryKey) =>
    listGuardrailRepositories().find(
      (repository) => repository.repositoryKey === repositoryKey,
    ) ?? null,
  insertGateRun,
  updateGateRun,
  getGateRun,
  listGateEvents,
  appendGateEvent,
  readPolicy: readGuardrailPolicy,
  resolveChangeSet,
  startScan,
  waitForScan,
  cancelScan,
  isScanActive,
  getBaselineScanId: getRepositoryBaseline,
  githubBaselineProvider,
  getScan: getRun,
  listScans: listRuns,
  readFindings: (scanDir) => toFindingSummaries(readFindingsFile(scanDir)),
  readTriage: getFindingTriage,
  readExceptions: readGuardrailExceptions,
  evaluateGate,
  buildGateArtifact,
  buildOperationalErrorArtifact,
  writeArtifact: writeGateArtifact,
};

export async function startLocalGate(
  request: LocalGateRequest,
  deps: LocalGateDependencies = productionDeps,
): Promise<GateRun> {
  const repository = deps.getRepository(request.repositoryKey);
  if (!repository) throw new Error(`Repositório não configurado: ${request.repositoryKey}`);
  const baselineSource = request.baselineSource ?? "local";
  if (
    baselineSource === "github" &&
    (repository.remoteOwner === null || repository.remoteName === null)
  ) {
    throw new Error("O remoto GitHub não está pronto para fornecer baselines");
  }

  const run: GateRun = {
    id: deps.createGateId(),
    repositoryKey: repository.repositoryKey,
    repositoryPath: repository.repositoryPath,
    source: "local",
    baseRef: request.baseRef,
    headRef: request.headRef,
    pullRequestNumber: null,
    scanId: null,
    status: "queued",
    outcome: null,
    policyVersion: 1,
    baselineCommit: null,
    artifactPath: null,
    error: null,
    startedAt: deps.now(),
    completedAt: null,
    estimatedUsd: 0,
  };
  deps.insertGateRun(run);
  emit(run.id, "status", { gateId: run.id, status: "queued" }, deps);
  launchGate(run.id, deps, false, baselineSource);
  return run;
}

export function cancelGate(
  gateId: string,
  deps: LocalGateDependencies = productionDeps,
): boolean {
  const gate = deps.getGateRun(gateId);
  if (!gate || ["completed", "cancelled", "error"].includes(gate.status)) return false;
  if (gate.scanId !== null) deps.cancelScan(gate.scanId);
  const completedAt = deps.now();
  deps.updateGateRun(gateId, { status: "cancelled", completedAt });
  emit(gateId, "done", { gateId, status: "cancelled", completedAt }, deps);
  return true;
}

export function subscribeGate(
  gateId: string,
  listener: GateEventListener,
  deps: LocalGateDependencies = productionDeps,
): () => void {
  const unsubscribe = subscribePersistedGateEvents(gateId, listener, deps);
  const gate = deps.getGateRun(gateId);
  if (
    gate?.status === "scanning" &&
    gate.scanId !== null &&
    deps.isScanActive(gate.scanId)
  ) {
    launchGate(gateId, deps, true, "local");
  }
  return unsubscribe;
}

export function getGateArtifact(
  gateId: string,
  deps: LocalGateDependencies = productionDeps,
): GateArtifact | null {
  const artifactPath = deps.getGateRun(gateId)?.artifactPath;
  if (!artifactPath || !fs.existsSync(artifactPath)) return null;
  return parseGateArtifact(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
}

export function waitForGate(gateId: string): Promise<void> {
  return activeGates.get(gateId) ?? Promise.resolve();
}

function launchGate(
  gateId: string,
  deps: LocalGateDependencies,
  recoverScan: boolean,
  baselineSource: "local" | "github",
): void {
  if (activeGates.has(gateId)) return;
  const task = runGate(gateId, deps, recoverScan, baselineSource).finally(() => {
    if (activeGates.get(gateId) === task) activeGates.delete(gateId);
  });
  activeGates.set(gateId, task);
}

async function runGate(
  gateId: string,
  deps: LocalGateDependencies,
  recoverScan: boolean,
  baselineSource: "local" | "github",
): Promise<void> {
  const gate = requiredGate(gateId, deps);
  const repository = requiredRepository(gate.repositoryKey, deps);
  let policy: GuardrailPolicy | null = null;
  let changeSet: import("@csb/shared").ChangeSet | null = null;
  let scan: ScanRun | null = null;

  try {
    if (!recoverScan) transition(gateId, "resolving", deps);
    policy = deps.readPolicy(repository.repositoryPath);
    changeSet = await deps.resolveChangeSet({
      repositoryPath: repository.repositoryPath,
      baseRef: gate.baseRef,
      headRef: gate.headRef,
      maxChangedPaths: policy.scope.maxChangedPaths,
      fallback: policy.scope.fallback,
    });

    if (changeSet.files.length === 0) {
      transition(gateId, "evaluating", deps);
      await evaluateAndComplete(
        gateId,
        repository,
        policy,
        changeSet,
        null,
        baselineSource,
        deps,
      );
      return;
    }

    if (recoverScan) {
      const scanId = requiredGate(gateId, deps).scanId;
      if (scanId === null) throw new Error("Gate em recuperação não possui scan vinculado");
      scan = await deps.waitForScan(scanId);
    } else {
      transition(gateId, "scanning", deps);
      scan = await deps.startScan({
        repositoryPath: repository.repositoryPath,
        displayName: repository.displayName,
        model: policy.scan.model,
        effort: policy.scan.effort,
        mode: policy.scan.mode,
        maxCostUsd: policy.scan.maxCostUsd,
        paths: changeSet.scopeMode === "changed" ? changeSet.scanPaths : [],
      });
      deps.updateGateRun(gateId, { scanId: scan.id });
      emit(gateId, "scan", {
        gateId,
        scanId: scan.id,
        status: "scanning",
      }, deps);
      scan = await deps.waitForScan(scan.id);
    }

    if (deps.getGateRun(gateId)?.status === "cancelled") return;
    if (scan.status !== "completed") {
      throw new Error(`Scan finalizou com status ${scan.status}`);
    }
    transition(gateId, "evaluating", deps);
    await evaluateAndComplete(
      gateId,
      repository,
      policy,
      changeSet,
      scan,
      baselineSource,
      deps,
    );
  } catch (error) {
    if (deps.getGateRun(gateId)?.status === "cancelled") return;
    await failGate(
      gateId,
      repository,
      policy,
      changeSet,
      scan,
      baselineSource,
      error,
      deps,
    );
  }
}

async function evaluateAndComplete(
  gateId: string,
  repository: GuardrailRepository,
  policy: GuardrailPolicy,
  changeSet: import("@csb/shared").ChangeSet,
  scan: ScanRun | null,
  baselineSource: "local" | "github",
  deps: LocalGateDependencies,
): Promise<void> {
  const baseline = await resolveBaseline(repository, baselineSource, deps);
  const baselineScanId = baseline.scanId;
  const baselineFindings = baseline.findings;
  const currentFindings = scan === null ? [] : deps.readFindings(scan.scanDir);
  const historicalFindings = deps.listScans()
    .filter((candidate) =>
      candidate.status === "completed" &&
      candidate.id !== scan?.id &&
      candidate.id !== baselineScanId,
    )
    .flatMap((candidate) => deps.readFindings(candidate.scanDir));
  const evaluation = deps.evaluateGate({
    policy,
    branch: changeSet.headRef,
    changeSet,
    currentFindings,
    baselineFindings,
    historicalFindings,
    triageByIdentity: deps.readTriage(repository.repositoryKey),
    exceptions: deps.readExceptions(repository.repositoryPath),
    sourceScanId: scan?.id ?? "no-scan",
    baselineScanId,
    now: deps.now(),
  });
  const baselineCommit = baseline.commit;
  const artifact = deps.buildGateArtifact({
    ...artifactEnvelope(gateId, repository, policy, changeSet, scan, baselineCommit, deps.now()),
    evaluation,
  });
  const artifactPath = deps.writeArtifact(gateId, artifact);
  const completedAt = deps.now();
  const estimatedUsd = scan?.cost?.estimatedUsd ?? 0;
  deps.updateGateRun(gateId, {
    status: "completed",
    outcome: evaluation.decision.outcome,
    baselineCommit,
    artifactPath,
    estimatedUsd,
    completedAt,
  });
  emit(gateId, "decision", {
    gateId,
    status: "completed",
    outcome: evaluation.decision.outcome,
    conclusion: evaluation.decision.githubConclusion,
    artifactAvailable: true,
    estimatedUsd,
  }, deps);
  emit(gateId, "done", {
    gateId,
    status: "completed",
    outcome: evaluation.decision.outcome,
    completedAt,
    artifactAvailable: true,
  }, deps);
}

async function failGate(
  gateId: string,
  repository: GuardrailRepository,
  policy: GuardrailPolicy | null,
  changeSet: import("@csb/shared").ChangeSet | null,
  scan: ScanRun | null,
  baselineSource: "local" | "github",
  error: unknown,
  deps: LocalGateDependencies,
): Promise<void> {
  const completedAt = deps.now();
  const message = error instanceof Error ? error.message : "Falha operacional no gate";
  let artifactPath: string | null = null;
  if (policy !== null && changeSet !== null) {
    const baselineCommit =
      baselineSource === "local"
        ? localBaseline(repository.repositoryKey, deps).commit
        : null;
    const artifact = deps.buildOperationalErrorArtifact({
      ...artifactEnvelope(gateId, repository, policy, changeSet, scan, baselineCommit, completedAt),
      operationalSummary: message,
    });
    artifactPath = deps.writeArtifact(gateId, artifact);
  }
  deps.updateGateRun(gateId, {
    status: "error",
    outcome: "error",
    artifactPath,
    error: message,
    estimatedUsd: scan?.cost?.estimatedUsd ?? 0,
    completedAt,
  });
  emit(gateId, "error", {
    gateId,
    status: "error",
    outcome: "error",
    code: "gate.failed",
    completedAt,
    artifactAvailable: artifactPath !== null,
  }, deps);
}

async function resolveBaseline(
  repository: GuardrailRepository,
  source: "local" | "github",
  deps: LocalGateDependencies,
): Promise<{
  scanId: string | null;
  findings: FindingSummary[] | null;
  commit: string | null;
}> {
  if (source === "local") return localBaseline(repository.repositoryKey, deps);
  if (repository.remoteOwner === null || repository.remoteName === null) {
    throw new Error("O remoto GitHub não está pronto para fornecer baselines");
  }
  const artifact = await deps.githubBaselineProvider.getBaseline({
    repositoryKey: repository.repositoryKey,
    owner: repository.remoteOwner,
    name: repository.remoteName,
    defaultBranch: repository.defaultBranch,
  });
  if (artifact === null) {
    return { scanId: null, findings: null, commit: null };
  }
  return {
    scanId: artifact.scan.id ?? artifact.gateId,
    findings: artifact.findings.filter(
      (finding) => finding.lifecycle !== "fixed",
    ),
    commit: artifact.changeSet.headSha,
  };
}

function localBaseline(
  repositoryKey: string,
  deps: LocalGateDependencies,
): {
  scanId: string | null;
  findings: FindingSummary[] | null;
  commit: string | null;
} {
  const scanId = deps.getBaselineScanId(repositoryKey);
  const scan = scanId === null ? null : deps.getScan(scanId);
  return {
    scanId,
    findings: scan === null ? null : deps.readFindings(scan.scanDir),
    commit: scan?.revision ?? null,
  };
}

function artifactEnvelope(
  gateId: string,
  repository: GuardrailRepository,
  policy: GuardrailPolicy,
  changeSet: import("@csb/shared").ChangeSet,
  scan: ScanRun | null,
  baselineCommit: string | null,
  createdAt: string,
): Omit<BuildGateArtifactInput, "evaluation"> {
  return {
    gateId,
    repository: {
      key: repository.repositoryKey,
      owner: repository.remoteOwner,
      name: repository.remoteName ?? repository.displayName,
      defaultBranch: repository.defaultBranch,
    },
    source: "local",
    changeSet,
    policy,
    scan: {
      id: scan?.id ?? null,
      cost: scan?.cost ?? null,
      status: scan?.status ?? "not_run",
    },
    baselineCommit,
    versions: { gateCore: "0.1.0", scanner: scan?.model ?? null },
    createdAt,
  };
}

function transition(
  gateId: string,
  status: GateRun["status"],
  deps: LocalGateDependencies,
): void {
  deps.updateGateRun(gateId, { status });
  emit(gateId, "status", { gateId, status, phase: status }, deps);
}

function emit(
  gateId: string,
  type: Parameters<typeof publishGateEvent>[1],
  payload: Parameters<typeof publishGateEvent>[2],
  deps: LocalGateDependencies,
): void {
  publishGateEvent(gateId, type, payload, deps.now(), deps);
}

function requiredGate(gateId: string, deps: LocalGateDependencies): GateRun {
  const gate = deps.getGateRun(gateId);
  if (!gate) throw new Error(`Gate não encontrado: ${gateId}`);
  return gate;
}

function requiredRepository(
  repositoryKey: string,
  deps: LocalGateDependencies,
): GuardrailRepository {
  const repository = deps.getRepository(repositoryKey);
  if (!repository) throw new Error(`Repositório não configurado: ${repositoryKey}`);
  return repository;
}

function writeGateArtifact(gateId: string, artifact: GateArtifact): string {
  const directory = path.join(GATES_DIR, gateId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, "csb-gate-result.json");
  const temporary = path.join(directory, `csb-gate-result.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, destination);
  return destination;
}
