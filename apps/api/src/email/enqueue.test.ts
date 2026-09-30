import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureAuthSchema } from "../auth/schema.js";
import { emailQueueEnabled, enqueueEmail } from "./enqueue.js";
import { listEmailDeliveries } from "./outbox-store.js";
import { ensureEmailSchema } from "./schema.js";
import { DEFAULT_EMAIL_SETTINGS, saveEmailSettings } from "./settings-store.js";

/** Its own database: the shared `benchmark.db` is read by parallel test files. */
function fresh(enabled: boolean): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(db);
  ensureEmailSchema(db);
  saveEmailSettings({
    ...DEFAULT_EMAIL_SETTINGS, enabled,
    fromAddress: "sentinel@okami.example", smtpHost: "smtp.okami.example", smtpPort: 465,
  }, null, new Date("2026-09-30T09:00:00.000Z"), db);
  return db;
}

const NOW = new Date("2026-09-30T10:00:00.000Z");

const invite = {
  event: "account.invite" as const,
  dedupeKey: "account.u1.invite.2026-10-03T10:00:00.000Z",
  userId: null,
  toAddress: "bruno@example.com",
  locale: "pt-BR" as const,
  data: {
    inviterName: "Marcos",
    inviteToken: "Tk0000000000000000000000000000000000000000x",
    expiresAt: new Date("2026-10-03T10:00:00.000Z"),
  },
  now: NOW,
  origin: "https://sentinel.okami.example",
};

test("renders the message and queues it, ready for the worker", () => {
  const db = fresh(true);
  const result = enqueueEmail(db, invite);
  assert.equal(result.status, "queued");
  if (result.status !== "queued") return;
  assert.match(result.id, /^out_/);

  const row = db.prepare("SELECT * FROM email_outbox WHERE id = ?").get(result.id) as Record<string, unknown>;
  assert.equal(row.event, "account.invite");
  assert.equal(row.status, "queued");
  assert.equal(row.attempts, 0);
  assert.equal(row.next_attempt_at, NOW.toISOString());
  assert.equal(row.to_address, "bruno@example.com");
  assert.equal(row.locale, "pt-BR");
  assert.match(String(row.subject), /convite/);
  assert.ok(String(row.html).includes(`https://sentinel.okami.example/invite/${invite.data.inviteToken}`));
  assert.ok(String(row.text).includes("Marcos criou uma conta para você"));
});

test("the global switch is honoured here, so a disabled installation queues nothing", () => {
  const db = fresh(false);
  assert.deepEqual(enqueueEmail(db, invite), { status: "skipped", reason: "disabled" });
  assert.equal(listEmailDeliveries(200, db).length, 0);

  // Turning it on must not release a backlog, because none was written.
  saveEmailSettings({ ...DEFAULT_EMAIL_SETTINGS, enabled: true, fromAddress: "sentinel@okami.example" }, null, NOW, db);
  assert.equal(enqueueEmail(db, invite).status, "queued");
  assert.equal(listEmailDeliveries(200, db).length, 1);
});

test("the same event twice is a no-op, not an error", () => {
  const db = fresh(true);
  assert.equal(enqueueEmail(db, invite).status, "queued");
  assert.deepEqual(enqueueEmail(db, invite), { status: "skipped", reason: "duplicate" });
  assert.equal(listEmailDeliveries(200, db).length, 1);
  // A different reference is a different message.
  assert.equal(enqueueEmail(db, { ...invite, dedupeKey: "account.u1.invite.later" }).status, "queued");
  assert.equal(listEmailDeliveries(200, db).length, 2);
});

test("the row joins the caller's transaction and disappears with it", () => {
  const db = fresh(true);
  assert.throws(() => db.transaction(() => {
    enqueueEmail(db, invite);
    throw new Error("the event failed after the message was rendered");
  })());
  assert.equal(listEmailDeliveries(200, db).length, 0);
});

test("without a public origin the queued body carries no link and no token", () => {
  const db = fresh(true);
  const result = enqueueEmail(db, { ...invite, origin: null });
  assert.equal(result.status, "queued");
  if (result.status !== "queued") return;
  const row = db.prepare("SELECT html, text FROM email_outbox WHERE id = ?").get(result.id) as
    { html: string; text: string };
  assert.equal(row.html.includes("href="), false);
  assert.equal(row.html.includes(invite.data.inviteToken), false);
  assert.equal(row.text.includes(invite.data.inviteToken), false);
  assert.ok(row.text.includes("não tem endereço público configurado"));
});

test("a taken dedupe key is refused before anything is rendered", () => {
  const db = fresh(true);
  assert.equal(enqueueEmail(db, invite).status, "queued");

  // The periodic callers — an operational condition re-sampled every minute, a
  // daily ceiling that stays crossed all day — re-enqueue the same key constantly.
  // The unique index is still what makes it correct; asking it first is what makes
  // it cheap, and is observable because a render this row can never use never runs.
  let rendered = 0;
  const counting = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes("INSERT INTO email_outbox")) rendered += 1;
          return Reflect.get(target, property, receiver).call(target, sql);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as typeof db;
  assert.deepEqual(enqueueEmail(counting, invite), { status: "skipped", reason: "duplicate" });
  assert.equal(rendered, 0);
  db.close();
});

test("a caller that already read the global switch does not make the store read it again", () => {
  const db = fresh(true);
  let settingsReads = 0;
  const counting = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes("FROM email_settings")) settingsReads += 1;
          return Reflect.get(target, property, receiver).call(target, sql);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as typeof db;

  assert.equal(enqueueEmail(counting, invite).status, "queued");
  assert.equal(settingsReads, 1);
  // A batch for many recipients reads it once and passes it down; the answer is
  // identical either way.
  settingsReads = 0;
  assert.equal(
    enqueueEmail(counting, { ...invite, dedupeKey: "account.u1.invite.second" }, { enabled: true }).status,
    "queued",
  );
  assert.equal(settingsReads, 0);
  assert.deepEqual(
    enqueueEmail(counting, { ...invite, dedupeKey: "account.u1.invite.third" }, { enabled: false }),
    { status: "skipped", reason: "disabled" },
  );
  assert.equal(emailQueueEnabled(db), true);
  db.close();
});
