import { randomUUID } from "node:crypto";

import type { StoredProviderConnection } from "../connections-store.js";
import {
  VaultError,
  type CredentialVault,
} from "../credentials/credential-vault.js";

export type RemoteAgentJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface RemoteAgentStatus {
  status: RemoteAgentJobStatus;
  terminal: boolean;
}

export interface CursorBackgroundAgentCreateInput {
  repositoryUrl: string;
  branch: string;
  instructions: string;
  apiKey: string;
  signal: AbortSignal;
}

export interface CursorBackgroundAgentCreateResult {
  agentId: string;
  runId: string;
  status: "queued" | "running";
}

export interface CursorBackgroundAgentRequest {
  agentId: string;
  runId: string;
  apiKey: string;
  signal?: AbortSignal;
}

/**
 * The narrow remote API seam. The only bearer value is an in-memory argument
 * during an individual request; implementations must never retain it.
 */
export interface CursorBackgroundAgentsClient {
  create(input: CursorBackgroundAgentCreateInput): Promise<CursorBackgroundAgentCreateResult>;
  status(input: CursorBackgroundAgentRequest): Promise<RemoteAgentStatus>;
  cancel(input: CursorBackgroundAgentRequest): Promise<void>;
}

export interface RemoteAgentJobRecord {
  remoteJobId: string;
  connectionId: string;
  agentId: string;
  runId: string;
  status: RemoteAgentJobStatus;
}

export interface RemoteAgentJobStore {
  get(remoteJobId: string): RemoteAgentJobRecord | null;
  put(job: RemoteAgentJobRecord): void;
  update(remoteJobId: string, status: RemoteAgentJobStatus): RemoteAgentJobRecord | null;
}

export interface RemoteAgentConnectionStore {
  get(id: string): StoredProviderConnection | null;
}

export type RemoteAgentJobErrorCode =
  | "remote_repository_confirmation_required"
  | "remote_repository_invalid"
  | "remote_branch_required"
  | "remote_instructions_invalid"
  | "remote_job_not_found"
  | "remote_job_cancelled"
  | "remote_job_deadline_exceeded"
  | "credential_rejected"
  | "secure_storage_unavailable"
  | "endpoint_access_denied"
  | "rate_limited"
  | "provider_unreachable"
  | "protocol_unsupported";

/** Safe, closed errors for the remote-job boundary. */
export class RemoteAgentJobError extends Error {
  constructor(readonly code: RemoteAgentJobErrorCode) {
    super(code);
    this.name = "RemoteAgentJobError";
  }
}

export interface RemoteAgentJobRunner {
  create(input: {
    connectionId: string;
    repositoryUrl: string;
    branch: string;
    confirmed: boolean;
    instructions: string;
    signal: AbortSignal;
  }): Promise<{ remoteJobId: string; status: "queued" | "running" }>;
  status(remoteJobId: string): Promise<RemoteAgentStatus>;
  cancel(remoteJobId: string): Promise<{ remote: boolean }>;
  waitForTerminal(
    remoteJobId: string,
    input: { signal: AbortSignal; deadlineMs: number; pollIntervalMs: number },
  ): Promise<RemoteAgentStatus>;
}

