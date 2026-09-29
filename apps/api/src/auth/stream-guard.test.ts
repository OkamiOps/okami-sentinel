import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { getDb } from "../db.js";
import { createStreamGuard } from "./stream-guard.js";
import { createUser, updateUser } from "./user-store.js";
import { createSession } from "./session-store.js";
import { principalForSession } from "./auth-service.js";
import { LOCAL_PRINCIPAL } from "./principal.js";
import { replaceUserGrants } from "./grant-store.js";
import { revokeSession } from "./session-store.js";

function seedGuardRepository(key: string): void {
  getDb().prepare(`INSERT OR IGNORE INTO guardrail_repositories
    (repository_key, repository_path, source, display_name, default_branch, default_executor, enabled, policy_path, created_at, updated_at)
    VALUES (?, ?, 'local', ?, 'main', 'sentinel-managed', 1, '.csb/guardrails.json', 'now', 'now')`)
    .run(key, `/repos/${key.replaceAll(/[^A-Za-z0-9]/g, "-")}`, key);
}

async function guardFor(
  session: Parameters<typeof principalForSession>[0],
  repositoryKey: () => string | null | undefined,
  clock: () => number,
): Promise<() => boolean> {
  let guard: (() => boolean) | null = null;
  const app = new Hono();
  app.get("/", (c) => {
    c.set("principal" as never, principalForSession(session)! as never);
    guard = createStreamGuard(c, repositoryKey, 60_000, clock);
    return c.text("ok");
  });
  await app.request("/");
  return guard!;
}

test("a stream closes within the interval after the user is disabled", async () => {
  seedGuardRepository("local/guard");
  const user = createUser({ username: `g${Date.now()}`, displayName: "G", isAdmin: false }, getDb());
  getDb().prepare("INSERT INTO repository_grants VALUES (?, 'local/guard', 'viewer', NULL, 'now')").run(user.id);
  const { session } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  let clock = 0;
  const guard = await guardFor(session, () => "local/guard", () => clock);
  assert.equal(guard(), true);
  updateUser(user.id, { status: "disabled" }, getDb());
  clock = 30_000;
  assert.equal(guard(), true);
  clock = 60_001;
  assert.equal(guard(), false);
});

test("a stream closes after the grant that authorized it is revoked", async () => {
  const key = `local/guard-revoke-${Date.now()}`;
  seedGuardRepository(key);
  const user = createUser({ username: `gr${Date.now()}`, displayName: "GR", isAdmin: false }, getDb());
  replaceUserGrants(user.id, [{ repositoryKey: key, role: "viewer" }], null, getDb());
  const { session } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  let clock = 0;
  const guard = await guardFor(session, () => key, () => clock);
  assert.equal(guard(), true);
  replaceUserGrants(user.id, [], null, getDb());
  clock = 60_001;
  assert.equal(guard(), false);
  // Once denied the guard stays denied without touching the database again.
  clock = 120_002;
  assert.equal(guard(), false);
});

test("a stream closes after its own session is revoked", async () => {
  const key = `local/guard-session-${Date.now()}`;
  seedGuardRepository(key);
  const user = createUser({ username: `gs${Date.now()}`, displayName: "GS", isAdmin: false }, getDb());
  replaceUserGrants(user.id, [{ repositoryKey: key, role: "viewer" }], null, getDb());
  const { session } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  let clock = 0;
  const guard = await guardFor(session, () => key, () => clock);
  assert.equal(guard(), true);
  revokeSession(session.id, getDb());
  clock = 60_001;
  assert.equal(guard(), false);
});

test("the local runtime principal is never re-authorized", async () => {
  let clock = 0;
  let guard: (() => boolean) | null = null;
  const app = new Hono();
  app.get("/", (c) => {
    c.set("principal" as never, LOCAL_PRINCIPAL as never);
    guard = createStreamGuard(c, () => null, 60_000, () => clock);
    return c.text("ok");
  });
  await app.request("/");
  assert.equal(guard!(), true);
  clock = 10 * 60_000;
  assert.equal(guard!(), true);
});
