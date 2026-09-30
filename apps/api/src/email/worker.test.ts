import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import Database from "better-sqlite3";
import { SMTPServer } from "smtp-server";
import { ensureAuthSchema } from "../auth/schema.js";
import { createUser, updateUser } from "../auth/user-store.js";
import type { EmailCredentialStore, EmailProviderSecret } from "../credentials/system-email-credential-store.js";
import { enqueueEmail } from "./enqueue.js";
import { claimDueEmails, insertOutboxRow, listEmailDeliveries, requeueSendingEmails } from "./outbox-store.js";
import { ensureEmailSchema } from "./schema.js";
import { DEFAULT_EMAIL_SETTINGS, saveEmailSettings } from "./settings-store.js";
import { createSmtpTransport } from "./smtp-transport.js";
import {
  EMAIL_MAX_ATTEMPTS,
  EMAIL_RETENTION_DAYS,
  emailCancellationReason,
  nextEmailAttemptAt,
  runEmailWorkerTick,
  startEmailWorker,
  sweepEmailRetention,
} from "./worker.js";
import { emailTransportError, type EmailMessage, type EmailTransport } from "./transport.js";

class NoSecrets implements EmailCredentialStore {
  async put(): Promise<void> {}
  async get(): Promise<EmailProviderSecret | null> { return null; }
  async delete(): Promise<void> {}
}

function fresh(settings: Partial<typeof DEFAULT_EMAIL_SETTINGS> = {}): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(db);
  ensureEmailSchema(db);
  saveEmailSettings({
    ...DEFAULT_EMAIL_SETTINGS, enabled: true, fromAddress: "sentinel@okami.example",
    smtpHost: "127.0.0.1", smtpPort: 2525, smtpSecurity: "none", smtpUsername: null,
    ...settings,
  }, null, new Date("2026-09-30T09:00:00.000Z"), db);
  return db;
}

/** A transport that records what it was handed and fails when told to. */
function fakeTransport(): {
  transport: () => EmailTransport;
  sent: EmailMessage[];
  fail: (failure: "transient" | "permanent" | "unknown" | null) => void;
} {
  const sent: EmailMessage[] = [];
  let failure: "transient" | "permanent" | "unknown" | null = null;
  return {
    sent,
    fail: (value) => { failure = value; },
    transport: () => ({
      async send(message) {
        if (failure === "transient") throw emailTransportError("provider_unavailable", "relay is down");
        if (failure === "permanent") throw emailTransportError("recipient_rejected", "no such mailbox");
        if (failure === "unknown") throw new Error("something else entirely");
        sent.push(message);
        return { providerMessageId: `provider-${sent.length}` };
      },
    }),
  };
}

let sequence = 0;
const queued = (db: Database.Database, now: Date, overrides: Record<string, unknown> = {}) =>
  enqueueEmail(db, {
    event: "account.password_changed",
    dedupeKey: `account.u1.password_changed.${now.toISOString()}.${(sequence += 1)}`,
    userId: null,
    toAddress: "ana@example.com",
    locale: "pt-BR",
    data: { at: now },
    now,
    origin: null,
    ...overrides,
  } as never);

const only = (db: Database.Database) => listEmailDeliveries(200, db)[0]!;

test("claims the due queue, sends it and marks every row delivered", async () => {
  const db = fresh();
  const now = new Date("2026-09-30T10:00:00.000Z");
  // All due at the same instant: the batch, not the schedule, is what is under
  // test here, and a row queued a second into the future is correctly not due.
  for (let i = 0; i < 12; i += 1) queued(db, now);
  const { transport, sent } = fakeTransport();

  const first = await runEmailWorkerTick({ database: db, now: () => now, secrets: new NoSecrets(), transport, log: () => {} });
  assert.deepEqual(first, { skipped: null, sent: 10, retried: 0, failed: 0, cancelled: 0 });
  assert.equal(sent.length, 10);
  // The outbox id is the provider's idempotency key, so a retry is the same message.
  assert.match(sent[0]!.idempotencyKey, /^out_/);
  const delivered = listEmailDeliveries(200, db).filter((row) => row.status === "sent");
  assert.equal(delivered.length, 10);
  assert.equal(delivered[0]!.providerMessageId?.startsWith("provider-"), true);
  assert.ok(delivered[0]!.sentAt);

  const second = await runEmailWorkerTick({ database: db, now: () => now, secrets: new NoSecrets(), transport, log: () => {} });
  assert.equal(second.sent, 2);
  const third = await runEmailWorkerTick({ database: db, now: () => now, secrets: new NoSecrets(), transport, log: () => {} });
  assert.deepEqual(third, { skipped: "empty", sent: 0, retried: 0, failed: 0, cancelled: 0 });
});

