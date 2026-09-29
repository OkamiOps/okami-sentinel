import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureAuthSchema } from "./schema.js";
import { createUser, findUserByUsername, updateUser } from "./user-store.js";
import { hashPassword } from "./passwords.js";
import { createInvite } from "./invite-store.js";
import { resolveSession } from "./session-store.js";
import { acceptInvite, bootstrapAdmin, changePassword, lockoutMs, login, principalForSession } from "./auth-service.js";

function setup() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(db);
  return db;
}

test("logs in with a normalized username and returns a principal", async () => {
  const db = setup();
  createUser({ username: "ana", displayName: "Ana", isAdmin: false, passwordHash: await hashPassword("ana password 123") }, db);
  const result = await login({ username: " ANA ", password: "ana password 123", ip: "1.1.1.1", userAgent: null }, db);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(principalForSession(result.session, db)?.username, "ana");
  assert.ok(findUserByUsername("ana", db)?.lastLoginAt);
});

test("locks the account after five failures and doubles the lock", async () => {
  assert.equal(lockoutMs(4), 0);
  assert.equal(lockoutMs(5), 15 * 60_000);
  assert.equal(lockoutMs(10), 30 * 60_000);
  assert.equal(lockoutMs(100), 24 * 3600_000);
  const db = setup();
  createUser({ username: "ana", displayName: "Ana", isAdmin: false, passwordHash: await hashPassword("ana password 123") }, db);
  const now = new Date("2026-09-29T10:00:00.000Z");
  for (let i = 0; i < 5; i += 1) {
    const failed = await login({ username: "ana", password: "wrong", ip: `10.0.0.${i}`, userAgent: null, now }, db);
    assert.equal(failed.ok, false);
  }
  const locked = await login({ username: "ana", password: "ana password 123", ip: "10.0.1.1", userAgent: null, now }, db);
  assert.deepEqual(locked, { ok: false, error: "account_locked", retryAfterSeconds: 900 });
  const later = await login({ username: "ana", password: "ana password 123", ip: "10.0.1.1", userAgent: null, now: new Date(now.getTime() + 901_000) }, db);
  assert.equal(later.ok, true);
});

test("does not reveal whether the username exists and refuses disabled users", async () => {
  const db = setup();
  const user = createUser({ username: "ana", displayName: "Ana", isAdmin: false, passwordHash: await hashPassword("ana password 123") }, db);
  assert.deepEqual(await login({ username: "nobody", password: "x", ip: "2.2.2.2", userAgent: null }, db), { ok: false, error: "invalid_credentials" });
  updateUser(user.id, { status: "disabled" }, db);
  assert.deepEqual(await login({ username: "ana", password: "ana password 123", ip: "2.2.2.3", userAgent: null }, db), { ok: false, error: "invalid_credentials" });
});

test("accepting an invite sets the password, consumes the link and signs in", async () => {
  const db = setup();
  const user = createUser({ username: "ana", displayName: "Ana", isAdmin: false }, db);
  const { token } = createInvite({ userId: user.id, purpose: "invite", createdBy: null }, db);
  assert.deepEqual(await acceptInvite({ token, password: "short", ip: null, userAgent: null }, db), { ok: false, error: "password_too_short" });
  const accepted = await acceptInvite({ token, password: "a strong password", ip: null, userAgent: null }, db);
  assert.equal(accepted.ok, true);
  assert.deepEqual(await acceptInvite({ token, password: "a strong password", ip: null, userAgent: null }, db), { ok: false, error: "invite_invalid" });
});

test("changing the password revokes the other sessions only", async () => {
  const db = setup();
  createUser({ username: "ana", displayName: "Ana", isAdmin: false, passwordHash: await hashPassword("ana password 123") }, db);
  const a = await login({ username: "ana", password: "ana password 123", ip: "3.3.3.1", userAgent: null }, db);
  const b = await login({ username: "ana", password: "ana password 123", ip: "3.3.3.2", userAgent: null }, db);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(await changePassword({ userId: a.user.id, sessionId: a.session.id, currentPassword: "wrong", newPassword: "another password" }, db), { ok: false, error: "invalid_credentials" });
  assert.deepEqual(await changePassword({ userId: a.user.id, sessionId: a.session.id, currentPassword: "ana password 123", newPassword: "another password" }, db), { ok: true });
  assert.ok(resolveSession(a.token, undefined, db));
  assert.equal(resolveSession(b.token, undefined, db), null);
});

test("bootstraps the first admin and recovers when no active admin remains", async () => {
  const db = setup();
  const settings = { username: "admin", password: "docker-secret-password-24chars" };
  assert.equal(await bootstrapAdmin(settings, db), "created");
  assert.equal(await bootstrapAdmin(settings, db), "unchanged");
  const admin = findUserByUsername("admin", db)!;
  updateUser(admin.id, { status: "disabled", passwordHash: await hashPassword("forgotten password") }, db);
  assert.equal(await bootstrapAdmin(settings, db), "recovered");
  const login1 = await login({ username: "admin", password: settings.password, ip: "4.4.4.4", userAgent: null }, db);
  assert.equal(login1.ok, true);
});
