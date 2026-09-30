import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { GuardrailRepository, ScannerCatalogResponse } from "@csb/shared";
import {
  ensureConnectionSchema,
  insertConnection,
  updateConnectionRecord,
  type StoredProviderConnection,
} from "../connections-store.js";
import { ensureAuthSchema } from "../auth/schema.js";
import { createUser, updateUser } from "../auth/user-store.js";
import { ensureGateSchema, insertGateRun, updateGateRun, upsertGuardrailRepository } from "../gate-store.js";
import { createGitHubMonitorRule, ensureGitHubMonitorSchema } from "../github-monitor/store.js";
import { getOpsAlertState, listUnresolvedOpsAlerts } from "./ops-alert-store.js";
import {
  engineAvailability,
  evaluateConnectionAttention,
  evaluateEngineAvailability,
  startOpsEvaluator,
  evaluateDailyCost,
  evaluatePublishRecovery,
  notifyGitHubPublishFailed,
  OPS_ALERT_REPEAT_MS,
  OPS_ENGINE_GRACE_MS,
  opsRecipients,
  stepOpsCondition,
  utcDayBounds,
} from "./ops-notifications.js";
import { ensureEmailSchema } from "./schema.js";
import { DEFAULT_EMAIL_SETTINGS, saveEmailSettings } from "./settings-store.js";
import { setSubscription } from "./subscription-store.js";

const T0 = new Date("2026-09-30T10:00:00.000Z");
/** A fixed id so the dedupe keys this file asserts on are predictable. */
const RULE_ID = "00000000-0000-4000-8000-000000000001" as const;
const ORIGIN = "https://sentinel.okami.example";
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

/** Its own database: the shared file is written by parallel test processes. */
function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  ensureGateSchema(db);
  ensureAuthSchema(db);
  ensureEmailSchema(db);
  ensureConnectionSchema(db);
  ensureGitHubMonitorSchema(db);
  saveEmailSettings({
    ...DEFAULT_EMAIL_SETTINGS, enabled: true,
    fromAddress: "sentinel@okami.example", smtpHost: "smtp.okami.example", smtpPort: 465,
  }, null, T0, db);
  return db;
}

function admin(db: Database.Database, username = "root@example.com"): string {
  return createUser({ username, displayName: "Root", isAdmin: true }, db).id;
}

function queued(db: Database.Database) {
  return db.prepare("SELECT event, scope, to_address, dedupe_key, subject, text FROM email_outbox ORDER BY created_at, dedupe_key")
    .all() as Array<{ event: string; scope: string | null; to_address: string; dedupe_key: string; subject: string; text: string }>;
}

// --------------------------------------------------------------------------
// The state machine
// --------------------------------------------------------------------------

interface Recorder {
  alerts: string[];
  resolutions: string[];
  step(active: boolean, now: Date, graceMs?: number): ReturnType<typeof stepOpsCondition>;
}

function recorder(db: Database.Database, target = "engine"): Recorder {
  const alerts: string[] = [];
  const resolutions: string[] = [];
  return {
    alerts,
    resolutions,
    step: (active, now, graceMs = 0) => stepOpsCondition(db, {
      event: "ops.engine_unavailable",
      target,
      active,
      now,
      graceMs,
      alert: (activeSince) => alerts.push(activeSince.toISOString()),
      resolve: (activeSince) => resolutions.push(activeSince.toISOString()),
    }),
  };
}

test("a condition has to last five minutes before anybody hears about it", () => {
  const db = fresh();
  const spy = recorder(db);

  assert.equal(spy.step(true, T0, OPS_ENGINE_GRACE_MS), null);
  assert.equal(spy.step(true, at(60_000), OPS_ENGINE_GRACE_MS), null);
  assert.equal(spy.step(true, at(OPS_ENGINE_GRACE_MS - 1), OPS_ENGINE_GRACE_MS), null);
  assert.deepEqual(spy.alerts, []);
  // The row exists from the first sample, because the window is measured from
  // when the condition started and not from when it was first reported.
  assert.equal(getOpsAlertState("ops.engine_unavailable", "engine", db)?.activeSince, T0.toISOString());

  assert.equal(spy.step(true, at(OPS_ENGINE_GRACE_MS), OPS_ENGINE_GRACE_MS), "alerted");
  assert.deepEqual(spy.alerts, [T0.toISOString()]);
  assert.equal(getOpsAlertState("ops.engine_unavailable", "engine", db)?.lastSentAt,
    at(OPS_ENGINE_GRACE_MS).toISOString());
  db.close();
});

