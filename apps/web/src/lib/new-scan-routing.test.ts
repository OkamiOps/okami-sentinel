import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectionCompatibility, ProviderConnection, ProviderModel } from "@csb/shared";

import {
  buildConnectionAwareStartRequest,
  canResolveConnectionWithEngine,
  connectionSelectionFor,
  reasoningEffortGridClass,
  reasoningEffortForModel,
} from "./new-scan-routing.js";

function connection(modelSelectionMode: ProviderConnection["modelSelectionMode"] = "catalog"): ProviderConnection {
  return {
    id: "connection-a",
    scopeId: "local",
    name: "Primary provider",
    providerKind: "openai",
    routeKind: "chatgpt-device",
    transport: "codex-app-server",
    authKind: "device-code",
    protocol: "codex-app-server",
    status: "ready",
    modelSelectionMode,
    defaultModelId: modelSelectionMode === "runtime-default" ? null : "live-model",
    lastTestedAt: null,
    lastModelSyncAt: null,
    modelCatalogStale: false,
    display: {
      providerLabel: "OpenAI",
      routeLabel: "ChatGPT device",
      secretConfigured: true,
      endpointConfigured: true,
      endpointKind: "preset",
    },
  };
}

function model(id: string): ProviderModel {
  return {
    connectionId: "connection-a",
    id,
    displayName: id,
    contextWindow: null,
    capabilities: {
      tools: "unknown", artifactOutput: "unknown", structuredOutput: "unknown",
      boundedExecution: "unknown", osIsolation: "unknown", streaming: "unknown",
      usage: "unknown", cancellation: "unknown",
    },
    pricing: null,
    discoveredAt: "2026-08-11T18:00:00.000Z",
    source: "provider-api",
  };
}

test("uses a catalog model only when it was returned by the selected connection", () => {
  const liveModels = [model("live-model")];
  assert.deepEqual(connectionSelectionFor(connection(), liveModels, "live-model"), {
    connectionId: "connection-a",
    modelSelectionMode: "catalog",
    modelId: "live-model",
  });
  assert.equal(connectionSelectionFor(connection(), liveModels, "gpt-5.6-sol"), null);
  assert.equal(connectionSelectionFor(connection(), [], null), null);
  assert.equal(connectionSelectionFor(connection(), [{ ...model("live-model"), connectionId: "other-connection" }], "live-model"), null);
});

test("uses runtime default only when the connection declares that selection mode", () => {
  assert.deepEqual(connectionSelectionFor(connection("runtime-default"), [model("ignored")], null), {
    connectionId: "connection-a",
    modelSelectionMode: "runtime-default",
    modelId: null,
  });
  assert.equal(connectionSelectionFor(connection(), [model("live-model")], null), null);
});

test("builds a connection-only scan payload after matching server eligibility", () => {
  const selectedModel = {
    ...model("live-model"),
    reasoningEffort: { options: ["low", "high"], default: "high" },
  };
  const selection = connectionSelectionFor(connection(), [selectedModel], "live-model")!;
  const compatibility: ConnectionCompatibility = { ...selection, eligible: true, reasons: [] };
  const request = buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "mantis",
    selection,
    compatibility,
    remoteRepositoryConfirmed: true,
    effort: "high",
    reasoning: reasoningEffortForModel(selectedModel, "high"),
    mode: "standard",
    maxCostUsd: undefined,
    paths: ["src"],
  });

  assert.deepEqual(request, {
    repositoryPath: "/workspace/repository",
    engine: "mantis",
    connection: selection,
    remoteRepositoryConfirmed: true,
    effort: "high",
    mode: "standard",
    maxCostUsd: undefined,
    paths: ["src"],
  });
  assert.equal("provider" in request!, false);
  assert.equal("authMode" in request!, false);
  assert.equal("model" in request!, false);
});

test("does not build a scan request from a stale or blocked server compatibility result", () => {
  const selection = connectionSelectionFor(connection(), [model("live-model")], "live-model")!;
  assert.equal(buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "mantis",
    selection,
    compatibility: { ...selection, eligible: false, reasons: ["connection_not_ready"] },
    remoteRepositoryConfirmed: false,
    effort: "high",
    reasoning: reasoningEffortForModel(model("provider-managed"), "high"),
    mode: "standard",
    maxCostUsd: undefined,
    paths: [],
  }), null);
  assert.equal(buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "mantis",
    selection,
    compatibility: { connectionId: "other", modelSelectionMode: "catalog", modelId: "live-model", eligible: true, reasons: [] },
    remoteRepositoryConfirmed: false,
    effort: "high",
    reasoning: reasoningEffortForModel(model("provider-managed"), "high"),
    mode: "standard",
    maxCostUsd: undefined,
    paths: [],
  }), null);
});

test("uses only the selected model reasoning metadata and omits provider-managed effort", () => {
  const configured = {
    ...model("configured-model"),
    reasoningEffort: {
      options: ["low", "high"],
      default: "high",
    },
  };
  assert.deepEqual(reasoningEffortForModel(configured, "minimal"), {
    kind: "configurable",
    options: ["low", "high"],
    selected: "high",
  });
  assert.deepEqual(reasoningEffortForModel(configured, "low"), {
    kind: "configurable",
    options: ["low", "high"],
    selected: "low",
  });
  assert.deepEqual(reasoningEffortForModel(model("provider-managed"), "high"), {
    kind: "provider-managed",
    options: [],
    selected: null,
  });

  const selection = connectionSelectionFor(connection(), [model("provider-managed")], "provider-managed")!;
  const request = buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "codex-security",
    selection,
    compatibility: { ...selection, eligible: true, reasons: [] },
    remoteRepositoryConfirmed: true,
    effort: reasoningEffortForModel(model("provider-managed"), "high").selected ?? undefined,
    reasoning: reasoningEffortForModel(model("provider-managed"), "high"),
    mode: "standard",
    paths: [],
  });
  assert.equal("effort" in request!, false);
});

test("lays out any published reasoning-option count without a fixed column cap", () => {
  assert.match(reasoningEffortGridClass, /grid-flow-col/);
  assert.match(reasoningEffortGridClass, /auto-cols-fr/);
  assert.doesNotMatch(reasoningEffortGridClass, /grid-cols-[35]/);
});

test("serializes only a model-published reasoning effort, never the browser value", () => {
  const configured = {
    ...model("configured-model"),
    reasoningEffort: { options: ["low", "high"], default: "high" },
  };
  const selection = connectionSelectionFor(connection(), [configured], "configured-model")!;
  const request = buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "codex-security",
    selection,
    compatibility: { ...selection, eligible: true, reasons: [] },
    remoteRepositoryConfirmed: true,
    effort: "xhigh",
    reasoning: reasoningEffortForModel(configured, "low"),
    mode: "standard",
    paths: [],
  });
  assert.equal(request?.effort, "low");
});

test("keeps an enabled methodology selectable when its legacy local runtime is unavailable", () => {
  assert.equal(canResolveConnectionWithEngine({ enabled: true, available: false }), true);
  assert.equal(canResolveConnectionWithEngine({ enabled: false, available: true }), false);
});
