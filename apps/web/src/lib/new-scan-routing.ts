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
  | { kind: "configurable"; options: string[]; selected: string };

/** One equal-width column per provider-published option; no fixed cap. */
export const reasoningEffortGridClass = "grid grid-flow-col auto-cols-fr border border-border";

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
      : metadata.options[0] ?? null;
  if (selected === null) return { kind: "provider-managed", options: [], selected: null };
  return {
    kind: "configurable",
    options: [...metadata.options],
    selected,
  };
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
    ...(reasoning.kind === "configurable" ? { effort: reasoning.selected } : {}),
    connection: selection,
  };
}
