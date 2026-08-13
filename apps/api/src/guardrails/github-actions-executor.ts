import { createHash, randomUUID } from "node:crypto";

import type { GateArtifactV2, GateRun, GuardrailRepository } from "@csb/shared";

import type {
  CreateGitHubActionsDispatchResult,
  GitHubActionsArtifactMetadata,
  GitHubActionsDispatchMetadata,
  GitHubActionsDispatchUpdate,
  GateRunUpdate,
} from "../gate-store.js";
import type { AcceptedGateTargetPreview } from "./target-preview.js";
import type { ActionsArtifactImporter } from "./actions-artifact-importer.js";

export const ACTIONS_CALLER_WORKFLOW_PATH = ".github/workflows/csb-security-change-gate.yml";
export const ACTIONS_ARTIFACT_NAME = "csb-gate-artifact-v2";
const RUN_CORRELATION_BEFORE_MS = 60_000;
const RUN_CORRELATION_AFTER_MS = 30 * 60_000;

export type GitHubActionsExecutionErrorCode =
  | "actions_artifact_ambiguous"
  | "actions_artifact_missing"
  | "actions_check_ambiguous"
  | "actions_dispatch_rejected"
  | "actions_dispatch_unknown"
  | "actions_gate_identity_invalid"
  | "actions_run_ambiguous"
  | "actions_run_failed"
  | "actions_run_not_found";

export class GitHubActionsExecutionError extends Error {
  constructor(readonly code: GitHubActionsExecutionErrorCode) {
    super(code);
    this.name = "GitHubActionsExecutionError";
  }
}

export interface GitHubActionsRemoteRun {
  id: string;
  attempt: number;
  event: "workflow_dispatch";
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  displayTitle: string;
  createdAt: string;
}

export interface GitHubActionsRemoteArtifact {
  id: string;
  name: string;
  digest: string;
  expired: boolean;
  workflowRunId: string;
}

export interface GitHubActionsRemote {
  dispatchWorkflow(input: {
    dispatch: GitHubActionsDispatchMetadata;
    repository: GuardrailRepository;
    inputs: Readonly<Record<string, string>>;
  }): Promise<void>;
  listWorkflowRuns(input: {
    dispatch: GitHubActionsDispatchMetadata;
    repository: GuardrailRepository;
  }): Promise<GitHubActionsRemoteRun[]>;
  getWorkflowRun(input: {
    dispatch: GitHubActionsDispatchMetadata;
    repository: GuardrailRepository;
    workflowRunId: string;
  }): Promise<GitHubActionsRemoteRun>;
  listWorkflowArtifacts(input: {
    dispatch: GitHubActionsDispatchMetadata;
    repository: GuardrailRepository;
    workflowRunId: string;
  }): Promise<GitHubActionsRemoteArtifact[]>;
  downloadWorkflowArtifact(input: {
    dispatch: GitHubActionsDispatchMetadata;
    repository: GuardrailRepository;
    artifactId: string;
  }): Promise<Uint8Array>;
  countGateChecks(input: {
    dispatch: GitHubActionsDispatchMetadata;
    repository: GuardrailRepository;
    headSha: string;
    gateId: string;
  }): Promise<number>;
}

export interface GitHubActionsExecutorStore {
  createDispatchGate(
    run: GateRun,
    dispatch: GitHubActionsDispatchMetadata,
  ): CreateGitHubActionsDispatchResult;
  getGateRun(gateId: string): GateRun | null;
  getRepository(repositoryKey: string): GuardrailRepository | null;
  getDispatch(gateId: string): GitHubActionsDispatchMetadata | null;
  listPendingDispatches(): GitHubActionsDispatchMetadata[];
  updateGateRun(gateId: string, updates: GateRunUpdate): void;
  updateDispatch(gateId: string, updates: GitHubActionsDispatchUpdate): void;
  reserveArtifact(artifact: GitHubActionsArtifactMetadata): "created" | "existing";
}

export interface GitHubActionsExecutorDependencies {
  store: GitHubActionsExecutorStore;
  remote: GitHubActionsRemote;
  importer: ActionsArtifactImporter;
  releaseSha: string | null;
  createGateId?(): string;
  now?(): string;
  onGateChanged?(gate: GateRun): void;
}

export interface StartGitHubActionsGateInput {
  repository: GuardrailRepository;
  preview: AcceptedGateTargetPreview;
  idempotencyKey: string;
}

