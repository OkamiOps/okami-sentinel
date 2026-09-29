import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Hono } from "hono";
import type { GitHubMonitorOverview, GitHubMonitorRule } from "@csb/shared";
import { app } from "../app.js";
import { createGitHubMonitorApi } from "../github-monitor/api.js";
import type { GitHubMonitorService } from "../github-monitor/service.js";
import { getDb } from "../db.js";
import type { ServerSettings } from "../deployment-settings.js";
import { createServerApp } from "../server-app.js";
import { refreshManagedRuntimeCommands } from "../config.js";
import { ensureGitHubMonitorSchema } from "../github-monitor/store.js";
import { SECURE_SESSION_COOKIE } from "../session-cookie.js";
import { listActiveRuns, listRunPage, scanCatalog } from "../scan-list.js";
import { buildMetricsSummary } from "../metrics.js";
import { replaceUserGrants } from "./grant-store.js";
import { LOCAL_PRINCIPAL, type AccessScope } from "./principal.js";
import { createSession } from "./session-store.js";
import { createUser } from "./user-store.js";

/**
 * Every test file in this suite shares one SQLite file, and the run, monitor,
 * gate and user lists are read unfiltered elsewhere, so every row this file
 * inserts is recorded here and removed again instead of being left behind as
 * another file's phantom row or an extra administrator it may demote.
 */
