import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";
import type { GitHubAction, GitHubActionEvent, GuardrailRepository } from "@csb/shared";

import { defaultToImmediateTransactions } from "../sqlite.js";
import {
  createGitHubAction,
  createGitHubActionEvent,
  disableGitHubActionsForRepository,
  ensureGitHubActionsSchema,
  getGitHubAction,
  gitHubActionEventTargetIdentity,
  hasGitHubActionEventForHeadSha,
  listGitHubActionEvents,
  listGitHubActions,
  patchGitHubAction,
  patchGitHubActionEvent,
  recordGitHubActionReconciliation,
  supersedeQueuedEvents,
} from "./store.js";
import {
  GITHUB_RECONCILE_MAX_BRANCH_PAGES,
  GITHUB_RECONCILE_MAX_PULL_REQUEST_PAGES,
  reconcileGitHubActions,
  singleFlightReconcile,
  startGitHubReconciler,
  type GitHubReconcilerDependencies,
} from "./reconciler.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const NOW = "2026-09-30T12:00:00.000Z";

interface RemotePullRequest {
  number: number;
  title: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  draft?: boolean;
  forkOf?: string;
  updatedAt?: string;
}

interface RemoteBranch { name: string; headSha: string }

interface HarnessOptions {
  actions?: ActionPatch[];
  openPullRequests?: RemotePullRequest[];
  branches?: RemoteBranch[];
  events?: Array<Partial<Parameters<typeof createGitHubActionEvent>[0]>>;
  repositoryMissing?: boolean;
  fail?: boolean;
  installationScopes?: { scopes: Array<{ installationId: string; repositoryIds: string[] }>; failures: number } | null;
}

function repository(): GuardrailRepository {
  return {
    repositoryKey: "github:1", source: "github", enabled: true, defaultBranch: "main",
    remoteOwner: "okami", remoteName: "sentinel",
    githubConnectionId: "c1", githubInstallationId: "i1", githubRepositoryId: "1",
  } as GuardrailRepository;
}

type ActionPatch = Partial<Parameters<typeof createGitHubAction>[0]>
  & { baselineInitializedAt?: string | null };

/** The action the harness builds, already past its first reconciliation. */
function prAction(patch: ActionPatch = {}) {
  return {
    baselineInitializedAt: "2026-09-29T00:00:00.000Z",
    repositoryKey: "github:1", name: "PR", triggerKind: "pull_request" as const,
    branchPatterns: ["main"], connectionId: "c1", installationId: "i1", repositoryId: "1",
    executor: "sentinel-managed" as const,
    scanner: { engine: "codex-security" as const, mode: "standard" as const, connection: { connectionId: "p", modelSelectionMode: "catalog" as const, modelId: "m" } },
    costCeilingUsd: 2, dailyCostCeilingUsd: 10, enabled: true, includeForks: false, createdBy: "u1",
    ...patch,
  };
}

function launchedEvent(action: GitHubAction, patch: Partial<Parameters<typeof createGitHubActionEvent>[0]> = {}) {
  const headSha = (patch.headSha as string | undefined) ?? SHA_A;
  const headRef = (patch.headRef as string | undefined) ?? "topic";
  const pullRequestNumber = patch.pullRequestNumber === undefined ? 7 : patch.pullRequestNumber as number | null;
  const kind = (patch.kind as GitHubActionEvent["kind"] | undefined) ?? "pull_request";
  return {
    actionId: action.id, repositoryKey: action.repositoryKey, actionRevision: action.revision,
    origin: "webhook" as const, deliveryId: "d1", kind, status: "launched" as const,
    headSha, baseRef: "main", headRef, pullRequestNumber,
    targetIdentity: gitHubActionEventTargetIdentity({ kind, headSha, headRef, pullRequestNumber }),
    title: null, gateId: "gate-old", costCeilingUsd: 2, reason: null, error: null,
    detectedAt: "2026-09-30T09:00:00.000Z", observedAt: null,
    ...patch,
  };
}

