import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Hono } from "hono";
import { app } from "../app.js";
import { getDb } from "../db.js";
import type { ServerSettings } from "../deployment-settings.js";
import { createServerApp } from "../server-app.js";
import { refreshManagedRuntimeCommands } from "../config.js";
import { SECURE_SESSION_COOKIE } from "../session-cookie.js";
import { listActiveRuns, listRunPage, scanCatalog } from "../scan-list.js";
import { buildMetricsSummary } from "../metrics.js";
import { replaceUserGrants } from "./grant-store.js";
import { LOCAL_PRINCIPAL, type AccessScope } from "./principal.js";
import { createSession } from "./session-store.js";
import { createUser } from "./user-store.js";

/**
 * Every test file in this suite shares one SQLite file, and the run, gate and
 * user lists are read unfiltered elsewhere, so every row this file inserts is
 * recorded here and removed again instead of being left behind as another
 * file's phantom row or an extra administrator it may demote.
 */
const seeded = {
  runs: new Set<string>(),
  repositories: new Set<string>(),
  gates: new Set<string>(),
  users: new Set<string>(),
};

function removeSeededRows(): void {
  const deleteIn = (table: string, column: string, ids: Set<string>) => {
    if (ids.size === 0) return;
    const values = [...ids];
    getDb().prepare(`DELETE FROM ${table} WHERE ${column} IN (${values.map(() => "?").join(", ")})`).run(...values);
  };
  // One transaction, so the write lock every other test file competes for is
  // taken once instead of eleven times. Children first: the cascades depend on a
  // pragma this suite does not set.
  getDb().transaction(() => {
    deleteIn("gate_runs", "id", seeded.gates);
    deleteIn("runs", "id", seeded.runs);
    deleteIn("sessions", "user_id", seeded.users);
    deleteIn("user_invites", "user_id", seeded.users);
    deleteIn("repository_grants", "user_id", seeded.users);
    deleteIn("users", "id", seeded.users);
    deleteIn("repository_grants", "repository_key", seeded.repositories);
    deleteIn("guardrail_repositories", "repository_key", seeded.repositories);
  })();
}

after(removeSeededRows);

function insertRun(id: string, key: string | null, status: string, name: string): void {
  seeded.runs.add(id);
  getDb().prepare(`
    INSERT INTO runs (id, display_name, repository_path, scan_dir, status, source, created_at, updated_at, started_at, repository_key)
    VALUES (?, ?, ?, ?, ?, 'benchmark', ?, ?, ?, ?)
  `).run(id, name, `/repos/${name}`, `/tmp/${id}`, status, "2026-09-29T00:00:00.000Z", "2026-09-29T00:00:00.000Z", "2026-09-29T00:00:00.000Z", key);
}

const tag = `scope${Date.now()}`;
insertRun(`${tag}-a1`, `${tag}:a`, "completed", `${tag}-alpha`);
insertRun(`${tag}-a2`, `${tag}:a`, "failed", `${tag}-alpha`);
insertRun(`${tag}-a3`, `${tag}:a`, "running", `${tag}-alpha`);
insertRun(`${tag}-b1`, `${tag}:b`, "completed", `${tag}-beta`);
insertRun(`${tag}-n1`, null, "running", `${tag}-orphan`);

const onlyA: AccessScope = { kind: "repositories", keys: new Set([`${tag}:a`]) };
const nothing: AccessScope = { kind: "repositories", keys: new Set() };

test("paged lists, totals and archived counts honor the scope", () => {
  const page = listRunPage({ limit: 100, offset: 0, status: "all", query: tag }, true, onlyA);
  assert.deepEqual(page.scans.map((s) => s.id).sort(), [`${tag}-a1`, `${tag}-a2`, `${tag}-a3`]);
  assert.equal(page.total, 3);
  assert.equal(page.summary.archivedCount, 1);
});

test("catalog and active runs honor the scope", () => {
  assert.deepEqual(scanCatalog(onlyA).repositories, [`${tag}-alpha`]);
  assert.deepEqual(listActiveRuns(onlyA).map((s) => s.id), [`${tag}-a3`]);
  assert.equal(listActiveRuns(nothing).length, 0);
});

