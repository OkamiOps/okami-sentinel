import assert from "node:assert/strict";
import test from "node:test";

import {
  XAI_PUBLIC_OAUTH_PRESET,
  XaiOAuthFlowError,
  createXaiOAuthHttpTransport,
} from "./xai-oauth-flow.js";

test("xAI OAuth transport posts only to pinned auth.x.ai endpoints and strips raw upstream errors", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = createXaiOAuthHttpTransport({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/device/code")) {
        return new Response(JSON.stringify({
          device_code: "private-device-code",
          verification_uri: "https://auth.x.ai/activate",
          verification_uri_complete: "https://auth.x.ai/activate?code=private-device-code",
          user_code: "ABCD-1234",
          expires_in: 900,
          interval: 5,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: "slow_down",
        error_description: "Bearer private-token must never leave the transport",
      }), { status: 400 });
    },
  });

  const device = await transport.requestDeviceCode({
    url: "https://auth.x.ai/oauth2/device/code",
    clientId: XAI_PUBLIC_OAUTH_PRESET.clientId,
    scope: XAI_PUBLIC_OAUTH_PRESET.scopes,
    signal: new AbortController().signal,
  });
  const token = await transport.requestToken({
    url: "https://auth.x.ai/oauth2/token",
    clientId: XAI_PUBLIC_OAUTH_PRESET.clientId,
    grantType: "urn:ietf:params:oauth:grant-type:device_code",
    deviceCode: "private-device-code",
    signal: new AbortController().signal,
  });

  assert.deepEqual(device, {
    deviceCode: "private-device-code",
    verificationUri: "https://auth.x.ai/activate",
    verificationUriComplete: "https://auth.x.ai/activate?code=private-device-code",
    userCode: "ABCD-1234",
    expiresIn: 900,
    interval: 5,
  });
  assert.deepEqual(token, { error: "slow_down" });
  assert.deepEqual(calls.map((call) => call.url), [
    "https://auth.x.ai/oauth2/device/code",
    "https://auth.x.ai/oauth2/token",
  ]);
  assert.equal(calls.every((call) => call.init.method === "POST" && call.init.redirect === "error"), true);
  const deviceBody = new URLSearchParams(String(calls[0]?.init.body));
  assert.equal(deviceBody.get("client_id"), XAI_PUBLIC_OAUTH_PRESET.clientId);
  assert.equal(deviceBody.get("scope"), XAI_PUBLIC_OAUTH_PRESET.scopes);
  assert.equal(JSON.stringify(token).includes("private-token"), false);
});

test("xAI OAuth transport rejects a caller-supplied origin before any request", async () => {
  let calls = 0;
  const transport = createXaiOAuthHttpTransport({
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(transport.requestDeviceCode({
    url: "https://attacker.example/oauth2/device/code" as never,
    clientId: XAI_PUBLIC_OAUTH_PRESET.clientId,
    scope: XAI_PUBLIC_OAUTH_PRESET.scopes,
    signal: new AbortController().signal,
  }), (error: unknown) => {
    assert.equal(error instanceof XaiOAuthFlowError, true);
    assert.equal((error as XaiOAuthFlowError).code, "oauth_metadata_invalid");
    return true;
  });
  assert.equal(calls, 0);
});

test("xAI OAuth transport enforces its deadline when fetch or its body reader ignores AbortSignal", async () => {
  let fetchCalls = 0;
  const ignoredFetch = createXaiOAuthHttpTransport({
    timeoutMs: 5,
    fetch: async () => {
      fetchCalls += 1;
      return new Promise<Response>(() => undefined);
    },
  });

  await assert.rejects(ignoredFetch.requestDeviceCode({
    url: "https://auth.x.ai/oauth2/device/code",
    clientId: XAI_PUBLIC_OAUTH_PRESET.clientId,
    scope: XAI_PUBLIC_OAUTH_PRESET.scopes,
    signal: new AbortController().signal,
  }), { code: "provider_unreachable" });
  assert.equal(fetchCalls, 1);

  let cancelled = false;
  const ignoredReader = createXaiOAuthHttpTransport({
    timeoutMs: 5,
    fetch: async () => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read: async () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
            cancel: async () => {
              cancelled = true;
            },
          };
        },
      },
    }) as Response,
  });

  await assert.rejects(ignoredReader.requestDeviceCode({
    url: "https://auth.x.ai/oauth2/device/code",
    clientId: XAI_PUBLIC_OAUTH_PRESET.clientId,
    scope: XAI_PUBLIC_OAUTH_PRESET.scopes,
    signal: new AbortController().signal,
  }), { code: "provider_unreachable" });
  assert.equal(cancelled, true);
});