function reconcilerHarness(options: HarnessOptions = {}) {
  const db = new Database(":memory:");
  defaultToImmediateTransactions(db);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO guardrail_repositories VALUES ('github:1')").run();
  ensureGitHubActionsSchema(db);

  const actions = (options.actions ?? [prAction()]).map((patch) => {
    const { baselineInitializedAt, ...create } = prAction(patch);
    const action = createGitHubAction(create, db);
    if (baselineInitializedAt !== null && baselineInitializedAt !== undefined) {
      db.prepare("UPDATE github_actions SET baseline_initialized_at = ? WHERE id = ?")
        .run(baselineInitializedAt, action.id);
    }
    return getGitHubAction(action.id, db)!;
  });
  for (const patch of options.events ?? []) {
    createGitHubActionEvent(launchedEvent(actions[0]!, patch), db);
  }
  const remoteCalls: string[] = [];
  const dispatched: string[] = [];
  const row = repository();

  const page = <T>(entries: readonly T[], resourcePath: string): T[] => {
    const number = Number(new URL(`https://x${resourcePath}`).searchParams.get("page") ?? "1");
    const size = Number(new URL(`https://x${resourcePath}`).searchParams.get("per_page") ?? "100");
    return entries.slice((number - 1) * size, number * size);
  };

  const deps: GitHubReconcilerDependencies = {
    now: () => new Date(NOW),
    listActions: () => listGitHubActions({}, db),
    getRepository: (key) => (options.repositoryMissing === true || key !== row.repositoryKey ? null : row),
    readRepositoryJson: async (_repository, resourcePath) => {
      remoteCalls.push(resourcePath);
      if (options.fail === true) throw new Error("upstream exploded");
      if (resourcePath.startsWith("/pulls")) {
        return page(options.openPullRequests ?? [], resourcePath).map((pull) => ({
          number: pull.number,
          title: pull.title,
          draft: pull.draft ?? false,
          updated_at: pull.updatedAt ?? "2026-09-30T11:00:00.000Z",
          base: { ref: pull.baseRef, repo: { id: 1 } },
          head: { ref: pull.headRef, sha: pull.headSha, repo: pull.forkOf === undefined ? { id: 1 } : { id: 2 } },
        }));
      }
      return page(options.branches ?? [], resourcePath).map((branch) => ({
        name: branch.name, commit: { sha: branch.headSha },
      }));
    },
    createEvent: (input) => createGitHubActionEvent(input, db),
    hasEventForHeadSha: (actionId, headSha) => hasGitHubActionEventForHeadSha(actionId, headSha, db),
    supersede: (input) => supersedeQueuedEvents(input, db, NOW),
    listQueuedEvents: (actionId) => listGitHubActionEvents({ actionId, statuses: ["queued"] }, db),
    patchEvent: (id, patch) => { patchGitHubActionEvent(id, patch, db); },
    recordReconciliation: (actionId, outcome) => {
      recordGitHubActionReconciliation(actionId, outcome, db, NOW);
    },
    dispatch: (eventId) => { dispatched.push(eventId); },
    reconcileOrphans: () => 0,
    disableActionsForRepository: (key, reason) => { disableGitHubActionsForRepository(key, reason, db); },
    runInTransaction: (work) => db.transaction(work)(),
    ...(options.installationScopes === undefined
      ? {}
      : { listInstallationScopes: async () => options.installationScopes ?? null }),
  };

  return {
    db, deps, remoteCalls, dispatched: () => dispatched,
    action: (index = 0) => getGitHubAction(actions[index]!.id, db)!,
    events: (index = 0) => listGitHubActionEvents({ actionId: actions[index]!.id }, db),
    run: () => reconcileGitHubActions(deps),
  };
}

test("creates nothing when no commit moved", async () => {
  const harness = reconcilerHarness({
    openPullRequests: [{ number: 7, baseRef: "main", headRef: "topic", headSha: SHA_A, title: "t" }],
    events: [{ headSha: SHA_A }],
  });
  assert.deepEqual(await harness.run(), { repositories: 1, created: 0, observed: 0, errors: 0 });
  assert.deepEqual(harness.dispatched(), []);
});

