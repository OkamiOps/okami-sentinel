import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { getDb } from "../db.js";
import type { ServerSettings } from "../deployment-settings.js";
import { securitySessionToken } from "../security-session.js";
import { createServerApp } from "../server-app.js";
import { createAuthApi } from "./auth-api.js";
import { createInvite } from "./invite-store.js";
import { hashPassword } from "./passwords.js";
import { createSession, getSessionById } from "./session-store.js";
import { createUser, findUserByUsername, updateUser } from "./user-store.js";

const origin = "https://sentinel.example";
const settings: ServerSettings = {
  // The tests below address the limiter by `X-Forwarded-For`, which only a
  // deployment behind one trusted proxy may believe.
  mode: "server", origin, username: "admin", password: "x".repeat(24), repositoryRoots: [], trustProxy: true,
};

function serverWithAuthApi() {
  const api = new Hono().route("/", createAuthApi({ settings }));
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-auth-web-"));
  return { app: createServerApp(api, { webRoot, settings }), origin };
}

/**
 * Idempotent so a rerun against a persistent data directory still starts from a
 * known password with the account unlocked.
 */
async function seedUser(username: string, password: string): Promise<string> {
  const passwordHash = await hashPassword(password);
  const existing = findUserByUsername(username, getDb());
  if (existing) updateUser(existing.id, { passwordHash, failedAttempts: 0, lockedUntil: null, status: "active" }, getDb());
  else createUser({ username, displayName: username, isAdmin: false, passwordHash }, getDb());
  return username;
}

async function signIn(app: Hono, base: string, username: string, password: string, ip: string): Promise<{ cookie: string; csrf: string }> {
  const response = await app.request(`${base}/api/auth/login`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const session = await (await app.request(`${base}/api/auth/session`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrf: session.csrfToken as string };
}

test("logs in, reads the session, and logs out", async () => {
  const { app, origin } = serverWithAuthApi();
  await seedUser("ana", "ana password 123");
  const login = await app.request(`${origin}/api/auth/login`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Ana", password: "ana password 123" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!;
  assert.match(cookie, /^__Host-sentinel_session=[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  const pair = cookie.split(";")[0]!;
  const session = await (await app.request(`${origin}/api/auth/session`, { headers: { Cookie: pair } })).json();
  assert.equal(session.user.username, "ana");
  assert.equal(session.runtimeMode, "server");
  const logout = await app.request(`${origin}/api/auth/logout`, { method: "POST", headers: { Cookie: pair, Origin: origin, "X-CSRF-Token": session.csrfToken } });
  assert.equal(logout.status, 204);
  assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: pair } })).status, 401);
});

test("returns the lockout contract after five failures", async () => {
  const { app, origin } = serverWithAuthApi();
  const username = await seedUser(`lock${Date.now()}`, "right password 1");
  const attempt = (password: string, ip: string) => app.request(`${origin}/api/auth/login`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ username, password }),
  });
  for (let i = 0; i < 5; i += 1) assert.equal((await attempt("wrong", `10.9.0.${i}`)).status, 401);
  const locked = await attempt("right password 1", "10.9.1.1");
  assert.equal(locked.status, 423);
  assert.deepEqual(await locked.json(), { error: "account_locked", retryAfterSeconds: 900 });
});

test("an invite link can be read once and accepted once", async () => {
  const { app, origin } = serverWithAuthApi();
  const user = createUser({ username: `inv${Date.now()}`, displayName: "Invited", isAdmin: false }, getDb());
  const { token } = createInvite({ userId: user.id, purpose: "invite", createdBy: null }, getDb());
  const peek = await app.request(`${origin}/api/auth/invites/${token}`);
  assert.equal(peek.status, 200);
  assert.equal((await peek.json()).username, user.username);
  const accept = () => app.request(`${origin}/api/auth/invites/${token}`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "a strong password" }),
  });
  const first = await accept();
  assert.equal(first.status, 200);
  assert.match(first.headers.get("set-cookie")!, /^__Host-sentinel_session=/);
  assert.equal((await accept()).status, 404);
});

