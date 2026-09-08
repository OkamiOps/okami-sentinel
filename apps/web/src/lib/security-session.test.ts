import assert from "node:assert/strict";
import test from "node:test";

import { createSecuritySessionClient, isUnderRepositoryRoot } from "./security-session.js";

test("accepts only path-segment descendants of configured repository roots", () => {
  const roots = ["/repos/team-a", "/repos/team-b/"];
  assert.equal(isUnderRepositoryRoot("/repos/team-a", roots), true);
  assert.equal(isUnderRepositoryRoot("/repos/team-a/project", roots), true);
  assert.equal(isUnderRepositoryRoot("/repos/team-a-copy", roots), false);
  assert.equal(isUnderRepositoryRoot("/repos/team-b/project", roots), true);
  assert.equal(isUnderRepositoryRoot("/private/project", roots), false);
});

test("keeps one in-memory session for API mutations and exposes server roots", async () => {
  const calls: Array<{ url: string; method: string; csrf: string | null }> = [];
  const client = createSecuritySessionClient(async (input, init) => {
    const inputUrl = String(input);
    const request = new Request(inputUrl.startsWith("/") ? `http://sentinel.local${inputUrl}` : inputUrl, init);
    calls.push({ url: request.url, method: request.method, csrf: request.headers.get("x-csrf-token") });
    if (request.url === "http://sentinel.local/api/security-session") {
      return Response.json({
        csrfToken: "session-token",
        runtimeMode: "server",
        repositoryRoots: ["/repos/team-a", "/repos/team-b"],
      });
    }
    return Response.json({ ok: true });
  });

  const session = await client.get();
  await client.request("/api/scans", { method: "POST" });
  await client.request("/api/guardrails/gates", { method: "POST" });

  assert.deepEqual(session, {
    csrfToken: "session-token",
    runtimeMode: "server",
    repositoryRoots: ["/repos/team-a", "/repos/team-b"],
  });
  assert.deepEqual(calls, [
    { url: "http://sentinel.local/api/security-session", method: "GET", csrf: null },
    { url: "http://sentinel.local/api/scans", method: "POST", csrf: "session-token" },
    { url: "http://sentinel.local/api/guardrails/gates", method: "POST", csrf: "session-token" },
  ]);
});

test("does not alter an external provider request", async () => {
  const calls: Array<{ url: string; csrf: string | null; authorization: string | null }> = [];
  const client = createSecuritySessionClient(async (input, init) => {
    const inputUrl = String(input);
    const request = new Request(inputUrl.startsWith("/") ? `http://sentinel.local${inputUrl}` : inputUrl, init);
    calls.push({
      url: request.url,
      csrf: request.headers.get("x-csrf-token"),
      authorization: request.headers.get("authorization"),
    });
    return Response.json({ ok: true });
  });

  await client.request("https://provider.example/v1/models", {
    method: "POST",
    headers: { Authorization: "Bearer provider-token" },
  });

  assert.deepEqual(calls, [{
    url: "https://provider.example/v1/models",
    csrf: null,
    authorization: "Bearer provider-token",
  }]);
});
