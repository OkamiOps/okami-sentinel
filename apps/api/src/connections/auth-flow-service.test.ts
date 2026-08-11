import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectionAuthKind } from "@csb/shared";
import type { StoredProviderConnection } from "../connections-store.js";
import type { RouteAdapter, SafeAuthFlow } from "./route-adapter.js";
import {
  AuthFlowServiceError,
  createAuthFlowService,
} from "./auth-flow-service.js";

function connection(
  routeKind = "openai-chatgpt-app-server",
): StoredProviderConnection {
  return {
    id: "conn-openai",
    scopeId: "local",
    name: "OpenAI subscription",
    providerKind: "openai",
    routeKind,
    transport: "codex-app-server",
    authKind: "device-code",
    protocol: "codex-app-server",
    status: "authentication-required",
    modelSelectionMode: "catalog",
    defaultModelId: null,
    lastTestedAt: null,
    lastModelSyncAt: null,
    modelCatalogStale: false,
    display: {
      providerLabel: "OpenAI",
      routeLabel: "ChatGPT app-server",
      secretConfigured: false,
      endpointConfigured: false,
      endpointKind: null,
    },
    credentialRef: null,
  };
}

function safeFlow(overrides: Partial<SafeAuthFlow> = {}): SafeAuthFlow {
  return {
    flowId: "login-1",
    status: "pending",
    authUrl: null,
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
    expiresAt: null,
    ...overrides,
  };
}

function adapter(overrides: Partial<RouteAdapter> = {}): RouteAdapter {
  return {
    routeKind: "openai-chatgpt-app-server",
    transport: "codex-app-server",
    protocol: "codex-app-server",
    async inspect() {
      return { available: true, reason: null, supportsRuntimeDefault: false };
    },
    async discoverModels() {
      return { models: [], supportsRuntimeDefault: false };
    },
    async probe() {
      throw new Error("not used");
    },
    ...overrides,
  };
}

function registry(
  route: RouteAdapter,
  overrides: Partial<{
    providerKind: string;
    transport: RouteAdapter["transport"];
    protocol: RouteAdapter["protocol"];
    authKinds: readonly ConnectionAuthKind[];
  }> = {},
) {
  return {
    get: (routeKind: string) => routeKind === route.routeKind ? route : undefined,
    getManifest: (routeKind: string) => routeKind === route.routeKind
      ? {
        routeKind: route.routeKind,
        providerKind: "openai",
        transport: route.transport,
        protocol: route.protocol,
        authKinds: ["device-code"] as const,
        ...overrides,
      }
      : undefined,
  };
}

test("OpenAI device flow delegates to the app-server adapter and never retains a token", async () => {
  const calls: Array<{ connectionId: string; mode: string }> = [];
  const appServer = adapter({
    async startAuth(current, mode) {
      calls.push({ connectionId: current.id, mode });
      return {
        ...safeFlow(),
        // A compromised dependency must still not get persisted by the service.
        accessToken: "must-not-leave-codex" as never,
      };
    },
  });
  const service = createAuthFlowService({
    connections: { get: (id) => id === "conn-openai" ? connection() : null },
    routes: registry(appServer),
  });

  const result = await service.start("conn-openai", "device-code");

  assert.deepEqual(calls, [{ connectionId: "conn-openai", mode: "device-code" }]);
  assert.deepEqual(result, safeFlow());
  assert.equal(JSON.stringify(result).includes("must-not-leave-codex"), false);
});

test("auth flow service keeps safe state in memory and delegates cancellation", async () => {
  const cancelled: string[] = [];
  const appServer = adapter({
    async startAuth() {
      return safeFlow();
    },
    async cancelAuth(_connection, flowId) {
      cancelled.push(flowId);
    },
  });
  const service = createAuthFlowService({
    connections: { get: () => connection() },
    routes: registry(appServer),
  });

  await service.start("conn-openai", "device-code");
  await service.cancel("conn-openai", "login-1");

  assert.deepEqual(cancelled, ["login-1"]);
  assert.deepEqual(await service.get("conn-openai", "login-1"), safeFlow({ status: "cancelled" }));
});

test("OpenAI app-server flow derives completion from a fresh safe runtime inspection", async () => {
  const appServer = adapter({
    async startAuth() {
      return safeFlow();
    },
    async inspect() {
      return { available: true, reason: null, supportsRuntimeDefault: false };
    },
  });
  const service = createAuthFlowService({
    connections: { get: () => connection() },
    routes: registry(appServer),
  });

  await service.start("conn-openai", "device-code");

  assert.deepEqual(await service.get("conn-openai", "login-1"), safeFlow({ status: "completed" }));
});

test("auth flow service rejects unsupported routes and redacts dependency failures", async () => {
  const marker = "access-token-not-for-public-output";
  const service = createAuthFlowService({
    connections: { get: () => connection() },
    routes: registry(adapter({
      async startAuth() {
        throw new Error(`provider says Bearer ${marker}`);
      },
    })),
  });

  await assert.rejects(service.start("conn-openai", "device-code"), (error: unknown) => {
    assert.equal(error instanceof AuthFlowServiceError, true);
    assert.equal((error as AuthFlowServiceError).code, "provider_unreachable");
    assert.equal(String(error).includes(marker), false);
    return true;
  });

  const unsupported = createAuthFlowService({
    connections: { get: () => connection() },
    routes: registry(adapter()),
  });
  await assert.rejects(unsupported.start("conn-openai", "browser-oauth"), {
    code: "protocol_unsupported",
  });
});

test("auth flow service rejects an unregistered manifest mismatch before delegating provider auth", async () => {
  let delegated = 0;
  const appServer = adapter({
    async startAuth() {
      delegated += 1;
      return safeFlow();
    },
  });
  const mismatches = [
    { providerKind: "xai" },
    { transport: "local-cli" as const },
    { protocol: "grok-build-cli" as const },
    { authKinds: ["browser-oauth"] as const },
  ];

  for (const manifest of mismatches) {
    const service = createAuthFlowService({
      connections: { get: () => connection() },
      routes: registry(appServer, manifest),
    });
    await assert.rejects(service.start("conn-openai", "device-code"), {
      code: "protocol_unsupported",
    });
  }

  assert.equal(delegated, 0);
});