test("creates an event for a commit the webhook missed", async () => {
  const harness = reconcilerHarness({
    openPullRequests: [{ number: 7, baseRef: "main", headRef: "topic", headSha: SHA_B, title: "t" }],
    events: [{ headSha: SHA_A }],
  });
  assert.deepEqual(await harness.run(), { repositories: 1, created: 1, observed: 0, errors: 0 });
  const created = harness.events().find((event) => event.headSha === SHA_B)!;
  assert.equal(created.status, "queued");
  assert.equal(created.origin, "reconciliation");
  assert.equal(created.deliveryId, null);
  assert.equal(created.targetIdentity, `pr:7@${SHA_B}`);
  assert.deepEqual(harness.dispatched(), [created.id]);
});

test("creates nothing for a SHA any event of the action already carries", async () => {
  const harness = reconcilerHarness({
    openPullRequests: [{ number: 7, baseRef: "main", headRef: "topic", headSha: SHA_B, title: "t" }],
    events: [{ headSha: SHA_B, status: "skipped", reason: "commit_already_analysed", gateId: null }],
  });
  assert.deepEqual(await harness.run(), { repositories: 1, created: 0, observed: 0, errors: 0 });
});

test("marks the first run as observed and never scans the backlog", async () => {
  const harness = reconcilerHarness({
    actions: [prAction({ baselineInitializedAt: null })],
    openPullRequests: [
      { number: 7, baseRef: "main", headRef: "one", headSha: SHA_A, title: "one" },
      { number: 8, baseRef: "main", headRef: "two", headSha: SHA_B, title: "two" },
      { number: 9, baseRef: "main", headRef: "three", headSha: SHA_C, title: "three" },
    ],
  });
  assert.deepEqual(await harness.run(), { repositories: 1, created: 0, observed: 3, errors: 0 });
  assert.equal(harness.dispatched().length, 0);
  assert.ok(harness.action().baselineInitializedAt);
  for (const event of harness.events()) {
    assert.equal(event.status, "observed");
    assert.equal(event.reason, "initial_baseline");
  }
});

test("treats an edited action as new again", async () => {
  const harness = reconcilerHarness({
    openPullRequests: [{ number: 7, baseRef: "main", headRef: "topic", headSha: SHA_A, title: "t" }],
  });
  // Editing what the action observes bumps the revision and forgets the
  // baseline, so the next run observes the open queue instead of charging for it.
  const edited = patchGitHubAction(harness.action().id, { branchPatterns: ["main", "release/**"] }, harness.db)!;
  assert.equal(edited.revision, 2);
  assert.equal(edited.baselineInitializedAt, null);

  assert.deepEqual(await harness.run(), { repositories: 1, created: 0, observed: 1, errors: 0 });
  assert.equal(harness.dispatched().length, 0);
  assert.ok(harness.action().baselineInitializedAt);
});

test("skips a repository whose actions are all disabled and makes no remote call", async () => {
  const harness = reconcilerHarness({
    actions: [prAction({ enabled: false })],
    openPullRequests: [{ number: 7, baseRef: "main", headRef: "topic", headSha: SHA_A, title: "t" }],
  });
  assert.deepEqual(await harness.run(), { repositories: 0, created: 0, observed: 0, errors: 0 });
  assert.equal(harness.remoteCalls.length, 0);
});

test("records the error on the action and keeps going", async () => {
  const harness = reconcilerHarness({ fail: true });
  assert.deepEqual(await harness.run(), { repositories: 0, created: 0, observed: 0, errors: 1 });
  assert.equal(harness.action().lastError, "github_action_reconcile_failed");
  // The failure never becomes an upstream message on the row.
  assert.ok(!harness.action().lastError!.includes("exploded"));
});

test("stops branch listing at two pages and PR listing at three", async () => {
  const pulls = Array.from({ length: 400 }, (_, index) => ({
    number: index + 1, baseRef: "main", headRef: `topic-${index}`,
    headSha: index.toString(16).padStart(40, "0"), title: "t",
  }));
  const branches = Array.from({ length: 300 }, (_, index) => ({
    name: `branch-${index}`, headSha: (index + 1000).toString(16).padStart(40, "0"),
  }));
  const harness = reconcilerHarness({
    actions: [prAction(), prAction({ name: "Push", triggerKind: "push", branchPatterns: ["*"] })],
    openPullRequests: pulls,
    branches,
  });
  await harness.run();
  assert.equal(harness.remoteCalls.filter((call) => call.startsWith("/pulls")).length, GITHUB_RECONCILE_MAX_PULL_REQUEST_PAGES);
  assert.equal(harness.remoteCalls.filter((call) => call.startsWith("/branches")).length, GITHUB_RECONCILE_MAX_BRANCH_PAGES);
  assert.equal(GITHUB_RECONCILE_MAX_PULL_REQUEST_PAGES, 3);
  assert.equal(GITHUB_RECONCILE_MAX_BRANCH_PAGES, 2);
});

