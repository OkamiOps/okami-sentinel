import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderModel, ScanConnectionSelection } from "@csb/shared";
import type { StoredProviderConnection } from "../connections-store.js";
import type { ConnectionSecretBundle, CredentialVault } from "../credentials/credential-vault.js";
import type { HttpFetch } from "./http-model-discovery.js";
import {
  createHttpRouteAdapter,
  discoverModels,
  inspectHttpRoute,
  probeHttpRoute,
  refreshConnectionModels,
} from "./http-route-adapters.js";

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Gemini preset exposes the official OpenAI chat wire path without inferring agent capability", async () => {
  const route = await inspectHttpRoute(connection("gemini-api"), fakeVault({ apiKey: "gemini-secret" }));

  assert.equal(route.available, true);
  assert.equal(route.protocol, "openai-chat");
  assert.equal(route.inferencePath, "/v1beta/openai/chat/completions");
  assert.equal(route.capabilities.tools, "unknown");
  assert.equal(route.capabilities.structuredOutput, "unknown");
  assert.equal(JSON.stringify(route).includes("gemini-secret"), false);
});

test("Gemini and DeepSeek presets discover only live authenticated catalogs", async () => {
  const geminiTransport = fakeFetch({
    "GET https://generativelanguage.googleapis.com/v1beta/models": json(200, {
      models: [{ name: "models/visible", baseModelId: "account-visible", displayName: "Visible" }],
      nextPageToken: "page-2",
    }),
    "GET https://generativelanguage.googleapis.com/v1beta/models?pageToken=page-2": json(200, {
      models: [{ name: "models/other", baseModelId: "account-visible-2" }],
    }),
  });
  const deepSeekTransport = fakeFetch({
    "GET https://api.deepseek.com/models": json(200, { data: [{ id: "account-visible" }] }),
  });

  const gemini = await discoverModels(connection("gemini-api"), {
    vault: fakeVault({ apiKey: "gemini-secret" }),
    transport: geminiTransport,
  });
  const deepseek = await discoverModels(connection("deepseek-api"), {
    vault: fakeVault({ apiKey: "deepseek-secret" }),
    transport: deepSeekTransport,
  });

  assert.deepEqual(gemini.models.map((model) => model.id), ["account-visible", "account-visible-2"]);
  assert.deepEqual(deepseek.models.map((model) => model.id), ["account-visible"]);
  assert.equal(geminiTransport.calls[0]?.init.headers?.["x-goog-api-key"], "gemini-secret");
  assert.equal(deepSeekTransport.calls[0]?.init.headers?.Authorization, "Bearer deepseek-secret");
  assert.equal(JSON.stringify([gemini, deepseek]).includes("fallbackModel"), false);
  assert.equal(JSON.stringify([gemini, deepseek]).includes("gemini-secret"), false);
  assert.equal(JSON.stringify([gemini, deepseek]).includes("deepseek-secret"), false);
});

test("fixed xAI catalog ignores a custom host and keeps its bearer in the vault boundary", async () => {
  const transport = fakeFetch({
    "GET https://api.x.ai/v1/models": json(200, { models: [{ id: "account-visible" }] }),
  });

  const result = await discoverModels(connection("xai-api"), {
    vault: fakeVault({ apiKey: "xai-secret", baseUrl: "https://untrusted.example/v1" }),
    transport,
  });

  assert.deepEqual(result.models.map((model) => model.id), ["account-visible"]);
  assert.deepEqual(transport.calls.map((call) => call.url), ["https://api.x.ai/v1/models"]);
  assert.equal(JSON.stringify(result).includes("xai-secret"), false);
});

test("fixed OpenAI catalog ignores custom hosts and uses the official models endpoint", async () => {
  const transport = fakeFetch({
    "GET https://api.openai.com/v1/models": json(200, { data: [{ id: "account-visible" }] }),
  });

  const result = await discoverModels(connection("openai-api"), {
    vault: fakeVault({
      apiKey: "openai-secret",
      baseUrl: "https://untrusted.example/v1",
      discoveryUrl: "https://untrusted.example/models",
    }),
    transport,
  });

  assert.deepEqual(result.models.map((model) => model.id), ["account-visible"]);
  assert.deepEqual(transport.calls.map((call) => call.url), ["https://api.openai.com/v1/models"]);
  assert.equal(JSON.stringify(result).includes("openai-secret"), false);
});