test("a blip inside the grace period tells nobody, and leaves nothing behind", () => {
  const db = fresh();
  const spy = recorder(db);
  assert.equal(spy.step(true, T0, OPS_ENGINE_GRACE_MS), null);
  assert.equal(spy.step(false, at(60_000), OPS_ENGINE_GRACE_MS), null);
  assert.deepEqual(spy.alerts, []);
  // Nobody was told, so there is nothing to tell them is over — and no row to
  // make the next blip look like a continuation of this one.
  assert.deepEqual(spy.resolutions, []);
  assert.equal(getOpsAlertState("ops.engine_unavailable", "engine", db), null);
  db.close();
});

test("a persisting condition repeats every six hours and not one sample sooner", () => {
  const db = fresh();
  const spy = recorder(db);
  assert.equal(spy.step(true, T0), "alerted");
  assert.equal(spy.step(true, at(60_000)), null);
  assert.equal(spy.step(true, at(OPS_ALERT_REPEAT_MS - 1_000)), null);
  assert.equal(spy.step(true, at(OPS_ALERT_REPEAT_MS)), "alerted");
  assert.equal(spy.step(true, at(OPS_ALERT_REPEAT_MS + 1_000)), null);
  assert.equal(spy.step(true, at(2 * OPS_ALERT_REPEAT_MS)), "alerted");
  // Three alerts, all naming the same episode start: the reader learns how long
  // this has been going on, not when the last e-mail was sent.
  assert.deepEqual(spy.alerts, [T0.toISOString(), T0.toISOString(), T0.toISOString()]);
  db.close();
});

test("the end of a condition sends exactly one resolution, and a new episode starts clean", () => {
  const db = fresh();
  const spy = recorder(db);
  assert.equal(spy.step(true, T0), "alerted");
  assert.equal(spy.step(false, at(3_600_000)), "resolved");
  assert.deepEqual(spy.resolutions, [T0.toISOString()]);
  // Already resolved: a quiet installation stays quiet.
  assert.equal(spy.step(false, at(3_660_000)), null);
  assert.equal(spy.step(false, at(7_200_000)), null);
  assert.deepEqual(spy.resolutions, [T0.toISOString()]);

  // A second outage is a new episode: it alerts immediately rather than waiting
  // out the six hours of the first one.
  assert.equal(spy.step(true, at(7_260_000)), "alerted");
  assert.deepEqual(spy.alerts, [T0.toISOString(), at(7_260_000).toISOString()]);
  db.close();
});

test("a restart in the middle of an outage does not re-alert, and does not reset the window", () => {
  const db = fresh();
  assert.equal(recorder(db).step(true, T0), "alerted");

  // A brand-new evaluator — no memory of its own — reads the persisted episode.
  const afterRestart = recorder(db);
  assert.equal(afterRestart.step(true, at(60_000)), null);
  assert.equal(afterRestart.step(true, at(OPS_ALERT_REPEAT_MS - 1_000)), null);
  assert.deepEqual(afterRestart.alerts, []);
  assert.equal(afterRestart.step(true, at(OPS_ALERT_REPEAT_MS)), "alerted");
  // And the alert still names when the outage began, not when this process did.
  assert.deepEqual(afterRestart.alerts, [T0.toISOString()]);
  db.close();
});

