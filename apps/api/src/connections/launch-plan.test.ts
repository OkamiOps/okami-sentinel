import assert from "node:assert/strict";
import test from "node:test";

import type {
  CapabilityReport,
  ModelCapabilities,
  ProviderModel,
  ScanConnectionSnapshot,
} from "@csb/shared";

import type { StoredProviderConnection } from "../connections-store.js";
import {
  LaunchPlanError,
  createLaunchPlanResolver,
} from "./launch-plan.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");

const supportedCapabilities: ModelCapabilities = {
  tools: "supported",
  artifactOutput: "supported",
  structuredOutput: "supported",
  boundedExecution: "supported",
  osIsolation: "supported",
  streaming: "supported",
  usage: "supported",
  cancellation: "supported",
};

function connection(
  patch: Partial<StoredProviderConnection> = {},
): StoredProviderConnection {
  return {
    id: "conn-a",
    scopeId: "local",
    name: "OpenAI API",
    providerKind: "openai",
    routeKind: "openai-api",
    transport: "http-inference",
    authKind: "api-key",
    protocol: "openai-responses",
    status: "ready",
    credentialRef: "connection/conn-a",
    modelSelectionMode: "catalog",
    defaultModelId: null,
    lastTestedAt: NOW.toISOString(),
    lastModelSyncAt: NOW.toISOString(),
    modelCatalogStale: false,
    display: {
      providerLabel: "OpenAI",
      routeLabel: "API",
      secretConfigured: true,
      endpointConfigured: false,
      endpointKind: "preset",
    },
    ...patch,
  };
}

function model(patch: Partial<ProviderModel> = {}): ProviderModel {
  return {
    connectionId: "conn-a",
    id: "model-a",
    displayName: "Model A",
    contextWindow: 128_000,
    capabilities: supportedCapabilities,
    pricing: null,
    discoveredAt: NOW.toISOString(),
    source: "provider-api",
    ...patch,
  };
}

function probe(patch: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    id: "probe-a",
    connectionId: "conn-a",
    modelId: "model-a",
    protocol: "openai-responses",
    status: "passed",
    capabilities: supportedCapabilities,
    errorCode: null,
    checkedAt: "2026-08-11T11:55:00.000Z",
    ...patch,
  };
}

function fixture(
  overrides: {
    connection?: StoredProviderConnection | null;
    model?: ProviderModel | null;
    probe?: CapabilityReport | null;
  } = {},
) {
  const snapshots: ScanConnectionSnapshot[] = [];
  const storedConnection = overrides.connection === undefined ? connection() : overrides.connection;
  const storedModel = overrides.model === undefined ? model() : overrides.model;
  const storedProbe = overrides.probe === undefined ? probe() : overrides.probe;
  const resolver = createLaunchPlanResolver({
    getConnection: (id) => storedConnection?.id === id ? storedConnection : null,
    getModel: (connectionId, modelId) =>
      storedModel?.connectionId === connectionId && storedModel.id === modelId
        ? storedModel
        : null,
    getLatestCapabilityCheck: (connectionId, modelId, protocol) =>
      storedProbe?.connectionId === connectionId &&
        storedProbe.modelId === modelId &&
        storedProbe.protocol === protocol
        ? storedProbe
        : null,
    writeSnapshot: (snapshot) => snapshots.push(snapshot),
    now: () => NOW,
  });
  return { resolver, snapshots };
}

test("launch rejects a model owned by another connection before persisting a snapshot", () => {
  const { resolver, snapshots } = fixture({
    model: model({ connectionId: "conn-b" }),
  });

  assert.throws(() => resolver.resolve({
    scanId: "scan-a",
    engine: "mantis",
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
  }), (error: unknown) => {
    assert.equal(error instanceof LaunchPlanError, true);
    assert.equal((error as LaunchPlanError).code, "model_not_found");
    return true;
  });
  assert.deepEqual(snapshots, []);
});

