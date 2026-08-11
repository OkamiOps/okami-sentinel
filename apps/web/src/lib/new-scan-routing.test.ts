import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectionCompatibility, ProviderConnection, ProviderModel } from "@csb/shared";

import {
  buildConnectionAwareStartRequest,
  canResolveConnectionWithEngine,
  compatibilityReasonKey,
  connectionSelectionFor,
  defaultReasoningEffortForCompatibility,
  loadLiveConnectionModels,
  isProbeOnlyCompatibilityBlock,
  validateConnectionCapability,
  reasoningEffortPanelClass,
  reasoningEffortViewportClass,
  reasoningEffortGridClass,
  reasoningEffortOptionClass,
  reasoningEffortForCompatibility,
  reconcileReasoningEffort,
} from "./new-scan-routing.js";
import type { CapabilityValidationClient } from "./new-scan-routing.js";

test("explains an unproven Codex Security gateway contract instead of a generic block", () => {
  assert.equal(
    compatibilityReasonKey(["codex_security_gateway_feature_unproven"]),
    "newScan.compatibilityCodexGatewayUnproven",
  );
  assert.equal(
    compatibilityReasonKey(["connection_not_ready"]),
    "newScan.compatibilityBlocked",
  );
  assert.equal(
    compatibilityReasonKey(["capability_probe_missing"]),
    "newScan.compatibilityPortableRequired",
  );
  assert.equal(
    compatibilityReasonKey(["capability_probe_stale"]),
    "newScan.compatibilityPortableStale",
  );
  assert.equal(
    compatibilityReasonKey(["capability_probe_failed"]),
    "newScan.compatibilityPortableFailed",
  );
  assert.equal(
    compatibilityReasonKey(["provider_runner_unavailable"]),
    "newScan.compatibilityPortableRunnerUnavailable",
  );
});

test("recognizes a selected model blocked only by a missing, stale, or failed capability probe", () => {
  const selection = { connectionId: "connection-a", modelSelectionMode: "catalog" as const, modelId: "live-model" };
  assert.equal(isProbeOnlyCompatibilityBlock({ ...selection, eligible: false, reasons: ["capability_probe_missing"] }), true);
  assert.equal(isProbeOnlyCompatibilityBlock({ ...selection, eligible: false, reasons: ["capability_probe_stale"] }), true);
  assert.equal(isProbeOnlyCompatibilityBlock({ ...selection, eligible: false, reasons: ["capability_probe_failed"] }), true);
  assert.equal(isProbeOnlyCompatibilityBlock({ ...selection, eligible: false, reasons: ["codex_portable_capability_required"] }), true);
  assert.equal(isProbeOnlyCompatibilityBlock({ ...selection, eligible: false, reasons: ["codex_portable_capability_stale"] }), true);
  assert.equal(isProbeOnlyCompatibilityBlock({ ...selection, eligible: false, reasons: ["codex_portable_capability_failed"] }), true);
  assert.equal(isProbeOnlyCompatibilityBlock({ ...selection, eligible: false, reasons: ["capability_probe_missing", "capability_probe_stale"] }), true);
  assert.equal(isProbeOnlyCompatibilityBlock({ ...selection, eligible: false, reasons: ["capability_probe_missing", "connection_not_ready"] }), false);
  assert.equal(isProbeOnlyCompatibilityBlock({ ...selection, eligible: true, reasons: [] }), false);
});

