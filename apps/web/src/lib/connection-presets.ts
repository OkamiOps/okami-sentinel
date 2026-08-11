import type {
  ConnectionAuthKind,
  ConnectionTransport,
  ModelSelectionMode,
  ProviderConnection,
  ProviderProtocol,
} from "@csb/shared";

import type { ConnectionDraft } from "./connections.js";

type CredentialMode = "none" | "api-key" | "token-plan" | "custom" | "managed-oauth";
type EndpointMode = "none" | "preset" | "custom" | "mimo-region";

export type MimoTokenPlanRegionId = "cn" | "sgp" | "ams";

export interface ConnectionPreset {
  readonly id: string;
  readonly labelKey: ConnectionPresetLabelKey;
  readonly providerKind: string;
  readonly routeKind: string;
  readonly transport: ConnectionTransport;
  readonly authKind: ConnectionAuthKind;
  readonly protocol: ProviderProtocol;
  readonly modelSelectionMode: ModelSelectionMode;
  readonly credentialMode: CredentialMode;
  readonly endpointMode: EndpointMode;
}

export type ConnectionPresetLabelKey =
  | "connections.preset.openai-local-codex"
  | "connections.preset.openai-chatgpt-browser-oauth"
  | "connections.preset.openai-chatgpt-device-code"
  | "connections.preset.openai-api"
  | "connections.preset.xai-grok-local"
  | "connections.preset.xai-direct-device-oauth"
  | "connections.preset.xai-api"
  | "connections.preset.claude-code-local"
  | "connections.preset.anthropic-api"
  | "connections.preset.cursor-local"
  | "connections.preset.cursor-cloud-api"
  | "connections.preset.openrouter-api"
  | "connections.preset.gemini-api"
  | "connections.preset.deepseek-api"
  | "connections.preset.minimax-token-plan"
  | "connections.preset.mimo-token-plan"
  | "connections.preset.custom-openai-compatible"
  | "connections.preset.custom-anthropic-compatible";

