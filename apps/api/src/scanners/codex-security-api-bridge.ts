import type { ProviderModel } from "@csb/shared";

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
  plan: ScanLaunchPlan;
  connection: StoredProviderConnection | null;
  vault: CredentialVault;
}): Promise<string> {
  if (!isCodexSecurityApiPlan(input.plan) || !isCodexSecurityApiConnection(input.connection)) {
    throw new CodexSecurityApiBridgeError("provider_runner_unavailable");
  }
  if (input.connection.id !== input.plan.connectionId) {
    throw new CodexSecurityApiBridgeError("provider_runner_unavailable");
  }

  try {
    const credential = await input.vault.get(input.connection.credentialRef);
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
    typeof connection.credentialRef === "string" &&
    connection.credentialRef.length > 0;
}
