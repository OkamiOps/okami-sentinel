import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildGateArtifact,
  buildOperationalErrorArtifact,
  selectGateBaseline,
  evaluateGate,
  parseGateArtifact,
  type GateBaselineCandidate,
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
import {
  isTerminalScanStatus,
  type EffectiveScanLineage,
  type FindingSummary,
  type FindingTriage,
  type GateArtifact,
  type GateRun,
  type GuardrailException,
  type GuardrailPolicy,
  type GuardrailRepository,
  type ScanRun,
  type StartScanRequest,
  type GateCoverageEnvelope,
} from "@csb/shared";
import { nanoid } from "nanoid";

import {
  GATES_DIR,
  GITHUB_ACTIONS_WORKFLOW_SHA,
  GUARDRAIL_MATERIALIZATIONS_DIR,
} from "./config.js";
import { purgeScanRunArtifacts } from "./activity.js";
import {
  getFindingTriage,
  getRepositoryBaseline,
  getRun,
  hideRun,
  listRuns,
} from "./db.js";
import {
  publishGateEvent,
  subscribePersistedGateEvents,
  type GateEventListener,
} from "./gate-events.js";
import {
  appendGateEvent,
  createGitHubActionsDispatchGate,
  deleteGateRun,
  finalizeGitHubActionsArtifact,
  getGitHubActionsArtifact,
  getGitHubActionsDispatch,
  getGateRun,
  insertGateRun,
  listGateEvents,
  listGateRuns,
  listGuardrailRepositories,
  listPendingGitHubActionsDispatches,
  listMaterializationLeases,
  reserveGitHubActionsArtifact,
  upsertMaterializationLease,
  updateGateRun,
  updateGitHubActionsDispatch,
  type GateEvent,
  type GateRunUpdate,
} from "./gate-store.js";
import {
  GitHubBaselineProvider,
  type BaselineProvider,
} from "./github-baseline.js";
import { readFindingsFile, toFindingSummaries } from "./ingest.js";
import { getSystemGitHubAppService } from "./github-app-api.js";
import {
  publishManagedGateCheck,
  type ManagedGitHubCheckClient,
} from "./github-check.js";
import { ActionsArtifactImporter } from "./guardrails/actions-artifact-importer.js";
import {
  GitHubActionsExecutor,
  GitHubActionsGitHubApi,
} from "./guardrails/github-actions-executor.js";
import { GitHubArchiveClient } from "./guardrails/github-archive-client.js";
import {
  SentinelManagedExecutor,
  SentinelManagedExecutorError,
  type SentinelManagedExecutionInput,
  type SentinelManagedExecutionResult,
} from "./guardrails/sentinel-managed-executor.js";
import {
  cleanupMaterializationLeaseRoot,
  SnapshotMaterializer,
} from "./guardrails/snapshot-materializer.js";
import { reconcileMaterializationLeases } from "./guardrails/materialization-reconciler.js";
import type { AcceptedGateTargetPreview } from "./guardrails/target-preview.js";
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

export interface RemoteManagedGateDependencies {
  createGateId(): string;
  now(): string;
  getRepository(repositoryKey: string): GuardrailRepository | null;
  insertGateRun(run: GateRun): void;
  updateGateRun(gateId: string, updates: GateRunUpdate): void;
  getGateRun(gateId: string): GateRun | null;
  listGateEvents(gateId: string): GateEvent[];
  appendGateEvent(gateId: string, event: GateEvent): void;
  execute(input: SentinelManagedExecutionInput): Promise<SentinelManagedExecutionResult>;
  cancelScan(scanId: string): boolean;
  writeArtifact(gateId: string, artifact: GateArtifact): string;
  publishCheck(input: {
    artifact: Extract<GateArtifact, { schemaVersion: 2 }>;
    authority: AcceptedGateTargetPreview["repositoryAuthority"];
    detailsUrl: string | null;
  }): Promise<"created" | "updated">;
}

