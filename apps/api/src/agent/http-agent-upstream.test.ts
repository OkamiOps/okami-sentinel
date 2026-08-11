import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProviderModel } from "@csb/shared";
import {
  HTTP_AGENT_BODY_LIMIT_BYTES,
  HttpAgentUpstreamError,
  createHttpAgentUpstream,
  createHttpProbeSession,
} from "./http-agent-upstream.js";

test("AgentUpstream resolves the official route on the server and never accepts a wire URL", async () => {
  const transport = transcript([json(200, { id: "response-1", output: [] })]);
  const upstream = createHttpAgentUpstream({
    routeKind: "openai-api",
    protocol: "openai-responses",
    credentials: { apiKey: "openai-secret" },
    transport: transport.fetch,
  });
  const wire = {
    operation: "responses" as const,
    body: { model: "selected-model", input: "probe" },
    signal: new AbortController().signal,
  };

  const response = await upstream.request(wire);

  assert.deepEqual(response, { id: "response-1", output: [] });
  assert.equal("url" in wire, false);
  assert.deepEqual(transport.calls.map((call) => call.url), ["https://api.openai.com/v1/responses"]);
  assert.equal(transport.calls[0]?.init.method, "POST");
  assert.equal(transport.calls[0]?.init.redirect, "error");
  assert.equal(transport.calls[0]?.headers.get("authorization"), "Bearer openai-secret");
  assert.equal(transport.calls[0]?.headers.get("content-type"), "application/json");
});

