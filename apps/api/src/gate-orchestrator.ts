import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { assertRepositoryAccess } from "./repository-access.js";
import path from "node:path";

import {
  buildGateArtifact,
  buildOperationalErrorArtifact,
  selectGateBaseline,
  evaluateGate,
  parseGateArtifact,
  type BaselineFindingSummary,
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
  type GateArtifactV2,
  type GateRun,
  type GuardrailException,
  type GuardrailPolicy,
  type GuardrailRepository,
  type GuardrailResolvedPolicySource,
  type GuardrailScanSelection,
  type ScanRun,
  type StartScanRequest,
  type GateCoverageEnvelope,
} from "@csb/shared";
import { DEFAULT_GUARDRAIL_PR_COMMENT_LOCALE } from "@csb/shared";
import { nanoid } from "nanoid";

import {
  GATES_DIR,
  GITHUB_ACTIONS_WORKFLOW_SHA,
  GUARDRAIL_MATERIALIZATIONS_DIR,
} from "./config.js";
import { purgeScanRunArtifacts } from "./activity.js";
import { loadServerSettings } from "./deployment-settings.js";
import { notifyGitHubPublishFailed } from "./email/ops-notifications.js";
import { notifyGateOutcome } from "./email/repository-notifications.js";
import {
  getFindingTriage,
  getRepositoryBaseline,
  deleteRun,
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
  getGuardrailRepositoryPrComment,
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
import { refreshRepositoryBaselineState } from "./guardrails/baseline-state.js";
import { readFindingsFile, toFindingSummaries } from "./ingest.js";
import { getSystemGitHubAppService } from "./github-app-api.js";
import {
  publishManagedGateCheck,
  type ManagedGitHubCheckClient,
} from "./github-check.js";
import {
  publishPrComment,
  type PrCommentPublisherDependencies,
  type PublishPrCommentInput,
  type PublishPrCommentResult,
} from "./github/pr-comment-publisher.js";
import { getPrComment, upsertPrComment } from "./github/pr-comment-store.js";
import { ActionsArtifactImporter } from "./guardrails/actions-artifact-importer.js";
import {
  GitHubActionsExecutor,
  GitHubActionsGitHubApi,
} from "./guardrails/github-actions-executor.js";
import { GitHubArchiveClient } from "./guardrails/github-archive-client.js";
import { GitHubCommitCheckout } from "./guardrails/github-commit-checkout.js";
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
  scanSelection?: GuardrailScanSelection;
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
  /**
   * The repository notification for a terminal gate. Injected so a test can watch
   * it fire — and watch it throw without costing the gate its decision.
   */
  notifyOutcome(gate: GateRun): void;
  /**
   * Recomputes the repository's baseline word once a gate is terminal. It is the
   * whole of "the baseline is built on the first merge": nothing else writes
   * `guardrail_repository_baselines`, and a failure here must never cost the gate
   * its decision, so every call site swallows it into the log.
   */
  refreshBaselineState(repositoryKey: string): void;
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
  /**
   * The sticky pull-request comment. It never throws and never fails the gate:
   * the decision is already durable by the time it runs.
   */
  publishComment(input: PublishPrCommentInput): Promise<PublishPrCommentResult>;
  notifyOutcome(gate: GateRun): void;
  refreshBaselineState(repositoryKey: string): void;
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
  notifyOutcome: notifyGateOutcome,
  refreshBaselineState: refreshRepositoryBaselineState,
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
  publishComment: (input) => publishPrComment(input, productionPrCommentDependencies()),
  notifyOutcome: notifyGateOutcome,
  refreshBaselineState: refreshRepositoryBaselineState,
};