test("renames the caller and refuses an empty display name", async () => {
  const { app, origin } = serverWithAuthApi();
  const username = await seedUser(`name${Date.now()}`, "profile password 1");
  const { cookie, csrf } = await signIn(app, origin, username, "profile password 1", "10.7.0.1");
  const patch = (displayName: unknown) => app.request(`${origin}/api/account/profile`, {
    method: "PATCH", headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  const renamed = await patch("  Renamed Person  ");
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).displayName, "Renamed Person");
  const empty = await patch("   ");
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: "display_name_invalid" });
});

test("session deletion reaches only the caller's own sessions", async () => {
  const { app, origin } = serverWithAuthApi();
  const username = await seedUser(`revoke${Date.now()}`, "revoke password 1");
  const a = await signIn(app, origin, username, "revoke password 1", "10.6.0.1");
  const b = await signIn(app, origin, username, "revoke password 1", "10.6.0.2");
  const c = await signIn(app, origin, username, "revoke password 1", "10.6.0.3");
  const stranger = createUser({ username: `other${Date.now()}`, displayName: "Other", isAdmin: false }, getDb());
  const strangerSession = createSession({ userId: stranger.id, ip: null, userAgent: null }, getDb()).session;

  const remove = (id: string) => app.request(`${origin}/api/account/sessions/${id}`, {
    method: "DELETE", headers: { Cookie: a.cookie, Origin: origin, "X-CSRF-Token": a.csrf },
  });
  assert.equal((await remove(strangerSession.id)).status, 404);
  assert.equal((await remove("not-a-session-id")).status, 404);
  assert.ok(getSessionById(strangerSession.id), "another user's session must survive");

  const own = await (await app.request(`${origin}/api/account/sessions`, { headers: { Cookie: a.cookie } })).json();
  const target = own.sessions.find((s: { current: boolean }) => !s.current)!;
  assert.equal((await remove(target.id)).status, 204);
  assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: a.cookie } })).status, 200);

  const others = await app.request(`${origin}/api/account/sessions/others`, {
    method: "DELETE", headers: { Cookie: a.cookie, Origin: origin, "X-CSRF-Token": a.csrf },
  });
  assert.equal(others.status, 204);
  assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: a.cookie } })).status, 200);
  for (const stale of [b, c]) {
    assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: stale.cookie } })).status, 401);
  }
  assert.ok(getSessionById(strangerSession.id), "revoking other sessions must not touch another user");
});

test("local mode reports the local principal and hides the account routes", async () => {
  const local: ServerSettings = { mode: "local", origin: null, username: "", password: "", repositoryRoots: [], trustProxy: false };
  const app = new Hono().route("/api", new Hono().route("/", createAuthApi({ settings: local })));
  const session = await (await app.request("http://localhost/api/auth/session")).json();
  assert.deepEqual(session, {
    user: { id: "local", username: "local", displayName: "Local", isAdmin: true },
    grants: [],
    csrfToken: securitySessionToken,
    runtimeMode: "local",
    repositoryRoots: [],
  });
  for (const [method, path] of [["GET", "/api/account/sessions"], ["PATCH", "/api/account/profile"], ["POST", "/api/account/password"], ["DELETE", "/api/account/sessions/others"], ["DELETE", "/api/account/sessions/anything"]] as const) {
    const response = await app.request(`http://localhost${path}`, { method, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});

test("account routes change the password and list only the caller's sessions", async () => {
  const { app, origin } = serverWithAuthApi();
  const username = await seedUser(`acct${Date.now()}`, "account password 1");
  const a = await signIn(app, origin, username, "account password 1", "10.8.0.1");
  const b = await signIn(app, origin, username, "account password 1", "10.8.0.2");
  const sessions = await (await app.request(`${origin}/api/account/sessions`, { headers: { Cookie: a.cookie } })).json();
  assert.equal(sessions.sessions.length, 2);
  assert.equal(sessions.sessions.filter((s: { current: boolean }) => s.current).length, 1);
  const change = await app.request(`${origin}/api/account/password`, {
    method: "POST", headers: { Cookie: a.cookie, Origin: origin, "X-CSRF-Token": a.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: "account password 1", newPassword: "account password 2" }),
  });
  assert.equal(change.status, 204);
  assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: a.cookie } })).status, 200);
  assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: b.cookie } })).status, 401);
});