test("a failed enqueue leaves the window open so the next sample tries again", () => {
  const db = fresh();
  let fail = true;
  const step = (now: Date) => stepOpsCondition(db, {
    event: "ops.engine_unavailable", target: "engine", active: true, now,
    alert: () => { if (fail) throw new Error("the outbox is unwritable"); },
    resolve: () => {},
  });
  assert.throws(() => step(T0), /unwritable/);
  // `last_sent_at` was not advanced, because the write and the send share one
  // transaction; the opposite order would swallow the alert silently.
  assert.equal(getOpsAlertState("ops.engine_unavailable", "engine", db)?.lastSentAt, null);
  fail = false;
  assert.equal(step(at(60_000)), "alerted");
  assert.equal(getOpsAlertState("ops.engine_unavailable", "engine", db)?.lastSentAt, at(60_000).toISOString());
  db.close();
});

// --------------------------------------------------------------------------
// Recipients
// --------------------------------------------------------------------------

test("operational alerts reach subscribing administrators and nobody else", () => {
  const db = fresh();
  const root = admin(db);
  const second = admin(db, "second@example.com");
  const member = createUser({ username: "ana@example.com", displayName: "Ana", isAdmin: false }, db);
  const addressless = createUser({ username: "operator", displayName: "Operator", isAdmin: true }, db);
  void member;
  void addressless;

  assert.deepEqual(
    opsRecipients("ops.daily_cost", db).map((recipient) => recipient.userId).sort(),
    [root, second].sort(),
  );
  setSubscription(second, "ops", "ops.daily_cost", false, db);
  assert.deepEqual(opsRecipients("ops.daily_cost", db).map((recipient) => recipient.userId), [root]);
  // Switching one operational event off leaves the others alone.
  assert.equal(opsRecipients("ops.engine_unavailable", db).length, 2);

  updateUser(root, { status: "disabled" }, db);
  assert.deepEqual(opsRecipients("ops.engine_unavailable", db).map((recipient) => recipient.userId), [second]);
  db.close();
});

// --------------------------------------------------------------------------
// Connections
// --------------------------------------------------------------------------

function connection(id: string, name: string): StoredProviderConnection {
  return {
    id, scopeId: "local", name, providerKind: "openai", routeKind: "openai-api",
    transport: "http", authKind: "api-key", protocol: "openai-responses", status: "ready",
    modelSelectionMode: "explicit", defaultModelId: "gpt-5", lastTestedAt: null,
    lastModelSyncAt: null, modelCatalogStale: false, credentialRef: null,
    display: {
      providerLabel: "OpenAI", routeLabel: "API", secretConfigured: true,
      endpointConfigured: true, endpointKind: "preset",
    },
  } as unknown as StoredProviderConnection;
}

test("a connection that degrades alerts, and one that recovers resolves", () => {
  const db = fresh();
  admin(db);
  insertConnection(connection("conn-1", "OpenRouter principal"), db);
  insertConnection(connection("conn-2", "Anthropic"), db);

  // Both ready: nothing at all, and no state to remember.
  assert.deepEqual(evaluateConnectionAttention({ database: db, now: T0, origin: ORIGIN }), [null, null]);
  assert.deepEqual(listUnresolvedOpsAlerts("ops.connection_attention", db), []);

  updateConnectionRecord("conn-1", { status: "degraded" }, db);
  assert.deepEqual(
    evaluateConnectionAttention({ database: db, now: at(60_000), origin: ORIGIN }),
    ["alerted", null],
  );
  let rows = queued(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, "ops.connection_attention");
  assert.equal(rows[0]!.scope, "ops");
  assert.ok(rows[0]!.text.includes("OpenRouter principal"));
  assert.ok(rows[0]!.text.includes("degradada"));

  // Still degraded a minute later: the six-hour window keeps the inbox quiet.
  assert.deepEqual(
    evaluateConnectionAttention({ database: db, now: at(120_000), origin: ORIGIN }),
    [null, null],
  );
  assert.equal(queued(db).length, 1);

  updateConnectionRecord("conn-1", { status: "ready" }, db);
  assert.deepEqual(
    evaluateConnectionAttention({ database: db, now: at(180_000), origin: ORIGIN }),
    ["resolved", null],
  );
  rows = queued(db);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.event === "ops.connection_attention.resolved"));
  db.close();
});

