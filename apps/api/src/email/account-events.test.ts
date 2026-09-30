import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { acceptInvite, changePassword, login, resetLoginRateLimit } from "../auth/auth-service.js";
import { createInvite } from "../auth/invite-store.js";
import { hashPassword } from "../auth/passwords.js";
import { ensureAuthSchema } from "../auth/schema.js";
import { createSession } from "../auth/session-store.js";
import { createUser, type UserRecord } from "../auth/user-store.js";
import { isUnfamiliarLogin, NEW_LOGIN_HISTORY_DAYS } from "./account-notifications.js";
import { listEmailDeliveries } from "./outbox-store.js";
import { ensureEmailSchema } from "./schema.js";
import { DEFAULT_EMAIL_SETTINGS, saveEmailSettings } from "./settings-store.js";

const PASSWORD = "ana password 123";
const NEXT_PASSWORD = "ana password 456";
const AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Firefox/141.0";
const OTHER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36";

function setup(enabled = true): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(db);
  ensureEmailSchema(db);
  saveEmailSettings({
    ...DEFAULT_EMAIL_SETTINGS, enabled, fromAddress: "sentinel@okami.example",
    smtpHost: "smtp.okami.example", smtpPort: 465,
  }, null, new Date("2026-09-30T09:00:00.000Z"), db);
  resetLoginRateLimit();
  return db;
}

async function ana(db: Database.Database, overrides: Partial<UserRecord> = {}): Promise<UserRecord> {
  return createUser({
    username: overrides.username ?? "ana@okami.example",
    displayName: "Ana", email: overrides.email ?? null, isAdmin: false,
    passwordHash: await hashPassword(PASSWORD),
  }, db);
}

const events = (db: Database.Database) => listEmailDeliveries(200, db).map((row) => row.event);
const bodyOf = (db: Database.Database, event: string): { subject: string; text: string } =>
  db.prepare("SELECT subject, text FROM email_outbox WHERE event = ? ORDER BY created_at DESC").get(event) as
    { subject: string; text: string };

test("a lock applied by failed sign-ins tells the account's owner when it lifts", async () => {
  const db = setup();
  const user = await ana(db);
  const now = new Date("2026-09-30T10:00:00.000Z");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await login({ username: user.username, password: "wrong", ip: `10.0.0.${attempt}`, userAgent: AGENT, now }, db);
  }
  // Four failures are not news; the fifth is the one that locks the account.
  assert.deepEqual(events(db), []);

  await login({ username: user.username, password: "wrong", ip: "10.0.0.9", userAgent: AGENT, now }, db);
  assert.deepEqual(events(db), ["account.locked"]);
  const message = bodyOf(db, "account.locked");
  assert.match(message.subject, /bloqueada/);
  assert.ok(message.text.includes("Nova tentativa em: 15 minutos"));
  assert.ok(message.text.includes("Horário do bloqueio: 2026-09-30 10:00:00 UTC"));

  // Polling the locked account is not a new lock, so it is not a new message.
  await login({ username: user.username, password: PASSWORD, ip: "10.0.0.9", userAgent: AGENT, now }, db);
  assert.deepEqual(events(db), ["account.locked"]);
});

test("changing the password says so, and so does accepting an invite or a reset", async () => {
  const db = setup();
  const user = await ana(db);
  const now = new Date("2026-09-30T11:00:00.000Z");
  const { session } = createSession({ userId: user.id, ip: "10.0.0.1", userAgent: AGENT, now }, db);

  const changed = await changePassword({
    userId: user.id, sessionId: session.id, currentPassword: PASSWORD, newPassword: NEXT_PASSWORD, now,
  }, db);
  assert.equal(changed.ok, true);
  assert.deepEqual(events(db), ["account.password_changed"]);
  assert.ok(bodyOf(db, "account.password_changed").text.includes("Horário: 2026-09-30 11:00:00 UTC"));

  const refused = await changePassword({
    userId: user.id, sessionId: session.id, currentPassword: "not it", newPassword: "another password 1", now,
  }, db);
  assert.equal(refused.ok, false);
  assert.equal(events(db).length, 1);

  const later = new Date("2026-09-30T12:00:00.000Z");
  const reset = createInvite({ userId: user.id, purpose: "reset", createdBy: null, now: later }, db);
  const accepted = await acceptInvite({
    token: reset.token, password: "ana password 789", ip: "10.0.0.1", userAgent: AGENT, now: later,
  }, db);
  assert.equal(accepted.ok, true);
  assert.deepEqual(events(db).sort(), ["account.password_changed", "account.password_changed"]);
});