test("OpenAI API adapter exposes the Responses protocol required by its route contract", () => {
  const adapter = createHttpRouteAdapter("openai-api", {
    vault: fakeVault({ apiKey: "openai-secret" }),
  });

  assert.equal(adapter.protocol, "openai-responses");
});

test("failed refresh preserves stale rows and never supplies a fallback model", async () => {
  const stale = [model("conn-a", "previously-discovered")];
  const result = await refreshConnectionModels(connection("custom-openai-compatible"), {
    vault: fakeVault({ baseUrl: "https://gateway.example/v1", apiKey: "secret-value" }),
    transport: fakeFetch({ "GET https://gateway.example/v1/models": json(403, { error: "secret-value" }) }),
    staleModels: stale,
  });

  assert.equal(result.status, "stale");
  assert.deepEqual(result.models.map((item) => item.id), ["previously-discovered"]);
  assert.equal(result.safeError?.code, "endpoint_access_denied");
  assert.equal(result.models.some((item) => item.id === "fallbackModel"), false);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});

test("MiniMax discovers all pages from its pinned Token Plan catalog", async () => {
  const transport = fakeFetch({
    "GET https://api.minimax.io/anthropic/v1/models": json(200, {
      data: [{ id: "account-visible", display_name: "Account Visible" }],
      has_more: true,
      last_id: "account-visible",
    }),
    "GET https://api.minimax.io/anthropic/v1/models?after_id=account-visible": json(200, {
      data: [{ id: "account-visible-2", display_name: "Account Visible 2" }],
      has_more: false,
      last_id: "account-visible-2",
    }),
  });
  const result = await discoverModels(connection("minimax-token-plan"), {
    vault: fakeVault({ apiKey: "minimax-secret" }),
    transport,
  });

  assert.deepEqual(result.models.map((model) => ({ id: model.id, displayName: model.displayName })), [
    { id: "account-visible", displayName: "Account Visible" },
    { id: "account-visible-2", displayName: "Account Visible 2" },
  ]);
  assert.equal(result.pageCount, 2);
  assert.equal(result.safeError, undefined);
  assert.deepEqual(transport.calls.map((call) => call.url), [
    "https://api.minimax.io/anthropic/v1/models",
    "https://api.minimax.io/anthropic/v1/models?after_id=account-visible",
  ]);
  assert.equal(transport.calls[0]?.init.headers?.["X-Api-Key"], "minimax-secret");
  assert.equal(JSON.stringify(result).includes("minimax-secret"), false);
});

test("MiniMax ignores arbitrary discovery and base hosts rather than sending its plan token", async () => {
  const transport = fakeFetch({
    "GET https://api.minimax.io/anthropic/v1/models": json(200, { data: [] }),
  });
  const result = await discoverModels(connection("minimax-token-plan"), {
    vault: fakeVault({
      apiKey: "minimax-secret",
      baseUrl: "https://untrusted.example/anthropic",
      discoveryUrl: "https://untrusted.example/models",
    }),
    transport,
  });

  assert.equal(result.safeError, undefined);
  assert.deepEqual(result.models, []);
  assert.deepEqual(transport.calls.map((call) => call.url), [
    "https://api.minimax.io/anthropic/v1/models",
  ]);
  assert.equal(transport.calls[0]?.init.headers?.["X-Api-Key"], "minimax-secret");
  assert.equal(JSON.stringify(result).includes("minimax-secret"), false);
  assert.equal(JSON.stringify(result).includes("untrusted.example"), false);
});

test("an empty authenticated catalog is valid and a later refresh removes absent rows", async () => {
  const empty = await refreshConnectionModels(connection("custom-openai-compatible"), {
    vault: fakeVault({ baseUrl: "https://gateway.example/v1", apiKey: "secret-value" }),
    transport: fakeFetch({ "GET https://gateway.example/v1/models": json(200, { data: [] }) }),
    staleModels: [model("conn-a", "old-model")],
  });

  assert.equal(empty.status, "ready");
  assert.deepEqual(empty.models, []);
  assert.equal(empty.safeError, undefined);
});