test("a pull request from a fork is not observed unless the action opted in", async () => {
  const closed = reconcilerHarness({
    openPullRequests: [{ number: 7, baseRef: "main", headRef: "topic", headSha: SHA_B, title: "t", forkOf: "somebody" }],
    events: [{ headSha: SHA_A }],
  });
  assert.deepEqual(await closed.run(), { repositories: 1, created: 0, observed: 0, errors: 0 });

  const open = reconcilerHarness({
    actions: [prAction({ includeForks: true })],
    openPullRequests: [{ number: 7, baseRef: "main", headRef: "topic", headSha: SHA_B, title: "t", forkOf: "somebody" }],
    events: [{ headSha: SHA_A }],
  });
  assert.deepEqual(await open.run(), { repositories: 1, created: 1, observed: 0, errors: 0 });
  // The ref that exists in the base repository, never the fork's own branch.
  assert.equal(open.events().find((event) => event.headSha === SHA_B)!.headRef, "pull/7/head");
});

test("a draft pull request is not scanned until it is ready", async () => {
  const harness = reconcilerHarness({
    openPullRequests: [{ number: 7, baseRef: "main", headRef: "topic", headSha: SHA_B, title: "t", draft: true }],
    events: [{ headSha: SHA_A }],
  });
  assert.deepEqual(await harness.run(), { repositories: 1, created: 0, observed: 0, errors: 0 });
});

test("only a branch the action follows produces a push event", async () => {
  const harness = reconcilerHarness({
    actions: [prAction({ name: "Push", triggerKind: "push", branchPatterns: ["release/**"] })],
    branches: [{ name: "main", headSha: SHA_A }, { name: "release/1", headSha: SHA_B }],
    events: [],
  });
  await harness.run();
  const observed = harness.events();
  assert.deepEqual(observed.map((event) => event.headRef), ["release/1"]);
  assert.equal(observed[0]!.targetIdentity, `push:release/1@${SHA_B}`);
});

test("the newer head cancels the queue the reconciliation replaces", async () => {
  const harness = reconcilerHarness({
    openPullRequests: [{ number: 7, baseRef: "main", headRef: "topic", headSha: SHA_B, title: "t" }],
    events: [{ headSha: SHA_A, status: "queued", gateId: null, detectedAt: "2026-09-30T09:00:00.000Z" }],
  });
  await harness.run();
  const [older] = harness.events().filter((event) => event.headSha === SHA_A);
  assert.equal(older!.status, "superseded");
  assert.equal(older!.reason, "head_superseded");
  assert.deepEqual(harness.dispatched(), harness.events().filter((event) => event.headSha === SHA_B).map((event) => event.id));
});

test("a queued event older than a day is retired instead of resurrected", async () => {
  const harness = reconcilerHarness({
    openPullRequests: [],
    events: [{
      headSha: SHA_A, status: "queued", gateId: null,
      detectedAt: "2026-09-01T09:00:00.000Z",
    }],
  });
  assert.deepEqual(await harness.run(), { repositories: 1, created: 0, observed: 0, errors: 0 });
  assert.deepEqual(harness.dispatched(), []);
  const stale = harness.events()[0]!;
  assert.equal(stale.status, "skipped");
  assert.equal(stale.reason, "queued_event_expired");
});

