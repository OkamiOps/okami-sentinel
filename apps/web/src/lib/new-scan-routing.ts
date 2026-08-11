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

type ConnectionAwareStartInput = Omit<StartScanRequest, "connection" | "provider" | "authMode" | "model"> & {
  selection: ScanConnectionSelection;
  compatibility: ConnectionCompatibility | null;
};

export function buildConnectionAwareStartRequest(input: ConnectionAwareStartInput): StartScanRequest | null {
  const { selection, compatibility, ...request } = input;
  if (
    compatibility === null ||
    !compatibility.eligible ||
    compatibility.connectionId !== selection.connectionId ||
    compatibility.modelSelectionMode !== selection.modelSelectionMode ||
    compatibility.modelId !== selection.modelId
  ) return null;
  return { ...request, connection: selection };
}
