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

export const REMOTE_AGENT_JOB_REQUEST_TIMEOUT_MS = 8_000;

export interface RemoteAgentStatus {
  status: RemoteAgentJobStatus;
  terminal: boolean;
}

export interface CursorBackgroundAgentCreateInput {
  repositoryUrl: string;
  branch: string;
  instructions: string;
  /** Must be a row previously discovered for the selected connection. */
  modelId: string;
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

/** Narrow catalog seam: a remote job may use only the connection's live model row. */
export interface RemoteAgentModelCatalog {
  getModel(connectionId: string, modelId: string): { connectionId: string; id: string } | null;
}

export type RemoteAgentJobErrorCode =
  | "remote_repository_confirmation_required"
  | "remote_repository_invalid"
  | "remote_branch_required"
  | "remote_instructions_invalid"
  | "remote_model_required"
  | "remote_model_not_found"
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
    modelId: string;
    signal: AbortSignal;
  }): Promise<{ remoteJobId: string; status: "queued" | "running" }>;
  status(remoteJobId: string, signal?: AbortSignal): Promise<RemoteAgentStatus>;
  cancel(remoteJobId: string, signal?: AbortSignal): Promise<{ remote: boolean }>;
  waitForTerminal(
    remoteJobId: string,
    input: { signal: AbortSignal; deadlineMs: number; pollIntervalMs: number },
  ): Promise<RemoteAgentStatus>;
}

export interface RemoteAgentJobRunnerDependencies {
  vault: CredentialVault;
  connections: RemoteAgentConnectionStore;
  models: RemoteAgentModelCatalog;
  api: CursorBackgroundAgentsClient;
  jobs?: RemoteAgentJobStore;
  createId?: () => string;
  now?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
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
  const requestTimeoutMs = positiveBoundedInteger(
    deps.requestTimeoutMs ?? REMOTE_AGENT_JOB_REQUEST_TIMEOUT_MS,
    REMOTE_AGENT_JOB_REQUEST_TIMEOUT_MS,
  );
  const cancelWithBudget = async (
    remoteJobId: string,
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
    reconcileConflict: boolean,
  ): Promise<{ remote: boolean }> => {
    const job = requiredJob(remoteJobId, jobs);
    const connection = cursorBackgroundConnection(job.connectionId, deps.connections);
    const request = createRequestScope(parentSignal, timeoutMs);
    try {
      const apiKey = await awaitWithin(readApiKey(connection, deps.vault), request.signal);
      try {
        await awaitWithin(deps.api.cancel({
          agentId: job.agentId,
          runId: job.runId,
          apiKey,
          signal: request.signal,
        }), request.signal);
      } catch (error) {
        if (!isRunNotCancellable(error) || !reconcileConflict || request.signal.aborted) throw error;
        // Reconciliation shares this exact bounded request scope. A cleanup
        // race must never buy a fresh full request timeout after cancellation.
        const finalStatus = await readRemoteStatus(deps.api, job, apiKey, request.signal);
        if (!finalStatus.terminal) throw new RemoteAgentJobError("provider_unreachable");
        jobs.update(job.remoteJobId, finalStatus.status);
        return { remote: false };
      }
      jobs.update(job.remoteJobId, "cancelled");
      return { remote: true };
    } catch (error) {
      throw normalizeRemoteError(error);
    } finally {
      request.dispose();
    }
  };
  const scheduleTerminalCleanup = (remoteJobId: string, deadlineAt: number): void => {
    const remainingMs = Math.max(0, deadlineAt - now());
    const cleanupBudgetMs = Math.max(1, Math.min(requestTimeoutMs, remainingMs));
    // This is intentionally detached. Once the lifecycle is terminal, that
    // result wins; a provider that ignores AbortSignal cannot extend it.
    consumeLate(cancelWithBudget(
      remoteJobId,
      undefined,
      cleanupBudgetMs,
      remainingMs > 0,
    ));
  };