test("a commit the outage lost is recovered and dispatched, however old the change is", async () => {
  // C-1. The API was down for two days; the pull request's own clock is 48 h old.
  // The event the reconciliation creates is one we have just learned of, so its
  // age is ours to measure, not the payload's.
  const harness = reconcilerHarness({
    openPullRequests: [{
      number: 9, baseRef: "main", headRef: "topic", headSha: SHA_B, title: "t",
      updatedAt: "2026-09-28T09:00:00.000Z",
    }],
  });
  assert.deepEqual(await harness.run(), { repositories: 1, created: 1, observed: 0, errors: 0 });
  const recovered = harness.events().find((event) => event.headSha === SHA_B)!;
  assert.equal(recovered.status, "queued");
  assert.deepEqual(harness.dispatched(), [recovered.id], "a recovery that is not dispatched recovers nothing");
});

test("a queued event the daily ceiling held back is dispatched again", async () => {
  const harness = reconcilerHarness({
    openPullRequests: [],
    events: [{
      headSha: SHA_A, status: "queued", gateId: null, reason: "daily_cost_ceiling",
      detectedAt: "2026-09-30T11:00:00.000Z",
    }],
  });
  await harness.run();
  assert.deepEqual(harness.dispatched(), [harness.events()[0]!.id]);
});

test("re-lists the installations, because GitHub never redelivers an installation event", async () => {
  const harness = reconcilerHarness({
    openPullRequests: [],
    installationScopes: { scopes: [{ installationId: "i1", repositoryIds: ["99"] }], failures: 0 },
  });
  await harness.run();
  const action = harness.action();
  assert.equal(action.enabled, false);
  assert.equal(action.lastError, "repository_unauthorized");
});

test("an installation listing that failed disables nothing", async () => {
  const harness = reconcilerHarness({ openPullRequests: [], installationScopes: null });
  const outcome = await harness.run();
  assert.equal(outcome.errors, 1);
  assert.equal(harness.action().enabled, true, "a blinking API must not stop the automation");
});

test("one unreadable installation costs one error, and the rest of the scope still applies", async () => {
  // I-1 from the reconciler's side: a partial report is still a report. The
  // installation that answered decides reachability; the one that failed is
  // absent, so its repositories are left alone.
  const harness = reconcilerHarness({
    openPullRequests: [],
    installationScopes: { scopes: [{ installationId: "i2", repositoryIds: ["1"] }], failures: 1 },
  });
  const outcome = await harness.run();
  assert.equal(outcome.errors, 1);
  // The action's installation (`i1`) is not in the report at all: not observed,
  // so not disabled.
  assert.equal(harness.action().enabled, true);

  const observed = reconcilerHarness({
    openPullRequests: [],
    installationScopes: { scopes: [{ installationId: "i1", repositoryIds: ["1"] }], failures: 2 },
  });
  const seen = await observed.run();
  assert.equal(seen.errors, 2, "errors count failed reads, not the shape of the report");
  assert.equal(observed.action().enabled, true, "the repository is still reachable");
});

test("a repository that is no longer enrolled records the error and does not throw", async () => {
  const harness = reconcilerHarness({ repositoryMissing: true });
  assert.deepEqual(await harness.run(), { repositories: 0, created: 0, observed: 0, errors: 1 });
  assert.equal(harness.action().lastError, "github_action_repository_missing");
});

