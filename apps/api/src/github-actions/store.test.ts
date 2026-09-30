import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import type {
  GitHubAction,
  GitHubActionEventCreate,
  GitHubActionTargetIdentity,
  WebhookDeliveryRecord,
} from "@csb/shared";

import {
  completeWebhookDelivery,
  disableGitHubActionsForInstallation,
  disableGitHubActionsForRepository,
  failOrphanedGitHubActionDispatches,
  findGitHubActionEventByGateId,
  hasGitHubActionEventForHeadSha,
  recordGitHubActionReconciliation,
  reserveGitHubActionEventDispatch,
  reservedGitHubActionCostForUtcDay,
  countReconciledEventsSince,
  countWebhookDeliveriesSince,
  createGitHubAction,
  createGitHubActionEvent,
  ensureGitHubActionsSchema,
  getGitHubActionEvent,
  gitHubActionEventTargetIdentity,
  hasAnalysedCommit,
  lastVerifiedWebhookDeliveryAt,
  listGitHubActions,
  newestObservedEventAt,
  listGitHubActionEvents,
  listWebhookDeliveries,
  patchGitHubAction,
  patchGitHubActionEvent,
  recordWebhookDelivery,
  recordWebhookSecretStored,
  rerunTargetIdentity,
  supersedeQueuedEvents,
  webhookSecretStoredAt,
} from "./store.js";