test("a deleted connection is a resolution, not a condition that persists for ever", () => {
  const db = fresh();
  admin(db);
  insertConnection(connection("conn-1", "OpenRouter principal"), db);
  updateConnectionRecord("conn-1", { status: "expired" }, db);
  assert.deepEqual(evaluateConnectionAttention({ database: db, now: T0, origin: ORIGIN }), ["alerted"]);

  db.prepare("DELETE FROM provider_connections WHERE id = 'conn-1'").run();
  // The connection is gone from every list of broken ones; the alert state is the
  // only record that it was ever broken, which is why the evaluator reads it.
  assert.deepEqual(evaluateConnectionAttention({ database: db, now: at(60_000), origin: ORIGIN }), ["resolved"]);
  assert.deepEqual(listUnresolvedOpsAlerts("ops.connection_attention", db), []);
  db.close();
});

test("a connection being set up is not an operational failure", () => {
  const db = fresh();
  admin(db);
  insertConnection(connection("conn-1", "Half-finished"), db);
  for (const status of ["draft", "authentication-required", "testing", "ready"] as const) {
    updateConnectionRecord("conn-1", { status }, db);
    assert.deepEqual(
      evaluateConnectionAttention({ database: db, now: T0, origin: ORIGIN }), [null], status,
    );
  }
  assert.equal(queued(db).length, 0);
  db.close();
});

// --------------------------------------------------------------------------
// The daily cost ceiling
// --------------------------------------------------------------------------

function repository(db: Database.Database, key: string): void {
  upsertGuardrailRepository({
    repositoryKey: key, repositoryPath: null, source: "github", displayName: "sentinel",
    defaultBranch: "main", defaultExecutor: "sentinel-managed", remoteOwner: "okami",
    remoteName: "sentinel", githubConnectionId: "conn-1", githubInstallationId: "inst-1",
    githubRepositoryId: "repo-1", enabled: true, policyPath: ".okami/guardrails.json",
  } as unknown as GuardrailRepository, db);
}

function rule(db: Database.Database, repositoryKey: string, dailyCeiling: number): string {
  return createGitHubMonitorRule({
    repositoryKey, connectionId: "conn-1", installationId: "inst-1", repositoryId: "repo-1",
    executor: "sentinel-managed", scanner: null, costCeilingUsd: 1,
    dailyCostCeilingUsd: dailyCeiling, followBranches: ["main"], checkoutMode: "none",
    enabled: true,
  }, db, T0.toISOString(), RULE_ID).id;
}

function reserve(db: Database.Database, ruleId: string, repositoryKey: string, usd: number, index: number, when: Date): void {
  db.prepare(`INSERT INTO github_monitor_events
    (id, rule_id, repository_key, rule_revision, kind, status, head_sha, head_ref,
     target_identity, cost_ceiling_usd, detected_at, dispatched_at)
    VALUES (?, ?, ?, 1, 'push', 'launched', ?, 'main', ?, ?, ?, ?)`)
    .run(`event-${index}`, ruleId, repositoryKey, "a".repeat(40), `target-${index}`, usd,
      when.toISOString(), when.toISOString());
}

