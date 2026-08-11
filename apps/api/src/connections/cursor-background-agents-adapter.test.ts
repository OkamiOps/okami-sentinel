import assert from "node:assert/strict";
import test from "node:test";

import {
  CURSOR_CLOUD_AGENTS_ORIGIN,
  createCursorBackgroundAgentsAdapter,
  type CursorBackgroundFetch,
} from "./cursor-background-agents-adapter.js";
import type { CursorBackgroundAgentCreateInput } from "./remote-agent-job-runner.js";

test("Cursor Background creates a v1 cloud agent with the selected catalog model and no fallback", async () => {
  const transport = fakeFetch({
    "POST https://api.cursor.com/v1/agents": json(200, {
      agent: { id: "bc-agent-1", status: "ACTIVE" },
      run: { id: "run-1", status: "CREATING" },
    }),
  });
  const adapter = createCursorBackgroundAgentsAdapter({ transport });

  const input: CursorBackgroundAgentCreateInput & { modelId: string } = {
    repositoryUrl: "https://github.com/acme/repository",
    branch: "main",
    instructions: "Review the repository.",
    modelId: "account-visible",
    apiKey: "cursor-secret",
    signal: new AbortController().signal,
  };
  const result = await adapter.create(input);

  assert.equal(CURSOR_CLOUD_AGENTS_ORIGIN, "https://api.cursor.com");
  assert.deepEqual(result, { agentId: "bc-agent-1", runId: "run-1", status: "queued" });
  assert.equal(transport.calls.length, 1);
  const createCall = transport.calls[0];
  assert.deepEqual({
    url: createCall?.url,
    init: {
      method: createCall?.init.method,
      redirect: createCall?.init.redirect,
      headers: createCall?.init.headers,
      body: createCall?.init.body,
    },
  }, {
    url: "https://api.cursor.com/v1/agents",
    init: {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer cursor-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: { text: "Review the repository." },
        repos: [{ url: "https://github.com/acme/repository", startingRef: "main" }],
        model: { id: "account-visible" },
      }),
    },
  });
  assert.equal(createCall?.init.signal instanceof AbortSignal, true);
  assert.equal(String(transport.calls[0]?.init.body).includes("cursor-default"), false);
  assert.equal(JSON.stringify(result).includes("cursor-secret"), false);
});

test("Cursor Background refuses a create request without an explicit selected model before the network", async () => {
  const transport = fakeFetch({});
  const adapter = createCursorBackgroundAgentsAdapter({ transport });
  const input = {
    repositoryUrl: "https://github.com/acme/repository",
    branch: "main",
    instructions: "Review the repository.",
    apiKey: "cursor-secret",
    signal: new AbortController().signal,
  } as unknown as CursorBackgroundAgentCreateInput;

  await assert.rejects(
    adapter.create(input),
    (error: unknown) => typeof error === "object" && error !== null &&
      (error as { code?: unknown }).code === "protocol_unsupported",
  );

  assert.deepEqual(transport.calls, []);
});

test("Cursor Background reads run state and cancels only through the documented v1 endpoints", async () => {
  const transport = fakeFetch({
    "GET https://api.cursor.com/v1/agents/bc-agent-1/runs/run-1": json(200, {
      id: "run-1",
      agentId: "bc-agent-1",
      status: "RUNNING",
    }),
    "POST https://api.cursor.com/v1/agents/bc-agent-1/runs/run-1/cancel": json(200, {
      id: "run-1",
    }),
  });
  const adapter = createCursorBackgroundAgentsAdapter({ transport });

  const status = await adapter.status({
    agentId: "bc-agent-1",
    runId: "run-1",
    apiKey: "cursor-secret",
  });
  await adapter.cancel({ agentId: "bc-agent-1", runId: "run-1", apiKey: "cursor-secret" });

  assert.deepEqual(status, { status: "running", terminal: false });
  assert.deepEqual(transport.calls.map((call) => ({ url: call.url, method: call.init.method })), [
    { url: "https://api.cursor.com/v1/agents/bc-agent-1/runs/run-1", method: "GET" },
    { url: "https://api.cursor.com/v1/agents/bc-agent-1/runs/run-1/cancel", method: "POST" },
  ]);
  assert.equal(transport.calls.every((call) => call.init.redirect === "error"), true);
  assert.equal(JSON.stringify(status).includes("cursor-secret"), false);
});