export class GitHubActionsExecutor {
  readonly #store: GitHubActionsExecutorStore;
  readonly #remote: GitHubActionsRemote;
  readonly #importer: ActionsArtifactImporter;
  readonly #releaseSha: string | null;
  readonly #createGateId: () => string;
  readonly #now: () => string;
  readonly #onGateChanged: (gate: GateRun) => void;

  constructor(dependencies: GitHubActionsExecutorDependencies) {
    this.#store = dependencies.store;
    this.#remote = dependencies.remote;
    this.#importer = dependencies.importer;
    this.#releaseSha = dependencies.releaseSha === null ? null : fullSha(dependencies.releaseSha);
    this.#createGateId = dependencies.createGateId ?? (() => randomUUID());
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#onGateChanged = dependencies.onGateChanged ?? (() => undefined);
  }

  async start(input: StartGitHubActionsGateInput): Promise<GateRun> {
    const idempotencyKey = safeIdempotencyKey(input.idempotencyKey);
    if (this.#releaseSha === null) {
      throw new GitHubActionsExecutionError("actions_gate_identity_invalid");
    }
    validateStartIdentity(input.repository, input.preview);
    const now = this.#now();
    const gateId = this.#createGateId();
    const protectedBranch = input.preview.publication.protectedBranch
      ?? input.preview.resolvedTarget.baseRef;
    const run = actionsGateRun(gateId, input.repository, input.preview, now);
    const dispatch = actionsDispatch(
      run,
      input.repository,
      input.preview,
      idempotencyKey,
      this.#releaseSha,
      protectedBranch,
      now,
    );
    const persisted = this.#store.createDispatchGate(run, dispatch);
    if (persisted.dispatch.requestFingerprint !== dispatch.requestFingerprint) {
      throw new GitHubActionsExecutionError("actions_gate_identity_invalid");
    }
    if (!persisted.created) return persisted.gate;

    this.#store.updateGateRun(run.id, { status: "resolving" });
    try {
      await this.#remote.dispatchWorkflow({
        dispatch,
        repository: input.repository,
        inputs: dispatchInputs(input.repository, input.preview, dispatch, protectedBranch),
      });
      this.#store.updateDispatch(run.id, {
        state: "dispatch_accepted",
        dispatchedAt: this.#now(),
        error: null,
      });
    } catch (error) {
      const definite = dispatchFailureIsDefinite(error);
      if (definite) {
        this.#fail(run.id, "actions_dispatch_rejected");
        throw new GitHubActionsExecutionError("actions_dispatch_rejected");
      }
      this.#store.updateDispatch(run.id, { error: "actions_dispatch_unknown" });
    }
    return requiredGate(run.id, this.#store);
  }

  async reconcileGate(gateId: string): Promise<GateRun | null> {
    let dispatch = this.#store.getDispatch(gateId);
    let gate = this.#store.getGateRun(gateId);
    if (dispatch === null || gate === null) return null;
    if (terminalDispatch(dispatch.state) || terminalGate(gate.status)) return gate;
    const repository = this.#store.getRepository(gate.repositoryKey);
    if (repository === null) return this.#fail(gateId, "actions_gate_identity_invalid");

    try {
      if (dispatch.workflowRunId === null) {
        this.#store.updateDispatch(gateId, {
          state: "correlating",
          lastPolledAt: this.#now(),
        });
        const runs = await this.#remote.listWorkflowRuns({ dispatch, repository });
        const matches = correlatedRuns(dispatch, runs);
        if (matches.length > 1) return this.#fail(gateId, "actions_run_ambiguous");
        if (matches.length === 0) {
          if (Date.parse(this.#now()) > Date.parse(dispatch.requestedAt) + RUN_CORRELATION_AFTER_MS) {
            return this.#fail(gateId, "actions_run_not_found");
          }
          return requiredGate(gateId, this.#store);
        }
        const match = matches[0]!;
        this.#store.updateDispatch(gateId, {
          state: "running",
          workflowRunId: match.id,
          workflowRunAttempt: match.attempt,
          lastPolledAt: this.#now(),
          error: null,
        });
        this.#store.updateGateRun(gateId, {
          workflowRunId: match.id,
          status: "scanning",
        });
        dispatch = requiredDispatch(gateId, this.#store);
        gate = requiredGate(gateId, this.#store);
        this.#onGateChanged(gate);
      }

      const remoteRun = await this.#remote.getWorkflowRun({
        dispatch,
        repository,
        workflowRunId: dispatch.workflowRunId!,
      });
      assertRunIdentity(dispatch, remoteRun);
      this.#store.updateDispatch(gateId, {
        state: remoteRun.status === "completed" ? "artifact_pending" : "running",
        workflowRunAttempt: remoteRun.attempt,
        lastPolledAt: this.#now(),
      });
      if (remoteRun.status !== "completed") return requiredGate(gateId, this.#store);

      const artifacts = (await this.#remote.listWorkflowArtifacts({
        dispatch,
        repository,
        workflowRunId: remoteRun.id,
      })).filter((artifact) =>
        artifact.name === ACTIONS_ARTIFACT_NAME
        && artifact.workflowRunId === remoteRun.id
        && !artifact.expired,
      );
      if (artifacts.length > 1) return this.#fail(gateId, "actions_artifact_ambiguous");
      if (artifacts.length === 0) return this.#fail(gateId, "actions_artifact_missing");
      const artifact = artifacts[0]!;
      const metadata: GitHubActionsArtifactMetadata = {
        id: `github-actions:${artifact.id}`,
        gateId,
        repositoryKey: gate.repositoryKey,
        workflowRunId: remoteRun.id,
        workflowRunAttempt: remoteRun.attempt,
        artifactName: artifact.name,
        artifactDigest: githubDigest(artifact.digest),
        artifactSchemaVersion: 2,
        status: "pending",
        createdAt: this.#now(),
        validatedAt: null,
      };
      this.#store.reserveArtifact(metadata);
      const archive = await this.#remote.downloadWorkflowArtifact({
        dispatch,
        repository,
        artifactId: artifact.id,
      });
      const imported = this.#importer.import({
        artifactId: metadata.id,
        gateId,
        githubDigest: metadata.artifactDigest,
        archive,
      });
      if (imported.applied && imported.artifact.publication.eligible) {
        const checks = await this.#remote.countGateChecks({
          dispatch,
          repository,
          headSha: imported.artifact.resolvedTarget.headSha,
          gateId,
        });
        if (checks > 1) throw new GitHubActionsExecutionError("actions_check_ambiguous");
        this.#store.updateGateRun(gateId, checks === 1
          ? { publishStatus: "published", publishedAt: this.#now(), publishError: null }
          : { publishStatus: "failed", publishError: "actions_check_missing" });
      }
      gate = requiredGate(gateId, this.#store);
      this.#onGateChanged(gate);
      return gate;
    } catch (error) {
      if (requiredGate(gateId, this.#store).status === "cancelled") return requiredGate(gateId, this.#store);
      return this.#fail(gateId, executionCode(error));
    }
  }

  async reconcilePending(): Promise<GateRun[]> {
    const results: GateRun[] = [];
    for (const dispatch of this.#store.listPendingDispatches()) {
      const gate = await this.reconcileGate(dispatch.gateId);
      if (gate !== null) results.push(gate);
    }
    return results;
  }

  cancel(gateId: string): boolean {
    const gate = this.#store.getGateRun(gateId);
    const dispatch = this.#store.getDispatch(gateId);
    if (gate === null || dispatch === null || terminalGate(gate.status)) return false;
    const completedAt = this.#now();
    this.#store.updateGateRun(gateId, { status: "cancelled", completedAt });
    this.#store.updateDispatch(gateId, { state: "cancelled", completedAt });
    this.#onGateChanged(requiredGate(gateId, this.#store));
    return true;
  }

  #fail(gateId: string, code: GitHubActionsExecutionErrorCode | string): GateRun {
    const gate = requiredGate(gateId, this.#store);
    if (gate.status === "cancelled") return gate;
    const completedAt = this.#now();
    const safeCode = safeFailureCode(code);
    this.#store.updateGateRun(gateId, {
      status: "error",
      outcome: "error",
      error: safeCode,
      completedAt,
    });
    this.#store.updateDispatch(gateId, {
      state: "failed",
      completedAt,
      error: safeCode,
    });
    const failed = requiredGate(gateId, this.#store);
    this.#onGateChanged(failed);
    return failed;
  }
}

