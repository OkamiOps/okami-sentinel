import assert from "node:assert/strict";
import test from "node:test";

import type { CreateProviderConnectionRequest, ProviderConnection } from "@csb/shared";

import { createConnectionsClient } from "../api.js";

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
    if (request.url.endsWith("/csrf")) return Response.json({ csrfToken: "memory-only-token" });
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
    "GET /api/connections/csrf",
    "POST /api/connections",
    "PATCH /api/connections/conn-1",
  ]);
  assert.equal(calls[1].headers.get("x-csrf-token"), "memory-only-token");
  assert.equal(calls[2].headers.get("x-csrf-token"), "memory-only-token");
  assert.equal(calls[1].body?.includes("credentialRef"), false);
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
