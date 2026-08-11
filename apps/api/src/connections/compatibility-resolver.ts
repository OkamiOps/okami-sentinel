import type {
  CapabilityReport,
  CodexSecurityExecutionProfile,
  CodexSecurityProfilePreference,
  ConnectionCompatibility,
  ModelReasoningEffort,
  ProviderConnection,
  ProviderModel,
  ProviderProtocol,
  ScannerEngine,
  ScanConnectionSelection,
} from "@csb/shared";
import {
  PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
  PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
  isPortableCodexSecurityRoute,
} from "../scanners/portable-codex-security-profile.js";
import {
  CURRENT_AGENT_SESSION_CONTRACT_VERSION,
  hasAgentSessionReasoningEffortCodec,
} from "../agent/session-types.js";
export type RunnerKind =
  | "codex-security-contract"
  | "codex-app-server"
  | "agent-session"
  | "local-agent-session"
  | "remote-agent-job";

export type CompatibilityReason =
  | "connection_not_ready"
  | "invalid_model_selection"
  | "model_catalog_stale"
  | "model_not_found"
  | "codex_security_provider_unsupported"
  | "codex_security_gateway_feature_unproven"
  | "codex_native_contract_unavailable"
  | "invalid_execution_profile_preference"
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

/**
 * The scanner launch boundary, not the browser catalog, owns whether a
 * provider-published effort value is actionable for this runner.
 */
export function effectiveReasoningEffort(
  model: ProviderModel | null,
  connection: ProviderConnection,
  decision: Pick<ResolvedConnectionCompatibility, "eligible" | "runnerKind">,
): ModelReasoningEffort | undefined {
  const metadata = model?.reasoningEffort;
  if (
    !decision.eligible ||
    decision.runnerKind === null ||
    !hasReasoningEffortCodec(connection, decision.runnerKind) ||
    metadata === undefined ||
    metadata.options.length === 0
  ) return undefined;
  return {
    options: [...metadata.options],
    default: metadata.default,
  };
}

function hasReasoningEffortCodec(
  connection: ProviderConnection,
  runnerKind: RunnerKind,
): boolean {
  if (runnerKind === "codex-security-contract" || runnerKind === "codex-app-server") {
    return isCodexSecurityRoute(connection);
  }
  return runnerKind === "agent-session" &&
    hasAgentSessionReasoningEffortCodec(connection.routeKind, connection.protocol);
}

export interface CompatibilityInput {
  engine: ScannerEngine;
  /** Stored callers supply the vault reference; generic HTTP callers may omit it. */
  connection: ProviderConnection & { credentialRef?: string | null };
  selection: ScanConnectionSelection;
  model: ProviderModel | null;
  probe?: CapabilityReport | null;
  now?: Date;
  maxProbeAgeMs?: number;
  snapshotReadOnly?: boolean;
  staticAnalysisProfile?: boolean;
  remoteRepositoryConfirmed?: boolean;
  executionProfilePreference?: CodexSecurityProfilePreference;
}

export const DEFAULT_CAPABILITY_PROBE_MAX_AGE_MS = 60 * 60 * 1000;