export interface GitHubActionsRepositoryAuthority {
  readAuthorizedRepositoryJson(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    permissions: { actions?: "read" | "write"; checks?: "write"; contents?: "read" },
  ): Promise<unknown>;
  writeAuthorizedRepositoryJson(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    method: "PATCH" | "POST",
    body: unknown,
    permissions: { actions?: "read" | "write"; checks?: "write"; contents?: "read" },
  ): Promise<unknown>;
  downloadAuthorizedRepositoryBytes(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    permissions: { actions: "read" },
  ): Promise<Uint8Array>;
}

export class GitHubActionsGitHubApi implements GitHubActionsRemote {
  constructor(readonly authority: GitHubActionsRepositoryAuthority) {}

  async dispatchWorkflow(input: Parameters<GitHubActionsRemote["dispatchWorkflow"]>[0]): Promise<void> {
    const identity = remoteIdentity(input.repository, input.dispatch);
    await this.authority.writeAuthorizedRepositoryJson(
      identity.connectionId,
      identity.installationId,
      identity.repositoryId,
      `/repos/${identity.owner}/${identity.name}/actions/workflows/${encodeURIComponent(input.dispatch.workflowPath)}/dispatches`,
      "POST",
      { ref: input.dispatch.workflowRef, inputs: input.inputs },
      { actions: "write" },
    );
  }

