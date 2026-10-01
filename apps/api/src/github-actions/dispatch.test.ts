import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";
import type { GateTarget, GitHubAction, GitHubActionEvent, GuardrailRepository } from "@csb/shared";

import { defaultToImmediateTransactions } from "../sqlite.js";
import type { AutomaticGitHubScanInput } from "../github-monitor-dispatch.js";
import {
  createGitHubAction,
  createGitHubActionEvent,
  ensureGitHubActionsSchema,
  getGitHubActionEvent,
  gitHubActionEventTargetIdentity,
  getGitHubAction,
  patchGitHubAction,
  patchGitHubActionEvent,
  reserveGitHubActionEventDispatch,
} from "./store.js";
import { dispatchGitHubActionEvent, reconcileOrphanedGitHubActionDispatches } from "./dispatch.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function enrolledRepository(): GuardrailRepository {
  return {
    repositoryKey: "github:1", source: "github", enabled: true, defaultBranch: "main",
    githubConnectionId: "c1", githubInstallationId: "i1", githubRepositoryId: "1",
  } as GuardrailRepository;
}

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  defaultToImmediateTransactions(db);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO guardrail_repositories VALUES ('github:1')").run();
  ensureGitHubActionsSchema(db);
  return db;
}

interface HarnessOptions {
  action?: Partial<Parameters<typeof createGitHubAction>[0]>;
  event?: Partial<Parameters<typeof createGitHubActionEvent>[0]>;
  start?: (input: AutomaticGitHubScanInput) => Promise<{ gateId: string; headSha: string }>;
  clock?: string[];
}

function harness(options: HarnessOptions = {}) {
  const db = memoryDb();
  const action = createGitHubAction({
    repositoryKey: "github:1", name: "PR", triggerKind: "pull_request", branchPatterns: ["main"],
    connectionId: "c1", installationId: "i1", repositoryId: "1", executor: "sentinel-managed",
    scanner: { engine: "codex-security", mode: "standard", connection: { connectionId: "p", modelSelectionMode: "catalog", modelId: "m" } },
    costCeilingUsd: 2, dailyCostCeilingUsd: 2, enabled: true, includeForks: false, createdBy: "u1",
    ...options.action,
  }, db);
  const headSha = (options.event?.headSha as string | undefined) ?? SHA_A;
  const kind = (options.event?.kind as GitHubActionEvent["kind"] | undefined) ?? "pull_request";
  const headRef = (options.event?.headRef as string | undefined) ?? "feature/login";
  const pullRequestNumber = options.event?.pullRequestNumber === undefined
    ? 7 : options.event.pullRequestNumber as number | null;
  const event = createGitHubActionEvent({
    actionId: action.id, repositoryKey: "github:1", actionRevision: action.revision,
    origin: "webhook", deliveryId: "d1", kind, status: "queued", headSha,
    baseRef: "main", headRef, pullRequestNumber,
    targetIdentity: gitHubActionEventTargetIdentity({ kind, headSha, headRef, pullRequestNumber }),
    title: null, gateId: null, costCeilingUsd: action.costCeilingUsd, reason: null, error: null,
    detectedAt: "2026-09-30T10:00:00.000Z", observedAt: null,
    ...options.event,
  }, db)!;
  const repository = enrolledRepository();
  const targets: GateTarget[] = [];
  const started: string[] = [];
  const clock = [...(options.clock ?? ["2026-09-30T12:00:00.000Z"])];
  let previous = clock[0]!;
  const deps = {
    now: () => {
      previous = clock.length > 1 ? clock.shift()! : clock[0] ?? previous;
      return new Date(previous);
    },
    getEvent: (id: string) => getGitHubActionEvent(id, db),
    getAction: (id: string) => getGitHubAction(id, db),
    getRepository: () => repository,
    reserve: (input: Parameters<typeof reserveGitHubActionEventDispatch>[0]) =>
      reserveGitHubActionEventDispatch(input, db),
    patchEvent: (id: string, patch: Parameters<typeof patchGitHubActionEvent>[1]) => {
      patchGitHubActionEvent(id, patch, db);
    },
    start: options.start ?? (async (input: AutomaticGitHubScanInput) => {
      targets.push(input.target);
      started.push(input.event.id);
      return { gateId: `gate-${started.length}`, headSha: input.event.headSha };
    }),
  };
  return {
    db, action, event, deps, targets, started, repository,
    reread: () => getGitHubActionEvent(event.id, db)!,
    run: (id = event.id) => dispatchGitHubActionEvent(id, deps),
  };
}