export interface RemoteAgentJobRunnerDependencies {
  vault: CredentialVault;
  connections: RemoteAgentConnectionStore;
  api: CursorBackgroundAgentsClient;
  jobs?: RemoteAgentJobStore;
  createId?: () => string;
  now?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Provides the Task 6 remote-job route without pretending a remote GitHub
 * agent is a local immutable snapshot. It stores only opaque IDs and status.
 */
export function createRemoteAgentJobRunner(
  deps: RemoteAgentJobRunnerDependencies,
): RemoteAgentJobRunner {
  const jobs = deps.jobs ?? createInMemoryRemoteAgentJobStore();
  const createId = deps.createId ?? randomUUID;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepUntil;

  return {
    async create(input) {
      validateCreateInput(input);
      const connection = cursorBackgroundConnection(input.connectionId, deps.connections);
      const apiKey = await readApiKey(connection, deps.vault);
      throwIfAborted(input.signal);

      let created: CursorBackgroundAgentCreateResult;
      try {
        created = await deps.api.create({
          repositoryUrl: input.repositoryUrl,
          branch: input.branch,
          instructions: input.instructions,
          apiKey,
          signal: input.signal,
        });
      } catch (error) {
        throw normalizeRemoteError(error);
      }

      const remoteJobId = validOpaqueId(createId());
      jobs.put({
        remoteJobId,
        connectionId: connection.id,
        agentId: validOpaqueId(created.agentId),
        runId: validOpaqueId(created.runId),
        status: created.status,
      });
      return { remoteJobId, status: created.status };
    },

    async status(remoteJobId) {
      const job = requiredJob(remoteJobId, jobs);
      const connection = cursorBackgroundConnection(job.connectionId, deps.connections);
      const apiKey = await readApiKey(connection, deps.vault);
      try {
        const status = await deps.api.status({
          agentId: job.agentId,
          runId: job.runId,
          apiKey,
        });
        const safeStatus = validStatus(status);
        jobs.update(job.remoteJobId, safeStatus.status);
        return safeStatus;
      } catch (error) {
        throw normalizeRemoteError(error);
      }
    },

    async cancel(remoteJobId) {
      const job = requiredJob(remoteJobId, jobs);
      const connection = cursorBackgroundConnection(job.connectionId, deps.connections);
      const apiKey = await readApiKey(connection, deps.vault);
      try {
        await deps.api.cancel({ agentId: job.agentId, runId: job.runId, apiKey });
        jobs.update(job.remoteJobId, "cancelled");
        return { remote: true };
      } catch (error) {
        throw normalizeRemoteError(error);
      }
    },

    async waitForTerminal(remoteJobId, input) {
      validatePollingInput(input);
      const deadlineAt = now() + input.deadlineMs;
      for (;;) {
        if (input.signal.aborted) {
          await cancelAfterTerminalCondition(remoteJobId, this.cancel, "remote_job_cancelled");
        }
        if (now() >= deadlineAt) {
          await cancelAfterTerminalCondition(remoteJobId, this.cancel, "remote_job_deadline_exceeded");
        }

        const current = await this.status(remoteJobId);
        if (current.terminal) return current;

        try {
          await sleep(input.pollIntervalMs, input.signal);
        } catch {
          if (input.signal.aborted) {
            await cancelAfterTerminalCondition(remoteJobId, this.cancel, "remote_job_cancelled");
          }
          throw new RemoteAgentJobError("provider_unreachable");
        }
      }
    },
  };
}

/** Safe in-process default; Task 6 may replace this with durable safe metadata. */
export function createInMemoryRemoteAgentJobStore(): RemoteAgentJobStore {
  const records = new Map<string, RemoteAgentJobRecord>();
  return {
    get(remoteJobId) {
      const record = records.get(remoteJobId);
      return record === undefined ? null : { ...record };
    },
    put(job) {
      records.set(job.remoteJobId, { ...job });
    },
    update(remoteJobId, status) {
      const current = records.get(remoteJobId);
      if (current === undefined) return null;
      const next = { ...current, status };
      records.set(remoteJobId, next);
      return { ...next };
    },
  };
}

function validateCreateInput(input: {
  connectionId: string;
  repositoryUrl: string;
  branch: string;
  confirmed: boolean;
  instructions: string;
  signal: AbortSignal;
}): void {
  if (input.confirmed !== true) {
    throw new RemoteAgentJobError("remote_repository_confirmation_required");
  }
  if (!isGithubRepositoryUrl(input.repositoryUrl)) {
    throw new RemoteAgentJobError("remote_repository_invalid");
  }
  if (!isSafeText(input.branch, 240)) {
    throw new RemoteAgentJobError("remote_branch_required");
  }
  if (!isSafeText(input.instructions, 32_000)) {
    throw new RemoteAgentJobError("remote_instructions_invalid");
  }
  if (!isSafeText(input.connectionId, 160)) {
    throw new RemoteAgentJobError("protocol_unsupported");
  }
  throwIfAborted(input.signal);
}

function validatePollingInput(input: {
  signal: AbortSignal;
  deadlineMs: number;
  pollIntervalMs: number;
}): void {
  if (!(input.signal instanceof AbortSignal)) {
    throw new RemoteAgentJobError("protocol_unsupported");
  }
  if (!Number.isInteger(input.deadlineMs) || input.deadlineMs <= 0 || input.deadlineMs > 5_400_000) {
    throw new RemoteAgentJobError("protocol_unsupported");
  }
  if (!Number.isInteger(input.pollIntervalMs) || input.pollIntervalMs <= 0 || input.pollIntervalMs > 60_000) {
    throw new RemoteAgentJobError("protocol_unsupported");
  }
}

function cursorBackgroundConnection(
  connectionId: string,
  connections: RemoteAgentConnectionStore,
): StoredProviderConnection {
  const connection = connections.get(connectionId);
  if (
    connection === null ||
    connection.providerKind !== "cursor" ||
    connection.routeKind !== "cursor-background-agents" ||
    connection.transport !== "remote-agent-api" ||
    connection.authKind !== "api-key" ||
    connection.protocol !== "cursor-background-agents" ||
    connection.credentialRef === null
  ) {
    throw new RemoteAgentJobError("protocol_unsupported");
  }
  return connection;
}

async function readApiKey(
  connection: StoredProviderConnection,
  vault: CredentialVault,
): Promise<string> {
  try {
    const bundle = await vault.get(connection.credentialRef!);
    if (!isSafeText(bundle.apiKey, 4_096)) {
      throw new RemoteAgentJobError("credential_rejected");
    }
    return bundle.apiKey;
  } catch (error) {
    if (error instanceof RemoteAgentJobError) throw error;
    if (error instanceof VaultError && error.code === "secure_storage_unavailable") {
      throw new RemoteAgentJobError("secure_storage_unavailable");
    }
    throw new RemoteAgentJobError("credential_rejected");
  }
}

function requiredJob(remoteJobId: string, jobs: RemoteAgentJobStore): RemoteAgentJobRecord {
  if (!isSafeText(remoteJobId, 240)) throw new RemoteAgentJobError("remote_job_not_found");
  const job = jobs.get(remoteJobId);
  if (job === null) throw new RemoteAgentJobError("remote_job_not_found");
  return job;
}

function validStatus(status: RemoteAgentStatus): RemoteAgentStatus {
  if (!isRemoteAgentJobStatus(status.status) || typeof status.terminal !== "boolean") {
    throw new RemoteAgentJobError("protocol_unsupported");
  }
  return { status: status.status, terminal: status.terminal };
}

function validOpaqueId(value: string): string {
  if (!isSafeText(value, 240) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(value)) {
    throw new RemoteAgentJobError("protocol_unsupported");
  }
  return value;
}

function isGithubRepositoryUrl(value: string): boolean {
  if (!isSafeText(value, 2_048)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return false;
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return false;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part));
  } catch {
    return false;
  }
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001F\u007F]/.test(value);
}

function isRemoteAgentJobStatus(value: unknown): value is RemoteAgentJobStatus {
  return value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "expired";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RemoteAgentJobError("remote_job_cancelled");
}

async function cancelAfterTerminalCondition(
  remoteJobId: string,
  cancel: (id: string) => Promise<{ remote: boolean }>,
  code: "remote_job_cancelled" | "remote_job_deadline_exceeded",
): Promise<never> {
  try {
    await cancel(remoteJobId);
  } catch {
    // The lifecycle terminal condition is more useful than a retryable cancel failure.
  }
  throw new RemoteAgentJobError(code);
}

function sleepUntil(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RemoteAgentJobError("remote_job_cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new RemoteAgentJobError("remote_job_cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeRemoteError(error: unknown): RemoteAgentJobError {
  if (error instanceof RemoteAgentJobError) return error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === "credential_rejected" ||
      code === "secure_storage_unavailable" ||
      code === "endpoint_access_denied" ||
      code === "rate_limited" ||
      code === "provider_unreachable" ||
      code === "protocol_unsupported"
    ) return new RemoteAgentJobError(code);
  }
  return new RemoteAgentJobError("provider_unreachable");
}