export async function startLocalGate(
  request: LocalGateRequest,
  deps: LocalGateDependencies = productionDeps,
): Promise<GateRun> {
  const repository = deps.getRepository(request.repositoryKey);
  if (!repository) throw new Error(`Repositório não configurado: ${request.repositoryKey}`);
  const repositoryPath = requiredLocalRepositoryPath(repository);
  const selection = request.scanSelection;
  const costCeilingUsd = selection?.costLimit?.kind === "none" ? 0
    : selection?.costLimit?.kind === "manual" ? selection.costLimit.maxCostUsd
    : localCostCeiling(repositoryPath, deps);
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
    policySource: null,
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
  launchGate(run.id, deps, false, baselineSource, selection);
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
    policySource: null,
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
    const executor = systemActionsExecutor();
    const accepted = executor.cancel(gateId);
    if (accepted) void executor.reconcileGate(gateId).catch(() => undefined);
    return accepted;
  }
  const managed = activeManagedGates.get(gateId);
  managed?.controller.abort();
  if (managed?.scanId !== null && managed?.scanId !== undefined) {
    deps.cancelScan(managed.scanId);
  }
  if (gate.scanId !== null) deps.cancelScan(gate.scanId);
  const completedAt = deps.now();
  deps.updateGateRun(gateId, { status: "cancelled", completedAt });
  // A cancelled baseline build is a build nobody is running: the projection has to
  // stop promising one.
  settleBaselineForGate(gateId, deps);
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
      deleteRun(scan.id);
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
      settleBaseline(gate.repositoryKey, deps);
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
  settleBaseline(gate.repositoryKey, deps);
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
  const task: Promise<void> = runRemoteManagedGate(
    gateId,
    repository,
    preview,
    controller,
    deps,
  ).catch((error: unknown) => {
    logGateFailure(gateId, error);
  }).finally(() => {
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
            // Which level of the precedence decided, recorded on the row so the
            // repository list can name it without a GitHub call per repository.
            policySource: currentPolicySource(execution.artifact.policySource),
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
              // After the row, so the alert names a state an administrator can see.
              notifyGitHubPublishFailed(gateId);
            }
          }
          await publishGateComment(gateId, execution.artifact, preview, deps);
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
    settleBaseline(repository.repositoryKey, deps);
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
    logGateFailure(gateId, error);
    const completedAt = deps.now();
    // The decision is already durable, so it is the truth about the change.
    // Releasing the snapshot, emitting or persisting afterwards is bookkeeping
    // and must never discard a paid scan; the lease is reconciled at startup.
    // A persisted artifact whose outcome never reached the gate row is the one
    // case left without a decision to serve, so it still fails closed.
    const persistedOutcome = artifactPersisted ? deps.getGateRun(gateId)?.outcome ?? null : null;
    if (persistedOutcome !== null) {
      deps.updateGateRun(gateId, {
        materializationState: "failed",
        status: "completed",
        error: null,
        completedAt,
      });
      settleBaseline(repository.repositoryKey, deps);
      emit(gateId, "done", {
        gateId,
        status: "completed",
        outcome: persistedOutcome,
        completedAt,
        artifactAvailable: true,
      }, deps);
      return;
    }
    const code = managedFailureCode(error);
    deps.updateGateRun(gateId, {
      materializationState: "failed",
      status: "error",
      outcome: "error",
      error: code,
      completedAt,
    });
    settleBaseline(repository.repositoryKey, deps);
    emit(gateId, "error", {
      gateId,
      status: "error",
      outcome: "error",
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
  selection?: GuardrailScanSelection,
): void {
  if (activeGates.has(gateId)) return;
  // The launch is fire and forget, so this is the last place a rejection can be
  // observed. Leaving it unhandled would take the process down with it.
  const task: Promise<void> = runGate(gateId, deps, recoverScan, baselineSource, selection)
    .catch((error: unknown) => {
      logGateFailure(gateId, error);
    })
    .finally(() => {
      if (activeGates.get(gateId) === task) activeGates.delete(gateId);
    });
  activeGates.set(gateId, task);
}

async function runGate(
  gateId: string,
  deps: LocalGateDependencies,
  recoverScan: boolean,
  baselineSource: "local" | "github",
  selection?: GuardrailScanSelection,
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
      requireMatchingCheckout: true,
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
        ...(selection ? {
          engine: selection.engine, connection: selection.connection,
          ...(selection.engine === "codex-security" ? { executionProfilePreference: "auto" as const } : {}),
          ...(selection.effort === undefined ? {} : { effort: selection.effort }),
        } : { model: policy.scan.model, effort: policy.scan.effort }),
        mode: selection?.mode ?? policy.scan.mode,
        ...(selection?.costLimit?.kind === "none" ? {} : { maxCostUsd: gate.costCeilingUsd }),
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
    logGateFailure(gateId, error);
    try {
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
    } catch (failure) {
      // Recording the failure must not become a second failure: without this the
      // gate would stay in a running status forever, with no terminal event.
      logGateFailure(gateId, failure);
      recordUnrecordedGateFailure(gateId, scan, deps);
    }
  }
}