test("validates one selected provider model before compatibility and never starts a scan", async () => {
  const selection = { connectionId: "connection-a", modelSelectionMode: "catalog" as const, modelId: "live-model" };
  const calls: string[] = [];
  const client: CapabilityValidationClient & { startScan(): Promise<never> } = {
    async probeConnection(connectionId, probeSelection) {
      calls.push(`probe:${connectionId}:${probeSelection.modelId}`);
      return {
        connection: connection(),
        report: {
          id: "probe-1", connectionId, modelId: "live-model", protocol: "openai-chat", status: "passed",
          capabilities: model("live-model").capabilities, errorCode: null, checkedAt: "2026-08-11T18:00:00.000Z",
        },
      };
    },
    async resolveScanCompatibility(request) {
      calls.push(`compatibility:${request.engine}:${request.selection.modelId}:${request.executionProfilePreference}`);
      return { ...selection, eligible: true, reasons: [], selectedProfile: "portable" };
    },
    async startScan() {
      calls.push("scan");
      throw new Error("The preflight must not launch a scan");
    },
  };
  const result = await validateConnectionCapability(client, {
    engine: "codex-security",
    selection,
    remoteRepositoryConfirmed: true,
  });

  assert.deepEqual(calls, ["probe:connection-a:live-model", "compatibility:codex-security:live-model:auto"]);
  assert.equal(result.report.status, "passed");
  assert.equal(result.compatibility.eligible, true);
});

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
    reasoning: reasoningEffortForCompatibility({ ...compatibility, reasoningEffort: selectedModel.reasoningEffort }, "high"),
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
  const capabilityPreflight = buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "codex-security",
    selection,
    compatibility: { ...selection, eligible: false, reasons: ["capability_probe_missing"] },
    remoteRepositoryConfirmed: true,
    effort: undefined,
    reasoning: reasoningEffortForCompatibility(null, null),
    mode: "standard",
    paths: [],
  });
  assert.equal(capabilityPreflight, null);

  assert.equal(buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "mantis",
    selection,
    compatibility: { ...selection, eligible: false, reasons: ["connection_not_ready"] },
    remoteRepositoryConfirmed: false,
    effort: "high",
    reasoning: reasoningEffortForCompatibility(null, "high"),
    mode: "standard",
    maxCostUsd: undefined,
    paths: [],
  }), null);
  assert.equal(buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "codex-security",
    selection,
    compatibility: { ...selection, eligible: false, reasons: ["capability_probe_missing", "connection_not_ready"] },
    remoteRepositoryConfirmed: true,
    effort: undefined,
    reasoning: reasoningEffortForCompatibility(null, null),
    mode: "standard",
    paths: [],
  }), null);
  assert.equal(buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "codex-security",
    selection,
    compatibility: { ...selection, eligible: false, reasons: ["provider_runner_unavailable"] },
    remoteRepositoryConfirmed: true,
    effort: undefined,
    reasoning: reasoningEffortForCompatibility(null, null),
    mode: "standard",
    paths: [],
  }), null);
  assert.equal(buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "mantis",
    selection,
    compatibility: { connectionId: "other", modelSelectionMode: "catalog", modelId: "live-model", eligible: true, reasons: [] },
    remoteRepositoryConfirmed: false,
    effort: "high",
    reasoning: reasoningEffortForCompatibility(null, "high"),
    mode: "standard",
    maxCostUsd: undefined,
    paths: [],
  }), null);
});

test("uses only the server compatibility reasoning metadata and omits provider-managed effort", () => {
  const configured = {
    ...model("configured-model"),
    reasoningEffort: {
      options: ["low", "high"],
      default: "high",
    },
  };
  const selection = connectionSelectionFor(connection(), [configured], "configured-model")!;
  const compatibility: ConnectionCompatibility = {
    ...selection,
    eligible: true,
    reasons: [],
    reasoningEffort: { options: ["low", "high", "max", "ultra"], default: "high" },
  };
  assert.deepEqual(reasoningEffortForCompatibility(compatibility, "minimal"), {
    kind: "configurable",
    options: ["low", "high", "max", "ultra"],
    selected: "high",
  });
  assert.deepEqual(reasoningEffortForCompatibility(compatibility, "ultra"), {
    kind: "configurable",
    options: ["low", "high", "max", "ultra"],
    selected: "ultra",
  });
  assert.deepEqual(reasoningEffortForCompatibility({ ...selection, eligible: true, reasons: [] }, "high"), {
    kind: "provider-managed",
    options: [],
    selected: null,
  });

  const request = buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "codex-security",
    selection,
    compatibility: { ...selection, eligible: true, reasons: [] },
    remoteRepositoryConfirmed: true,
    effort: reasoningEffortForCompatibility(null, "high").selected ?? undefined,
    reasoning: reasoningEffortForCompatibility(null, "high"),
    mode: "standard",
    paths: [],
  });
  assert.equal("effort" in request!, false);
});