test("launches a queued event and records the gate", async () => {
  const h = harness();
  await h.run();
  const event = h.reread();
  assert.equal(event.status, "launched");
  assert.equal(event.gateId, "gate-1");
  assert.equal(event.completedAt, "2026-09-30T12:00:00.000Z");
  assert.deepEqual(h.targets, [{ kind: "pull_request", number: 7 }]);
});

test("refuses when the head SHA moved between queue and dispatch", async () => {
  const h = harness({
    start: async () => { throw new Error("head_superseded"); },
  });
  await h.run();
  const event = h.reread();
  assert.equal(event.status, "skipped");
  assert.equal(event.reason, "head_superseded");
  assert.equal(event.gateId, null);
});

test("keeps the event queued when the daily ceiling is spent", async () => {
  const h = harness();
  // Another dispatch of the same action already reserved the whole day.
  const spender = createGitHubActionEvent({
    actionId: h.action.id, repositoryKey: "github:1", actionRevision: h.action.revision,
    origin: "webhook", deliveryId: null, kind: "pull_request", status: "queued", headSha: SHA_B,
    baseRef: "main", headRef: "feature/other", pullRequestNumber: 8,
    targetIdentity: gitHubActionEventTargetIdentity({
      kind: "pull_request", headSha: SHA_B, headRef: "feature/other", pullRequestNumber: 8,
    }),
    title: null, gateId: null, costCeilingUsd: 2, reason: null, error: null,
    detectedAt: "2026-09-30T09:00:00.000Z", observedAt: null,
  }, h.db)!;
  reserveGitHubActionEventDispatch({
    eventId: spender.id, actionId: h.action.id, repositoryKey: h.action.repositoryKey,
    actionRevision: h.action.revision,
    dayStart: "2026-09-30T00:00:00.000Z", dayEnd: "2026-10-01T00:00:00.000Z",
    costCeilingUsd: 2, dailyCostCeilingUsd: 2, at: "2026-09-30T09:00:01.000Z",
  }, h.db);

  await h.run();
  const event = h.reread();
  assert.equal(event.status, "queued");
  assert.equal(event.reason, "daily_cost_ceiling");
  assert.deepEqual(h.started, []);
});

test("crosses the UTC-day boundary correctly", async () => {
  const h = harness({ clock: ["2026-09-30T23:59:59.000Z"] });
  await h.run();
  assert.equal(h.reread().status, "launched");

  // A second event of the same action: the ceiling of 30 September is spent.
  const next = createGitHubActionEvent({
    actionId: h.action.id, repositoryKey: "github:1", actionRevision: h.action.revision,
    origin: "webhook", deliveryId: null, kind: "pull_request", status: "queued", headSha: SHA_B,
    baseRef: "main", headRef: "feature/other", pullRequestNumber: 8,
    targetIdentity: gitHubActionEventTargetIdentity({
      kind: "pull_request", headSha: SHA_B, headRef: "feature/other", pullRequestNumber: 8,
    }),
    title: null, gateId: null, costCeilingUsd: 2, reason: null, error: null,
    detectedAt: "2026-09-30T23:59:59.000Z", observedAt: null,
  }, h.db)!;
  await h.run(next.id);
  assert.equal(getGitHubActionEvent(next.id, h.db)!.status, "queued");
  assert.equal(getGitHubActionEvent(next.id, h.db)!.reason, "daily_cost_ceiling");

  // One second later it is another UTC day, and the budget starts clean.
  const tomorrow = harness({ clock: ["2026-10-01T00:00:01.000Z"] });
  await tomorrow.run();
  assert.equal(tomorrow.reread().status, "launched");
});