const activeGates = new Map<string, Promise<void>>();
const activeManagedGates = new Map<string, { controller: AbortController; scanId: string | null }>();
const githubBaselineProvider = new GitHubBaselineProvider({
  readAuthorizedRepositoryJson: (connectionId, installationId, repositoryId, resourcePath, permissions) =>
    getSystemGitHubAppService().readAuthorizedRepositoryJson(
      connectionId,
      installationId,
      repositoryId,
      resourcePath,
      permissions,
    ),
  downloadAuthorizedRepositoryBytes: (connectionId, installationId, repositoryId, resourcePath, permissions) =>
    getSystemGitHubAppService().downloadAuthorizedRepositoryBytes(
      connectionId,
      installationId,
      repositoryId,
      resourcePath,
      permissions,
    ),
});
let managedExecutor: SentinelManagedExecutor | null = null;
let actionsExecutor: GitHubActionsExecutor | null = null;

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

const productionManagedDeps: RemoteManagedGateDependencies = {
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
  execute: (input) => systemManagedExecutor().execute(input),
  cancelScan,
  writeArtifact: writeGateArtifact,
  publishCheck: (input) => publishManagedGateCheck(
    input,
    getSystemGitHubAppService() as ManagedGitHubCheckClient,
  ),
};

export async function startLocalGate(
  request: LocalGateRequest,
  deps: LocalGateDependencies = productionDeps,
): Promise<GateRun> {
  const repository = deps.getRepository(request.repositoryKey);
  if (!repository) throw new Error(`Repositório não configurado: ${request.repositoryKey}`);
  const repositoryPath = requiredLocalRepositoryPath(repository);
  const costCeilingUsd = localCostCeiling(repositoryPath, deps);
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
    repositoryPath,
    source: "local",
    executor: "sentinel-managed",
    baseRef: request.baseRef,
    headRef: request.headRef,
    resolvedBaseSha: null,
    resolvedHeadSha: null,
    policySha: null,
    pullRequestNumber: null,
    workflowRunId: null,
    materializationState: "not_required",
    scanLineageHash: null,
    artifactSchemaVersion: 1,
    scanId: null,
    status: "queued",
    outcome: null,
    policyVersion: 1,
    baselineCommit: null,
    artifactPath: null,
    publishStatus:
      repository.remoteOwner !== null && repository.remoteName !== null
        ? "waiting"
        : "not_configured",
    publishError: null,
    publishedAt: null,
    error: null,
    startedAt: deps.now(),
    completedAt: null,
    costCeilingUsd,
    estimatedUsd: 0,
  };
  deps.insertGateRun(run);
  emit(run.id, "status", { gateId: run.id, status: "queued" }, deps);
  launchGate(run.id, deps, false, baselineSource);
  return run;
}

export async function startRemoteManagedGate(
  preview: AcceptedGateTargetPreview,
  deps: RemoteManagedGateDependencies = productionManagedDeps,
): Promise<GateRun> {
  const repository = deps.getRepository(preview.repositoryKey);
  if (
    repository === null
    || repository.source !== "github"
    || repository.repositoryPath !== null
    || preview.executor !== "sentinel-managed"
    || preview.repositoryAuthority.connectionId !== repository.githubConnectionId
    || preview.repositoryAuthority.installationId !== repository.githubInstallationId
    || preview.repositoryAuthority.repositoryId !== repository.githubRepositoryId
  ) {
    throw new Error("target_preview_stale");
  }
  const run: GateRun = {
    id: deps.createGateId(),
    repositoryKey: repository.repositoryKey,
    repositoryPath: null,
    source: "github",
    executor: "sentinel-managed",
    baseRef: preview.resolvedTarget.baseRef,
    headRef: preview.resolvedTarget.headRef,
    resolvedBaseSha: preview.resolvedTarget.baseSha,
    resolvedHeadSha: preview.resolvedTarget.headSha,
    policySha: preview.resolvedTarget.policySha,
    pullRequestNumber: preview.resolvedTarget.pullRequestNumber,
    workflowRunId: null,
    materializationState: "queued",
    scanLineageHash: null,
    artifactSchemaVersion: 2,
    scanId: null,
    status: "queued",
    outcome: null,
    policyVersion: preview.policy.schemaVersion,
    baselineCommit: null,
    artifactPath: null,
    publishStatus: preview.publication.eligible ? "waiting" : "not_configured",
    publishError: null,
    publishedAt: null,
    error: null,
    startedAt: deps.now(),
    completedAt: null,
    costCeilingUsd: preview.costBudget.maxCostUsd ?? 0,
    estimatedUsd: 0,
  };
  deps.insertGateRun(run);
  emit(run.id, "status", { gateId: run.id, status: "queued" }, deps);
  launchRemoteManagedGate(run.id, repository, preview, deps);
  return run;
}

