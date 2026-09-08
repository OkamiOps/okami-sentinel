import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { createServerApp } from "./server-app.js";
import { loadServerSettings, publicOrigin } from "./deployment-settings.js";
import { securitySessionToken } from "./security-session.js";

const origin = "https://sentinel.example";
const password = "test-admin-secret-never-production-1234";
const auth = { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}` };

test("server protects HTML, API, SSE and mutations while leaving cheap health probes public", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-server-web-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><h1>Sentinel</h1>");
  fs.writeFileSync(path.join(root, "app.js"), "export default 'Sentinel';");
  const api = new Hono();
  api.get("/scans", (c) => c.json({ scans: [] }));
  api.post("/scans", (c) => c.json({ created: true }, 201));
  api.get("/events", () => new Response("event: ready\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  let ready = true;
  const app = createServerApp(api, { webRoot: root, isReady: () => ready, settings: {
    mode: "server", origin, username: "admin", password, repositoryRoots: ["/repos"],
  } });
  try {
    for (const resource of ["/", "/scans/any", "/app.js", "/api/scans", "/api/events"]) {
      assert.equal((await app.request(origin + resource)).status, 401, resource);
    }
    assert.equal((await app.request(origin + "/healthz")).status, 200);
    assert.equal((await app.request(origin + "/readyz")).status, 200);
    const html = await app.request(origin + "/scans/any", { headers: { ...auth, Accept: "text/html" } });
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Sentinel/);
    assert.equal((await app.request(origin + "/missing.js", { headers: { ...auth, Accept: "text/html" } })).status, 404);
    assert.equal((await app.request(origin + "/api/not-found", { headers: { ...auth, Accept: "text/html" } })).status, 404);
    const events = await app.request(origin + "/api/events", { headers: auth });
    assert.match(events.headers.get("Content-Type")!, /text\/event-stream/);
    assert.match(await events.text(), /event: ready/);
    assert.equal((await app.request(origin + "/api/scans", { method: "POST", headers: auth })).status, 403);
    for (const crossOrigin of ["https://attacker.example", "null"]) {
      assert.equal((await app.request(origin + "/api/scans", { method: "POST", headers: { ...auth, Origin: crossOrigin, "X-CSRF-Token": securitySessionToken } })).status, 403);
    }
    assert.equal((await app.request("https://attacker.example/api/scans", { headers: auth })).status, 403);
    assert.equal((await app.request(origin + "/api/scans", { headers: { ...auth, "Sec-Fetch-Site": "same-site" } })).status, 403);
    // Throttling incorrect passwords must never lock out a valid operator.
    for (let attempt = 0; attempt < 31; attempt++) await app.request(origin + "/api/scans");
    assert.equal((await app.request(origin + "/api/scans")).status, 429);
    assert.equal((await app.request(origin + "/api/scans", { headers: auth })).status, 200);
    const allowed = { ...auth, Origin: origin, "X-CSRF-Token": securitySessionToken };
    assert.equal((await app.request(origin + "/api/scans", { method: "POST", headers: allowed })).status, 201);
    ready = false;
    assert.equal((await app.request(origin + "/readyz")).status, 503);
    assert.equal((await app.request(origin + "/api/scans", { method: "POST", headers: allowed })).status, 503);
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

test("server configuration rejects remote HTTP, missing credentials and broad origins", () => {
  assert.throws(() => publicOrigin({ CSB_PUBLIC_ORIGIN: "http://server.example" }));
  assert.throws(() => publicOrigin({ CSB_PUBLIC_ORIGIN: "https://server.example/path" }));
  assert.throws(() => loadServerSettings({ CSB_RUNTIME_MODE: "server", CSB_PUBLIC_ORIGIN: origin }));
  assert.equal(publicOrigin({ CSB_PUBLIC_ORIGIN: "http://127.0.0.1:8787" }), "http://127.0.0.1:8787");
});