test("Cursor Background normalizes only models returned by the authenticated v1 catalog", async () => {
  const transport = fakeFetch({
    "GET https://api.cursor.com/v1/models": json(200, {
      items: [
        { id: "account-visible", displayName: "Account Visible" },
        { id: "another-visible" },
      ],
    }),
  });
  const adapter = createCursorBackgroundAgentsAdapter({ transport });

  const models = await adapter.listModels({ apiKey: "cursor-secret" });

  assert.deepEqual(models, [
    { id: "account-visible", displayName: "Account Visible" },
    { id: "another-visible", displayName: "another-visible" },
  ]);
  assert.equal(JSON.stringify(models).includes("cursor-secret"), false);
  assert.equal(models.some((model) => model.id === "cursor-default"), false);
});

test("Cursor Background rejects a v1 catalog response that echoes the bearer credential", async () => {
  const transport = fakeFetch({
    "GET https://api.cursor.com/v1/models": json(200, {
      items: [{ id: "cursor-secret", displayName: "cursor-secret" }],
    }),
  });
  const adapter = createCursorBackgroundAgentsAdapter({ transport });

  await assert.rejects(
    adapter.listModels({ apiKey: "cursor-secret" }),
    (error: unknown) => typeof error === "object" && error !== null &&
      (error as { code?: unknown }).code === "protocol_unsupported",
  );
});

test("Cursor Background never exposes a bearer echoed as reasoning metadata", async () => {
  const transport = fakeFetch({
    "GET https://api.cursor.com/v1/models": json(200, {
      items: [{
        id: "account-visible",
        displayName: "Account Visible",
        supported_reasoning_efforts: ["low", "cursor-secret"],
        default_reasoning_effort: "cursor-secret",
      }],
    }),
  });
  const adapter = createCursorBackgroundAgentsAdapter({ transport });

  const models = await adapter.listModels({ apiKey: "cursor-secret" });

  assert.deepEqual(models, [{ id: "account-visible", displayName: "Account Visible" }]);
  assert.equal(JSON.stringify(models).includes("cursor-secret"), false);
});

test("Cursor Background adapter rejects repository credentials before making its fixed-origin request", async () => {
  const transport = fakeFetch({});
  const adapter = createCursorBackgroundAgentsAdapter({ transport });

  await assert.rejects(
    adapter.create({
      repositoryUrl: "https://token@github.com/acme/repository",
      branch: "main",
      instructions: "Review the repository.",
      modelId: "account-visible",
      apiKey: "cursor-secret",
      signal: new AbortController().signal,
    }),
    (error: unknown) => typeof error === "object" && error !== null &&
      (error as { code?: unknown }).code === "protocol_unsupported",
  );

  assert.deepEqual(transport.calls, []);
});

test("Cursor Background returns within its deadline when a transport ignores abort", async () => {
  const transport: CursorBackgroundFetch = async () => new Promise<Response>(() => {});
  const adapter = createCursorBackgroundAgentsAdapter({ transport, timeoutMs: 5 });

  const outcome = await settleWithin(
    adapter.listModels({ apiKey: "cursor-secret" }),
    80,
  );

  assert.equal(outcome, "provider_unreachable");
});

test("Cursor Background returns within its deadline when a response body ignores abort", async () => {
  let cancelled = false;
  const transport: CursorBackgroundFetch = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
        cancel: async () => {
          cancelled = true;
        },
        releaseLock() {},
      }),
    },
  }) as unknown as Response;
  const adapter = createCursorBackgroundAgentsAdapter({ transport, timeoutMs: 5 });

  const outcome = await settleWithin(
    adapter.listModels({ apiKey: "cursor-secret" }),
    80,
  );

  assert.equal(outcome, "provider_unreachable");
  assert.equal(cancelled, true);
});

test("Cursor Background preserves a cancel race as a safe run_not_cancellable signal", async () => {
  const transport = fakeFetch({
    "POST https://api.cursor.com/v1/agents/bc-agent-1/runs/run-1/cancel": json(409, {}),
  });
  const adapter = createCursorBackgroundAgentsAdapter({ transport });

  await assert.rejects(
    adapter.cancel({ agentId: "bc-agent-1", runId: "run-1", apiKey: "cursor-secret" }),
    (error: unknown) => typeof error === "object" && error !== null &&
      (error as { code?: unknown }).code === "run_not_cancellable",
  );
});

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(routes: Record<string, Response>): CursorBackgroundFetch & {
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const response = routes[`${init.method ?? "GET"} ${url}`];
    if (response === undefined) throw new Error(`Unexpected route: ${init.method ?? "GET"} ${url}`);
    return response.clone();
  }) as CursorBackgroundFetch & { calls: Array<{ url: string; init: RequestInit }> };
  transport.calls = calls;
  return transport;
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<string> {
  return Promise.race([
    promise.then(
      () => "resolved",
      (error: unknown) => typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "rejected",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("test_timeout"), timeoutMs)),
  ]);
}
