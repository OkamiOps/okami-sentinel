import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { app } from "../app.js";
import { getDb } from "../db.js";
import type { ServerSettings } from "../deployment-settings.js";
import { createServerApp } from "../server-app.js";
import { SESSION_COOKIE } from "../server-security.js";
import { replaceUserGrants } from "./grant-store.js";
import { authorize, matchPolicy } from "./route-policy.js";
import { createSession } from "./session-store.js";
import { createUser } from "./user-store.js";

test("every registered API route declares a requirement", () => {
  const missing = app.routes
    .filter((route) => route.method !== "ALL" && !route.path.endsWith("*"))
    .map((route) => `${route.method} ${route.path}`)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .filter((entry) => {
      const [method, routePath] = entry.split(" ") as [string, string];
      return matchPolicy(method, routePath.replaceAll(/:([A-Za-z]+)/g, "x"))?.requirement === undefined;
    });
  assert.deepEqual(missing, []);
});

test("literal segments win over parameters", () => {
  assert.equal(matchPolicy("GET", "/scans/active")?.requirement.kind, "scoped");
  assert.deepEqual(matchPolicy("GET", "/scans/abc")?.params, { id: "abc" });
  assert.equal(matchPolicy("GET", "/nope"), null);
  assert.equal(matchPolicy("DELETE", "/account/sessions/others")?.requirement.kind, "authenticated");
  assert.equal(matchPolicy("POST", "/scans/abc"), null);
  assert.equal(matchPolicy("GET", "/scans/abc/"), null);
  assert.equal(matchPolicy("GET", "/connections/security-session")?.requirement.kind, "authenticated");
  assert.equal(matchPolicy("GET", "/connections/abc")?.requirement.kind, "admin");
});

test("path segments are decoded exactly once and bad encoding never matches", () => {
  assert.deepEqual(matchPolicy("GET", "/github-checkouts/local%2Fone")?.params, { repositoryKey: "local/one" });
  assert.deepEqual(matchPolicy("GET", "/github-checkouts/local%252Fone")?.params, { repositoryKey: "local%2Fone" });
  assert.equal(matchPolicy("GET", "/github-checkouts/%ZZ"), null);
  // An encoded separator stays inside one segment, so it cannot forge extra
  // ones, and the captured value is what the handler will read back.
  assert.deepEqual(matchPolicy("GET", "/scans/a%2Fb/report")?.params, { id: "a/b" });
  assert.equal(matchPolicy("GET", "/scans/a/b/report"), null);
});

test("the matcher captures the same repository key the handler will read", async () => {
  const probe = new Hono();
  probe.use("*", async (c, next) => {
    c.set("matched" as never, matchPolicy(c.req.method, c.req.path)?.params.repositoryKey as never);
    await next();
  });
  probe.get("/github-checkouts/:repositoryKey", (c) => c.json({
    matched: c.get("matched" as never) as string | undefined,
    handler: c.req.param("repositoryKey"),
  }));
  for (const raw of ["local%2Fone", "github%3A1", "local%252Fone", "plain"]) {
    const body = await (await probe.request(`/github-checkouts/${raw}`)).json();
    assert.equal(body.matched, body.handler, `mismatch for ${raw}`);
  }
});

