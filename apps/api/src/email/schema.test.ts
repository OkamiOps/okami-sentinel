import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureAuthSchema } from "../auth/schema.js";
import { ensureEmailSchema } from "./schema.js";

function base(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(db);
  return db;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

test("creates the e-mail tables and the user locale idempotently", () => {
  const db = base();
  ensureEmailSchema(db);
  ensureEmailSchema(db);
  ensureEmailSchema(db);

  assert.deepEqual(columns(db, "email_settings"), [
    "id", "provider", "enabled", "from_name", "from_address", "reply_to",
    "smtp_host", "smtp_port", "smtp_security", "smtp_username", "secret_ref",
    "updated_at", "updated_by",
  ]);
  assert.deepEqual(columns(db, "email_outbox"), [
    "id", "event", "dedupe_key", "user_id", "to_address", "locale", "subject",
    "html", "text", "status", "attempts", "next_attempt_at", "last_error",
    "provider_message_id", "created_at", "sent_at",
    // Added by migration, so a database written before Task 3 keeps working.
    "scope",
  ]);
  assert.deepEqual(columns(db, "notification_subscriptions"), [
    "user_id", "scope", "event", "enabled",
  ]);
  assert.deepEqual(columns(db, "ops_alert_state"), [
    "event", "target", "active_since", "last_sent_at", "resolved_at",
  ]);
  // Nullable: an account message has no scope, and a row written before the
  // column existed has none either — the worker treats both the same way.
  assert.equal(
    (db.prepare("PRAGMA table_info(email_outbox)").all() as Array<{ name: string; notnull: number }>)
      .find((column) => column.name === "scope")?.notnull,
    0,
  );
  assert.ok(columns(db, "users").includes("locale"));
  // Nullable, so every account created before the column existed keeps working.
  assert.equal(
    (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string; notnull: number }>)
      .find((column) => column.name === "locale")?.notnull,
    0,
  );
});

test("the settings table holds a single row and rejects an unknown provider", () => {
  const db = base();
  ensureEmailSchema(db);
  const insert = (id: number, provider: string, security = "tls") =>
    db.prepare(`INSERT INTO email_settings (id, provider, enabled, from_name, smtp_security)
      VALUES (?, ?, 0, 'Okami', ?)`).run(id, provider, security);

  insert(1, "smtp");
  assert.throws(() => insert(2, "smtp"), /CHECK constraint/);
  assert.throws(() => insert(1, "smtp"), /UNIQUE|PRIMARY/);
  db.prepare("DELETE FROM email_settings").run();
  assert.throws(() => insert(1, "sendgrid"), /CHECK constraint/);
  assert.throws(() => insert(1, "smtp", "ssl"), /CHECK constraint/);
  insert(1, "resend");
});

test("the outbox refuses a repeated dedupe key and an unknown status", () => {
  const db = base();
  ensureEmailSchema(db);
  const queue = (id: string, dedupe: string, status = "queued") =>
    db.prepare(`INSERT INTO email_outbox
      (id, event, dedupe_key, to_address, locale, subject, html, text, status, attempts, created_at)
      VALUES (?, 'gate.blocked', ?, 'ana@example.com', 'pt-BR', 'Gate', '<p>x</p>', 'x', ?, 0, 'now')`)
      .run(id, dedupe, status);

  queue("m1", "gate.g1.gate.blocked");
  assert.throws(() => queue("m2", "gate.g1.gate.blocked"), /UNIQUE/);
  assert.throws(() => queue("m3", "gate.g2.gate.blocked", "posted"), /CHECK constraint/);
  for (const status of ["queued", "sending", "sent", "failed", "cancelled"]) {
    queue(`m-${status}`, `gate.${status}.gate.blocked`, status);
  }
});

test("subscriptions are one row per user, scope and event, and follow the user", () => {
  const db = base();
  db.pragma("foreign_keys = ON");
  ensureEmailSchema(db);
  db.prepare(`INSERT INTO users (id, username, display_name, is_admin, status, failed_attempts, created_at, updated_at)
    VALUES ('u1', 'ana', 'Ana', 0, 'active', 0, 'now', 'now')`).run();
  const subscribe = (scope: string, event: string, enabled: number) =>
    db.prepare("INSERT INTO notification_subscriptions (user_id, scope, event, enabled) VALUES ('u1', ?, ?, ?)")
      .run(scope, event, enabled);

  subscribe("local:/repos/app", "gate.blocked", 1);
  subscribe("ops", "ops.daily_cost", 0);
  assert.throws(() => subscribe("ops", "ops.daily_cost", 1), /UNIQUE|PRIMARY/);
  assert.throws(() => subscribe("ops", "ops.engine_unavailable", 2), /CHECK constraint/);

  db.prepare("DELETE FROM users WHERE id = 'u1'").run();
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM notification_subscriptions").get() as { n: number }).n,
    0,
  );
});

test("an outbox row survives the deletion of the user it was addressed to", () => {
  const db = base();
  db.pragma("foreign_keys = ON");
  ensureEmailSchema(db);
  db.prepare(`INSERT INTO users (id, username, display_name, is_admin, status, failed_attempts, created_at, updated_at)
    VALUES ('u1', 'ana', 'Ana', 0, 'active', 0, 'now', 'now')`).run();
  db.prepare(`INSERT INTO email_outbox
    (id, event, dedupe_key, user_id, to_address, locale, subject, html, text, status, attempts, created_at)
    VALUES ('m1', 'account.reset', 'account.u1.reset.1', 'u1', 'ana@example.com', 'pt-BR', 'Reset', '<p>x</p>', 'x', 'sent', 1, 'now')`).run();
  db.prepare("DELETE FROM users WHERE id = 'u1'").run();
  const row = db.prepare("SELECT user_id, status FROM email_outbox WHERE id = 'm1'").get() as
    { user_id: string | null; status: string };
  assert.deepEqual(row, { user_id: null, status: "sent" });
});
