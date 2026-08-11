import type { ProviderAuthFlow, ProviderDisconnectResponse, ProviderModel, ScanConnectionSelection } from "@csb/shared";

export type ManagedAuthMode = "browser-oauth" | "device-code";

export type ConnectionOperationErrorKey =
  | "connections.operations.authMetadataInvalid"
  | "connections.operations.secureStorageUnavailable"
  | "connections.operations.providerUnavailable"
  | "connections.operations.error";

/** Maps only server-approved codes; arbitrary upstream text stays hidden. */
export function connectionOperationErrorKey(error: unknown): ConnectionOperationErrorKey {
  const code = error instanceof Error ? error.message : null;
  if (code === "oauth_metadata_invalid") return "connections.operations.authMetadataInvalid";
  if (code === "secure_storage_unavailable") return "connections.operations.secureStorageUnavailable";
  if (code === "provider_unreachable") return "connections.operations.providerUnavailable";
  return "connections.operations.error";
}

export interface AuthFlowClient {
  startAuth(connectionId: string, mode: ManagedAuthMode): Promise<ProviderAuthFlow>;
  getAuth(connectionId: string, flowId: string): Promise<ProviderAuthFlow>;
  cancelAuth(connectionId: string, flowId: string): Promise<void>;
}

type Schedule = (callback: () => void | Promise<void>, delayMs: number) => unknown;
type ClearSchedule = (handle: unknown) => void;

export interface AuthFlowPollerOptions {
  client: AuthFlowClient;
  onFlow(flow: ProviderAuthFlow | null): void;
  onTerminal?(flow: ProviderAuthFlow): void;
  onError?(): void;
  schedule?: Schedule;
  clearSchedule?: ClearSchedule;
  now?: () => Date;
  pollIntervalMs?: number;
  maxPolls?: number;
}

type ActiveFlow = { connectionId: string; flow: ProviderAuthFlow; generation: number; polls: number };

const TERMINAL_AUTH_STATUSES = new Set<ProviderAuthFlow["status"]>([
  "completed", "cancelled", "expired", "denied", "failed",
]);

export function isTerminalAuthFlow(flow: ProviderAuthFlow): boolean {
  return TERMINAL_AUTH_STATUSES.has(flow.status);
}

/** The renderable DTO deliberately has no credential fields. */
export function authFlowPresentation(flow: ProviderAuthFlow): Pick<ProviderAuthFlow, "authUrl" | "verificationUrl" | "userCode" | "expiresAt"> {
  return {
    authUrl: flow.authUrl,
    verificationUrl: flow.verificationUrl,
    userCode: flow.userCode,
    expiresAt: flow.expiresAt,
  };
}

export function probeSelectionForModel(
  connectionId: string,
  catalog: readonly ProviderModel[],
  selectedModelId: string | null,
): ScanConnectionSelection | null {
  if (selectedModelId === null || !catalog.some((model) => model.id === selectedModelId)) return null;
  return { connectionId, modelSelectionMode: "catalog", modelId: selectedModelId };
}

export function disconnectMessageForStatus(status: ProviderDisconnectResponse["result"]["status"]): {
  key: "connections.operations.disconnectRevoked" | "connections.operations.disconnectLocalRemoved" | "connections.operations.disconnectRevokePending" | "connections.operations.disconnectNotSupported";
  tone: "success" | "info";
} {
  switch (status) {
    case "revoked":
      return { key: "connections.operations.disconnectRevoked", tone: "success" };
    case "local_removed":
      return { key: "connections.operations.disconnectLocalRemoved", tone: "success" };
    case "revoke_pending":
      return { key: "connections.operations.disconnectRevokePending", tone: "info" };
    case "not_supported":
      return { key: "connections.operations.disconnectNotSupported", tone: "info" };
  }
}

export function createAuthFlowPoller(options: AuthFlowPollerOptions) {
  const schedule = options.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const clearSchedule = options.clearSchedule ?? ((handle) => window.clearTimeout(handle as number));
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const maxPolls = options.maxPolls ?? 120;
  let active: ActiveFlow | null = null;
  let timer: unknown = null;
  let generation = 0;
  let disposed = false;

  const clearTimer = () => {
    if (timer === null) return;
    clearSchedule(timer);
    timer = null;
  };

  const terminal = (flow: ProviderAuthFlow) => {
    clearTimer();
    active = null;
    options.onFlow(flow);
    options.onTerminal?.(flow);
  };

  const schedulePoll = (current: ActiveFlow) => {
    clearTimer();
    timer = schedule(() => poll(current.generation), pollIntervalMs);
  };

  const poll = async (expectedGeneration: number): Promise<void> => {
    if (disposed || active === null || active.generation !== expectedGeneration) return;
    const current = active;
    const expired = current.flow.expiresAt !== null && Date.parse(current.flow.expiresAt) <= now().getTime();
    if (expired || current.polls >= maxPolls) {
      terminal({ ...current.flow, status: expired ? "expired" : "failed" });
      void options.client.cancelAuth(current.connectionId, current.flow.flowId).catch(() => undefined);
      return;
    }
    try {
      const next = await options.client.getAuth(current.connectionId, current.flow.flowId);
      if (disposed || active === null || active.generation !== expectedGeneration) return;
      active = { ...active, flow: next, polls: active.polls + 1 };
      if (isTerminalAuthFlow(next)) {
        terminal(next);
        return;
      }
      options.onFlow(next);
      schedulePoll(active);
    } catch {
      if (disposed || active === null || active.generation !== expectedGeneration) return;
      terminal({ ...current.flow, status: "failed" });
      options.onError?.();
    }
  };

  const cancel = async (): Promise<boolean> => {
    clearTimer();
    const current = active;
    if (current === null) return true;
    try {
      await options.client.cancelAuth(current.connectionId, current.flow.flowId);
    } catch {
      if (!disposed && active === current) schedulePoll(current);
      options.onError?.();
      return false;
    }
    if (active !== current) return true;
    active = null;
    generation += 1;
    if (!disposed) options.onFlow({ ...current.flow, status: "cancelled" });
    return true;
  };

  const start = async (connectionId: string, mode: ManagedAuthMode): Promise<ProviderAuthFlow> => {
    if (!await cancel()) throw new Error("Unable to cancel the active authentication flow");
    const currentGeneration = ++generation;
    const flow = await options.client.startAuth(connectionId, mode);
    if (disposed || currentGeneration !== generation) {
      void options.client.cancelAuth(connectionId, flow.flowId).catch(() => undefined);
      return flow;
    }
    active = { connectionId, flow, generation: currentGeneration, polls: 0 };
    if (isTerminalAuthFlow(flow)) terminal(flow);
    else {
      options.onFlow(flow);
      schedulePoll(active);
    }
    return flow;
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    await cancel();
  };

  return {
    start,
    cancel,
    dispose,
  };
}