test("eligible HTTP launch writes exactly one immutable snapshot with the exact model and probe", () => {
  const { resolver, snapshots } = fixture();

  const plan = resolver.resolve({
    scanId: "scan-a",
    engine: "mantis",
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
  });

  assert.deepEqual(plan, {
    engine: "mantis",
    connectionId: "conn-a",
    providerKind: "openai",
    routeKind: "openai-api",
    runnerKind: "agent-session",
    protocol: "openai-responses",
    model: model(),
    capabilityCheckId: "probe-a",
    snapshot: {
      scanId: "scan-a",
      connectionId: "conn-a",
      routeKind: "openai-api",
      modelSelectionMode: "catalog",
      modelId: "model-a",
      capabilityCheckId: "probe-a",
      capturedAt: NOW.toISOString(),
    },
  });
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots, [plan.snapshot]);
});

test("VulnHunter launch supplies its immutable methodology facts server-side", () => {
  const { resolver } = fixture();

  const plan = resolver.resolve({
    scanId: "scan-vh",
    engine: "vulnhunter",
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
  });

  assert.equal(plan.runnerKind, "agent-session");
  assert.equal(plan.capabilityCheckId, "probe-a");
});

test("Claude Code runtime-default launch persists no browser model fallback", () => {
  const { resolver, snapshots } = fixture({
    connection: connection({
      providerKind: "anthropic",
      routeKind: "claude-code-local",
      transport: "local-cli",
      authKind: "existing-session",
      protocol: "claude-code-cli",
      credentialRef: null,
      modelSelectionMode: "runtime-default",
      modelCatalogStale: false,
    }),
    model: null,
    probe: null,
  });

  const plan = resolver.resolve({
    scanId: "scan-claude-runtime-default",
    engine: "mantis",
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "runtime-default",
      modelId: null,
    },
  });

  assert.equal(plan.runnerKind, "local-agent-session");
  assert.equal(plan.model, null);
  assert.equal(plan.capabilityCheckId, null);
  assert.equal(plan.scannerAuthMode, "existing-session");
  assert.deepEqual(plan.snapshot, {
    scanId: "scan-claude-runtime-default",
    connectionId: "conn-a",
    routeKind: "claude-code-local",
    modelSelectionMode: "runtime-default",
    modelId: null,
    capabilityCheckId: null,
    capturedAt: NOW.toISOString(),
  });
  assert.deepEqual(snapshots, [plan.snapshot]);
});

test("missing connection and stale probe fail without a snapshot", () => {
  const missing = fixture({ connection: null });
  assert.throws(() => missing.resolver.resolve({
    scanId: "scan-a",
    engine: "mantis",
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
  }), (error: unknown) =>
    error instanceof LaunchPlanError && error.code === "connection_not_found");
  assert.deepEqual(missing.snapshots, []);

  const stale = fixture({
    probe: probe({ checkedAt: "2026-08-11T10:00:00.000Z" }),
  });
  assert.throws(() => stale.resolver.resolve({
    scanId: "scan-b",
    engine: "mantis",
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
  }), (error: unknown) =>
    error instanceof LaunchPlanError && error.code === "capability_probe_stale");
  assert.deepEqual(stale.snapshots, []);
});

test("OpenAI Codex Security maps route authentication without reading a vault", () => {
  const chatgpt = fixture({
    connection: connection({
      routeKind: "openai-chatgpt-app-server",
      transport: "codex-app-server",
      authKind: "device-code",
      protocol: "codex-app-server",
      credentialRef: null,
    }),
    probe: null,
  });
  assert.equal(chatgpt.resolver.resolve({
    scanId: "scan-chatgpt",
    engine: "codex-security",
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
  }).scannerAuthMode, "chatgpt");

  const api = fixture({ probe: null });
  assert.equal(api.resolver.resolve({
    scanId: "scan-api",
    engine: "codex-security",
    selection: {
      connectionId: "conn-a",
      modelSelectionMode: "catalog",
      modelId: "model-a",
    },
  }).scannerAuthMode, "api-key");
});
