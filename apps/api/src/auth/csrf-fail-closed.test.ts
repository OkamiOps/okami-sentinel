import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono, type Context } from "hono";
import { app } from "../app.js";
import { getDb } from "../db.js";
import type { ServerSettings } from "../deployment-settings.js";
import { securitySessionToken, validRequestCsrf } from "../security-session.js";
import { createServerApp } from "../server-app.js";
import { SECURE_SESSION_COOKIE } from "../session-cookie.js";
import { csrfTokenOf, LOCAL_PRINCIPAL } from "./principal.js";
import { createSession } from "./session-store.js";
import { createUser } from "./user-store.js";

const origin = "https://sentinel.example";
const serverSettings: ServerSettings = {
  mode: "server", origin, username: "admin", password: "x".repeat(24), repositoryRoots: ["/repos"], trustProxy: false,
};

/**
 * One mutation behind each of the three guards that call `validRequestCsrf`
 * themselves. Every target is deliberately unresolvable, so a request that
 * survives the guard fails in its handler without reaching Git, a provider or
 * the network.
 */
const GUARDED_MUTATIONS = [
  ["connections", "/connections/no-such-connection/auth/start", {}],
  ["engine updates", "/engine-updates/not-a-runtime/update", { version: "1.0.0" }],
  ["github integration", "/github-checkouts/no-such-repository/fetch", {}],
] as const;

function withServerRuntime<T>(body: () => T): T {
  const previous = { mode: process.env.CSB_RUNTIME_MODE, origin: process.env.CSB_PUBLIC_ORIGIN };
  process.env.CSB_RUNTIME_MODE = "server";
  process.env.CSB_PUBLIC_ORIGIN = origin;
  const restore = () => {
    for (const [key, value] of [["CSB_RUNTIME_MODE", previous.mode], ["CSB_PUBLIC_ORIGIN", previous.origin]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = body();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

/** A principal with no `csrfToken` beside it: the state a server-mode request
 * would be in if it ever reached a guard without a session behind it. */
function withoutSessionCsrf(): Hono {
  const probe = new Hono();
  probe.use("*", async (c, next) => {
    c.set("principal" as never, { ...LOCAL_PRINCIPAL, kind: "user", isAdmin: true } as never);
    await next();
  });
  probe.route("/", app);
  return probe;
}

test("csrfTokenOf never falls back to the process token in server mode", () => {
  const context = {
    get: () => undefined,
    req: { header: () => securitySessionToken },
  } as unknown as Context;

  withServerRuntime(() => {
    const first = csrfTokenOf(context);
    assert.notEqual(first, securitySessionToken);
    assert.notEqual(first, csrfTokenOf(context), "a guessable constant would be as good as no guard");
    assert.equal(validRequestCsrf(context), false);
  });

  // The loopback runtime has no sessions, so the process token stays its CSRF
  // token and local callers keep working exactly as before.
  assert.equal(csrfTokenOf(context), securitySessionToken);
  assert.equal(validRequestCsrf(context), true);
});

test("the process token cannot authorize a server-mode mutation that has no session", () => withServerRuntime(async () => {
  const probe = withoutSessionCsrf();
  for (const [name, target, body] of GUARDED_MUTATIONS) {
    const response = await probe.request(`${origin}${target}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": securitySessionToken },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403, `${name} answered ${response.status}`);
    assert.deepEqual(await response.json(), { error: "csrf_invalid" }, name);
  }
}));

test("a seeded session's own CSRF token is the only one these mutations accept", () => withServerRuntime(async () => {
  const user = createUser({ username: `csrf${Date.now()}`, displayName: "Csrf", isAdmin: false }, getDb());
  const { token, session } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  const probe = new Hono();
  // The session and its CSRF token are real; only the role is pinned, because a
  // stored administrator can be demoted by any concurrent test file.
  probe.use("*", async (c, next) => {
    c.set("principal" as never, {
      ...LOCAL_PRINCIPAL, kind: "user", userId: user.id, sessionId: session.id, isAdmin: true,
    } as never);
    await next();
  });
  probe.route("/", app);
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-csrf-web-"));
  const server = createServerApp(probe, { webRoot, settings: serverSettings });

  const post = (target: string, csrf: string, body: unknown) => server.request(`${origin}/api${target}`, {
    method: "POST",
    headers: { Cookie: `${SECURE_SESSION_COOKIE}=${token}`, Origin: origin, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  for (const [name, target, body] of GUARDED_MUTATIONS) {
    const refused = await post(target, securitySessionToken, body);
    assert.equal(refused.status, 403, `${name} accepted the process token`);
    assert.deepEqual(await refused.json(), { error: "csrf_invalid" }, name);

    const accepted = await post(target, session.csrfToken, body);
    assert.notEqual(accepted.status, 403, `${name} refused its own session token`);
    assert.notEqual((await accepted.json()).error, "csrf_invalid", name);
  }
}));
