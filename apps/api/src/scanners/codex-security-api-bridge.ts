import type {
  ProviderModel,
  ScanConnectionSnapshot,
} from "@csb/shared";

import { CODEX_SECURITY_API_VAULT_TIMEOUT_MS } from "../config.js";
import type { StoredProviderConnection } from "../connections-store.js";
import type { ScanLaunchPlan } from "../connections/launch-plan.js";
import type { CredentialVault } from "../credentials/credential-vault.js";

export { prepareCodexSecurityApiLaunch } from "./launch.js";

export type CodexSecurityApiBridgeErrorCode =
  | "provider_runner_unavailable"
  | "credential_unavailable";

/** Deliberately carries only a stable, non-secret error code. */
export class CodexSecurityApiBridgeError extends Error {
  constructor(readonly code: CodexSecurityApiBridgeErrorCode) {
    super(code);
    this.name = "CodexSecurityApiBridgeError";
  }
}

type CodexSecurityApiPlan = ScanLaunchPlan & {
  model: ProviderModel;
  scannerAuthMode: "api-key";
};

/** The sole HTTP contract accepted by the Codex Security CLI API-key bridge. */
export function isCodexSecurityApiPlan(
  plan: ScanLaunchPlan,
): plan is CodexSecurityApiPlan {
  return plan.engine === "codex-security" &&
    plan.providerKind === "openai" &&
    plan.routeKind === "openai-api" &&
    plan.runnerKind === "codex-security-contract" &&
    plan.protocol === "openai-responses" &&
    plan.scannerAuthMode === "api-key" &&
    plan.model !== null &&
    plan.snapshot.connectionId === plan.connectionId &&
    plan.snapshot.routeKind === "openai-api" &&
    plan.snapshot.modelSelectionMode === "catalog" &&
    plan.snapshot.modelId === plan.model.id &&
    plan.snapshot.capabilityCheckId === null;
}

/**
 * Reads the selected vault entry only after both the immutable launch plan and
 * the current persisted connection prove the exact OpenAI API tuple.
 */
export async function resolveCodexSecurityApiKey(input: {
  scanId: string;
  plan: ScanLaunchPlan;
  getConnection: (connectionId: string) => StoredProviderConnection | null;
  getSnapshot: (scanId: string) => ScanConnectionSnapshot | null;
  getModel: (connectionId: string, modelId: string) => ProviderModel | null;
  vault: CredentialVault;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  if (!isCodexSecurityApiPlan(input.plan) || input.plan.snapshot.scanId !== input.scanId) {
    throw new CodexSecurityApiBridgeError("provider_runner_unavailable");
  }

  let connection: StoredProviderConnection | null;
  let snapshot: ScanConnectionSnapshot | null;
  let model: ProviderModel | null;
  try {
    connection = input.getConnection(input.plan.connectionId);
    snapshot = input.getSnapshot(input.scanId);
    model = input.getModel(input.plan.connectionId, input.plan.model.id);
  } catch {
    throw new CodexSecurityApiBridgeError("provider_runner_unavailable");
  }

  if (
    !isCodexSecurityApiConnection(connection) ||
    connection.id !== input.plan.connectionId ||
    !sameSnapshot(snapshot, input.plan.snapshot) ||
    model === null ||
    model.connectionId !== connection.id ||
    model.id !== input.plan.model.id ||
    input.plan.model.connectionId !== connection.id
  ) {
    throw new CodexSecurityApiBridgeError("provider_runner_unavailable");
  }

  try {
    const credential = await boundedVaultRead(
      input.vault,
      connection.credentialRef,
      input.signal,
      validTimeout(input.timeoutMs),
    );
    if (!credential.apiKey?.trim()) {
      throw new CodexSecurityApiBridgeError("credential_unavailable");
    }
    return credential.apiKey;
  } catch {
    throw new CodexSecurityApiBridgeError("credential_unavailable");
  }
}

export function isCodexSecurityApiConnection(
  connection: StoredProviderConnection | null,
): connection is StoredProviderConnection & { credentialRef: string } {
  return connection !== null &&
    connection.status === "ready" &&
    connection.providerKind === "openai" &&
    connection.routeKind === "openai-api" &&
    connection.transport === "http-inference" &&
    connection.authKind === "api-key" &&
    connection.protocol === "openai-responses" &&
    connection.modelSelectionMode === "catalog" &&
    connection.modelCatalogStale === false &&
    typeof connection.credentialRef === "string" &&
    connection.credentialRef.length > 0;
}

function sameSnapshot(
  persisted: ScanConnectionSnapshot | null,
  planned: ScanConnectionSnapshot,
): boolean {
  return persisted !== null &&
    persisted.scanId === planned.scanId &&
    persisted.connectionId === planned.connectionId &&
    persisted.routeKind === planned.routeKind &&
    persisted.modelSelectionMode === planned.modelSelectionMode &&
    persisted.modelId === planned.modelId &&
    persisted.capabilityCheckId === planned.capabilityCheckId &&
    persisted.capturedAt === planned.capturedAt;
}

function validTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 10_000)
    : CODEX_SECURITY_API_VAULT_TIMEOUT_MS;
}

function boundedVaultRead(
  vault: CredentialVault,
  credentialRef: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Awaited<ReturnType<CredentialVault["get"]>>> {
  if (signal?.aborted) {
    return Promise.reject(new CodexSecurityApiBridgeError("credential_unavailable"));
  }

  const operation = Promise.resolve().then(() => vault.get(credentialRef));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const fail = (): void => finish(() =>
      reject(new CodexSecurityApiBridgeError("credential_unavailable"))
    );
    const onAbort = (): void => fail();
    const timeout = setTimeout(fail, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    // Both handlers remain attached after timeout/abort so a backend that
    // ignores cancellation cannot create an unhandled late rejection.
    void operation.then(
      (value) => finish(() => resolve(value)),
      () => fail(),
    );
  });
}