function isExecutionProfilePreference(
  value: unknown,
): value is CodexSecurityProfilePreference | undefined {
  return value === undefined || value === "auto" || value === "native" || value === "portable";
}

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
  if (!isExecutionProfilePreference(input.executionProfilePreference)) {
    return blocked(base, ["invalid_execution_profile_preference"]);
  }
  if (input.connection.status !== "ready") reasons.push("connection_not_ready");
  reasons.push(...selectionReasons(input));
  if (reasons.length > 0) return blocked(base, unique(reasons));

  if (input.engine === "codex-security") {
    const profiles = resolveCodexSecurityProfiles(input);
    if (!profiles.eligible || profiles.runnerKind === null || profiles.protocol === null) {
      return blockedWithProfiles(base, profiles);
    }
    return {
      ...eligible(base, profiles.runnerKind, profiles.protocol, profiles.capabilityCheckId),
      selectedProfile: profiles.selectedProfile,
      availableProfiles: profiles.availableProfiles,
      profileVersion: profiles.profileVersion,
      methodologyRef: profiles.methodologyRef,
    };
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

  if (isClaudeCodeLocalMantisSession(input)) {
    return eligible(
      base,
      "local-agent-session",
      input.connection.protocol,
      null,
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

export interface CodexSecurityProfileResolution {
  eligible: boolean;
  selectedProfile: CodexSecurityExecutionProfile | null;
  availableProfiles: CodexSecurityExecutionProfile[];
  reasons: CompatibilityReason[];
  runnerKind: RunnerKind | null;
  protocol: ProviderProtocol | null;
  capabilityCheckId: string | null;
  profileVersion: string | null;
  methodologyRef: string | null;
}

/**
 * Resolves execution profile solely from persisted connection, catalog, and
 * probe facts. It does not read a credential or make a network request.
 */
export function resolveCodexSecurityProfiles(
  input: CompatibilityInput,
): CodexSecurityProfileResolution {
  const native = isCodexSecurityRoute(input.connection);
  const portableReasons = validateAgentProbe(input);
  const portable = input.connection.transport === "http-inference" &&
    portableReasons.length === 0 &&
    isPortableCodexSecurityRoute(input.connection.routeKind, input.connection.protocol);
  const availableProfiles: CodexSecurityExecutionProfile[] = [
    ...(native ? ["native" as const] : []),
    ...(portable ? ["portable" as const] : []),
  ];
  const preference = input.executionProfilePreference ?? "auto";
  const selectedProfile = preference === "native"
    ? native ? "native" : null
    : preference === "portable"
    ? portable ? "portable" : null
    : native ? "native" : portable ? "portable" : null;

  if (selectedProfile === "native") {
    return {
      eligible: true,
      selectedProfile,
      availableProfiles,
      reasons: [],
      runnerKind: "codex-security-contract",
      protocol: input.connection.protocol,
      capabilityCheckId: null,
      profileVersion: "openai-codex-security-native-v1",
      methodologyRef: "@openai/codex-security",
    };
  }
  if (selectedProfile === "portable") {
    return {
      eligible: true,
      selectedProfile,
      availableProfiles,
      reasons: [],
      runnerKind: "agent-session",
      protocol: input.connection.protocol,
      capabilityCheckId: input.probe!.id,
      profileVersion: PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
      methodologyRef: PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
    };
  }

  return {
    eligible: false,
    selectedProfile: null,
    availableProfiles,
    reasons: preference === "native"
      ? ["codex_native_contract_unavailable"]
      : portableReasons.length > 0
      ? portableReasons
      : ["codex_security_provider_unsupported"],
    runnerKind: null,
    protocol: null,
    capabilityCheckId: null,
    profileVersion: null,
    methodologyRef: null,
  };
}

/**
 * Local-agent eligibility is deliberately narrower than local route
 * registration. The defensive execution seam currently reviews only this
 * exact Claude Code session; Grok and Cursor remain fail-closed.
 */
function isClaudeCodeLocalMantisSession(input: CompatibilityInput): boolean {
  const { connection } = input;
  return input.engine === "mantis" &&
    connection.providerKind === "anthropic" &&
    connection.routeKind === "claude-code-local" &&
    connection.transport === "local-cli" &&
    connection.authKind === "existing-session" &&
    connection.protocol === "claude-code-cli" &&
    connection.credentialRef === null;
}

function isCodexSecurityRoute(
  connection: ProviderConnection,
): boolean {
  if (
    connection.providerKind === "openai" &&
    connection.routeKind === "openai-api"
  ) {
    return connection.transport === "http-inference" &&
      connection.authKind === "api-key" &&
      connection.protocol === "openai-responses";
  }
  if (
    connection.providerKind === "openai" &&
    connection.transport === "codex-app-server" &&
    connection.protocol === "codex-app-server"
  ) {
    if (connection.routeKind === "openai-codex-local") {
      return connection.authKind === "existing-session";
    }
    if (connection.routeKind === "openai-chatgpt-app-server") {
      return connection.authKind === "browser-oauth" ||
        connection.authKind === "device-code";
    }
  }
  return false;
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
  if (connection.modelSelectionMode !== "catalog") return ["invalid_model_selection"];
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

  if (report.agentContractVersion !== CURRENT_AGENT_SESSION_CONTRACT_VERSION) {
    return ["capability_probe_stale"];
  }

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

function blockedWithProfiles(
  selection: ScanConnectionSelection,
  profiles: CodexSecurityProfileResolution,
): ResolvedConnectionCompatibility {
  return {
    ...blocked(selection, profiles.reasons),
    selectedProfile: profiles.selectedProfile,
    availableProfiles: profiles.availableProfiles,
    profileVersion: profiles.profileVersion,
    methodologyRef: profiles.methodologyRef,
  };
}

function unique(reasons: CompatibilityReason[]): CompatibilityReason[] {
  return [...new Set(reasons)];
}