  return {
    async create(input) {
      validateCreateInput(input);
      const connection = cursorBackgroundConnection(input.connectionId, deps.connections);
      const modelId = selectedModelId(connection.id, input.modelId, deps.models);
      const request = createRequestScope(input.signal, requestTimeoutMs);
      try {
        const apiKey = await awaitWithin(readApiKey(connection, deps.vault), request.signal);
        const created = await awaitWithin(deps.api.create({
          repositoryUrl: input.repositoryUrl,
          branch: input.branch,
          instructions: input.instructions,
          modelId,
          apiKey,
          signal: request.signal,
        }), request.signal);

        const remoteJobId = validOpaqueId(createId());
        jobs.put({
          remoteJobId,
          connectionId: connection.id,
          agentId: validOpaqueId(created.agentId),
          runId: validOpaqueId(created.runId),
          status: created.status,
        });
        return { remoteJobId, status: created.status };
      } catch (error) {
        throw normalizeRemoteError(error);
      } finally {
        request.dispose();
      }
    },

    async status(remoteJobId, signal) {
      const job = requiredJob(remoteJobId, jobs);
      const connection = cursorBackgroundConnection(job.connectionId, deps.connections);
      const request = createRequestScope(signal, requestTimeoutMs);
      try {
        const apiKey = await awaitWithin(readApiKey(connection, deps.vault), request.signal);
        const safeStatus = await readRemoteStatus(deps.api, job, apiKey, request.signal);
        jobs.update(job.remoteJobId, safeStatus.status);
        return safeStatus;
      } catch (error) {
        throw normalizeRemoteError(error);
      } finally {
        request.dispose();
      }
    },

    async cancel(remoteJobId, signal) {
      return cancelWithBudget(remoteJobId, signal, requestTimeoutMs, true);
    },

    async waitForTerminal(remoteJobId, input) {
      validatePollingInput(input);
      const deadlineAt = now() + input.deadlineMs;
      const lifecycle = createRequestScope(input.signal, input.deadlineMs);
      try {
        for (;;) {
          const terminalCode = terminalCondition(input.signal, lifecycle, now() >= deadlineAt);
          if (terminalCode !== null) {
            scheduleTerminalCleanup(remoteJobId, deadlineAt);
            throw new RemoteAgentJobError(terminalCode);
          }

          try {
            const current = await this.status(remoteJobId, lifecycle.signal);
            if (current.terminal) return current;
          } catch (error) {
            const terminalCodeAfterStatus = terminalCondition(input.signal, lifecycle, now() >= deadlineAt);
            if (terminalCodeAfterStatus !== null) {
              scheduleTerminalCleanup(remoteJobId, deadlineAt);
              throw new RemoteAgentJobError(terminalCodeAfterStatus);
            }
            throw normalizeRemoteError(error);
          }

          try {
            await awaitWithin(sleep(input.pollIntervalMs, lifecycle.signal), lifecycle.signal);
          } catch (error) {
            const terminalCodeAfterSleep = terminalCondition(input.signal, lifecycle, now() >= deadlineAt);
            if (terminalCodeAfterSleep !== null) {
              scheduleTerminalCleanup(remoteJobId, deadlineAt);
              throw new RemoteAgentJobError(terminalCodeAfterSleep);
            }
            throw normalizeRemoteError(error);
          }
        }
      } finally {
        lifecycle.dispose();
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
  modelId: string;
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
  if (!isSafeText(input.modelId, 240)) {
    throw new RemoteAgentJobError("remote_model_required");
  }
  if (!isSafeText(input.connectionId, 160)) {
    throw new RemoteAgentJobError("protocol_unsupported");
  }
  throwIfAborted(input.signal);
}

function selectedModelId(
  connectionId: string,
  requestedModelId: string,
  models: RemoteAgentModelCatalog,
): string {
  if (!isSafeText(requestedModelId, 240)) {
    throw new RemoteAgentJobError("remote_model_required");
  }
  let model: { connectionId: string; id: string } | null;
  try {
    model = models.getModel(connectionId, requestedModelId);
  } catch {
    throw new RemoteAgentJobError("remote_model_not_found");
  }
  if (
    model === null ||
    model.connectionId !== connectionId ||
    model.id !== requestedModelId ||
    !isSafeText(model.id, 240)
  ) throw new RemoteAgentJobError("remote_model_not_found");
  return model.id;
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
  if (
    !isRemoteAgentJobStatus(status.status) ||
    typeof status.terminal !== "boolean" ||
    status.terminal !== isTerminalStatus(status.status)
  ) {
    throw new RemoteAgentJobError("protocol_unsupported");
  }
  return { status: status.status, terminal: status.terminal };
}

function isTerminalStatus(status: RemoteAgentJobStatus): boolean {
  return status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired";
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

async function readRemoteStatus(
  api: CursorBackgroundAgentsClient,
  job: RemoteAgentJobRecord,
  apiKey: string,
  signal: AbortSignal,
): Promise<RemoteAgentStatus> {
  const status = await awaitWithin(api.status({
    agentId: job.agentId,
    runId: job.runId,
    apiKey,
    signal,
  }), signal);
  return validStatus(status);
}

function isRunNotCancellable(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "run_not_cancellable";
}

function createRequestScope(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function awaitWithin<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    consumeLate(operation);
    throw new RemoteAgentJobError("remote_job_cancelled");
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      consumeLate(operation);
      reject(new RemoteAgentJobError("remote_job_cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function consumeLate(operation: Promise<unknown>): void {
  void operation.then(() => undefined, () => undefined);
}

function terminalCondition(
  parent: AbortSignal,
  lifecycle: { signal: AbortSignal },
  deadlineReached: boolean,
): "remote_job_cancelled" | "remote_job_deadline_exceeded" | null {
  if (parent.aborted) return "remote_job_cancelled";
  if (deadlineReached || lifecycle.signal.aborted) return "remote_job_deadline_exceeded";
  return null;
}

function positiveBoundedInteger(value: unknown, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new TypeError("Invalid remote agent job request timeout");
  }
  return value as number;
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
      code === "protocol_unsupported" ||
      code === "remote_model_required" ||
      code === "remote_model_not_found"
    ) return new RemoteAgentJobError(code);
  }
  return new RemoteAgentJobError("provider_unreachable");
}