test("a custom OpenAI route without a configured endpoint never falls back to OpenAI", async () => {
  const transport = fakeFetch({});
  const result = await discoverModels(connection("custom-openai-compatible"), {
    vault: fakeVault({ apiKey: "custom-secret" }),
    transport,
  });

  assert.equal(result.safeError?.code, "model_discovery_unsupported");
  assert.deepEqual(transport.calls, []);
  assert.equal(JSON.stringify(result).includes("custom-secret"), false);
});

test("insecure HTTP requires an explicit local-only flag and still rejects remote hosts", async () => {
  const localTransport = fakeFetch({
    "GET http://localhost:7331/v1/models": json(200, { data: [{ id: "account-visible" }] }),
  });
  const localBundle = {
    baseUrl: "http://localhost:7331/v1",
    apiKey: "local-secret",
    allowInsecureLocalhost: true,
  } as ConnectionSecretBundle;
  const local = await discoverModels(connection("custom-openai-compatible"), {
    vault: fakeVault(localBundle),
    transport: localTransport,
  });
  assert.deepEqual(local.models.map((item) => item.id), ["account-visible"]);

  const noFlagTransport = fakeFetch({});
  const noFlag = await discoverModels(connection("custom-openai-compatible"), {
    vault: fakeVault({ baseUrl: "http://localhost:7331/v1", apiKey: "no-flag-secret" }),
    transport: noFlagTransport,
  });
  assert.equal(noFlag.safeError?.code, "protocol_unsupported");
  assert.deepEqual(noFlagTransport.calls, []);

  const remoteTransport = fakeFetch({});
  const remoteBundle = {
    baseUrl: "http://gateway.example/v1",
    apiKey: "remote-secret",
    allowInsecureLocalhost: true,
  } as ConnectionSecretBundle;
  const remote = await discoverModels(connection("custom-openai-compatible"), {
    vault: fakeVault(remoteBundle),
    transport: remoteTransport,
  });
  assert.equal(remote.safeError?.code, "protocol_unsupported");
  assert.deepEqual(remoteTransport.calls, []);
  assert.equal(JSON.stringify([local, noFlag, remote]).includes("local-secret"), false);
  assert.equal(JSON.stringify([local, noFlag, remote]).includes("no-flag-secret"), false);
  assert.equal(JSON.stringify([local, noFlag, remote]).includes("remote-secret"), false);
});

test("Anthropic uses its authenticated model pages while MiMo without a regional base stays non-ready", async () => {
  const anthropicTransport = fakeFetch({
    "GET https://api.anthropic.com/v1/models": json(200, {
      data: [{ id: "account-visible", display_name: "Account visible" }],
      has_more: false,
    }),
  });
  const anthropic = await discoverModels(connection("anthropic-api"), {
    vault: fakeVault({ apiKey: "anthropic-secret" }),
    transport: anthropicTransport,
  });
  const mimo = await discoverModels(connection("mimo-token-plan"), {
    vault: fakeVault({ apiKey: "tp-mimo-secret" }),
    transport: fakeFetch({}),
  });

  assert.deepEqual(anthropic.models.map((item) => item.id), ["account-visible"]);
  assert.equal(anthropicTransport.calls[0]?.init.headers?.["x-api-key"], "anthropic-secret");
  assert.equal(mimo.safeError?.code, "model_discovery_unsupported");
  assert.equal(JSON.stringify([anthropic, mimo]).includes("anthropic-secret"), false);
  assert.equal(JSON.stringify([anthropic, mimo]).includes("tp-mimo-secret"), false);
});

