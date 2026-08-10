import type {
  ConnectionAuthKind,
  ConnectionSecretInput,
  ConnectionTransport,
  CreateProviderConnectionRequest,
  ModelSelectionMode,
  ProviderConnection,
  ProviderProtocol,
  UpdateProviderConnectionRequest,
} from "@csb/shared";

export interface ConnectionDraft {
  name: string;
  providerKind: string;
  routeKind: string;
  transport: ConnectionTransport;
  authKind: ConnectionAuthKind;
  protocol: ProviderProtocol;
  modelSelectionMode: ModelSelectionMode;
  apiKey: string;
  baseUrl: string;
  discoveryUrl: string;
  headers: string;
}

export type ConnectionDraftError = "name" | "provider" | "route" | "headers" | "secret" | null;

export function blankConnectionDraft(connection?: ProviderConnection): ConnectionDraft {
  return {
    name: connection?.name ?? "",
    providerKind: connection?.providerKind ?? "custom",
    routeKind: connection?.routeKind ?? "openai-compatible",
    transport: connection?.transport ?? "http-inference",
    authKind: connection?.authKind ?? "api-key",
    protocol: connection?.protocol ?? "openai-chat",
    modelSelectionMode: connection?.modelSelectionMode ?? "catalog",
    apiKey: "",
    baseUrl: "",
    discoveryUrl: "",
    headers: "",
  };
}

export function selectConnection(
  connections: ProviderConnection[],
  connectionId: string | null,
): ProviderConnection | null {
  if (connections.length === 0) return null;
  return connections.find((connection) => connection.id === connectionId) ?? connections[0];
}

export function validateConnectionDraft(
  draft: ConnectionDraft,
  options: { requireHttpSecret?: boolean } = {},
): ConnectionDraftError {
  if (!draft.name.trim()) return "name";
  if (!draft.providerKind.trim()) return "provider";
  if (!draft.routeKind.trim()) return "route";
  if (draft.headers.trim() && parseSecretHeaders(draft.headers) === null) return "headers";
  if (draft.transport === "http-inference" && options.requireHttpSecret !== false && !connectionSecretInput(draft)) return "secret";
  return null;
}

export function changeConnectionTransport(
  draft: ConnectionDraft,
  transport: ConnectionTransport,
): ConnectionDraft {
  if (transport === "local-cli") {
    return {
      ...draft,
      transport,
      authKind: "existing-session",
      protocol: "codex-cli",
      modelSelectionMode: "runtime-default",
      apiKey: "",
      baseUrl: "",
      discoveryUrl: "",
      headers: "",
    };
  }
  return {
    ...draft,
    transport,
    authKind: "api-key",
    protocol: "openai-chat",
    modelSelectionMode: "catalog",
  };
}

export function createConnectionRequest(draft: ConnectionDraft): CreateProviderConnectionRequest {
  return {
    name: draft.name.trim(),
    providerKind: draft.providerKind.trim(),
    routeKind: draft.routeKind.trim(),
    transport: draft.transport,
    authKind: draft.authKind,
    protocol: draft.protocol,
    modelSelectionMode: draft.modelSelectionMode,
    ...connectionSecretRequest(draft),
  };
}

export function updateConnectionRequest(draft: ConnectionDraft): UpdateProviderConnectionRequest {
  if (draft.transport === "local-cli") return { name: draft.name.trim() };
  return {
    name: draft.name.trim(),
    ...connectionSecretRequest(draft),
  };
}

function connectionSecretRequest(draft: ConnectionDraft): { secret?: ConnectionSecretInput } {
  const secret = connectionSecretInput(draft);
  return secret ? { secret } : {};
}

export function connectionSecretInput(draft: ConnectionDraft): ConnectionSecretInput | undefined {
  const apiKey = draft.apiKey.trim();
  const baseUrl = draft.baseUrl.trim();
  const discoveryUrl = draft.discoveryUrl.trim();
  const headers = draft.headers.trim() ? parseSecretHeaders(draft.headers) : {};
  if (headers === null) return undefined;
  if (!apiKey && !baseUrl && !discoveryUrl && Object.keys(headers).length === 0) return undefined;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(discoveryUrl ? { discoveryUrl } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

export function parseSecretHeaders(value: string): Record<string, string> | null {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0 || !line.slice(separator + 1).trim()) return null;
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return headers;
}
