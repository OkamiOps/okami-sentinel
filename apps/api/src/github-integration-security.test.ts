import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { githubIntegrationSecurity } from "./github-integration-security.js";
import { securitySessionToken } from "./security-session.js";

test("GitHub integration local mutations require a same-origin security session", async () => {
  const app = new Hono();
  let writes = 0;
  app.use("*", githubIntegrationSecurity());
  app.get("/", (c) => c.json({ ok: true }));
  app.post("/", (c) => { writes++; return c.json({ ok: true }); });
  assert.equal((await app.request("http://localhost/")).status, 200);
  assert.equal((await app.request("http://evil.example/")).status, 403);
  assert.equal((await app.request("http://localhost/", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await app.request("http://localhost/", { method: "POST" })).status, 403);
  assert.equal((await app.request("http://localhost/", { method: "POST", headers: { Origin: "https://evil.example", "X-CSRF-Token": securitySessionToken } })).status, 403);
  assert.equal(writes, 0);
  assert.equal((await app.request("http://localhost/", { method: "POST", headers: { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": securitySessionToken } })).status, 200);
  assert.equal(writes, 1);
});
