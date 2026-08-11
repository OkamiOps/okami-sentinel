import assert from "node:assert/strict";
import test from "node:test";

import type {
  CapabilityReport,
  ModelCapabilities,
  ProviderModel,
} from "@csb/shared";

import type { StoredProviderConnection } from "../connections-store.js";
import { CURRENT_AGENT_SESSION_CONTRACT_VERSION } from "../agent/session-types.js";
import {
  effectiveReasoningEffort,
} from "./compatibility-resolver.js";
import { createScanCompatibilityResolver } from "./scan-compatibility.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function capabilities(): ModelCapabilities {
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

function connection(patch: Partial<StoredProviderConnection> = {}): StoredProviderConnection {
  return {
    id: "connection-a",
    scopeId: "local",
    name: "OpenRouter",
    providerKind: "openrouter",
    routeKind: "openrouter-api",
    transport: "http-inference",
    authKind: "api-key",
    protocol: "openai-chat",
    status: "ready",
    modelSelectionMode: "catalog",
    defaultModelId: null,
    lastTestedAt: NOW.toISOString(),
    lastModelSyncAt: NOW.toISOString(),
    modelCatalogStale: false,
    display: {
      providerLabel: "OpenRouter",
      routeLabel: "API",
      secretConfigured: true,
      endpointConfigured: true,
      endpointKind: "preset",
    },
    credentialRef: "connection/connection-a",
    ...patch,
  };
}

function model(patch: Partial<ProviderModel> = {}): ProviderModel {
  return {
    connectionId: "connection-a",
    id: "provider/model-a",
    displayName: "Model A",
    contextWindow: 100_000,
    capabilities: capabilities(),
    pricing: null,
    discoveredAt: NOW.toISOString(),
    source: "provider-api",
    ...patch,
  };
}

function probe(patch: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    id: "probe-a",
    connectionId: "connection-a",
    modelId: "provider/model-a",
    protocol: "openai-chat",
    agentContractVersion: CURRENT_AGENT_SESSION_CONTRACT_VERSION,
    status: "passed",
    capabilities: capabilities(),
    errorCode: null,
    checkedAt: "2026-08-11T11:55:00.000Z",
    ...patch,
  };
}