function recordUnrecordedGateFailure(
  gateId: string,
  scan: ScanRun | null,
  deps: LocalGateDependencies,
): void {
  const completedAt = deps.now();
  deps.updateGateRun(gateId, {
    status: "error",
    outcome: "error",
    error: "gate_failure_unrecorded",
    estimatedUsd: scan?.cost?.estimatedUsd ?? 0,
    completedAt,
  });
  settleBaselineForGate(gateId, deps);
  emit(gateId, "error", {
    gateId,
    status: "error",
    outcome: "error",
    code: "gate_failure_unrecorded",
    completedAt,
    artifactAvailable: false,
  }, deps);
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
  const repositoryPath = requiredLocalRepositoryPath(repository);
  const repositoryIdentity = localRepositoryIdentity(repositoryPath);
  const historicalFindings = deps.listScans()
    .filter((candidate) =>
      candidate.status === "completed" &&
      candidate.id !== scan?.id &&
      candidate.id !== baselineScanId &&
      isScanForLocalRepository(candidate, repositoryIdentity),
    )
    .flatMap((candidate) => readHistoricalFindings(candidate, deps));
  const evaluation = deps.evaluateGate({
    policy,
    branch: changeSet.headRef,
    changeSet,
    currentFindings,
    baselineFindings,
    historicalFindings,
    triageByIdentity: deps.readTriage(repository.repositoryKey),
    exceptions: deps.readExceptions(repositoryPath),
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
  settleBaseline(repository.repositoryKey, deps);
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
  settleBaseline(repository.repositoryKey, deps);
  emit(gateId, "error", {
    gateId,
    status: "error",
    outcome: "error",
    code: "gate.failed",
    completedAt,
    artifactAvailable: artifactPath !== null,
  }, deps);
}

/**
 * Historical evidence is best effort: it can only upgrade a finding to reopened.
 * One removed or unreadable old scan directory must not fail every later gate,
 * so skip it loudly. The current scan's findings are load bearing and are read
 * without this shield, so an unreadable one still fails the gate.
 */
function readHistoricalFindings(
  scan: ScanRun,
  deps: LocalGateDependencies,
): FindingSummary[] {
  try {
    return deps.readFindings(scan.scanDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      `[csb-api] Scan ${scan.id} ignored as gate history: ${detail}`,
    );
    return [];
  }
}

/**
 * ScanRun intentionally stores the resolved local checkout path instead of a
 * guardrail repository key. Historical lifecycle evidence must therefore be
 * scoped by that checkout before it can classify a finding as reopened.
 *
 * A managed scan exposes a public locator in repositoryPath, which is not a
 * local checkout and must never contribute to a local gate's history.
 */
function isScanForLocalRepository(scan: ScanRun, repositoryIdentity: string): boolean {
  if (scan.repositoryPath === null || !path.isAbsolute(scan.repositoryPath)) return false;
  return localRepositoryIdentity(scan.repositoryPath) === repositoryIdentity;
}

function localRepositoryIdentity(repositoryPath: string): string {
  const resolved = path.resolve(repositoryPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // Historical rows can outlive a removed checkout. Resolving still keeps
    // their identity local and deterministic without trusting a relative path.
    return resolved;
  }
}

/**
 * A stored baseline artifact already carries the identity gate-core assigned to
 * each finding, so keep that field typed all the way into the evaluation instead
 * of letting it be re-derived from an already redacted summary.
 */
async function resolveBaseline(
  repository: GuardrailRepository,
  source: "local" | "github",
  deps: LocalGateDependencies,
): Promise<{
  scanId: string | null;
  findings: BaselineFindingSummary[] | null;
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
  findings: BaselineFindingSummary[] | null;
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
  deps: Pick<LocalGateDependencies, "now" | "updateGateRun" | "listGateEvents" | "appendGateEvent" | "getGateRun" | "notifyOutcome">
    | Pick<RemoteManagedGateDependencies, "now" | "updateGateRun" | "listGateEvents" | "appendGateEvent" | "getGateRun" | "notifyOutcome">,
): void {
  deps.updateGateRun(gateId, { status });
  emit(gateId, "status", { gateId, status, phase: status }, deps);
}

function emit(
  gateId: string,
  type: Parameters<typeof publishGateEvent>[1],
  payload: Parameters<typeof publishGateEvent>[2],
  deps: Pick<LocalGateDependencies, "now" | "listGateEvents" | "appendGateEvent" | "getGateRun" | "notifyOutcome">
    | Pick<RemoteManagedGateDependencies, "now" | "listGateEvents" | "appendGateEvent" | "getGateRun" | "notifyOutcome">,
): void {
  publishGateEvent(gateId, type, payload, deps.now(), deps);
  // `done` and `error` are the only terminal events a gate emits, on every path:
  // the local evaluation, the managed success, the managed failure that still had
  // a persisted decision, the two failure recorders. Hooking the one choke point
  // rather than six call sites is why a new terminal path cannot forget the
  // notification.
  if (type === "done" || type === "error") notifyGateTerminal(gateId, deps);
}

/**
 * Queues the repository e-mail for a gate that just became terminal.
 *
 * Reads the row back instead of trusting the payload: the persisted outcome is
 * the truth about the change, and it is the only thing the reader of the message
 * will be able to open. Everything is swallowed — a gate decision must not be
 * lost, delayed or rolled back because an e-mail could not be rendered.
 */
function notifyGateTerminal(
  gateId: string,
  deps: Pick<LocalGateDependencies, "getGateRun" | "notifyOutcome">
    | Pick<RemoteManagedGateDependencies, "getGateRun" | "notifyOutcome">,
): void {
  try {
    const gate = deps.getGateRun(gateId);
    if (gate !== null) deps.notifyOutcome(gate);
  } catch (error) {
    console.warn(
      `[csb-api] Could not queue the gate notification for ${gateId}: `
        + `${error instanceof Error ? error.name : "unknown_error"}`,
    );
  }
}

function systemManagedExecutor(): SentinelManagedExecutor {
  if (managedExecutor !== null) return managedExecutor;
  const authorize = async (repository: GuardrailRepository) => {
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
  };
  const archive = new GitHubArchiveClient({ authorize });
  const commitCheckout = new GitHubCommitCheckout({ authorize });
  const materializer = new SnapshotMaterializer({
    root: GUARDRAIL_MATERIALIZATIONS_DIR,
    leases: { save: upsertMaterializationLease },
    downloadArchive: (repository, sha, signal) => archive.download(repository, sha, signal),
    checkoutCommit: (repository, sha, destination, signal) =>
      commitCheckout.checkout(repository, sha, destination, signal),
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
      if (gate.status === "scanning" || gate.status === "cancelling") {
        emit(gate.id, "status", {
          gateId: gate.id,
          status: gate.status,
          phase: gate.status,
          ...(gate.error ? { code: gate.error } : {}),
        }, productionDeps);
      } else if (gate.status === "cancelled") {
        emit(gate.id, "done", { gateId: gate.id, status: gate.status,
          ...(gate.error ? { code: gate.error } : {}), completedAt: gate.completedAt }, productionDeps);
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

/**
 * The baseline projection, refreshed once a gate is terminal. A failure is logged
 * and swallowed: the gate's decision is already durable, and a projection that
 * could not be rewritten is a stale word on a screen, not a lost verdict.
 */
/**
 * The sticky comment, next to the Check and after it.
 *
 * A comment failure never fails the gate: the decision is already written, the
 * money is already spent, and a pull request with a Check and no comment is a
 * degraded result, not a wrong one. The failure is recorded on the comment's own
 * row and raised through the alert the Check publication already uses
 * (`ops.github_publish_failed`), so an administrator sees one event for "Sentinel
 * could not write to GitHub" instead of two that mean the same thing.
 */
async function publishGateComment(
  gateId: string,
  artifact: GateArtifactV2,
  preview: AcceptedGateTargetPreview,
  deps: RemoteManagedGateDependencies,
): Promise<void> {
  if (artifact.target.kind !== "pull_request") return;
  if (artifact.repository.locator.kind !== "github") return;
  try {
    const startedAt = deps.getGateRun(gateId)?.startedAt ?? null;
    const result = await deps.publishComment({
      artifact,
      repositoryKey: artifact.repository.key,
      authority: preview.repositoryAuthority,
      owner: artifact.repository.locator.owner,
      name: artifact.repository.locator.name,
      pullRequestNumber: artifact.resolvedTarget.pullRequestNumber,
      durationMs: startedAt === null ? null : Date.parse(deps.now()) - Date.parse(startedAt),
    });
    if (result.status === "failed") notifyGitHubPublishFailed(gateId);
  } catch (error) {
    logGateFailure(gateId, error);
    notifyGitHubPublishFailed(gateId);
  }
}

/**
 * The App credential, the projection and the repository's own two comment settings.
 * It is built per call rather than frozen into `productionManagedDeps` because the
 * public origin and the repository row can both change between two gates.
 */
function productionPrCommentDependencies(): PrCommentPublisherDependencies {
  const service = getSystemGitHubAppService();
  return {
    readAuthorizedRepositoryJson: (connectionId, installationId, repositoryId, resourcePath, permissions) =>
      service.readAuthorizedRepositoryJson(
        connectionId,
        installationId,
        repositoryId,
        resourcePath,
        permissions,
      ),
    writeAuthorizedRepositoryJson: (connectionId, installationId, repositoryId, resourcePath, method, body, permissions) =>
      service.writeAuthorizedRepositoryJson(
        connectionId,
        installationId,
        repositoryId,
        resourcePath,
        method,
        body,
        permissions,
      ),
    getComment: (repositoryKey, pullRequestNumber) => getPrComment(repositoryKey, pullRequestNumber),
    upsertComment: (record) => { upsertPrComment(record); },
    commentsEnabled: (repositoryKey) =>
      getGuardrailRepositoryPrComment(repositoryKey)?.enabled ?? false,
    commentLocale: (repositoryKey) =>
      getGuardrailRepositoryPrComment(repositoryKey)?.locale ?? DEFAULT_GUARDRAIL_PR_COMMENT_LOCALE,
    publicOrigin: () => loadServerSettings().origin,
    now: () => new Date().toISOString(),
  };
}

/**
 * The three words a gate may have run under. An artifact that still carries one of
 * the two retired ones means `repository_file`: both only ever described reading
 * `.csb/guardrails.json`.
 */
function currentPolicySource(
  source: GateArtifactV2["policySource"],
): GuardrailResolvedPolicySource {
  if (source === "base" || source === "protected_branch") return "repository_file";
  return source;
}

/** The same, when only the gate id is at hand. */
function settleBaselineForGate(
  gateId: string,
  deps: { getGateRun(gateId: string): GateRun | null; refreshBaselineState(repositoryKey: string): void },
): void {
  const repositoryKey = deps.getGateRun(gateId)?.repositoryKey;
  if (repositoryKey === undefined) return;
  settleBaseline(repositoryKey, deps);
}

function settleBaseline(
  repositoryKey: string,
  deps: { refreshBaselineState(repositoryKey: string): void },
): void {
  try {
    deps.refreshBaselineState(repositoryKey);
  } catch (error) {
    console.warn(`[csb-api] Could not refresh the baseline of ${repositoryKey}: ${String(error)}`);
  }
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

// The stored gate error is a sanitized code; keep the full cause in the
// server log so a failure after a long scan is diagnosable.
function logGateFailure(gateId: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[csb-api] Gate ${gateId} failed: ${detail}`);
}

function managedFailureCode(error: unknown): string {
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
  return assertRepositoryAccess(repository.repositoryPath);
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
