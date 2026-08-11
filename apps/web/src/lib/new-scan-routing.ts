import type {
  ConnectionCompatibility,
  ProviderConnection,
  ProviderModel,
  ScanConnectionSelection,
  StartScanRequest,
} from "@csb/shared";

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
): "newScan.compatibilityCodexGatewayUnproven" | "newScan.compatibilityBlocked" {
  return reasons.includes("codex_security_gateway_feature_unproven")
    ? "newScan.compatibilityCodexGatewayUnproven"
    : "newScan.compatibilityBlocked";
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
  const { selection, compatibility, effort: _untrustedEffort, reasoning, ...request } = input;
  if (
    compatibility === null ||
    !compatibility.eligible ||
    compatibility.connectionId !== selection.connectionId ||
    compatibility.modelSelectionMode !== selection.modelSelectionMode ||
    compatibility.modelId !== selection.modelId
  ) return null;
  return {
    ...request,
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
