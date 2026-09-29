import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { createServerApp } from "./server-app.js";
import { loadServerSettings, publicOrigin, type ServerSettings } from "./deployment-settings.js";
import { securitySessionToken } from "./security-session.js";
import { getDb } from "./db.js";
import { createUser } from "./auth/user-store.js";
import { hashPassword } from "./auth/passwords.js";
import { createSession, revokeUserSessions } from "./auth/session-store.js";
import { newToken } from "./auth/tokens.js";

const origin = "https://sentinel.example";
const password = "test-admin-secret-never-production-1234";
const auth = { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}` };
const serverSettings = (): ServerSettings => ({
  mode: "server", origin, username: "admin", password, repositoryRoots: ["/repos"], trustProxy: false,
});

async function sessionCookie(isAdmin = true): Promise<{ cookie: string; csrf: string; userId: string }> {
  const user = createUser({
    username: `u${Math.random().toString(36).slice(2, 10)}`,
    displayName: "T",
    isAdmin,
    passwordHash: await hashPassword("test password 1234"),
  }, getDb());
  const { token, session } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  return { cookie: `__Host-sentinel_session=${token}`, csrf: session.csrfToken, userId: user.id };
}

test("server serves the SPA publicly but requires a session for the API", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-server-web-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><h1>Sentinel</h1>");
  fs.writeFileSync(path.join(root, "app.js"), "export default 'Sentinel';");
  const api = new Hono();
  api.get("/scans", (c) => c.json({ scans: [] }));
  api.post("/scans", (c) => c.json({ created: true }, 201));
  api.get("/events", () => new Response("event: ready\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  let ready = true;
  const app = createServerApp(api, { webRoot: root, isReady: () => ready, settings: serverSettings() });
  try {
    // The login screen must render before anybody holds a session.
    assert.equal((await app.request(origin + "/")).status, 200);
    assert.equal((await app.request(origin + "/app.js")).status, 200);
    const html = await app.request(origin + "/scans/any", { headers: { Accept: "text/html" } });
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Sentinel/);
    assert.equal((await app.request(origin + "/missing.js", { headers: { Accept: "text/html" } })).status, 404);
    for (const resource of ["/api/scans", "/api/events", "/api/auth/session"]) {
      const response = await app.request(origin + resource);
      assert.equal(response.status, 401, resource);
      assert.deepEqual(await response.json(), { error: "authentication_required" });
    }
    assert.equal((await app.request(origin + "/healthz")).status, 200);
    assert.equal((await app.request(origin + "/readyz")).status, 200);

    const { cookie, csrf } = await sessionCookie();
    assert.equal((await app.request(origin + "/api/scans", { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await app.request(origin + "/api/not-found", { headers: { Cookie: cookie, Accept: "text/html" } })).status, 404);
    const events = await app.request(origin + "/api/events", { headers: { Cookie: cookie } });
    assert.match(events.headers.get("Content-Type")!, /text\/event-stream/);
    assert.match(await events.text(), /event: ready/);

    // A session alone never authorises a mutation: only its own CSRF token does.
    const csrfFailures: Record<string, string>[] = [
      { Cookie: cookie, Origin: origin },
      { Cookie: cookie, Origin: origin, "X-CSRF-Token": securitySessionToken },
      { Cookie: cookie, Origin: origin, "X-CSRF-Token": (await sessionCookie()).csrf },
    ];
    for (const headers of csrfFailures) {
      const response = await app.request(origin + "/api/scans", { method: "POST", headers });
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.deepEqual(await response.json(), { error: "csrf_invalid" });
    }
    for (const crossOrigin of ["https://attacker.example", "null"]) {
      assert.equal((await app.request(origin + "/api/scans", {
        method: "POST", headers: { Cookie: cookie, Origin: crossOrigin, "X-CSRF-Token": csrf },
      })).status, 403);
    }
    assert.equal((await app.request("https://attacker.example/api/scans", { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await app.request(origin + "/api/scans", { headers: { Cookie: cookie, "Sec-Fetch-Site": "same-site" } })).status, 403);
    // HTTP Basic is no longer a credential anywhere in server mode.
    assert.equal((await app.request(origin + "/api/scans", { headers: auth })).status, 401);
    assert.equal((await app.request(origin + "/api/scans", {
      method: "POST", headers: { ...auth, Origin: origin, "X-CSRF-Token": securitySessionToken },
    })).status, 401);

    const allowed = { Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf };
    assert.equal((await app.request(origin + "/api/scans", { method: "POST", headers: allowed })).status, 201);
    ready = false;
    assert.equal((await app.request(origin + "/readyz")).status, 503);
    assert.equal((await app.request(origin + "/api/scans", { method: "POST", headers: allowed })).status, 503);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("login and invite acceptance are public but refuse foreign origins", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-server-public-"));
  const api = new Hono();
  api.post("/auth/login", (c) => c.json({ ok: true }));
  api.get("/auth/invites/:token", (c) => c.json({ invite: c.req.param("token") }));
  api.post("/auth/invites/:token", (c) => c.json({ accepted: true }));
  const app = createServerApp(api, { webRoot: root, settings: serverSettings() });
  try {
    assert.equal((await app.request(origin + "/api/auth/login", {
      method: "POST", headers: { Origin: "https://evil.example" },
    })).status, 403);
    assert.equal((await app.request(origin + "/api/auth/login", { method: "POST" })).status, 403);
    assert.equal((await app.request(origin + "/api/auth/login", {
      method: "POST", headers: { Origin: origin },
    })).status, 200);

    const invite = newToken();
    assert.equal((await app.request(`${origin}/api/auth/invites/${invite}`)).status, 200);
    assert.equal((await app.request(`${origin}/api/auth/invites/${invite}`, {
      method: "POST", headers: { Origin: origin },
    })).status, 200);
    assert.equal((await app.request(`${origin}/api/auth/invites/${invite}`, { method: "POST" })).status, 403);
    // Only the exact invite-token shape is public; nothing else under /auth is.
    assert.equal((await app.request(`${origin}/api/auth/invites/${invite}/extra`)).status, 401);
    assert.equal((await app.request(`${origin}/api/auth/invites/short`)).status, 401);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a revoked session is refused on the next request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-server-revoked-"));
  const api = new Hono().get("/scans", (c) => c.json({ scans: [] }));
  const app = createServerApp(api, { webRoot: root, settings: serverSettings() });
  try {
    const { cookie, userId } = await sessionCookie();
    assert.equal((await app.request(origin + "/api/scans", { headers: { Cookie: cookie } })).status, 200);
    revokeUserSessions(userId, null, getDb());
    const response = await app.request(origin + "/api/scans", { headers: { Cookie: cookie } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "authentication_required" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("local production wrapper retains direct API paths and /api for compiled frontend", async () => {
  const api = new Hono().get("/scans", (c) => c.json({ scans: [] }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-local-web-"));
  try {
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><h1>Local Sentinel</h1>");
    const server = createServerApp(api, { webRoot: root, settings: loadServerSettings({ CSB_RUNTIME_MODE: "local" }) });
    for (const url of ["http://localhost/scans", "http://localhost/api/scans"]) assert.deepEqual(await (await server.request(url)).json(), { scans: [] });
    const html = await server.request("http://localhost/scans/example", { headers: { Accept: "text/html" } });
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Local Sentinel/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("local wrapper protects every mutation from foreign browser origins while retaining tokenized CLI and callback flows", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-local-security-web-"));
  let writes = 0;
  const api = new Hono();
  api.post("/scans", (c) => {
    writes += 1;
    return c.json({ created: true }, 201);
  });
  // GitHub redirects to this GET route after the signed flow state is checked
  // by the handler itself. It is not a browser mutation.
  api.get("/guardrails/github-app/manifest/callback", (c) => c.json({ callback: true }));
  try {
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><h1>Local Sentinel</h1>");
    const server = createServerApp(api, {
      webRoot: root,
      settings: loadServerSettings({ CSB_RUNTIME_MODE: "local" }),
    });
    const local = "http://127.0.0.1:8787";
    const withToken = { "X-CSRF-Token": securitySessionToken };

    const foreign = await server.request(`${local}/api/scans`, {
      method: "POST",
      headers: { ...withToken, Origin: "https://attacker.example", "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(foreign.status, 403);
    assert.deepEqual(await foreign.json(), { error: "origin_denied" });
    assert.equal(writes, 0);

    const missingToken = await server.request(`${local}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(missingToken.status, 403);
    assert.deepEqual(await missingToken.json(), { error: "csrf_invalid" });
    assert.equal(writes, 0);

    // Non-browser automation has no Origin header, but still needs the
    // process-local token. The Vite frontend remains a valid browser caller.
    assert.equal((await server.request(`${local}/api/scans`, { method: "POST", headers: withToken, body: "{}" })).status, 201);
    assert.equal((await server.request(`${local}/api/scans`, {
      method: "POST",
      headers: { ...withToken, Origin: "http://localhost:5173" }, body: "{}",
    })).status, 201);
    assert.equal(writes, 2);

    assert.equal((await server.request(`${local}/api/guardrails/github-app/manifest/callback`, {
      headers: { Origin: "https://github.com" },
    })).status, 200);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("server configuration rejects remote HTTP, missing credentials and broad origins", () => {
  assert.throws(() => publicOrigin({ CSB_PUBLIC_ORIGIN: "http://server.example" }));
  assert.throws(() => publicOrigin({ CSB_PUBLIC_ORIGIN: "https://server.example/path" }));
  assert.throws(() => loadServerSettings({ CSB_RUNTIME_MODE: "server", CSB_PUBLIC_ORIGIN: origin }));
  assert.equal(publicOrigin({ CSB_PUBLIC_ORIGIN: "http://127.0.0.1:8787" }), "http://127.0.0.1:8787");
});

test("local wrapper rejects foreign Host on reads before exposing API, session or HTML", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-local-host-"));
  const api = new Hono();
  api.get("/scans", (c) => c.json({ scans: [] }));
  api.get("/security-session", (c) => c.json({ csrfToken: securitySessionToken }));
  try {
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><h1>Local Sentinel</h1>");
    const app = createServerApp(api, { webRoot: root, settings: loadServerSettings({ CSB_RUNTIME_MODE: "local" }) });
    for (const resource of ["/", "/api/scans", "/api/security-session"]) {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        assert.equal((await app.request(`http://untrusted.example${resource}`, { method })).status, 403);
        assert.equal((await app.request(`http://localhost${resource}`, {
          method, headers: { Host: "untrusted.example" },
        })).status, 403);
      }
    }
    for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) {
      assert.equal((await app.request(`http://${host}/api/security-session`, { headers: { Host: host } })).status, 200);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
