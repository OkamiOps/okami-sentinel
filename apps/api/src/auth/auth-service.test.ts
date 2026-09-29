import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureAuthSchema } from "./schema.js";
import { createUser, findUserByUsername, updateUser } from "./user-store.js";
import { hashPassword } from "./passwords.js";
import { createInvite } from "./invite-store.js";
import { resolveSession } from "./session-store.js";
import {
  acceptInvite,
  bootstrapAdmin,
  changePassword,
  lockoutMs,
  login,
  principalForSession,
  resetLoginRateLimit,
} from "./auth-service.js";

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

test("rate-limits a single IP after enough failed attempts within the window", async () => {
  resetLoginRateLimit();
  const db = setup();
  createUser({ username: "ana", displayName: "Ana", isAdmin: false, passwordHash: await hashPassword("ana password 123") }, db);
  const now = new Date("2026-09-29T11:00:00.000Z");
  const ip = "9.9.9.9";
  for (let i = 0; i < 30; i += 1) {
    const result = await login({ username: "ana", password: "wrong", ip, userAgent: null, now }, db);
    assert.equal(result.ok, false);
  }
  const blocked = await login({ username: "ana", password: "ana password 123", ip, userAgent: null, now }, db);
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.error, "rate_limited");
  assert.ok(blocked.error === "rate_limited" && blocked.retryAfterSeconds > 0);
});

test("counts probes of an already-locked account against the per-IP limiter", async () => {
  resetLoginRateLimit();
  const db = setup();
  createUser({ username: "bob", displayName: "Bob", isAdmin: false, passwordHash: await hashPassword("bob password 123") }, db);
  const now = new Date("2026-09-29T12:00:00.000Z");
  // Lock the account using distinct IPs so this doesn't pre-charge the probing IP below.
  for (let i = 0; i < 5; i += 1) {
    await login({ username: "bob", password: "wrong", ip: `8.8.8.${i}`, userAgent: null, now }, db);
  }
  const ip = "8.8.8.8";
  let lastResult;
  for (let i = 0; i < 30; i += 1) {
    lastResult = await login({ username: "bob", password: "bob password 123", ip, userAgent: null, now }, db);
    assert.equal(lastResult.ok, false);
  }
  assert.ok(lastResult && !lastResult.ok && lastResult.error === "account_locked");
  const rateLimited = await login({ username: "bob", password: "bob password 123", ip, userAgent: null, now }, db);
  assert.equal(rateLimited.ok, false);
  if (rateLimited.ok) return;
  assert.equal(rateLimited.error, "rate_limited");
  // The locked-account probes never touch verifyPassword, so they must not have
  // advanced the user's own failure counter.
  assert.equal(findUserByUsername("bob", db)?.failedAttempts, 5);
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

test("a restart clears the lockout on the configured administrator without resetting its password", async () => {
  const db = setup();
  const settings = { username: "admin", password: "docker-secret-password-24chars" };
  assert.equal(await bootstrapAdmin(settings, db), "created");
  // The administrator changed the password after the first boot; a lockout
  // recovery must not silently restore the one in the password file.
  const admin = findUserByUsername("admin", db)!;
  const chosen = "the password the admin chose";
  updateUser(admin.id, { passwordHash: await hashPassword(chosen) }, db);
  assert.equal(await bootstrapAdmin(settings, db), "unchanged");

  const chosenHash = findUserByUsername("admin", db)!.passwordHash;
  // Only administrator on the instance, now locked out by failed attempts.
  const now = new Date();
  updateUser(admin.id, { failedAttempts: 5, lockedUntil: new Date(now.getTime() + 15 * 60_000).toISOString() }, db);
  assert.equal(await bootstrapAdmin(settings, db), "unlocked");
  const unlocked = findUserByUsername("admin", db)!;
  assert.equal(unlocked.failedAttempts, 0);
  assert.equal(unlocked.lockedUntil, null);
  assert.equal(unlocked.passwordHash, chosenHash, "the stored password hash must survive the unlock");
  const chosenStillWorks = await login({ username: "admin", password: chosen, ip: "4.4.4.5", userAgent: null }, db);
  assert.equal(chosenStillWorks.ok, true, "the password the administrator chose must still sign in");
  // A second boot has nothing left to clear.
  assert.equal(await bootstrapAdmin(settings, db), "unchanged");

  // A lingering failure counter below the lock threshold is cleared too, so the
  // next attempt starts from a full budget.
  updateUser(admin.id, { failedAttempts: 3 }, db);
  assert.equal(await bootstrapAdmin(settings, db), "unlocked");
  assert.equal(findUserByUsername("admin", db)?.failedAttempts, 0);
});

test("changing the password clears the failure counters", async () => {
  const db = setup();
  const user = createUser({ username: "ana", displayName: "Ana", isAdmin: false, passwordHash: await hashPassword("ana password 123") }, db);
  const signedIn = await login({ username: "ana", password: "ana password 123", ip: "5.5.5.1", userAgent: null }, db);
  assert.ok(signedIn.ok);
  if (!signedIn.ok) return;
  updateUser(user.id, { failedAttempts: 4, lockedUntil: new Date(Date.now() + 60_000).toISOString() }, db);
  assert.deepEqual(
    await changePassword({ userId: user.id, sessionId: signedIn.session.id, currentPassword: "ana password 123", newPassword: "another password" }, db),
    { ok: true },
  );
  const after = findUserByUsername("ana", db)!;
  assert.equal(after.failedAttempts, 0);
  assert.equal(after.lockedUntil, null);
});
