import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { GuardrailRepository } from "@csb/shared";
import { app, createGuardrailsApp, type GuardrailsApiDependencies } from "../app.js";
import { getDb } from "../db.js";
import type { ServerSettings } from "../deployment-settings.js";
import { createServerApp } from "../server-app.js";
import { SECURE_SESSION_COOKIE } from "../session-cookie.js";
import { replaceUserGrants } from "./grant-store.js";
import { LOCAL_PRINCIPAL } from "./principal.js";
import { createGitHubAction } from "../github-actions/store.js";
import { ROUTE_POLICY, authorize, matchPolicy } from "./route-policy.js";
import { createSession } from "./session-store.js";
import { createUser } from "./user-store.js";

test("every registered API route declares a requirement", () => {
  const missing = app.routes
    .filter((route) => route.method !== "ALL" && !route.path.endsWith("*"))
    .map((route) => `${route.method} ${route.path}`)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .filter((entry) => {
      const [method, routePath] = entry.split(" ") as [string, string];
      // Any parameter name Hono accepts, so a future `:userId2` or `:user_id`
      // route is still normalized instead of silently escaping the check.
      return matchPolicy(method, routePath.replaceAll(/:([A-Za-z0-9_]+)/g, "x"))?.requirement === undefined;
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

/**
 * The poller's routes are gone with it. Nothing answers `/github-monitor/*` any
 * more, and nothing in the policy claims to: task 1.5 introduces `/github/*`
 * with its own rows and its own tests.
 */
test("no route of the removed monitor survives in the policy", () => {
  assert.deepEqual(
    ROUTE_POLICY.filter(([, pattern]) => pattern.startsWith("/github-monitor")),
    [],
  );
  for (const method of ["GET", "POST", "PATCH"]) {
    assert.equal(matchPolicy(method, "/github-monitor/rules"), null, method);
  }
  assert.equal(matchPolicy("POST", "/github-monitor/poll"), null);
  assert.equal(matchPolicy("GET", "/github-monitor/overview"), null);
});

test("the webhook is the only public route that mutates state", () => {
  const publicMutations = ROUTE_POLICY.filter(([method, , requirement]) =>
    requirement.kind === "public" && !["GET", "HEAD", "OPTIONS"].includes(method));
  assert.deepEqual(publicMutations.map(([method, pattern]) => `${method} ${pattern}`).sort(), [
    "POST /auth/invites/:token", "POST /auth/login", "POST /github/webhook",
  ]);
  assert.equal(matchPolicy("POST", "/github/webhook")?.requirement.kind, "public");
  // The HMAC is the authentication, so no session-bearing method may share the path.
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    assert.equal(matchPolicy(method, "/github/webhook"), null, method);
  }
});

/**
 * The nine routes of the GitHub tab, each with the requirement the spec's
 * permission table names. The pair that addresses one action resolves the
 * repository from the action's own row, which is what makes a maintainer of
 * another repository answer 404 instead of 403.
 */
test("declares every route of the GitHub tab with the requirement the spec names", () => {
  const declared = ROUTE_POLICY
    .filter(([, pattern]) => pattern.startsWith("/github/"))
    .map(([method, pattern, requirement]) => [
      `${method} ${pattern}`,
      requirement.kind === "repository" ? `${requirement.role}:${requirement.from}` : requirement.kind,
    ]);
  assert.deepEqual(Object.fromEntries(declared), {
    "POST /github/webhook": "public",
    "GET /github/integration": "admin",
    "PUT /github/integration/webhook-secret": "admin",
    "GET /github/deliveries": "admin",
    "POST /github/reconcile": "admin",
    "GET /github/actions": "scoped",
    "POST /github/actions": "admin",
    "PATCH /github/actions/:actionId": "maintainer:action",
    "DELETE /github/actions/:actionId": "maintainer:action",
    "GET /github/actions/:actionId/events": "viewer:action",
    "GET /github/events": "scoped",
    "GET /github/branches": "scoped",
  });
  // The parameter name is load-bearing: `repositoryKeyFor("action")` reads
  // `actionId`, so renaming it in the pattern would silently resolve `undefined`.
  assert.deepEqual(matchPolicy("PATCH", "/github/actions/a1")?.params, { actionId: "a1" });
  assert.deepEqual(matchPolicy("GET", "/github/actions/a1/events")?.params, { actionId: "a1" });
  // A literal path wins over the parameter, so neither write can be reached by
  // dressing it up as an action id.
  assert.equal(matchPolicy("GET", "/github/integration")?.requirement.kind, "admin");
  assert.equal(matchPolicy("PATCH", "/github/actions/integration")?.requirement.kind, "repository");
  assert.equal(matchPolicy("PUT", "/github/integration/webhook-secret")?.requirement.kind, "admin");
  // Nothing new is public, and no other method shares the two writes.
  assert.deepEqual(
    ROUTE_POLICY.filter(([method, pattern, requirement]) =>
      pattern.startsWith("/github/") && requirement.kind === "public"
      && `${method} ${pattern}` !== "POST /github/webhook"),
    [],
  );
  for (const method of ["POST", "PATCH", "DELETE"]) {
    assert.equal(matchPolicy(method, "/github/integration"), null, method);
  }
});

/**
 * The Guardrails tab's own routes, with the requirement the spec's permission table
 * names. Enrolling, removing and building a baseline all spend or delete, so all
 * three are the administrator's; saving a policy is a maintainer's and simulating
 * one an analyst's.
 */
test("declares every repository route of the Guardrails tab with the requirement the spec names", () => {
  const declared = ROUTE_POLICY
    .filter(([, pattern]) => pattern.startsWith("/guardrails/repositories"))
    .map(([method, pattern, requirement]) => [
      `${method} ${pattern}`,
      requirement.kind === "repository" ? `${requirement.role}:${requirement.from}` : requirement.kind,
    ]);
  assert.deepEqual(Object.fromEntries(declared), {
    "GET /guardrails/repositories": "scoped",
    "POST /guardrails/repositories": "admin",
    "PATCH /guardrails/repositories/:repositoryKey": "admin",
    "DELETE /guardrails/repositories/:repositoryKey": "admin",
    "POST /guardrails/repositories/:repositoryKey/actions-dispatch": "operator:param",
    "GET /guardrails/repositories/:repositoryKey/actions-status": "viewer:param",
    "GET /guardrails/repositories/:repositoryKey/baseline": "viewer:param",
    "POST /guardrails/repositories/:repositoryKey/baseline": "admin",
    "GET /guardrails/repositories/:repositoryKey/caller-workflow": "viewer:param",
    "PUT /guardrails/repositories/:repositoryKey/caller-workflow": "maintainer:param",
    "GET /guardrails/repositories/:repositoryKey/github-status": "viewer:param",
    "GET /guardrails/repositories/:repositoryKey/policy": "viewer:param",
    "PUT /guardrails/repositories/:repositoryKey/policy": "maintainer:param",
    "POST /guardrails/repositories/:repositoryKey/policy/simulate": "analyst:param",
    "GET /guardrails/repositories/:repositoryKey/pull-requests": "viewer:param",
    "POST /guardrails/repositories/:repositoryKey/target-preview": "operator:param",
  });
  // The retired parallel path for the baseline must not be reachable at all.
  assert.equal(matchPolicy("POST", "/guardrails/repositories/github:1/baseline/sync"), null);
  // Nothing here is public.
  assert.deepEqual(
    ROUTE_POLICY.filter(([, pattern, requirement]) =>
      pattern.startsWith("/guardrails/") && requirement.kind === "public"),
    [],
  );
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

/**
 * The invariant that matters for `from: "param"` routes: the key `authorize`
 * checked the grant against has to be the very key the handler resolves. A
 * second decode inside the handler used to break it, so a grant on the literal
 * key `…a%2Fb` authorized a request the handler then executed against `…a/b`.
 */
test("a guardrails param route resolves exactly the key authorization checked", async () => {
  const stamp = Date.now();
  const literalKey = `local:/repos/pct-${stamp}-a%2Fb`;
  const decodedKey = `local:/repos/pct-${stamp}-a/b`;
  // Precondition of the regression: one more decode turns one key into the other.
  assert.equal(decodeURIComponent(literalKey), decodedKey);

  const seen: string[] = [];
  const repository = (key: string): GuardrailRepository => ({
    repositoryKey: key, repositoryPath: `/repos/${key}`, source: "local", displayName: key,
    defaultBranch: "main", defaultExecutor: "sentinel-managed", remoteOwner: null, remoteName: null,
    githubConnectionId: null, githubInstallationId: null, githubRepositoryId: null, enabled: true,
    policyPath: ".csb/guardrails.json", lastGateId: null, githubStatus: "not_configured",
  });
  // Only the two members `GET …/github-status` reaches; the rest of the
  // dependency surface is irrelevant to which key the handler resolves.
  const deps = {
    getRepository(key: string) {
      seen.push(key);
      return [literalKey, decodedKey].includes(key) ? repository(key) : null;
    },
    getGitHubStatus: async (value: GuardrailRepository) => ({ resolvedKey: value.repositoryKey }),
  } as unknown as GuardrailsApiDependencies;

  const probe = new Hono();
  probe.use("*", async (c, next) => {
    c.set("principal" as never, {
      ...LOCAL_PRINCIPAL, kind: "user", isAdmin: false, grants: new Map([[literalKey, "viewer"]]),
    } as never);
    await next();
  });
  probe.use("*", authorize());
  probe.route("/", createGuardrailsApp(deps));

  const granted = await probe.request(`/guardrails/repositories/${encodeURIComponent(literalKey)}/github-status`);
  assert.equal(granted.status, 200);
  assert.deepEqual(await granted.json(), { status: { resolvedKey: literalKey } });
  assert.deepEqual(seen, [literalKey]);

  // The repository the extra decode used to reach stays invisible: the grant
  // does not cover it, so the handler is never invoked at all.
  const other = await probe.request(`/guardrails/repositories/${encodeURIComponent(decodedKey)}/github-status`);
  assert.equal(other.status, 404);
  assert.deepEqual(await other.json(), { error: "not_found" });
  assert.deepEqual(seen, [literalKey]);
});

test("a missing principal is the only authentication failure authorize invents", async () => {
  const probe = new Hono();
  probe.use("*", authorize());
  probe.get("/scanners", (c) => c.json({ reached: true }));
  const previous = process.env.CSB_RUNTIME_MODE;
  process.env.CSB_RUNTIME_MODE = "server";
  try {
    const response = await probe.request("/scanners");
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "authentication_required" });
  } finally {
    if (previous === undefined) delete process.env.CSB_RUNTIME_MODE;
    else process.env.CSB_RUNTIME_MODE = previous;
  }
});

test("a genuine fault while reading the principal is not disguised as a 401", async () => {
  const middleware = authorize();
  const context = {
    req: { method: "GET", path: "/scanners" },
    get() { throw new Error("db_unavailable"); },
    json() { throw new Error("authorize answered instead of failing"); },
  };
  await assert.rejects(async () => { await middleware(context as never, async () => {}); }, /db_unavailable/);
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
  mode: "server", origin, username: "admin", password: "x".repeat(24), repositoryRoots: [], trustProxy: false,
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
  return { cookie: `${SECURE_SESSION_COOKIE}=${token}`, csrf: session.csrfToken };
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

function seedGitHubRepository(key: string, repositoryId: string): void {
  getDb().prepare(`INSERT OR IGNORE INTO guardrail_repositories
    (repository_key, repository_path, source, display_name, default_branch, default_executor,
     remote_owner, remote_name, github_connection_id, github_installation_id, github_repository_id,
     enabled, policy_path, created_at, updated_at)
    VALUES (?, NULL, 'github', ?, 'main', 'sentinel-managed', 'okami', ?, 'c1', 'i1', ?, 1,
            '.csb/guardrails.json', 'now', 'now')`)
    .run(key, key, key.replaceAll(":", "-"), repositoryId);
}

/**
 * The three decisions the policy makes for an action, through the real middleware:
 * an action of a repository the caller cannot see is **missing**, not forbidden;
 * the role is resolved from the action's own row; and every mutation on the tree
 * still needs the CSRF token, while GitHub's own delivery does not.
 */
test("an action is authorized from its own row, and the tree keeps its CSRF guard", async () => {
  const stamp = Date.now();
  const repoA = `github:pa-${stamp}`;
  const repoB = `github:pb-${stamp}`;
  seedGitHubRepository(repoA, `${stamp}1`);
  seedGitHubRepository(repoB, `${stamp}2`);
  const action = createGitHubAction({
    repositoryKey: repoA, name: `PR ${stamp}`, triggerKind: "pull_request", branchPatterns: ["main"],
    executor: "sentinel-managed", connectionId: "c1", installationId: "i1", repositoryId: `${stamp}1`,
    scanner: null, costCeilingUsd: 2, dailyCostCeilingUsd: null, enabled: true, includeForks: false,
    createdBy: null,
  }, getDb());

  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-policy-action-"));
  const server = createServerApp(app, { webRoot, settings: serverSettings });
  // `githubIntegrationSecurity` reads the deployment origin from the environment,
  // not from the settings handed to `createServerApp`.
  const previousMode = process.env.CSB_RUNTIME_MODE;
  const previousOrigin = process.env.CSB_PUBLIC_ORIGIN;
  process.env.CSB_RUNTIME_MODE = "server";
  process.env.CSB_PUBLIC_ORIGIN = origin;
  try {
  const insider = member(`pmaintA${stamp}`, [{ repositoryKey: repoA, role: "maintainer" }]);
  const outsider = member(`pmaintB${stamp}`, [{ repositoryKey: repoB, role: "maintainer" }]);
  const send = (actor: { cookie: string; csrf: string }, body: unknown, csrf = true) =>
    server.request(`${origin}/api/github/actions/${action.id}`, {
      method: "PATCH",
      headers: {
        Cookie: actor.cookie, Origin: origin, "Content-Type": "application/json",
        ...(csrf ? { "X-CSRF-Token": actor.csrf } : {}),
      },
      body: JSON.stringify(body),
    });

  const invisible = await send(outsider, { enabled: false });
  assert.equal(invisible.status, 404);
  assert.deepEqual(await invisible.json(), { error: "not_found" });

  // Visible and high enough for the route, but enabling spends: the handler's
  // cost rule refuses what the role alone would have allowed.
  const enabling = await send(insider, { enabled: true });
  assert.equal(enabling.status, 403);
  assert.deepEqual(await enabling.json(), { error: "forbidden" });

  // Switching it off is the maintainer's to make.
  const disabling = await send(insider, { enabled: false });
  assert.equal(disabling.status, 200);

  // Every mutation on the tree needs the token, whatever the role.
  const withoutToken = await send(insider, { enabled: false }, false);
  assert.equal(withoutToken.status, 403);
  assert.deepEqual(await withoutToken.json(), { error: "csrf_invalid" });
  const createWithoutToken = await server.request(`${origin}/api/github/actions`, {
    method: "POST",
    headers: { Cookie: insider.cookie, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ repositoryKey: repoA }),
  });
  assert.equal(createWithoutToken.status, 403);
  assert.deepEqual(await createWithoutToken.json(), { error: "csrf_invalid" });

  // GitHub carries none of the three. The delivery reaches the handler, which
  // refuses it for the reason it should: the headers, not the origin.
  const delivery = await server.request(`${origin}/api/github/webhook`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(delivery.status, 400);
  assert.deepEqual(await delivery.json(), { error: "malformed_delivery" });
  } finally {
    if (previousMode === undefined) delete process.env.CSB_RUNTIME_MODE;
    else process.env.CSB_RUNTIME_MODE = previousMode;
    if (previousOrigin === undefined) delete process.env.CSB_PUBLIC_ORIGIN;
    else process.env.CSB_PUBLIC_ORIGIN = previousOrigin;
  }
});
