import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { Hono } from "hono";
import {
  NOTIFICATION_DEFAULTS,
  OPS_NOTIFICATION_SCOPE,
  REPOSITORY_NOTIFICATION_EVENTS,
  type AccountNotificationsResponse,
  type GuardrailRepository,
} from "@csb/shared";
import { LOCAL_PRINCIPAL, type Principal } from "../auth/principal.js";
import { ensureAuthSchema } from "../auth/schema.js";
import { setRepositoryGrant } from "../auth/grant-store.js";
import { createUser, updateUser } from "../auth/user-store.js";
import type { ServerSettings } from "../deployment-settings.js";
import { ensureGateSchema, upsertGuardrailRepository } from "../gate-store.js";
import { createNotificationsApi } from "./notifications-api.js";
import { ensureEmailSchema } from "./schema.js";
import { isSubscribed, listUserSubscriptions, setSubscription, subscribedUserIds } from "./subscription-store.js";

/**
 * Its own in-memory database. The shared `benchmark.db` is written by parallel
 * test processes, and an administrator's matrix names *every* registered
 * repository — an assertion about it would race whatever another file enrolled.
 */
function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  ensureGateSchema(db);
  ensureAuthSchema(db);
  ensureEmailSchema(db);
  return db;
}

function repository(key: string, displayName: string): GuardrailRepository {
  return {
    repositoryKey: key, repositoryPath: null, source: "github", displayName,
    defaultBranch: "main", defaultExecutor: "sentinel-managed", remoteOwner: "okami",
    remoteName: displayName, githubConnectionId: "conn-1", githubInstallationId: "inst-1",
    githubRepositoryId: `repo-${key}`, enabled: true, policyPath: ".okami/guardrails.json",
    lastGateId: null,
  } as unknown as GuardrailRepository;
}

const SERVER_SETTINGS = { mode: "server" } as unknown as ServerSettings;
const LOCAL_SETTINGS = { mode: "local" } as unknown as ServerSettings;