test("AgentUpstream pins official origins and the documented MiniMax Token Plan header", async () => {
  const cases = [
    ["xai-api", "openai-responses", "responses", "https://api.x.ai/v1/responses", "authorization", "Bearer xai-secret"],
    ["anthropic-api", "anthropic-messages", "messages", "https://api.anthropic.com/v1/messages", "x-api-key", "anthropic-secret"],
    ["openrouter-api", "openai-chat", "chat-completions", "https://openrouter.ai/api/v1/chat/completions", "authorization", "Bearer openrouter-secret"],
    ["gemini-api", "openai-chat", "chat-completions", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", "authorization", "Bearer gemini-secret"],
    ["deepseek-api", "openai-chat", "chat-completions", "https://api.deepseek.com/chat/completions", "authorization", "Bearer deepseek-secret"],
    ["minimax-token-plan", "anthropic-messages", "messages", "https://api.minimax.io/anthropic/v1/messages", "x-api-key", "minimax-secret"],
  ] as const;

  for (const [routeKind, protocol, operation, expectedUrl, header, expectedValue] of cases) {
    const transport = transcript([json(200, {})]);
    const upstream = createHttpAgentUpstream({
      routeKind,
      protocol,
      credentials: {
        apiKey: expectedValue.replace(/^Bearer /, ""),
        baseUrl: "https://ignored.example/never-used",
      },
      transport: transport.fetch,
    });

    await upstream.request({ operation, body: {}, signal: new AbortController().signal });
    assert.equal(transport.calls[0]?.url, expectedUrl);
    assert.equal(transport.calls[0]?.headers.get(header), expectedValue);
    assert.equal(JSON.stringify(transport.calls).includes("ignored.example"), false);
  }
});

test("AgentUpstream validates custom bases and rejects MiMo until its execution contract is provided", async () => {
  const customTransport = transcript([json(200, {})]);
  const custom = createHttpAgentUpstream({
    routeKind: "custom-openai-compatible",
    protocol: "openai-chat",
    credentials: { apiKey: "custom-secret", baseUrl: "https://gateway.example/v1" },
    transport: customTransport.fetch,
  });
  await custom.request({ operation: "chat-completions", body: {}, signal: new AbortController().signal });
  assert.equal(customTransport.calls[0]?.url, "https://gateway.example/v1/chat/completions");

  const insecureTransport = transcript([]);
  const insecure = createHttpAgentUpstream({
    routeKind: "custom-openai-compatible",
    protocol: "openai-chat",
    credentials: { apiKey: "custom-secret", baseUrl: "http://gateway.example/v1", allowInsecureLocalhost: true },
    transport: insecureTransport.fetch,
  });
  await assert.rejects(
    insecure.request({ operation: "chat-completions", body: {}, signal: new AbortController().signal }),
    { code: "protocol_unsupported" },
  );
  assert.deepEqual(insecureTransport.calls, []);

  const mimo = createHttpAgentUpstream({
    routeKind: "mimo-token-plan",
    protocol: "anthropic-messages",
    credentials: { apiKey: "mimo-secret", baseUrl: "https://regional.mimo.example" },
    transport: transcript([]).fetch,
  });
  await assert.rejects(
    mimo.request({ operation: "messages", body: {}, signal: new AbortController().signal }),
    { code: "protocol_unsupported" },
  );
});

test("AgentUpstream maps HTTP statuses to safe errors and does not retain provider diagnostics", async () => {
  const transport = transcript([json(403, { error: { message: "openai-secret diagnostic" } })]);
  const upstream = createHttpAgentUpstream({
    routeKind: "openai-api",
    protocol: "openai-responses",
    credentials: { apiKey: "openai-secret" },
    transport: transport.fetch,
  });

  await assert.rejects(
    upstream.request({ operation: "responses", body: {}, signal: new AbortController().signal }),
    (error: unknown) => {
      assert.equal(error instanceof HttpAgentUpstreamError, true);
      assert.equal((error as HttpAgentUpstreamError).code, "model_access_denied");
      assert.equal(JSON.stringify(error).includes("openai-secret"), false);
      return true;
    },
  );
});

test("AgentUpstream rejects an oversized response before JSON parsing", async () => {
  const upstream = createHttpAgentUpstream({
    routeKind: "openai-api",
    protocol: "openai-responses",
    credentials: { apiKey: "openai-secret" },
    transport: (async () => new Response("x".repeat(HTTP_AGENT_BODY_LIMIT_BYTES + 1))) as typeof fetch,
  });

  await assert.rejects(
    upstream.request({ operation: "responses", body: {}, signal: new AbortController().signal }),
    { code: "protocol_unsupported" },
  );
});

test("AgentUpstream stops locally when a fetch ignores abort and consumes its late rejection", async () => {
  let rejectLate: ((reason?: unknown) => void) | undefined;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  const upstream = createHttpAgentUpstream({
    routeKind: "openai-api",
    protocol: "openai-responses",
    credentials: { apiKey: "openai-secret" },
    transport: (async () => new Promise<Response>((_resolve, reject) => { rejectLate = reject; })) as typeof fetch,
  });
  const controller = new AbortController();
  const pending = upstream.request({ operation: "responses", body: {}, signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, { code: "agent_cancelled" });
  rejectLate?.(new Error("late upstream failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
});

test("AgentUpstream stops locally when a response reader ignores abort", async () => {
  const started = deferred<void>();
  const response = new Response(new ReadableStream<Uint8Array>({
    pull() {
      started.resolve();
      return new Promise(() => undefined);
    },
    cancel() {
      return new Promise(() => undefined);
    },
  }));
  const upstream = createHttpAgentUpstream({
    routeKind: "openai-api",
    protocol: "openai-responses",
    credentials: { apiKey: "openai-secret" },
    transport: (async () => response) as typeof fetch,
  });
  const controller = new AbortController();
  const pending = upstream.request({ operation: "responses", body: {}, signal: controller.signal });
  await started.promise;
  controller.abort();

  await assert.rejects(pending, { code: "agent_cancelled" });
});

test("HttpProbeSession uses the real three protocol loops, records usage, and removes only its private temporary directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "csb-http-probe-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cases = [
    {
      routeKind: "openai-api",
      protocol: "openai-responses" as const,
      expectedUrl: "https://api.openai.com/v1/responses",
      replies: [
        responsesTool("workspace.read", { path: "probe-input.txt" }, "read-1"),
        responsesTool("results.write", { path: "probe.json", content: "{\"ok\":true}" }, "write-1"),
        responsesFinal({ ok: true }),
      ],
    },
    {
      routeKind: "gemini-api",
      protocol: "openai-chat" as const,
      expectedUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      replies: [
        chatTool("workspace.list", { path: "." }, "list-1"),
        chatTool("results.write", { path: "probe.json", content: "{\"ok\":true}" }, "write-1"),
        chatFinal({ ok: true }),
      ],
    },
    {
      routeKind: "anthropic-api",
      protocol: "anthropic-messages" as const,
      expectedUrl: "https://api.anthropic.com/v1/messages",
      replies: [
        anthropicTool("workspace.read", { path: "probe-input.txt" }, "read-1"),
        anthropicTool("results.write", { path: "probe.json", content: "{\"ok\":true}" }, "write-1"),
        anthropicFinal({ ok: true }),
      ],
    },
  ];

  for (const candidate of cases) {
    const transport = transcript(candidate.replies.map((reply) => json(200, reply)));
    const probe = createHttpProbeSession({ transport: transport.fetch, temporaryParent: root });
    const result = await probe({
      connectionId: "connection-a",
      routeKind: candidate.routeKind,
      protocol: candidate.protocol,
      inferencePath: "/untrusted-client-path",
      model: model(candidate.protocol),
      credentials: { apiKey: `${candidate.protocol}-secret` },
    });

    assert.equal(transport.calls[0]?.url, candidate.expectedUrl);
    assert.deepEqual(result.agentLoop, {
      workspaceToolRequested: true,
      workspaceToolResultConsumed: true,
      resultsWriteRequested: true,
      artifactProduced: true,
      structuredResultProduced: true,
    });
    assert.equal(result.capabilities?.usage, "supported");
    assert.equal(JSON.stringify(result).includes(`${candidate.protocol}-secret`), false);
  }

  assert.deepEqual(await readdir(root), []);
});

function model(id: string): ProviderModel {
  return {
    connectionId: "connection-a",
    id,
    displayName: id,
    contextWindow: null,
    capabilities: {
      tools: "unknown", artifactOutput: "unknown", structuredOutput: "unknown", boundedExecution: "unknown",
      osIsolation: "unknown", streaming: "unknown", usage: "unknown", cancellation: "unknown",
    },
    pricing: null,
    discoveredAt: "2026-08-11T00:00:00.000Z",
    source: "provider-api",
  };
}

function transcript(replies: Response[]) {
  const calls: Array<{ url: string; init: RequestInit; headers: Headers }> = [];
  return {
    calls,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const response = replies.shift();
      if (response === undefined) throw new Error("unexpected fetch");
      calls.push({ url: String(url), init: init ?? {}, headers: new Headers(init?.headers) });
      return response;
    }) as typeof fetch,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function responsesTool(name: string, input: Record<string, unknown>, id: string) {
  return { id: `response-${id}`, output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(input) }], usage: { input_tokens: 1, output_tokens: 1 } };
}

function responsesFinal(value: Record<string, unknown>) {
  return { id: "response-final", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }], usage: { input_tokens: 1, output_tokens: 1 } };
}

function chatTool(name: string, input: Record<string, unknown>, id: string) {
  return { choices: [{ message: { tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}

function chatFinal(value: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}

function anthropicTool(name: string, input: Record<string, unknown>, id: string) {
  return { content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 1, output_tokens: 1 } };
}

function anthropicFinal(value: Record<string, unknown>) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], usage: { input_tokens: 1, output_tokens: 1 } };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
