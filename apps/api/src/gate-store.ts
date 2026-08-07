import Database from "better-sqlite3";
import type {
  GateOutcome,
  GateRun,
  GateSource,
  GateStatus,
  GitHubConclusion,
  GuardrailRepository,
} from "@csb/shared";
import { getDb } from "./db.js";

interface GuardrailRepositoryRow {
  repository_key: string;
  repository_path: string;
  display_name: string;
  default_branch: string;
  remote_owner: string | null;
  remote_name: string | null;
  enabled: number;
  policy_path: string;
  last_gate_id: string | null;
}

interface GateRunRow {
  id: string;
  repository_key: string;
  repository_path: string;
  source: string;
  base_ref: string;
  head_ref: string;
  pull_request_number: number | null;
  scan_id: string | null;
  status: string;
  outcome: string | null;
  policy_version: number;
  baseline_commit: string | null;
  artifact_path: string | null;
  error: string | null;
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

export type GateRunUpdate = Partial<
  Pick<
    GateRun,
    | "scanId"
    | "status"
    | "outcome"
    | "baselineCommit"
    | "artifactPath"
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

export function ensureGateSchema(
  database: Database.Database = getDb(),
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS guardrail_repositories (
      repository_key TEXT PRIMARY KEY,
      repository_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      remote_owner TEXT,
      remote_name TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      policy_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gate_runs (
      id TEXT PRIMARY KEY,
      repository_key TEXT NOT NULL,
      repository_path TEXT NOT NULL,
      source TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      head_ref TEXT NOT NULL,
      pull_request_number INTEGER,
      scan_id TEXT,
      status TEXT NOT NULL,
      outcome TEXT,
      policy_version INTEGER NOT NULL,
      baseline_commit TEXT,
      artifact_path TEXT,
      error TEXT,
      estimated_usd REAL NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS gate_runs_by_repository_started
      ON gate_runs(repository_key, started_at DESC);

    CREATE TABLE IF NOT EXISTS gate_events (
      gate_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (gate_id, sequence)
    );
  `);
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
         repository_key, repository_path, display_name, default_branch,
         remote_owner, remote_name, enabled, policy_path, created_at, updated_at
       ) VALUES (
         @repository_key, @repository_path, @display_name, @default_branch,
         @remote_owner, @remote_name, @enabled, @policy_path, @created_at, @updated_at
       )
       ON CONFLICT(repository_key) DO UPDATE SET
         repository_path = excluded.repository_path,
         display_name = excluded.display_name,
         default_branch = excluded.default_branch,
         remote_owner = excluded.remote_owner,
         remote_name = excluded.remote_name,
         enabled = excluded.enabled,
         policy_path = excluded.policy_path,
         updated_at = excluded.updated_at`,
    )
    .run({
      repository_key: repository.repositoryKey,
      repository_path: repository.repositoryPath,
      display_name: repository.displayName,
      default_branch: repository.defaultBranch,
      remote_owner:
        repository.remoteOwner === null ? null : repository.remoteOwner,
      remote_name: repository.remoteName === null ? null : repository.remoteName,
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
         id, repository_key, repository_path, source, base_ref, head_ref,
         pull_request_number, scan_id, status, outcome, policy_version,
         baseline_commit, artifact_path, error, estimated_usd, started_at,
         completed_at
       ) VALUES (
         @id, @repository_key, @repository_path, @source, @base_ref, @head_ref,
         @pull_request_number, @scan_id, @status, @outcome, @policy_version,
         @baseline_commit, @artifact_path, @error, @estimated_usd, @started_at,
         @completed_at
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
    displayName: row.display_name,
    defaultBranch: row.default_branch,
    remoteOwner,
    remoteName,
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
    base_ref: run.baseRef,
    head_ref: run.headRef,
    pull_request_number:
      run.pullRequestNumber === null ? null : run.pullRequestNumber,
    scan_id: run.scanId === null ? null : run.scanId,
    status: run.status,
    outcome: run.outcome === null ? null : run.outcome,
    policy_version: run.policyVersion,
    baseline_commit:
      run.baselineCommit === null ? null : run.baselineCommit,
    artifact_path: run.artifactPath === null ? null : run.artifactPath,
    error: run.error === null ? null : run.error,
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
    baseRef: row.base_ref,
    headRef: row.head_ref,
    pullRequestNumber:
      row.pull_request_number === null ? null : row.pull_request_number,
    scanId: row.scan_id === null ? null : row.scan_id,
    status: row.status as GateStatus,
    outcome: row.outcome === null ? null : (row.outcome as GateOutcome),
    policyVersion: row.policy_version,
    baselineCommit:
      row.baseline_commit === null ? null : row.baseline_commit,
    artifactPath: row.artifact_path === null ? null : row.artifact_path,
    error: row.error === null ? null : row.error,
    estimatedUsd: row.estimated_usd,
    startedAt: row.started_at,
    completedAt: row.completed_at === null ? null : row.completed_at,
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
  }
  return payloadJson;
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
        (typeof value === "string" &&
          value.length <= 64 &&
          Number.isFinite(Date.parse(value)))
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