  async listWorkflowRuns(input: Parameters<GitHubActionsRemote["listWorkflowRuns"]>[0]): Promise<GitHubActionsRemoteRun[]> {
    const identity = remoteIdentity(input.repository, input.dispatch);
    const value = await this.authority.readAuthorizedRepositoryJson(
      identity.connectionId,
      identity.installationId,
      identity.repositoryId,
      `/repos/${identity.owner}/${identity.name}/actions/workflows/${encodeURIComponent(input.dispatch.workflowPath)}/runs?event=workflow_dispatch&per_page=100`,
      { actions: "read" },
    );
    return workflowRuns(value);
  }

  async getWorkflowRun(input: Parameters<GitHubActionsRemote["getWorkflowRun"]>[0]): Promise<GitHubActionsRemoteRun> {
    const identity = remoteIdentity(input.repository, input.dispatch);
    return workflowRun(await this.authority.readAuthorizedRepositoryJson(
      identity.connectionId,
      identity.installationId,
      identity.repositoryId,
      `/repos/${identity.owner}/${identity.name}/actions/runs/${numericId(input.workflowRunId)}`,
      { actions: "read" },
    ));
  }

  async listWorkflowArtifacts(input: Parameters<GitHubActionsRemote["listWorkflowArtifacts"]>[0]): Promise<GitHubActionsRemoteArtifact[]> {
    const identity = remoteIdentity(input.repository, input.dispatch);
    return workflowArtifacts(await this.authority.readAuthorizedRepositoryJson(
      identity.connectionId,
      identity.installationId,
      identity.repositoryId,
      `/repos/${identity.owner}/${identity.name}/actions/runs/${numericId(input.workflowRunId)}/artifacts?per_page=100`,
      { actions: "read" },
    ));
  }

  async downloadWorkflowArtifact(input: Parameters<GitHubActionsRemote["downloadWorkflowArtifact"]>[0]): Promise<Uint8Array> {
    const identity = remoteIdentity(input.repository, input.dispatch);
    return this.authority.downloadAuthorizedRepositoryBytes(
      identity.connectionId,
      identity.installationId,
      identity.repositoryId,
      `/repos/${identity.owner}/${identity.name}/actions/artifacts/${numericId(input.artifactId)}/zip`,
      { actions: "read" },
    );
  }

  async countGateChecks(input: Parameters<GitHubActionsRemote["countGateChecks"]>[0]): Promise<number> {
    const identity = remoteIdentity(input.repository, input.dispatch);
    const value = record(await this.authority.readAuthorizedRepositoryJson(
      identity.connectionId,
      identity.installationId,
      identity.repositoryId,
      `/repos/${identity.owner}/${identity.name}/commits/${fullSha(input.headSha)}/check-runs?check_name=${encodeURIComponent("CSB Security Change Gate")}&filter=all&per_page=100`,
      { checks: "write" },
    ));
    const checks = array(value.check_runs, 100);
    return checks.filter((entry) => record(entry).external_id === input.gateId).length;
  }
}

function actionsGateRun(
  gateId: string,
  repository: GuardrailRepository,
  preview: AcceptedGateTargetPreview,
  now: string,
): GateRun {
  return {
    id: gateId,
    repositoryKey: repository.repositoryKey,
    repositoryPath: null,
    source: "github",
    executor: "github-actions",
    baseRef: preview.resolvedTarget.baseRef,
    headRef: preview.resolvedTarget.headRef,
    resolvedBaseSha: preview.resolvedTarget.baseSha,
    resolvedHeadSha: preview.resolvedTarget.headSha,
    policySha: preview.resolvedTarget.policySha,
    pullRequestNumber: preview.resolvedTarget.pullRequestNumber,
    workflowRunId: null,
    materializationState: "not_required",
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
    costCeilingUsd: preview.costBudget.maxCostUsd,
    estimatedUsd: 0,
    startedAt: now,
    completedAt: null,
  };
}

