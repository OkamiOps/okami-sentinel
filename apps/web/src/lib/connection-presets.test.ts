import assert from "node:assert/strict";
import test from "node:test";

import { blankConnectionDraft, validateConnectionDraft } from "./connections.js";
import {
  CONNECTION_PRESETS,
  MIMO_TOKEN_PLAN_REGIONS,
  applyConnectionPreset,
  applyMimoTokenPlanRegion,
  connectionPresetNeedsSecret,
  getConnectionPreset,
  isManagedOAuthPreset,
  mimoSecretUpdateNeedsRegion,
  mimoTokenPlanDraftError,
} from "./connection-presets.js";

test("maps every supported provider route preset to its registered transport contract", () => {
  assert.equal(CONNECTION_PRESETS.length, 18);

  assert.deepEqual(getConnectionPreset("openai-chatgpt-browser-oauth"), {
    id: "openai-chatgpt-browser-oauth",
    labelKey: "connections.preset.openai-chatgpt-browser-oauth",
    providerKind: "openai",
    routeKind: "openai-chatgpt-app-server",
    transport: "codex-app-server",
    authKind: "browser-oauth",
    protocol: "codex-app-server",
    modelSelectionMode: "catalog",
    credentialMode: "managed-oauth",
    endpointMode: "preset",
  });

  assert.deepEqual(getConnectionPreset("cursor-cloud-api"), {
    id: "cursor-cloud-api",
    labelKey: "connections.preset.cursor-cloud-api",
    providerKind: "cursor",
    routeKind: "cursor-background-agents",
    transport: "remote-agent-api",
    authKind: "api-key",
    protocol: "cursor-background-agents",
    modelSelectionMode: "catalog",
    credentialMode: "api-key",
    endpointMode: "preset",
  });

  assert.equal(getConnectionPreset("openai-local-codex").modelSelectionMode, "catalog");
  assert.equal(getConnectionPreset("xai-grok-local").modelSelectionMode, "catalog");
  assert.equal(getConnectionPreset("cursor-local").modelSelectionMode, "catalog");
  assert.equal(getConnectionPreset("claude-code-local").modelSelectionMode, "runtime-default");
});

test("managed OAuth routes do not prompt for an API key or fail write-only validation", () => {
  const preset = getConnectionPreset("xai-direct-device-oauth");
  const draft = applyConnectionPreset(blankConnectionDraft(), preset.id);
  draft.name = "xAI test";

  assert.equal(isManagedOAuthPreset(preset), true);
  assert.equal(connectionPresetNeedsSecret(preset), false);
  assert.equal(draft.apiKey, "");
  assert.equal(validateConnectionDraft(draft), null);
});

test("Codex app-server browser and device routes also create without a secret bundle", () => {
  for (const presetId of ["openai-chatgpt-browser-oauth", "openai-chatgpt-device-code"] as const) {
    const preset = getConnectionPreset(presetId);
    const draft = applyConnectionPreset(blankConnectionDraft(), preset.id);
    draft.name = "ChatGPT test";

    assert.equal(preset.transport, "codex-app-server");
    assert.equal(connectionPresetNeedsSecret(preset), false);
    assert.equal(validateConnectionDraft(draft), null);
  }
});

test("remote Cursor API remains secret-backed; only managed OAuth bypasses the secret bundle", () => {
  const draft = applyConnectionPreset(blankConnectionDraft(), "cursor-cloud-api");
  draft.name = "Cursor test";

  assert.equal(connectionPresetNeedsSecret(getConnectionPreset("cursor-cloud-api")), true);
  assert.equal(validateConnectionDraft(draft), "secret");
});

test("custom routes expose their endpoint bundle while local routes keep it hidden", () => {
  assert.equal(connectionPresetNeedsSecret(getConnectionPreset("custom-openai-compatible")), true);
  assert.equal(connectionPresetNeedsSecret(getConnectionPreset("openai-local-codex")), false);
});

test("pins MiMo Token Plan configuration to the exact selected region", () => {
  assert.deepEqual(MIMO_TOKEN_PLAN_REGIONS.map((region) => region.baseUrl), [
    "https://token-plan-cn.xiaomimimo.com/v1",
    "https://token-plan-sgp.xiaomimimo.com/v1",
    "https://token-plan-ams.xiaomimimo.com/v1",
  ]);

  const draft = applyMimoTokenPlanRegion(
    applyConnectionPreset(blankConnectionDraft(), "mimo-token-plan"),
    "ams",
  );
  assert.equal(draft.baseUrl, "https://token-plan-ams.xiaomimimo.com/v1");
});

test("requires a visible MiMo region choice before replacing a stored Token Plan secret", () => {
  const draft = applyConnectionPreset(blankConnectionDraft(), "mimo-token-plan");
  draft.baseUrl = "";
  draft.apiKey = "tp-replacement";

  assert.equal(mimoSecretUpdateNeedsRegion(draft, null), true);
  assert.equal(mimoSecretUpdateNeedsRegion(draft, "sgp"), false);
  assert.equal(mimoTokenPlanDraftError(draft, true, null), "mimo-region");
  assert.equal(mimoTokenPlanDraftError(draft, true, "sgp"), null);
});

test("MiMo Token Plan never overwrites a write-only bundle with only a new region", () => {
  const draft = applyConnectionPreset(blankConnectionDraft(), "mimo-token-plan");
  draft.name = "MiMo token plan";
  draft.apiKey = "";

  assert.equal(mimoTokenPlanDraftError(draft, false, "cn"), "secret");
  assert.equal(mimoTokenPlanDraftError({ ...draft, baseUrl: "" }, true, null), null);
  assert.equal(mimoTokenPlanDraftError(draft, true, "cn"), "secret");
});