test("a daily ceiling crossing sends one message per threshold per day", () => {
  const db = fresh();
  admin(db);
  repository(db, "okami/one");
  const ruleId = rule(db, "okami/one", 10);

  // Below 80%: nothing.
  reserve(db, ruleId, "okami/one", 7, 1, T0);
  assert.equal(evaluateDailyCost({ database: db, now: T0, origin: ORIGIN }), 0);

  // 80%: one message.
  reserve(db, ruleId, "okami/one", 1, 2, T0);
  assert.equal(evaluateDailyCost({ database: db, now: T0, origin: ORIGIN }), 1);
  let rows = queued(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.dedupe_key.startsWith(`ops.daily_cost.${RULE_ID}.2026-09-30.80.`), true);
  assert.ok(rows[0]!.text.includes("Percentual: 80%"));

  // Still at 80%, re-evaluated a hundred times: the unique key is the guarantee,
  // not a timer, so a restart cannot produce a second one either.
  for (let index = 0; index < 5; index += 1) {
    assert.equal(evaluateDailyCost({ database: db, now: at(index * 60_000), origin: ORIGIN }), 0);
  }
  assert.equal(queued(db).length, 1);

  // 100%: a second, different message.
  reserve(db, ruleId, "okami/one", 2, 3, T0);
  assert.equal(evaluateDailyCost({ database: db, now: at(600_000), origin: ORIGIN }), 1);
  rows = queued(db);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.dedupe_key.startsWith(`ops.daily_cost.${RULE_ID}.2026-09-30.100.`)));
  assert.equal(evaluateDailyCost({ database: db, now: at(660_000), origin: ORIGIN }), 0);

  // The next UTC day is a fresh ceiling with fresh keys, and no reservations yet.
  const tomorrow = new Date("2026-10-01T09:00:00.000Z");
  assert.equal(utcDayBounds(tomorrow).day, "2026-10-01");
  assert.equal(evaluateDailyCost({ database: db, now: tomorrow, origin: ORIGIN }), 0);
  reserve(db, ruleId, "okami/one", 10, 4, tomorrow);
  assert.equal(evaluateDailyCost({ database: db, now: tomorrow, origin: ORIGIN }), 1);
  assert.ok(queued(db).some((row) => row.dedupe_key.includes("2026-10-01.100.")));
  db.close();
});

test("a jump straight past both thresholds says the useful one only", () => {
  const db = fresh();
  admin(db);
  repository(db, "okami/one");
  const ruleId = rule(db, "okami/one", 10);
  reserve(db, ruleId, "okami/one", 10, 1, T0);
  assert.equal(evaluateDailyCost({ database: db, now: T0, origin: ORIGIN }), 1);
  const rows = queued(db);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.dedupe_key.includes(".100."));
  db.close();
});

test("a disabled rule and a rule without a ceiling are never evaluated", () => {
  const db = fresh();
  admin(db);
  repository(db, "okami/one");
  const ruleId = rule(db, "okami/one", 10);
  reserve(db, ruleId, "okami/one", 10, 1, T0);
  db.prepare("UPDATE github_monitor_rules SET enabled = 0 WHERE id = ?").run(ruleId);
  assert.equal(evaluateDailyCost({ database: db, now: T0, origin: ORIGIN }), 0);

  db.prepare("UPDATE github_monitor_rules SET enabled = 1, daily_cost_ceiling_usd = NULL, cost_ceiling_usd = NULL WHERE id = ?")
    .run(ruleId);
  assert.equal(evaluateDailyCost({ database: db, now: T0, origin: ORIGIN }), 0);
  assert.equal(queued(db).length, 0);
  db.close();
});

// --------------------------------------------------------------------------
// A GitHub check that never arrived
// --------------------------------------------------------------------------

function gateRow(db: Database.Database, id: string): void {
  repository(db, "okami/one");
  insertGateRun({
    id, repositoryKey: "okami/one", repositoryPath: null, source: "github",
    executor: "sentinel-managed", baseRef: "main", headRef: "feature/login",
    resolvedBaseSha: null, resolvedHeadSha: null, policySha: null, pullRequestNumber: 7,
    workflowRunId: null, materializationState: "released", scanLineageHash: null,
    artifactSchemaVersion: 2, scanId: null, status: "completed", outcome: "pass",
    policyVersion: 1, baselineCommit: null, artifactPath: null, publishStatus: "failed",
    publishError: "github_check_publish_failed", publishedAt: null, error: null,
    startedAt: T0.toISOString(), completedAt: T0.toISOString(),
    costCeilingUsd: 5, estimatedUsd: 0,
  } as never, db);
}

