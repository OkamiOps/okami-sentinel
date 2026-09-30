import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import type { GitHubAction, GitHubActionEventCreate, WebhookDeliveryRecord } from "@csb/shared";

import {
  countWebhookDeliveriesSince,
  createGitHubAction,
  createGitHubActionEvent,
  ensureGitHubActionsSchema,
  getGitHubActionEvent,
  gitHubActionEventTargetIdentity,
  hasAnalysedCommit,
  listGitHubActions,
  listWebhookDeliveries,
  patchGitHubAction,
  patchGitHubActionEvent,
  recordWebhookDelivery,
  supersedeQueuedEvents,
} from "./store.js";

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
    dailyCostCeilingUsd: 10, enabled: false, createdBy: "u1",
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
    scanner: null, costCeilingUsd: 0, dailyCostCeilingUsd: null, enabled: false, createdBy: "u1",
  }, db));
});

const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);

function pullRequestAction(db: Database.Database): GitHubAction {
  return createGitHubAction({
    repositoryKey: "github:1", name: "PR", triggerKind: "pull_request", branchPatterns: ["main"],
    connectionId: "c1", installationId: "i1", repositoryId: "1", executor: "sentinel-managed",
    scanner: null, costCeilingUsd: 2, dailyCostCeilingUsd: 10, enabled: true, createdBy: "u1",
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

test("prunes deliveries beyond the retention ceiling", () => {
  const db = memoryDb();
  const base = Date.parse("2026-09-01T00:00:00.000Z");
  // A multiple of the prune interval, so the ceiling is exact rather than the
  // ceiling plus whatever arrived since the last prune.
  const total = 2100;
  for (let index = 0; index < total; index += 1) {
    recordWebhookDelivery(delivery(index, new Date(base + index * 1000).toISOString()), db);
  }
  const count = db.prepare("SELECT COUNT(*) AS total FROM github_webhook_deliveries").get() as { total: number };
  assert.equal(count.total, 2000);
  const newest = listWebhookDeliveries(1, db);
  assert.equal(newest[0]!.deliveryId, `delivery-${total - 1}`);
  const oldest = db
    .prepare("SELECT delivery_id FROM github_webhook_deliveries ORDER BY received_at ASC LIMIT 1")
    .get() as { delivery_id: string };
  assert.equal(oldest.delivery_id, `delivery-${total - 2000}`);
});
