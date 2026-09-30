import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureAuthSchema } from "../auth/schema.js";
import { ensureEmailSchema } from "./schema.js";
import {
  EMAIL_DELIVERY_HISTORY_LIMIT,
  insertOutboxRow,
  listEmailDeliveries,
  markEmailFailed,
  markEmailSent,
} from "./outbox-store.js";

/**
 * Its own in-memory database, not the shared `benchmark.db`: the test runner
 * executes files in parallel processes against one data directory, and a store
 * test that truncated the real outbox would race the API test that reads it.
 */
function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(db);
  ensureEmailSchema(db);
  return db;
}

const message = {
  event: "gate.blocked",
  dedupeKey: "gate.g1.gate.blocked",
  userId: null,
  toAddress: "ana@example.com",
  locale: "pt-BR" as const,
  subject: "Gate bloqueado",
  html: "<p>x</p>",
  text: "x",
};

test("a repeated dedupe key enqueues nothing and says so", () => {
  const db = fresh();
  const now = new Date("2026-09-30T10:00:00.000Z");
  const first = insertOutboxRow(message, now, db);
  assert.match(first ?? "", /^out_/);
  assert.equal(insertOutboxRow(message, now, db), null);
  assert.notEqual(insertOutboxRow({ ...message, dedupeKey: "gate.g2.gate.blocked" }, now, db), null);
  assert.equal(listEmailDeliveries(200, db).length, 2);
});

test("a queued message records its schedule, its failures and its delivery", () => {
  const db = fresh();
  const id = insertOutboxRow(message, new Date("2026-09-30T10:00:00.000Z"), db)!;
  const queued = listEmailDeliveries(200, db)[0]!;
  assert.deepEqual(
    { status: queued.status, attempts: queued.attempts, nextAttemptAt: queued.nextAttemptAt, lastError: queued.lastError },
    { status: "queued", attempts: 0, nextAttemptAt: "2026-09-30T10:00:00.000Z", lastError: null },
  );

  markEmailFailed(id, "The provider rejected the credentials.", "2026-09-30T10:01:00.000Z", db);
  const retrying = listEmailDeliveries(200, db)[0]!;
  assert.deepEqual(
    { status: retrying.status, attempts: retrying.attempts, nextAttemptAt: retrying.nextAttemptAt },
    { status: "queued", attempts: 1, nextAttemptAt: "2026-09-30T10:01:00.000Z" },
  );
  assert.equal(retrying.lastError, "The provider rejected the credentials.");

  // No next attempt is what makes the row terminal, and the error stays visible.
  markEmailFailed(id, "Given up.", null, db);
  const dead = listEmailDeliveries(200, db)[0]!;
  assert.deepEqual({ status: dead.status, attempts: dead.attempts, nextAttemptAt: dead.nextAttemptAt }, {
    status: "failed", attempts: 2, nextAttemptAt: null,
  });
  assert.equal(dead.lastError, "Given up.");

  markEmailSent(id, "provider-42", new Date("2026-09-30T10:05:00.000Z"), db);
  const sent = listEmailDeliveries(200, db)[0]!;
  assert.deepEqual(
    { status: sent.status, providerMessageId: sent.providerMessageId, sentAt: sent.sentAt, lastError: sent.lastError, nextAttemptAt: sent.nextAttemptAt },
    { status: "sent", providerMessageId: "provider-42", sentAt: "2026-09-30T10:05:00.000Z", lastError: null, nextAttemptAt: null },
  );
});

test("the history never returns a body, and its limit cannot be raised by a caller", () => {
  const db = fresh();
  insertOutboxRow(message, new Date(), db);
  const entry = listEmailDeliveries(10_000, db)[0]!;
  assert.equal("html" in entry, false);
  assert.equal("text" in entry, false);
  assert.equal(EMAIL_DELIVERY_HISTORY_LIMIT, 200);
  assert.equal(listEmailDeliveries(0, db).length, 1);
  assert.equal(listEmailDeliveries(-5, db).length, 1);
});