export async function startRemoteActionsGate(
  preview: AcceptedGateTargetPreview,
  idempotencyKey: string,
): Promise<GateRun> {
  const repository = listGuardrailRepositories().find(
    (candidate) => candidate.repositoryKey === preview.repositoryKey,
  ) ?? null;
  if (repository === null) throw new Error("target_preview_stale");
  return systemActionsExecutor().start({ repository, preview, idempotencyKey });
}

export async function reconcileGitHubActionsGates(): Promise<GateRun[]> {
  return systemActionsExecutor().reconcilePending();
}

export function cancelGate(
  gateId: string,
  deps: LocalGateDependencies | RemoteManagedGateDependencies = productionDeps,
): boolean {
  const gate = deps.getGateRun(gateId);
  if (!gate || ["completed", "cancelled", "error"].includes(gate.status)) return false;
  if (gate.executor === "github-actions") {
    const completedAt = deps.now();
    deps.updateGateRun(gateId, { status: "cancelled", completedAt });
    const dispatch = getGitHubActionsDispatch(gateId);
    if (dispatch !== null) {
      updateGitHubActionsDispatch(gateId, {
        state: "cancelled",
        completedAt,
      });
    }
    emit(gateId, "done", { gateId, status: "cancelled", completedAt }, deps);
    return true;
  }
  const managed = activeManagedGates.get(gateId);
  managed?.controller.abort();
  if (managed?.scanId !== null && managed?.scanId !== undefined) {
    deps.cancelScan(managed.scanId);
  }
  if (gate.scanId !== null) deps.cancelScan(gate.scanId);
  const completedAt = deps.now();
  deps.updateGateRun(gateId, { status: "cancelled", completedAt });
  emit(gateId, "done", { gateId, status: "cancelled", completedAt }, deps);
  return true;
}

export function deleteTerminalGate(
  gateId: string,
  options: { preserveLinkedScan?: boolean } = {},
): boolean {
  const gate = getGateRun(gateId);
  if (gate === null) return false;
  if (gate.status !== "completed" && gate.status !== "cancelled" && gate.status !== "error") {
    throw new Error("gate_not_terminal");
  }
  if (!options.preserveLinkedScan && gate.scanId !== null) {
    const scan = getRun(gate.scanId);
    if (scan !== null) {
      if (isScanActive(scan.id) || !isTerminalScanStatus(scan.status)) {
        throw new Error("linked_scan_not_terminal");
      }
      purgeScanRunArtifacts(scan.scanDir);
      hideRun(scan.id);
    }
  }
  for (const lease of listMaterializationLeases().filter((candidate) => candidate.gateId === gate.id)) {
    cleanupMaterializationLeaseRoot(GUARDRAIL_MATERIALIZATIONS_DIR, gate.id, lease.id);
  }
  removeGateArtifactDirectory(gate.id);
  return deleteGateRun(gate.id);
}

/**
 * A gate is a projection of its linked scan, never an independent source of
 * liveness. After a process restart the in-memory completion callback may be
 * gone, so reconcile the durable terminal scan before serving the gate.
 */
