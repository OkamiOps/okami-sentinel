import assert from "node:assert/strict";
import test from "node:test";

import type { StoredProviderConnection } from "../connections-store.js";
import {
  createXaiOAuthAdapter,
  type XaiOAuthAdapterFlow,
} from "./xai-oauth-adapter.js";

function connection(): StoredProviderConnection {
  return {
    id: "conn-xai",
    scopeId: "local",
    name: "xAI subscription",
    providerKind: "xai",
    routeKind: "xai-oauth",
    transport: "http-inference",
    authKind: "device-code",
    protocol: "xai-oauth-responses",
    status: "authentication-required",
    modelSelectionMode: "catalog",
    defaultModelId: null,
    lastTestedAt: null,
    lastModelSyncAt: null,
    modelCatalogStale: false,
    display: {
      providerLabel: "xAI",
      routeLabel: "xAI OAuth",
      secretConfigured: true,
      endpointConfigured: true,
      endpointKind: "preset",
    },
    credentialRef: "connection/conn-xai",
  };
}

class FakeXaiFlow implements XaiOAuthAdapterFlow {
  readonly calls: string[] = [];
  readonly executedCommands: string[] = [];
  readonly readPaths: string[] = [];

  async start(connectionId: string) {
    this.calls.push(`start:${connectionId}`);
    return {
      flowId: "xai-flow-1",
      status: "pending-device" as const,
      verificationUrl: "https://auth.x.ai/activate",
      userCode: "XAI-1234",
      expiresAt: "2026-08-11T01:00:00.000Z",
      accessToken: "must-not-leave-flow" as never,
    };
  }

  get() {
    return null;
  }

  async cancel(connectionId: string, flowId: string) {
    this.calls.push(`cancel:${connectionId}:${flowId}`);
  }

  async credentialStatus(): Promise<"ready" | "authentication-required" | "expired"> {
    return "ready" as const;
  }

  async getAccessToken(connectionId: string) {
    this.calls.push(`token:${connectionId}`);
    return "private-xai-oauth-token";
  }

  async disconnect(connectionId: string) {
    this.calls.push(`disconnect:${connectionId}`);
    return "revoked" as const;
  }
}

test("xAI OAuth adapter is device-only, direct, and has no Grok Build dependency", async () => {
  const flow = new FakeXaiFlow();
  const discoveredWith: string[] = [];
  const adapter = createXaiOAuthAdapter({
    flow,
    discover: async (_connection, accessToken) => {
      discoveredWith.push(accessToken);
      return {
        models: [{
          connectionId: "conn-xai",
          id: "upstream-selected-model",
          displayName: "Upstream selected model",
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
          source: "provider-api" as const,
        }],
        supportsRuntimeDefault: false as const,
      };
    },
  });

  const started = await adapter.startAuth?.(connection(), "device-code");
  const models = await adapter.discoverModels(connection());

  assert.deepEqual({
    routeKind: adapter.routeKind,
    transport: adapter.transport,
    protocol: adapter.protocol,
  }, {
    routeKind: "xai-oauth",
    transport: "http-inference",
    protocol: "xai-oauth-responses",
  });
  assert.deepEqual(started, {
    flowId: "xai-flow-1",
    status: "pending",
    authUrl: null,
    verificationUrl: "https://auth.x.ai/activate",
    userCode: "XAI-1234",
    expiresAt: "2026-08-11T01:00:00.000Z",
  });
  assert.deepEqual(models.models.map((model) => model.id), ["upstream-selected-model"]);
  assert.deepEqual(discoveredWith, ["private-xai-oauth-token"]);
  assert.equal(JSON.stringify({ started, models }).includes("private-xai-oauth-token"), false);
  assert.equal(JSON.stringify({ started, models }).includes("must-not-leave-flow"), false);
  assert.deepEqual(flow.executedCommands, []);
  assert.deepEqual(flow.readPaths, []);
  assert.deepEqual(flow.calls, ["start:conn-xai", "token:conn-xai"]);

  await assert.rejects(adapter.startAuth(connection(), "browser-oauth"), {
    code: "protocol_unsupported",
  });
});

test("xAI OAuth adapter maps expired credentials and disconnects without returning a bearer", async () => {
  const flow = new FakeXaiFlow();
  flow.credentialStatus = async () => "expired";
  const adapter = createXaiOAuthAdapter({ flow });

  assert.deepEqual(await adapter.inspect(connection()), {
    available: false,
    reason: "credential_expired",
    supportsRuntimeDefault: false,
  });
  assert.deepEqual(await adapter.disconnectAuth?.(connection()), { status: "revoked" });
  assert.deepEqual(flow.calls, ["disconnect:conn-xai"]);
});

test("xAI model discovery has an authoritative deadline when its transport ignores abort", async () => {
  const adapter = createXaiOAuthAdapter({
    flow: new FakeXaiFlow(),
    transport: async () => new Promise<Response>(() => undefined),
  });

  const result = await Promise.race([
    adapter.discoverModels(connection()),
    delay(8_250).then(() => "timed-out" as const),
  ]);

  assert.notEqual(result, "timed-out");
  assert.deepEqual(result, {
    models: [],
    supportsRuntimeDefault: false,
    safeError: { code: "provider_unreachable" },
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