const seeded = {
  runs: new Set<string>(),
  repositories: new Set<string>(),
  gates: new Set<string>(),
  monitorRules: new Set<string>(),
  monitorEvents: new Set<string>(),
  actionsRuns: new Set<string>(),
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
    deleteIn("github_monitor_actions_runs", "id", seeded.actionsRuns);
    deleteIn("github_monitor_events", "id", seeded.monitorEvents);
    deleteIn("github_monitor_rules", "id", seeded.monitorRules);
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

/**
 * The monitor only accepts a GitHub-sourced repository with a full remote
 * identity, and `seedMonitorRule` writes rules carrying exactly these ids, so a
 * patch is not refused for an identity mismatch before authorization is tested.
 */
function seedRemoteRepository(key: string): void {
  seeded.repositories.add(key);
  getDb().prepare(`INSERT OR REPLACE INTO guardrail_repositories
    (repository_key, repository_path, source, display_name, default_branch, default_executor,
     remote_owner, remote_name, github_connection_id, github_installation_id, github_repository_id,
     enabled, policy_path, created_at, updated_at)
    VALUES (?, NULL, 'github', ?, 'main', 'sentinel-managed', 'acme', ?, 'conn', 'inst', 'repo', 1,
            '.csb/guardrails.json', 'now', 'now')`)
    .run(key, key, key);
}

/**
 * A Sentinel-managed rule carries the scanner selection a real one has, so a
 * refusal to enable it is authorization talking and not the service rejecting a
 * rule that could never be enabled in the first place.
 */
const seededScanner = {
  engine: "codex-security", mode: "standard",
  connection: { connectionId: "seeded-connection", modelSelectionMode: "runtime-default", modelId: null },
};

function seedMonitorRule(id: string, repositoryKey: string, executor = "sentinel-managed"): void {
  seeded.monitorRules.add(id);
  ensureGitHubMonitorSchema(getDb());
  const now = new Date().toISOString();
  getDb().prepare(`INSERT OR REPLACE INTO github_monitor_rules
    (id, repository_key, connection_id, installation_id, repository_id, executor, scanner_json,
     cost_ceiling_usd, daily_cost_ceiling_usd, follow_branches_json, checkout_mode, enabled, revision,
     baseline_initialized_at, last_polled_at, last_error, created_at, updated_at)
    VALUES (?, ?, 'conn', 'inst', 'repo', ?, ?, 2, 2, '["main"]', 'none', 1, 1, ?, ?, NULL, ?, ?)`)
    .run(id, repositoryKey, executor, executor === "sentinel-managed" ? JSON.stringify(seededScanner) : null,
      now, now, now, now);
}

function seedMonitorEvent(id: string, ruleId: string, repositoryKey: string): void {
  seeded.monitorEvents.add(id);
  getDb().prepare(`INSERT OR REPLACE INTO github_monitor_events
    (id, rule_id, repository_key, rule_revision, kind, status, head_sha, base_ref, head_ref,
     pull_request_number, target_identity, title, gate_id, cost_ceiling_usd, reason, error,
     detected_at, dispatched_at, completed_at)
    VALUES (?, ?, ?, 1, 'push', 'queued', ?, NULL, 'main', NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)`)
    .run(id, ruleId, repositoryKey, "a".repeat(40), id, new Date().toISOString());
}

function seedActionsRun(id: string, ruleId: string, repositoryKey: string): void {
  seeded.actionsRuns.add(id);
  const now = new Date().toISOString();
  getDb().prepare(`INSERT OR REPLACE INTO github_monitor_actions_runs
    (id, rule_id, repository_key, workflow_run_id, name, event, head_branch, head_sha, status,
     conclusion, url, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'CI', 'push', 'main', ?, 'completed', 'success', 'https://github.com/x/y/actions/runs/1', ?, ?)`)
    .run(id, ruleId, repositoryKey, id, "b".repeat(40), now, now);
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

/**
 * The role table gives a repository maintainer its own monitor rule. Phase 1
 * reserved both writes for administrators because the rule id had no resolver
 * behind it, so this covers the two paths that replace it: the create body
 * names the repository, and a patch is authorized against the rule's own row.
 */
test("a monitor rule is created and edited by the repository's maintainer", (t) => withServerRuntime(async () => {
  const stamp = Date.now();
  t.after(removeSeededRows);
  const owned = `scoped-monitor-owned-${stamp}`;
  const fresh = `scoped-monitor-fresh-${stamp}`;
  const foreign = `scoped-monitor-foreign-${stamp}`;
  for (const key of [owned, fresh, foreign]) seedRemoteRepository(key);
  const ownedRule = `scoped-monitor-rule-${stamp}`;
  const foreignRule = `scoped-monitor-foreign-rule-${stamp}`;
  seedMonitorRule(ownedRule, owned);
  seedMonitorRule(foreignRule, foreign);

  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-monitor-web-"));
  const server = createServerApp(app, { webRoot, settings: serverSettings });
  const maintainer = actor(`monitormaint${stamp}`, false, [
    { repositoryKey: owned, role: "maintainer" }, { repositoryKey: fresh, role: "maintainer" },
  ]);
  const viewer = actor(`monitorviewer${stamp}`, false, [
    { repositoryKey: owned, role: "viewer" }, { repositoryKey: fresh, role: "viewer" },
  ]);
  const send = (who: { cookie: string; csrf: string }, method: "POST" | "PATCH", target: string, body: unknown) =>
    server.request(`${origin}${target}`, {
      method,
      headers: { Cookie: who.cookie, Origin: origin, "X-CSRF-Token": who.csrf, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const ruleBody = (repositoryKey: string) => ({
    repositoryKey, executor: "github-actions", scanner: null, costCeilingUsd: 2,
    followBranches: ["main"], checkoutMode: "none", enabled: false,
  });

  // POST — the viewer of a repository it may see is still refused.
  const viewerCreate = await send(viewer, "POST", "/api/github-monitor/rules", ruleBody(fresh));
  assert.equal(viewerCreate.status, 403);
  assert.deepEqual(await viewerCreate.json(), { error: "forbidden" });

  // POST — a repository outside every grant is invisible, not merely refused.
  const foreignCreate = await send(maintainer, "POST", "/api/github-monitor/rules", ruleBody(foreign));
  assert.equal(foreignCreate.status, 404);
  assert.deepEqual(await foreignCreate.json(), { error: "not_found" });

  const created = await send(maintainer, "POST", "/api/github-monitor/rules", ruleBody(fresh));
  assert.equal(created.status, 201);
  const createdRule = (await created.json()).rule as { id: string; repositoryKey: string };
  seeded.monitorRules.add(createdRule.id);
  assert.equal(createdRule.repositoryKey, fresh);

  // PATCH — the rule's own repository decides, with the same 404/403 split.
  const viewerPatch = await send(viewer, "PATCH", `/api/github-monitor/rules/${ownedRule}`, { enabled: false });
  assert.equal(viewerPatch.status, 403);
  assert.deepEqual(await viewerPatch.json(), { error: "forbidden" });

  const foreignPatch = await send(maintainer, "PATCH", `/api/github-monitor/rules/${foreignRule}`, { enabled: false });
  assert.equal(foreignPatch.status, 404);
  assert.deepEqual(await foreignPatch.json(), { error: "not_found" });

  // An unknown rule resolves to no repository, so it is invisible too: a member
  // must not learn which rule ids exist by probing them.
  const unknownPatch = await send(maintainer, "PATCH", `/api/github-monitor/rules/no-such-rule-${stamp}`, { enabled: false });
  assert.equal(unknownPatch.status, 404);
  assert.deepEqual(await unknownPatch.json(), { error: "not_found" });

  // The rule it just created runs on GitHub Actions, so the maintainer owns it.
  const patched = await send(maintainer, "PATCH", `/api/github-monitor/rules/${createdRule.id}`, { enabled: false, checkoutMode: "fetch" });
  assert.equal(patched.status, 200);
  const patchedRule = (await patched.json()).rule as Record<string, unknown>;
  assert.deepEqual(
    { id: patchedRule.id, repositoryKey: patchedRule.repositoryKey, enabled: patchedRule.enabled, checkoutMode: patchedRule.checkoutMode },
    { id: createdRule.id, repositoryKey: fresh, enabled: false, checkoutMode: "fetch" },
  );

  // A patch can never carry the rule to another repository, whatever the caller
  // maintains: the field is refused outright and the rule stays where it was.
  const moved = await send(maintainer, "PATCH", `/api/github-monitor/rules/${createdRule.id}`, { repositoryKey: owned, enabled: false });
  assert.equal(moved.status, 400);
  assert.deepEqual(await moved.json(), { error: "github_monitor_invalid" });
  assert.equal(
    (getDb().prepare("SELECT repository_key FROM github_monitor_rules WHERE id = ?").get(createdRule.id) as { repository_key: string }).repository_key,
    fresh,
  );

  // Phase 1 cost rule: a member never spends on a provider connection, so a
  // Sentinel-managed rule is refused however it is addressed — created from
  // scratch, or merely enabled where an administrator left one.
  const sentinelBody = {
    ...ruleBody(fresh), executor: "sentinel-managed",
    scanner: {
      engine: "codex-security", mode: "standard",
      connection: { connectionId: "provider-connection", modelSelectionMode: "runtime-default", modelId: null },
    },
  };
  const spendingCreate = await send(maintainer, "POST", "/api/github-monitor/rules", sentinelBody);
  assert.equal(spendingCreate.status, 403);
  assert.deepEqual(await spendingCreate.json(), { error: "forbidden" });

  const enablingSpend = await send(maintainer, "PATCH", `/api/github-monitor/rules/${ownedRule}`, { enabled: true });
  assert.equal(enablingSpend.status, 403);
  assert.deepEqual(await enablingSpend.json(), { error: "forbidden" });
  assert.equal(
    (getDb().prepare("SELECT enabled FROM github_monitor_rules WHERE id = ?").get(ownedRule) as { enabled: number }).enabled,
    1,
  );
  // Not even a cosmetic patch, because the rule it would leave behind is still
  // enabled and still launches Sentinel-managed paid scans.
  const cosmeticSpend = await send(maintainer, "PATCH", `/api/github-monitor/rules/${ownedRule}`, { checkoutMode: "fetch" });
  assert.equal(cosmeticSpend.status, 403);
  assert.deepEqual(await cosmeticSpend.json(), { error: "forbidden" });

  // Stopping the spending is never blocked: switching off a rule an
  // administrator enabled is the one Sentinel-managed edit a maintainer owns.
  const stopped = await send(maintainer, "PATCH", `/api/github-monitor/rules/${ownedRule}`, { enabled: false });
  assert.equal(stopped.status, 200);
  assert.equal(((await stopped.json()).rule as { enabled: boolean }).enabled, false);
  assert.equal(
    (getDb().prepare("SELECT enabled FROM github_monitor_rules WHERE id = ?").get(ownedRule) as { enabled: number }).enabled,
    0,
  );

  // Switching it back on is the administrator's decision again.
  const restarted = await send(maintainer, "PATCH", `/api/github-monitor/rules/${ownedRule}`, { enabled: true });
  assert.equal(restarted.status, 403);
  assert.deepEqual(await restarted.json(), { error: "forbidden" });
  assert.equal(
    (getDb().prepare("SELECT enabled FROM github_monitor_rules WHERE id = ?").get(ownedRule) as { enabled: number }).enabled,
    0,
  );

  // And a rule left switched off still may not be pointed at a connection,
  // which is what the next administrator to enable it would then spend on.
  const rewired = await send(maintainer, "PATCH", `/api/github-monitor/rules/${ownedRule}`, {
    enabled: false,
    scanner: {
      engine: "codex-security", mode: "standard",
      connection: { connectionId: "another-connection", modelSelectionMode: "runtime-default", modelId: null },
    },
  });
  assert.equal(rewired.status, 403);
  assert.deepEqual(await rewired.json(), { error: "forbidden" });

  // Nor may `enabled: false` carry anything else along: ceilings and followed
  // branches are what the next administrator's enable would spend against, so
  // the exemption covers the switch and nothing but the switch.
  const smuggled = await send(maintainer, "PATCH", `/api/github-monitor/rules/${ownedRule}`, {
    enabled: false, costCeilingUsd: 100_000, dailyCostCeilingUsd: 100_000, followBranches: ["**"],
  });
  assert.equal(smuggled.status, 403);
  assert.deepEqual(await smuggled.json(), { error: "forbidden" });
  assert.deepEqual(
    getDb().prepare(`SELECT cost_ceiling_usd, daily_cost_ceiling_usd, follow_branches_json, checkout_mode, scanner_json
      FROM github_monitor_rules WHERE id = ?`).get(ownedRule),
    {
      cost_ceiling_usd: 2, daily_cost_ceiling_usd: 2, follow_branches_json: '["main"]',
      checkout_mode: "none", scanner_json: JSON.stringify(seededScanner),
    },
  );
}));

/**
 * The same cost rule from the administrator's side, and for the two paths the
 * server-mode test above cannot reach without a stored administrator: a fixed
 * principal in front of the monitor API, with the service faked so the decision
 * is the only thing observed.
 */
test("only an administrator may point a monitor rule at a provider connection", async () => {
  const key = `scoped-spend-${Date.now()}`;
  const createdExecutors: string[] = [];
  const patchedIds: string[] = [];
  const rule = { id: "spend-rule", repositoryKey: key } as unknown as GitHubMonitorRule;
  const service = {
    createRule: (input: { executor: string }) => { createdExecutors.push(input.executor); return rule; },
    patchRule: (id: string) => { patchedIds.push(id); return rule; },
  } as unknown as GitHubMonitorService;
  const monitor = (isAdmin: boolean) => {
    const probe = new Hono();
    probe.use("*", async (c, next) => {
      c.set("principal" as never, {
        ...LOCAL_PRINCIPAL, kind: "user", isAdmin, grants: new Map([[key, "maintainer"]]),
      } as never);
      await next();
    });
    probe.route("/", createGitHubMonitorApi({ service } as never));
    return probe;
  };
  const body = (executor: "sentinel-managed" | "github-actions") => JSON.stringify({
    repositoryKey: key, executor, costCeilingUsd: 2, followBranches: ["main"], checkoutMode: "none", enabled: false,
    scanner: executor === "github-actions" ? null : {
      engine: "codex-security", mode: "standard",
      connection: { connectionId: "provider-connection", modelSelectionMode: "runtime-default", modelId: null },
    },
  });
  const create = (isAdmin: boolean, executor: "sentinel-managed" | "github-actions") =>
    monitor(isAdmin).request("/github-monitor/rules", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: body(executor),
    });

  const refused = await create(false, "sentinel-managed");
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "forbidden" });
  assert.deepEqual(createdExecutors, []);

  // The Actions executor spends the repository's own budget under its own
  // credentials, so a maintainer may still use it.
  assert.equal((await create(false, "github-actions")).status, 201);
  assert.deepEqual(createdExecutors, ["github-actions"]);

  assert.equal((await create(true, "sentinel-managed")).status, 201);
  assert.deepEqual(createdExecutors, ["github-actions", "sentinel-managed"]);

  // An administrator's patch is not measured against the resulting rule at all.
  const adminPatch = await monitor(true).request("/github-monitor/rules/spend-rule", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(adminPatch.status, 200);
  assert.deepEqual(patchedIds, ["spend-rule"]);
});

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
