import type {
  CapabilityReport,
  ConnectionCompatibility,
  ProviderConnection,
  ProviderModel,
  ProviderProtocol,
  ScannerEngine,
  ScanConnectionSelection,
} from "@csb/shared";

export type RunnerKind =
  | "codex-security-contract"
  | "codex-app-server"
  | "agent-session"
  | "remote-agent-job";

export type CompatibilityReason =
  | "connection_not_ready"
  | "invalid_model_selection"
  | "model_catalog_stale"
  | "model_not_found"
  | "codex_security_provider_unsupported"
  | "capability_probe_missing"
  | "capability_probe_mismatch"
  | "capability_probe_stale"
  | "capability_probe_failed"
  | "agent_tools_unproven"
  | "artifact_output_missing"
  | "structured_result_unproven"
  | "bounded_execution_unproven"
  | "cancellation_unproven"
  | "sandbox_unverified"
  | "snapshot_read_only_required"
  | "static_analysis_profile_required"
  | "remote_repository_confirmation_required"
  | "runner_capability_missing";

export interface ResolvedConnectionCompatibility extends ConnectionCompatibility {
  reasons: CompatibilityReason[];
  runnerKind: RunnerKind | null;
  protocol: ProviderProtocol | null;
  capabilityCheckId: string | null;
}

export interface CompatibilityInput {
  engine: ScannerEngine;
  connection: ProviderConnection;
  selection: ScanConnectionSelection;
  model: ProviderModel | null;
  probe?: CapabilityReport | null;
  now?: Date;
  maxProbeAgeMs?: number;
  snapshotReadOnly?: boolean;
  staticAnalysisProfile?: boolean;
  remoteRepositoryConfirmed?: boolean;
}

export const DEFAULT_CAPABILITY_PROBE_MAX_AGE_MS = 60 * 60 * 1000;

const CODEX_SECURITY_ROUTES = new Set([
  "openai-codex-local",
  "openai-chatgpt-app-server",
  "openai-api",
]);

/**
 * Resolves only persisted server-side facts. This function never reaches a
 * provider, reads a vault, starts a process, or accepts client capability flags.
 */
export function resolveCompatibility(
  input: CompatibilityInput,
): ResolvedConnectionCompatibility {
  const reasons: CompatibilityReason[] = [];
  const base = {
    connectionId: input.selection.connectionId,
    modelSelectionMode: input.selection.modelSelectionMode,
    modelId: input.selection.modelId,
  } as const;

  if (input.connection.id !== input.selection.connectionId) {
    return blocked(base, ["invalid_model_selection"]);
  }
  if (input.connection.status !== "ready") reasons.push("connection_not_ready");
  reasons.push(...selectionReasons(input));
  if (reasons.length > 0) return blocked(base, unique(reasons));

  if (input.engine === "codex-security") {
    if (
      input.connection.providerKind !== "openai" ||
      !CODEX_SECURITY_ROUTES.has(input.connection.routeKind)
    ) {
      return blocked(base, ["codex_security_provider_unsupported"]);
    }
    return eligible(
      base,
      "codex-security-contract",
      input.connection.protocol,
      null,
    );
  }

  if (input.connection.transport === "remote-agent-api") {
    if (
      input.connection.routeKind !== "cursor-background-agents" ||
      input.connection.protocol !== "cursor-background-agents"
    ) return blocked(base, ["runner_capability_missing"]);
    if (input.remoteRepositoryConfirmed !== true) {
      return blocked(base, ["remote_repository_confirmation_required"]);
    }
    return withMethodologyRequirements(
      input,
      eligible(base, "remote-agent-job", input.connection.protocol, null),
    );
  }

  if (
    input.connection.transport === "codex-app-server" &&
    input.connection.protocol === "codex-app-server" &&
    (input.connection.routeKind === "openai-codex-local" ||
      input.connection.routeKind === "openai-chatgpt-app-server")
  ) {
    return withMethodologyRequirements(
      input,
      eligible(base, "codex-app-server", input.connection.protocol, null),
    );
  }

  if (input.connection.transport !== "http-inference") {
    return blocked(base, ["runner_capability_missing"]);
  }

  const probeReasons = validateAgentProbe(input);
  if (probeReasons.length > 0) return blocked(base, probeReasons);

  return withMethodologyRequirements(
    input,
    eligible(
      base,
      "agent-session",
      input.connection.protocol,
      input.probe!.id,
    ),
  );
}

