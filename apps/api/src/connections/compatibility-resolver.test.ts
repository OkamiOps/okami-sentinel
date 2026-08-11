import assert from "node:assert/strict";
import test from "node:test";

import type {
  CapabilityReport,
  ModelCapabilities,
  ProviderConnection,
  ProviderModel,
  ProviderProtocol,
} from "@csb/shared";
import { VISIBLE_CONNECTION_PRESETS } from "@csb/shared";

import { resolveCompatibility } from "./compatibility-resolver.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function capabilities(
  patch: Partial<ModelCapabilities> = {},
): ModelCapabilities {
  return {
    tools: "unknown",
    artifactOutput: "unknown",
    structuredOutput: "unknown",
    boundedExecution: "unknown",
    osIsolation: "unknown",
    streaming: "unknown",
    usage: "unknown",
    cancellation: "unknown",
    ...patch,
  };
}

function connection(
  routeKind: string,
  patch: Partial<ProviderConnection & { credentialRef: string | null }> = {},
): ProviderConnection & { credentialRef: string | null } {
  return {
    id: "conn-a",
    scopeId: "local",
    name: routeKind,
    providerKind: "test",
    routeKind,
    transport: "http-inference",
    authKind: "api-key",
    protocol: "openai-chat",
    status: "ready",
    modelSelectionMode: "catalog",
    defaultModelId: null,
    lastTestedAt: NOW.toISOString(),
    lastModelSyncAt: NOW.toISOString(),
    modelCatalogStale: false,
    credentialRef: null,
    display: {
      providerLabel: "Test",
      routeLabel: routeKind,
      secretConfigured: true,
      endpointConfigured: false,
      endpointKind: "preset",
    },
    ...patch,
  };
}

function model(
  id = "model-a",
  patch: Partial<ProviderModel> = {},
): ProviderModel {
  return {
    connectionId: "conn-a",
    id,
    displayName: id,
    contextWindow: null,
    capabilities: capabilities(),
    pricing: null,
    discoveredAt: NOW.toISOString(),
    source: "provider-api",
    ...patch,
  };
}

function probe(
  protocol: ProviderProtocol = "openai-chat",
  patch: Partial<CapabilityReport> = {},
): CapabilityReport {
  return {
    id: "probe-a",
    connectionId: "conn-a",
    modelId: "model-a",
    protocol,
    status: "passed",
    capabilities: capabilities({
      tools: "supported",
      artifactOutput: "supported",
      structuredOutput: "supported",
      boundedExecution: "supported",
      osIsolation: "supported",
      cancellation: "supported",
    }),
    errorCode: null,
    checkedAt: "2026-08-11T11:55:00.000Z",
    ...patch,
  };
}

test("Mantis blocks an HTTP model until every agent capability is proven", () => {
  const decision = resolveCompatibility({
    engine: "mantis",
    connection: connection("gemini-api"),
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
    model: model(),
    probe: probe("openai-chat", {
      capabilities: capabilities({
        tools: "unknown",
        artifactOutput: "unknown",
        structuredOutput: "unknown",
        boundedExecution: "supported",
        cancellation: "supported",
        osIsolation: "supported",
      }),
    }),
    now: NOW,
  });

  assert.deepEqual(decision.reasons, [
    "agent_tools_unproven",
    "artifact_output_missing",
    "structured_result_unproven",
  ]);
  assert.equal(decision.eligible, false);
  assert.equal(decision.runnerKind, null);
});

test("a complete fresh Gemini probe selects the bounded agent session", () => {
  const decision = resolveCompatibility({
    engine: "mantis",
    connection: connection("gemini-api"),
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
    model: model(),
    probe: probe(),
    now: NOW,
  });

  assert.deepEqual(decision, {
    connectionId: "conn-a",
    modelSelectionMode: "catalog",
    modelId: "model-a",
    eligible: true,
    reasons: [],
    runnerKind: "agent-session",
    protocol: "openai-chat",
    capabilityCheckId: "probe-a",
  });
});

test("a probe for another model or protocol is never trusted", () => {
  const decision = resolveCompatibility({
    engine: "vulnhunter",
    connection: connection("openai-api", { protocol: "openai-responses" }),
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
    model: model(),
    probe: probe("openai-chat", { modelId: "model-b" }),
    snapshotReadOnly: true,
    staticAnalysisProfile: true,
    now: NOW,
  });

  assert.deepEqual(decision.reasons, ["capability_probe_mismatch"]);
  assert.equal(decision.eligible, false);
});