test("MiMo discovers exactly one authenticated catalog from the selected OpenAI Token Plan region", async () => {
  const tokenPlanKey = "tp-mimo-secret";
  const transport = fakeFetch({
    "GET https://token-plan-sgp.xiaomimimo.com/v1/models": json(200, {
      object: "list",
      data: [{ id: "account-visible" }],
      has_more: true,
      last_id: "account-visible",
    }),
  });

  const result = await discoverModels(connection("mimo-token-plan"), {
    vault: fakeVault({
      apiKey: tokenPlanKey,
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      discoveryUrl: "https://attacker.example/models",
    }),
    transport,
  });

  assert.deepEqual(result.models.map((model) => model.id), ["account-visible"]);
  assert.equal(result.pageCount, 1);
  assert.deepEqual(transport.calls.map((call) => call.url), [
    "https://token-plan-sgp.xiaomimimo.com/v1/models",
  ]);
  assert.equal(transport.calls[0]?.init.headers?.["api-key"], tokenPlanKey);
  assert.equal(transport.calls[0]?.init.headers?.Authorization, undefined);
  assert.equal(JSON.stringify(result).includes(tokenPlanKey), false);

  const empty = await discoverModels(connection("mimo-token-plan"), {
    vault: fakeVault({
      apiKey: tokenPlanKey,
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    }),
    transport: fakeFetch({
      "GET https://token-plan-cn.xiaomimimo.com/v1/models": json(200, {
        object: "list",
        data: [],
      }),
    }),
  });
  assert.deepEqual(empty.models, []);
  assert.equal(empty.safeError, undefined);
  assert.equal(empty.pageCount, 1);
});

test("MiMo derives the paired OpenAI catalog from an Anthropic Token Plan base", async () => {
  const tokenPlanKey = "tp-mimo-secret";
  const transport = fakeFetch({
    "GET https://token-plan-ams.xiaomimimo.com/v1/models": json(200, {
      object: "list",
      data: [{ id: "account-visible" }],
    }),
  });
  const anthropicConnection = {
    ...connection("mimo-token-plan"),
    protocol: "anthropic-messages" as const,
  };

  const result = await discoverModels(anthropicConnection, {
    vault: fakeVault({
      apiKey: tokenPlanKey,
      baseUrl: "https://token-plan-ams.xiaomimimo.com/v1/anthropic",
      discoveryUrl: "https://attacker.example/models",
    }),
    transport,
  });
  const inspection = await inspectHttpRoute(anthropicConnection, fakeVault({
    apiKey: tokenPlanKey,
    baseUrl: "https://token-plan-ams.xiaomimimo.com/v1/anthropic",
  }));

  assert.deepEqual(result.models.map((model) => model.id), ["account-visible"]);
  assert.deepEqual(transport.calls.map((call) => call.url), [
    "https://token-plan-ams.xiaomimimo.com/v1/models",
  ]);
  assert.equal(transport.calls[0]?.init.headers?.["api-key"], tokenPlanKey);
  assert.equal(inspection.inferencePath, "/v1/messages");
  assert.equal(JSON.stringify([result, inspection]).includes(tokenPlanKey), false);
});

test("MiMo fails closed for non-plan keys, unapproved regions, and invalid catalog shapes", async () => {
  const nonPlanKeyTransport = fakeFetch({});
  const nonPlanKey = await discoverModels(connection("mimo-token-plan"), {
    vault: fakeVault({
      apiKey: "sk-not-a-token-plan-key",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    }),
    transport: nonPlanKeyTransport,
  });
  assert.equal(nonPlanKey.safeError?.code, "credential_rejected");
  assert.deepEqual(nonPlanKeyTransport.calls, []);

  const unapprovedRegionTransport = fakeFetch({});
  const unapprovedRegion = await discoverModels(connection("mimo-token-plan"), {
    vault: fakeVault({
      apiKey: "tp-mimo-secret",
      baseUrl: "https://token-plan-unknown.xiaomimimo.com/v1",
    }),
    transport: unapprovedRegionTransport,
  });
  assert.equal(unapprovedRegion.safeError?.code, "model_discovery_unsupported");
  assert.deepEqual(unapprovedRegionTransport.calls, []);

  for (const [status, response, expected] of [
    [401, { object: "list", data: [] }, "credential_rejected"],
    [403, { object: "list", data: [] }, "endpoint_access_denied"],
    [200, { object: "not-a-list", data: [{ id: "must-not-escape" }] }, "protocol_unsupported"],
  ] as const) {
    const result = await discoverModels(connection("mimo-token-plan"), {
      vault: fakeVault({
        apiKey: "tp-mimo-secret",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      }),
      transport: fakeFetch({
        "GET https://token-plan-cn.xiaomimimo.com/v1/models": json(status, response),
      }),
    });

    assert.equal(result.safeError?.code, expected);
    assert.deepEqual(result.models, []);
  }
});