test("a transient failure walks the 1 min, 5 min, 30 min, 2 h schedule and gives up on the fifth attempt", async () => {
  const db = fresh();
  const start = new Date("2026-09-30T10:00:00.000Z");
  queued(db, start);
  const { transport, fail } = fakeTransport();
  fail("transient");

  // Each delay is measured from the attempt that just failed, so the stamps are
  // cumulative: 1 min, then 5, then 30, then 2 h.
  const expected = ["10:01:00", "10:06:00", "10:36:00", "12:36:00"];
  let clock = start;
  for (const [index, at] of expected.entries()) {
    const tick = await runEmailWorkerTick({ database: db, now: () => clock, secrets: new NoSecrets(), transport, log: () => {} });
    assert.deepEqual(tick, { skipped: null, sent: 0, retried: 1, failed: 0, cancelled: 0 }, `attempt ${index + 1}`);
    const row = only(db);
    assert.equal(row.status, "queued");
    assert.equal(row.attempts, index + 1);
    assert.equal(row.nextAttemptAt, `2026-09-30T${at}.000Z`);
    assert.match(row.lastError ?? "", /provider is unavailable.*relay is down/);
    // Nothing is claimed before it is due.
    assert.equal(claimDueEmails(10, clock, db).length, 0);
    assert.equal(requeueSendingEmails(clock, db), 0);
    clock = new Date(`2026-09-30T${at}.000Z`);
  }

  const last = await runEmailWorkerTick({ database: db, now: () => clock, secrets: new NoSecrets(), transport, log: () => {} });
  assert.deepEqual(last, { skipped: null, sent: 0, retried: 0, failed: 1, cancelled: 0 });
  const dead = only(db);
  assert.equal(dead.status, "failed");
  assert.equal(dead.attempts, EMAIL_MAX_ATTEMPTS);
  assert.equal(dead.nextAttemptAt, null);
  assert.match(dead.lastError ?? "", /provider is unavailable.*relay is down/);

  assert.equal(nextEmailAttemptAt(0, start), "2026-09-30T10:01:00.000Z");
  assert.equal(nextEmailAttemptAt(3, start), "2026-09-30T12:00:00.000Z");
  assert.equal(nextEmailAttemptAt(1, start), "2026-09-30T10:05:00.000Z");
  assert.equal(nextEmailAttemptAt(4, start), null);
});

test("a permanent failure counts as an attempt and stops there, with the error kept", async () => {
  const db = fresh();
  const now = new Date("2026-09-30T10:00:00.000Z");
  queued(db, now);
  const { transport, fail } = fakeTransport();
  fail("permanent");

  const tick = await runEmailWorkerTick({ database: db, now: () => now, secrets: new NoSecrets(), transport, log: () => {} });
  assert.deepEqual(tick, { skipped: null, sent: 0, retried: 0, failed: 1, cancelled: 0 });
  const row = only(db);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 1);
  assert.equal(row.nextAttemptAt, null);
  assert.match(row.lastError ?? "", /rejected the recipient address.*no such mailbox/);
});

test("an error the transport did not classify is transient, because it may be the process's own", async () => {
  const db = fresh();
  const now = new Date("2026-09-30T10:00:00.000Z");
  queued(db, now);
  const { transport, fail } = fakeTransport();
  fail("unknown");
  const logged: string[] = [];

  await runEmailWorkerTick({ database: db, now: () => now, secrets: new NoSecrets(), transport, log: (m) => logged.push(m) });
  const row = only(db);
  assert.equal(row.status, "queued");
  assert.equal(row.nextAttemptAt, "2026-09-30T10:01:00.000Z");
  // The log names the row and the provider's verdict, never the recipient or the body.
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /^E-mail out_[\w-]+ \(account\.password_changed\) will retry: provider_unavailable$/);
  assert.equal(logged[0]!.includes("ana@example.com"), false);
});