test("a publish failure alerts at once, and publishing later resolves it", () => {
  const db = fresh();
  admin(db);
  gateRow(db, "gate-1");

  assert.equal(notifyGitHubPublishFailed("gate-1", { database: db, now: T0, origin: ORIGIN }), "alerted");
  const rows = queued(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, "ops.github_publish_failed");
  assert.ok(rows[0]!.text.includes("Gate: gate-1"));
  assert.ok(rows[0]!.text.includes("Motivo: github_check_publish_failed"));

  // A second failure inside the window is the same condition, not a new one.
  assert.equal(notifyGitHubPublishFailed("gate-1", { database: db, now: at(60_000), origin: ORIGIN }), null);
  assert.equal(queued(db).length, 1);

  // Nothing is tracked that the hook has not seen, so shipping this cannot alert
  // about every gate that failed to publish before the table existed.
  gateRow(db, "gate-old");
  updateGateRun("gate-old", { publishStatus: "failed", publishError: "actions_check_missing" }, db);
  assert.deepEqual(
    evaluatePublishRecovery({ database: db, now: at(120_000), origin: ORIGIN }).length,
    1,
  );
  assert.equal(queued(db).length, 1);

  updateGateRun("gate-1", { publishStatus: "published", publishError: null }, db);
  assert.deepEqual(
    evaluatePublishRecovery({ database: db, now: at(180_000), origin: ORIGIN }),
    ["resolved"],
  );
  assert.ok(queued(db).some((row) => row.event === "ops.github_publish_failed.resolved"));
  assert.deepEqual(listUnresolvedOpsAlerts("ops.github_publish_failed", db), []);
  db.close();
});

test("the publish hook swallows a broken outbox and logs the kind only", () => {
  const db = fresh();
  admin(db);
  gateRow(db, "gate-1");
  db.exec("ALTER TABLE email_outbox RENAME TO email_outbox_hidden");
  const logs: string[] = [];
  assert.equal(
    notifyGitHubPublishFailed("gate-1", { database: db, now: T0, origin: ORIGIN, log: (m) => logs.push(m) }),
    null,
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^Could not queue the publish-failure alert for gate gate-1: SqliteError/);
  assert.ok(!logs[0]!.includes("root@example.com"));
  db.close();
});

test("nothing operational is queued while e-mail is switched off installation-wide", () => {
  const db = fresh();
  saveEmailSettings({ ...DEFAULT_EMAIL_SETTINGS, enabled: false }, null, T0, db);
  admin(db);
  gateRow(db, "gate-1");
  // The alert state is still recorded — the condition happened — but no message
  // is written, so switching e-mail on later cannot release a backlog.
  assert.equal(notifyGitHubPublishFailed("gate-1", { database: db, now: T0, origin: ORIGIN }), "alerted");
  assert.equal(queued(db).length, 0);
  db.close();
});

// --------------------------------------------------------------------------
// The engine, and the loop
// --------------------------------------------------------------------------

function catalog(available: Partial<Record<string, boolean>>): () => Promise<ScannerCatalogResponse> {
  return async () => ({
    refreshedAt: T0.toISOString(),
    scanners: (["codex-security", "mantis", "vulnhunter"] as const).map((engine) => ({
      engine, name: engine, enabled: engine !== "vulnhunter", available: available[engine] === true,
      maturity: "stable", reason: null, sourceUrl: null, authModes: [], models: [],
      efforts: [], modes: [], stageCount: 1, writesTarget: false, executesGeneratedCode: false,
    })) as unknown as ScannerCatalogResponse["scanners"],
  });
}