test("resolves one executable scanner decision from persisted model and probe facts", () => {
  const resolver = createScanCompatibilityResolver({
    getConnection: () => connection(),
    getModel: () => model(),
    getLatestCapabilityCheck: () => probe(),
    now: () => NOW,
  });

  const result = resolver.resolve({
    engine: "mantis",
    selection: {
      connectionId: "connection-a",
      modelSelectionMode: "catalog",
      modelId: "provider/model-a",
    },
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
});

test("publishes every catalog effort only for an eligible wired runner", () => {
  const reasoningEffort = {
    options: ["low", "medium", "high", "xhigh", "max", "ultra"],
    default: "low",
  };
  const cases = [
    {
      label: "HTTP AgentSession",
      engine: "mantis" as const,
      stored: connection(),
    },
    {
      label: "Codex app-server",
      engine: "mantis" as const,
      stored: connection({
        providerKind: "openai",
        routeKind: "openai-chatgpt-app-server",
        transport: "codex-app-server",
        authKind: "device-code",
        protocol: "codex-app-server",
        credentialRef: null,
      }),
    },
    {
      label: "Codex Security contract",
      engine: "codex-security" as const,
      stored: connection({
        providerKind: "openai",
        routeKind: "openai-api",
        transport: "http-inference",
        authKind: "api-key",
        protocol: "openai-responses",
      }),
    },
  ];

  for (const candidate of cases) {
    const result = createScanCompatibilityResolver({
      getConnection: () => candidate.stored,
      getModel: () => model({ reasoningEffort }),
      getLatestCapabilityCheck: () => probe({ protocol: candidate.stored.protocol }),
      now: () => NOW,
    }).resolve({
      engine: candidate.engine,
      selection: {
        connectionId: "connection-a",
        modelSelectionMode: "catalog",
        modelId: "provider/model-a",
      },
    });

    assert.equal(result.eligible, true, candidate.label);
    assert.deepEqual(result.reasoningEffort, reasoningEffort, candidate.label);
    assert.notEqual(result.reasoningEffort, reasoningEffort, candidate.label);
  }
});

test("omits model effort for blocked and runner kinds without an effort codec", () => {
  const publishedModel = model({
    reasoningEffort: { options: ["low", "max", "ultra"], default: "low" },
  });

  for (const decision of [
    { eligible: false, runnerKind: "agent-session" as const },
    { eligible: true, runnerKind: "local-agent-session" as const },
    { eligible: true, runnerKind: "remote-agent-job" as const },
  ]) {
    assert.equal(effectiveReasoningEffort(publishedModel, connection(), decision), undefined);
  }
});

test("keeps routes without a proven effort-level codec provider-managed", () => {
  for (const candidate of [
    { providerKind: "xiaomi", routeKind: "mimo-token-plan", protocol: "openai-chat" as const },
    { providerKind: "minimax", routeKind: "minimax-token-plan", protocol: "anthropic-messages" as const },
    { providerKind: "deepseek", routeKind: "deepseek-api", protocol: "openai-chat" as const },
    { providerKind: "custom", routeKind: "custom-openai-compatible", protocol: "openai-chat" as const },
    { providerKind: "custom", routeKind: "custom-anthropic-compatible", protocol: "anthropic-messages" as const },
  ]) {
    const resolver = createScanCompatibilityResolver({
      getConnection: () => connection(candidate),
      getModel: () => model({
        reasoningEffort: { options: ["low", "high", "max"], default: "high" },
      }),
      getLatestCapabilityCheck: () => probe({ protocol: candidate.protocol }),
      now: () => NOW,
    });

    const result = resolver.resolve({
      engine: "mantis",
      selection: {
        connectionId: "connection-a",
        modelSelectionMode: "catalog",
        modelId: "provider/model-a",
      },
    });

    assert.equal(result.eligible, true, candidate.routeKind);
    assert.equal(result.reasoningEffort, undefined, candidate.routeKind);
  }
});

test("advertises MiMo Token Plan only through its pinned OpenAI chat tuple", () => {
  const resolver = createScanCompatibilityResolver({
    getConnection: () => connection({
      providerKind: "xiaomi",
      routeKind: "mimo-token-plan",
      protocol: "openai-chat",
    }),
    getModel: () => model(),
    getLatestCapabilityCheck: () => probe(),
    now: () => NOW,
  });

  const result = resolver.resolve({
    engine: "mantis",
    selection: {
      connectionId: "connection-a",
      modelSelectionMode: "catalog",
      modelId: "provider/model-a",
    },
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
});

test("advertises every scanner for a centrally supported HTTP AgentSession route after a fresh full probe", () => {
  for (const engine of ["mantis", "vulnhunter", "codex-security"] as const) {
    const resolver = createScanCompatibilityResolver({
      getConnection: () => connection({
        providerKind: "openai",
        routeKind: "openai-api",
        protocol: "openai-chat",
      }),
      getModel: () => model(),
      getLatestCapabilityCheck: () => probe(),
      now: () => NOW,
    });

    const result = resolver.resolve({
      engine,
      selection: {
        connectionId: "connection-a",
        modelSelectionMode: "catalog",
        modelId: "provider/model-a",
      },
      ...(engine === "codex-security"
        ? { executionProfilePreference: "portable" as const }
        : {}),
    });

    assert.equal(result.eligible, true, engine);
    assert.deepEqual(result.reasons, [], engine);
    if (engine === "codex-security") {
      assert.equal(result.selectedProfile, "portable");
    }
  }
});

test("keeps protocol mismatches and unknown HTTP routes blocked before launch", () => {
  for (const patch of [
    { routeKind: "openai-api", protocol: "anthropic-messages" as const },
    { routeKind: "unregistered-http-route", protocol: "openai-chat" as const },
  ]) {
    const result = createScanCompatibilityResolver({
      getConnection: () => connection(patch),
      getModel: () => model(),
      getLatestCapabilityCheck: () => ({ ...probe(), protocol: patch.protocol }),
      now: () => NOW,
    }).resolve({
      engine: "mantis",
      selection: {
        connectionId: "connection-a",
        modelSelectionMode: "catalog",
        modelId: "provider/model-a",
      },
    });

    assert.equal(result.eligible, false, `${patch.routeKind}/${patch.protocol}`);
    assert.deepEqual(result.reasons, ["provider_runner_unavailable"]);
  }
});

test("fails closed for unknown connections and runner kinds that are not wired", () => {
  const missing = createScanCompatibilityResolver({
    getConnection: () => null,
    getModel: () => null,
    getLatestCapabilityCheck: () => null,
    now: () => NOW,
  }).resolve({
    engine: "vulnhunter",
    selection: {
      connectionId: "missing",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
  });
  assert.deepEqual(missing.reasons, ["connection_not_found"]);

  const remote = createScanCompatibilityResolver({
    getConnection: () => connection({
      providerKind: "cursor",
      routeKind: "cursor-background-agents",
      transport: "remote-agent-api",
      authKind: "api-key",
      protocol: "cursor-background-agents",
    }),
    getModel: () => model(),
    getLatestCapabilityCheck: () => null,
    now: () => NOW,
  }).resolve({
    engine: "mantis",
    selection: {
      connectionId: "connection-a",
      modelSelectionMode: "catalog",
      modelId: "provider/model-a",
    },
    remoteRepositoryConfirmed: true,
  });
  assert.equal(remote.eligible, false);
  assert.deepEqual(remote.reasons, ["provider_runner_unavailable"]);
});

test("advertises Mantis for the fully pinned xAI OAuth tuple", () => {
  const resolver = createScanCompatibilityResolver({
    getConnection: () => connection({
      providerKind: "xai",
      routeKind: "xai-oauth",
      transport: "http-inference",
      authKind: "device-code",
      protocol: "xai-oauth-responses",
      credentialRef: null,
    }),
    getModel: () => ({ ...model(), capabilities: capabilities() }),
    getLatestCapabilityCheck: () => ({
      ...probe(),
      protocol: "xai-oauth-responses",
    }),
    now: () => NOW,
  });

  const result = resolver.resolve({
    engine: "mantis",
    selection: {
      connectionId: "connection-a",
      modelSelectionMode: "catalog",
      modelId: "provider/model-a",
    },
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
});

test("advertises Mantis local execution only for the exact Claude Code session tuple", () => {
  const selection = {
    connectionId: "connection-a",
    modelSelectionMode: "runtime-default" as const,
    modelId: null,
  };
  const claude = connection({
    providerKind: "anthropic",
    routeKind: "claude-code-local",
    transport: "local-cli",
    authKind: "existing-session",
    protocol: "claude-code-cli",
    modelSelectionMode: "runtime-default",
    credentialRef: null,
  });
  const resolver = createScanCompatibilityResolver({
    getConnection: () => claude,
    getModel: () => {
      throw new Error("runtime default must not load a catalog model");
    },
    getLatestCapabilityCheck: () => {
      throw new Error("runtime default must not load a model probe");
    },
    now: () => NOW,
  });
  assert.deepEqual(resolver.resolve({ engine: "mantis", selection }), {
    ...selection,
    eligible: true,
    reasons: [],
  });

  for (const [label, patch] of [
    ["provider", { providerKind: "openai" }],
    ["transport", { transport: "http-inference" }],
    ["auth", { authKind: "api-key" }],
    ["protocol", { protocol: "openai-responses" }],
    ["credential", { credentialRef: "connection/claude-local" }],
    ["model-selection", { modelSelectionMode: "catalog" }],
  ] as const) {
    const decision = createScanCompatibilityResolver({
      getConnection: () => ({ ...claude, ...patch }),
      getModel: () => null,
      getLatestCapabilityCheck: () => null,
      now: () => NOW,
    }).resolve({ engine: "mantis", selection });
    assert.equal(decision.eligible, false, label);
    assert.notDeepEqual(decision.reasons, [], label);
  }

  const catalogAgainstRuntimeDefault = createScanCompatibilityResolver({
    getConnection: () => claude,
    getModel: () => model(),
    getLatestCapabilityCheck: () => probe(),
    now: () => NOW,
  }).resolve({
    engine: "mantis",
    selection: {
      connectionId: "connection-a",
      modelSelectionMode: "catalog",
      modelId: "provider/model-a",
    },
  });
  assert.equal(catalogAgainstRuntimeDefault.eligible, false);

  for (const blockedConnection of [
    connection({
      providerKind: "xai",
      routeKind: "xai-grok-build-local",
      transport: "local-cli",
      authKind: "existing-session",
      protocol: "grok-build-cli",
      modelSelectionMode: "catalog",
    }),
    connection({
      providerKind: "cursor",
      routeKind: "cursor-agent-local",
      transport: "local-cli",
      authKind: "existing-session",
      protocol: "cursor-agent-cli",
      modelSelectionMode: "catalog",
    }),
  ]) {
    const decision = createScanCompatibilityResolver({
      getConnection: () => blockedConnection,
      getModel: () => model(),
      getLatestCapabilityCheck: () => probe(),
      now: () => NOW,
    }).resolve({
      engine: "mantis",
      selection: {
        connectionId: "connection-a",
        modelSelectionMode: "catalog",
        modelId: "provider/model-a",
      },
    });
    assert.equal(decision.eligible, false, blockedConnection.routeKind);
    assert.deepEqual(decision.reasons, ["runner_capability_missing"]);
  }
});

test("advertises Codex Security OpenAI API only after the exact child-env bridge is wired", () => {
  const resolver = createScanCompatibilityResolver({
    getConnection: () => connection({
      providerKind: "openai",
      routeKind: "openai-api",
      transport: "http-inference",
      authKind: "api-key",
      protocol: "openai-responses",
    }),
    getModel: () => model(),
    getLatestCapabilityCheck: () => null,
    now: () => NOW,
  });

  const result = resolver.resolve({
    engine: "codex-security",
    selection: {
      connectionId: "connection-a",
      modelSelectionMode: "catalog",
      modelId: "provider/model-a",
    },
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
});

test("advertises resolved Portable Codex Security only through its dedicated worker contract", () => {
  const resolver = createScanCompatibilityResolver({
    getConnection: () => connection({
      providerKind: "xiaomi",
      routeKind: "mimo-token-plan",
      transport: "http-inference",
      authKind: "api-key",
      protocol: "openai-chat",
    }),
    getModel: () => ({
      ...model(),
      id: "mimo-v2.5",
      displayName: "MiMo V2.5",
    }),
    getLatestCapabilityCheck: () => ({
      ...probe(),
      modelId: "mimo-v2.5",
    }),
    now: () => NOW,
  });

  const auto = resolver.resolve({
    engine: "codex-security",
    selection: {
      connectionId: "connection-a",
      modelSelectionMode: "catalog",
      modelId: "mimo-v2.5",
    },
  });

  assert.equal(auto.eligible, true);
  assert.equal(auto.selectedProfile, "portable");
  assert.equal(auto.profileVersion, "sentinel-codex-security-portable-v1");

  const portable = resolver.resolve({
    engine: "codex-security",
    selection: {
      connectionId: "connection-a",
      modelSelectionMode: "catalog",
      modelId: "mimo-v2.5",
    },
    executionProfilePreference: "portable",
  });
  assert.equal(portable.eligible, true);
  assert.deepEqual(portable.reasons, []);
  assert.equal(portable.selectedProfile, "portable");
  assert.equal(portable.methodologyRef, "sentinel/codex-security-methodology@v1");

  const native = resolver.resolve({
    engine: "codex-security",
    selection: {
      connectionId: "connection-a",
      modelSelectionMode: "catalog",
      modelId: "mimo-v2.5",
    },
    executionProfilePreference: "native",
  });
  assert.equal(native.eligible, false);
  assert.deepEqual(native.reasons, ["codex_native_contract_unavailable"]);
});