export function reconcileGateWithLinkedScan(
  gateId: string,
  deps: LocalGateDependencies = productionDeps,
): GateRun | null {
  const gate = deps.getGateRun(gateId);
  if (
    gate === null
    || gate.status !== "scanning"
    || gate.scanId === null
    || activeGates.has(gate.id)
    || deps.isScanActive(gate.scanId)
  ) return gate;

  const scan = deps.getScan(gate.scanId);
  if (scan === null || !isTerminalScanStatus(scan.status)) return gate;

  let materializationState = gate.materializationState;
  if (deps === productionDeps && materializationState !== "not_required") {
    materializationState = releaseGateMaterializations(gate.id, deps.now());
  }

  const completedAt = scan.completedAt ?? deps.now();
  const estimatedUsd = scan.cost?.estimatedUsd ?? gate.estimatedUsd;
  if (scan.status === "completed") {
    let artifact: GateArtifact | null = null;
    try {
      artifact = getGateArtifact(gate.id, deps);
    } catch {
      artifact = null;
    }
    if (artifact !== null) {
      deps.updateGateRun(gate.id, {
        status: "completed",
        outcome: artifact.decision.outcome,
        error: null,
        estimatedUsd,
        materializationState,
        completedAt,
      });
      emit(gate.id, "done", {
        gateId: gate.id,
        status: "completed",
        outcome: artifact.decision.outcome,
        completedAt,
        artifactAvailable: true,
      }, deps);
      return deps.getGateRun(gate.id);
    }
  }

  const cancelled = scan.status === "cancelled";
  const code = scan.status === "completed"
    ? "gate_finalization_interrupted"
    : `linked_scan_${scan.status}`;
  deps.updateGateRun(gate.id, {
    status: cancelled ? "cancelled" : "error",
    outcome: cancelled ? null : "error",
    error: code,
    estimatedUsd,
    materializationState,
    completedAt,
  });
  emit(gate.id, cancelled ? "done" : "error", {
    gateId: gate.id,
    status: cancelled ? "cancelled" : "error",
    outcome: cancelled ? null : "error",
    code,
    completedAt,
    artifactAvailable: false,
  }, deps);
  return deps.getGateRun(gate.id);
}

function releaseGateMaterializations(
  gateId: string,
  releasedAt: string,
): GateRun["materializationState"] {
  let failed = false;
  for (const lease of listMaterializationLeases().filter((candidate) => candidate.gateId === gateId)) {
    try {
      cleanupMaterializationLeaseRoot(GUARDRAIL_MATERIALIZATIONS_DIR, gateId, lease.id);
      upsertMaterializationLease({
        ...lease,
        state: "released",
        releasedAt,
      });
    } catch {
      failed = true;
      upsertMaterializationLease({
        ...lease,
        state: "failed",
        releasedAt: null,
      });
    }
  }
  return failed ? "failed" : "released";
}

