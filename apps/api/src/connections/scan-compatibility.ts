import type {
  CapabilityReport,
  ConnectionCompatibility,
  ProviderModel,
  ProviderProtocol,
  ResolveScanCompatibilityRequest,
} from "@csb/shared";

import type { StoredProviderConnection } from "../connections-store.js";
import {
  resolveCompatibility,
  type ResolvedConnectionCompatibility,
} from "./compatibility-resolver.js";
import { isCodexSecurityApiConnection } from "../scanners/codex-security-api-bridge.js";

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
      });
      if (!resolved.eligible) return publicDecision(resolved);
      return runnerIsWired(input, connection, resolved)
        ? publicDecision(resolved)
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
    return resolved.runnerKind === "codex-security-contract" &&
      (connection.routeKind === "openai-codex-local" ||
        connection.routeKind === "openai-chatgpt-app-server" ||
        isCodexSecurityApiConnection(connection));
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
  if (input.engine === "mantis") {
    if (connection.routeKind === "xai-oauth" || connection.protocol === "xai-oauth-responses") {
      return connection.providerKind === "xai" &&
        connection.routeKind === "xai-oauth" &&
        connection.transport === "http-inference" &&
        connection.authKind === "device-code" &&
        connection.protocol === "xai-oauth-responses" &&
        connection.credentialRef === null;
    }
    return isWiredHttpRoute(connection.routeKind, connection.protocol);
  }
  if (input.engine === "vulnhunter") {
    return isWiredHttpRoute(connection.routeKind, connection.protocol) ||
      (connection.providerKind === "xai" &&
        connection.routeKind === "xai-oauth" &&
        connection.transport === "http-inference" &&
        connection.authKind === "device-code" &&
        connection.protocol === "xai-oauth-responses");
  }
  return false;
}

function isWiredHttpRoute(routeKind: string, protocol: ProviderProtocol): boolean {
  if (protocol === "openai-responses") {
    return routeKind === "openai-api" || routeKind === "xai-api";
  }
  if (protocol === "openai-chat") {
    return [
      "openrouter-api",
      "gemini-api",
      "deepseek-api",
      "custom-openai-compatible",
    ].includes(routeKind);
  }
  if (protocol === "anthropic-messages") {
    return [
      "anthropic-api",
      "minimax-token-plan",
      "mimo-token-plan",
      "custom-anthropic-compatible",
    ].includes(routeKind);
  }
  return protocol === "xai-oauth-responses" && routeKind === "xai-oauth";
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
): ConnectionCompatibility {
  return {
    connectionId: decision.connectionId,
    modelSelectionMode: decision.modelSelectionMode,
    modelId: decision.modelId,
    eligible: decision.eligible,
    reasons: [...decision.reasons],
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
