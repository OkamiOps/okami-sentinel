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

/**
 * The guard now covers all of `/github/*`, and GitHub's delivery is the one path
 * that must pass without a session, an `Origin` or a token — the HMAC over the raw
 * body is what authenticates it. Naming the exemption in the guard keeps it from
 * depending on the order the routes were registered in.
 */
test("the webhook delivery is the only mutation the guard waves through", async () => {
  const app = new Hono();
  const reached: string[] = [];
  app.use("*", githubIntegrationSecurity());
  app.post("/github/webhook", (c) => { reached.push("webhook"); return c.json({ ok: true }); });
  app.post("/api/github/webhook", (c) => { reached.push("prefixed"); return c.json({ ok: true }); });
  app.post("/github/actions", (c) => { reached.push("actions"); return c.json({ ok: true }); });
  app.get("/github/webhook", (c) => { reached.push("read"); return c.json({ ok: true }); });

  // No cookie, no Origin, no CSRF token, and a host GitHub would never know.
  assert.equal((await app.request("http://evil.example/github/webhook", { method: "POST" })).status, 200);
  // The server runtime mounts the same application under `/api`.
  assert.equal((await app.request("http://evil.example/api/github/webhook", { method: "POST" })).status, 200);
  // Everything else on the same tree still needs the origin and the token.
  assert.equal((await app.request("http://localhost/github/actions", { method: "POST" })).status, 403);
  // The exemption is that one method on that one path, nothing adjacent.
  assert.equal((await app.request("http://evil.example/github/webhook")).status, 403);
  assert.deepEqual(reached, ["webhook", "prefixed"]);
});