test("refuses when the authority triple no longer matches the repository", async () => {
  const h = harness();
  // The enrolment was re-pointed at another installation after the event was
  // queued: the action's copy of the triple is not authority on its own.
  h.repository.githubInstallationId = "i2";
  await h.run();
  const event = h.reread();
  assert.equal(event.status, "skipped");
  assert.equal(event.reason, "github_action_authority_invalid");
  assert.deepEqual(h.started, []);
});

test("refuses when the revision changed after the reservation", async () => {
  const h = harness({
    start: async () => { throw new Error("action_revision_changed"); },
  });
  await h.run();
  const event = h.reread();
  assert.equal(event.status, "skipped");
  assert.equal(event.reason, "action_revision_changed");
});

test("records an ambiguous post-dispatch failure as failed and never retries", async () => {
  let attempts = 0;
  const h = harness({
    start: async () => {
      attempts += 1;
      throw new Error("provider exploded mid-launch");
    },
  });
  await h.run();
  const event = h.reread();
  assert.equal(event.status, "failed");
  assert.equal(event.error, "automatic_dispatch_failed");
  // The second call finds a terminal event and does nothing at all.
  await h.run();
  assert.equal(attempts, 1);
});

test("a launch that answers with another head is uncertain, never launched", async () => {
  const h = harness({ start: async () => ({ gateId: "gate-x", headSha: SHA_B }) });
  await h.run();
  const event = h.reread();
  assert.equal(event.status, "failed");
  assert.equal(event.error, "automatic_dispatch_uncertain");
  assert.equal(event.gateId, null);
});

test("a fork pull request queued while the opt-in was on does not dispatch after it is turned off", async () => {
  const h = harness({
    action: { includeForks: true },
    event: { headRef: "pull/7/head" },
  });
  // The administrator turns the opt-in off while the event waits in the queue.
  // The revision moved with it, which the reservation would catch anyway; the
  // flag is checked first so the refusal names the real reason.
  patchGitHubAction(h.action.id, { includeForks: false }, h.db);
  await h.run();
  const event = h.reread();
  assert.equal(event.status, "skipped");
  assert.equal(event.reason, "fork_pull_request");
  assert.deepEqual(h.started, []);
});

test("a fork head is only ever dispatched as a pull request of the base repository", async () => {
  const h = harness({ action: { includeForks: true }, event: { headRef: "pull/7/head" } });
  await h.run();
  assert.equal(h.reread().status, "launched");
  // Never a compare against `pull/7/head`: the target names the pull request, so
  // every read downstream goes to the base repository and the policy and the
  // baseline keep coming from the base branch.
  assert.deepEqual(h.targets, [{ kind: "pull_request", number: 7 }]);
});

test("a fork ref without its pull request number is refused instead of fetched", async () => {
  const h = harness({
    action: { includeForks: true, triggerKind: "push", branchPatterns: ["main"] },
    event: { kind: "push", headRef: "pull/7/head", pullRequestNumber: null },
  });
  await h.run();
  const event = h.reread();
  assert.equal(event.status, "skipped");
  assert.equal(event.reason, "github_action_authority_invalid");
  assert.deepEqual(h.started, []);
});

test("a push to the protected branch is a protected-branch gate, and any other a comparison", async () => {
  const protectedBranch = harness({
    action: { triggerKind: "push", branchPatterns: ["main"] },
    event: { kind: "push", headRef: "main", pullRequestNumber: null, baseRef: null },
  });
  await protectedBranch.run();
  assert.deepEqual(protectedBranch.targets, [{ kind: "protected_branch", ref: "main" }]);

  const feature = harness({
    action: { triggerKind: "push", branchPatterns: ["*"] },
    event: { kind: "push", headRef: "release/1", pullRequestNumber: null, baseRef: "main" },
  });
  await feature.run();
  assert.deepEqual(feature.targets, [{ kind: "compare", baseRef: "main", headRef: "release/1" }]);
});