test("metrics count only in-scope runs", () => {
  assert.equal(buildMetricsSummary({ scope: onlyA, query: tag }).recentTotal, 3);
  assert.equal(buildMetricsSummary({ scope: nothing }).recentTotal, 0);
});

test("an unscoped default still sees every run", () => {
  const page = listRunPage({ limit: 100, offset: 0, status: "all", query: tag });
  assert.equal(page.total, 5);
  assert.equal(buildMetricsSummary({ query: tag }).recentTotal, 5);
});

/* ------------------------------------------------------------------------- */
/* Server-mode HTTP checks: a SCOPED route is the only guard those paths get. */
/* ------------------------------------------------------------------------- */

const origin = "https://sentinel.example";
const serverSettings: ServerSettings = {
  mode: "server", origin, username: "admin", password: "x".repeat(24), repositoryRoots: [], trustProxy: false,
};

function seedRepository(key: string): void {
  seeded.repositories.add(key);
  getDb().prepare(`INSERT OR IGNORE INTO guardrail_repositories
    (repository_key, repository_path, source, display_name, default_branch, default_executor, enabled, policy_path, created_at, updated_at)
    VALUES (?, ?, 'local', ?, 'main', 'sentinel-managed', 1, '.csb/guardrails.json', 'now', 'now')`)
    .run(key, `/repos/${key.replaceAll(/[^A-Za-z0-9]/g, "-")}`, key);
}

function seedGate(id: string, repositoryKey: string): void {
  seeded.gates.add(id);
  getDb().prepare(`INSERT OR REPLACE INTO gate_runs
    (id, repository_key, repository_path, source, executor, base_ref, head_ref, materialization_state,
     artifact_schema_version, status, policy_version, publish_status, cost_ceiling_usd, estimated_usd, started_at)
    VALUES (?, ?, ?, 'local', 'sentinel-managed', 'main', 'feature', 'not_required', 1, 'completed', 1, 'not_configured', 0, 0, ?)`)
    .run(id, repositoryKey, `/repos/${repositoryKey}`, new Date().toISOString());
}

function seedScopedRun(id: string, repositoryKey: string | null): void {
  seeded.runs.add(id);
  const now = new Date().toISOString();
  getDb().prepare(`INSERT OR REPLACE INTO runs
    (id, display_name, scan_dir, status, source, repository_key, created_at, updated_at)
    VALUES (?, ?, ?, 'completed', 'native', ?, ?, ?)`)
    .run(id, id, path.join(os.tmpdir(), `csb-scoped-${id}`), repositoryKey, now, now);
}

function actor(name: string, isAdmin: boolean, grants: Array<{ repositoryKey: string; role: "viewer" | "analyst" | "operator" | "maintainer" }>) {
  const user = createUser({ username: name, displayName: name, isAdmin }, getDb());
  seeded.users.add(user.id);
  replaceUserGrants(user.id, grants, null, getDb());
  const { token, session } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  return { cookie: `${SECURE_SESSION_COOKIE}=${token}`, csrf: session.csrfToken };
}

/**
 * A stand-in scanner keeps `GET /health` off the real CLI (seconds per spawn)
 * while still returning an `info --json` document shaped like the real one: the
 * typed fields the frontend renders plus host paths that must not leave.
 */
const scannerRawInfo = {
  cliVersion: "9.9.9",
  sdkVersion: "8.8.8",
  model: "probe-model",
  reasoningEffort: "high",
  npmCache: "/var/tmp/csb-scoped-npm-cache",
  codexHome: "/var/tmp/csb-scoped-codex-home",
};
const scannerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "csb-scoped-scanner-"));
const fakeScanner = path.join(scannerDirectory, "fake-codex-security");
fs.writeFileSync(
  fakeScanner,
  `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(${JSON.stringify(scannerRawInfo)}));\n`,
  { mode: 0o700 },
);
after(() => fs.rmSync(scannerDirectory, { recursive: true, force: true }));

/**
 * The GitHub monitor and checkout routes carry their own origin guard, which
 * only accepts the public origin once the runtime is in server mode.
 */
