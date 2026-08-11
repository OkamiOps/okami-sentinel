import type {
  CapabilityReport,
  ProviderModel,
  ProviderProtocol,
  ScannerAuthMode,
  ScannerEngine,
  ScanConnectionSelection,
  ScanConnectionSnapshot,
} from "@csb/shared";

import type { StoredProviderConnection } from "../connections-store.js";
import {
  resolveCompatibility,
  type CompatibilityReason,
  type RunnerKind,
} from "./compatibility-resolver.js";

export type LaunchPlanErrorCode = "connection_not_found" | CompatibilityReason;

export class LaunchPlanError extends Error {
  constructor(readonly code: LaunchPlanErrorCode) {
    super(code);
    this.name = "LaunchPlanError";
  }
}

export interface LaunchPlanStore {
  getConnection(id: string): StoredProviderConnection | null;
  getModel(connectionId: string, modelId: string): ProviderModel | null;
  getLatestCapabilityCheck(
    connectionId: string,
    modelId: string | null,
    protocol: ProviderProtocol,
  ): CapabilityReport | null;
  writeSnapshot(snapshot: ScanConnectionSnapshot): void;
}

export interface ResolveLaunchPlanInput {
  scanId: string;
  engine: ScannerEngine;
  selection: ScanConnectionSelection;
  /** Required only for the explicitly remote Cursor route. */
  remoteRepositoryConfirmed?: boolean;
}

export interface ScanLaunchPlan {
  engine: ScannerEngine;
  connectionId: string;
  providerKind: string;
  routeKind: string;
  runnerKind: RunnerKind;
  protocol: ProviderProtocol;
  model: ProviderModel | null;
  capabilityCheckId: string | null;
  scannerAuthMode?: ScannerAuthMode;
  snapshot: ScanConnectionSnapshot;
}

export interface LaunchPlanResolver {
  resolve(input: ResolveLaunchPlanInput): ScanLaunchPlan;
}

/**
 * Resolves immutable metadata only. Vault access belongs to the selected
 * runner adapter after this boundary succeeds.
 */
export function createLaunchPlanResolver(
  dependencies: LaunchPlanStore & { now?: () => Date },
): LaunchPlanResolver {
  const now = dependencies.now ?? (() => new Date());
  return {
    resolve(input) {
      const resolvedAt = now();
      const connection = dependencies.getConnection(input.selection.connectionId);
      if (connection === null) throw new LaunchPlanError("connection_not_found");

      const model = input.selection.modelSelectionMode === "catalog" &&
          input.selection.modelId !== null
        ? dependencies.getModel(connection.id, input.selection.modelId)
        : null;
      const capability = input.selection.modelSelectionMode === "catalog"
        ? dependencies.getLatestCapabilityCheck(
          connection.id,
          input.selection.modelId,
          connection.protocol,
        )
        : null;

      const compatibility = resolveCompatibility({
        engine: input.engine,
        connection,
        selection: input.selection,
        model,
        probe: capability,
        now: resolvedAt,
        snapshotReadOnly: input.engine === "vulnhunter",
        staticAnalysisProfile: input.engine === "vulnhunter",
        remoteRepositoryConfirmed: input.remoteRepositoryConfirmed,
      });
      if (
        !compatibility.eligible ||
        compatibility.runnerKind === null ||
        compatibility.protocol === null
      ) {
        throw new LaunchPlanError(compatibility.reasons[0] ?? "runner_capability_missing");
      }

      const capturedAt = resolvedAt.toISOString();
      const snapshot: ScanConnectionSnapshot = {
        scanId: input.scanId,
        connectionId: connection.id,
        routeKind: connection.routeKind,
        modelSelectionMode: input.selection.modelSelectionMode,
        modelId: input.selection.modelId,
        capabilityCheckId: compatibility.capabilityCheckId,
        capturedAt,
      };
      dependencies.writeSnapshot(snapshot);

      return {
        engine: input.engine,
        connectionId: connection.id,
        providerKind: connection.providerKind,
        routeKind: connection.routeKind,
        runnerKind: compatibility.runnerKind,
        protocol: compatibility.protocol,
        model,
        capabilityCheckId: compatibility.capabilityCheckId,
        ...(compatibility.runnerKind === "codex-security-contract" ||
          compatibility.runnerKind === "codex-app-server" ||
          compatibility.runnerKind === "local-agent-session"
          ? { scannerAuthMode: scannerAuthMode(connection.routeKind) }
          : {}),
        snapshot,
      };
    },
  };
}

function scannerAuthMode(routeKind: string): ScannerAuthMode {
  if (routeKind === "claude-code-local") return "existing-session";
  return routeKind === "openai-api"
    ? "api-key"
    : "chatgpt";
}
