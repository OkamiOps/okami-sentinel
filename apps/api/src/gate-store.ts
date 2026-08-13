import Database from "better-sqlite3";
import type {
  GateExecutorKind,
  GateMaterializationState,
  GateOutcome,
  GatePublishStatus,
  GateRun,
  GateSource,
  GateStatus,
  GitHubConclusion,
  GuardrailRepository,
} from "@csb/shared";
import { getDb } from "./db.js";
import { migrateGuardrailsSchema } from "./guardrails-migrations.js";

interface GuardrailRepositoryRow {
  repository_key: string;
  repository_path: string | null;
  source: string;
  display_name: string;
  default_branch: string;
  default_executor: string;
  remote_owner: string | null;
  remote_name: string | null;
  github_connection_id: string | null;
  github_installation_id: string | null;
  github_repository_id: string | null;
  enabled: number;
  policy_path: string;
  last_gate_id: string | null;
}

interface GateRunRow {
  id: string;
  repository_key: string;
  repository_path: string | null;
  source: string;
  executor: string;
  base_ref: string;
  head_ref: string;
  resolved_base_sha: string | null;
  resolved_head_sha: string | null;
  policy_sha: string | null;
  pull_request_number: number | null;
  workflow_run_id: string | null;
  materialization_state: string;
  scan_lineage_hash: string | null;
  artifact_schema_version: number;
  scan_id: string | null;
  status: string;
  outcome: string | null;
  policy_version: number;
  baseline_commit: string | null;
  artifact_path: string | null;
  publish_status: string;
  publish_error: string | null;
  published_at: string | null;
  error: string | null;
  cost_ceiling_usd: number;
  estimated_usd: number;
  started_at: string;
  completed_at: string | null;
}

interface GateEventRow {
  sequence: number;
  type: string;
  payload_json: string;
  created_at: string;
}

interface CachedGitHubBaselineRow {
  repository_key: string;
  workflow_run_id: string;
  head_sha: string;
  artifact_path: string;
  fetched_at: string;
}

interface GatePublicationAttemptRow {
  id: string;
  gate_id: string;
  status: string;
  error: string | null;
  created_at: string;
}

export interface CachedGitHubBaseline {
  repositoryKey: string;
  workflowRunId: string;
  headSha: string;
  artifactPath: string;
  fetchedAt: string;
}

export type GatePublicationAttemptStatus = "publishing" | "published" | "failed";

export interface GatePublicationAttempt {
  id: string;
  gateId: string;
  status: GatePublicationAttemptStatus;
  error: string | null;
  createdAt: string;
}

export interface GitHubAppConnectionMetadata {
  id: string;
  appId: string;
  appSlug: string;
  clientId: string;
  status: "ready" | "revoked" | "error";
  createdAt: string;
  updatedAt: string;
}

