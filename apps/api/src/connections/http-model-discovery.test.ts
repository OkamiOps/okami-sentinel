import assert from "node:assert/strict";
import test from "node:test";

import {
  HTTP_RESPONSE_LIMIT_BYTES,
  discoverGeminiModels,
  discoverOpenAiModels,
  discoverOpenRouterModels,
  safeFetchJson,
  type HttpFetch,
} from "./http-model-discovery.js";

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("normalizes only models returned by the authenticated endpoint", async () => {
  const transport = fakeFetch({
    "GET https://gateway.example/v1/models": json(200, {
      data: [{ id: "team/model-a", owned_by: "team" }],
    }),
  });

  const result = await discoverOpenAiModels({
    baseUrl: "https://gateway.example/v1",
    headers: { Authorization: "Bearer secret-value" },
  }, transport);

  assert.deepEqual(result.models.map((model) => model.id), ["team/model-a"]);
  assert.equal(result.models[0]?.displayName, "team/model-a");
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  assert.equal(result.models.some((model) => model.id === "fallbackModel"), false);
});

test("uses documented cursor pagination without accepting a provider-supplied URL", async () => {
  const transport = fakeFetch({
    "GET https://gateway.example/v1/models": json(200, {
      data: [{ id: "first" }],
      has_more: true,
      last_id: "first",
      next: "https://attacker.example/models",
    }),
    "GET https://gateway.example/v1/models?after=first": json(200, {
      data: [{ id: "second" }],
      has_more: false,
    }),
  });

  const result = await discoverOpenAiModels({
    baseUrl: "https://gateway.example/v1",
    apiKey: "secret-value",
  }, transport);

  assert.deepEqual(result.models.map((model) => model.id), ["first", "second"]);
  assert.deepEqual(transport.calls.map((call) => call.url), [
    "https://gateway.example/v1/models",
    "https://gateway.example/v1/models?after=first",
  ]);
});

test("safe HTTP fetch disables redirects and returns only a safe error", async () => {
  const transport = fakeFetch({
    "GET https://gateway.example/models?token=query-secret": json(403, { error: "query-secret" }),
  });

  const result = await safeFetchJson({
    url: "https://gateway.example/models?token=query-secret",
    headers: { Authorization: "Bearer header-secret" },
    transport,
  });

  assert.deepEqual(result, { safeError: { code: "endpoint_access_denied" } });
  assert.equal(transport.calls[0]?.init.redirect, "error");
  assert.equal(transport.calls[0]?.init.signal instanceof AbortSignal, true);
  assert.equal(JSON.stringify(result).includes("query-secret"), false);
  assert.equal(JSON.stringify(result).includes("header-secret"), false);
});