function withServerRuntime<T>(body: () => Promise<T>): Promise<T> {
  const previous = {
    mode: process.env.CSB_RUNTIME_MODE,
    origin: process.env.CSB_PUBLIC_ORIGIN,
    bin: process.env.CODEX_SECURITY_BIN,
  };
  process.env.CSB_RUNTIME_MODE = "server";
  process.env.CSB_PUBLIC_ORIGIN = origin;
  process.env.CODEX_SECURITY_BIN = fakeScanner;
  refreshManagedRuntimeCommands();
  const restore = () => {
    for (const [key, value] of [["CSB_RUNTIME_MODE", previous.mode], ["CSB_PUBLIC_ORIGIN", previous.origin], ["CODEX_SECURITY_BIN", previous.bin]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    refreshManagedRuntimeCommands();
  };
  return body().then((value) => { restore(); return value; }, (error) => { restore(); throw error; });
}

/** Mounting the API behind a fixed principal avoids a stored admin, which any
 * concurrent test file may demote while it exercises the last-admin rule. */
function asPrincipal(overrides: Record<string, unknown>) {
  const probe = new Hono();
  probe.use("*", async (c, next) => {
    c.set("principal" as never, { ...LOCAL_PRINCIPAL, ...overrides } as never);
    await next();
  });
  probe.route("/", app);
  return probe;
}

test("scoped routes never answer with another repository's data", (t) => withServerRuntime(async () => {
  const stamp = Date.now();
  t.after(removeSeededRows);
  const repoA = `scoped-a-${stamp}`;
  const repoB = `scoped-b-${stamp}`;
  seedRepository(repoA);
  seedRepository(repoB);
  const runA = `scoped-run-a-${stamp}`;
  const runB = `scoped-run-b-${stamp}`;
  seedScopedRun(runA, repoA);
  seedScopedRun(runB, repoB);
  seedGate(`scoped-gate-a-${stamp}`, repoA);
  seedGate(`scoped-gate-b-${stamp}`, repoB);

  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-scoped-web-"));
  const server = createServerApp(app, { webRoot, settings: serverSettings });
  const viewer = actor(`scopedviewer${stamp}`, false, [{ repositoryKey: repoA, role: "viewer" }]);

  const read = (who: { cookie: string }, target: string) =>
    server.request(`${origin}${target}`, { headers: { Cookie: who.cookie, Origin: origin } });
  const post = (who: { cookie: string; csrf: string }, target: string, body: unknown) =>
    server.request(`${origin}${target}`, {
      method: "POST",
      headers: { Cookie: who.cookie, Origin: origin, "X-CSRF-Token": who.csrf, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // GET /github-checkouts?repositoryKey=… — a query key outside the grant is invisible.
  const checkoutB = await read(viewer, `/api/github-checkouts?repositoryKey=${encodeURIComponent(repoB)}`);
  assert.equal(checkoutB.status, 404);
  assert.deepEqual(await checkoutB.json(), { error: "not_found" });
  // The granted key is visible: the refusal that follows is the checkout's own
  // state (this fixture has no working tree), never the 404 scope produces.
  const checkoutA = await read(viewer, `/api/github-checkouts?repositoryKey=${encodeURIComponent(repoA)}`);
  assert.equal(checkoutA.status, 409);
  assert.deepEqual(await checkoutA.json(), { error: "checkout_unavailable" });

  // GET /guardrails/gates — an out-of-scope query key yields nothing; the
  // unfiltered list is narrowed to the grants.
  const gatesB = await read(viewer, `/api/guardrails/gates?repositoryKey=${encodeURIComponent(repoB)}`);
  assert.equal(gatesB.status, 200);
  assert.deepEqual(await gatesB.json(), { gates: [] });
  const gatesAll = await read(viewer, "/api/guardrails/gates");
  assert.equal(gatesAll.status, 200);
  const gateKeys = new Set(((await gatesAll.json()).gates as Array<{ repositoryKey: string }>).map((gate) => gate.repositoryKey));
  assert.equal(gateKeys.has(repoA), true);
  assert.equal(gateKeys.has(repoB), false);

  // GET /guardrails/repositories
  const repositories = ((await (await read(viewer, "/api/guardrails/repositories")).json()).repositories as Array<{ repositoryKey: string }>)
    .map((repository) => repository.repositoryKey);
  assert.equal(repositories.includes(repoA), true);
  assert.equal(repositories.includes(repoB), false);

  // GET /scans and friends
  const scanIds = ((await (await read(viewer, "/api/scans?limit=100&offset=0")).json()).scans as Array<{ id: string }>).map((scan) => scan.id);
  assert.equal(scanIds.includes(runB), false);
  const catalog = (await (await read(viewer, "/api/scans/catalog")).json()) as { total: number; repositories: string[] };
  assert.equal(catalog.repositories.includes(runA), true);
  assert.equal(catalog.repositories.includes(runB), false);
  const active = (await (await read(viewer, "/api/scans/active")).json()).scans as Array<{ id: string }>;
  assert.equal(active.some((scan) => scan.id === runB), false);

  // POST /compare — a single out-of-scope scan hides the whole comparison.
  const compareB = await post(viewer, "/api/compare", { scanIds: [runA, runB] });
  assert.equal(compareB.status, 404);
  assert.deepEqual(await compareB.json(), { error: "not_found" });
  const compareA = await post(viewer, "/api/compare", { scanIds: [runA] });
  // 400, not 404: the in-scope scan reached the handler, which then refused the
  // request on its own arity rule.
  assert.equal(compareA.status, 400);
  const refusedCompare = await compareA.json() as { error?: unknown };
  assert.equal(typeof refusedCompare.error, "string");
  assert.notEqual(refusedCompare.error, "not_found");

  // GET /health — only in-scope active scans, and no server paths for a member:
  // neither the state directory nor the scanner's raw info document.
  const health = await (await read(viewer, "/api/health")).json();
  assert.deepEqual(health.activeScanIds, []);
  assert.equal(health.activeScanId, null);
  assert.equal(health.codexStateDir, undefined);
  assert.equal(health.codexInfo.raw, undefined);
  assert.deepEqual(health.codexInfo, {
    cliVersion: "9.9.9", sdkVersion: "8.8.8", model: "probe-model", reasoningEffort: "high",
  });
  assert.deepEqual(
    Object.values(health.codexInfo).filter((value) => typeof value === "string" && value.startsWith("/")),
    [],
  );
  assert.equal(JSON.stringify(health).includes("/var/tmp/csb-scoped-"), false);

  // GET /github/branches — the branch read the Guardrails tab depends on. Its
  // repository travels in the query string, so the handler is the only guard:
  // a key outside the grants is invisible, and an unknown key answers the same.
  const branchesB = await read(viewer, `/api/github/branches?repositoryKey=${encodeURIComponent(repoB)}`);
  assert.equal(branchesB.status, 404);
  assert.deepEqual(await branchesB.json(), { error: "not_found" });
  const branchesMissing = await read(viewer, "/api/github/branches?repositoryKey=does-not-exist");
  assert.equal(branchesMissing.status, 404);
  assert.deepEqual(await branchesMissing.json(), { error: "not_found" });
  // The granted key reaches the handler, whose refusal is about the repository's
  // own shape (these fixtures are local), never about the scope.
  const branchesA = await read(viewer, `/api/github/branches?repositoryKey=${encodeURIComponent(repoA)}`);
  assert.equal(branchesA.status, 409);
  assert.deepEqual(await branchesA.json(), { error: "github_repository_unsupported" });
  const branchesUnnamed = await read(viewer, "/api/github/branches");
  assert.equal(branchesUnnamed.status, 400);

  // The rest of the GitHub monitor routes are gone with the poller; task 1.5
  // replaces them with `/github/actions` and `/github/events`, which arrive with
  // their own scoping tests.
}));

test("health discloses server paths to an administrator only", () => withServerRuntime(async () => {
  const forAdmin = await (await asPrincipal({ isAdmin: true }).request("/health")).json();
  assert.equal(typeof forAdmin.codexStateDir, "string");
  // The administrator and the local runtime keep the whole scanner document.
  assert.deepEqual(forAdmin.codexInfo.raw, scannerRawInfo);
  assert.equal(forAdmin.codexInfo.cliVersion, "9.9.9");

  const forMember = await (await asPrincipal({ kind: "user", isAdmin: false }).request("/health")).json();
  assert.equal(forMember.ok, true);
  assert.equal(forMember.codexStateDir, undefined);
  assert.equal(forMember.codexInfo.raw, undefined);
  assert.equal(forMember.codexInfo.model, "probe-model");
  assert.deepEqual(
    Object.values(forMember.codexInfo).filter((value) => typeof value === "string" && value.startsWith("/")),
    [],
  );
}));