test("rows a crash left claimed go back to the queue when the worker starts", async () => {
  const db = fresh();
  const now = new Date("2026-09-30T10:00:00.000Z");
  const stuck = insertOutboxRow({
    event: "account.locked", dedupeKey: "account.u1.locked.x", userId: null,
    toAddress: "ana@example.com", locale: "pt-BR", subject: "s", html: "<p>s</p>", text: "s",
    status: "sending", nextAttemptAt: null,
  }, now, db)!;
  assert.equal(claimDueEmails(10, now, db).length, 0);

  const { transport, sent } = fakeTransport();
  const worker = startEmailWorker({
    database: db, now: () => now, secrets: new NoSecrets(), transport, log: () => {}, intervalMs: 60_000,
  });
  assert.equal((db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(stuck) as { status: string }).status, "queued");
  const tick = await worker.tick();
  await worker.stop();
  assert.equal(tick?.sent, 1);
  assert.equal(sent.length, 1);
});

test("a message whose account is no longer active is cancelled instead of sent", async () => {
  const db = fresh();
  const now = new Date("2026-09-30T10:00:00.000Z");
  const disabled = createUser({ username: "ana", displayName: "Ana", isAdmin: false }, db);
  const active = createUser({ username: "carla", displayName: "Carla", isAdmin: false }, db);
  for (const user of [disabled, active]) {
    queued(db, now, {
      userId: user.id, toAddress: `${user.username}@example.com`,
      dedupeKey: `account.${user.id}.password_changed.1`,
    });
  }
  updateUser(disabled.id, { status: "disabled" }, db);

  const { transport, sent } = fakeTransport();
  const tick = await runEmailWorkerTick({ database: db, now: () => now, secrets: new NoSecrets(), transport, log: () => {} });
  assert.deepEqual(tick, { skipped: null, sent: 1, retried: 0, failed: 0, cancelled: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "carla@example.com");
  const cancelled = listEmailDeliveries(200, db).filter((row) => row.status === "cancelled");
  assert.deepEqual(cancelled.map((row) => row.lastError), ["The account is disabled."]);

  // An id that resolves to nothing is cancelled too — the case a restored
  // backup or a future account deletion produces.
  assert.equal(emailCancellationReason({
    id: "x", event: "account.locked", userId: "gone", toAddress: "a@b.example",
    locale: "pt-BR", subject: "s", html: "s", text: "s", attempts: 0,
  }, db), "The account no longer exists.");
  // `email_outbox.user_id` is `ON DELETE SET NULL`, so a deleted account leaves
  // the row unbound rather than dangling, and an unbound row has no account to
  // check: the address it was rendered for is all there is.
  db.prepare("DELETE FROM users WHERE id = ?").run(active.id);
  assert.equal(emailCancellationReason({
    id: "x", event: "account.locked", userId: null, toAddress: "a@b.example",
    locale: "pt-BR", subject: "s", html: "s", text: "s", attempts: 0,
  }, db), null);
});

test("nothing is claimed while the provider is off, incomplete or unreadable", async () => {
  const now = new Date("2026-09-30T10:00:00.000Z");
  const { transport, sent } = fakeTransport();

  const disabled = fresh({ enabled: false });
  // Enqueue directly: `enqueueEmail` would refuse while the switch is off, and
  // the question here is what the worker does with a row already in the queue.
  insertOutboxRow({
    event: "account.locked", dedupeKey: "d1", userId: null, toAddress: "ana@example.com",
    locale: "pt-BR", subject: "s", html: "s", text: "s",
  }, now, disabled);
  const off = await runEmailWorkerTick({ database: disabled, now: () => now, secrets: new NoSecrets(), transport, log: () => {} });
  assert.equal(off.skipped, "disabled");
  assert.equal(only(disabled).status, "queued");
  assert.equal(only(disabled).attempts, 0);

  const incomplete = fresh({ smtpHost: null, smtpPort: null });
  queued(incomplete, now);
  const half = await runEmailWorkerTick({ database: incomplete, now: () => now, secrets: new NoSecrets(), transport, log: () => {} });
  assert.equal(half.skipped, "not_configured");
  assert.equal(only(incomplete).status, "queued");
  assert.equal(only(incomplete).attempts, 0);

  const locked = fresh({ smtpUsername: "sentinel", secretRef: "email-missing" });
  queued(locked, now);
  const vaultDown: EmailCredentialStore = {
    async put() {}, async delete() {},
    async get() { throw new Error("vault is sealed"); },
  };
  const unreadable = await runEmailWorkerTick({ database: locked, now: () => now, secrets: vaultDown, transport, log: () => {} });
  assert.equal(unreadable.skipped, "secret_unavailable");
  assert.equal(only(locked).attempts, 0);
  assert.equal(sent.length, 0);
});

test("retention deletes delivered and cancelled messages past 90 days and keeps the failures", () => {
  const db = fresh();
  const now = new Date("2026-09-30T10:00:00.000Z");
  const old = new Date(now.getTime() - (EMAIL_RETENTION_DAYS + 1) * 24 * 3_600_000);
  const recent = new Date(now.getTime() - 3 * 24 * 3_600_000);
  const row = (dedupeKey: string, status: string, at: Date, sentAt: Date | null): string => {
    const id = insertOutboxRow({
      event: "account.locked", dedupeKey, userId: null, toAddress: "ana@example.com",
      locale: "pt-BR", subject: "s", html: "s", text: "s",
    }, at, db)!;
    db.prepare("UPDATE email_outbox SET status = ?, sent_at = ? WHERE id = ?")
      .run(status, sentAt?.toISOString() ?? null, id);
    return id;
  };
  row("a", "sent", old, old);
  row("b", "cancelled", old, null);
  row("c", "failed", old, null);
  row("d", "sent", recent, recent);
  row("e", "queued", old, null);

  assert.equal(sweepEmailRetention(now, db), 2);
  assert.deepEqual(listEmailDeliveries(200, db).map((entry) => entry.status).sort(), ["failed", "queued", "sent"]);
  assert.equal(sweepEmailRetention(now, db), 0);
});

test("the loop never overlaps itself and stops cleanly", async () => {
  const db = fresh();
  const now = new Date("2026-09-30T10:00:00.000Z");
  queued(db, now);
  queued(db, now);

  let inFlight = 0;
  let peak = 0;
  const waiting: Array<() => void> = [];
  const transport = (): EmailTransport => ({
    async send() {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => waiting.push(resolve));
      inFlight -= 1;
      return { providerMessageId: null };
    },
  });

  const worker = startEmailWorker({
    database: db, now: () => now, secrets: new NoSecrets(), transport, log: () => {}, intervalMs: 1,
  });
  const first = worker.tick();
  // A second tick while one is in flight is refused, not queued behind it, and
  // neither is the timer's own — a slow provider delays the queue, it does not
  // multiply the workers reading it.
  assert.equal(await worker.tick(), null);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(peak, 1);
  while (waiting.length > 0) {
    waiting.pop()!();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const tick = await first;
  assert.equal(tick?.sent, 2);
  assert.equal(peak, 1);

  const stopping = worker.stop();
  assert.equal(await worker.tick(), null);
  await stopping;
  assert.equal(listEmailDeliveries(200, db).filter((row) => row.status === "sent").length, 2);
});

test("a queued message reaches a real SMTP relay through the loop", async (t) => {
  const received: string[] = [];
  const server = new SMTPServer({
    disabledCommands: ["STARTTLS"], authOptional: true, hideSTARTTLS: true,
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => { received.push(Buffer.concat(chunks).toString("utf8")); callback(); });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server.server, "listening");
  const address = server.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const db = fresh({ smtpPort: address.port });
  const now = new Date("2026-09-30T10:00:00.000Z");
  const result = enqueueEmail(db, {
    event: "account.new_login",
    dedupeKey: "account.u1.new_login.2026-09-30T10:00:00.000Z",
    userId: null,
    toAddress: "ana@example.com",
    locale: "pt-BR",
    data: { at: now, ip: "203.0.113.7", browser: "Firefox · macOS" },
    now,
    origin: "https://sentinel.okami.example",
  });
  assert.equal(result.status, "queued");

  const worker = startEmailWorker({
    database: db, now: () => now, secrets: new NoSecrets(),
    transport: (config) => createSmtpTransport({ ...config, timeoutMs: 5_000 }),
    log: () => {}, intervalMs: 60_000,
  });
  const tick = await worker.tick();
  await worker.stop();

  assert.equal(tick?.sent, 1);
  assert.equal(received.length, 1);
  assert.match(received[0]!, /^To: ana@example\.com$/m);
  assert.match(received[0]!, /^From: "?Okami Sentinel"? <sentinel@okami\.example>$/m);
  assert.ok(received[0]!.includes("=?UTF-8?") || /^Subject: .*novo acesso/mi.test(received[0]!));
  const row = only(db);
  assert.equal(row.status, "sent");
  assert.ok(row.providerMessageId);
});
