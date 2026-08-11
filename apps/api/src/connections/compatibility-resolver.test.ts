import assert from "node:assert/strict";
import test from "node:test";

import type {
  CapabilityReport,
  ModelCapabilities,
  ProviderConnection,
  ProviderModel,
  ProviderProtocol,
} from "@csb/shared";

import { resolveCompatibility } from "./compatibility-resolver.js";
import {
  PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
  PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
  createSafePortableCodexSecurityProviderPlan,
} from "../scanners/portable-codex-security-profile.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");

const PORTABLE_ROUTES = [
  ["openrouter-api", "openai-chat"],
  ["gemini-api", "openai-chat"],
  ["deepseek-api", "openai-chat"],
  ["mimo-token-plan", "openai-chat"],
  ["custom-openai-compatible", "openai-chat"],
  ["anthropic-api", "anthropic-messages"],
  ["minimax-token-plan", "anthropic-messages"],
  ["custom-anthropic-compatible", "anthropic-messages"],
  ["xai-api", "openai-responses"],
  ["xai-oauth", "xai-oauth-responses"],
] as const satisfies ReadonlyArray<readonly [string, ProviderProtocol]>;

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

test("Codex Security resolves the existing OpenAI contracts as Native", () => {
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
    assert.equal(decision.selectedProfile, "native");
    assert.deepEqual(decision.availableProfiles, ["native"]);
    assert.equal(decision.capabilityCheckId, null);
  }
});

test("Codex Security resolves every visible Portable route from a fresh complete probe", () => {
  for (const [routeKind, protocol] of PORTABLE_ROUTES) {
    const decision = resolveCompatibility({
      engine: "codex-security",
      connection: connection(routeKind, { protocol }),
      selection: {
        connectionId: "conn-a",
        modelSelectionMode: "catalog",
        modelId: "model-a",
      },
      model: model(),
      probe: probe(protocol),
      now: NOW,
    });

    assert.equal(decision.eligible, true, `${routeKind}/${protocol}`);
    assert.equal(decision.runnerKind, "agent-session", `${routeKind}/${protocol}`);
    assert.equal(decision.selectedProfile, "portable", `${routeKind}/${protocol}`);
    assert.deepEqual(decision.availableProfiles, ["portable"], `${routeKind}/${protocol}`);
    assert.equal(decision.profileVersion, "sentinel-codex-security-portable-v1");
    assert.equal(decision.methodologyRef, "sentinel/codex-security-methodology@v1");
    assert.equal(decision.capabilityCheckId, "probe-a");
  }
});

test("Codex Security fails closed for unproven Portable routes and never substitutes Portable for Native", () => {
  const invalidProbes: Array<{
    name: string;
    report: (protocol: ProviderProtocol) => CapabilityReport | null;
    reason: string;
  }> = [
    {
      name: "missing",
      report: () => null,
      reason: "capability_probe_missing",
    },
    {
      name: "stale",
      report: (protocol) => probe(protocol, { checkedAt: "2026-08-11T10:00:00.000Z" }),
      reason: "capability_probe_stale",
    },
    {
      name: "failed",
      report: (protocol) => probe(protocol, { status: "failed" }),
      reason: "capability_probe_failed",
    },
    {
      name: "mismatched",
      report: (protocol) => probe(protocol, { modelId: "other-model" }),
      reason: "capability_probe_mismatch",
    },
  ];

  for (const [routeKind, protocol] of PORTABLE_ROUTES) {
    for (const invalid of invalidProbes) {
      const decision = resolveCompatibility({
        engine: "codex-security",
        connection: connection(routeKind, { protocol }),
        selection: {
          connectionId: "conn-a",
          modelSelectionMode: "catalog",
          modelId: "model-a",
        },
        model: model(),
        probe: invalid.report(protocol),
        now: NOW,
      });

      assert.equal(decision.eligible, false, `${routeKind}/${invalid.name}`);
      assert.deepEqual(decision.reasons, [invalid.reason], `${routeKind}/${invalid.name}`);
      assert.equal(decision.selectedProfile, null, `${routeKind}/${invalid.name}`);
    }

    const nativeOnly = resolveCompatibility({
      engine: "codex-security",
      connection: connection(routeKind, { protocol }),
      selection: {
        connectionId: "conn-a",
        modelSelectionMode: "catalog",
        modelId: "model-a",
      },
      model: model(),
      probe: probe(protocol),
      executionProfilePreference: "native",
      now: NOW,
    });

    assert.equal(nativeOnly.eligible, false, `${routeKind}/native`);
    assert.deepEqual(nativeOnly.reasons, ["codex_native_contract_unavailable"]);
  }
});

test("Codex Security does not expose Portable outside its approved tuple matrix", () => {
  for (const candidate of [
    ["openai-api", "openai-responses"],
    ["custom-openai-compatible", "openai-responses"],
  ] as const satisfies ReadonlyArray<readonly [string, ProviderProtocol]>) {
    const [routeKind, protocol] = candidate;
    const decision = resolveCompatibility({
      engine: "codex-security",
      connection: connection(routeKind, { protocol }),
      selection: {
        connectionId: "conn-a",
        modelSelectionMode: "catalog",
        modelId: "model-a",
      },
      model: model(),
      probe: probe(protocol),
      executionProfilePreference: "portable",
      now: NOW,
    });
    assert.equal(decision.eligible, false, `${routeKind}/${protocol}`);
    assert.deepEqual(decision.reasons, ["codex_security_provider_unsupported"]);
  }
});

test("Codex Security rejects a forged profile preference instead of treating it as Auto", () => {
  const decision = resolveCompatibility({
    engine: "codex-security",
    connection: connection("mimo-token-plan", { protocol: "openai-chat" }),
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
    model: model(),
    probe: probe("openai-chat"),
    executionProfilePreference: "browser-forged" as never,
    now: NOW,
  });

  assert.equal(decision.eligible, false);
  assert.deepEqual(decision.reasons, ["invalid_execution_profile_preference"]);
});

test("Portable provider plans copy only a complete, pinned server tuple", () => {
  const source = {
    scanId: "scan-a",
    connectionId: "conn-a",
    routeKind: "mimo-token-plan",
    protocol: "openai-chat" as const,
    modelId: "mimo-v2.5",
    capabilityCheckId: "probe-a",
    profileVersion: PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
    methodologyRef: PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
    browserInjected: "must-not-cross-the-boundary",
  };
  const safe = createSafePortableCodexSecurityProviderPlan(source);

  assert.deepEqual(safe, {
    scanId: "scan-a",
    connectionId: "conn-a",
    routeKind: "mimo-token-plan",
    protocol: "openai-chat",
    modelId: "mimo-v2.5",
    capabilityCheckId: "probe-a",
    profileVersion: PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
    methodologyRef: PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
  });
  assert.notEqual(safe, source);

  for (const candidate of [
    { ...source, scanId: "" },
    { ...source, protocol: "codex-app-server" },
    { ...source, protocol: "anthropic-messages" },
    { ...source, routeKind: "openai-api", protocol: "openai-responses" },
    { ...source, capabilityCheckId: "" },
    { ...source, profileVersion: "browser-forged" },
    { ...source, methodologyRef: "browser-forged" },
  ]) {
    assert.throws(() => createSafePortableCodexSecurityProviderPlan(candidate));
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
