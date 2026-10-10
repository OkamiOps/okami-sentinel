import {
  canonicalMimoTokenPlanModelId,
  mimoTokenPlanModelIdsMatch,
  type CapabilityReport,
  type CodexSecurityProfilePreference,
  type ModelReasoningEffort,
  type ScanExecutionProvenance,
  type ProviderModel,
  type ProviderProtocol,
  type ScannerAuthMode,
  type ScannerEngine,
  type ScanConnectionSelection,
  type ScanConnectionSnapshot,
} from "@csb/shared";

import type { StoredProviderConnection } from "../connections-store.js";
import {
  effectiveReasoningEffort,
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
  executionProfilePreference?: CodexSecurityProfilePreference;
}

export interface ScanLaunchPlan {
  engine: ScannerEngine;
  connectionId: string;
  providerKind: string;
  routeKind: string;
  runnerKind: RunnerKind;
  protocol: ProviderProtocol;
  model: ProviderModel | null;
  /** Server-owned effective effort metadata for an actionable runner only. */
  reasoningEffort?: ModelReasoningEffort;
  capabilityCheckId: string | null;
  /** Execution provenance is either pinned for Codex Security or explicitly absent. */
  execution: ScanExecutionProvenance | null;
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
  dependencies: LaunchPlanStore & { now?: () => Date; runtimeMode?: "local" | "server" },
): LaunchPlanResolver {
  const now = dependencies.now ?? (() => new Date());
  const runtimeMode = dependencies.runtimeMode ?? "local";
  return {
    resolve(input) {
      const resolvedAt = now();
      const connection = dependencies.getConnection(input.selection.connectionId);
      if (connection === null) throw new LaunchPlanError("connection_not_found");

      const resolvedCatalog = resolveMimoSuccessorSelection(
        connection,
        input.selection,
        dependencies,
      );
      const selection = resolvedCatalog.selection;
      const model = resolvedCatalog.model;
      const capability = resolvedCatalog.capability;

      const compatibility = resolveCompatibility({
        engine: input.engine,
        runtimeMode,
        connection,
        selection,
        model,
        probe: capability,
        now: resolvedAt,
        snapshotReadOnly: input.engine === "vulnhunter",
        staticAnalysisProfile: input.engine === "vulnhunter",
        remoteRepositoryConfirmed: input.remoteRepositoryConfirmed,
        executionProfilePreference: input.executionProfilePreference,
      });
      if (
        !compatibility.eligible ||
        compatibility.runnerKind === null ||
        compatibility.protocol === null
      ) {
        throw new LaunchPlanError(compatibility.reasons[0] ?? "runner_capability_missing");
      }

      const capturedAt = resolvedAt.toISOString();
      const reasoningEffort = effectiveReasoningEffort(model, connection, compatibility);
      const execution = input.engine === "codex-security" &&
          compatibility.selectedProfile !== undefined &&
          compatibility.selectedProfile !== null &&
          compatibility.profileVersion !== undefined &&
          compatibility.profileVersion !== null &&
          compatibility.methodologyRef !== undefined &&
          compatibility.methodologyRef !== null
        ? {
          executionProfile: compatibility.selectedProfile,
          profileVersion: compatibility.profileVersion,
          methodologyRef: compatibility.methodologyRef,
          capabilityCheckId: compatibility.capabilityCheckId,
          connectionId: connection.id,
          routeKind: connection.routeKind,
          protocol: compatibility.protocol,
          authKind: connection.authKind,
        }
        : null;
      const snapshot: ScanConnectionSnapshot = {
        scanId: input.scanId,
        connectionId: connection.id,
        routeKind: connection.routeKind,
        modelSelectionMode: selection.modelSelectionMode,
        modelId: selection.modelId,
        capabilityCheckId: compatibility.capabilityCheckId,
        executionProfile: execution?.executionProfile ?? null,
        profileVersion: execution?.profileVersion ?? null,
        methodologyRef: execution?.methodologyRef ?? null,
        protocol: compatibility.protocol,
        authKind: connection.authKind,
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
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        capabilityCheckId: compatibility.capabilityCheckId,
        execution,
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

/**
 * A saved v2.5 selection launches as its v2.6 successor. The probe may still
 * be stored under the retired id; it is aligned to the successor so the
 * existing capability check keeps authorizing the replacement model.
 * Historical snapshots are not rewritten here — only this new resolution.
 */
function resolveMimoSuccessorSelection(
  connection: StoredProviderConnection,
  selection: ScanConnectionSelection,
  dependencies: LaunchPlanStore,
): {
  selection: ScanConnectionSelection;
  model: ProviderModel | null;
  capability: CapabilityReport | null;
} {
  if (selection.modelSelectionMode !== "catalog") {
    return { selection, model: null, capability: null };
  }
  if (selection.modelId === null || connection.routeKind !== "mimo-token-plan") {
    return {
      selection,
      model: selection.modelId === null
        ? null
        : dependencies.getModel(connection.id, selection.modelId),
      capability: dependencies.getLatestCapabilityCheck(
        connection.id,
        selection.modelId,
        connection.protocol,
      ),
    };
  }

  const canonicalId = canonicalMimoTokenPlanModelId(selection.modelId);
  const lookupIds = canonicalId === selection.modelId
    ? [selection.modelId]
    : [canonicalId, selection.modelId];
  let model: ProviderModel | null = null;
  for (const modelId of lookupIds) {
    model = dependencies.getModel(connection.id, modelId);
    if (model !== null) break;
  }
  if (model !== null) {
    model = {
      ...model,
      id: canonicalId,
      displayName: model.displayName === model.id ? canonicalId : model.displayName,
    };
  }

  let capability: CapabilityReport | null = null;
  for (const modelId of lookupIds) {
    capability = dependencies.getLatestCapabilityCheck(
      connection.id,
      modelId,
      connection.protocol,
    );
    if (capability !== null) break;
  }
  if (
    capability !== null &&
    model !== null &&
    capability.modelId !== model.id &&
    capability.modelId !== null &&
    mimoTokenPlanModelIdsMatch(capability.modelId, model.id)
  ) {
    capability = { ...capability, modelId: model.id };
  }

  return {
    selection: model === null ? selection : { ...selection, modelId: model.id },
    model,
    capability,
  };
}

function scannerAuthMode(routeKind: string): ScannerAuthMode {
  if (routeKind === "claude-code-local") return "existing-session";
  return routeKind === "openai-api"
    ? "api-key"
    : "chatgpt";
}
