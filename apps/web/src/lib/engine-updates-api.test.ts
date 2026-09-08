import assert from "node:assert/strict";
import test from "node:test";

import type { EngineUpdatesResponse } from "@csb/shared";

import { createEngineUpdatesClient } from "./engine-updates-api.js";

const response: EngineUpdatesResponse = {
  items: [{
    id: "codex-security",
    name: "Codex Security",
    kind: "cli",
    source: "managed",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    previousVersion: null,
    status: "available",
    checkedAt: "2026-09-08T10:00:00.000Z",
    error: null,
    canUpdate: true,
    canRollback: false,
    sourceUrl: "https://github.com/openai/codex-security",
  }],
  busy: null,
  blockedReason: null,
  lastOperation: null,
};

test("reads update status without a CSRF token", async () => {
  const calls: Array<{ method: string; path: string; csrf: string | null }> = [];
  const client = createEngineUpdatesClient(async (input, init) => {
    const request = new Request(`http://sentinel.local${String(input)}`, init);
    calls.push({ method: request.method, path: new URL(request.url).pathname, csrf: request.headers.get("x-csrf-token") });
    return Response.json(response);
  });

  assert.deepEqual(await client.list(), response);
  assert.deepEqual(calls, [{ method: "GET", path: "/api/engine-updates", csrf: null }]);
});

test("sends exact update actions with one in-memory CSRF token", async () => {
  const calls: Array<{ method: string; path: string; csrf: string | null; body: string }> = [];
  const client = createEngineUpdatesClient(async (input, init) => {
    const request = new Request(`http://sentinel.local${String(input)}`, init);
    const path = new URL(request.url).pathname;
    calls.push({ method: request.method, path, csrf: request.headers.get("x-csrf-token"), body: await request.text() });
    if (path.endsWith("/security-session")) return Response.json({ csrfToken: "browser-only-token" });
    return Response.json(response);
  });

  await client.check();
  await client.update("codex-security", "1.1.0");
  await client.rollback("codex-security");

  assert.deepEqual(calls, [
    { method: "GET", path: "/api/security-session", csrf: null, body: "" },
    { method: "POST", path: "/api/engine-updates/check", csrf: "browser-only-token", body: "{}" },
    { method: "POST", path: "/api/engine-updates/codex-security/update", csrf: "browser-only-token", body: "{\"version\":\"1.1.0\"}" },
    { method: "POST", path: "/api/engine-updates/codex-security/rollback", csrf: "browser-only-token", body: "{}" },
  ]);
});

test("refreshes an invalid CSRF session exactly once for an updater mutation", async () => {
  const calls: Array<{ method: string; path: string; csrf: string | null }> = [];
  let sessions = 0;
  let updates = 0;
  const client = createEngineUpdatesClient(async (input, init) => {
    const request = new Request(`http://sentinel.local${String(input)}`, init);
    const path = new URL(request.url).pathname;
    calls.push({ method: request.method, path, csrf: request.headers.get("x-csrf-token") });
    if (path.endsWith("/security-session")) {
      sessions += 1;
      return Response.json({ csrfToken: sessions === 1 ? "expired" : "fresh" });
    }
    updates += 1;
    if (updates === 1) return Response.json({ error: "csrf_invalid" }, { status: 403 });
    return Response.json(response);
  });

  assert.deepEqual(await client.update("codex-security", "1.1.0"), response);
  assert.deepEqual(calls, [
    { method: "GET", path: "/api/security-session", csrf: null },
    { method: "POST", path: "/api/engine-updates/codex-security/update", csrf: "expired" },
    { method: "GET", path: "/api/security-session", csrf: null },
    { method: "POST", path: "/api/engine-updates/codex-security/update", csrf: "fresh" },
  ]);
});

test("does not retry an updater mutation for a non-CSRF failure", async () => {
  const calls: string[] = [];
  const client = createEngineUpdatesClient(async (input, init) => {
    const request = new Request(`http://sentinel.local${String(input)}`, init);
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    if (path.endsWith("/security-session")) return Response.json({ csrfToken: "valid" });
    return Response.json({ error: "check_required" }, { status: 409 });
  });

  await assert.rejects(client.update("codex-security", "1.1.0"), /check_required/);
  assert.deepEqual(calls, [
    "GET /api/security-session",
    "POST /api/engine-updates/codex-security/update",
  ]);
});
