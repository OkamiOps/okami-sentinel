import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureAuthSchema } from "./schema.js";
import { createUser } from "./user-store.js";
import { createSession, listUserSessions, resolveSession, revokeUserSessions } from "./session-store.js";
import { consumeInvite, createInvite, peekInvite } from "./invite-store.js";

function setup() {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  database.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(database);
  const user = createUser({ username: "ana", displayName: "Ana", isAdmin: false }, database);
  return { database, user };
}

test("stores only the token hash and expires idle and old sessions", () => {
  const { database, user } = setup();
  const start = new Date("2026-09-29T10:00:00.000Z");
  const { token, session } = createSession({ userId: user.id, ip: "10.0.0.1", userAgent: "ua", now: start }, database);
  assert.notEqual(session.id, token);
  assert.equal((database.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(token) as { n: number }).n, 0);
  assert.equal(resolveSession(token, new Date(start.getTime() + 11 * 3600_000), database)?.id, session.id);
  // Touched at +11h, so idle expiry moves to +23h.
  assert.ok(resolveSession(token, new Date(start.getTime() + 22 * 3600_000), database));
  assert.equal(resolveSession(token, new Date(start.getTime() + 35 * 3600_000), database), null);
  const second = createSession({ userId: user.id, ip: null, userAgent: null, now: start }, database);
  let now = start.getTime();
  for (let hour = 0; hour < 7 * 24; hour += 6) {
    now = start.getTime() + hour * 3600_000;
    assert.ok(resolveSession(second.token, new Date(now), database), `hour ${hour}`);
  }
  assert.equal(resolveSession(second.token, new Date(start.getTime() + 7 * 24 * 3600_000 + 1), database), null);
});

test("revokes every session of a user except the current one", () => {
  const { database, user } = setup();
  const a = createSession({ userId: user.id, ip: null, userAgent: null }, database);
  const b = createSession({ userId: user.id, ip: null, userAgent: null }, database);
  revokeUserSessions(user.id, a.session.id, database);
  assert.ok(resolveSession(a.token, undefined, database));
  assert.equal(resolveSession(b.token, undefined, database), null);
  assert.deepEqual(listUserSessions(user.id, undefined, database).map((s) => s.id), [a.session.id]);
});

test("invite links are single use, expire, and replace older links", () => {
  const { database, user } = setup();
  const now = new Date("2026-09-29T10:00:00.000Z");
  const first = createInvite({ userId: user.id, purpose: "invite", createdBy: null, now }, database);
  const second = createInvite({ userId: user.id, purpose: "reset", createdBy: null, now }, database);
  assert.equal(peekInvite(first.token, now, database), null);
  assert.equal(peekInvite(second.token, new Date(now.getTime() + 73 * 3600_000), database), null);
  assert.equal(consumeInvite(second.token, now, database)?.purpose, "reset");
  assert.equal(consumeInvite(second.token, now, database), null);
});