interface Harness {
  db: Database.Database;
  request(
    method: "GET" | "PUT",
    principal: Principal,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

function harness(db: Database.Database, settings: ServerSettings = SERVER_SETTINGS): Harness {
  let current: Principal = LOCAL_PRINCIPAL;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, current as never);
    await next();
  });
  app.route("/", createNotificationsApi({ settings, database: () => db }));
  return {
    db,
    async request(method, principal, body) {
      current = principal;
      const response = await app.request("/account/notifications", {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    },
  };
}

function principalOf(id: string, isAdmin: boolean): Principal {
  return { ...LOCAL_PRINCIPAL, kind: "user", userId: id, isAdmin, grants: new Map() };
}

test("the defaults come from the design's event table, not from the absence of a row", () => {
  const db = fresh();
  const user = createUser({ username: "ana@example.com", displayName: "Ana", isAdmin: false }, db);
  assert.deepEqual(NOTIFICATION_DEFAULTS, {
    "gate.blocked": true, "gate.error": true, "gate.passed": false,
    "scan.failed": true, "scan.completed": false,
    "ops.engine_unavailable": true, "ops.connection_attention": true,
    "ops.daily_cost": true, "ops.github_publish_failed": true,
  });
  assert.equal(isSubscribed(user.id, "okami/one", "gate.blocked", db), true);
  assert.equal(isSubscribed(user.id, "okami/one", "scan.completed", db), false);
  assert.equal(listUserSubscriptions(user.id, db).length, 0);

  // An override wins, in both directions, and only for its own scope.
  setSubscription(user.id, "okami/one", "gate.blocked", false, db);
  setSubscription(user.id, "okami/one", "scan.completed", true, db);
  assert.equal(isSubscribed(user.id, "okami/one", "gate.blocked", db), false);
  assert.equal(isSubscribed(user.id, "okami/one", "scan.completed", db), true);
  assert.equal(isSubscribed(user.id, "okami/two", "gate.blocked", db), true);

  // Writing the same value twice is an update, not a second row.
  setSubscription(user.id, "okami/one", "gate.blocked", false, db);
  assert.equal(listUserSubscriptions(user.id, db).length, 2);
  db.close();
});

test("subscribedUserIds applies the default to everyone who never chose", () => {
  const db = fresh();
  const one = createUser({ username: "one@example.com", displayName: "One", isAdmin: false }, db);
  const two = createUser({ username: "two@example.com", displayName: "Two", isAdmin: false }, db);
  const three = createUser({ username: "three@example.com", displayName: "Three", isAdmin: false }, db);
  setSubscription(two.id, "okami/one", "gate.blocked", false, db);
  setSubscription(three.id, "okami/one", "scan.completed", true, db);

  assert.deepEqual(
    subscribedUserIds([one.id, two.id, three.id], "okami/one", "gate.blocked", db),
    [one.id, three.id],
  );
  assert.deepEqual(
    subscribedUserIds([one.id, two.id, three.id], "okami/one", "scan.completed", db),
    [three.id],
  );
  assert.deepEqual(subscribedUserIds([], "okami/one", "gate.blocked", db), []);
  db.close();
});

test("a member's matrix holds exactly the repositories shared with them", async () => {
  const db = fresh();
  upsertGuardrailRepository(repository("okami/one", "sentinel"), db);
  upsertGuardrailRepository(repository("okami/two", "atlas"), db);
  const member = createUser({ username: "ana@example.com", displayName: "Ana", isAdmin: false }, db);
  setRepositoryGrant(member.id, "okami/one", "viewer", null, db);
  const api = harness(db);

  const { status, body } = await api.request("GET", principalOf(member.id, false));
  assert.equal(status, 200);
  const matrix = body as unknown as AccountNotificationsResponse;
  assert.deepEqual(matrix.repositories.map((row) => row.repositoryKey), ["okami/one"]);
  assert.equal(matrix.repositories[0]!.displayName, "sentinel");
  assert.equal(matrix.repositories[0]!.role, "viewer");
  assert.deepEqual(
    matrix.repositories[0]!.events,
    REPOSITORY_NOTIFICATION_EVENTS.map((event) => ({
      event, enabled: NOTIFICATION_DEFAULTS[event], isDefault: true,
    })),
  );
  // Operational alerts are an administrator's row; a member has none to render.
  assert.equal(matrix.ops, null);
  assert.equal(matrix.address, "ana@example.com");
  assert.equal(matrix.locale, "pt-BR");
  assert.deepEqual(matrix.accountEvents, [
    "account.invite", "account.reset", "account.new_login",
    "account.locked", "account.password_changed",
  ]);
  db.close();
});

test("an administrator's matrix holds every registered repository and the ops row", async () => {
  const db = fresh();
  upsertGuardrailRepository(repository("okami/one", "sentinel"), db);
  upsertGuardrailRepository(repository("okami/two", "atlas"), db);
  const admin = createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  const api = harness(db);

  const matrix = (await api.request("GET", principalOf(admin.id, true))).body as unknown as AccountNotificationsResponse;
  assert.deepEqual(matrix.repositories.map((row) => row.repositoryKey).sort(), ["okami/one", "okami/two"]);
  // An administrator sees a repository without holding a grant on it.
  assert.deepEqual(matrix.repositories.map((row) => row.role), [null, null]);
  assert.deepEqual(matrix.ops?.events.map((cell) => cell.event), [
    "ops.engine_unavailable", "ops.connection_attention",
    "ops.daily_cost", "ops.github_publish_failed",
  ]);
  assert.ok(matrix.ops?.events.every((cell) => cell.enabled && cell.isDefault));
  db.close();
});

test("an account with nothing to send to is told so instead of guessed at", async () => {
  const db = fresh();
  const user = createUser({ username: "operator", displayName: "Operator", isAdmin: false }, db);
  const api = harness(db);
  assert.equal(
    ((await api.request("GET", principalOf(user.id, false))).body as unknown as AccountNotificationsResponse).address,
    null,
  );
  // `users.email` first, then a username that is itself an address.
  updateUser(user.id, { email: "ops@example.com" }, db);
  assert.equal(
    ((await api.request("GET", principalOf(user.id, false))).body as unknown as AccountNotificationsResponse).address,
    "ops@example.com",
  );
  db.close();
});

test("a member cannot subscribe to a repository they cannot see, nor to the ops row", async () => {
  const db = fresh();
  upsertGuardrailRepository(repository("okami/one", "sentinel"), db);
  upsertGuardrailRepository(repository("okami/secret", "atlas"), db);
  const member = createUser({ username: "ana@example.com", displayName: "Ana", isAdmin: false }, db);
  setRepositoryGrant(member.id, "okami/one", "analyst", null, db);
  const api = harness(db);
  const caller = principalOf(member.id, false);

  // Invisible and non-existent answer with the same code: the difference would
  // let a member enumerate the repositories they were not given.
  for (const scope of ["okami/secret", "okami/never-existed"]) {
    const refused = await api.request("PUT", caller, {
      subscriptions: [{ scope, event: "gate.blocked", enabled: false }],
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "scope_unknown");
  }

  const ops = await api.request("PUT", caller, {
    subscriptions: [{ scope: OPS_NOTIFICATION_SCOPE, event: "ops.daily_cost", enabled: false }],
  });
  assert.equal(ops.status, 400);
  assert.equal(ops.body.error, "ops_forbidden");

  // An operational event on a repository scope, and a repository event on `ops`,
  // are both wrong even for somebody allowed to touch each scope on its own.
  const mismatched = await api.request("PUT", caller, {
    subscriptions: [{ scope: "okami/one", event: "ops.daily_cost", enabled: false }],
  });
  assert.equal(mismatched.body.error, "event_invalid");

  assert.equal(listUserSubscriptions(member.id, db).length, 0);
  db.close();
});

test("account events are never editable, and one bad cell rolls the whole batch back", async () => {
  const db = fresh();
  upsertGuardrailRepository(repository("okami/one", "sentinel"), db);
  upsertGuardrailRepository(repository("okami/two", "atlas"), db);
  const admin = createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  const api = harness(db);
  const caller = principalOf(admin.id, true);

  const account = await api.request("PUT", caller, {
    subscriptions: [{ scope: OPS_NOTIFICATION_SCOPE, event: "account.new_login", enabled: false }],
  });
  assert.equal(account.status, 400);
  assert.equal(account.body.error, "event_not_editable");
  assert.equal(account.body.event, "account.new_login");

  // A batch whose last cell is refused writes none of the earlier ones: half a
  // matrix is a state the user never asked for and cannot see.
  const partial = await api.request("PUT", caller, {
    subscriptions: [
      { scope: "okami/one", event: "gate.passed", enabled: true },
      { scope: "okami/two", event: "scan.completed", enabled: true },
      { scope: "okami/one", event: "account.locked", enabled: false },
    ],
  });
  assert.equal(partial.status, 400);
  assert.equal(listUserSubscriptions(admin.id, db).length, 0);

  for (const body of [
    {},
    { subscriptions: "all" },
    { subscriptions: [{ scope: "okami/one", event: "gate.passed" }] },
    { subscriptions: [{ scope: "okami/one", event: "gate.passed", enabled: "yes" }] },
    { subscriptions: [{ scope: "", event: "gate.passed", enabled: true }] },
    {
      subscriptions: [
        { scope: "okami/one", event: "gate.passed", enabled: true },
        { scope: "okami/one", event: "gate.passed", enabled: false },
      ],
    },
  ]) {
    const refused = await api.request("PUT", caller, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.ok(
      ["subscriptions_invalid", "enabled_invalid"].includes(String(refused.body.error)),
      String(refused.body.error),
    );
  }
  assert.equal(listUserSubscriptions(admin.id, db).length, 0);
  db.close();
});

test("an allowed batch is stored, echoed back, and marked as no longer default", async () => {
  const db = fresh();
  upsertGuardrailRepository(repository("okami/one", "sentinel"), db);
  const admin = createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  const api = harness(db);
  const caller = principalOf(admin.id, true);

  const saved = await api.request("PUT", caller, {
    subscriptions: [
      { scope: "okami/one", event: "gate.passed", enabled: true },
      { scope: "okami/one", event: "gate.blocked", enabled: false },
      { scope: OPS_NOTIFICATION_SCOPE, event: "ops.daily_cost", enabled: false },
    ],
  });
  assert.equal(saved.status, 200);
  const matrix = saved.body as unknown as AccountNotificationsResponse;
  const cells = new Map(matrix.repositories[0]!.events.map((cell) => [cell.event, cell]));
  assert.deepEqual(cells.get("gate.passed"), { event: "gate.passed", enabled: true, isDefault: false });
  assert.deepEqual(cells.get("gate.blocked"), { event: "gate.blocked", enabled: false, isDefault: false });
  // Untouched cells stay defaults, so the screen can still say "default".
  assert.deepEqual(cells.get("scan.failed"), { event: "scan.failed", enabled: true, isDefault: true });
  assert.equal(matrix.ops?.events.find((cell) => cell.event === "ops.daily_cost")?.enabled, false);

  assert.deepEqual(listUserSubscriptions(admin.id, db), [
    { scope: "okami/one", event: "gate.blocked", enabled: false },
    { scope: "okami/one", event: "gate.passed", enabled: true },
    { scope: OPS_NOTIFICATION_SCOPE, event: "ops.daily_cost", enabled: false },
  ]);

  // A cell set back to its default is still a stored choice, not a deletion:
  // "I chose this" survives a later change to the defaults table.
  await api.request("PUT", caller, {
    subscriptions: [{ scope: "okami/one", event: "gate.blocked", enabled: true }],
  });
  assert.deepEqual(
    listUserSubscriptions(admin.id, db).find((row) => row.event === "gate.blocked"),
    { scope: "okami/one", event: "gate.blocked", enabled: true },
  );
  db.close();
});

test("the matrix follows the store, not the session that asked for it", async () => {
  const db = fresh();
  upsertGuardrailRepository(repository("okami/one", "sentinel"), db);
  const member = createUser({ username: "ana@example.com", displayName: "Ana", isAdmin: false }, db);
  setRepositoryGrant(member.id, "okami/one", "viewer", null, db);
  const api = harness(db);
  // A cookie minted while the grant existed must not keep the cell editable once
  // the grant is gone, so the route re-reads the access it is about to apply.
  const stale: Principal = {
    ...principalOf(member.id, false),
    grants: new Map([["okami/one", "maintainer"]]),
  };
  setRepositoryGrant(member.id, "okami/one", null, null, db);

  const matrix = (await api.request("GET", stale)).body as unknown as AccountNotificationsResponse;
  assert.deepEqual(matrix.repositories, []);
  const refused = await api.request("PUT", stale, {
    subscriptions: [{ scope: "okami/one", event: "gate.blocked", enabled: false }],
  });
  assert.equal(refused.body.error, "scope_unknown");
  db.close();
});

test("local mode has no accounts, so it has no subscriptions either", async () => {
  const db = fresh();
  const api = harness(db, LOCAL_SETTINGS);
  const asked = await api.request("GET", LOCAL_PRINCIPAL);
  assert.equal(asked.status, 404);
  assert.equal(asked.body.error, "not_found");
  const written = await api.request("PUT", LOCAL_PRINCIPAL, { subscriptions: [] });
  assert.equal(written.status, 404);
  db.close();
});

test("the matrix is never cached, because it names one account's repositories", async () => {
  const db = fresh();
  const admin = createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  let current: Principal = principalOf(admin.id, true);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, current as never);
    await next();
  });
  app.route("/", createNotificationsApi({ settings: SERVER_SETTINGS, database: () => db }));
  const response = await app.request("/account/notifications");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  current = principalOf(admin.id, true);
  db.close();
});