test("an expired probe is blocked even when its capability flags are supported", () => {
  const decision = resolveCompatibility({
    engine: "mantis",
    connection: connection("deepseek-api"),
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
    model: model(),
    probe: probe("openai-chat", { checkedAt: "2026-08-10T11:59:59.000Z" }),
    now: NOW,
    maxProbeAgeMs: 60 * 60 * 1000,
  });

  assert.deepEqual(decision.reasons, ["capability_probe_stale"]);
  assert.equal(decision.eligible, false);
});

test("VulnHunter additionally requires a read-only snapshot and static profile", () => {
  const decision = resolveCompatibility({
    engine: "vulnhunter",
    connection: connection("anthropic-api", {
      providerKind: "anthropic",
      protocol: "anthropic-messages",
    }),
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
    model: model(),
    probe: probe("anthropic-messages"),
    snapshotReadOnly: false,
    staticAnalysisProfile: false,
    now: NOW,
  });

  assert.deepEqual(decision.reasons, [
    "snapshot_read_only_required",
    "static_analysis_profile_required",
  ]);
  assert.equal(decision.eligible, false);
});

test("Codex Security accepts verified OpenAI contracts and blocks unproven MiMo agent messages", () => {
  for (const candidate of [
    connection("openai-codex-local", {
      providerKind: "openai",
      transport: "codex-app-server",
      authKind: "existing-session",
      protocol: "codex-app-server",
    }),
    connection("openai-chatgpt-app-server", {
      providerKind: "openai",
      transport: "codex-app-server",
      authKind: "device-code",
      protocol: "codex-app-server",
    }),
    connection("openai-api", {
      providerKind: "openai",
      protocol: "openai-responses",
    }),
  ]) {
    const decision = resolveCompatibility({
      engine: "codex-security",
      connection: candidate,
      selection: {
        connectionId: "conn-a",
        modelSelectionMode: "catalog",
        modelId: "model-a",
      },
      model: model(),
      now: NOW,
    });
    assert.equal(decision.eligible, true, candidate.routeKind);
    assert.equal(decision.runnerKind, "codex-security-contract");
  }

  const mimoConnection = connection("mimo-token-plan", {
    providerKind: "xiaomi",
    transport: "http-inference",
    authKind: "api-key",
    protocol: "openai-chat",
    credentialRef: "connection/conn-a",
  });
  const mimo = resolveCompatibility({
    engine: "codex-security",
    connection: mimoConnection,
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "mimo-v2.5",
    },
    model: model("mimo-v2.5"),
    now: NOW,
  });
  assert.equal(mimo.eligible, false);
  assert.deepEqual(mimo.reasons, ["codex_security_gateway_feature_unproven"]);

  const mimoSpeech = resolveCompatibility({
    engine: "codex-security",
    connection: mimoConnection,
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "mimo-v2.5-asr",
    },
    model: model("mimo-v2.5-asr"),
    now: NOW,
  });
  assert.deepEqual(mimoSpeech.reasons, ["codex_security_gateway_feature_unproven"]);

  const xai = resolveCompatibility({
    engine: "codex-security",
    connection: connection("xai-oauth", {
      providerKind: "xai",
      protocol: "xai-oauth-responses",
      authKind: "device-code",
    }),
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
    model: model(),
    now: NOW,
  });
  assert.deepEqual(xai.reasons, ["codex_security_provider_unsupported"]);

  const malformedMimo = resolveCompatibility({
    engine: "codex-security",
    connection: connection("mimo-token-plan", {
      providerKind: "xiaomi",
      protocol: "anthropic-messages",
      authKind: "api-key",
    }),
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
    model: model(),
    now: NOW,
  });
  assert.deepEqual(malformedMimo.reasons, ["codex_security_provider_unsupported"]);
});