test("a probe only records explicit measurements for a selected model owned by the connection", async () => {
  const selected = model("conn-a", "account-visible");
  const selection: ScanConnectionSelection = {
    connectionId: "conn-a",
    modelSelectionMode: "catalog",
    modelId: "account-visible",
  };
  const result = await probeHttpRoute(connection("gemini-api"), selection, {
    vault: fakeVault({ apiKey: "gemini-secret" }),
    selectedModel: selected,
    probeSession: async (input) => {
      assert.equal(input.model.id, "account-visible");
      assert.equal(input.protocol, "openai-chat");
      assert.equal(input.inferencePath, "/v1beta/openai/chat/completions");
      return {
        capabilities: { tools: "supported", streaming: "supported" },
        limitsEnforced: true,
        agentLoop: {
          workspaceToolRequested: true,
          workspaceToolResultConsumed: true,
          resultsWriteRequested: true,
          artifactProduced: true,
          structuredResultProduced: true,
        },
        runtimeEvidence: completeRuntimeEvidence(),
        contextWindow: 128_000,
        pricing: {
          inputUsdPerMillionTokens: 1,
          cachedInputUsdPerMillionTokens: null,
          outputUsdPerMillionTokens: 2,
        },
      };
    },
  });

  assert.equal(result.report.status, "passed");
  assert.equal(result.report.capabilities.tools, "supported");
  assert.equal(result.report.capabilities.streaming, "supported");
  assert.equal(result.report.capabilities.artifactOutput, "unknown");
  assert.equal(result.contextWindow, 128_000);
  assert.equal(result.pricing?.outputUsdPerMillionTokens, 2);

  const denied = await probeHttpRoute(connection("gemini-api"), {
    ...selection,
    connectionId: "conn-b",
  }, {
    vault: fakeVault({ apiKey: "gemini-secret" }),
    selectedModel: selected,
    probeSession: async () => {
      throw new Error("must not run");
    },
  });
  assert.equal(denied.report.errorCode, "model_access_denied");
  assert.equal(denied.report.capabilities.tools, "unknown");
});

test("a partial agent loop or model 403 keeps all probe facts unknown", async () => {
  const selection: ScanConnectionSelection = {
    connectionId: "conn-a",
    modelSelectionMode: "catalog",
    modelId: "account-visible",
  };
  const partial = await probeHttpRoute(connection("deepseek-api"), selection, {
    vault: fakeVault({ apiKey: "deepseek-secret" }),
    selectedModel: model("conn-a", "account-visible"),
    probeSession: async () => ({
      capabilities: { tools: "supported" },
      limitsEnforced: true,
      agentLoop: {
        workspaceToolRequested: true,
        workspaceToolResultConsumed: false,
        resultsWriteRequested: false,
        artifactProduced: false,
        structuredResultProduced: false,
      },
    }),
  });
  assert.equal(partial.report.status, "failed");
  assert.equal(partial.report.errorCode, "protocol_unsupported");
  assert.equal(partial.report.capabilities.tools, "unknown");

  const denied = await probeHttpRoute(connection("deepseek-api"), selection, {
    vault: fakeVault({ apiKey: "deepseek-secret" }),
    selectedModel: model("conn-a", "account-visible"),
    probeSession: async () => {
      throw { status: 403 };
    },
  });
  assert.equal(denied.report.errorCode, "model_access_denied");
  assert.equal(denied.report.capabilities.structuredOutput, "unknown");
});