function selectionReasons(input: CompatibilityInput): CompatibilityReason[] {
  const { connection, model, selection } = input;
  if (selection.modelSelectionMode === "runtime-default") {
    return selection.modelId === null &&
        model === null &&
        connection.modelSelectionMode === "runtime-default" &&
        connection.routeKind === "claude-code-local"
      ? []
      : ["invalid_model_selection"];
  }
  if (connection.modelCatalogStale) return ["model_catalog_stale"];
  if (
    selection.modelId === null ||
    model === null ||
    model.connectionId !== connection.id ||
    model.id !== selection.modelId
  ) return ["model_not_found"];
  return [];
}

function validateAgentProbe(input: CompatibilityInput): CompatibilityReason[] {
  const report = input.probe;
  if (report === undefined || report === null) return ["capability_probe_missing"];
  if (
    report.connectionId !== input.connection.id ||
    report.modelId !== input.selection.modelId ||
    report.protocol !== input.connection.protocol
  ) return ["capability_probe_mismatch"];

  const checkedAt = Date.parse(report.checkedAt);
  const now = (input.now ?? new Date()).getTime();
  const maxAge = input.maxProbeAgeMs ?? DEFAULT_CAPABILITY_PROBE_MAX_AGE_MS;
  if (
    !Number.isFinite(checkedAt) ||
    !Number.isSafeInteger(maxAge) ||
    maxAge <= 0 ||
    checkedAt > now ||
    now - checkedAt > maxAge
  ) return ["capability_probe_stale"];

  if (report.status !== "passed") return ["capability_probe_failed"];
  const capabilities = report.capabilities;
  const reasons: CompatibilityReason[] = [];
  if (capabilities.tools !== "supported") reasons.push("agent_tools_unproven");
  if (capabilities.artifactOutput !== "supported") reasons.push("artifact_output_missing");
  if (capabilities.structuredOutput !== "supported") reasons.push("structured_result_unproven");
  if (capabilities.boundedExecution !== "supported") reasons.push("bounded_execution_unproven");
  if (capabilities.cancellation !== "supported") reasons.push("cancellation_unproven");
  if (capabilities.osIsolation !== "supported") reasons.push("sandbox_unverified");
  return reasons;
}

function withMethodologyRequirements(
  input: CompatibilityInput,
  decision: ResolvedConnectionCompatibility,
): ResolvedConnectionCompatibility {
  if (input.engine !== "vulnhunter") return decision;
  const reasons: CompatibilityReason[] = [];
  if (input.snapshotReadOnly !== true) reasons.push("snapshot_read_only_required");
  if (input.staticAnalysisProfile !== true) reasons.push("static_analysis_profile_required");
  return reasons.length === 0
    ? decision
    : blocked({
      connectionId: decision.connectionId,
      modelSelectionMode: decision.modelSelectionMode,
      modelId: decision.modelId,
    }, reasons);
}

function eligible(
  selection: ScanConnectionSelection,
  runnerKind: RunnerKind,
  protocol: ProviderProtocol,
  capabilityCheckId: string | null,
): ResolvedConnectionCompatibility {
  return {
    ...selection,
    eligible: true,
    reasons: [],
    runnerKind,
    protocol,
    capabilityCheckId,
  };
}

function blocked(
  selection: ScanConnectionSelection,
  reasons: CompatibilityReason[],
): ResolvedConnectionCompatibility {
  return {
    ...selection,
    eligible: false,
    reasons,
    runnerKind: null,
    protocol: null,
    capabilityCheckId: null,
  };
}

function unique(reasons: CompatibilityReason[]): CompatibilityReason[] {
  return [...new Set(reasons)];
}
