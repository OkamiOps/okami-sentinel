import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { GitHubMonitorOverview } from "@csb/shared";
import { app } from "../app.js";
import { createGitHubMonitorApi } from "../github-monitor/api.js";
import type { GitHubMonitorService } from "../github-monitor/service.js";
import { getDb } from "../db.js";
import type { ServerSettings } from "../deployment-settings.js";
import { createServerApp } from "../server-app.js";
import { refreshManagedRuntimeCommands } from "../config.js";
import { ensureGitHubMonitorSchema } from "../github-monitor/store.js";
import { SESSION_COOKIE } from "../server-security.js";
import { listActiveRuns, listRunPage, scanCatalog } from "../scan-list.js";
import { buildMetricsSummary } from "../metrics.js";
import { replaceUserGrants } from "./grant-store.js";
import { LOCAL_PRINCIPAL, type AccessScope } from "./principal.js";
import { createSession } from "./session-store.js";
import { createUser } from "./user-store.js";

function insertRun(id: string, key: string | null, status: string, name: string): void {
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
  mode: "server", origin, username: "admin", password: "x".repeat(24), repositoryRoots: [],
};

function seedRepository(key: string): void {
  getDb().prepare(`INSERT OR IGNORE INTO guardrail_repositories
    (repository_key, repository_path, source, display_name, default_branch, default_executor, enabled, policy_path, created_at, updated_at)
    VALUES (?, ?, 'local', ?, 'main', 'sentinel-managed', 1, '.csb/guardrails.json', 'now', 'now')`)
    .run(key, `/repos/${key.replaceAll(/[^A-Za-z0-9]/g, "-")}`, key);
}

function seedMonitorRule(id: string, repositoryKey: string): void {
  ensureGitHubMonitorSchema(getDb());
  const now = new Date().toISOString();
  getDb().prepare(`INSERT OR REPLACE INTO github_monitor_rules
    (id, repository_key, connection_id, installation_id, repository_id, executor, scanner_json,
     cost_ceiling_usd, daily_cost_ceiling_usd, follow_branches_json, checkout_mode, enabled, revision,
     baseline_initialized_at, last_polled_at, last_error, created_at, updated_at)
    VALUES (?, ?, 'conn', 'inst', 'repo', 'sentinel-managed', NULL, NULL, NULL, '["main"]', 'none', 1, 1, ?, ?, NULL, ?, ?)`)
    .run(id, repositoryKey, now, now, now, now);
}

function seedMonitorEvent(id: string, ruleId: string, repositoryKey: string): void {
  getDb().prepare(`INSERT OR REPLACE INTO github_monitor_events
    (id, rule_id, repository_key, rule_revision, kind, status, head_sha, base_ref, head_ref,
     pull_request_number, target_identity, title, gate_id, cost_ceiling_usd, reason, error,
     detected_at, dispatched_at, completed_at)
    VALUES (?, ?, ?, 1, 'push', 'queued', ?, NULL, 'main', NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)`)
    .run(id, ruleId, repositoryKey, "a".repeat(40), id, new Date().toISOString());
}

function seedActionsRun(id: string, ruleId: string, repositoryKey: string): void {
  const now = new Date().toISOString();
  getDb().prepare(`INSERT OR REPLACE INTO github_monitor_actions_runs
    (id, rule_id, repository_key, workflow_run_id, name, event, head_branch, head_sha, status,
     conclusion, url, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'CI', 'push', 'main', ?, 'completed', 'success', 'https://github.com/x/y/actions/runs/1', ?, ?)`)
    .run(id, ruleId, repositoryKey, id, "b".repeat(40), now, now);
}

function seedGate(id: string, repositoryKey: string): void {
  getDb().prepare(`INSERT OR REPLACE INTO gate_runs
    (id, repository_key, repository_path, source, executor, base_ref, head_ref, materialization_state,
     artifact_schema_version, status, policy_version, publish_status, cost_ceiling_usd, estimated_usd, started_at)
    VALUES (?, ?, ?, 'local', 'sentinel-managed', 'main', 'feature', 'not_required', 1, 'completed', 1, 'not_configured', 0, 0, ?)`)
    .run(id, repositoryKey, `/repos/${repositoryKey}`, new Date().toISOString());
}

