import type {
  ProviderModel,
  ScanConnectionSnapshot,
} from "@csb/shared";

import { CODEX_SECURITY_API_VAULT_TIMEOUT_MS } from "../config.js";
import type { StoredProviderConnection } from "../connections-store.js";
import type { ScanLaunchPlan } from "../connections/launch-plan.js";
import {
  isMimoTokenPlanApiKey,
  isMimoTokenPlanResponsesModel,
  mimoTokenPlanOpenAiBase,
} from "../connections/http-model-discovery.js";
import type { CredentialVault } from "../credentials/credential-vault.js";

export { prepareCodexSecurityMimoLaunch } from "./launch.js";

export type CodexSecurityMimoBridgeErrorCode =
  | "provider_runner_unavailable"
  | "credential_unavailable";

export class CodexSecurityMimoBridgeError extends Error {
  constructor(readonly code: CodexSecurityMimoBridgeErrorCode) {
    super(code);
    this.name = "CodexSecurityMimoBridgeError";
  }
}

type CodexSecurityMimoPlan = ScanLaunchPlan & {
  model: ProviderModel;
  scannerAuthMode: "api-key";
};

export interface CodexSecurityMimoCredential {
  apiKey: string;
  baseUrl: string;
}

/**
 * MiMo remains an OpenAI Chat route for Sentinel agent sessions. This is the
 * one deliberate dual-protocol boundary: Codex Security configures that same
 * pinned Token Plan route as a Responses provider, per Xiaomi's Codex guide.
 */
export function isCodexSecurityMimoPlan(
  plan: ScanLaunchPlan,
): plan is CodexSecurityMimoPlan {
  return plan.engine === "codex-security" &&
    plan.providerKind === "xiaomi" &&
    plan.routeKind === "mimo-token-plan" &&
    plan.runnerKind === "codex-security-contract" &&
    plan.protocol === "openai-chat" &&
    plan.scannerAuthMode === "api-key" &&
    plan.model !== null &&
    isMimoTokenPlanResponsesModel(plan.model.id) &&
    plan.snapshot.connectionId === plan.connectionId &&
    plan.snapshot.routeKind === "mimo-token-plan" &&
    plan.snapshot.modelSelectionMode === "catalog" &&
    plan.snapshot.modelId === plan.model.id &&
    plan.snapshot.capabilityCheckId === null;
}

export function isCodexSecurityMimoConnection(
  connection: StoredProviderConnection | null,
): connection is StoredProviderConnection & { credentialRef: string } {
  return connection !== null &&
    connection.status === "ready" &&
    connection.providerKind === "xiaomi" &&
    connection.routeKind === "mimo-token-plan" &&
    connection.transport === "http-inference" &&
    connection.authKind === "api-key" &&
    connection.protocol === "openai-chat" &&
    connection.modelSelectionMode === "catalog" &&
    connection.modelCatalogStale === false &&
    typeof connection.credentialRef === "string" &&
    connection.credentialRef.length > 0;
}

export async function resolveCodexSecurityMimoCredential(input: {
  scanId: string;
  plan: ScanLaunchPlan;
  getConnection: (connectionId: string) => StoredProviderConnection | null;
  getSnapshot: (scanId: string) => ScanConnectionSnapshot | null;
  getModel: (connectionId: string, modelId: string) => ProviderModel | null;
  vault: CredentialVault;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CodexSecurityMimoCredential> {
  if (!isCodexSecurityMimoPlan(input.plan) || input.plan.snapshot.scanId !== input.scanId) {
    throw new CodexSecurityMimoBridgeError("provider_runner_unavailable");
  }

  let connection: StoredProviderConnection | null;
  let snapshot: ScanConnectionSnapshot | null;
  let model: ProviderModel | null;
  try {
    connection = input.getConnection(input.plan.connectionId);
    snapshot = input.getSnapshot(input.scanId);
    model = input.getModel(input.plan.connectionId, input.plan.model.id);
  } catch {
    throw new CodexSecurityMimoBridgeError("provider_runner_unavailable");
  }

  if (
    !isCodexSecurityMimoConnection(connection) ||
    connection.id !== input.plan.connectionId ||
    !sameSnapshot(snapshot, input.plan.snapshot) ||
    model === null ||
    model.connectionId !== connection.id ||
    model.id !== input.plan.model.id ||
    input.plan.model.connectionId !== connection.id
  ) {
    throw new CodexSecurityMimoBridgeError("provider_runner_unavailable");
  }

  let credential: Awaited<ReturnType<CredentialVault["get"]>>;
  try {
    credential = await boundedVaultRead(
      input.vault,
      connection.credentialRef,
      input.signal,
      validTimeout(input.timeoutMs),
    );
  } catch {
    throw new CodexSecurityMimoBridgeError("credential_unavailable");
  }

  const baseUrl = mimoTokenPlanOpenAiBase(credential.baseUrl);
  if (!isMimoTokenPlanApiKey(credential.apiKey) || baseUrl === null) {
    throw new CodexSecurityMimoBridgeError("credential_unavailable");
  }
  return { apiKey: credential.apiKey!, baseUrl };
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
    return Promise.reject(new CodexSecurityMimoBridgeError("credential_unavailable"));
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
      reject(new CodexSecurityMimoBridgeError("credential_unavailable"))
    );
    const onAbort = (): void => fail();
    const timeout = setTimeout(fail, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      () => fail(),
    );
  });
}