test("does not invent a default when a provider publishes options without one", () => {
  const configured = {
    ...model("configured-model"),
    reasoningEffort: { options: ["economy", "forensic"], default: null },
  };
  const selection = connectionSelectionFor(connection(), [configured], "configured-model")!;
  const reasoning = reasoningEffortForCompatibility({ ...selection, eligible: true, reasons: [], reasoningEffort: configured.reasoningEffort }, "untrusted-browser-value");
  assert.deepEqual(reasoning, {
    kind: "configurable",
    options: ["economy", "forensic"],
    selected: null,
  });

  const request = buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "codex-security",
    selection,
    compatibility: { ...selection, eligible: true, reasons: [] },
    remoteRepositoryConfirmed: true,
    effort: "untrusted-browser-value",
    reasoning,
    mode: "standard",
    paths: [],
  });
  assert.equal("effort" in request!, false);
});

test("resets a route change to the server-published default", () => {
  const selection = connectionSelectionFor(connection(), [model("configured")], "configured")!;
  assert.equal(defaultReasoningEffortForCompatibility({
    ...selection,
    eligible: true,
    reasons: [],
    reasoningEffort: { options: ["low", "high"], default: "low" },
  }), "low");
  assert.equal(defaultReasoningEffortForCompatibility({
    ...selection,
    eligible: true,
    reasons: [],
    reasoningEffort: { options: ["low", "high", "ultra"], default: "high" },
  }), "high");
  assert.equal(defaultReasoningEffortForCompatibility({
    ...selection,
    eligible: true,
    reasons: [],
    reasoningEffort: { options: ["economy", "forensic"], default: null },
  }), null);
  assert.equal(defaultReasoningEffortForCompatibility(null), null);
});

test("preserves a selected effort through authorization revalidation until the server contract changes", () => {
  const selection = connectionSelectionFor(connection(), [model("configured")], "configured")!;
  const contract: ConnectionCompatibility = {
    ...selection,
    eligible: true,
    reasons: [],
    reasoningEffort: { options: ["low", "high", "max", "ultra"], default: "high" },
  };

  assert.equal(reconcileReasoningEffort("ultra", null), "ultra");
  assert.equal(reconcileReasoningEffort("ultra", contract), "ultra");
  assert.equal(reconcileReasoningEffort("ultra", {
    ...contract,
    reasoningEffort: { options: ["low", "high"], default: "high" },
  }), "high");
  assert.equal(reconcileReasoningEffort("ultra", {
    ...contract,
    reasoningEffort: undefined,
  }), null);
});

test("loads a live model catalog for every connection and falls back to cache safely", async () => {
  const cached = [model("cached-model")];
  const live = [{
    ...model("live-model"),
    reasoningEffort: { options: ["quick", "exhaustive"], default: "quick" },
  }];
  const calls: string[] = [];
  const client = {
    async listConnectionModels() {
      calls.push("cache");
      return cached;
    },
    async refreshConnectionModels() {
      calls.push("refresh");
      return {
        connection: connection(),
        discovery: { models: live, supportsRuntimeDefault: false },
      };
    },
  };

  assert.deepEqual(await loadLiveConnectionModels(client, "connection-a"), live);
  assert.deepEqual(calls.sort(), ["cache", "refresh"]);

  assert.deepEqual(await loadLiveConnectionModels({
    async listConnectionModels() { return cached; },
    async refreshConnectionModels() { throw new Error("provider unavailable"); },
  }, "connection-a"), cached);
});