test("probe keeps the bundle redactor active through the complete session callback", async () => {
  const activeScopes = new Map<string, readonly string[]>();
  const redactor = {
    register(scope: string, values: readonly string[]) {
      activeScopes.set(scope, values);
    },
    unregister(scope: string) {
      activeScopes.delete(scope);
    },
  };
  const result = await probeHttpRoute(connection("gemini-api"), {
    connectionId: "conn-a",
    modelSelectionMode: "catalog",
    modelId: "account-visible",
  }, {
    vault: fakeVault({
      apiKey: "probe-session-secret",
      headers: { "X-Workspace-Token": "probe-header-secret" },
    }),
    selectedModel: model("conn-a", "account-visible"),
    redactor,
    probeSession: async () => {
      const registered = [...activeScopes.values()].flat();
      assert.equal(registered.includes("probe-session-secret"), true);
      assert.equal(registered.includes("probe-header-secret"), true);
      return completeProbeMeasurement();
    },
  });

  assert.equal(result.report.status, "passed");
  assert.equal(activeScopes.size, 0);
  assert.equal(JSON.stringify(result).includes("probe-session-secret"), false);
  assert.equal(JSON.stringify(result).includes("probe-header-secret"), false);
});

function connection(routeKind: string): StoredProviderConnection {
  return {
    id: "conn-a",
    scopeId: "local",
    name: "Test connection",
    providerKind: routeKind,
    routeKind,
    transport: "http-inference",
    authKind: "api-key",
    protocol: routeKind === "anthropic-api" || routeKind === "custom-anthropic-compatible" || routeKind === "minimax-token-plan"
      ? "anthropic-messages"
      : "openai-chat",
    status: "testing",
    modelSelectionMode: "catalog",
    defaultModelId: null,
    lastTestedAt: null,
    lastModelSyncAt: null,
    modelCatalogStale: false,
    display: {
      providerLabel: "Test",
      routeLabel: routeKind,
      secretConfigured: true,
      endpointConfigured: true,
      endpointKind: "preset",
    },
    credentialRef: "connection/conn-a",
  };
}

function model(connectionId: string, id: string): ProviderModel {
  return {
    connectionId,
    id,
    displayName: id,
    contextWindow: null,
    capabilities: {
      tools: "unknown",
      artifactOutput: "unknown",
      structuredOutput: "unknown",
      boundedExecution: "unknown",
      osIsolation: "unknown",
      streaming: "unknown",
      usage: "unknown",
      cancellation: "unknown",
    },
    pricing: null,
    discoveredAt: "2026-08-11T00:00:00.000Z",
    source: "provider-api",
  };
}

function completeProbeMeasurement() {
  return {
    capabilities: { tools: "supported" as const },
    limitsEnforced: true,
    agentLoop: {
      workspaceToolRequested: true,
      workspaceToolResultConsumed: true,
      resultsWriteRequested: true,
      artifactProduced: true,
      structuredResultProduced: true,
    },
    runtimeEvidence: completeRuntimeEvidence(),
  };
}

function completeRuntimeEvidence() {
  return {
    authoritativeDeadlineEnforced: true,
    authoritativeCancellationEnforced: true,
    privatePinnedRootsEnforced: true,
    closedToolSurfaceEnforced: true,
  };
}

function fakeVault(bundle: ConnectionSecretBundle): CredentialVault {
  return {
    async available() {
      return { available: true, backend: "keychain" } as const;
    },
    async put() {},
    async get() {
      return bundle;
    },
    async delete() {},
  };
}

function fakeFetch(routes: Record<string, Response>): HttpFetch & {
  calls: Array<{ url: string; init: RequestInit & { headers?: Record<string, string> } }>;
} {
  const calls: Array<{ url: string; init: RequestInit & { headers?: Record<string, string> } }> = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const request = (init ?? {}) as RequestInit & { headers?: Record<string, string> };
    calls.push({ url, init: request });
    const response = routes[`${request.method ?? "GET"} ${url}`];
    if (!response) throw new Error(`unexpected request ${request.method ?? "GET"} ${url}`);
    return response.clone();
  }) as HttpFetch & {
    calls: Array<{ url: string; init: RequestInit & { headers?: Record<string, string> } }>;
  };
  transport.calls = calls;
  return transport;
}
