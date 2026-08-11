import type {
  CapabilityReport,
  ConnectionCompatibility,
  ProviderConnection,
  ProviderModel,
  ResolveScanCompatibilityRequest,
  ScanConnectionSelection,
  ScannerEngine,
  StartScanRequest,
} from "@csb/shared";

const CAPABILITY_PROBE_REASONS = new Set([
  "capability_probe_missing",
  "capability_probe_stale",
  "capability_probe_failed",
  "codex_portable_capability_required",
  "codex_portable_capability_stale",
  "codex_portable_capability_failed",
]);

/** Legacy runtime discovery is informational; server compatibility owns route eligibility. */
export function canResolveConnectionWithEngine(engine: Pick<{ enabled: boolean; available: boolean }, "enabled" | "available">): boolean {
  return engine.enabled;
}

export function connectionSelectionFor(
  connection: ProviderConnection | null,
  models: readonly ProviderModel[],
  selectedModelId: string | null,
): ScanConnectionSelection | null {
  if (connection === null) return null;
  if (connection.modelSelectionMode === "runtime-default") {
    return { connectionId: connection.id, modelSelectionMode: "runtime-default", modelId: null };
  }
  if (selectedModelId === null || !models.some((model) => model.connectionId === connection.id && model.id === selectedModelId)) return null;
  return { connectionId: connection.id, modelSelectionMode: "catalog", modelId: selectedModelId };
}

export type ReasoningEffortControl =
  | { kind: "provider-managed"; options: []; selected: null }
  | { kind: "configurable"; options: string[]; selected: string | null };

/** Lets the viewport shrink instead of inheriting its scrollable grid width. */
export const reasoningEffortPanelClass = "min-w-0 border-b p-4 md:border-b-0 md:border-r";

/** Keeps overflow inside the control when a provider publishes many long labels. */
export const reasoningEffortViewportClass = "min-w-0 max-w-full overflow-x-auto overscroll-x-contain";

/** One equal-width, readable column per provider-published option; no fixed cap. */
export const reasoningEffortGridClass = "grid w-max min-w-full grid-flow-col auto-cols-[minmax(8rem,1fr)] border border-border";

export function compatibilityReasonKey(
  reasons: readonly string[],
): "newScan.compatibilityCodexGatewayUnproven" | "newScan.compatibilityPortableRequired" | "newScan.compatibilityPortableStale" | "newScan.compatibilityPortableFailed" | "newScan.compatibilityPortableRunnerUnavailable" | "newScan.compatibilityBlocked" {
  if (reasons.includes("provider_runner_unavailable")) {
    return "newScan.compatibilityPortableRunnerUnavailable";
  }
  if (reasons.includes("capability_probe_missing") || reasons.includes("codex_portable_capability_required")) {
    return "newScan.compatibilityPortableRequired";
  }
  if (reasons.includes("capability_probe_stale") || reasons.includes("codex_portable_capability_stale")) {
    return "newScan.compatibilityPortableStale";
  }
  if (reasons.includes("capability_probe_failed") || reasons.includes("codex_portable_capability_failed")) {
    return "newScan.compatibilityPortableFailed";
  }
  return reasons.includes("codex_security_gateway_feature_unproven")
    ? "newScan.compatibilityCodexGatewayUnproven"
    : "newScan.compatibilityBlocked";
}

/**
 * A capability-only block is the one preflight state that can be resolved by
 * a short, selected-model proof. Every other server reason remains blocked.
 */
export function isProbeOnlyCompatibilityBlock(
  compatibility: ConnectionCompatibility | null,
): boolean {
  return compatibility !== null &&
    !compatibility.eligible &&
    compatibility.reasons.length > 0 &&
    compatibility.reasons.every((reason) => CAPABILITY_PROBE_REASONS.has(reason));
}

export interface CapabilityValidationClient {
  probeConnection(connectionId: string, selection: ScanConnectionSelection): Promise<{
    report: CapabilityReport;
  }>;
  resolveScanCompatibility(request: ResolveScanCompatibilityRequest): Promise<ConnectionCompatibility>;
}

export interface CapabilityValidationInput {
  engine: ScannerEngine;
  selection: ScanConnectionSelection;
  remoteRepositoryConfirmed: boolean;
}

