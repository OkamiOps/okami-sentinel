import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { GateRun, GuardrailRepository, ScanRun } from "@csb/shared";
import { setRepositoryGrant } from "../auth/grant-store.js";
import { ensureAuthSchema } from "../auth/schema.js";
import { createUser, updateUser } from "../auth/user-store.js";
import { ensureGateSchema, upsertGuardrailRepository } from "../gate-store.js";
import { listEmailDeliveries } from "./outbox-store.js";
import {
  gateNotificationEvent,
  notifyGateOutcome,
  notifyScanOutcome,
  repositoryEventRecipients,
  scanNotificationEvent,
} from "./repository-notifications.js";
import { ensureEmailSchema } from "./schema.js";
import { DEFAULT_EMAIL_SETTINGS, saveEmailSettings } from "./settings-store.js";
import { setSubscription } from "./subscription-store.js";
import { emailCancellationReason, EMAIL_ACCESS_LOST_ERROR } from "./worker.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const ORIGIN = "https://sentinel.okami.example";

/** Its own database: the shared file is written by parallel test processes. */
function fresh(): Database.Database {
  const db = new Database(":memory:");
  // Only the columns this module reads: the counts of a linked scan, by column,
  // so a finding never has to be loaded to render a notification.
  db.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, repository_path TEXT, scan_dir TEXT NOT NULL,
    status TEXT NOT NULL, source TEXT NOT NULL,
    severity_critical INTEGER NOT NULL DEFAULT 0, severity_high INTEGER NOT NULL DEFAULT 0,
    severity_medium INTEGER NOT NULL DEFAULT 0, severity_low INTEGER NOT NULL DEFAULT 0,
    severity_info INTEGER NOT NULL DEFAULT 0, severity_unknown INTEGER NOT NULL DEFAULT 0,
    severity_total INTEGER NOT NULL DEFAULT 0
  )`);
  ensureGateSchema(db);
  ensureAuthSchema(db);
  ensureEmailSchema(db);
  saveEmailSettings({
    ...DEFAULT_EMAIL_SETTINGS, enabled: true,
    fromAddress: "sentinel@okami.example", smtpHost: "smtp.okami.example", smtpPort: 465,
  }, null, NOW, db);
  upsertGuardrailRepository({
    repositoryKey: "okami/one", repositoryPath: null, source: "github", displayName: "sentinel",
    defaultBranch: "main", defaultExecutor: "sentinel-managed", remoteOwner: "okami",
    remoteName: "sentinel", githubConnectionId: "conn-1", githubInstallationId: "inst-1",
    githubRepositoryId: "repo-1", enabled: true, policyPath: ".okami/guardrails.json",
  } as unknown as GuardrailRepository, db);
  return db;
}

function gate(overrides: Partial<GateRun> = {}): GateRun {
  return {
    id: "gate-1", repositoryKey: "okami/one", repositoryPath: null, source: "github",
    executor: "sentinel-managed", baseRef: "main", headRef: "feature/login",
    resolvedBaseSha: null, resolvedHeadSha: null, policySha: null, pullRequestNumber: 7,
    workflowRunId: null, materializationState: "released", scanLineageHash: null,
    artifactSchemaVersion: 2, scanId: null, status: "completed", outcome: "blocked",
    policyVersion: 1, baselineCommit: null, artifactPath: null, publishStatus: "not_applicable",
    publishError: null, publishedAt: null, error: null,
    startedAt: "2026-09-30T11:55:00.000Z", completedAt: "2026-09-30T11:59:07.000Z",
    costCeilingUsd: 5, estimatedUsd: 0.42,
    ...overrides,
  } as GateRun;
}

function scan(overrides: Partial<ScanRun> = {}): ScanRun {
  return {
    id: "s-1", displayName: "sentinel", repositoryPath: "/repos/sentinel",
    repositoryKey: "okami/one", revision: "main", scanDir: "/runs/s-1",
    status: "completed", model: "gpt-5", effort: "high", mode: "standard",
    engine: "codex-security", provider: "openai", authMode: "api-key", scannerVersion: null,
    recipeHash: null, startedAt: "2026-09-30T11:00:00.000Z", completedAt: "2026-09-30T11:01:01.000Z",
    durationMs: 61_000,
    cost: { estimatedUsd: 1.5, inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5 },
    severity: { critical: 1, high: 2, medium: 0, low: 0, info: 0, unknown: 0, total: 3 },
    source: "benchmark", pid: null, execution: null,
    ...overrides,
  } as ScanRun;
}

function queued(db: Database.Database) {
  return db.prepare("SELECT event, scope, user_id, to_address, dedupe_key, subject FROM email_outbox ORDER BY dedupe_key")
    .all() as Array<{ event: string; scope: string | null; user_id: string; to_address: string; dedupe_key: string; subject: string }>;
}

test("a terminal gate status maps to exactly one event, and a cancellation to none", () => {
  assert.equal(gateNotificationEvent({ status: "completed", outcome: "blocked" }), "gate.blocked");
  assert.equal(gateNotificationEvent({ status: "completed", outcome: "pass" }), "gate.passed");
  assert.equal(gateNotificationEvent({ status: "completed", outcome: "warning" }), "gate.passed");
  assert.equal(gateNotificationEvent({ status: "completed", outcome: "no_changes" }), "gate.passed");
  assert.equal(gateNotificationEvent({ status: "completed", outcome: "bootstrap" }), "gate.passed");
  assert.equal(gateNotificationEvent({ status: "error", outcome: "error" }), "gate.error");
  assert.equal(gateNotificationEvent({ status: "completed", outcome: "error" }), "gate.error");
  assert.equal(gateNotificationEvent({ status: "cancelled", outcome: "error" }), null);
  assert.equal(gateNotificationEvent({ status: "cancelling", outcome: null }), null);
  assert.equal(gateNotificationEvent({ status: "scanning", outcome: null }), null);

  assert.equal(scanNotificationEvent("completed"), "scan.completed");
  assert.equal(scanNotificationEvent("failed"), "scan.failed");
  assert.equal(scanNotificationEvent("incomplete"), "scan.failed");
  assert.equal(scanNotificationEvent("cancelled"), null);
  assert.equal(scanNotificationEvent("running"), null);
  assert.equal(scanNotificationEvent("queued"), null);
});

test("a gate event reaches every grantee and every administrator, once each", () => {
  const db = fresh();
  const admin = createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  const viewer = createUser({ username: "ana@example.com", displayName: "Ana", isAdmin: false }, db);
  const stranger = createUser({ username: "bruno@example.com", displayName: "Bruno", isAdmin: false }, db);
  setRepositoryGrant(viewer.id, "okami/one", "viewer", null, db);
  void stranger;

  assert.equal(notifyGateOutcome(gate(), { database: db, now: NOW, origin: ORIGIN }), 2);
  const rows = queued(db);
  assert.deepEqual(rows.map((row) => row.to_address).sort(), ["ana@example.com", "root@example.com"]);
  // The design's `gate.<gateId>.<event>`, plus the recipient so each one gets a row.
  assert.deepEqual(rows.map((row) => row.dedupe_key).sort(), [
    `gate.gate-1.gate.blocked.${viewer.id}`,
    `gate.gate-1.gate.blocked.${admin.id}`,
  ].sort());
  assert.deepEqual(new Set(rows.map((row) => row.scope)), new Set(["okami/one"]));
  assert.ok(rows.every((row) => row.event === "gate.blocked"));

  // Observing the same terminal transition again queues nothing: the unique
  // dedupe key is what makes the hook safe to call from more than one path.
  assert.equal(notifyGateOutcome(gate(), { database: db, now: NOW, origin: ORIGIN }), 0);
  assert.equal(queued(db).length, 2);
  db.close();
});

test("a disabled account, a missing address and a switched-off event all receive nothing", () => {
  const db = fresh();
  const admin = createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  const disabled = createUser({ username: "old@example.com", displayName: "Old", isAdmin: false }, db);
  const addressless = createUser({ username: "operator", displayName: "Operator", isAdmin: false }, db);
  const unsubscribed = createUser({ username: "quiet@example.com", displayName: "Quiet", isAdmin: false }, db);
  for (const user of [disabled, addressless, unsubscribed]) {
    setRepositoryGrant(user.id, "okami/one", "maintainer", null, db);
  }
  updateUser(disabled.id, { status: "disabled" }, db);
  setSubscription(unsubscribed.id, "okami/one", "gate.blocked", false, db);

  const recipients = repositoryEventRecipients("okami/one", "gate.blocked", db);
  assert.deepEqual(recipients.map((recipient) => recipient.userId), [admin.id]);

  // And the two events that are off by default reach nobody until somebody asks.
  assert.deepEqual(repositoryEventRecipients("okami/one", "gate.passed", db), []);
  setSubscription(admin.id, "okami/one", "gate.passed", true, db);
  assert.deepEqual(
    repositoryEventRecipients("okami/one", "gate.passed", db).map((recipient) => recipient.userId),
    [admin.id],
  );
  db.close();
});

test("a scan with no repository is an administrators-only event", () => {
  const db = fresh();
  const admin = createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  const viewer = createUser({ username: "ana@example.com", displayName: "Ana", isAdmin: false }, db);
  setRepositoryGrant(viewer.id, "okami/one", "maintainer", null, db);

  assert.equal(
    notifyScanOutcome(scan({ id: "s-loose", repositoryKey: null, status: "failed" }),
      { database: db, now: NOW, origin: ORIGIN }),
    1,
  );
  const rows = queued(db);
  assert.deepEqual(rows.map((row) => row.user_id), [admin.id]);
  assert.deepEqual(rows.map((row) => row.scope), [null]);
  assert.equal(rows[0]!.dedupe_key, `scan.s-loose.scan.failed.${admin.id}`);
  // `scan.completed` is off by default and has no cell for a repository-less
  // scan, so the default is the whole answer.
  assert.equal(
    notifyScanOutcome(scan({ id: "s-loose-2", repositoryKey: null, status: "completed" }),
      { database: db, now: NOW, origin: ORIGIN }),
    0,
  );
  db.close();
});

test("a cancelled scan and a cancelled gate queue nothing at all", () => {
  const db = fresh();
  createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  assert.equal(notifyScanOutcome(scan({ status: "cancelled" }), { database: db, now: NOW, origin: ORIGIN }), 0);
  assert.equal(
    notifyGateOutcome(gate({ status: "cancelled", outcome: null }), { database: db, now: NOW, origin: ORIGIN }),
    0,
  );
  assert.equal(queued(db).length, 0);
  db.close();
});

test("the body carries counts, cost, duration and a link — and never a finding", () => {
  const db = fresh();
  createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  db.prepare(`INSERT INTO runs (id, display_name, scan_dir, status, source,
    severity_critical, severity_high, severity_medium, severity_low, severity_info,
    severity_unknown, severity_total)
    VALUES ('s-9', 'sentinel', '/runs/s-9', 'completed', 'benchmark', 2, 3, 4, 5, 6, 0, 20)`).run();

  notifyGateOutcome(gate({ scanId: "s-9" }), { database: db, now: NOW, origin: ORIGIN });
  const row = db.prepare("SELECT subject, html, text FROM email_outbox").get() as
    { subject: string; html: string; text: string };
  assert.match(row.subject, /gate bloqueado em sentinel/);
  // The display name, not the repository key and never a filesystem path.
  assert.ok(row.text.includes("Repositório: sentinel"));
  assert.equal(row.text.includes("okami/one"), false);
  assert.ok(row.text.includes("Branch: feature/login"));
  assert.ok(row.text.includes("Pull request: #7"));
  assert.ok(row.text.includes("Findings: 20"));
  assert.ok(row.text.includes("Críticos: 2"));
  assert.ok(row.text.includes("Custo: USD 0.42"));
  assert.ok(row.text.includes("Duração: 4m 07s"));
  assert.ok(row.html.includes(`href="${ORIGIN}/guardrails/gate-1"`));
  assert.equal(row.text.includes("/repos/"), false);
  db.close();
});

test("a scan message reads the row it was queued for", () => {
  const db = fresh();
  createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  notifyScanOutcome(scan(), { database: db, now: NOW, origin: ORIGIN });
  const row = db.prepare("SELECT event, text, html FROM email_outbox").get() as
    { event: string; text: string; html: string };
  // `scan.completed` is off by default; the administrator got it because…
  assert.equal(row, undefined);

  setSubscription(
    (db.prepare("SELECT id FROM users").get() as { id: string }).id,
    "okami/one", "scan.completed", true, db,
  );
  notifyScanOutcome(scan(), { database: db, now: NOW, origin: ORIGIN });
  const stored = db.prepare("SELECT event, text, html FROM email_outbox").get() as
    { event: string; text: string; html: string };
  assert.equal(stored.event, "scan.completed");
  assert.ok(stored.text.includes("Resultado: concluído"));
  assert.ok(stored.text.includes("Findings: 3"));
  assert.ok(stored.text.includes("Custo: USD 1.50"));
  assert.ok(stored.text.includes("Duração: 1m 01s"));
  assert.ok(stored.html.includes(`href="${ORIGIN}/scans/s-1"`));
  db.close();
});

test("nothing is queued while e-mail is switched off installation-wide", () => {
  const db = fresh();
  saveEmailSettings({ ...DEFAULT_EMAIL_SETTINGS, enabled: false }, null, NOW, db);
  createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  assert.equal(notifyGateOutcome(gate(), { database: db, now: NOW, origin: ORIGIN }), 0);
  assert.equal(queued(db).length, 0);
  db.close();
});

test("an enqueue that throws is swallowed, logged by kind, and costs the caller nothing", () => {
  const db = fresh();
  createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  // The table the enqueue writes to is gone; the gate and the scan already
  // happened, and a notification must not be able to undo either.
  db.exec("ALTER TABLE email_outbox RENAME TO email_outbox_hidden");
  const logs: string[] = [];
  assert.equal(
    notifyGateOutcome(gate(), { database: db, now: NOW, origin: ORIGIN, log: (m) => logs.push(m) }),
    0,
  );
  assert.equal(
    notifyScanOutcome(scan({ status: "failed" }), { database: db, now: NOW, origin: ORIGIN, log: (m) => logs.push(m) }),
    0,
  );
  assert.equal(logs.length, 2);
  assert.match(logs[0]!, /^Could not queue the completed notification for gate gate-1: SqliteError/);
  assert.match(logs[1]!, /^Could not queue the failed notification for scan s-1: SqliteError/);
  // No address, no subject, no body in the log.
  assert.ok(logs.every((line) => !line.includes("root@example.com")));
  db.close();
});

test("the outbox row lands in the caller's transaction, and rolls back with it", () => {
  const db = fresh();
  createUser({ username: "root@example.com", displayName: "Root", isAdmin: true }, db);
  assert.throws(() => db.transaction(() => {
    assert.equal(notifyGateOutcome(gate(), { database: db, now: NOW, origin: ORIGIN }), 1);
    assert.equal(queued(db).length, 1);
    throw new Error("the gate write failed");
  })(), /the gate write failed/);
  assert.equal(queued(db).length, 0);
  db.close();
});

test("the worker cancels a repository row once its recipient loses the access", async () => {
  const db = fresh();
  const viewer = createUser({ username: "ana@example.com", displayName: "Ana", isAdmin: false }, db);
  setRepositoryGrant(viewer.id, "okami/one", "viewer", null, db);
  assert.equal(notifyGateOutcome(gate(), { database: db, now: NOW, origin: ORIGIN }), 1);
  const row = db.prepare("SELECT id, event, scope, user_id, to_address, locale, subject, html, text, attempts FROM email_outbox")
    .get() as { id: string; event: string; scope: string | null; user_id: string; to_address: string; locale: string; subject: string; html: string; text: string; attempts: number };
  const claim = { ...row, userId: row.user_id, toAddress: row.to_address };

  // Still a viewer: the message goes out.
  assert.equal(emailCancellationReason(claim, db), null);

  setRepositoryGrant(viewer.id, "okami/one", null, null, db);
  assert.equal(emailCancellationReason(claim, db), EMAIL_ACCESS_LOST_ERROR);

  // Promotion to administrator restores the visibility of every repository.
  updateUser(viewer.id, { isAdmin: true }, db);
  assert.equal(emailCancellationReason(claim, db), null);
  // And being disabled outranks both.
  updateUser(viewer.id, { status: "disabled" }, db);
  assert.equal(emailCancellationReason(claim, db), "The account is disabled.");

  // An operational row needs the administrator flag, not a grant.
  updateUser(viewer.id, { status: "active", isAdmin: false }, db);
  assert.match(
    String(emailCancellationReason({ ...claim, event: "ops.daily_cost", scope: "ops" }, db)),
    /no longer an administrator/,
  );
  updateUser(viewer.id, { isAdmin: true }, db);
  assert.equal(emailCancellationReason({ ...claim, event: "ops.daily_cost", scope: "ops" }, db), null);
  // An account message has no scope and is never cancelled for access.
  assert.equal(emailCancellationReason({ ...claim, event: "account.locked", scope: null }, db), null);
  assert.equal(listEmailDeliveries(200, db).length, 1);
  db.close();
});