function actionsDispatch(
  gate: GateRun,
  repository: GuardrailRepository,
  preview: AcceptedGateTargetPreview,
  idempotencyKey: string,
  releaseSha: string,
  protectedBranch: string,
  now: string,
): GitHubActionsDispatchMetadata {
  const expectedRunName = `CSB gate ${gate.id} · ${preview.resolvedTarget.headSha}`;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    repositoryKey: repository.repositoryKey,
    repositoryId: repository.githubRepositoryId,
    executor: preview.executor,
    target: preview.target,
    resolvedTarget: preview.resolvedTarget,
    policySha: preview.policySha,
    releaseSha,
  })).digest("hex");
  return {
    gateId: gate.id,
    repositoryKey: gate.repositoryKey,
    idempotencyKey,
    requestFingerprint: `sha256:${fingerprint}`,
    connectionId: preview.repositoryAuthority.connectionId,
    installationId: preview.repositoryAuthority.installationId,
    repositoryId: preview.repositoryAuthority.repositoryId,
    workflowPath: ACTIONS_CALLER_WORKFLOW_PATH,
    workflowRef: repository.defaultBranch,
    releaseSha,
    targetKind: preview.target.kind,
    protectedBranch,
    expectedRunName,
    expectedHeadSha: preview.resolvedTarget.headSha,
    state: "dispatch_requested",
    workflowRunId: null,
    workflowRunAttempt: null,
    requestedAt: now,
    dispatchedAt: null,
    lastPolledAt: null,
    completedAt: null,
    error: null,
  };
}

function dispatchInputs(
  repository: GuardrailRepository,
  preview: AcceptedGateTargetPreview,
  dispatch: GitHubActionsDispatchMetadata,
  protectedBranch: string,
): Readonly<Record<string, string>> {
  return {
    gate_id: dispatch.gateId,
    target_kind: preview.target.kind,
    base_ref: preview.resolvedTarget.baseRef,
    head_ref: preview.resolvedTarget.headRef,
    base_sha: preview.resolvedTarget.baseSha,
    head_sha: preview.resolvedTarget.headSha,
    protected_branch: protectedBranch,
    pull_request_number: String(preview.resolvedTarget.pullRequestNumber ?? 0),
    head_repository: `${repository.remoteOwner}/${repository.remoteName}`,
  };
}

function correlatedRuns(
  dispatch: GitHubActionsDispatchMetadata,
  runs: readonly GitHubActionsRemoteRun[],
): GitHubActionsRemoteRun[] {
  const before = Date.parse(dispatch.requestedAt) - RUN_CORRELATION_BEFORE_MS;
  const after = Date.parse(dispatch.requestedAt) + RUN_CORRELATION_AFTER_MS;
  return runs.filter((run) => {
    const created = Date.parse(run.createdAt);
    return run.event === "workflow_dispatch"
      && run.displayTitle === dispatch.expectedRunName
      && Number.isFinite(created)
      && created >= before
      && created <= after;
  });
}

function assertRunIdentity(
  dispatch: GitHubActionsDispatchMetadata,
  run: GitHubActionsRemoteRun,
): void {
  if (
    run.id !== dispatch.workflowRunId
    || run.attempt !== dispatch.workflowRunAttempt
    || run.event !== "workflow_dispatch"
    || run.displayTitle !== dispatch.expectedRunName
  ) throw new GitHubActionsExecutionError("actions_run_ambiguous");
}

function validateStartIdentity(
  repository: GuardrailRepository,
  preview: AcceptedGateTargetPreview,
): void {
  if (
    repository.source !== "github"
    || repository.repositoryPath !== null
    || preview.executor !== "github-actions"
    || preview.repositoryKey !== repository.repositoryKey
    || preview.repositoryAuthority.connectionId !== repository.githubConnectionId
    || preview.repositoryAuthority.installationId !== repository.githubInstallationId
    || preview.repositoryAuthority.repositoryId !== repository.githubRepositoryId
    || !preview.executorCapability.ready
  ) throw new GitHubActionsExecutionError("actions_gate_identity_invalid");
}

