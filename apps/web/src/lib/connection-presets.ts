import {
  VISIBLE_CONNECTION_PRESETS,
  type ConnectionPreset,
  type ProviderConnection,
} from "@csb/shared";

import type { ConnectionDraft } from "./connections.js";

export type MimoTokenPlanRegionId = "cn" | "sgp" | "ams";

export type { ConnectionPreset, ConnectionPresetLabelKey } from "@csb/shared";

export const MIMO_TOKEN_PLAN_REGIONS = Object.freeze([
  { id: "cn" as const, baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" },
  { id: "sgp" as const, baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
  { id: "ams" as const, baseUrl: "https://token-plan-ams.xiaomimimo.com/v1" },
]);

export const CONNECTION_PRESETS = VISIBLE_CONNECTION_PRESETS;

export type ConnectionPresetId = (typeof CONNECTION_PRESETS)[number]["id"];

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
