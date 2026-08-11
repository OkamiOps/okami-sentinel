import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import type { ConnectionSecretBundle, CredentialVault } from "./credentials/credential-vault.js";
import type { XaiOAuthCredentialStore, XaiOAuthTransport } from "./connections/xai-oauth-flow.js";
import { createProviderRuntime } from "./provider-runtime.js";

class MemoryVault implements CredentialVault {
  readonly values = new Map<string, ConnectionSecretBundle>();
  async available() { return { available: true, backend: "keychain" as const }; }
  async put(ref: string, value: ConnectionSecretBundle) { this.values.set(ref, structuredClone(value)); }
  async get(ref: string) { return structuredClone(this.values.get(ref)!); }
  async delete(ref: string) { this.values.delete(ref); }
}

class MemoryOAuthStore implements XaiOAuthCredentialStore {
  get() { return Promise.resolve(null); }
  put() { return Promise.resolve(); }
  delete() { return Promise.resolve(); }
}

const oauthTransport: XaiOAuthTransport = {
  requestDeviceCode: async () => ({
    deviceCode: "private-device-code",
    verificationUri: "https://auth.x.ai/activate",
    userCode: "XAI-ABCD",
    expiresIn: 600,
  }),
  requestToken: async () => ({ error: "authorization_pending" }),
  revoke: async () => undefined,
};

test("one runtime composes connection metadata, direct OAuth, catalogs, and scan snapshots", async () => {
  const database = new Database(":memory:");
  try {
    const runtime = createProviderRuntime({
      database,
      vault: new MemoryVault(),
      xaiCredentialStore: new MemoryOAuthStore(),
      xaiTransport: oauthTransport,
      oauthSleep: (_milliseconds, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    const connection = await runtime.connections.create({
      name: "xAI subscription",
      providerKind: "xai",
      routeKind: "xai-oauth",
      transport: "http-inference",
      authKind: "device-code",
      protocol: "xai-oauth-responses",
      modelSelectionMode: "catalog",
    });

    const flow = await runtime.authFlows.start(connection.id, "device-code");
    assert.equal(flow.verificationUrl, "https://auth.x.ai/activate");
    assert.equal(flow.userCode, "XAI-ABCD");
    assert.equal(JSON.stringify(flow).includes("private-device-code"), false);
    assert.equal(runtime.routes.get("xai-oauth")?.protocol, "xai-oauth-responses");
    assert.equal(runtime.store.get(connection.id)?.routeKind, "xai-oauth");

    await runtime.authFlows.cancel(connection.id, flow.flowId);
  } finally {
    database.close();
  }
});

test("the provider runtime supplies a real HTTP probe session when no override is injected", async () => {
  const database = new Database(":memory:");
  const transport = transcript([
    responseTool("workspace.read", { path: "probe-input.txt" }, "read-1"),
    responseTool("results.write", { path: "probe.json", content: "{\"ok\":true}" }, "write-1"),
    responseFinal({ ok: true }),
  ]);
  try {
    const runtime = createProviderRuntime({
      database,
      vault: new MemoryVault(),
      xaiCredentialStore: new MemoryOAuthStore(),
      routeDependencies: { http: { transport: transport.fetch } },
    });
    const connection = await runtime.connections.create({
      name: "OpenAI API",
      providerKind: "openai",
      routeKind: "openai-api",
      transport: "http-inference",
      authKind: "api-key",
      protocol: "openai-responses",
      modelSelectionMode: "catalog",
      secret: { apiKey: "openai-private-probe-token" },
    });
    runtime.store.replaceModels(connection.id, [model(connection.id, "account-model")]);

    const result = await runtime.connections.probe(connection.id, {
      connectionId: connection.id,
      modelSelectionMode: "catalog",
      modelId: "account-model",
    });

    assert.equal(result?.report.status, "passed");
    assert.equal(result?.report.capabilities.tools, "supported");
    assert.deepEqual(transport.calls.map((call) => call.url), [
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses",
    ]);
    assert.equal(JSON.stringify(result).includes("openai-private-probe-token"), false);
  } finally {
    database.close();
  }
});

test("the provider runtime retains an injected HTTP probe session", async () => {
  const database = new Database(":memory:");
  const observed: string[] = [];
  try {
    const runtime = createProviderRuntime({
      database,
      vault: new MemoryVault(),
      xaiCredentialStore: new MemoryOAuthStore(),
      routeDependencies: {
        http: {
          probeSession: async (input) => {
            observed.push(input.model.id);
            return completeProbeMeasurement();
          },
        },
      },
    });
    const connection = await runtime.connections.create({
      name: "OpenAI API override",
      providerKind: "openai",
      routeKind: "openai-api",
      transport: "http-inference",
      authKind: "api-key",
      protocol: "openai-responses",
      modelSelectionMode: "catalog",
      secret: { apiKey: "openai-private-override-token" },
    });
    runtime.store.replaceModels(connection.id, [model(connection.id, "override-model")]);

    const result = await runtime.connections.probe(connection.id, {
      connectionId: connection.id,
      modelSelectionMode: "catalog",
      modelId: "override-model",
    });

    assert.equal(result?.report.status, "passed");
    assert.deepEqual(observed, ["override-model"]);
  } finally {
    database.close();
  }
});

function model(connectionId: string, id: string) {
  return {
    connectionId,
    id,
    displayName: id,
    contextWindow: null,
    capabilities: {
      tools: "unknown" as const,
      artifactOutput: "unknown" as const,
      structuredOutput: "unknown" as const,
      boundedExecution: "unknown" as const,
      osIsolation: "unknown" as const,
      streaming: "unknown" as const,
      usage: "unknown" as const,
      cancellation: "unknown" as const,
    },
    pricing: null,
    discoveredAt: "2026-08-11T12:00:00.000Z",
    source: "provider-api" as const,
  };
}

function completeProbeMeasurement() {
  return {
    capabilities: {
      tools: "supported" as const,
      artifactOutput: "supported" as const,
      structuredOutput: "supported" as const,
      boundedExecution: "supported" as const,
      usage: "supported" as const,
    },
    limitsEnforced: true,
    agentLoop: {
      workspaceToolRequested: true,
      workspaceToolResultConsumed: true,
      resultsWriteRequested: true,
      artifactProduced: true,
      structuredResultProduced: true,
    },
    runtimeEvidence: {
      authoritativeDeadlineEnforced: true,
      authoritativeCancellationEnforced: true,
      privatePinnedRootsEnforced: true,
      closedToolSurfaceEnforced: true,
    },
  };
}

function transcript(replies: unknown[]) {
  const calls: Array<{ url: string }> = [];
  return {
    calls,
    fetch: (async (url: string | URL | Request) => {
      const reply = replies.shift();
      if (reply === undefined) throw new Error("unexpected fetch");
      calls.push({ url: String(url) });
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  };
}

function responseTool(name: string, input: Record<string, unknown>, id: string) {
  return {
    id: `response-${id}`,
    output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(input) }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function responseFinal(value: Record<string, unknown>) {
  return {
    id: "response-final",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}