test("Codex Security rejects every visible non-OpenAI route and malformed OpenAI auth", () => {
  for (const preset of VISIBLE_CONNECTION_PRESETS.filter(
    (candidate) => candidate.providerKind !== "openai",
  )) {
    const decision = resolveCompatibility({
      engine: "codex-security",
      connection: connection(preset.routeKind, {
        providerKind: preset.providerKind,
        transport: preset.transport,
        authKind: preset.authKind,
        protocol: preset.protocol,
      }),
      selection: {
        connectionId: "conn-a",
        modelSelectionMode: "catalog",
        modelId: "model-a",
      },
      model: model(),
      now: NOW,
    });

    assert.equal(decision.eligible, false, preset.id);
  }

  for (const candidate of [
    connection("openai-codex-local", {
      providerKind: "openai",
      transport: "codex-app-server",
      authKind: "api-key",
      protocol: "codex-app-server",
    }),
    connection("openai-chatgpt-app-server", {
      providerKind: "openai",
      transport: "codex-app-server",
      authKind: "existing-session",
      protocol: "codex-app-server",
    }),
  ]) {
    const decision = resolveCompatibility({
      engine: "codex-security",
      connection: candidate,
      selection: {
        connectionId: "conn-a",
        modelSelectionMode: "catalog",
        modelId: "model-a",
      },
      model: model(),
      now: NOW,
    });

    assert.equal(decision.eligible, false, `${candidate.routeKind}/${candidate.authKind}`);
  }
});

test("a model owned by another connection is blocked before runner selection", () => {
  const decision = resolveCompatibility({
    engine: "mantis",
    connection: connection("openrouter-api"),
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
    model: model("model-a", { connectionId: "conn-b" }),
    probe: probe(),
    now: NOW,
  });

  assert.deepEqual(decision.reasons, ["model_not_found"]);
  assert.equal(decision.eligible, false);
});

test("Codex app-server stays eligible for local Mantis without an HTTP probe", () => {
  const decision = resolveCompatibility({
    engine: "mantis",
    connection: connection("openai-chatgpt-app-server", {
      providerKind: "openai",
      transport: "codex-app-server",
      authKind: "device-code",
      protocol: "codex-app-server",
    }),
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
    model: model(),
    now: NOW,
  });

  assert.equal(decision.eligible, true);
  assert.equal(decision.runnerKind, "codex-app-server");
  assert.equal(decision.capabilityCheckId, null);
});

test("Mantis accepts only the exact Claude Code local existing-session contract", () => {
  const claude = connection("claude-code-local", {
    providerKind: "anthropic",
    transport: "local-cli",
    authKind: "existing-session",
    protocol: "claude-code-cli",
    modelSelectionMode: "runtime-default",
  });
  const runtimeDefault = resolveCompatibility({
    engine: "mantis",
    connection: claude,
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "runtime-default",
      modelId: null,
    },
    model: null,
    probe: null,
    now: NOW,
  });

  assert.deepEqual(runtimeDefault, {
    connectionId: "conn-a",
    modelSelectionMode: "runtime-default",
    modelId: null,
    eligible: true,
    reasons: [],
    runnerKind: "local-agent-session",
    protocol: "claude-code-cli",
    capabilityCheckId: null,
  });

  const catalog = resolveCompatibility({
    engine: "mantis",
    connection: { ...claude, modelSelectionMode: "catalog", modelCatalogStale: false },
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "claude-visible",
    },
    model: model("claude-visible", { source: "runtime" }),
    probe: null,
    now: NOW,
  });
  assert.equal(catalog.eligible, true);
  assert.equal(catalog.runnerKind, "local-agent-session");

  const mismatches: ProviderConnection[] = [
    { ...claude, providerKind: "xai" },
    { ...claude, routeKind: "xai-grok-build-local", protocol: "grok-build-cli" },
    { ...claude, routeKind: "cursor-agent-local", protocol: "cursor-agent-cli" },
    { ...claude, authKind: "browser-oauth" as const },
    { ...claude, transport: "http-inference" as const },
  ];
  for (const candidate of mismatches) {
    const decision = resolveCompatibility({
      engine: "mantis",
      connection: candidate,
      selection: {
        connectionId: "conn-a",
        modelSelectionMode: "runtime-default",
        modelId: null,
      },
      model: null,
      probe: null,
      now: NOW,
    });
    assert.equal(decision.eligible, false, `${candidate.routeKind}/${candidate.providerKind}`);
    assert.notDeepEqual(decision.reasons, [], `${candidate.routeKind}/${candidate.providerKind}`);
  }
});

test("a remote Cursor job never silently substitutes a local snapshot", () => {
  const decision = resolveCompatibility({
    engine: "mantis",
    connection: connection("cursor-background-agents", {
      providerKind: "cursor",
      transport: "remote-agent-api",
      protocol: "cursor-background-agents",
    }),
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
    model: model(),
    remoteRepositoryConfirmed: false,
    now: NOW,
  });

  assert.deepEqual(decision.reasons, ["remote_repository_confirmation_required"]);
  assert.equal(decision.eligible, false);
});