test("the loop is clamped, never overlaps, and stops on demand", async () => {
  const ticks: number[] = [];
  const timers: Array<{ interval: number; fire: () => void }> = [];
  let cleared = 0;
  let release: () => void = () => {};
  const reconciler = startGitHubReconciler({
    reconcile: async () => {
      ticks.push(Date.now());
      await new Promise<void>((resolve) => { release = resolve; });
      return { repositories: 0, created: 0, observed: 0, errors: 0 };
    },
    intervalMs: 10,
    setInterval: ((handler: () => void, interval: number) => {
      timers.push({ interval, fire: handler });
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval,
    clearInterval: (() => { cleared += 1; }) as unknown as typeof clearInterval,
  });
  // Below the floor of five minutes, the interval is clamped up.
  assert.equal(timers[0]!.interval, 300_000);
  timers[0]!.fire();
  timers[0]!.fire();
  assert.equal(ticks.length, 1, "a tick never overlaps the previous one");
  release();
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  timers[0]!.fire();
  assert.equal(ticks.length, 2);
  release();
  await reconciler.stop();
  assert.equal(cleared, 1);
});

/**
 * I-2. `stop()` used to be a bare `clearInterval`, so `closeDb` could run while a
 * cycle was inside its transaction or awaiting a paid dispatch: the gate started
 * and its outcome was written to a closed handle.
 */
test("stopping waits for the cycle in flight, and the boot cycle shares the guard", async () => {
  const order: string[] = [];
  let release: () => void = () => {};
  const reconciler = startGitHubReconciler({
    reconcile: async () => {
      order.push("cycle-start");
      await new Promise<void>((resolve) => { release = resolve; });
      order.push("cycle-end");
      return { repositories: 0, created: 0, observed: 0, errors: 0 };
    },
    setInterval: (() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
    clearInterval: (() => undefined) as unknown as typeof clearInterval,
  });

  // The boot cycle goes through the same in-flight flag as a tick, so a slow boot
  // cycle cannot be overlapped by the first tick either.
  const boot = reconciler.runNow();
  const overlapping = reconciler.runNow();
  await overlapping;
  assert.deepEqual(order, ["cycle-start"], "the second call found one in flight");

  let stopped = false;
  const stopping = reconciler.stop().then(() => { stopped = true; order.push("stopped"); });
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.equal(stopped, false, "stop waits for the cycle that is writing");
  release();
  await stopping;
  await boot;
  assert.deepEqual(order, ["cycle-start", "cycle-end", "stopped"]);

  // Stopped means stopped: a later tick does nothing.
  await reconciler.runNow();
  assert.deepEqual(order, ["cycle-start", "cycle-end", "stopped"]);
});

test("a stop does not wait out a wedged cycle for ever", async () => {
  const reconciler = startGitHubReconciler({
    reconcile: () => new Promise(() => {}),
    stopDeadlineMs: 5,
    setInterval: (() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
    clearInterval: (() => undefined) as unknown as typeof clearInterval,
  });
  void reconciler.runNow();
  const started = Date.now();
  await reconciler.stop();
  assert.ok(Date.now() - started < 2_000, "bounded, like the outbox worker's own stop");
});

/** M-1. A synchronous throw used to leave `running` true and the loop dead. */
test("a cycle that throws synchronously does not wedge the loop", async () => {
  const failures: unknown[] = [];
  let calls = 0;
  const reconciler = startGitHubReconciler({
    reconcile: () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return Promise.resolve({ repositories: 1, created: 0, observed: 0, errors: 0 });
    },
    onError: (error) => { failures.push(error); },
    setInterval: (() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
    clearInterval: (() => undefined) as unknown as typeof clearInterval,
  });
  await reconciler.runNow();
  assert.equal(failures.length, 1);
  await reconciler.runNow();
  assert.equal(calls, 2, "the guard was released");
  await reconciler.stop();
});


/**
 * "Reconciliar agora" and the 15-minute tick are two callers of one cycle. The
 * loop's own guard only covers the loop, so a button press could run a second full
 * set of GitHub reads per repository concurrently and hand the loser of the race an
 * `errors > 0` the operator reads as a fault (M-1). One guard for both callers.
 */
test("a second reconciliation joins the one in flight instead of starting another", async () => {
  let started = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reconcile = singleFlightReconcile(async () => {
    started += 1;
    await gate;
    return { repositories: 1, created: 2, observed: 3, errors: 0 };
  });

  const first = reconcile();
  const second = reconcile();
  assert.equal(started, 1, "the second call started a second cycle");
  release();
  // The caller that started the cycle owns its counts; the one that attached is
  // told so, because those counts predate its request.
  assert.deepEqual(await first, { repositories: 1, created: 2, observed: 3, errors: 0, joined: false });
  assert.deepEqual(await second, { repositories: 1, created: 2, observed: 3, errors: 0, joined: true });

  // The guard is released when the cycle ends, including a failing one.
  const after = reconcile();
  assert.equal(started, 2);
  assert.equal((await after).joined, false);

  let failures = 0;
  const failing = singleFlightReconcile(async () => {
    failures += 1;
    throw new Error("github_unavailable");
  });
  await assert.rejects(failing(), /github_unavailable/);
  await assert.rejects(failing(), /github_unavailable/);
  assert.equal(failures, 2, "a failed cycle left the guard held");
});
