import assert from "node:assert/strict";
import test from "node:test";

import type { CreateProviderConnectionRequest, ProviderConnection } from "@csb/shared";

import { createConnectionsClient, createScanRoutingClient } from "../api.js";

const connection: ProviderConnection = {
  id: "conn-1",
  scopeId: "local",
  name: "Custom inference",
  providerKind: "custom",
  routeKind: "openai-compatible",
  transport: "http-inference",
  authKind: "api-key",
  protocol: "openai-chat",
  status: "ready",
  modelSelectionMode: "catalog",
  defaultModelId: null,
  lastTestedAt: null,
  lastModelSyncAt: null,
  modelCatalogStale: false,
  display: {
    providerLabel: "Custom",
    routeLabel: "OpenAI compatible",
    secretConfigured: true,
    endpointConfigured: true,
    endpointKind: "custom",
  },
};

test("acquires one in-memory csrf token before connection writes", async () => {
  const calls: Array<{ path: string; method: string; headers: Headers; body: string | null }> = [];
  const client = createConnectionsClient(async (input, init) => {
    const request = new Request(`http://sentinel.local${String(input)}`, init);
    calls.push({
      path: new URL(request.url).pathname,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    });
    if (request.url.endsWith("/security-session")) return Response.json({ csrfToken: "memory-only-token" });
    return Response.json({ connection });
  });
  const body: CreateProviderConnectionRequest = {
    name: "Custom inference",
    providerKind: "custom",
    routeKind: "openai-compatible",
    transport: "http-inference",
    authKind: "api-key",
    protocol: "openai-chat",
    modelSelectionMode: "catalog",
    secret: { apiKey: "entered-now" },
  };

  await client.create(body);
  await client.update("conn-1", { name: "Renamed" });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    "GET /api/connections/security-session",
    "POST /api/connections",
    "PATCH /api/connections/conn-1",
  ]);
  assert.equal(calls[1].headers.get("x-csrf-token"), "memory-only-token");
  assert.equal(calls[2].headers.get("x-csrf-token"), "memory-only-token");
  assert.equal(calls[1].body?.includes("credentialRef"), false);
});

test("accepts an empty 204 response after deleting a connection", async () => {
  const calls: string[] = [];
  const client = createConnectionsClient(async (input, init) => {
    const path = new URL(String(input), "http://sentinel.local").pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/security-session")) return Response.json({ csrfToken: "memory-only-token" });
    return new Response(null, { status: 204 });
  });

  await client.remove("conn-1");
  assert.deepEqual(calls, [
    "GET /api/connections/security-session",
    "DELETE /api/connections/conn-1",
  ]);
});

test("lists provider connection read models without asking for csrf", async () => {
  const calls: string[] = [];
  const client = createConnectionsClient(async (input) => {
    calls.push(new URL(String(input), "http://sentinel.local").pathname);
    return Response.json({ connections: [connection] });
  });

  assert.deepEqual(await client.list(), [connection]);
  assert.deepEqual(calls, ["/api/connections"]);
});

test("uses the same csrf session for auth mutations while polling flow state without it", async () => {
  const calls: Array<{ method: string; path: string; csrf: string | null }> = [];
  const client = createConnectionsClient(async (input, init) => {
    const request = new Request(`http://sentinel.local${String(input)}`, init);
    const path = new URL(request.url).pathname;
    calls.push({ method: request.method, path, csrf: request.headers.get("x-csrf-token") });
    if (path.endsWith("/security-session")) return Response.json({ csrfToken: "auth-csrf" });
    if (path.endsWith("/auth/start") || path.endsWith("/auth/flow-1")) {
      return Response.json({
        flow: {
          flowId: "flow-1",
          status: path.endsWith("/auth/start") ? "pending" : "completed",
          authUrl: null,
          verificationUrl: "https://auth.x.ai/activate",
          userCode: "XAI-ABCD",
          expiresAt: null,
        },
      }, { status: path.endsWith("/auth/start") ? 201 : 200 });
    }
    if (path.endsWith("/disconnect")) return Response.json({ result: { status: "revoked" } });
    return Response.json({ ok: true });
  });

  const started = await client.startAuth("conn-1", "device-code");
  const current = await client.getAuth("conn-1", started.flowId);
  await client.cancelAuth("conn-1", started.flowId);
  const disconnected = await client.disconnectAuth("conn-1");

  assert.equal(current.status, "completed");
  assert.equal(disconnected.status, "revoked");
  assert.deepEqual(calls, [
    { method: "GET", path: "/api/connections/security-session", csrf: null },
    { method: "POST", path: "/api/connections/conn-1/auth/start", csrf: "auth-csrf" },
    { method: "GET", path: "/api/connections/conn-1/auth/flow-1", csrf: null },
    { method: "POST", path: "/api/connections/conn-1/auth/flow-1/cancel", csrf: "auth-csrf" },
    { method: "POST", path: "/api/connections/conn-1/auth/disconnect", csrf: "auth-csrf" },
  ]);
});

test("asks the server to resolve engine compatibility from a connection selection", async () => {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const client = createScanRoutingClient(async (input, init) => {
    const request = new Request(`http://sentinel.local${String(input)}`, init);
    calls.push({ method: request.method, path: new URL(request.url).pathname, body: await request.text() });
    return Response.json({
      connectionId: "conn-1",
      modelSelectionMode: "catalog",
      modelId: "live-model",
      eligible: true,
      reasons: [],
    });
  });

  const result = await client.resolveCompatibility({
    engine: "mantis",
    selection: { connectionId: "conn-1", modelSelectionMode: "catalog", modelId: "live-model" },
    remoteRepositoryConfirmed: true,
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(calls, [{
    method: "POST",
    path: "/api/connections/compatibility",
    body: JSON.stringify({
      engine: "mantis",
      selection: { connectionId: "conn-1", modelSelectionMode: "catalog", modelId: "live-model" },
      remoteRepositoryConfirmed: true,
    }),
  }]);
});