test("a disabled action, a moved revision or a vanished event dispatches nothing", async () => {
  const disabled = harness();
  patchGitHubAction(disabled.action.id, { enabled: false }, disabled.db);
  await disabled.run();
  assert.equal(disabled.reread().status, "skipped");
  assert.equal(disabled.reread().reason, "github_action_authority_invalid");

  const moved = harness();
  patchGitHubAction(moved.action.id, { branchPatterns: ["release/**"] }, moved.db);
  await moved.run();
  assert.equal(moved.reread().reason, "action_revision_changed");
  assert.deepEqual(moved.started, []);

  const absent = harness();
  await absent.run("no-such-event");
  assert.deepEqual(absent.started, []);
});

test("a deploy mid-dispatch leaves the event queued, and the next process launches it", async () => {
  // I-6. A refusal whose cause is the server, not the change: terminating it here
  // was a commit nobody would ever scan — the webhook cannot recreate the event
  // (UNIQUE) and the reconciliation would not either (the SHA is on the books).
  let draining = true;
  const h = harness({
    start: async (input) => {
      if (draining) throw new Error("server_draining");
      return { gateId: "gate-1", headSha: input.event.headSha };
    },
  });
  await h.run();
  const postponed = h.reread();
  assert.equal(postponed.status, "queued");
  assert.equal(postponed.reason, "server_draining");
  assert.equal(postponed.dispatchedAt, null, "the reservation is released with the refusal");
  assert.equal(postponed.completedAt, null);

  // The next process — or the next reconciliation cycle — finds it claimable.
  draining = false;
  await h.run();
  const launched = h.reread();
  assert.equal(launched.status, "launched");
  assert.equal(launched.gateId, "gate-1");
});

test("an orphaned reservation from a dead process becomes terminal at boot", async () => {
  const h = harness();
  reserveGitHubActionEventDispatch({
    eventId: h.event.id, actionId: h.action.id, repositoryKey: h.action.repositoryKey,
    actionRevision: h.action.revision,
    dayStart: "2026-09-30T00:00:00.000Z", dayEnd: "2026-10-01T00:00:00.000Z",
    costCeilingUsd: 2, dailyCostCeilingUsd: 2, at: "2026-09-30T09:00:00.000Z",
  }, h.db);
  assert.equal(reconcileOrphanedGitHubActionDispatches({
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    failOrphans: (now, options) => {
      assert.equal(now, "2026-09-30T12:00:00.000Z");
      assert.deepEqual(options.exceptEventIds, []);
      return 1;
    },
  }), 1);
});

test("dispatches a github-actions action through its own executor", async () => {
  const h = harness({
    action: { executor: "github-actions", scanner: null },
  });
  await h.run();
  const event = h.reread();
  assert.equal(event.status, "launched");
  assert.equal(event.gateId, "gate-1");
  assert.equal(h.action.executor, "github-actions");
});

test("refuses a github-actions dispatch while the caller still has automatic triggers", async () => {
  const h = harness({
    action: { executor: "github-actions", scanner: null },
    start: async () => { throw new Error("monitor_actions_duplicate_triggers"); },
  });
  await h.run();
  const event = h.reread();
  assert.equal(event.status, "skipped");
  assert.equal(event.reason, "monitor_actions_duplicate_triggers");
  assert.equal(event.gateId, null);
});

test("refuses a github-actions dispatch when the caller workflow is absent", async () => {
  const h = harness({
    action: { executor: "github-actions", scanner: null },
    start: async () => { throw new Error("target_preview_executor_unavailable"); },
  });
  await h.run();
  const event = h.reread();
  assert.equal(event.status, "skipped");
  assert.equal(event.reason, "target_preview_executor_unavailable");
});

test("refuses a fork pull request for the Actions executor too", async () => {
  const h = harness({
    action: { executor: "github-actions", scanner: null, includeForks: false },
    event: { kind: "pull_request", headRef: "pull/7/head", pullRequestNumber: 7 },
  });
  await h.run();
  const event = h.reread();
  assert.equal(event.status, "skipped");
  assert.equal(event.reason, "fork_pull_request");
  assert.deepEqual(h.started, []);
});