/**
 * This deliberately has no scan client: preflight can prove only one selected
 * provider model, then asks the server to recompute the route eligibility.
 */
export async function validateConnectionCapability(
  client: CapabilityValidationClient,
  input: CapabilityValidationInput,
): Promise<{ report: CapabilityReport; compatibility: ConnectionCompatibility }> {
  if (input.selection.modelSelectionMode !== "catalog" || input.selection.modelId === null) {
    throw new Error("invalid_model_selection");
  }
  const { report } = await client.probeConnection(input.selection.connectionId, input.selection);
  const compatibility = await client.resolveScanCompatibility({
    engine: input.engine,
    selection: input.selection,
    remoteRepositoryConfirmed: input.remoteRepositoryConfirmed,
    ...(input.engine === "codex-security" ? { executionProfilePreference: "auto" } : {}),
  });
  return { report, compatibility };
}

export function reasoningEffortForModel(
  model: ProviderModel | null,
  selectedEffort: string | null,
): ReasoningEffortControl {
  const metadata = model?.reasoningEffort;
  if (metadata === undefined || metadata.options.length === 0) {
    return { kind: "provider-managed", options: [], selected: null };
  }
  const selected = selectedEffort !== null && metadata.options.includes(selectedEffort)
    ? selectedEffort
    : metadata.default !== null && metadata.options.includes(metadata.default)
      ? metadata.default
      : null;
  return {
    kind: "configurable",
    options: [...metadata.options],
    selected,
  };
}

/** The model's own catalog default is the only safe reset across model changes. */
export function defaultReasoningEffortForModel(model: ProviderModel | null): string | null {
  const metadata = model?.reasoningEffort;
  return metadata !== undefined &&
    metadata.default !== null &&
    metadata.options.includes(metadata.default)
    ? metadata.default
    : null;
}

type ConnectionAwareStartInput = Omit<StartScanRequest, "connection" | "provider" | "authMode" | "model"> & {
  selection: ScanConnectionSelection;
  compatibility: ConnectionCompatibility | null;
  reasoning: ReasoningEffortControl;
};

export function buildConnectionAwareStartRequest(input: ConnectionAwareStartInput): StartScanRequest | null {
  const {
    selection,
    compatibility,
    effort: _untrustedEffort,
    executionProfilePreference: _untrustedProfilePreference,
    reasoning,
    ...request
  } = input;
  if (
    compatibility === null ||
    !compatibility.eligible ||
    compatibility.connectionId !== selection.connectionId ||
    compatibility.modelSelectionMode !== selection.modelSelectionMode ||
    compatibility.modelId !== selection.modelId
  ) return null;
  return {
    ...request,
    ...(request.engine === "codex-security" ? { executionProfilePreference: "auto" as const } : {}),
    ...(reasoning.kind === "configurable" && reasoning.selected !== null
      ? { effort: reasoning.selected }
      : {}),
    connection: selection,
  };
}

export interface LiveConnectionModelsClient {
  listConnectionModels(connectionId: string): Promise<ProviderModel[]>;
  refreshConnectionModels(connectionId: string): Promise<{
    discovery: {
      models: ProviderModel[];
      safeError?: { code: string };
    };
  }>;
}

/**
 * Refreshes every catalog-backed route through its registered adapter. When a
 * provider cannot be reached, the last known catalog remains usable; no model
 * or provider name is used to infer capabilities.
 */
export async function loadLiveConnectionModels(
  client: LiveConnectionModelsClient,
  connectionId: string,
): Promise<ProviderModel[]> {
  const cached = client.listConnectionModels(connectionId).then(
    (models) => ({ ok: true as const, models }),
    () => ({ ok: false as const, models: [] as ProviderModel[] }),
  );
  try {
    const refreshed = await client.refreshConnectionModels(connectionId);
    if (refreshed.discovery.safeError === undefined) {
      return refreshed.discovery.models;
    }
  } catch {
    // The cached outcome below is the deliberate degraded-mode fallback.
  }
  const fallback = await cached;
  if (fallback.ok) return fallback.models;
  throw new Error("model_catalog_unavailable");
}