function remoteIdentity(
  repository: GuardrailRepository,
  dispatch: GitHubActionsDispatchMetadata,
): {
  connectionId: string;
  installationId: string;
  repositoryId: string;
  owner: string;
  name: string;
} {
  if (
    repository.source !== "github"
    || repository.repositoryPath !== null
    || repository.githubConnectionId !== dispatch.connectionId
    || repository.githubInstallationId !== dispatch.installationId
    || repository.githubRepositoryId !== dispatch.repositoryId
    || repository.remoteOwner === null
    || repository.remoteName === null
  ) throw new GitHubActionsExecutionError("actions_gate_identity_invalid");
  return {
    connectionId: dispatch.connectionId,
    installationId: dispatch.installationId,
    repositoryId: dispatch.repositoryId,
    owner: slug(repository.remoteOwner),
    name: slug(repository.remoteName),
  };
}

function workflowRuns(value: unknown): GitHubActionsRemoteRun[] {
  const root = record(value);
  return array(root.workflow_runs, 100).map(workflowRun);
}

function workflowRun(value: unknown): GitHubActionsRemoteRun {
  const row = record(value);
  const status = row.status;
  if (status !== "queued" && status !== "in_progress" && status !== "completed") invalidRemote();
  if (row.event !== "workflow_dispatch") invalidRemote();
  return {
    id: numericId(row.id),
    attempt: positiveInteger(row.run_attempt),
    event: "workflow_dispatch",
    status,
    conclusion: row.conclusion === null ? null : boundedText(row.conclusion, 100),
    displayTitle: boundedText(row.display_title, 512),
    createdAt: isoTimestamp(row.created_at),
  };
}

function workflowArtifacts(value: unknown): GitHubActionsRemoteArtifact[] {
  const root = record(value);
  return array(root.artifacts, 100).map((entry) => {
    const row = record(entry);
    const run = record(row.workflow_run);
    return {
      id: numericId(row.id),
      name: boundedText(row.name, 255),
      digest: githubDigest(row.digest),
      expired: booleanValue(row.expired),
      workflowRunId: numericId(run.id),
    };
  });
}

function dispatchFailureIsDefinite(error: unknown): boolean {
  const code = error instanceof Error && "code" in error
    ? String((error as Error & { code: unknown }).code)
    : "";
  return [
    "github_connection_revoked",
    "github_credential_rejected",
    "github_credential_unavailable",
    "github_not_found",
    "github_request_rejected",
  ].includes(code);
}

function executionCode(error: unknown): string {
  if (error instanceof GitHubActionsExecutionError) return error.code;
  if (error instanceof Error && /^[a-z][a-z0-9_-]{0,127}$/.test(error.message)) {
    return error.message;
  }
  return "actions_run_failed";
}

function requiredGate(gateId: string, store: GitHubActionsExecutorStore): GateRun {
  const gate = store.getGateRun(gateId);
  if (gate === null) throw new GitHubActionsExecutionError("actions_gate_identity_invalid");
  return gate;
}

function requiredDispatch(
  gateId: string,
  store: GitHubActionsExecutorStore,
): GitHubActionsDispatchMetadata {
  const dispatch = store.getDispatch(gateId);
  if (dispatch === null) throw new GitHubActionsExecutionError("actions_gate_identity_invalid");
  return dispatch;
}

function terminalDispatch(state: GitHubActionsDispatchMetadata["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function terminalGate(status: GateRun["status"]): boolean {
  return status === "completed" || status === "error" || status === "cancelled";
}

function safeIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/.test(normalized)) {
    throw new GitHubActionsExecutionError("actions_gate_identity_invalid");
  }
  return normalized;
}

function fullSha(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new GitHubActionsExecutionError("actions_gate_identity_invalid");
  return value;
}

function githubDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) invalidRemote();
  return value;
}

function numericId(value: unknown): string {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !/^[1-9][0-9]{0,30}$/.test(normalized)) invalidRemote();
  return normalized;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalidRemote();
  return value as number;
}

function slug(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new GitHubActionsExecutionError("actions_gate_identity_invalid");
  return value;
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    invalidRemote();
  }
  return value;
}

function isoTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalidRemote();
  return new Date(value).toISOString();
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") invalidRemote();
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidRemote();
  return value as Record<string, unknown>;
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalidRemote();
  return value;
}

function safeFailureCode(value: string): string {
  return /^[a-z][a-z0-9_-]{0,127}$/.test(value) ? value : "actions_run_failed";
}

function invalidRemote(): never {
  throw new GitHubActionsExecutionError("actions_run_failed");
}