test("the first sign-in never alerts, and a familiar address and browser never do either", async () => {
  const db = setup();
  const user = await ana(db);
  const first = new Date("2026-09-30T10:00:00.000Z");
  assert.equal(isUnfamiliarLogin(db, user.id, { ip: "203.0.113.7", userAgent: AGENT, now: first }), false);
  assert.equal((await login({ username: user.username, password: PASSWORD, ip: "203.0.113.7", userAgent: AGENT, now: first }, db)).ok, true);
  assert.deepEqual(events(db), []);

  const again = new Date("2026-09-30T18:00:00.000Z");
  assert.equal((await login({ username: user.username, password: PASSWORD, ip: "203.0.113.7", userAgent: AGENT, now: again }, db)).ok, true);
  assert.deepEqual(events(db), []);

  // The same browser family from the same address, different build: a user agent
  // is client-supplied text, and a Firefox update is not a security event.
  const updated = `${AGENT.replace("141.0", "142.0")}`;
  assert.equal(isUnfamiliarLogin(db, user.id, { ip: "203.0.113.7", userAgent: updated, now: again }), false);
});

test("a new address or a new browser alerts once, naming both", async () => {
  const db = setup();
  const user = await ana(db);
  const first = new Date("2026-09-30T10:00:00.000Z");
  await login({ username: user.username, password: PASSWORD, ip: "203.0.113.7", userAgent: AGENT, now: first }, db);

  const elsewhere = new Date("2026-09-30T11:00:00.000Z");
  await login({ username: user.username, password: PASSWORD, ip: "198.51.100.4", userAgent: AGENT, now: elsewhere }, db);
  assert.deepEqual(events(db), ["account.new_login"]);
  const alert = bodyOf(db, "account.new_login");
  assert.match(alert.subject, /novo acesso/);
  assert.ok(alert.text.includes("Endereço IP: 198.51.100.4"));
  assert.ok(alert.text.includes("Navegador: Firefox · macOS"));
  assert.ok(alert.text.includes("Horário: 2026-09-30 11:00:00 UTC"));
  // No public origin in local mode, so no link and the footer says why.
  assert.equal(alert.text.includes("http"), false);

  const otherBrowser = new Date("2026-09-30T12:00:00.000Z");
  await login({ username: user.username, password: PASSWORD, ip: "203.0.113.7", userAgent: OTHER_AGENT, now: otherBrowser }, db);
  assert.equal(events(db).filter((event) => event === "account.new_login").length, 2);
  assert.ok(bodyOf(db, "account.new_login").text.includes("Navegador: Chrome · Windows"));
});

test("a device unused for longer than the window looks new again", async () => {
  const db = setup();
  const user = await ana(db);
  const first = new Date("2026-01-01T10:00:00.000Z");
  await login({ username: user.username, password: PASSWORD, ip: "203.0.113.7", userAgent: AGENT, now: first }, db);
  assert.deepEqual(events(db), []);

  const long = new Date(first.getTime() + (NEW_LOGIN_HISTORY_DAYS + 1) * 24 * 3_600_000);
  assert.equal(isUnfamiliarLogin(db, user.id, { ip: "203.0.113.7", userAgent: AGENT, now: long }), true);
  await login({ username: user.username, password: PASSWORD, ip: "203.0.113.7", userAgent: AGENT, now: long }, db);
  assert.deepEqual(events(db), ["account.new_login"]);
});

test("an account with no address on file, and an installation with e-mail off, queue nothing", async () => {
  const addressless = setup();
  // `ana` signs in with a name that is not an address and has no e-mail on file.
  const user = await ana(addressless, { username: "ana", email: null });
  const now = new Date("2026-09-30T10:00:00.000Z");
  await login({ username: "ana", password: PASSWORD, ip: "203.0.113.7", userAgent: AGENT, now }, addressless);
  await login({ username: "ana", password: PASSWORD, ip: "198.51.100.4", userAgent: AGENT, now }, addressless);
  assert.deepEqual(events(addressless), []);
  const { session } = createSession({ userId: user.id, ip: "10.0.0.1", userAgent: AGENT, now }, addressless);
  await changePassword({
    userId: user.id, sessionId: session.id, currentPassword: PASSWORD, newPassword: NEXT_PASSWORD, now,
  }, addressless);
  assert.deepEqual(events(addressless), []);

  const off = setup(false);
  const other = await ana(off);
  await login({ username: other.username, password: PASSWORD, ip: "203.0.113.7", userAgent: AGENT, now }, off);
  await login({ username: other.username, password: PASSWORD, ip: "198.51.100.4", userAgent: AGENT, now }, off);
  assert.deepEqual(events(off), []);
});

test("an outbox that cannot be written does not cost anyone their sign-in", async () => {
  const db = setup();
  const user = await ana(db);
  const now = new Date("2026-09-30T10:00:00.000Z");
  await login({ username: user.username, password: PASSWORD, ip: "203.0.113.7", userAgent: AGENT, now }, db);
  db.exec("DROP TABLE email_outbox");

  const elsewhere = new Date("2026-09-30T11:00:00.000Z");
  const result = await login({ username: user.username, password: PASSWORD, ip: "198.51.100.4", userAgent: AGENT, now: elsewhere }, db);
  assert.equal(result.ok, true);
  const { session } = createSession({ userId: user.id, ip: "10.0.0.1", userAgent: AGENT, now: elsewhere }, db);
  const changed = await changePassword({
    userId: user.id, sessionId: session.id, currentPassword: PASSWORD, newPassword: NEXT_PASSWORD, now: elsewhere,
  }, db);
  assert.equal(changed.ok, true);
});