test("lays out six published reasoning options without hidden horizontal scroll", () => {
  assert.match(reasoningEffortGridClass, /grid-cols-3/);
  assert.match(reasoningEffortGridClass, /sm:grid-cols-6/);
  assert.match(reasoningEffortGridClass, /gap-px/);
  assert.match(reasoningEffortGridClass, /bg-border/);
  assert.doesNotMatch(reasoningEffortGridClass, /grid-flow-col|auto-cols-|w-max|overflow-x/);
  assert.match(reasoningEffortOptionClass, /bg-background/);
  assert.match(reasoningEffortOptionClass, /min-w-0/);
  assert.match(reasoningEffortOptionClass, /truncate/);
  assert.doesNotMatch(reasoningEffortOptionClass, /border-l/);
});

test("keeps seven provider options and a long label inside the responsive grid", () => {
  const selection = connectionSelectionFor(connection(), [model("configured")], "configured")!;
  const options = ["low", "medium", "high", "xhigh", "max", "ultra", "provider-specific-forensic-analysis"];
  const control = reasoningEffortForCompatibility({
    ...selection,
    eligible: true,
    reasons: [],
    reasoningEffort: { options, default: "high" },
  }, "ultra");
  assert.deepEqual(control, { kind: "configurable", options, selected: "ultra" });
  assert.match(reasoningEffortPanelClass, /min-w-0/);
  assert.match(reasoningEffortViewportClass, /min-w-0/);
  assert.match(reasoningEffortViewportClass, /max-w-full/);
  assert.doesNotMatch(reasoningEffortViewportClass, /overflow-x-auto/);
  assert.match(reasoningEffortGridClass, /w-full/);
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
    reasoning: reasoningEffortForCompatibility({ ...selection, eligible: true, reasons: [], reasoningEffort: configured.reasoningEffort }, "low"),
    mode: "standard",
    paths: [],
  });
  assert.equal(request?.effort, "low");
});

test("pins Codex Security browser requests to the automatic server-resolved profile", () => {
  const configured = {
    ...model("configured-model"),
    reasoningEffort: { options: ["low", "high"], default: "high" },
  };
  const selection = connectionSelectionFor(connection(), [configured], "configured-model")!;
  const request = buildConnectionAwareStartRequest({
    repositoryPath: "/workspace/repository",
    engine: "codex-security",
    selection,
    compatibility: {
      ...selection,
      eligible: true,
      reasons: [],
      selectedProfile: "portable",
      availableProfiles: ["portable"],
      profileVersion: "sentinel-codex-security-portable-v1",
      methodologyRef: "sentinel/codex-security-methodology@v1",
      capabilityCheckId: "probe-1",
    },
    remoteRepositoryConfirmed: true,
    executionProfilePreference: "portable",
    effort: "browser-forged",
    reasoning: reasoningEffortForCompatibility({ ...selection, eligible: true, reasons: [], reasoningEffort: configured.reasoningEffort }, "low"),
    mode: "standard",
    paths: ["src"],
  });

  assert.deepEqual(request, {
    repositoryPath: "/workspace/repository",
    engine: "codex-security",
    connection: selection,
    remoteRepositoryConfirmed: true,
    executionProfilePreference: "auto",
    effort: "low",
    mode: "standard",
    paths: ["src"],
  });
  assert.equal("execution" in request!, false);
  assert.equal("profileVersion" in request!, false);
  assert.equal("methodologyRef" in request!, false);
});

test("keeps an enabled methodology selectable when its legacy local runtime is unavailable", () => {
  assert.equal(canResolveConnectionWithEngine({ enabled: true, available: false }), true);
  assert.equal(canResolveConnectionWithEngine({ enabled: false, available: true }), false);
});
