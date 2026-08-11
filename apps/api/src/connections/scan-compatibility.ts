import type {
  CapabilityReport,
  ConnectionCompatibility,
  ProviderModel,
  ProviderProtocol,
  ResolveScanCompatibilityRequest,
} from "@csb/shared";

import type { StoredProviderConnection } from "../connections-store.js";
import {
  effectiveReasoningEffort,
  resolveCompatibility,
  type ResolvedConnectionCompatibility,
} from "./compatibility-resolver.js";
import { isHttpAgentRouteProtocolSupported } from "../agent/http-agent-upstream.js";
import { isCodexSecurityApiConnection } from "../scanners/codex-security-api-bridge.js";
import {
  PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
  PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
} from "../scanners/portable-codex-security-profile.js";

export interface ScanCompatibilityStore {
  getConnection(id: string): StoredProviderConnection | null;
  getModel(connectionId: string, modelId: string): ProviderModel | null;
  getLatestCapabilityCheck(
    connectionId: string,
    modelId: string | null,
    protocol: ProviderProtocol,
  ): CapabilityReport | null;
}

export interface ScanCompatibilityResolver {
  resolve(input: ResolveScanCompatibilityRequest): ConnectionCompatibility;
}

/**
 * Read-only launch preview. It uses the same persisted connection/model/probe
 * facts as launch resolution, but never writes a scan snapshot or reads a
 * credential. A generic protocol capability is not advertised until its
 * concrete scanner worker is wired.
 */
export function createScanCompatibilityResolver(
  dependencies: ScanCompatibilityStore & { now?: () => Date },
): ScanCompatibilityResolver {
  const now = dependencies.now ?? (() => new Date());
  return {
    resolve(input) {
      const selection = copySelection(input);
      const connection = dependencies.getConnection(selection.connectionId);
      if (connection === null) return blocked(selection, "connection_not_found");

      const model = selection.modelSelectionMode === "catalog" && selection.modelId !== null
        ? dependencies.getModel(connection.id, selection.modelId)
        : null;
      const probe = selection.modelSelectionMode === "catalog"
        ? dependencies.getLatestCapabilityCheck(
          connection.id,
          selection.modelId,
          connection.protocol,
        )
        : null;
      const resolved = resolveCompatibility({
        engine: input.engine,
        connection,
        selection,
        model,
        probe,
        now: now(),
        snapshotReadOnly: input.engine === "vulnhunter",
        staticAnalysisProfile: input.engine === "vulnhunter",
        remoteRepositoryConfirmed: input.remoteRepositoryConfirmed,
        executionProfilePreference: input.executionProfilePreference,
      });
      if (!resolved.eligible) return publicDecision(resolved, connection, model);
      return runnerIsWired(input, connection, resolved)
        ? publicDecision(resolved, connection, model)
        : blocked(selection, "provider_runner_unavailable");
    },
  };
}

function runnerIsWired(
  input: ResolveScanCompatibilityRequest,
  connection: StoredProviderConnection,
  resolved: ResolvedConnectionCompatibility,
): boolean {
  if (resolved.runnerKind === "remote-agent-job") return false;
  if (input.engine === "codex-security") {
    if (resolved.runnerKind === "codex-security-contract") {
      return connection.routeKind === "openai-codex-local" ||
        connection.routeKind === "openai-chatgpt-app-server" ||
        isCodexSecurityApiConnection(connection);
    }
    return resolved.runnerKind === "agent-session" &&
      resolved.selectedProfile === "portable" &&
      resolved.profileVersion === PORTABLE_CODEX_SECURITY_PROFILE_VERSION &&
      resolved.methodologyRef === PORTABLE_CODEX_SECURITY_METHODOLOGY_REF &&
      resolved.capabilityCheckId !== null &&
      connection.transport === "http-inference" &&
      isHttpAgentRouteProtocolSupported(connection.routeKind, connection.protocol);
  }
  if (resolved.runnerKind === "codex-app-server") {
    return connection.routeKind === "openai-codex-local" ||
      connection.routeKind === "openai-chatgpt-app-server";
  }
  if (resolved.runnerKind === "local-agent-session") {
    return input.engine === "mantis" &&
      connection.providerKind === "anthropic" &&
      connection.routeKind === "claude-code-local" &&
      connection.transport === "local-cli" &&
      connection.authKind === "existing-session" &&
      connection.protocol === "claude-code-cli" &&
      connection.credentialRef === null;
  }
  if (resolved.runnerKind !== "agent-session") return false;
  if (input.engine === "mantis" || input.engine === "vulnhunter") {
    return isWiredHttpAgentSession(connection);
  }
  return false;
}

function isWiredHttpAgentSession(connection: StoredProviderConnection): boolean {
  if (connection.routeKind === "xai-oauth" || connection.protocol === "xai-oauth-responses") {
    return isExactXaiOAuthAgentSession(connection);
  }
  return isHttpAgentRouteProtocolSupported(connection.routeKind, connection.protocol);
}

function isExactXaiOAuthAgentSession(connection: StoredProviderConnection): boolean {
  return connection.providerKind === "xai" &&
    connection.routeKind === "xai-oauth" &&
    connection.transport === "http-inference" &&
    connection.authKind === "device-code" &&
    connection.protocol === "xai-oauth-responses" &&
    connection.credentialRef === null;
}

function copySelection(input: ResolveScanCompatibilityRequest) {
  return {
    connectionId: input.selection.connectionId,
    modelSelectionMode: input.selection.modelSelectionMode,
    modelId: input.selection.modelId,
  };
}

function publicDecision(
  decision: ResolvedConnectionCompatibility,
  connection: StoredProviderConnection,
  model: ProviderModel | null,
): ConnectionCompatibility {
  const reasoningEffort = effectiveReasoningEffort(model, connection, decision);
  const profile = decision.selectedProfile === undefined
    ? {}
    : {
      selectedProfile: decision.selectedProfile,
      availableProfiles: decision.availableProfiles === undefined
        ? []
        : [...decision.availableProfiles],
      profileVersion: decision.profileVersion ?? null,
      methodologyRef: decision.methodologyRef ?? null,
      capabilityCheckId: decision.capabilityCheckId ?? null,
    };
  return {
    connectionId: decision.connectionId,
    modelSelectionMode: decision.modelSelectionMode,
    modelId: decision.modelId,
    eligible: decision.eligible,
    reasons: [...decision.reasons],
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...profile,
  };
}

function blocked(
  selection: ResolveScanCompatibilityRequest["selection"],
  reason: string,
): ConnectionCompatibility {
  return {
    connectionId: selection.connectionId,
    modelSelectionMode: selection.modelSelectionMode,
    modelId: selection.modelId,
    eligible: false,
    reasons: [reason],
  };
}