function seedScopedRun(id: string, repositoryKey: string | null): void {
  const now = new Date().toISOString();
  getDb().prepare(`INSERT OR REPLACE INTO runs
    (id, display_name, scan_dir, status, source, repository_key, created_at, updated_at)
    VALUES (?, ?, ?, 'completed', 'native', ?, ?, ?)`)
    .run(id, id, path.join(os.tmpdir(), `csb-scoped-${id}`), repositoryKey, now, now);
}

function actor(name: string, isAdmin: boolean, grants: Array<{ repositoryKey: string; role: "viewer" | "analyst" | "operator" | "maintainer" }>) {
  const user = createUser({ username: name, displayName: name, isAdmin }, getDb());
  replaceUserGrants(user.id, grants, null, getDb());
  const { token, session } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  return { cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrfToken };
}

/**
 * The GitHub monitor and checkout routes carry their own origin guard, which
 * only accepts the public origin once the runtime is in server mode. The scanner
 * binary is pointed at nothing so `GET /health` answers without spawning a CLI.
 */
function withServerRuntime<T>(body: () => Promise<T>): Promise<T> {
  const previous = {
    mode: process.env.CSB_RUNTIME_MODE,
    origin: process.env.CSB_PUBLIC_ORIGIN,
    bin: process.env.CODEX_SECURITY_BIN,
  };
  process.env.CSB_RUNTIME_MODE = "server";
  process.env.CSB_PUBLIC_ORIGIN = origin;
  process.env.CODEX_SECURITY_BIN = path.join(os.tmpdir(), "csb-scoped-absent-scanner");
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

/**
 * Every test file in this suite shares one SQLite file, and the monitor and gate
 * lists are read unfiltered elsewhere, so the fixtures this test needs are
 * removed again instead of being left behind as another file's phantom rows.
 */
function dropSeededRows(repositoryKeys: string[]): void {
  const placeholders = repositoryKeys.map(() => "?").join(", ");
  for (const table of ["github_monitor_actions_runs", "github_monitor_events", "github_monitor_rules", "gate_runs"]) {
    getDb().prepare(`DELETE FROM ${table} WHERE repository_key IN (${placeholders})`).run(...repositoryKeys);
  }
}

test("scoped routes never answer with another repository's data", (t) => withServerRuntime(async () => {
  const stamp = Date.now();
  t.after(() => dropSeededRows([`scoped-a-${stamp}`, `scoped-b-${stamp}`]));
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
  seedMonitorRule(`scoped-rule-a-${stamp}`, repoA);
  seedMonitorRule(`scoped-rule-b-${stamp}`, repoB);
  seedMonitorEvent(`scoped-event-a-${stamp}`, `scoped-rule-a-${stamp}`, repoA);
  seedMonitorEvent(`scoped-event-b-${stamp}`, `scoped-rule-b-${stamp}`, repoB);
  seedActionsRun(`scoped-actions-a-${stamp}`, `scoped-rule-a-${stamp}`, repoA);
  seedActionsRun(`scoped-actions-b-${stamp}`, `scoped-rule-b-${stamp}`, repoB);

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
  const checkoutA = await read(viewer, `/api/github-checkouts?repositoryKey=${encodeURIComponent(repoA)}`);
  assert.notDeepEqual(await checkoutA.json(), { error: "not_found" });

  // GET /guardrails/gates — an out-of-scope query key yields nothing; the
  // unfiltered list is narrowed to the grants.
  const gatesB = await read(viewer, `/api/guardrails/gates?repositoryKey=${encodeURIComponent(repoB)}`);
  assert.equal(gatesB.status, 200);
  assert.deepEqual(await gatesB.json(), { gates: [] });
  const gatesAll = await read(viewer, "/api/guardrails/gates");
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
  assert.notDeepEqual(await compareA.json(), { error: "not_found" });

  // GET /health — only in-scope active scans, and no server paths for a member.
  const health = await (await read(viewer, "/api/health")).json();
  assert.deepEqual(health.activeScanIds, []);
  assert.equal(health.activeScanId, null);
  assert.equal(health.codexStateDir, undefined);

  // GitHub monitor lists and their recomputed summary.
  const overview = (await (await read(viewer, "/api/github-monitor/overview")).json()).overview as {
    rules: Array<{ repositoryKey: string }>;
    events: Array<{ repositoryKey: string }>;
    actionsRuns: Array<{ repositoryKey: string }>;
    summary: { enabledRules: number; queuedEvents: number; dispatchingEvents: number };
  };
  assert.deepEqual([...new Set(overview.rules.map((rule) => rule.repositoryKey))], [repoA]);
  assert.deepEqual([...new Set(overview.events.map((event) => event.repositoryKey))], [repoA]);
  assert.deepEqual([...new Set(overview.actionsRuns.map((run) => run.repositoryKey))], [repoA]);
  assert.equal(overview.summary.enabledRules, 1);
  assert.equal(overview.summary.queuedEvents, 1);
  assert.equal(overview.summary.dispatchingEvents, 0);

  const rulesB = await read(viewer, `/api/github-monitor/rules?repositoryKey=${encodeURIComponent(repoB)}`);
  assert.deepEqual(await rulesB.json(), { rules: [] });
  const eventsB = await read(viewer, `/api/github-monitor/events?repositoryKey=${encodeURIComponent(repoB)}`);
  assert.deepEqual(await eventsB.json(), { events: [] });
  const actionsB = await read(viewer, `/api/github-monitor/actions-runs?repositoryKey=${encodeURIComponent(repoB)}`);
  assert.deepEqual(await actionsB.json(), { actionsRuns: [] });

  // GET /github-monitor/branches needs the viewer role on the named repository.
  const branchesB = await read(viewer, `/api/github-monitor/branches?repositoryKey=${encodeURIComponent(repoB)}`);
  assert.equal(branchesB.status, 404);
  assert.deepEqual(await branchesB.json(), { error: "not_found" });

  // POST /github-monitor/poll needs the operator role on the named repository.
  const pollInvisible = await post(viewer, "/api/github-monitor/poll", { repositoryKey: repoB });
  assert.equal(pollInvisible.status, 404);
  assert.deepEqual(await pollInvisible.json(), { error: "not_found" });
  const pollUnderRole = await post(viewer, "/api/github-monitor/poll", { repositoryKey: repoA });
  assert.equal(pollUnderRole.status, 403);
  assert.deepEqual(await pollUnderRole.json(), { error: "forbidden" });
  const pollUnnamed = await post(viewer, "/api/github-monitor/poll", {});
  assert.equal(pollUnnamed.status, 404);
  assert.deepEqual(await pollUnnamed.json(), { error: "not_found" });
}));

test("health discloses the state directory to an administrator only", () => withServerRuntime(async () => {
  const forAdmin = await (await asPrincipal({ isAdmin: true }).request("/health")).json();
  assert.equal(typeof forAdmin.codexStateDir, "string");
  const forMember = await (await asPrincipal({ kind: "user", isAdmin: false }).request("/health")).json();
  assert.equal(forMember.codexStateDir, undefined);
  assert.equal(forMember.ok, true);
}));

test("poll reaches the monitor only for a repository the caller operates", async () => {
  const key = `scoped-poll-${Date.now()}`;
  seedRepository(key);
  const polled: Array<string | null> = [];
  const overview: GitHubMonitorOverview = {
    rules: [], events: [], actionsRuns: [],
    summary: {
      enabledRules: 0, queuedEvents: 0, dispatchingEvents: 0, lastPolledAt: null,
      lastError: null, checkoutAvailable: false, recentActionsWindowDays: 7,
    },
  };
  const service = {
    poll: async (requested: string | null) => { polled.push(requested); return overview; },
  } as unknown as GitHubMonitorService;
  const probe = (role: "viewer" | "operator") => {
    const monitor = new Hono();
    monitor.use("*", async (c, next) => {
      c.set("principal" as never, {
        ...LOCAL_PRINCIPAL, kind: "user", isAdmin: false, grants: new Map([[key, role]]),
      } as never);
      await next();
    });
    monitor.route("/", createGitHubMonitorApi({ service } as never));
    return monitor.request("/github-monitor/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryKey: key }),
    });
  };

  const denied = await probe("viewer");
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "forbidden" });
  assert.deepEqual(polled, []);

  const allowed = await probe("operator");
  assert.equal(allowed.status, 200);
  assert.deepEqual(polled, [key]);
});
