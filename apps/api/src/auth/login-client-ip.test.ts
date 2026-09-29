import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { getDb } from "../db.js";
import type { ServerSettings } from "../deployment-settings.js";
import { createAuthApi, loginBucket } from "./auth-api.js";
import { resetLoginRateLimit } from "./auth-service.js";
import { hashPassword } from "./passwords.js";
import { createServerApp } from "../server-app.js";
import { createUser, findUserByUsername, updateUser } from "./user-store.js";

const origin = "https://sentinel.example";

function settings(trustProxy: boolean): ServerSettings {
  return { mode: "server", origin, username: "admin", password: "x".repeat(24), repositoryRoots: [], trustProxy };
}

function server(trustProxy: boolean): Hono {
  const api = new Hono().route("/", createAuthApi({ settings: settings(trustProxy) }));
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-clientip-web-"));
  return createServerApp(api, { webRoot, settings: settings(trustProxy) });
}

async function seedUser(username: string, password: string): Promise<string> {
  const passwordHash = await hashPassword(password);
  const existing = findUserByUsername(username, getDb());
  if (existing) updateUser(existing.id, { passwordHash, failedAttempts: 0, lockedUntil: null, status: "active" }, getDb());
  else createUser({ username, displayName: username, isAdmin: false, passwordHash }, getDb());
  return username;
}

async function attempt(app: Hono, forwardedFor: string, username: string, password: string): Promise<Response> {
  return await app.request(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
    body: JSON.stringify({ username, password }),
  });
}

test("the limiter bucket ignores a forwarded header unless a proxy is trusted", () => {
  // Untrusted: only the socket peer decides, so the header cannot mint buckets.
  assert.equal(loginBucket("203.0.113.9", "10.1.2.3", false), "10.1.2.3");
  assert.equal(loginBucket("203.0.113.9", null, false), null);
  // Trusted: the rightmost entry is the one the single trusted proxy appended;
  // everything to its left arrived from the caller and stays untrusted.
  assert.equal(loginBucket("203.0.113.9, 198.51.100.7", "10.1.2.3", true), "198.51.100.7");
  assert.equal(loginBucket("198.51.100.7", null, true), "198.51.100.7");
  assert.equal(loginBucket(undefined, "10.1.2.3", true), null);
  assert.equal(loginBucket("   ", "10.1.2.3", true), null);
  assert.equal(loginBucket(`${"9".repeat(200)}`, null, true)?.length, 64);
});

test("a spoofed X-Forwarded-For cannot split the per-IP login limiter", async () => {
  resetLoginRateLimit();
  const username = await seedUser(`spoof${Date.now()}`, "spoof password 1");
  const app = server(false);
  for (let i = 0; i < 30; i += 1) {
    const response = await attempt(app, `203.0.113.${i}`, username, "wrong password");
    // The account locks itself after five failures; both answers still charge
    // the shared bucket, which is the point of the assertion below.
    assert.ok([401, 423].includes(response.status), `attempt ${i} answered ${response.status}`);
  }
  const blocked = await attempt(app, "203.0.113.250", username, "wrong password");
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, "rate_limited");
});

test("a trusted proxy's rightmost entry is the bucket, and the rest is ignored", async () => {
  resetLoginRateLimit();
  const username = await seedUser(`trusted${Date.now()}`, "trusted password 1");
  const app = server(true);
  for (let i = 0; i < 30; i += 1) {
    const response = await attempt(app, `198.51.100.${i}, 203.0.113.7`, username, "wrong password");
    assert.ok([401, 423].includes(response.status), `attempt ${i} answered ${response.status}`);
  }
  // Same rightmost entry, a different spoofed prefix: still the same bucket.
  const blocked = await attempt(app, "10.0.0.1, 203.0.113.7", username, "wrong password");
  assert.equal(blocked.status, 429);
  // A genuinely different proxy-appended address keeps its own budget.
  const other = await attempt(app, "10.0.0.1, 203.0.113.8", username, "wrong password");
  assert.notEqual(other.status, 429);
});

test("the session records the address the trusted proxy appended", async () => {
  resetLoginRateLimit();
  const username = await seedUser(`sessionip${Date.now()}`, "session ip password 1");
  for (const trustProxy of [true, false]) {
    const app = server(trustProxy);
    const login = await attempt(app, "10.0.0.9, 203.0.113.44", username, "session ip password 1");
    assert.equal(login.status, 200, `trustProxy=${trustProxy}`);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const body = await (await app.request(`${origin}/api/account/sessions`, { headers: { Cookie: cookie } })).json();
    const current = (body.sessions as Array<{ ip: string | null; current: boolean }>).find((session) => session.current)!;
    assert.equal(current.ip, trustProxy ? "203.0.113.44" : null);
  }
});