export function subscribeGate(
  gateId: string,
  listener: GateEventListener,
  deps: LocalGateDependencies = productionDeps,
): () => void {
  const unsubscribe = subscribePersistedGateEvents(gateId, listener, deps);
  const gate = reconcileGateWithLinkedScan(gateId, deps);
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

function launchRemoteManagedGate(
  gateId: string,
  repository: GuardrailRepository,
  preview: AcceptedGateTargetPreview,
  deps: RemoteManagedGateDependencies,
): void {
  if (activeGates.has(gateId)) return;
  const controller = new AbortController();
  activeManagedGates.set(gateId, { controller, scanId: null });
  const task = runRemoteManagedGate(
    gateId,
    repository,
    preview,
    controller,
    deps,
  ).finally(() => {
    if (activeGates.get(gateId) === task) activeGates.delete(gateId);
    activeManagedGates.delete(gateId);
  });
  activeGates.set(gateId, task);
}

async function runRemoteManagedGate(
  gateId: string,
  repository: GuardrailRepository,
  preview: AcceptedGateTargetPreview,
  controller: AbortController,
  deps: RemoteManagedGateDependencies,
): Promise<void> {
  let artifactPersisted = false;
  try {
    transition(gateId, "resolving", deps);
    deps.updateGateRun(gateId, { materializationState: "materializing" });
    const result = await deps.execute({
      gateId,
      repository,
      preview,
      signal: controller.signal,
      hooks: {
        materialized: () => {
          deps.updateGateRun(gateId, { materializationState: "ready" });
        },
        scanStarted: (scan) => {
          const active = activeManagedGates.get(gateId);
          if (active !== undefined) active.scanId = scan.id;
          deps.updateGateRun(gateId, { status: "scanning", scanId: scan.id });
          emit(gateId, "scan", {
            gateId,
            scanId: scan.id,
            status: "scanning",
          }, deps);
        },
        finalize: async (execution) => {
          if (deps.getGateRun(gateId)?.status === "cancelled") {
            throw new SentinelManagedExecutorError("managed_cancelled");
          }
          transition(gateId, "evaluating", deps);
          const artifactPath = deps.writeArtifact(gateId, execution.artifact);
          artifactPersisted = true;
          const estimatedUsd = execution.scan?.cost?.estimatedUsd ?? 0;
          deps.updateGateRun(gateId, {
            artifactPath,
            artifactSchemaVersion: 2,
            scanLineageHash: execution.artifact.lineage.scanLineageHash,
            baselineCommit: execution.artifact.baselineCommit,
            outcome: execution.artifact.decision.outcome,
            estimatedUsd,
          });
          if (execution.artifact.publication.eligible) {
            transition(gateId, "publishing", deps);
            deps.updateGateRun(gateId, { publishStatus: "publishing", publishError: null });
            try {
              await deps.publishCheck({
                artifact: execution.artifact,
                authority: preview.repositoryAuthority,
                detailsUrl: null,
              });
              deps.updateGateRun(gateId, {
                publishStatus: "published",
                publishedAt: deps.now(),
              });
            } catch {
              deps.updateGateRun(gateId, {
                publishStatus: "failed",
                publishError: "github_check_publish_failed",
              });
            }
          }
        },
      },
    });
    if (deps.getGateRun(gateId)?.status === "cancelled") return;
    const completedAt = deps.now();
    const estimatedUsd = result.scan?.cost?.estimatedUsd ?? 0;
    deps.updateGateRun(gateId, {
      materializationState: "released",
      status: "completed",
      outcome: result.artifact.decision.outcome,
      error: null,
      estimatedUsd,
      completedAt,
    });
    emit(gateId, "decision", {
      gateId,
      status: "completed",
      outcome: result.artifact.decision.outcome,
      conclusion: result.artifact.decision.githubConclusion,
      artifactAvailable: true,
      estimatedUsd,
    }, deps);
    emit(gateId, "done", {
      gateId,
      status: "completed",
      outcome: result.artifact.decision.outcome,
      completedAt,
      artifactAvailable: true,
    }, deps);
  } catch (error) {
    if (deps.getGateRun(gateId)?.status === "cancelled") return;
    const completedAt = deps.now();
    const code = managedFailureCode(error, artifactPersisted);
    deps.updateGateRun(gateId, {
      materializationState: "failed",
      status: "error",
      ...(artifactPersisted ? {} : { outcome: "error" as const }),
      error: code,
      completedAt,
    });
    emit(gateId, "error", {
      gateId,
      status: "error",
      outcome: artifactPersisted ? deps.getGateRun(gateId)?.outcome ?? "error" : "error",
      code,
      completedAt,
      artifactAvailable: artifactPersisted,
    }, deps);
  }
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
  const repositoryPath = requiredLocalRepositoryPath(repository);
  let policy: GuardrailPolicy | null = null;
  let changeSet: import("@csb/shared").ChangeSet | null = null;
  let scan: ScanRun | null = null;

  try {
    if (!recoverScan) transition(gateId, "resolving", deps);
    policy = deps.readPolicy(repositoryPath);
    changeSet = await deps.resolveChangeSet({
      repositoryPath,
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
        repositoryPath,
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
    exceptions: deps.readExceptions(requiredLocalRepositoryPath(repository)),
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
    connectionId: requiredRemoteIdentity(repository.githubConnectionId),
    installationId: requiredRemoteIdentity(repository.githubInstallationId),
    repositoryId: requiredRemoteIdentity(repository.githubRepositoryId),
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
  deps: Pick<LocalGateDependencies, "now" | "updateGateRun" | "listGateEvents" | "appendGateEvent">
    | Pick<RemoteManagedGateDependencies, "now" | "updateGateRun" | "listGateEvents" | "appendGateEvent">,
): void {
  deps.updateGateRun(gateId, { status });
  emit(gateId, "status", { gateId, status, phase: status }, deps);
}

function emit(
  gateId: string,
  type: Parameters<typeof publishGateEvent>[1],
  payload: Parameters<typeof publishGateEvent>[2],
  deps: Pick<LocalGateDependencies, "now" | "listGateEvents" | "appendGateEvent">
    | Pick<RemoteManagedGateDependencies, "now" | "listGateEvents" | "appendGateEvent">,
): void {
  publishGateEvent(gateId, type, payload, deps.now(), deps);
}

function systemManagedExecutor(): SentinelManagedExecutor {
  if (managedExecutor !== null) return managedExecutor;
  const archive = new GitHubArchiveClient({
    authorize: async (repository) => {
      const connectionId = requiredRemoteIdentity(repository.githubConnectionId);
      const installationId = requiredRemoteIdentity(repository.githubInstallationId);
      const repositoryId = requiredRemoteIdentity(repository.githubRepositoryId);
      const service = getSystemGitHubAppService();
      const selection = service.requireAuthorizedRepository(
        connectionId,
        installationId,
        repositoryId,
      );
      const token = await service.createAuthorizedRepositoryToken(
        connectionId,
        installationId,
        repositoryId,
        { contents: "read" },
      );
      return { owner: selection.owner, name: selection.name, token: token.token };
    },
  });
  const materializer = new SnapshotMaterializer({
    root: GUARDRAIL_MATERIALIZATIONS_DIR,
    leases: { save: upsertMaterializationLease },
    downloadArchive: (repository, sha, signal) => archive.download(repository, sha, signal),
  });
  managedExecutor = new SentinelManagedExecutor({
    materializer,
    startScan,
    waitForScan,
    readFindings: (scanDir) => toFindingSummaries(readFindingsFile(scanDir)),
    readTriage: getFindingTriage,
    baselineCandidate: managedBaselineCandidate,
  });
  return managedExecutor;
}

function systemActionsExecutor(): GitHubActionsExecutor {
  if (actionsExecutor !== null) return actionsExecutor;
  const repository = (repositoryKey: string) =>
    listGuardrailRepositories().find((candidate) => candidate.repositoryKey === repositoryKey) ?? null;
  const importer = new ActionsArtifactImporter({
    store: {
      getGateRun,
      getRepository: repository,
      getDispatch: getGitHubActionsDispatch,
      getArtifact: getGitHubActionsArtifact,
      finalize: finalizeGitHubActionsArtifact,
    },
    writeArtifact: (gateId, artifact) => writeGateArtifact(gateId, artifact),
  });
  const service = getSystemGitHubAppService();
  actionsExecutor = new GitHubActionsExecutor({
    store: {
      createDispatchGate: createGitHubActionsDispatchGate,
      getGateRun,
      getRepository: repository,
      getDispatch: getGitHubActionsDispatch,
      listPendingDispatches: listPendingGitHubActionsDispatches,
      updateGateRun,
      updateDispatch: updateGitHubActionsDispatch,
      reserveArtifact: reserveGitHubActionsArtifact,
    },
    remote: new GitHubActionsGitHubApi(service),
    importer,
    releaseSha: GITHUB_ACTIONS_WORKFLOW_SHA,
    createGateId: () => nanoid(20),
    onGateChanged: (gate) => {
      if (gate.status === "scanning") {
        emit(gate.id, "status", {
          gateId: gate.id,
          status: "scanning",
          phase: "scanning",
        }, productionDeps);
      } else if (gate.status === "completed") {
        const artifact = getGateArtifact(gate.id);
        emit(gate.id, "decision", {
          gateId: gate.id,
          status: gate.status,
          outcome: gate.outcome,
          conclusion: artifact?.decision.githubConclusion ?? null,
          artifactAvailable: artifact !== null,
          estimatedUsd: gate.estimatedUsd,
        }, productionDeps);
        emit(gate.id, "done", {
          gateId: gate.id,
          status: gate.status,
          outcome: gate.outcome,
          completedAt: gate.completedAt,
          artifactAvailable: artifact !== null,
        }, productionDeps);
      } else if (gate.status === "error") {
        emit(gate.id, "error", {
          gateId: gate.id,
          status: gate.status,
          outcome: gate.outcome,
          code: gate.error ?? "actions_run_failed",
          completedAt: gate.completedAt,
          artifactAvailable: gate.artifactPath !== null,
        }, productionDeps);
      }
    },
  });
  return actionsExecutor;
}

async function managedBaselineCandidate(input: {
  repository: GuardrailRepository;
  protectedBranch: string | null;
  lineage: EffectiveScanLineage;
  coverage: GateCoverageEnvelope;
}): Promise<GateBaselineCandidate> {
  if (input.protectedBranch === null) return { kind: "absent" };
  let incompatible: GateBaselineCandidate | null = null;
  for (const gate of listGateRuns(input.repository.repositoryKey)) {
    if (
      gate.status !== "completed"
      || gate.source !== "github"
      || gate.artifactSchemaVersion !== 2
      || gate.pullRequestNumber !== null
      || gate.baseRef !== input.protectedBranch
      || gate.headRef !== input.protectedBranch
    ) continue;
    let artifact: GateArtifact | null;
    try {
      artifact = getGateArtifact(gate.id);
    } catch {
      return { kind: "unavailable", reason: "artifact_invalid" };
    }
    if (artifact === null) return { kind: "unavailable", reason: "artifact_missing" };
    const candidate: GateBaselineCandidate = { kind: "artifact", artifact };
    const selection = selectGateBaseline({
      repositoryId: `github:${requiredRemoteIdentity(input.repository.githubRepositoryId)}`,
      protectedBranch: input.protectedBranch,
      lineage: input.lineage,
      policySchemaVersion: 1,
      coverage: input.coverage,
    }, candidate);
    if (selection.kind === "comparable") return candidate;
    if (selection.kind === "unavailable") {
      return { kind: "unavailable", reason: selection.reason };
    }
    incompatible ??= candidate;
  }
  return incompatible ?? { kind: "absent" };
}

export function reconcileManagedMaterializations() {
  return reconcileMaterializationLeases(
    GUARDRAIL_MATERIALIZATIONS_DIR,
    { list: listMaterializationLeases, save: upsertMaterializationLease },
  );
}

function managedFailureCode(error: unknown, artifactPersisted: boolean): string {
  if (artifactPersisted) return "snapshot_cleanup_failed";
  if (error instanceof SentinelManagedExecutorError) return error.code;
  const code = error instanceof Error ? error.message : "managed_executor_failed";
  return /^[a-z][a-z0-9_-]{0,127}$/.test(code) ? code : "managed_executor_failed";
}

function requiredRemoteIdentity(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new Error("github_repository_authority_invalid");
  }
  return value;
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

function requiredLocalRepositoryPath(repository: GuardrailRepository): string {
  if (repository.source !== "local" || repository.repositoryPath === null) {
    throw new Error("Gate local exige uma pasta de repositório configurada");
  }
  return repository.repositoryPath;
}

function localCostCeiling(
  repositoryPath: string,
  deps: Pick<LocalGateDependencies, "readPolicy">,
): number {
  try {
    return deps.readPolicy(repositoryPath).scan.maxCostUsd;
  } catch {
    // Preserve the existing failed-gate flow for an unreadable policy. It will
    // record the operational error during execution instead of rejecting the launch.
    return 0;
  }
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

function removeGateArtifactDirectory(gateId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(gateId)) {
    throw new Error("gate_identity_invalid");
  }
  const root = path.resolve(GATES_DIR);
  const target = path.join(root, gateId);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("gate_identity_invalid");
  }
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("gate_artifact_cleanup_failed");
  fs.rmSync(target, { recursive: true, force: false });
}
