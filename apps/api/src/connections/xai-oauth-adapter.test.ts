import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StoredProviderConnection } from "../connections-store.js";
import { resolveCompatibility } from "./compatibility-resolver.js";
import type { HttpProbeSession } from "./http-route-adapters.js";
import { createHttpProbeSession } from "../agent/http-agent-upstream.js";
import { SecretRedactor } from "../redaction.js";
import {
  createXaiOAuthAdapter,
  type XaiOAuthAdapterFlow,
} from "./xai-oauth-adapter.js";
import { createRouteRegistry } from "./route-registry.js";

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

test("production registry exposes the direct xAI device route only when its adapter is supplied", () => {
  const adapter = createXaiOAuthAdapter({ flow: new FakeXaiFlow() });
  const registry = createRouteRegistry({ xaiOAuth: adapter });

  assert.deepEqual(registry.getManifest("xai-oauth"), {
    routeKind: "xai-oauth",
    providerKind: "xai",
    transport: "http-inference",
    protocol: "xai-oauth-responses",
    authKinds: ["device-code"],
  });
  assert.equal(registry.get("xai-oauth"), adapter);
  assert.equal(registry.get("xai-grok-build-local")?.protocol, "grok-build-cli");
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

test("xAI OAuth probes the exact selected catalog model through the direct bearer route", async () => {
  const flow = new FakeXaiFlow();
  const calls: Array<{ routeKind: string; protocol: string; modelId: string; bearer: string | undefined }> = [];
  const redactor = new SecretRedactor();
  const selected = providerModel("conn-xai", "grok-account-model");
  const probeSession: HttpProbeSession = async (input) => {
    calls.push({
      routeKind: input.routeKind,
      protocol: input.protocol,
      modelId: input.model.id,
      bearer: input.credentials.apiKey,
    });
    assert.equal(redactor.redactText("private-xai-oauth-token"), "[REDACTED]");
    return completeProbeMeasurement();
  };
  const adapter = createXaiOAuthAdapter({
    flow,
    resolveModel: async () => selected,
    probeSession,
    redactor,
    now: () => new Date("2026-08-11T12:00:00.000Z"),
  });
  const selection = {
    connectionId: "conn-xai",
    modelSelectionMode: "catalog" as const,
    modelId: "grok-account-model",
  };

  const report = await adapter.probe(connection(), selection);
  const compatibility = resolveCompatibility({
    engine: "mantis",
    connection: { ...connection(), status: "ready" },
    selection,
    model: selected,
    probe: report,
    now: new Date("2026-08-11T12:00:01.000Z"),
  });

  assert.equal(report.status, "passed");
  assert.equal(report.protocol, "xai-oauth-responses");
  assert.deepEqual(calls, [{
    routeKind: "xai-oauth",
    protocol: "xai-oauth-responses",
    modelId: "grok-account-model",
    bearer: "private-xai-oauth-token",
  }]);
  assert.deepEqual(flow.calls, ["token:conn-xai"]);
  assert.equal(JSON.stringify({ report, compatibility }).includes("private-xai-oauth-token"), false);
  assert.equal(redactor.redactText("private-xai-oauth-token"), "private-xai-oauth-token");
  assert.equal(compatibility.eligible, true);
  assert.equal(compatibility.runnerKind, "agent-session");
});

test("xAI OAuth completes the trusted HTTP probe over only the pinned responses route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "csb-xai-oauth-probe-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const selected = providerModel("conn-xai", "grok-account-model");
  const transport = transcript([
    responseTool("workspace.read", { path: "probe-input.txt" }, "read-1"),
    responseTool("results.write", { path: "probe.json", content: "{\"ok\":true}" }, "write-1"),
    responseFinal({ ok: true }),
  ]);
  const adapter = createXaiOAuthAdapter({
    flow: new FakeXaiFlow(),
    resolveModel: async () => selected,
    probeSession: createHttpProbeSession({ transport: transport.fetch, temporaryParent: root }),
    now: () => new Date("2026-08-11T12:00:00.000Z"),
  });

  const report = await adapter.probe(connection(), {
    connectionId: "conn-xai",
    modelSelectionMode: "catalog",
    modelId: "grok-account-model",
  });

  assert.equal(report.status, "passed");
  assert.equal(report.capabilities.cancellation, "supported");
  assert.equal(report.capabilities.osIsolation, "supported");
  assert.deepEqual(transport.calls.map((call) => call.url), [
    "https://api.x.ai/v1/responses",
    "https://api.x.ai/v1/responses",
    "https://api.x.ai/v1/responses",
  ]);
  assert.equal(transport.calls[0]?.headers.get("authorization"), "Bearer private-xai-oauth-token");
  assert.equal(JSON.stringify(report).includes("private-xai-oauth-token"), false);
});

test("xAI OAuth keeps invalid selections and incomplete direct probes ineligible", async () => {
  const selected = providerModel("conn-xai", "grok-account-model");
  const invalidFlow = new FakeXaiFlow();
  const invalidAdapter = createXaiOAuthAdapter({
    flow: invalidFlow,
    resolveModel: async () => selected,
    probeSession: async () => completeProbeMeasurement(),
    now: () => new Date("2026-08-11T12:00:00.000Z"),
  });
  const invalid = await invalidAdapter.probe(connection(), {
    connectionId: "conn-xai",
    modelSelectionMode: "catalog",
    modelId: "different-model",
  });

  const incompleteFlow = new FakeXaiFlow();
  const incompleteAdapter = createXaiOAuthAdapter({
    flow: incompleteFlow,
    resolveModel: async () => selected,
    probeSession: async () => ({
      capabilities: {
        tools: "supported",
        artifactOutput: "supported",
        structuredOutput: "supported",
        boundedExecution: "supported",
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
        authoritativeDeadlineEnforced: false,
        authoritativeCancellationEnforced: true,
        privatePinnedRootsEnforced: true,
        closedToolSurfaceEnforced: true,
      },
    }),
    now: () => new Date("2026-08-11T12:00:00.000Z"),
  });
  const selection = {
    connectionId: "conn-xai",
    modelSelectionMode: "catalog" as const,
    modelId: "grok-account-model",
  };
  const incomplete = await incompleteAdapter.probe(connection(), selection);
  const compatibility = resolveCompatibility({
    engine: "mantis",
    connection: { ...connection(), status: "ready" },
    selection,
    model: selected,
    probe: incomplete,
    now: new Date("2026-08-11T12:00:01.000Z"),
  });

  assert.equal(invalid.status, "failed");
  assert.equal(invalid.errorCode, "model_access_denied");
  assert.deepEqual(invalidFlow.calls, []);
  assert.equal(incomplete.status, "failed");
  assert.equal(incomplete.errorCode, "protocol_unsupported");
  assert.deepEqual(incompleteFlow.calls, ["token:conn-xai"]);
  assert.equal(compatibility.eligible, false);
  assert.deepEqual(compatibility.reasons, ["capability_probe_failed"]);
});

function providerModel(connectionId: string, id: string) {
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
  const calls: Array<{ url: string; headers: Headers }> = [];
  return {
    calls,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const reply = replies.shift();
      if (reply === undefined) throw new Error("unexpected fetch");
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
