import assert from "node:assert/strict";
import test from "node:test";

import type {
  CapabilityReport,
  ModelCapabilities,
  ProviderModel,
} from "@csb/shared";

import type { StoredProviderConnection } from "../connections-store.js";
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

function model(): ProviderModel {
  return {
    connectionId: "connection-a",
    id: "provider/model-a",
    displayName: "Model A",
    contextWindow: 100_000,
    capabilities: capabilities(),
    pricing: null,
    discoveredAt: NOW.toISOString(),
    source: "provider-api",
  };
}

function probe(): CapabilityReport {
  return {
    id: "probe-a",
    connectionId: "connection-a",
    modelId: "provider/model-a",
    protocol: "openai-chat",
    status: "passed",
    capabilities: capabilities(),
    errorCode: null,
    checkedAt: "2026-08-11T11:55:00.000Z",
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