test("safe HTTP fetch rejects remote HTTP and response bodies over one MiB", async () => {
  const insecure = await safeFetchJson({
    url: "http://gateway.example/models",
    transport: fakeFetch({}),
  });
  assert.deepEqual(insecure, { safeError: { code: "protocol_unsupported" } });

  const tooLarge = await safeFetchJson({
    url: "https://gateway.example/models",
    transport: fakeFetch({
      "GET https://gateway.example/models": new Response(
        "x".repeat(HTTP_RESPONSE_LIMIT_BYTES + 1),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    }),
  });
  assert.deepEqual(tooLarge, { safeError: { code: "protocol_unsupported" } });

  const local = await safeFetchJson({
    url: "http://localhost:7331/models",
    allowInsecureLocalhost: true,
    transport: fakeFetch({
      "GET http://localhost:7331/models": json(200, { data: [] }),
    }),
  });
  assert.deepEqual(local, { data: { data: [] } });
});

test("Gemini discovers only API-returned OpenAI-compatible models with its inference auth", async () => {
  const transport = fakeFetch({
    "GET https://generativelanguage.googleapis.com/v1beta/openai/models": json(200, {
      object: "list",
      data: [{ id: "account-visible", context_window: 128000 }],
    }),
  });

  const result = await discoverGeminiModels({
    connectionId: "conn-gemini",
    apiKey: "gemini-secret",
  }, transport);

  assert.deepEqual(result.models.map((model) => model.id), ["account-visible"]);
  assert.equal(result.models[0]?.contextWindow, 128000);
  assert.equal(result.models[0]?.capabilities.tools, "unknown");
  assert.deepEqual(transport.calls.map((call) => call.url), [
    "https://generativelanguage.googleapis.com/v1beta/openai/models",
  ]);
  assert.equal(transport.calls[0]?.init.headers?.Authorization, "Bearer gemini-secret");
  assert.equal(transport.calls[0]?.init.headers?.["x-goog-api-key"], undefined);
  assert.equal(JSON.stringify(result).includes("gemini-secret"), false);
});

test("OpenRouter keeps reported pricing and parameters as unverified hints", async () => {
  const result = await discoverOpenRouterModels({ apiKey: "router-secret" }, fakeFetch({
    "GET https://openrouter.ai/api/v1/models": json(200, {
      data: [{
        id: "vendor/account-visible",
        name: "Account visible",
        context_length: 65536,
        supported_parameters: ["tools", "response_format"],
        pricing: { prompt: "0.000001", input_cache_read: "0.00000025", completion: "0.000002" },
      }],
    }),
  }));

  const model = result.models[0];
  assert.equal(model?.pricing?.inputUsdPerMillionTokens, 1);
  assert.equal(model?.pricing?.cachedInputUsdPerMillionTokens, 0.25);
  assert.equal(model?.pricing?.outputUsdPerMillionTokens, 2);
  assert.deepEqual(model?.unverifiedHints?.supportedParameters, ["tools", "response_format"]);
  assert.equal(model?.capabilities.tools, "unknown");
  assert.equal(JSON.stringify(result).includes("router-secret"), false);
});

test("rejects or redacts catalog fields that echo a registered header secret", async () => {
  const syntheticHeaderSecret = "synthetic-header-secret";
  const result = await discoverOpenRouterModels({
    headers: { "X-Workspace-Token": syntheticHeaderSecret },
  }, fakeFetch({
    "GET https://openrouter.ai/api/v1/models": json(200, {
      data: [
        { id: syntheticHeaderSecret, name: "must be rejected" },
        {
          id: "account-visible",
          name: `Visible ${syntheticHeaderSecret}`,
          supported_parameters: ["tools", syntheticHeaderSecret],
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
        {
          id: "body-visible",
          name: "Visible synthetic-body-secret",
          supported_parameters: ["tools", "synthetic-body-secret"],
          response_metadata: { api_key: "synthetic-body-secret" },
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      ],
    }),
  }));

  assert.deepEqual(result.models.map((model) => model.id), ["account-visible", "body-visible"]);
  assert.equal(result.models.every((model) => !model.displayName.includes(syntheticHeaderSecret)), true);
  assert.equal(result.models.every((model) => !model.displayName.includes("synthetic-body-secret")), true);
  assert.deepEqual(
    result.models.map((model) => model.unverifiedHints?.supportedParameters),
    [["tools"], ["tools"]],
  );
  assert.equal(JSON.stringify(result).includes(syntheticHeaderSecret), false);
  assert.equal(JSON.stringify(result).includes("synthetic-body-secret"), false);
});

test("rejects a catalog identifier that echoes a discovery URL query secret", async () => {
  const querySecret = "synthetic-query-secret";
  const result = await discoverOpenAiModels({
    discoveryUrl: `https://gateway.example/v1/models?token=${querySecret}`,
  }, fakeFetch({
    [`GET https://gateway.example/v1/models?token=${querySecret}`]: json(200, {
      data: [{ id: querySecret }, { id: "account-visible" }],
    }),
  }));

  assert.deepEqual(result.models.map((model) => model.id), ["account-visible"]);
  assert.equal(JSON.stringify(result).includes(querySecret), false);
});

test("maps credential and rate errors without retaining provider body or custom headers", async () => {
  for (const [status, code] of [
    [401, "credential_rejected"],
    [429, "rate_limited"],
  ] as const) {
    const result = await safeFetchJson({
      url: `https://gateway.example/models?secret=query-secret-${status}`,
      headers: { "X-Custom-Auth": `header-secret-${status}` },
      transport: fakeFetch({
        [`GET https://gateway.example/models?secret=query-secret-${status}`]: json(status, {
          error: `header-secret-${status}`,
        }),
      }),
    });
    assert.deepEqual(result, { safeError: { code } });
    assert.equal(JSON.stringify(result).includes(`query-secret-${status}`), false);
    assert.equal(JSON.stringify(result).includes(`header-secret-${status}`), false);
  }
});

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