test("the engine counts as ready through a local scanner or through a reachable connection", async () => {
  const db = fresh();
  admin(db);

  assert.deepEqual(
    await engineAvailability(db, catalog({ "codex-security": true })),
    { available: true, unavailable: [] },
  );
  // No local scanner and no connection: nothing can run.
  assert.deepEqual(
    await engineAvailability(db, catalog({})),
    { available: false, unavailable: ["codex-security", "mantis"] },
  );
  // A deployment that only ever scans over HTTP has no local CLI and must not be
  // reported as permanently broken.
  insertConnection(connection("conn-1", "OpenRouter principal"), db);
  assert.deepEqual(await engineAvailability(db, catalog({})), { available: true, unavailable: [] });
  updateConnectionRecord("conn-1", { status: "expired" }, db);
  assert.deepEqual(
    await engineAvailability(db, catalog({})),
    { available: false, unavailable: ["codex-security", "mantis"] },
  );
  // A scanner that is switched off is not a scanner that is broken.
  assert.deepEqual(
    (await engineAvailability(db, catalog({ mantis: true }))).available,
    true,
  );
  db.close();
});

test("an engine outage waits five minutes, then alerts, then reports its recovery", async () => {
  const db = fresh();
  admin(db);
  const down = { database: db, origin: ORIGIN, catalog: catalog({}) };

  assert.equal(await evaluateEngineAvailability({ ...down, now: T0 }), null);
  assert.equal(await evaluateEngineAvailability({ ...down, now: at(4 * 60_000) }), null);
  assert.equal(queued(db).length, 0);

  assert.equal(await evaluateEngineAvailability({ ...down, now: at(OPS_ENGINE_GRACE_MS) }), "alerted");
  const alerted = queued(db);
  assert.equal(alerted.length, 1);
  assert.equal(alerted[0]!.event, "ops.engine_unavailable");
  assert.ok(alerted[0]!.text.includes("Engines: codex-security, mantis"));
  assert.ok(alerted[0]!.text.includes(`Desde: 2026-09-30 10:00:00 UTC`));

  const up = { database: db, origin: ORIGIN, catalog: catalog({ "codex-security": true }) };
  assert.equal(await evaluateEngineAvailability({ ...up, now: at(OPS_ENGINE_GRACE_MS + 60_000) }), "resolved");
  assert.ok(queued(db).some((row) => row.event === "ops.engine_unavailable.resolved"));
  db.close();
});

test("the evaluator never overlaps itself, and a tick that throws leaves the loop working", async () => {
  const db = fresh();
  admin(db);
  gateRow(db, "gate-1");
  updateGateRun("gate-1", { publishStatus: "failed", publishError: "actions_check_missing" }, db);
  notifyGitHubPublishFailed("gate-1", { database: db, now: T0, origin: ORIGIN });
  db.prepare("DELETE FROM email_outbox").run();

  const logs: string[] = [];
  let clockCalls = 0;
  const evaluator = startOpsEvaluator({
    database: db,
    origin: ORIGIN,
    catalog: catalog({ "codex-security": true }),
    // A clock that throws once, before the first `await`: the overlap guard must
    // not be left armed, or the loop would be dead for the life of the process.
    now: undefined,
    log: (message) => logs.push(message),
    intervalMs: 24 * 3_600_000,
  });
  try {
    const broken = startOpsEvaluator({
      database: db,
      origin: ORIGIN,
      log: (message) => logs.push(message),
      intervalMs: 24 * 3_600_000,
      get catalog() {
        clockCalls += 1;
        if (clockCalls === 1) throw new Error("BrokenProbe");
        return catalog({ "codex-security": true });
      },
    });
    try {
      // The first tick's failure is logged by kind, not by message.
      assert.equal(await broken.tick(), null);
      assert.deepEqual(logs, ["Operational evaluator tick failed: Error"]);
      // And the next one works, which is the whole point.
      const recovered = await broken.tick();
      assert.ok(recovered !== null);
    } finally {
      await broken.stop();
    }

    // No overlap: a second call while one is in flight returns `null` rather than
    // running a second pass over the same conditions.
    const first = evaluator.tick();
    assert.equal(await evaluator.tick(), null);
    assert.ok(await first !== null);
    await evaluator.stop();
    // A stopped evaluator does nothing at all.
    assert.equal(await evaluator.tick(), null);
  } finally {
    await evaluator.stop();
    db.close();
  }
});
