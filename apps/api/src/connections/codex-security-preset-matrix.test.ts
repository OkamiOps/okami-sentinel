import assert from "node:assert/strict";
import test from "node:test";

import {
  VISIBLE_CONNECTION_PRESET_COUNT,
  VISIBLE_CONNECTION_PRESETS,
  type CapabilityReport,
  type ConnectionPreset,
  type ModelCapabilities,
  type ProviderConnection,
  type ProviderModel,
} from "@csb/shared";

import { resolveCompatibility } from "./compatibility-resolver.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");

type ExpectedProfile = "native" | "portable" | "blocked";

/**
 * This is deliberately an exhaustive public-preset contract: adding, removing,
 * or renaming a visible preset requires an explicit Codex Security decision.
 */
const EXPECTED_CODEX_SECURITY_PROFILES: Readonly<Record<string, ExpectedProfile>> = Object.freeze({
  "openai-local-codex": "native",
  "openai-chatgpt-browser-oauth": "native",
  "openai-chatgpt-device-code": "native",
  "openai-api": "native",
  "xai-grok-local": "blocked",
  "xai-direct-device-oauth": "portable",
  "xai-api": "portable",
  "claude-code-local": "blocked",
  "anthropic-api": "portable",
  "cursor-local": "blocked",
  "cursor-cloud-api": "blocked",
  "openrouter-api": "portable",
  "gemini-api": "portable",
  "deepseek-api": "portable",
  "minimax-token-plan": "portable",
  "mimo-token-plan": "portable",
  "custom-openai-compatible": "portable",
  "custom-anthropic-compatible": "portable",
});

test("Codex Security classifies every visible preset through the closed Native, Portable, or blocked matrix", () => {
  assert.equal(VISIBLE_CONNECTION_PRESET_COUNT, 18);
  assert.deepEqual(
    VISIBLE_CONNECTION_PRESETS.map((preset) => preset.id),
    Object.keys(EXPECTED_CODEX_SECURITY_PROFILES),
    "the contract must be updated whenever the visible catalog changes",
  );

  const actualProfiles = Object.fromEntries(
    VISIBLE_CONNECTION_PRESETS.map((preset) => [preset.id, resolvePreset(preset)]),
  );
  assert.deepEqual(actualProfiles, EXPECTED_CODEX_SECURITY_PROFILES);
});

test("Portable Codex Security fails closed when the persisted capability proof is missing, stale, failed, or mismatched", () => {
  for (const preset of portablePresets()) {
    for (const scenario of ["missing", "stale", "failed", "mismatched"] as const) {
      const decision = resolvePresetDecision(preset, scenario);
      assert.equal(decision.eligible, false, `${preset.id}/${scenario} must not fall back`);
      assert.deepEqual(decision.reasons, [
        scenario === "mismatched" ? "capability_probe_mismatch" : `capability_probe_${scenario}`,
      ]);
      assert.equal(decision.selectedProfile, null);
      assert.deepEqual(decision.availableProfiles, []);
    }
  }
});

function resolvePreset(
  preset: ConnectionPreset,
  probeScenario: "complete" | "missing" | "stale" | "failed" | "mismatched" = "complete",
): ExpectedProfile {
  const decision = resolvePresetDecision(preset, probeScenario);

  if (!decision.eligible) {
    assert.equal(decision.selectedProfile, null, `${preset.id} must not select a hidden fallback`);
    assert.deepEqual(decision.availableProfiles, [], `${preset.id} must not advertise an unavailable profile`);
    return "blocked";
  }
  assert.equal(decision.runnerKind, decision.selectedProfile === "native"
    ? "codex-security-contract"
    : "agent-session");
  if (decision.selectedProfile === "native" || decision.selectedProfile === "portable") {
    return decision.selectedProfile;
  }
  assert.fail(`${preset.id} was eligible without an execution profile`);
}

function resolvePresetDecision(
  preset: ConnectionPreset,
  probeScenario: "complete" | "missing" | "stale" | "failed" | "mismatched" = "complete",
) {
  const selectedModelId = preset.modelSelectionMode === "catalog"
    ? `${preset.id}-model`
    : null;
  const connection = presetConnection(preset);
  const model = selectedModelId === null ? null : providerModel(connection.id, selectedModelId);
  const probe = capabilityProbe(connection, selectedModelId, probeScenario);
  return resolveCompatibility({
    engine: "codex-security",
    connection,
    selection: {
      connectionId: connection.id,
      modelSelectionMode: preset.modelSelectionMode,
      modelId: selectedModelId,
    },
    model,
    probe,
    now: NOW,
  });
}

function portablePresets(): readonly ConnectionPreset[] {
  return VISIBLE_CONNECTION_PRESETS.filter(
    (preset) => EXPECTED_CODEX_SECURITY_PROFILES[preset.id] === "portable",
  );
}

function presetConnection(preset: ConnectionPreset): ProviderConnection {
  return {
    id: `connection-${preset.id}`,
    scopeId: "local",
    name: preset.id,
    providerKind: preset.providerKind,
    routeKind: preset.routeKind,
    transport: preset.transport,
    authKind: preset.authKind,
    protocol: preset.protocol,
    status: "ready",
    modelSelectionMode: preset.modelSelectionMode,
    defaultModelId: null,
    lastTestedAt: NOW.toISOString(),
    lastModelSyncAt: NOW.toISOString(),
    modelCatalogStale: false,
    display: {
      providerLabel: preset.providerKind,
      routeLabel: preset.routeKind,
      secretConfigured: true,
      endpointConfigured: false,
      endpointKind: "preset",
    },
  };
}

function providerModel(connectionId: string, id: string): ProviderModel {
  return {
    connectionId,
    id,
    displayName: id,
    contextWindow: null,
    capabilities: supportedCapabilities(),
    pricing: null,
    discoveredAt: NOW.toISOString(),
    source: "provider-api",
  };
}

function capabilityProbe(
  connection: ProviderConnection,
  modelId: string | null,
  scenario: "complete" | "missing" | "stale" | "failed" | "mismatched",
): CapabilityReport | null {
  if (scenario === "missing") return null;
  return {
    id: `probe-${connection.routeKind}`,
    connectionId: scenario === "mismatched" ? "other-connection" : connection.id,
    modelId,
    protocol: connection.protocol,
    status: scenario === "failed" ? "failed" : "passed",
    capabilities: supportedCapabilities(),
    errorCode: null,
    checkedAt: scenario === "stale"
      ? "2026-08-11T10:00:00.000Z"
      : "2026-08-11T11:55:00.000Z",
  };
}

function supportedCapabilities(): ModelCapabilities {
  return {
    tools: "supported",
    artifactOutput: "supported",
    structuredOutput: "supported",
    boundedExecution: "supported",
    osIsolation: "supported",
    streaming: "supported",
    usage: "supported",
    cancellation: "supported",
  };
}