test("only the minting helpers produce a target identity", () => {
  // @ts-expect-error a hand-built key would buy the same commit twice.
  const handBuilt: GitHubActionTargetIdentity = "pr:7@deadbeef";
  assert.equal(typeof handBuilt, "string");

  const minted = gitHubActionEventTargetIdentity({
    kind: "pull_request", headSha: "c".repeat(40), headRef: "feature/login", pullRequestNumber: 7,
  });
  assert.equal(minted, `pr:7@${"c".repeat(40)}`);
  // `check_run.rerequested` is the one event exempt from the repeated-commit rule.
  assert.equal(rerunTargetIdentity(minted, "9001"), `pr:7@${"c".repeat(40)}#rerun:9001`);
  assert.throws(
    () => gitHubActionEventTargetIdentity({
      kind: "pull_request", headSha: "c".repeat(40), headRef: "feature/login", pullRequestNumber: null,
    }),
    /github_action_event_pull_request_number_required/,
  );
  assert.equal(
    gitHubActionEventTargetIdentity({ kind: "push", headSha: "d".repeat(40), headRef: "refs/heads/main" }),
    `push:main@${"d".repeat(40)}`,
  );
});

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)`);
  db.prepare("INSERT INTO guardrail_repositories VALUES ('github:1')").run();
  ensureGitHubActionsSchema(db);
  return db;
}

test("allows several actions on one repository", () => {
  const db = memoryDb();
  const base = {
    repositoryKey: "github:1", connectionId: "c1", installationId: "i1", repositoryId: "1",
    executor: "sentinel-managed" as const, scanner: null, costCeilingUsd: 2,
    dailyCostCeilingUsd: 10, enabled: false, includeForks: false, createdBy: "u1",
  };
  createGitHubAction({ ...base, name: "PR", triggerKind: "pull_request", branchPatterns: ["main"] }, db);
  createGitHubAction({ ...base, name: "Push", triggerKind: "push", branchPatterns: ["main"] }, db);
  createGitHubAction({ ...base, name: "Release", triggerKind: "push", branchPatterns: ["release/**"] }, db);
  assert.equal(listGitHubActions({ repositoryKey: "github:1" }, db).length, 3);
});

test("refuses an action without a cost ceiling", () => {
  const db = memoryDb();
  assert.throws(() => createGitHubAction({
    repositoryKey: "github:1", name: "PR", triggerKind: "pull_request", branchPatterns: ["main"],
    connectionId: "c1", installationId: "i1", repositoryId: "1", executor: "sentinel-managed",
    scanner: null, costCeilingUsd: 0, dailyCostCeilingUsd: null, enabled: false,
    includeForks: false, createdBy: "u1",
  }, db));
});

const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);

function pullRequestAction(db: Database.Database): GitHubAction {
  return createGitHubAction({
    repositoryKey: "github:1", name: "PR", triggerKind: "pull_request", branchPatterns: ["main"],
    connectionId: "c1", installationId: "i1", repositoryId: "1", executor: "sentinel-managed",
    scanner: null, costCeilingUsd: 2, dailyCostCeilingUsd: 10, enabled: true,
    includeForks: false, createdBy: "u1",
  }, db);
}

function pullRequestEvent(
  action: GitHubAction,
  headSha: string,
  detectedAt: string,
): GitHubActionEventCreate {
  return {
    actionId: action.id,
    repositoryKey: action.repositoryKey,
    actionRevision: action.revision,
    origin: "webhook",
    deliveryId: null,
    kind: "pull_request",
    status: "queued",
    headSha,
    baseRef: "main",
    headRef: "feature/login",
    pullRequestNumber: 7,
    targetIdentity: gitHubActionEventTargetIdentity({
      kind: "pull_request", headSha, headRef: "feature/login", pullRequestNumber: 7,
    }),
    title: "Login",
    gateId: null,
    costCeilingUsd: 2,
    reason: null,
    error: null,
    observedAt: null,
    detectedAt,
  };
}

test("supersedes a queued event when a newer commit lands on the same PR", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  const first = createGitHubActionEvent(pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"), db);
  const second = createGitHubActionEvent(pullRequestEvent(action, SHA_NEW, "2026-09-30T10:05:00.000Z"), db);
  assert.ok(first);
  assert.ok(second);

  const superseded = supersedeQueuedEvents({
    actionId: action.id,
    pullRequestNumber: 7,
    exceptHeadSha: SHA_NEW,
    reason: "head_superseded",
  }, db, "2026-09-30T10:05:01.000Z");

  assert.equal(superseded, 1);
  const reread = getGitHubActionEvent(first.id, db)!;
  assert.equal(reread.status, "superseded");
  assert.equal(reread.reason, "head_superseded");
  assert.equal(reread.completedAt, "2026-09-30T10:05:01.000Z");
  assert.equal(getGitHubActionEvent(second.id, db)!.status, "queued");
});

test("supersedes the queue of a closed pull request", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  const event = createGitHubActionEvent(pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"), db)!;
  const superseded = supersedeQueuedEvents({
    actionId: action.id,
    pullRequestNumber: 7,
    exceptHeadSha: "",
    reason: "pull_request_closed",
  }, db);
  assert.equal(superseded, 1);
  assert.equal(getGitHubActionEvent(event.id, db)!.reason, "pull_request_closed");
});

test("rejects a second event for the same target identity at the same revision", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  assert.ok(createGitHubActionEvent(pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"), db));
  assert.equal(
    createGitHubActionEvent(pullRequestEvent(action, SHA_OLD, "2026-09-30T10:01:00.000Z"), db),
    null,
  );
});

test("accepts the same target identity again after a revision bump", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  assert.ok(createGitHubActionEvent(pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"), db));

  const patched = patchGitHubAction(action.id, { branchPatterns: ["main", "release/**"] }, db)!;
  assert.equal(patched.revision, 2);
  assert.equal(patched.baselineInitializedAt, null);

  assert.ok(createGitHubActionEvent(pullRequestEvent(patched, SHA_OLD, "2026-09-30T10:02:00.000Z"), db));
});

test("renaming an action leaves its revision and its queue alone", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  const renamed = patchGitHubAction(action.id, { name: "Pull requests", enabled: false }, db)!;
  assert.equal(renamed.revision, 1);
  assert.equal(renamed.name, "Pull requests");
  assert.equal(renamed.enabled, false);
});

test("reports a commit already analysed by the action", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  const event = createGitHubActionEvent(pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"), db)!;
  assert.equal(hasAnalysedCommit(action.id, SHA_OLD, db), false);

  patchGitHubActionEvent(event.id, { status: "launched", gateId: "gate-1" }, db);
  assert.equal(hasAnalysedCommit(action.id, SHA_OLD, db), true);
  assert.equal(hasAnalysedCommit(action.id, SHA_NEW, db), false);
});

function delivery(index: number, receivedAt: string): WebhookDeliveryRecord {
  return {
    deliveryId: `delivery-${index}`,
    connectionId: "c1",
    event: "pull_request",
    action: "synchronize",
    repositoryKey: "github:1",
    installationId: "i1",
    headSha: SHA_NEW,
    outcome: "processed",
    reason: null,
    matchedActionIds: [],
    eventIds: [],
    receivedAt,
    durationMs: 12,
  };
}

test("records a delivery once and reports the redelivery as duplicate", () => {
  const db = memoryDb();
  const first = delivery(1, "2026-09-30T10:00:00.000Z");
  assert.equal(recordWebhookDelivery(first, db), "recorded");
  assert.equal(recordWebhookDelivery(first, db), "duplicate");
  assert.equal(listWebhookDeliveries(10, db).length, 1);
  assert.deepEqual(
    countWebhookDeliveriesSince("2026-09-30T09:00:00.000Z", db),
    { processed: 1, ignored: 0, failed: 0 },
  );
  assert.deepEqual(
    countWebhookDeliveriesSince("2026-09-30T11:00:00.000Z", db),
    { processed: 0, ignored: 0, failed: 0 },
  );
});

function deliveryCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS total FROM github_webhook_deliveries")
    .get() as { total: number }).total;
}

test("prunes deliveries beyond the retention ceiling", () => {
  const db = memoryDb();
  const base = Date.parse("2026-09-01T00:00:00.000Z");
  // A fresh handle prunes on its first delivery and every hundredth after, so
  // 2001 lands the last prune on the last insert and the ceiling is exact.
  const total = 2001;
  for (let index = 0; index < total; index += 1) {
    recordWebhookDelivery(delivery(index, new Date(base + index * 1000).toISOString()), db);
  }
  assert.equal(deliveryCount(db), 2000);
  assert.equal(listWebhookDeliveries(1, db)[0]!.deliveryId, `delivery-${total - 1}`);
  const oldest = db
    .prepare("SELECT delivery_id FROM github_webhook_deliveries ORDER BY received_at ASC LIMIT 1")
    .get() as { delivery_id: string };
  assert.equal(oldest.delivery_id, `delivery-${total - 2000}`);
});

test("prunes once on the first delivery a process records", () => {
  const db = memoryDb();
  const base = Date.parse("2026-09-01T00:00:00.000Z");
  const insert = db.prepare(`
    INSERT INTO github_webhook_deliveries (delivery_id, connection_id, event, outcome, received_at)
    VALUES (?, 'c1', 'push', 'processed', ?)
  `);
  // A process that restarts more often than every hundred deliveries would
  // otherwise never prune, and the table would grow without bound.
  for (let index = 0; index < 2100; index += 1) {
    insert.run(`legacy-${index}`, new Date(base + index * 1000).toISOString());
  }
  assert.equal(recordWebhookDelivery(delivery(9999, "2026-09-30T10:00:00.000Z"), db), "recorded");
  assert.equal(deliveryCount(db), 2000);
});

test("normalises a fully qualified head ref on insert and on supersede", () => {
  const db = memoryDb();
  const action = createGitHubAction({
    repositoryKey: "github:1", name: "Push", triggerKind: "push", branchPatterns: ["main"],
    connectionId: "c1", installationId: "i1", repositoryId: "1", executor: "sentinel-managed",
    scanner: null, costCeilingUsd: 2, dailyCostCeilingUsd: 10, enabled: true,
    includeForks: false, createdBy: "u1",
  }, db);
  const pushEvent = (headSha: string, headRef: string): GitHubActionEventCreate => ({
    actionId: action.id,
    repositoryKey: action.repositoryKey,
    actionRevision: action.revision,
    origin: "webhook",
    deliveryId: null,
    kind: "push",
    status: "queued",
    headSha,
    baseRef: null,
    headRef,
    pullRequestNumber: null,
    targetIdentity: gitHubActionEventTargetIdentity({ kind: "push", headSha, headRef }),
    title: null,
    gateId: null,
    costCeilingUsd: 2,
    reason: null,
    error: null,
    observedAt: null,
    detectedAt: "2026-09-30T10:00:00.000Z",
  });

  const stored = createGitHubActionEvent(pushEvent(SHA_OLD, "refs/heads/main"), db)!;
  assert.equal(stored.headRef, "main");

  assert.ok(createGitHubActionEvent(pushEvent(SHA_NEW, "refs/heads/main"), db));
  // Whatever form the caller holds, the queue it means is the same queue.
  assert.equal(supersedeQueuedEvents({
    actionId: action.id, headRef: "refs/heads/main", exceptHeadSha: SHA_NEW, reason: "head_superseded",
  }, db), 1);
  assert.equal(getGitHubActionEvent(stored.id, db)!.status, "superseded");
  assert.equal(supersedeQueuedEvents({
    actionId: action.id, headRef: "main", exceptHeadSha: SHA_OLD, reason: "head_superseded",
  }, db), 1);
});

test("refuses a second action with the same name and trigger kind", () => {
  const db = memoryDb();
  const base = {
    repositoryKey: "github:1", connectionId: "c1", installationId: "i1", repositoryId: "1",
    executor: "sentinel-managed" as const, scanner: null, costCeilingUsd: 2,
    dailyCostCeilingUsd: 10, enabled: false, includeForks: false, createdBy: "u1",
  };
  createGitHubAction({ ...base, name: "PR", triggerKind: "pull_request", branchPatterns: ["main"] }, db);
  const other = createGitHubAction(
    { ...base, name: "Release", triggerKind: "pull_request", branchPatterns: ["main"] }, db,
  );
  assert.throws(
    () => createGitHubAction({ ...base, name: "PR", triggerKind: "pull_request", branchPatterns: ["main"] }, db),
    /github_action_name_taken/,
  );
  assert.throws(
    () => patchGitHubAction(other.id, { name: "PR" }, db),
    /github_action_name_taken/,
  );
});

test("the database refuses an action outside one to twenty branch patterns", () => {
  const db = memoryDb();
  const insert = (patterns: string[]) => db.prepare(`
    INSERT INTO github_actions (
      id, repository_key, name, trigger_kind, branch_patterns_json, executor,
      connection_id, installation_id, repository_id, cost_ceiling_usd,
      created_at, updated_at
    ) VALUES (?, 'github:1', ?, 'push', ?, 'sentinel-managed', 'c1', 'i1', '1', 2,
      '2026-09-30T10:00:00.000Z', '2026-09-30T10:00:00.000Z')
  `).run(`action-${patterns.length}`, `name-${patterns.length}`, JSON.stringify(patterns));
  assert.throws(() => insert([]), /CHECK constraint failed/);
  assert.throws(
    () => insert(Array.from({ length: 21 }, (_, index) => `branch-${index}`)),
    /CHECK constraint failed/,
  );
  insert(Array.from({ length: 20 }, (_, index) => `branch-${index}`));
});

test("refuses to enable an action whose branch patterns are emptied in the same patch", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  assert.throws(
    () => patchGitHubAction(action.id, { branchPatterns: [], enabled: true }, db),
    /github_action_branch_patterns_invalid/,
  );
});

/**
 * The number the Integration screen reads to answer "are the webhooks arriving?":
 * events the 15-minute reconciliation had to recover because no delivery brought
 * them. A high count with a configured secret means deliveries are being lost.
 */
test("counts the events the reconciliation recovered in a window", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  const recovered = (headSha: string, detectedAt: string, origin: "webhook" | "reconciliation" | "manual") =>
    createGitHubActionEvent({ ...pullRequestEvent(action, headSha, detectedAt), origin }, db);
  assert.ok(recovered("1".repeat(40), "2026-09-30T08:00:00.000Z", "reconciliation"));
  assert.ok(recovered("2".repeat(40), "2026-09-30T11:00:00.000Z", "reconciliation"));
  assert.ok(recovered("3".repeat(40), "2026-09-30T11:30:00.000Z", "webhook"));
  assert.ok(recovered("4".repeat(40), "2026-09-30T11:40:00.000Z", "manual"));
  assert.equal(countReconciledEventsSince("2026-09-30T10:00:00.000Z", db), 1);
  assert.equal(countReconciledEventsSince("2026-09-30T07:00:00.000Z", db), 2);
  assert.equal(countReconciledEventsSince("2026-10-01T00:00:00.000Z", db), 0);
});

/**
 * A delivery only reaches the table once its signature verified, so the newest
 * row of a connection *is* the last time that connection's secret was proven
 * right — the signal the readiness checklist needs so a wrong-but-present secret
 * cannot read green.
 */
test("reports when a connection last proved its webhook secret", () => {
  const db = memoryDb();
  assert.equal(lastVerifiedWebhookDeliveryAt("c1", db), null);
  recordWebhookDelivery({ ...delivery(1, "2026-09-30T10:00:00.000Z"), connectionId: "c1" }, db);
  recordWebhookDelivery({
    ...delivery(2, "2026-09-30T12:00:00.000Z"), connectionId: "c1",
    // A payload this connection signed but the product could not parse still
    // proves the secret.
    outcome: "failed", reason: "malformed_payload",
  }, db);
  recordWebhookDelivery({ ...delivery(3, "2026-09-30T09:00:00.000Z"), connectionId: "c2" }, db);
  assert.equal(lastVerifiedWebhookDeliveryAt("c1", db), "2026-09-30T12:00:00.000Z");
  assert.equal(lastVerifiedWebhookDeliveryAt("c2", db), "2026-09-30T09:00:00.000Z");
  assert.equal(lastVerifiedWebhookDeliveryAt("c3", db), null);
});

/**
 * The ordering guard behind C-1: a supersession may only cancel what is strictly
 * older than the change that replaces it. Without `beforeObservedAt` a delivery
 * that arrives late cancels the newer head it should have left alone.
 */
test("supersedes only the events older than the change that replaces them", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  const older = createGitHubActionEvent({
    ...pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"),
    observedAt: "2026-09-30T09:59:00.000Z",
  }, db)!;
  const newer = createGitHubActionEvent({
    ...pullRequestEvent(action, SHA_NEW, "2026-09-30T10:05:00.000Z"),
    observedAt: "2026-09-30T10:04:00.000Z",
  }, db)!;
  assert.equal(older.observedAt, "2026-09-30T09:59:00.000Z");

  // A late delivery of the older commit may cancel nothing at all.
  assert.equal(supersedeQueuedEvents({
    actionId: action.id, pullRequestNumber: 7, exceptHeadSha: SHA_OLD,
    reason: "head_superseded", beforeObservedAt: "2026-09-30T09:59:00.000Z",
  }, db), 0);
  assert.equal(getGitHubActionEvent(newer.id, db)!.status, "queued");

  // The genuine newer commit cancels the older one, and never itself.
  assert.equal(supersedeQueuedEvents({
    actionId: action.id, pullRequestNumber: 7, exceptHeadSha: SHA_NEW,
    reason: "head_superseded", beforeObservedAt: "2026-09-30T10:04:00.000Z",
  }, db), 1);
  assert.equal(getGitHubActionEvent(older.id, db)!.status, "superseded");
  assert.equal(getGitHubActionEvent(newer.id, db)!.status, "queued");
});

test("reports the newest change already recorded for a pull request or a branch", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  assert.equal(newestObservedEventAt({ actionId: action.id, pullRequestNumber: 7 }, db), null);
  createGitHubActionEvent({
    ...pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"),
    observedAt: "2026-09-30T09:59:00.000Z",
  }, db);
  assert.equal(newestObservedEventAt({ actionId: action.id, pullRequestNumber: 7 }, db), "2026-09-30T09:59:00.000Z");
  createGitHubActionEvent({
    ...pullRequestEvent(action, SHA_NEW, "2026-09-30T10:05:00.000Z"),
    observedAt: null,
  }, db);
  // With no payload clock the detection time stands in, so the answer never
  // goes backwards.
  assert.equal(newestObservedEventAt({ actionId: action.id, pullRequestNumber: 7 }, db), "2026-09-30T10:05:00.000Z");
  assert.equal(newestObservedEventAt({ actionId: action.id, pullRequestNumber: 8 }, db), null);
  assert.equal(newestObservedEventAt({ actionId: action.id, headRef: "refs/heads/feature/login" }, db), "2026-09-30T10:05:00.000Z");
  assert.throws(
    () => newestObservedEventAt({ actionId: action.id }, db),
    /github_action_supersede_scope_required/,
  );
});

test("claims a delivery before the work and completes it with the outcome", () => {
  const db = memoryDb();
  const claim = { ...delivery(9, "2026-09-30T10:00:00.000Z"), outcome: "failed" as const, reason: null };
  assert.equal(recordWebhookDelivery(claim, db), "recorded");
  assert.equal(recordWebhookDelivery(claim, db), "duplicate");
  completeWebhookDelivery("delivery-9", {
    repositoryKey: "github:1", installationId: "i1", headSha: SHA_NEW,
    outcome: "processed", reason: null, matchedActionIds: ["a1"], eventIds: ["e1"], durationMs: 7,
  }, db);
  const stored = listWebhookDeliveries(10, db)[0]!;
  assert.equal(stored.outcome, "processed");
  assert.deepEqual(stored.eventIds, ["e1"]);
  assert.deepEqual(stored.matchedActionIds, ["a1"]);
  assert.equal(stored.headSha, SHA_NEW);
  assert.equal(stored.durationMs, 7);
  // Completing a row that is not there writes nothing and throws nothing.
  completeWebhookDelivery("delivery-absent", {
    repositoryKey: null, installationId: null, headSha: null,
    outcome: "ignored", reason: "event_not_handled", matchedActionIds: [], eventIds: [], durationMs: 1,
  }, db);
  assert.equal(listWebhookDeliveries(10, db).length, 1);
});

test("an action carries its fork opt-in, and changing it bumps the revision", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  assert.equal(action.includeForks, false);
  const opened = patchGitHubAction(action.id, { includeForks: true }, db)!;
  assert.equal(opened.includeForks, true);
  assert.equal(opened.revision, action.revision + 1, "what the action observes changed");
  assert.equal(patchGitHubAction(action.id, { includeForks: true }, db)!.revision, opened.revision);
});

/**
 * N-3. GitHub's clocks have one-second resolution, so two heads of one pull request
 * can share one. The pair `(clock, insertion order)` orders them anyway, in one
 * direction only, so exactly one survives whichever arrived first.
 */
test("breaks a supersession tie on insertion order, never on the row itself", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  const sameSecond = "2026-09-30T10:00:00.000Z";
  const first = createGitHubActionEvent({
    ...pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:01.000Z"), observedAt: sameSecond,
  }, db)!;
  const second = createGitHubActionEvent({
    ...pullRequestEvent(action, SHA_NEW, "2026-09-30T10:00:02.000Z"), observedAt: sameSecond,
  }, db)!;

  // Without the tie-break the strict clock comparison cancels nothing.
  assert.equal(supersedeQueuedEvents({
    actionId: action.id, pullRequestNumber: 7, exceptHeadSha: SHA_NEW,
    reason: "head_superseded", beforeObservedAt: sameSecond,
  }, db), 0);

  assert.equal(supersedeQueuedEvents({
    actionId: action.id, pullRequestNumber: 7, exceptHeadSha: SHA_NEW,
    reason: "head_superseded", beforeObservedAt: sameSecond, beforeEventId: second.id,
  }, db), 1);
  assert.equal(getGitHubActionEvent(first.id, db)!.status, "superseded");
  assert.equal(getGitHubActionEvent(second.id, db)!.status, "queued");

  // The older row cannot cancel the newer one by naming itself: the pair is
  // ordered one way.
  assert.equal(supersedeQueuedEvents({
    actionId: action.id, pullRequestNumber: 7, exceptHeadSha: SHA_OLD,
    reason: "head_superseded", beforeObservedAt: sameSecond, beforeEventId: first.id,
  }, db), 0);
  assert.equal(getGitHubActionEvent(second.id, db)!.status, "queued");

  // An unknown id degrades to the strict clock comparison instead of matching
  // every row.
  assert.equal(supersedeQueuedEvents({
    actionId: action.id, pullRequestNumber: 7, exceptHeadSha: SHA_OLD,
    reason: "head_superseded", beforeObservedAt: sameSecond, beforeEventId: "absent",
  }, db), 0);
});

test("knows every commit the action has already seen, whatever became of it", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  createGitHubActionEvent({
    ...pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"),
    status: "skipped", reason: "commit_already_analysed",
  }, db);
  // Any status counts: a commit the action skipped is still not one a webhook
  // missed, and the reconciliation must not create a second event for it.
  assert.equal(hasGitHubActionEventForHeadSha(action.id, SHA_OLD, db), true);
  assert.equal(hasGitHubActionEventForHeadSha(action.id, SHA_NEW, db), false);
});

test("a commit refused for a server-side transient is not treated as seen", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  const event = createGitHubActionEvent(pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"), db)!;
  patchGitHubActionEvent(event.id, { status: "skipped", reason: "server_draining" }, db);
  // The refusal was about us, not about the commit, so the never-twice rule must
  // not close the door on it.
  assert.equal(hasGitHubActionEventForHeadSha(action.id, SHA_OLD, db), false);
  patchGitHubActionEvent(event.id, { status: "skipped", reason: "head_superseded" }, db);
  assert.equal(hasGitHubActionEventForHeadSha(action.id, SHA_OLD, db), true);
});

test("finds the event a gate belongs to, for a rerequested check run", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  const event = createGitHubActionEvent(pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"), db)!;
  patchGitHubActionEvent(event.id, { status: "launched", gateId: "gate-1" }, db);
  assert.equal(findGitHubActionEventByGateId("gate-1", db)?.id, event.id);
  assert.equal(findGitHubActionEventByGateId("gate-absent", db), null);
});

test("disables the actions of a repository, and of an installation, without forgetting the baseline", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  recordGitHubActionReconciliation(action.id, { error: null, initializeBaseline: true }, db, "2026-09-30T09:00:00.000Z");
  assert.equal(disableGitHubActionsForRepository("github:1", "repository_unauthorized", db), 1);
  const disabled = listGitHubActions({ repositoryKey: "github:1" }, db)[0]!;
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.lastError, "repository_unauthorized");
  assert.equal(disabled.revision, action.revision, "disabling changes nothing the action observes");
  assert.equal(disabled.baselineInitializedAt, "2026-09-30T09:00:00.000Z");
  // Already disabled: nothing left to disable.
  assert.equal(disableGitHubActionsForRepository("github:1", "repository_unauthorized", db), 0);

  patchGitHubAction(action.id, { enabled: true }, db);
  assert.equal(disableGitHubActionsForInstallation("i1", "installation_unauthorized", db), 1);
  assert.equal(listGitHubActions({ repositoryKey: "github:1" }, db)[0]!.lastError, "installation_unauthorized");
});

test("reserves the day's budget once, and refuses the dispatch that would exceed it", () => {
  const db = memoryDb();
  const action = createGitHubAction({
    repositoryKey: "github:1", name: "PR", triggerKind: "pull_request", branchPatterns: ["main"],
    connectionId: "c1", installationId: "i1", repositoryId: "1", executor: "sentinel-managed",
    scanner: null, costCeilingUsd: 2, dailyCostCeilingUsd: 3, enabled: true,
    includeForks: false, createdBy: "u1",
  }, db);
  const first = createGitHubActionEvent(pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"), db)!;
  const second = createGitHubActionEvent({
    ...pullRequestEvent(action, SHA_NEW, "2026-09-30T11:00:00.000Z"), pullRequestNumber: 8,
    targetIdentity: gitHubActionEventTargetIdentity({
      kind: "pull_request", headSha: SHA_NEW, headRef: "feature/login", pullRequestNumber: 8,
    }),
  }, db)!;
  const reservation = {
    actionId: action.id, repositoryKey: action.repositoryKey, actionRevision: action.revision,
    dayStart: "2026-09-30T00:00:00.000Z", dayEnd: "2026-10-01T00:00:00.000Z",
    costCeilingUsd: 2, dailyCostCeilingUsd: 3,
  };
  const reserved = reserveGitHubActionEventDispatch({
    ...reservation, eventId: first.id, at: "2026-09-30T10:00:01.000Z",
  }, db);
  assert.equal(reserved?.status, "dispatching");
  assert.equal(reserved?.dispatchedAt, "2026-09-30T10:00:01.000Z");
  // 2 + 2 > 3: the second stays queued for the next UTC window.
  assert.equal(reserveGitHubActionEventDispatch({
    ...reservation, eventId: second.id, at: "2026-09-30T11:00:01.000Z",
  }, db), null);
  assert.equal(getGitHubActionEvent(second.id, db)!.status, "queued");
  // The next day starts clean.
  assert.equal(reserveGitHubActionEventDispatch({
    ...reservation, eventId: second.id, at: "2026-10-01T00:00:01.000Z",
    dayStart: "2026-10-01T00:00:00.000Z", dayEnd: "2026-10-02T00:00:00.000Z",
  }, db)?.status, "dispatching");
  // Reserving twice is impossible: only a queued row is claimable.
  assert.equal(reserveGitHubActionEventDispatch({
    ...reservation, eventId: first.id, at: "2026-09-30T10:00:02.000Z",
  }, db), null);
});

test("the daily ceiling bounds the repository, not one action of it", () => {
  // The ruling: `daily_cost_ceiling_usd` caps what the **repository** may reserve
  // in the UTC day, so the PR/Push pair the migration creates keeps exactly the
  // one ceiling the rule had.
  const db = memoryDb();
  const base = {
    repositoryKey: "github:1", connectionId: "c1", installationId: "i1", repositoryId: "1",
    executor: "sentinel-managed" as const, scanner: null, costCeilingUsd: 3,
    dailyCostCeilingUsd: 6, enabled: true, includeForks: false, createdBy: "u1",
  };
  const pr = createGitHubAction({ ...base, name: "PR", triggerKind: "pull_request", branchPatterns: ["main"] }, db);
  const push = createGitHubAction({ ...base, name: "Push", triggerKind: "push", branchPatterns: ["main"] }, db);
  const day = { dayStart: "2026-09-30T00:00:00.000Z", dayEnd: "2026-10-01T00:00:00.000Z" };
  const queue = (action: GitHubAction, headSha: string, number: number) => createGitHubActionEvent({
    ...pullRequestEvent(action, headSha, "2026-09-30T10:00:00.000Z"),
    actionId: action.id, pullRequestNumber: number, costCeilingUsd: 3,
    targetIdentity: gitHubActionEventTargetIdentity({
      kind: "pull_request", headSha, headRef: "feature/login", pullRequestNumber: number,
    }),
  }, db)!;
  const first = queue(pr, SHA_OLD, 7);
  const second = queue(push, SHA_NEW, 8);
  const third = queue(pr, "e".repeat(40), 9);
  const reserve = (action: GitHubAction, eventId: string, at: string) =>
    reserveGitHubActionEventDispatch({
      ...day, eventId, actionId: action.id, repositoryKey: action.repositoryKey,
      actionRevision: action.revision, costCeilingUsd: 3,
      dailyCostCeilingUsd: action.dailyCostCeilingUsd!, at,
    }, db);

  assert.ok(reserve(pr, first.id, "2026-09-30T10:00:01.000Z"));
  assert.ok(reserve(push, second.id, "2026-09-30T11:00:01.000Z"));
  // $6 of $6 is spent by the pair, so the third is deferred even though its own
  // action has only reserved $3.
  assert.equal(reserve(pr, third.id, "2026-09-30T12:00:01.000Z"), null);
  assert.equal(getGitHubActionEvent(third.id, db)!.status, "queued");
  assert.equal(reservedGitHubActionCostForUtcDay("github:1", day.dayStart, day.dayEnd, db), 6);
  // Another repository has its own bucket.
  assert.equal(reservedGitHubActionCostForUtcDay("github:2", day.dayStart, day.dayEnd, db), 0);
});

test("a reservation of a revision that moved, or of a disabled action, is refused", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  const event = createGitHubActionEvent(pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"), db)!;
  patchGitHubAction(action.id, { enabled: false }, db);
  const reservation = {
    eventId: event.id, actionId: action.id, repositoryKey: action.repositoryKey,
    actionRevision: action.revision,
    dayStart: "2026-09-30T00:00:00.000Z", dayEnd: "2026-10-01T00:00:00.000Z",
    costCeilingUsd: 2, dailyCostCeilingUsd: 10, at: "2026-09-30T10:00:01.000Z",
  };
  assert.equal(reserveGitHubActionEventDispatch(reservation, db), null);
  patchGitHubAction(action.id, { enabled: true, branchPatterns: ["release/**"] }, db);
  assert.equal(reserveGitHubActionEventDispatch(reservation, db), null, "the revision moved");
});

test("an abandoned reservation becomes terminal, and a live one is left running", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  const event = createGitHubActionEvent(pullRequestEvent(action, SHA_OLD, "2026-09-30T10:00:00.000Z"), db)!;
  reserveGitHubActionEventDispatch({
    eventId: event.id, actionId: action.id, repositoryKey: action.repositoryKey,
    actionRevision: action.revision,
    dayStart: "2026-09-30T00:00:00.000Z", dayEnd: "2026-10-01T00:00:00.000Z",
    costCeilingUsd: 2, dailyCostCeilingUsd: 10, at: "2026-09-30T10:00:01.000Z",
  }, db);
  assert.equal(failOrphanedGitHubActionDispatches("2026-09-30T10:01:00.000Z", {
    exceptEventIds: [event.id],
  }, db), 0);
  assert.equal(getGitHubActionEvent(event.id, db)!.status, "dispatching");
  assert.equal(failOrphanedGitHubActionDispatches("2026-09-30T10:01:00.000Z", {}, db), 1);
  const orphan = getGitHubActionEvent(event.id, db)!;
  assert.equal(orphan.status, "failed");
  assert.equal(orphan.error, "automatic_dispatch_uncertain");
  // The reservation stays spent for the day: the scan may have started.
  assert.equal(reservedGitHubActionCostForUtcDay(
    action.repositoryKey, "2026-09-30T00:00:00.000Z", "2026-10-01T00:00:00.000Z", db,
  ), 2);
});

/**
 * The activity screen pages without a cursor, and a page that ignored the offset
 * would show the same rows forever. Both listings honour it, and both keep their
 * newest-first order across pages.
 */
test("pages events and deliveries from an offset", () => {
  const db = memoryDb();
  const action = pullRequestAction(db);
  const shas = ["a", "b", "c"].map((letter) => letter.repeat(40));
  shas.forEach((headSha, index) => {
    createGitHubActionEvent(
      pullRequestEvent(action, headSha, `2026-09-30T10:0${index}:00.000Z`),
      db,
    );
  });
  const newestFirst = listGitHubActionEvents({ actionId: action.id }, db).map((event) => event.headSha);
  assert.deepEqual(newestFirst, [shas[2], shas[1], shas[0]]);
  assert.deepEqual(
    listGitHubActionEvents({ actionId: action.id, limit: 1, offset: 1 }, db).map((event) => event.headSha),
    [shas[1]],
  );
  assert.deepEqual(
    listGitHubActionEvents({ actionId: action.id, limit: 2, offset: 2 }, db).map((event) => event.headSha),
    [shas[0]],
  );
  assert.deepEqual(listGitHubActionEvents({ actionId: action.id, offset: 3 }, db), []);
  // A negative or fractional offset is clamped, never interpolated into the SQL.
  assert.equal(listGitHubActionEvents({ actionId: action.id, offset: -5 }, db).length, 3);

  ["2026-09-30T11:00:00.000Z", "2026-09-30T11:01:00.000Z"].forEach((receivedAt, index) => {
    recordWebhookDelivery(delivery(index, receivedAt), db);
  });
  assert.deepEqual(
    listWebhookDeliveries(10, db).map((row) => row.deliveryId),
    ["delivery-1", "delivery-0"],
  );
  assert.deepEqual(
    listWebhookDeliveries(1, db, 1).map((row) => row.deliveryId),
    ["delivery-0"],
  );
  assert.deepEqual(listWebhookDeliveries(10, db, 2), []);
});

/**
 * The caller's scope belongs in the WHERE clause. Filtering a page in memory drops
 * exactly the rows the caller may read and reports a short page as the end of the
 * register — and an empty scope is an answer ("no grant"), never "no filter".
 */
test("filters the actions listing by scope in SQL and pages it", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO guardrail_repositories VALUES ('github:2')").run();
  const first = pullRequestAction(db);
  const second = createGitHubAction({
    repositoryKey: "github:1", name: "Push", triggerKind: "push", branchPatterns: ["main"],
    connectionId: "c1", installationId: "i1", repositoryId: "1", executor: "sentinel-managed",
    scanner: null, costCeilingUsd: 2, dailyCostCeilingUsd: null, enabled: false,
    includeForks: false, createdBy: "u1",
  }, db);
  const other = createGitHubAction({
    repositoryKey: "github:2", name: "PR", triggerKind: "pull_request", branchPatterns: ["main"],
    connectionId: "c1", installationId: "i2", repositoryId: "2", executor: "sentinel-managed",
    scanner: null, costCeilingUsd: 2, dailyCostCeilingUsd: null, enabled: true,
    includeForks: false, createdBy: "u1",
  }, db);

  assert.deepEqual(
    listGitHubActions({ repositoryKeys: ["github:1"] }, db).map((action) => action.id).sort(),
    [first.id, second.id].sort(),
  );
  // An empty scope is a member with no grant: nothing, not everything.
  assert.deepEqual(listGitHubActions({ repositoryKeys: [] }, db), []);
  assert.deepEqual(listGitHubActions({}, db).length, 3);

  const page = listGitHubActions({ limit: 2, offset: 0 }, db);
  assert.equal(page.length, 2);
  assert.deepEqual(
    listGitHubActions({ limit: 2, offset: 2 }, db).map((action) => action.id),
    [other.id].filter((id) => !page.some((action) => action.id === id)),
  );
  // A quoted key cannot break out of the generated IN list.
  assert.deepEqual(listGitHubActions({ repositoryKeys: ["github:1') OR 1=1 --"] }, db), []);
});

/**
 * Only the instant, never the value: the rotation log exists so a verified delivery
 * cannot vouch for the secret it replaced (ruling N-2).
 */
test("records when a webhook secret was stored, one row per connection", () => {
  const db = memoryDb();
  assert.equal(webhookSecretStoredAt("c1", db), null);
  recordWebhookSecretStored("c1", "2026-09-30T10:00:00.000Z", db);
  assert.equal(webhookSecretStoredAt("c1", db), "2026-09-30T10:00:00.000Z");
  // A rotation replaces the instant; the log is not a history.
  recordWebhookSecretStored("c1", "2026-09-30T11:00:00.000Z", db);
  assert.equal(webhookSecretStoredAt("c1", db), "2026-09-30T11:00:00.000Z");
  assert.equal(webhookSecretStoredAt("c2", db), null);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS total FROM github_webhook_secret_rotations").get() as { total: number }).total,
    1,
  );
});