export const MIMO_TOKEN_PLAN_REGIONS = Object.freeze([
  { id: "cn" as const, baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" },
  { id: "sgp" as const, baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
  { id: "ams" as const, baseUrl: "https://token-plan-ams.xiaomimimo.com/v1" },
]);

export const CONNECTION_PRESETS = Object.freeze([
  preset("openai-local-codex", "connections.preset.openai-local-codex", "openai", "openai-codex-local", "codex-app-server", "existing-session", "codex-app-server", "catalog", "none", "none"),
  preset("openai-chatgpt-browser-oauth", "connections.preset.openai-chatgpt-browser-oauth", "openai", "openai-chatgpt-app-server", "codex-app-server", "browser-oauth", "codex-app-server", "catalog", "managed-oauth", "preset"),
  preset("openai-chatgpt-device-code", "connections.preset.openai-chatgpt-device-code", "openai", "openai-chatgpt-app-server", "codex-app-server", "device-code", "codex-app-server", "catalog", "managed-oauth", "preset"),
  preset("openai-api", "connections.preset.openai-api", "openai", "openai-api", "http-inference", "api-key", "openai-responses", "catalog", "api-key", "preset"),
  preset("xai-grok-local", "connections.preset.xai-grok-local", "xai", "xai-grok-build-local", "local-cli", "existing-session", "grok-build-cli", "catalog", "none", "none"),
  preset("xai-direct-device-oauth", "connections.preset.xai-direct-device-oauth", "xai", "xai-oauth", "http-inference", "device-code", "xai-oauth-responses", "catalog", "managed-oauth", "preset"),
  preset("xai-api", "connections.preset.xai-api", "xai", "xai-api", "http-inference", "api-key", "openai-responses", "catalog", "api-key", "preset"),
  preset("claude-code-local", "connections.preset.claude-code-local", "anthropic", "claude-code-local", "local-cli", "existing-session", "claude-code-cli", "runtime-default", "none", "none"),
  preset("anthropic-api", "connections.preset.anthropic-api", "anthropic", "anthropic-api", "http-inference", "api-key", "anthropic-messages", "catalog", "api-key", "preset"),
  preset("cursor-local", "connections.preset.cursor-local", "cursor", "cursor-agent-local", "local-cli", "existing-session", "cursor-agent-cli", "catalog", "none", "none"),
  preset("cursor-cloud-api", "connections.preset.cursor-cloud-api", "cursor", "cursor-background-agents", "remote-agent-api", "api-key", "cursor-background-agents", "catalog", "api-key", "preset"),
  preset("openrouter-api", "connections.preset.openrouter-api", "openrouter", "openrouter-api", "http-inference", "api-key", "openai-chat", "catalog", "api-key", "preset"),
  preset("gemini-api", "connections.preset.gemini-api", "google", "gemini-api", "http-inference", "api-key", "openai-chat", "catalog", "api-key", "preset"),
  preset("deepseek-api", "connections.preset.deepseek-api", "deepseek", "deepseek-api", "http-inference", "api-key", "openai-chat", "catalog", "api-key", "preset"),
  preset("minimax-token-plan", "connections.preset.minimax-token-plan", "minimax", "minimax-token-plan", "http-inference", "api-key", "anthropic-messages", "catalog", "token-plan", "preset"),
  preset("mimo-token-plan", "connections.preset.mimo-token-plan", "xiaomi", "mimo-token-plan", "http-inference", "api-key", "anthropic-messages", "catalog", "token-plan", "mimo-region"),
  preset("custom-openai-compatible", "connections.preset.custom-openai-compatible", "custom", "custom-openai-compatible", "http-inference", "api-key", "openai-chat", "catalog", "custom", "custom"),
  preset("custom-anthropic-compatible", "connections.preset.custom-anthropic-compatible", "custom", "custom-anthropic-compatible", "http-inference", "api-key", "anthropic-messages", "catalog", "custom", "custom"),
] as const satisfies readonly ConnectionPreset[]);

export type ConnectionPresetId = (typeof CONNECTION_PRESETS)[number]["id"];

function preset(
  id: string,
  labelKey: ConnectionPresetLabelKey,
  providerKind: string,
  routeKind: string,
  transport: ConnectionTransport,
  authKind: ConnectionAuthKind,
  protocol: ProviderProtocol,
  modelSelectionMode: ModelSelectionMode,
  credentialMode: CredentialMode,
  endpointMode: EndpointMode,
): ConnectionPreset {
  return Object.freeze({
    id,
    labelKey,
    providerKind,
    routeKind,
    transport,
    authKind,
    protocol,
    modelSelectionMode,
    credentialMode,
    endpointMode,
  });
}

export function getConnectionPreset(id: ConnectionPresetId | string): ConnectionPreset {
  const selected = tryGetConnectionPreset(id);
  if (selected === null) throw new Error(`Unknown connection preset: ${id}`);
  return selected;
}

/** Radix can briefly emit an empty value while its provider-specific options change. */
export function tryGetConnectionPreset(id: string): ConnectionPreset | null {
  if (!id) return null;
  return CONNECTION_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function presetForConnection(connection: ProviderConnection | null | undefined): ConnectionPreset | null {
  if (connection === null || connection === undefined) return null;
  return CONNECTION_PRESETS.find((preset) =>
    preset.providerKind === connection.providerKind &&
    preset.routeKind === connection.routeKind &&
    preset.transport === connection.transport &&
    preset.authKind === connection.authKind &&
    preset.protocol === connection.protocol,
  ) ?? null;
}

export function applyConnectionPreset(
  draft: ConnectionDraft,
  presetId: ConnectionPresetId | string,
  nameSuggestion = "",
): ConnectionDraft {
  const selected = getConnectionPreset(presetId);
  return {
    ...draft,
    name: nameSuggestion || draft.name,
    providerKind: selected.providerKind,
    routeKind: selected.routeKind,
    transport: selected.transport,
    authKind: selected.authKind,
    protocol: selected.protocol,
    modelSelectionMode: selected.modelSelectionMode,
    apiKey: "",
    baseUrl: selected.endpointMode === "mimo-region" ? MIMO_TOKEN_PLAN_REGIONS[0].baseUrl : "",
    discoveryUrl: "",
    headers: "",
  };
}

export function applyMimoTokenPlanRegion(
  draft: ConnectionDraft,
  regionId: MimoTokenPlanRegionId,
): ConnectionDraft {
  const region = MIMO_TOKEN_PLAN_REGIONS.find((candidate) => candidate.id === regionId);
  if (region === undefined) throw new Error(`Unknown MiMo Token Plan region: ${regionId}`);
  return { ...draft, baseUrl: region.baseUrl, discoveryUrl: "" };
}

export function isManagedOAuthPreset(preset: ConnectionPreset): boolean {
  return preset.credentialMode === "managed-oauth";
}

export function connectionPresetNeedsSecret(preset: ConnectionPreset): boolean {
  return preset.credentialMode === "api-key" ||
    preset.credentialMode === "token-plan" ||
    preset.credentialMode === "custom";
}

export function presetShowsEndpointFields(preset: ConnectionPreset): boolean {
  return preset.endpointMode === "custom";
}

/**
 * Secret writes replace the vault bundle. Compatible routes therefore need the
 * endpoint and an authentication value together whenever a bundle is written.
 */
export function customEndpointDraftError(
  draft: ConnectionDraft,
  editing: boolean,
): "custom-endpoint" | "custom-replacement" | null {
  if (draft.routeKind !== "custom-openai-compatible" && draft.routeKind !== "custom-anthropic-compatible") {
    return null;
  }
  const writesSecret = draft.apiKey.trim().length > 0 ||
    draft.baseUrl.trim().length > 0 ||
    draft.discoveryUrl.trim().length > 0 ||
    draft.headers.trim().length > 0;
  if (editing && !writesSecret) return null;

  const complete = draft.baseUrl.trim().length > 0 &&
    (draft.apiKey.trim().length > 0 || draft.headers.trim().length > 0);
  if (complete) return null;
  return editing ? "custom-replacement" : "custom-endpoint";
}

/** Editing a MiMo Token Plan secret must never infer a hidden stored region. */
export function mimoSecretUpdateNeedsRegion(
  draft: ConnectionDraft,
  selectedRegion: MimoTokenPlanRegionId | null,
): boolean {
  return draft.routeKind === "mimo-token-plan" &&
    selectedRegion === null &&
    (draft.apiKey.trim().length > 0 || draft.baseUrl.trim().length > 0);
}

/**
 * Secret writes replace the native-vault bundle. A MiMo update therefore needs
 * both a fresh Token Plan key and an explicit region; silent preservation is
 * impossible because the existing values are deliberately write-only.
 */
export function mimoTokenPlanDraftError(
  draft: ConnectionDraft,
  editing: boolean,
  selectedRegion: MimoTokenPlanRegionId | null,
): "secret" | "mimo-region" | null {
  if (draft.routeKind !== "mimo-token-plan") return null;
  const changesSecret = draft.apiKey.trim().length > 0 || draft.baseUrl.trim().length > 0;
  if (editing && !changesSecret) return null;
  if (selectedRegion === null) return "mimo-region";
  return draft.apiKey.trim().length > 0 ? null : "secret";
}