test("a route absent from the policy table is denied", async () => {
  const probe = new Hono();
  probe.use("*", authorize());
  probe.get("/__policy_probe", (c) => c.json({ reached: true }));
  const response = await probe.request("/__policy_probe");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

const origin = "https://sentinel.example";
const serverSettings: ServerSettings = {
  mode: "server", origin, username: "admin", password: "x".repeat(24), repositoryRoots: [],
};

function seedRepository(key: string): void {
  getDb().prepare(`INSERT OR IGNORE INTO guardrail_repositories
    (repository_key, repository_path, source, display_name, default_branch, default_executor, enabled, policy_path, created_at, updated_at)
    VALUES (?, ?, 'local', ?, 'main', 'sentinel-managed', 1, '.csb/guardrails.json', 'now', 'now')`)
    .run(key, `/repos/${key.replaceAll(/[^A-Za-z0-9]/g, "-")}`, key);
}

function seedRun(id: string, repositoryKey: string): void {
  const now = new Date().toISOString();
  getDb().prepare(`INSERT OR REPLACE INTO runs
    (id, display_name, scan_dir, status, source, repository_key, created_at, updated_at)
    VALUES (?, ?, ?, 'completed', 'native', ?, ?, ?)`)
    .run(id, id, path.join(os.tmpdir(), `csb-policy-${id}`), repositoryKey, now, now);
}

function member(name: string, grants: Array<{ repositoryKey: string; role: "viewer" | "analyst" | "operator" | "maintainer" }>) {
  const user = createUser({ username: name, displayName: name, isAdmin: false }, getDb());
  replaceUserGrants(user.id, grants, null, getDb());
  const { token, session } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  return { cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrfToken };
}

test("the HTTP role matrix decides in server mode", async () => {
  const stamp = Date.now();
  const repoA = `policy-a-${stamp}`;
  const repoB = `policy-b-${stamp}`;
  seedRepository(repoA);
  seedRepository(repoB);
  const runA = `policy-run-a-${stamp}`;
  const runB = `policy-run-b-${stamp}`;
  seedRun(runA, repoA);
  seedRun(runB, repoB);
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-policy-web-"));
  const server = createServerApp(app, { webRoot, settings: serverSettings });
  const viewer = member(`policyviewer${stamp}`, [{ repositoryKey: repoA, role: "viewer" }]);
  const analyst = member(`policyanalyst${stamp}`, [{ repositoryKey: repoA, role: "analyst" }]);
  const maintainer = member(`policymaint${stamp}`, [{ repositoryKey: repoA, role: "maintainer" }]);

  const read = (actor: { cookie: string }, target: string) =>
    server.request(`${origin}${target}`, { headers: { Cookie: actor.cookie, Origin: origin } });
  const write = (actor: { cookie: string; csrf: string }, target: string, method = "POST", body: unknown = {}) =>
    server.request(`${origin}${target}`, {
      method,
      headers: { Cookie: actor.cookie, Origin: origin, "X-CSRF-Token": actor.csrf, "Content-Type": "application/json" },
      body: method === "DELETE" ? undefined : JSON.stringify(body),
    });

  assert.equal((await read(viewer, `/api/scans/${runA}`)).status, 200);
  const invisible = await read(viewer, `/api/scans/${runB}`);
  assert.equal(invisible.status, 404);
  assert.deepEqual(await invisible.json(), { error: "not_found" });
  const unknownRun = await read(viewer, "/api/scans/does-not-exist");
  assert.equal(unknownRun.status, 404);
  assert.deepEqual(await unknownRun.json(), { error: "not_found" });

  const viewerTriage = await write(viewer, `/api/scans/${runA}/findings/f1/triage`, "POST", { status: "confirmed" });
  assert.equal(viewerTriage.status, 403);
  assert.deepEqual(await viewerTriage.json(), { error: "forbidden" });
  const viewerDelete = await write(viewer, `/api/scans/${runA}`, "DELETE");
  assert.equal(viewerDelete.status, 403);
  assert.deepEqual(await viewerDelete.json(), { error: "forbidden" });
  for (const target of ["/api/users", "/api/connections"]) {
    const response = await read(viewer, target);
    assert.equal(response.status, 403, target);
    assert.deepEqual(await response.json(), { error: "forbidden" }, target);
  }
  const viewerStart = await write(viewer, "/api/scans", "POST", { repositoryPath: "/tmp" });
  assert.equal(viewerStart.status, 403);
  assert.deepEqual(await viewerStart.json(), { error: "forbidden" });

  // Authorization lets the analyst through; the handler owns the unknown finding.
  const analystTriage = await write(analyst, `/api/scans/${runA}/findings/f1/triage`, "POST", { status: "confirmed" });
  assert.ok(![401, 403].includes(analystTriage.status), `analyst triage status ${analystTriage.status}`);
  assert.notDeepEqual(await analystTriage.json(), { error: "forbidden" });

  const maintainerDelete = await write(maintainer, `/api/scans/${runB}`, "DELETE");
  assert.equal(maintainerDelete.status, 404);
  assert.deepEqual(await maintainerDelete.json(), { error: "not_found" });

  // Authenticated and scoped routes stay reachable for a plain member.
  assert.equal((await read(viewer, "/api/auth/session")).status, 200);
  assert.equal((await read(viewer, "/api/scans")).status, 200);

  // A HEAD probe is decided with the GET requirement, never waved through.
  const headUsers = await server.request(`${origin}/api/users`, { method: "HEAD", headers: { Cookie: viewer.cookie, Origin: origin } });
  assert.equal(headUsers.status, 403);
  const headScan = await server.request(`${origin}/api/scans/${runB}`, { method: "HEAD", headers: { Cookie: viewer.cookie, Origin: origin } });
  assert.equal(headScan.status, 404);

  // No session at all still authenticates before it authorizes.
  const anonymous = await server.request(`${origin}/api/scans`, { headers: { Origin: origin } });
  assert.equal(anonymous.status, 401);

  // Public routes need neither a session nor a policy exemption downstream.
  assert.equal((await server.request(`${origin}/healthz`)).status, 200);
});