export interface GitHubAppInstallationMetadata {
  id: string;
  connectionId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  status: "ready" | "suspended" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export interface GitHubInstallationRepositoryMetadata {
  repositoryId: string;
  installationId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  updatedAt: string;
}

export interface MaterializationLeaseMetadata {
  id: string;
  gateId: string;
  repositoryKey: string;
  snapshotIdentity: string;
  state: Exclude<GateMaterializationState, "not_required">;
  createdAt: string;
  expiresAt: string;
  releasedAt: string | null;
}

export interface GitHubActionsArtifactMetadata {
  id: string;
  gateId: string;
  repositoryKey: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  artifactName: string;
  artifactDigest: string;
  artifactSchemaVersion: number;
  status: "pending" | "validated" | "rejected";
  createdAt: string;
  validatedAt: string | null;
}

export type GitHubActionsDispatchState =
  | "dispatch_requested"
  | "dispatch_accepted"
  | "correlating"
  | "running"
  | "artifact_pending"
  | "completed"
  | "failed"
  | "cancelled";

export interface GitHubActionsDispatchMetadata {
  gateId: string;
  repositoryKey: string;
  idempotencyKey: string;
  requestFingerprint: string;
  connectionId: string;
  installationId: string;
  repositoryId: string;
  workflowPath: string;
  workflowRef: string;
  releaseSha: string;
  targetKind: "pull_request" | "compare" | "protected_branch";
  protectedBranch: string;
  expectedRunName: string;
  expectedHeadSha: string;
  state: GitHubActionsDispatchState;
  workflowRunId: string | null;
  workflowRunAttempt: number | null;
  requestedAt: string;
  dispatchedAt: string | null;
  lastPolledAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export type GitHubActionsDispatchUpdate = Partial<Pick<
  GitHubActionsDispatchMetadata,
  | "state"
  | "workflowRunId"
  | "workflowRunAttempt"
  | "dispatchedAt"
  | "lastPolledAt"
  | "completedAt"
  | "error"
>>;

export interface CreateGitHubActionsDispatchResult {
  created: boolean;
  gate: GateRun;
  dispatch: GitHubActionsDispatchMetadata;
}

export type GateRunUpdate = Partial<
  Pick<
    GateRun,
    | "resolvedBaseSha"
    | "resolvedHeadSha"
    | "policySha"
    | "workflowRunId"
    | "materializationState"
    | "scanLineageHash"
    | "artifactSchemaVersion"
    | "scanId"
    | "status"
    | "outcome"
    | "baselineCommit"
    | "artifactPath"
    | "publishStatus"
    | "publishError"
    | "publishedAt"
    | "error"
    | "estimatedUsd"
    | "completedAt"
  >
>;

export type GateEventType = "status" | "scan" | "decision" | "done" | "error";

export interface GateEventPayload {
  artifactAvailable?: boolean;
  code?: string;
  completedAt?: string | null;
  conclusion?: GitHubConclusion | null;
  current?: number;
  estimatedUsd?: number;
  gateId?: string;
  outcome?: GateOutcome | null;
  percent?: number;
  phase?: GateStatus;
  progress?: number;
  scanId?: string | null;
  status?: GateStatus;
  total?: number;
}

export interface GateEvent {
  sequence: number;
  type: GateEventType;
  payload: GateEventPayload;
  createdAt: string;
}

const MAX_EVENT_PAYLOAD_BYTES = 4_096;
const EVENT_TYPES = new Set<GateEventType>([
  "status",
  "scan",
  "decision",
  "done",
  "error",
]);
const EVENT_SUMMARY_KEYS = new Set([
  "artifactAvailable",
  "code",
  "completedAt",
  "conclusion",
  "current",
  "estimatedUsd",
  "gateId",
  "outcome",
  "percent",
  "phase",
  "progress",
  "scanId",
  "status",
  "total",
]);
const GATE_STATUSES = new Set<GateStatus>([
  "queued",
  "resolving",
  "scanning",
  "evaluating",
  "publishing",
  "completed",
  "cancelled",
  "error",
]);
const GATE_OUTCOMES = new Set<GateOutcome>([
  "no_changes",
  "bootstrap",
  "pass",
  "warning",
  "blocked",
  "error",
]);
const GITHUB_CONCLUSIONS = new Set<GitHubConclusion>([
  "success",
  "neutral",
  "failure",
  "action_required",
]);
const EVENT_CODE_PATTERN = /^[a-z][a-z0-9_.:-]*$/i;
const EVENT_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/i;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export function ensureGateSchema(
  database: Database.Database = getDb(),
): void {
  migrateGuardrailsSchema(database);
}

export function recordGatePublicationAttempt(
  attempt: GatePublicationAttempt,
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  database.prepare(
    `INSERT INTO gate_publication_attempts (
       id, gate_id, status, error, created_at
     ) VALUES (
       @id, @gate_id, @status, @error, @created_at
     )
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       error = excluded.error`,
  ).run({
    id: attempt.id,
    gate_id: attempt.gateId,
    status: attempt.status,
    error: attempt.error,
    created_at: attempt.createdAt,
  });
}

export function listGatePublicationAttempts(
  gateId: string,
  database: Database.Database = getDb(),
): GatePublicationAttempt[] {
  ensureGateSchema(database);
  const rows = database.prepare(
    `SELECT id, gate_id, status, error, created_at
     FROM gate_publication_attempts
     WHERE gate_id = ?
     ORDER BY created_at DESC, id DESC`,
  ).all(gateId) as GatePublicationAttemptRow[];
  return rows.map((row) => ({
    id: row.id,
    gateId: row.gate_id,
    status: row.status as GatePublicationAttemptStatus,
    error: row.error,
    createdAt: row.created_at,
  }));
}

export function upsertGitHubAppConnection(
  connection: GitHubAppConnectionMetadata,
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  database.prepare(`
    INSERT INTO github_app_connections (
      id, app_id, app_slug, client_id, status, created_at, updated_at
    ) VALUES (
      @id, @app_id, @app_slug, @client_id, @status, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      app_id = excluded.app_id,
      app_slug = excluded.app_slug,
      client_id = excluded.client_id,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run({
    id: connection.id,
    app_id: connection.appId,
    app_slug: connection.appSlug,
    client_id: connection.clientId,
    status: connection.status,
    created_at: connection.createdAt,
    updated_at: connection.updatedAt,
  });
}

export function listGitHubAppConnections(
  database: Database.Database = getDb(),
): GitHubAppConnectionMetadata[] {
  ensureGateSchema(database);
  const rows = database.prepare(`
    SELECT id, app_id, app_slug, client_id, status, created_at, updated_at
    FROM github_app_connections
    ORDER BY created_at, id
  `).all() as Array<Record<string, string>>;
  return rows.map((row) => ({
    id: row.id!,
    appId: row.app_id!,
    appSlug: row.app_slug!,
    clientId: row.client_id!,
    status: row.status as GitHubAppConnectionMetadata["status"],
    createdAt: row.created_at!,
    updatedAt: row.updated_at!,
  }));
}

export function upsertGitHubAppInstallation(
  installation: GitHubAppInstallationMetadata,
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  database.prepare(`
    INSERT INTO github_app_installations (
      id, connection_id, account_login, account_type, status, created_at, updated_at
    ) VALUES (
      @id, @connection_id, @account_login, @account_type, @status, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      connection_id = excluded.connection_id,
      account_login = excluded.account_login,
      account_type = excluded.account_type,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run({
    id: installation.id,
    connection_id: installation.connectionId,
    account_login: installation.accountLogin,
    account_type: installation.accountType,
    status: installation.status,
    created_at: installation.createdAt,
    updated_at: installation.updatedAt,
  });
}

export function listGitHubAppInstallations(
  connectionId: string,
  database: Database.Database = getDb(),
): GitHubAppInstallationMetadata[] {
  ensureGateSchema(database);
  const rows = database.prepare(`
    SELECT id, connection_id, account_login, account_type, status, created_at, updated_at
    FROM github_app_installations
    WHERE connection_id = ?
    ORDER BY created_at, id
  `).all(connectionId) as Array<Record<string, string>>;
  return rows.map((row) => ({
    id: row.id!,
    connectionId: row.connection_id!,
    accountLogin: row.account_login!,
    accountType: row.account_type as GitHubAppInstallationMetadata["accountType"],
    status: row.status as GitHubAppInstallationMetadata["status"],
    createdAt: row.created_at!,
    updatedAt: row.updated_at!,
  }));
}

export function upsertGitHubInstallationRepository(
  repository: GitHubInstallationRepositoryMetadata,
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  database.prepare(`
    INSERT INTO github_installation_repositories (
      repository_id, installation_id, owner, name, default_branch,
      is_private, archived, updated_at
    ) VALUES (
      @repository_id, @installation_id, @owner, @name, @default_branch,
      @is_private, @archived, @updated_at
    )
    ON CONFLICT(repository_id) DO UPDATE SET
      installation_id = excluded.installation_id,
      owner = excluded.owner,
      name = excluded.name,
      default_branch = excluded.default_branch,
      is_private = excluded.is_private,
      archived = excluded.archived,
      updated_at = excluded.updated_at
  `).run({
    repository_id: repository.repositoryId,
    installation_id: repository.installationId,
    owner: repository.owner,
    name: repository.name,
    default_branch: repository.defaultBranch,
    is_private: repository.private ? 1 : 0,
    archived: repository.archived ? 1 : 0,
    updated_at: repository.updatedAt,
  });
}

export function listGitHubInstallationRepositories(
  installationId: string,
  database: Database.Database = getDb(),
): GitHubInstallationRepositoryMetadata[] {
  ensureGateSchema(database);
  const rows = database.prepare(`
    SELECT repository_id, installation_id, owner, name, default_branch,
           is_private, archived, updated_at
    FROM github_installation_repositories
    WHERE installation_id = ?
    ORDER BY owner COLLATE NOCASE, name COLLATE NOCASE, repository_id
  `).all(installationId) as Array<Record<string, string | number>>;
  return rows.map((row) => ({
    repositoryId: String(row.repository_id),
    installationId: String(row.installation_id),
    owner: String(row.owner),
    name: String(row.name),
    defaultBranch: String(row.default_branch),
    private: row.is_private === 1,
    archived: row.archived === 1,
    updatedAt: String(row.updated_at),
  }));
}

export function upsertMaterializationLease(
  lease: MaterializationLeaseMetadata,
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  database.prepare(`
    INSERT INTO materialization_leases (
      id, gate_id, repository_key, snapshot_identity, state,
      created_at, expires_at, released_at
    ) VALUES (
      @id, @gate_id, @repository_key, @snapshot_identity, @state,
      @created_at, @expires_at, @released_at
    )
    ON CONFLICT(id) DO UPDATE SET
      snapshot_identity = excluded.snapshot_identity,
      state = excluded.state,
      expires_at = excluded.expires_at,
      released_at = excluded.released_at
  `).run({
    id: lease.id,
    gate_id: lease.gateId,
    repository_key: lease.repositoryKey,
    snapshot_identity: lease.snapshotIdentity,
    state: lease.state,
    created_at: lease.createdAt,
    expires_at: lease.expiresAt,
    released_at: lease.releasedAt,
  });
}

export function listMaterializationLeases(
  database: Database.Database = getDb(),
): MaterializationLeaseMetadata[] {
  ensureGateSchema(database);
  const rows = database.prepare(`
    SELECT * FROM materialization_leases
    ORDER BY created_at, id
  `).all() as Array<Record<string, string | null>>;
  return rows.map(materializationLeaseFromRow);
}

export function getMaterializationLease(
  id: string,
  database: Database.Database = getDb(),
): MaterializationLeaseMetadata | null {
  ensureGateSchema(database);
  const row = database.prepare("SELECT * FROM materialization_leases WHERE id = ?").get(id) as
    | Record<string, string | null>
    | undefined;
  if (!row) return null;
  return materializationLeaseFromRow(row);
}

function materializationLeaseFromRow(
  row: Record<string, string | null>,
): MaterializationLeaseMetadata {
  return {
    id: row.id!,
    gateId: row.gate_id!,
    repositoryKey: row.repository_key!,
    snapshotIdentity: row.snapshot_identity!,
    state: row.state as MaterializationLeaseMetadata["state"],
    createdAt: row.created_at!,
    expiresAt: row.expires_at!,
    releasedAt: row.released_at,
  };
}

export function upsertGitHubActionsArtifact(
  artifact: GitHubActionsArtifactMetadata,
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  database.prepare(`
    INSERT INTO github_actions_artifacts (
      id, gate_id, repository_key, workflow_run_id, workflow_run_attempt,
      artifact_name, artifact_digest, artifact_schema_version, status,
      created_at, validated_at
    ) VALUES (
      @id, @gate_id, @repository_key, @workflow_run_id, @workflow_run_attempt,
      @artifact_name, @artifact_digest, @artifact_schema_version, @status,
      @created_at, @validated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      artifact_digest = excluded.artifact_digest,
      artifact_schema_version = excluded.artifact_schema_version,
      status = excluded.status,
      validated_at = excluded.validated_at
  `).run({
    id: artifact.id,
    gate_id: artifact.gateId,
    repository_key: artifact.repositoryKey,
    workflow_run_id: artifact.workflowRunId,
    workflow_run_attempt: artifact.workflowRunAttempt,
    artifact_name: artifact.artifactName,
    artifact_digest: artifact.artifactDigest,
    artifact_schema_version: artifact.artifactSchemaVersion,
    status: artifact.status,
    created_at: artifact.createdAt,
    validated_at: artifact.validatedAt,
  });
}

export function getGitHubActionsArtifact(
  id: string,
  database: Database.Database = getDb(),
): GitHubActionsArtifactMetadata | null {
  ensureGateSchema(database);
  const row = database.prepare("SELECT * FROM github_actions_artifacts WHERE id = ?").get(id) as
    | Record<string, string | number | null>
    | undefined;
  if (!row) return null;
  return githubActionsArtifactFromRow(row);
}

function githubActionsArtifactFromRow(
  row: Record<string, string | number | null>,
): GitHubActionsArtifactMetadata {
  return {
    id: String(row.id),
    gateId: String(row.gate_id),
    repositoryKey: String(row.repository_key),
    workflowRunId: String(row.workflow_run_id),
    workflowRunAttempt: Number(row.workflow_run_attempt),
    artifactName: String(row.artifact_name),
    artifactDigest: String(row.artifact_digest),
    artifactSchemaVersion: Number(row.artifact_schema_version),
    status: row.status as GitHubActionsArtifactMetadata["status"],
    createdAt: String(row.created_at),
    validatedAt: row.validated_at === null ? null : String(row.validated_at),
  };
}

export function createGitHubActionsDispatchGate(
  run: GateRun,
  dispatch: GitHubActionsDispatchMetadata,
  database: Database.Database = getDb(),
): CreateGitHubActionsDispatchResult {
  ensureGateSchema(database);
  const create = database.transaction((): CreateGitHubActionsDispatchResult => {
    const existing = database.prepare(`
      SELECT * FROM github_actions_dispatches
      WHERE repository_key = ? AND idempotency_key = ?
    `).get(dispatch.repositoryKey, dispatch.idempotencyKey) as
      | Record<string, string | number | null>
      | undefined;
    if (existing !== undefined) {
      const persistedDispatch = githubActionsDispatchFromRow(existing);
      const persistedGate = getGateRun(persistedDispatch.gateId, database);
      if (persistedGate === null) throw new Error("GitHub Actions dispatch gate is missing");
      return { created: false, gate: persistedGate, dispatch: persistedDispatch };
    }

    insertGateRun(run, database);
    database.prepare(`
      INSERT INTO github_actions_dispatches (
        gate_id, repository_key, idempotency_key, request_fingerprint,
        connection_id, installation_id, repository_id, workflow_path,
        workflow_ref, release_sha, target_kind, protected_branch,
        expected_run_name, expected_head_sha, state, workflow_run_id,
        workflow_run_attempt, requested_at, dispatched_at, last_polled_at,
        completed_at, error
      ) VALUES (
        @gate_id, @repository_key, @idempotency_key, @request_fingerprint,
        @connection_id, @installation_id, @repository_id, @workflow_path,
        @workflow_ref, @release_sha, @target_kind, @protected_branch,
        @expected_run_name, @expected_head_sha, @state, @workflow_run_id,
        @workflow_run_attempt, @requested_at, @dispatched_at, @last_polled_at,
        @completed_at, @error
      )
    `).run(githubActionsDispatchToParams(dispatch));
    return { created: true, gate: run, dispatch };
  });
  return create.immediate();
}

export function getGitHubActionsDispatch(
  gateId: string,
  database: Database.Database = getDb(),
): GitHubActionsDispatchMetadata | null {
  ensureGateSchema(database);
  const row = database.prepare(
    "SELECT * FROM github_actions_dispatches WHERE gate_id = ?",
  ).get(gateId) as Record<string, string | number | null> | undefined;
  return row === undefined ? null : githubActionsDispatchFromRow(row);
}

export function listPendingGitHubActionsDispatches(
  database: Database.Database = getDb(),
): GitHubActionsDispatchMetadata[] {
  ensureGateSchema(database);
  const rows = database.prepare(`
    SELECT * FROM github_actions_dispatches
    WHERE state NOT IN ('completed', 'failed', 'cancelled')
    ORDER BY requested_at, gate_id
  `).all() as Array<Record<string, string | number | null>>;
  return rows.map(githubActionsDispatchFromRow);
}

export function updateGitHubActionsDispatch(
  gateId: string,
  updates: GitHubActionsDispatchUpdate,
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  const assignments: string[] = [];
  const params: Record<string, unknown> = { gate_id: gateId };
  const columns: Array<[keyof GitHubActionsDispatchUpdate, string]> = [
    ["state", "state"],
    ["workflowRunId", "workflow_run_id"],
    ["workflowRunAttempt", "workflow_run_attempt"],
    ["dispatchedAt", "dispatched_at"],
    ["lastPolledAt", "last_polled_at"],
    ["completedAt", "completed_at"],
    ["error", "error"],
  ];
  for (const [key, column] of columns) {
    if (updates[key] === undefined) continue;
    assignments.push(`${column} = @${column}`);
    params[column] = updates[key];
  }
  if (assignments.length === 0) return;
  const result = database.prepare(`
    UPDATE github_actions_dispatches
    SET ${assignments.join(", ")}
    WHERE gate_id = @gate_id
  `).run(params);
  if (result.changes !== 1) throw new Error("GitHub Actions dispatch is missing");
}

export function reserveGitHubActionsArtifact(
  artifact: GitHubActionsArtifactMetadata,
  database: Database.Database = getDb(),
): "created" | "existing" {
  ensureGateSchema(database);
  const reserve = database.transaction(() => {
    const existingById = getGitHubActionsArtifact(artifact.id, database);
    const existingByRun = database.prepare(`
      SELECT * FROM github_actions_artifacts
      WHERE repository_key = ? AND workflow_run_id = ?
        AND workflow_run_attempt = ? AND artifact_name = ?
    `).get(
      artifact.repositoryKey,
      artifact.workflowRunId,
      artifact.workflowRunAttempt,
      artifact.artifactName,
    ) as Record<string, string | number | null> | undefined;
    const existing = existingById ?? (
      existingByRun === undefined ? null : githubActionsArtifactFromRow(existingByRun)
    );
    if (existing !== null) {
      if (
        existing.id !== artifact.id
        || existing.gateId !== artifact.gateId
        || existing.repositoryKey !== artifact.repositoryKey
        || existing.workflowRunId !== artifact.workflowRunId
        || existing.workflowRunAttempt !== artifact.workflowRunAttempt
        || existing.artifactName !== artifact.artifactName
        || existing.artifactDigest !== artifact.artifactDigest
        || existing.artifactSchemaVersion !== artifact.artifactSchemaVersion
      ) {
        throw new Error("GitHub Actions artifact identity conflict");
      }
      return "existing" as const;
    }
    upsertGitHubActionsArtifact(artifact, database);
    return "created" as const;
  });
  return reserve.immediate();
}

export function finalizeGitHubActionsArtifact(
  input: {
    artifactId: string;
    artifactStatus: "validated" | "rejected";
    validatedAt: string;
    gateId: string;
    gateUpdates?: GateRunUpdate;
    dispatchUpdates: GitHubActionsDispatchUpdate;
  },
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  const finalize = database.transaction(() => {
    const result = database.prepare(`
      UPDATE github_actions_artifacts
      SET status = ?, validated_at = ?
      WHERE id = ? AND status IN ('pending', ?)
    `).run(input.artifactStatus, input.validatedAt, input.artifactId, input.artifactStatus);
    if (result.changes !== 1) throw new Error("GitHub Actions artifact is missing");
    if (input.gateUpdates !== undefined) {
      updateGateRun(input.gateId, input.gateUpdates, database);
    }
    updateGitHubActionsDispatch(input.gateId, input.dispatchUpdates, database);
  });
  finalize.immediate();
}

export function getCachedGitHubBaseline(
  repositoryKey: string,
  database: Database.Database = getDb(),
): CachedGitHubBaseline | null {
  ensureGateSchema(database);
  const row = database
    .prepare("SELECT * FROM github_baselines WHERE repository_key = ?")
    .get(repositoryKey) as CachedGitHubBaselineRow | undefined;
  if (row === undefined) return null;
  return {
    repositoryKey: row.repository_key,
    workflowRunId: row.workflow_run_id,
    headSha: row.head_sha,
    artifactPath: row.artifact_path,
    fetchedAt: row.fetched_at,
  };
}

export function upsertCachedGitHubBaseline(
  baseline: CachedGitHubBaseline,
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  database
    .prepare(
      `INSERT INTO github_baselines (
         repository_key, workflow_run_id, head_sha, artifact_path, fetched_at
       ) VALUES (
         @repository_key, @workflow_run_id, @head_sha, @artifact_path, @fetched_at
       )
       ON CONFLICT(repository_key) DO UPDATE SET
         workflow_run_id = excluded.workflow_run_id,
         head_sha = excluded.head_sha,
         artifact_path = excluded.artifact_path,
         fetched_at = excluded.fetched_at`,
    )
    .run({
      repository_key: baseline.repositoryKey,
      workflow_run_id: baseline.workflowRunId,
      head_sha: baseline.headSha,
      artifact_path: baseline.artifactPath,
      fetched_at: baseline.fetchedAt,
    });
}

export function upsertGuardrailRepository(
  repository: GuardrailRepository,
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO guardrail_repositories (
         repository_key, repository_path, source, display_name, default_branch, default_executor,
         remote_owner, remote_name, github_connection_id,
         github_installation_id, github_repository_id, enabled, policy_path,
         created_at, updated_at
       ) VALUES (
         @repository_key, @repository_path, @source, @display_name, @default_branch, @default_executor,
         @remote_owner, @remote_name, @github_connection_id,
         @github_installation_id, @github_repository_id, @enabled, @policy_path,
         @created_at, @updated_at
       )
       ON CONFLICT(repository_key) DO UPDATE SET
         repository_path = excluded.repository_path,
         source = excluded.source,
         display_name = excluded.display_name,
         default_branch = excluded.default_branch,
         default_executor = excluded.default_executor,
         remote_owner = excluded.remote_owner,
         remote_name = excluded.remote_name,
         github_connection_id = excluded.github_connection_id,
         github_installation_id = excluded.github_installation_id,
         github_repository_id = excluded.github_repository_id,
         enabled = excluded.enabled,
         policy_path = excluded.policy_path,
         updated_at = excluded.updated_at`,
    )
    .run({
      repository_key: repository.repositoryKey,
      repository_path: repository.repositoryPath,
      source: repository.source,
      display_name: repository.displayName,
      default_branch: repository.defaultBranch,
      default_executor: repository.defaultExecutor,
      remote_owner:
        repository.remoteOwner === null ? null : repository.remoteOwner,
      remote_name: repository.remoteName === null ? null : repository.remoteName,
      github_connection_id: repository.githubConnectionId,
      github_installation_id: repository.githubInstallationId,
      github_repository_id: repository.githubRepositoryId,
      enabled: repository.enabled === true ? 1 : 0,
      policy_path: repository.policyPath,
      created_at: now,
      updated_at: now,
    });
}

export function listGuardrailRepositories(
  database: Database.Database = getDb(),
): GuardrailRepository[] {
  ensureGateSchema(database);
  const rows = database
    .prepare(
      `SELECT repositories.*,
         (
           SELECT gate_runs.id
           FROM gate_runs
           WHERE gate_runs.repository_key = repositories.repository_key
           ORDER BY gate_runs.started_at DESC, gate_runs.id DESC
           LIMIT 1
         ) AS last_gate_id
       FROM guardrail_repositories repositories
       ORDER BY repositories.display_name COLLATE NOCASE, repositories.repository_key`,
    )
    .all() as GuardrailRepositoryRow[];

  return rows.map(rowToGuardrailRepository);
}

export function insertGateRun(
  run: GateRun,
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  database
    .prepare(
      `INSERT INTO gate_runs (
         id, repository_key, repository_path, source, executor, base_ref, head_ref,
         resolved_base_sha, resolved_head_sha, policy_sha, pull_request_number,
         workflow_run_id, materialization_state, scan_lineage_hash,
         artifact_schema_version, scan_id, status, outcome, policy_version,
         baseline_commit, artifact_path, publish_status, publish_error,
         published_at, error, cost_ceiling_usd, estimated_usd, started_at, completed_at
       ) VALUES (
         @id, @repository_key, @repository_path, @source, @executor, @base_ref, @head_ref,
         @resolved_base_sha, @resolved_head_sha, @policy_sha, @pull_request_number,
         @workflow_run_id, @materialization_state, @scan_lineage_hash,
         @artifact_schema_version, @scan_id, @status, @outcome, @policy_version,
         @baseline_commit, @artifact_path, @publish_status, @publish_error,
         @published_at, @error, @cost_ceiling_usd, @estimated_usd, @started_at, @completed_at
       )`,
    )
    .run(gateRunToParams(run));
}

export function updateGateRun(
  id: string,
  updates: GateRunUpdate,
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  const assignments: string[] = [];
  const params: Record<string, unknown> = { id };

  if (updates.resolvedBaseSha !== undefined) {
    assignments.push("resolved_base_sha = @resolved_base_sha");
    params.resolved_base_sha = updates.resolvedBaseSha;
  }
  if (updates.resolvedHeadSha !== undefined) {
    assignments.push("resolved_head_sha = @resolved_head_sha");
    params.resolved_head_sha = updates.resolvedHeadSha;
  }
  if (updates.policySha !== undefined) {
    assignments.push("policy_sha = @policy_sha");
    params.policy_sha = updates.policySha;
  }
  if (updates.workflowRunId !== undefined) {
    assignments.push("workflow_run_id = @workflow_run_id");
    params.workflow_run_id = updates.workflowRunId;
  }
  if (updates.materializationState !== undefined) {
    assignments.push("materialization_state = @materialization_state");
    params.materialization_state = updates.materializationState;
  }
  if (updates.scanLineageHash !== undefined) {
    assignments.push("scan_lineage_hash = @scan_lineage_hash");
    params.scan_lineage_hash = updates.scanLineageHash;
  }
  if (updates.artifactSchemaVersion !== undefined) {
    assignments.push("artifact_schema_version = @artifact_schema_version");
    params.artifact_schema_version = updates.artifactSchemaVersion;
  }
  if (updates.scanId !== undefined) {
    assignments.push("scan_id = @scan_id");
    params.scan_id = updates.scanId === null ? null : updates.scanId;
  }
  if (updates.status !== undefined) {
    assignments.push("status = @status");
    params.status = updates.status;
  }
  if (updates.outcome !== undefined) {
    assignments.push("outcome = @outcome");
    params.outcome = updates.outcome === null ? null : updates.outcome;
  }
  if (updates.baselineCommit !== undefined) {
    assignments.push("baseline_commit = @baseline_commit");
    params.baseline_commit =
      updates.baselineCommit === null ? null : updates.baselineCommit;
  }
  if (updates.artifactPath !== undefined) {
    assignments.push("artifact_path = @artifact_path");
    params.artifact_path =
      updates.artifactPath === null ? null : updates.artifactPath;
  }
  if (updates.publishStatus !== undefined) {
    assignments.push("publish_status = @publish_status");
    params.publish_status = updates.publishStatus;
  }
  if (updates.publishError !== undefined) {
    assignments.push("publish_error = @publish_error");
    params.publish_error = updates.publishError === null ? null : updates.publishError;
  }
  if (updates.publishedAt !== undefined) {
    assignments.push("published_at = @published_at");
    params.published_at = updates.publishedAt === null ? null : updates.publishedAt;
  }
  if (updates.error !== undefined) {
    assignments.push("error = @error");
    params.error = updates.error === null ? null : updates.error;
  }
  if (updates.estimatedUsd !== undefined) {
    assignments.push("estimated_usd = @estimated_usd");
    params.estimated_usd = updates.estimatedUsd;
  }
  if (updates.completedAt !== undefined) {
    assignments.push("completed_at = @completed_at");
    params.completed_at =
      updates.completedAt === null ? null : updates.completedAt;
  }

  if (assignments.length === 0) return;
  database
    .prepare(`UPDATE gate_runs SET ${assignments.join(", ")} WHERE id = @id`)
    .run(params);
}

export function getGateRun(
  id: string,
  database: Database.Database = getDb(),
): GateRun | null {
  ensureGateSchema(database);
  const row = database
    .prepare("SELECT * FROM gate_runs WHERE id = ?")
    .get(id) as GateRunRow | undefined;
  return row === undefined ? null : rowToGateRun(row);
}

export function listGateRuns(
  repositoryKey: string | null = null,
  database: Database.Database = getDb(),
): GateRun[] {
  ensureGateSchema(database);
  const rows =
    repositoryKey === null
      ? (database
          .prepare("SELECT * FROM gate_runs ORDER BY started_at DESC, id DESC")
          .all() as GateRunRow[])
      : (database
          .prepare(
            `SELECT * FROM gate_runs
             WHERE repository_key = ?
             ORDER BY started_at DESC, id DESC`,
          )
          .all(repositoryKey) as GateRunRow[]);
  return rows.map(rowToGateRun);
}

export function deleteGateRun(
  id: string,
  database: Database.Database = getDb(),
): boolean {
  ensureGateSchema(database);
  return database.transaction(() => {
    database.prepare("DELETE FROM gate_events WHERE gate_id = ?").run(id);
    database.prepare("DELETE FROM gate_publication_attempts WHERE gate_id = ?").run(id);
    database.prepare("DELETE FROM github_actions_artifacts WHERE gate_id = ?").run(id);
    database.prepare("DELETE FROM github_actions_dispatches WHERE gate_id = ?").run(id);
    database.prepare("DELETE FROM materialization_leases WHERE gate_id = ?").run(id);
    return database.prepare("DELETE FROM gate_runs WHERE id = ?").run(id).changes === 1;
  })();
}

export function appendGateEvent(
  gateId: string,
  event: GateEvent,
  database: Database.Database = getDb(),
): void {
  ensureGateSchema(database);
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
    throw new Error("Gate event sequence must be a non-negative safe integer");
  }
  if (!EVENT_TYPES.has(event.type)) {
    throw new Error("Unsupported gate event type");
  }

  const payloadJson = serializeEventPayload(event.payload);
  database
    .prepare(
      `INSERT INTO gate_events (
         gate_id, sequence, type, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(gateId, event.sequence, event.type, payloadJson, event.createdAt);
}

export function listGateEvents(
  gateId: string,
  database: Database.Database = getDb(),
): GateEvent[] {
  ensureGateSchema(database);
  const rows = database
    .prepare(
      `SELECT sequence, type, payload_json, created_at
       FROM gate_events
       WHERE gate_id = ?
       ORDER BY sequence`,
    )
    .all(gateId) as GateEventRow[];

  return rows.map((row) => ({
    sequence: row.sequence,
    type: row.type as GateEventType,
    payload: JSON.parse(row.payload_json) as GateEventPayload,
    createdAt: row.created_at,
  }));
}

function rowToGuardrailRepository(
  row: GuardrailRepositoryRow,
): GuardrailRepository {
  const remoteOwner = row.remote_owner === null ? null : row.remote_owner;
  const remoteName = row.remote_name === null ? null : row.remote_name;
  return {
    repositoryKey: row.repository_key,
    repositoryPath: row.repository_path,
    source: row.source as GateSource,
    displayName: row.display_name,
    defaultBranch: row.default_branch,
    defaultExecutor: row.default_executor as GateExecutorKind,
    remoteOwner,
    remoteName,
    githubConnectionId: row.github_connection_id,
    githubInstallationId: row.github_installation_id,
    githubRepositoryId: row.github_repository_id,
    enabled: row.enabled === 1,
    policyPath: row.policy_path,
    lastGateId: row.last_gate_id === null ? null : row.last_gate_id,
    githubStatus:
      remoteOwner !== null && remoteName !== null
        ? "not_checked"
        : "not_configured",
  };
}

function gateRunToParams(run: GateRun): Record<string, unknown> {
  return {
    id: run.id,
    repository_key: run.repositoryKey,
    repository_path: run.repositoryPath,
    source: run.source,
    executor: run.executor,
    base_ref: run.baseRef,
    head_ref: run.headRef,
    resolved_base_sha: run.resolvedBaseSha,
    resolved_head_sha: run.resolvedHeadSha,
    policy_sha: run.policySha,
    pull_request_number:
      run.pullRequestNumber === null ? null : run.pullRequestNumber,
    workflow_run_id: run.workflowRunId,
    materialization_state: run.materializationState,
    scan_lineage_hash: run.scanLineageHash,
    artifact_schema_version: run.artifactSchemaVersion,
    scan_id: run.scanId === null ? null : run.scanId,
    status: run.status,
    outcome: run.outcome === null ? null : run.outcome,
    policy_version: run.policyVersion,
    baseline_commit:
      run.baselineCommit === null ? null : run.baselineCommit,
    artifact_path: run.artifactPath === null ? null : run.artifactPath,
    publish_status: run.publishStatus,
    publish_error: run.publishError === null ? null : run.publishError,
    published_at: run.publishedAt === null ? null : run.publishedAt,
    error: run.error === null ? null : run.error,
    cost_ceiling_usd: run.costCeilingUsd,
    estimated_usd: run.estimatedUsd,
    started_at: run.startedAt,
    completed_at: run.completedAt === null ? null : run.completedAt,
  };
}

function rowToGateRun(row: GateRunRow): GateRun {
  return {
    id: row.id,
    repositoryKey: row.repository_key,
    repositoryPath: row.repository_path,
    source: row.source as GateSource,
    executor: row.executor as GateExecutorKind,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    resolvedBaseSha: row.resolved_base_sha,
    resolvedHeadSha: row.resolved_head_sha,
    policySha: row.policy_sha,
    pullRequestNumber:
      row.pull_request_number === null ? null : row.pull_request_number,
    workflowRunId: row.workflow_run_id,
    materializationState: row.materialization_state as GateMaterializationState,
    scanLineageHash: row.scan_lineage_hash,
    artifactSchemaVersion: row.artifact_schema_version,
    scanId: row.scan_id === null ? null : row.scan_id,
    status: row.status as GateStatus,
    outcome: row.outcome === null ? null : (row.outcome as GateOutcome),
    policyVersion: row.policy_version,
    baselineCommit:
      row.baseline_commit === null ? null : row.baseline_commit,
    artifactPath: row.artifact_path === null ? null : row.artifact_path,
    publishStatus: row.publish_status as GatePublishStatus,
    publishError: row.publish_error === null ? null : row.publish_error,
    publishedAt: row.published_at === null ? null : row.published_at,
    error: row.error === null ? null : row.error,
    costCeilingUsd: row.cost_ceiling_usd,
    estimatedUsd: row.estimated_usd,
    startedAt: row.started_at,
    completedAt: row.completed_at === null ? null : row.completed_at,
  };
}

function githubActionsDispatchToParams(
  dispatch: GitHubActionsDispatchMetadata,
): Record<string, unknown> {
  return {
    gate_id: dispatch.gateId,
    repository_key: dispatch.repositoryKey,
    idempotency_key: dispatch.idempotencyKey,
    request_fingerprint: dispatch.requestFingerprint,
    connection_id: dispatch.connectionId,
    installation_id: dispatch.installationId,
    repository_id: dispatch.repositoryId,
    workflow_path: dispatch.workflowPath,
    workflow_ref: dispatch.workflowRef,
    release_sha: dispatch.releaseSha,
    target_kind: dispatch.targetKind,
    protected_branch: dispatch.protectedBranch,
    expected_run_name: dispatch.expectedRunName,
    expected_head_sha: dispatch.expectedHeadSha,
    state: dispatch.state,
    workflow_run_id: dispatch.workflowRunId,
    workflow_run_attempt: dispatch.workflowRunAttempt,
    requested_at: dispatch.requestedAt,
    dispatched_at: dispatch.dispatchedAt,
    last_polled_at: dispatch.lastPolledAt,
    completed_at: dispatch.completedAt,
    error: dispatch.error,
  };
}

function githubActionsDispatchFromRow(
  row: Record<string, string | number | null>,
): GitHubActionsDispatchMetadata {
  return {
    gateId: String(row.gate_id),
    repositoryKey: String(row.repository_key),
    idempotencyKey: String(row.idempotency_key),
    requestFingerprint: String(row.request_fingerprint),
    connectionId: String(row.connection_id),
    installationId: String(row.installation_id),
    repositoryId: String(row.repository_id),
    workflowPath: String(row.workflow_path),
    workflowRef: String(row.workflow_ref),
    releaseSha: String(row.release_sha),
    targetKind: row.target_kind as GitHubActionsDispatchMetadata["targetKind"],
    protectedBranch: String(row.protected_branch),
    expectedRunName: String(row.expected_run_name),
    expectedHeadSha: String(row.expected_head_sha),
    state: row.state as GitHubActionsDispatchState,
    workflowRunId: row.workflow_run_id === null ? null : String(row.workflow_run_id),
    workflowRunAttempt:
      row.workflow_run_attempt === null ? null : Number(row.workflow_run_attempt),
    requestedAt: String(row.requested_at),
    dispatchedAt: row.dispatched_at === null ? null : String(row.dispatched_at),
    lastPolledAt: row.last_polled_at === null ? null : String(row.last_polled_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    error: row.error === null ? null : String(row.error),
  };
}

function serializeEventPayload(payload: GateEventPayload): string {
  if (
    payload === null ||
    Array.isArray(payload) ||
    (Object.getPrototypeOf(payload) !== Object.prototype &&
      Object.getPrototypeOf(payload) !== null)
  ) {
    throw new Error(
      "Gate event payload must be a plain status or progress summary",
    );
  }

  const canonicalPayload: Record<string, string | number | boolean | null> =
    Object.create(null) as Record<string, string | number | boolean | null>;
  for (const key of Reflect.ownKeys(payload)) {
    if (typeof key !== "string") {
      throw new Error("Gate event payload must be a status or progress summary");
    }
    const descriptor = Object.getOwnPropertyDescriptor(payload, key);
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error("Gate event payload accessors are not supported");
    }
    if (!descriptor.enumerable) continue;

    const value = descriptor.value;
    if (value === payload) {
      throw new Error("Gate event payload must be JSON serializable");
    }
    if (!EVENT_SUMMARY_KEYS.has(key) || !isEventSummaryScalar(value)) {
      throw new Error("Gate event payload must be a status or progress summary");
    }
    canonicalPayload[key] = value;
  }

  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(canonicalPayload);
  } catch {
    throw new Error("Gate event payload must be JSON serializable");
  }
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error("Gate event payload is too large");
  }
  for (const [key, value] of Object.entries(canonicalPayload)) {
    if (!isTypedEventSummaryValue(key, value)) {
      throw new Error("Gate event payload must be a status or progress summary");
    }
    if (key === "completedAt" && typeof value === "string") {
      canonicalPayload[key] = normalizeIsoTimestamp(value) as string;
    }
  }
  return JSON.stringify(canonicalPayload);
}

function isEventSummaryScalar(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isTypedEventSummaryValue(
  key: string,
  value: string | number | boolean | null,
): boolean {
  switch (key) {
    case "status":
    case "phase":
      return typeof value === "string" && GATE_STATUSES.has(value as GateStatus);
    case "outcome":
      return (
        value === null ||
        (typeof value === "string" && GATE_OUTCOMES.has(value as GateOutcome))
      );
    case "conclusion":
      return (
        value === null ||
        (typeof value === "string" &&
          GITHUB_CONCLUSIONS.has(value as GitHubConclusion))
      );
    case "code":
      return (
        typeof value === "string" &&
        value.length <= 128 &&
        EVENT_CODE_PATTERN.test(value)
      );
    case "gateId":
      return isBoundedEventId(value, false);
    case "scanId":
      return isBoundedEventId(value, true);
    case "completedAt":
      return (
        value === null ||
        (typeof value === "string" && normalizeIsoTimestamp(value) !== undefined)
      );
    case "current":
    case "total":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      );
    case "percent":
    case "progress":
      return typeof value === "number" && value >= 0 && value <= 100;
    case "estimatedUsd":
      return typeof value === "number" && value >= 0;
    case "artifactAvailable":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function isBoundedEventId(
  value: string | number | boolean | null,
  nullable: boolean,
): boolean {
  if (value === null) return nullable;
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    EVENT_ID_PATTERN.test(value)
  );
}

function normalizeIsoTimestamp(value: string): string | undefined {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }

  const instant = Date.parse(value);
  return Number.isFinite(instant)
    ? new Date(instant).toISOString()
    : undefined;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear =
      year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
