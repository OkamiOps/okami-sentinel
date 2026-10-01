import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";

import type {
  GitHubAction,
  GitHubActionEvent,
  GitHubActionEventCreate,
  GitHubActionTriggerKind,
  GuardrailRepository,
  WebhookDeliveryRecord,
} from "@csb/shared";

import { gitHubActionEventTargetIdentity, rerunTargetIdentity, shortBranchName } from "./schema.js";
import {
  ingestGitHubWebhook,
  type GitHubWebhookIngestDependencies,
  type GitHubWebhookIngestResult,
} from "./webhook-ingest.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SECRET = "webhook-secret-of-connection-one";

const repository: GuardrailRepository = {
  repositoryKey: "github:1",
  repositoryPath: null,
  source: "github",
  displayName: "okami/sentinel",
  defaultBranch: "main",
  defaultExecutor: "sentinel-managed",
  remoteOwner: "okami",
  remoteName: "sentinel",
  githubConnectionId: "c1",
  githubInstallationId: "i1",
  githubRepositoryId: "1",
  enabled: true,
  policyPath: ".csb/guardrails.json",
  lastGateId: null,
  githubStatus: "ready",
};

function anAction(overrides: Partial<GitHubAction> & { triggerKind: GitHubActionTriggerKind }): GitHubAction {
  const now = "2026-09-30T10:00:00.000Z";
  return {
    id: overrides.id ?? `action-${overrides.triggerKind}-${randomUUID().slice(0, 8)}`,
    repositoryKey: repository.repositoryKey,
    name: overrides.triggerKind === "push" ? "Push" : "PR",
    branchPatterns: ["main"],
    executor: "sentinel-managed",
    connectionId: "c1",
    installationId: "i1",
    repositoryId: "1",
    scanner: null,
    costCeilingUsd: 2,
    dailyCostCeilingUsd: 10,
    enabled: true,
    includeForks: false,
    revision: 3,
    baselineInitializedAt: now,
    createdBy: "u1",
    lastEventAt: null,
    lastReconciledAt: null,
    lastError: null,
    migrationNote: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const prAction = (options: { patterns?: string[]; enabled?: boolean; id?: string } = {}): GitHubAction =>
  anAction({
    triggerKind: "pull_request",
    ...(options.patterns ? { branchPatterns: options.patterns } : {}),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.id ? { id: options.id } : {}),
  });

const pushAction = (options: { patterns?: string[]; enabled?: boolean; id?: string } = {}): GitHubAction =>
  anAction({
    triggerKind: "push",
    ...(options.patterns ? { branchPatterns: options.patterns } : {}),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.id ? { id: options.id } : {}),
  });

const prPayload = (options: {
  number: number;
  sha: string;
  base?: string;
  head?: string;
  action?: string;
  /** GitHub's own clock for the change, which orders two deliveries of one target. */
  updatedAt?: string;
  draft?: boolean;
  /** The head repository's id; anything but 1 is a fork of the enrolled repository. */
  headRepositoryId?: number;
  title?: string;
}): Record<string, unknown> => ({
  action: options.action ?? "opened",
  number: options.number,
  pull_request: {
    number: options.number,
    base: { ref: options.base ?? "main", repo: { id: 1 } },
    head: {
      ref: options.head ?? "topic",
      sha: options.sha,
      repo: { id: options.headRepositoryId ?? 1, fork: (options.headRepositoryId ?? 1) !== 1 },
    },
    title: options.title ?? "Add gate",
    draft: options.draft ?? false,
    updated_at: options.updatedAt ?? "2026-09-30T11:59:00.000Z",
  },
  repository: { id: 1 },
  installation: { id: 77 },
});

const pushPayload = (options: { ref: string; after: string; before?: string; pushedAt?: string }): Record<string, unknown> => ({
  ref: options.ref,
  before: options.before ?? SHA_B,
  after: options.after,
  repository: { id: 1, pushed_at: options.pushedAt ?? "2026-09-30T11:59:00.000Z" },
  installation: { id: 77 },
});

const checkRunPayload = (options: {
  action?: string; checkRunId?: number; externalId?: string; sha?: string; appId?: number;
} = {}): Record<string, unknown> => ({
  action: options.action ?? "rerequested",
  check_run: {
    id: options.checkRunId ?? 99,
    external_id: options.externalId ?? "gate-1",
    head_sha: options.sha ?? SHA_A,
    app: { id: options.appId ?? 4242 },
  },
  repository: { id: 1 },
  installation: { id: 77 },
});

interface Harness {
  deliver(event: string, payload: unknown, options?: { delivery?: string; installationTargetId?: string }): Promise<GitHubWebhookIngestResult>;
  deliverUnsigned(event: string, payload: unknown, options?: { delivery?: string; signature?: string | undefined }): Promise<GitHubWebhookIngestResult>;
  events(): GitHubActionEvent[];
  deliveries(): WebhookDeliveryRecord[];
  dispatched(): string[];
  disabled(): Array<{ target: string; reason: string }>;
  refreshed(): string[];
  imported(): string[];
  rerunRequests(): RerunRequest[];
  deps: GitHubWebhookIngestDependencies;
}

type RerunRequest = Parameters<GitHubWebhookIngestDependencies["rerunGate"]>[0];

function ingestHarness(options: {
  actions?: GitHubAction[];
  repository?: GuardrailRepository | null;
  analysed?: Array<{ actionId: string; headSha: string }>;
  secrets?: Array<{ connectionId: string; secret: string; appId?: string | null }>;
  rerun?: (input: RerunRequest) => GitHubActionEvent | null;
  appId?: string | null;
  importWorkflowRun?: (id: string) => void;
} = {}): Harness {
  const actions = options.actions ?? [];
  let events: GitHubActionEvent[] = [];
  let deliveries: WebhookDeliveryRecord[] = [];
  const dispatched: string[] = [];
  let disabled: Array<{ target: string; reason: string }> = [];
  const refreshed: string[] = [];
  const imported: string[] = [];
  const rerunRequests: RerunRequest[] = [];
  const analysed = new Set((options.analysed ?? []).map((entry) => `${entry.actionId}|${entry.headSha}`));
  let clock = Date.parse("2026-09-30T12:00:00.000Z");

  const deps: GitHubWebhookIngestDependencies = {
    now: () => {
      clock += 5;
      return new Date(clock).toISOString();
    },
    listSecrets: async () => options.secrets ?? [{ connectionId: "c1", secret: SECRET }],
    findRepository: (connectionId, githubRepositoryId) => {
      const target = options.repository === undefined ? repository : options.repository;
      if (!target) return null;
      return target.githubConnectionId === connectionId && target.githubRepositoryId === githubRepositoryId
        ? target
        : null;
    },
    listActions: (repositoryKey) => actions.filter((action) => action.repositoryKey === repositoryKey),
    createEvent: (input: GitHubActionEventCreate) => {
      const key = `${input.actionId}|${input.actionRevision}|${input.targetIdentity}`;
      if (events.some((event) => `${event.actionId}|${event.actionRevision}|${event.targetIdentity}` === key)) return null;
      const event: GitHubActionEvent = {
        id: `event-${events.length + 1}`,
        dispatchedAt: null,
        completedAt: null,
        ...input,
        status: input.status ?? "queued",
        headRef: shortBranchName(input.headRef),
      };
      events.push(event);
      return event;
    },
    supersede: (input) => {
      let changed = 0;
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index]!;
        if (event.actionId !== input.actionId || event.status !== "queued") continue;
        if (event.headSha === input.exceptHeadSha) continue;
        if (input.pullRequestNumber !== undefined && event.pullRequestNumber !== input.pullRequestNumber) continue;
        if (input.headRef !== undefined && event.headRef !== shortBranchName(input.headRef)) continue;
        // The store's ordering guard, mirrored: strictly older changes, with
        // insertion order breaking a tie on the payload clock.
        if (input.beforeObservedAt !== undefined) {
          const stamp = event.observedAt ?? event.detectedAt;
          const newer = events.findIndex((candidate) => candidate.id === input.beforeEventId);
          const tie = stamp === input.beforeObservedAt && newer !== -1 && index < newer;
          if (!(stamp < input.beforeObservedAt || tie)) continue;
        }
        events[index] = { ...event, status: "superseded", reason: input.reason, completedAt: deps.now() };
        changed += 1;
      }
      return changed;
    },
    newestObservedAt: (input) => {
      const scoped = events.filter((event) => event.actionId === input.actionId
        && (input.pullRequestNumber === undefined || event.pullRequestNumber === input.pullRequestNumber)
        && (input.headRef === undefined || event.headRef === shortBranchName(input.headRef)));
      const stamps = scoped.map((event) => event.observedAt ?? event.detectedAt).sort();
      return stamps.at(-1) ?? null;
    },
    hasAnalysedCommit: (actionId, headSha) => analysed.has(`${actionId}|${headSha}`),
    claimDelivery: (input) => {
      if (deliveries.some((delivery) => delivery.deliveryId === input.deliveryId)) return "duplicate";
      deliveries.push(input);
      return "recorded";
    },
    completeDelivery: (deliveryId, patch) => {
      const index = deliveries.findIndex((delivery) => delivery.deliveryId === deliveryId);
      if (index === -1) return;
      deliveries[index] = { ...deliveries[index]!, ...patch };
    },
    disableActionsForRepository: (repositoryKey, reason) => { disabled.push({ target: repositoryKey, reason }); },
    disableActionsForInstallation: (installationId, reason) => { disabled.push({ target: `installation:${installationId}`, reason }); },
    refreshInstallationRepositories: async (installationId) => { refreshed.push(installationId); },
    dispatch: (eventId) => { dispatched.push(eventId); },
    connectionAppId: () => (options.appId === undefined ? "4242" : options.appId),
    rerunGate: (input) => {
      rerunRequests.push(input);
      return options.rerun ? options.rerun(input) : null;
    },
    // A real IMMEDIATE transaction discards every write when the work throws, and
    // so does this: the arrays are restored from a snapshot.
    runInTransaction: (work) => {
      const snapshot = { events: [...events], deliveries: [...deliveries], disabled: [...disabled] };
      try {
        return work();
      } catch (error) {
        events = snapshot.events;
        deliveries = snapshot.deliveries;
        disabled = snapshot.disabled;
        throw error;
      }
    },
    ...(options.importWorkflowRun ? { importWorkflowRun: (id: string) => { imported.push(id); options.importWorkflowRun!(id); } } : {}),
  };

  const send = async (
    event: string,
    payload: unknown,
    delivery: string,
    signature: (body: Uint8Array) => string | undefined,
    installationTargetId?: string,
  ) => {
    const body = new TextEncoder().encode(typeof payload === "string" ? payload : JSON.stringify(payload));
    return await ingestGitHubWebhook({
      body,
      headers: { event, delivery, signature: signature(body), installationTargetId },
    }, deps);
  };

  return {
    deliver: (event, payload, opts = {}) =>
      send(event, payload, opts.delivery ?? `d-${randomUUID()}`, (body) =>
        `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`, opts.installationTargetId),
    deliverUnsigned: (event, payload, opts = {}) =>
      send(event, payload, opts.delivery ?? `d-${randomUUID()}`, () =>
        "signature" in opts ? opts.signature : `sha256=${"0".repeat(64)}`),
    events: () => events,
    deliveries: () => deliveries,
    dispatched: () => dispatched,
    disabled: () => disabled,
    refreshed: () => refreshed,
    imported: () => imported,
    rerunRequests: () => rerunRequests,
    deps,
  };
}

test("creates one event per matching action on pull_request.opened", async () => {
  const harness = ingestHarness({ actions: [prAction({ patterns: ["main"] }), pushAction({ patterns: ["main"] })] });
  const result = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }), { delivery: "d1" });
  assert.equal(result.outcome, "processed");
  assert.equal(result.reason, null);
  assert.equal(result.eventIds.length, 1);
  const event = harness.events()[0]!;
  assert.equal(event.targetIdentity, `pr:7@${SHA_A}`);
  assert.equal(event.kind, "pull_request");
  assert.equal(event.origin, "webhook");
  assert.equal(event.deliveryId, "d1");
  assert.equal(event.status, "queued");
  assert.equal(event.actionRevision, 3);
  assert.equal(event.costCeilingUsd, 2);
  assert.equal(event.baseRef, "main");
  assert.equal(event.headRef, "topic");
  assert.equal(event.pullRequestNumber, 7);
  assert.equal(event.title, "Add gate");
  assert.deepEqual(harness.dispatched(), [event.id]);
  const delivery = harness.deliveries()[0]!;
  assert.equal(delivery.deliveryId, "d1");
  assert.equal(delivery.connectionId, "c1");
  assert.equal(delivery.event, "pull_request");
  assert.equal(delivery.action, "opened");
  assert.equal(delivery.repositoryKey, "github:1");
  assert.equal(delivery.installationId, "77");
  assert.equal(delivery.headSha, SHA_A);
  assert.equal(delivery.outcome, "processed");
  assert.deepEqual(delivery.eventIds, [event.id]);
  assert.deepEqual(delivery.matchedActionIds, result.matchedActionIds);
  assert.ok((delivery.durationMs ?? -1) >= 0);
});

test("creates an event for every enabled action whose pattern matches, and none for the others", async () => {
  const harness = ingestHarness({
    actions: [
      prAction({ patterns: ["main"], id: "a-main" }),
      prAction({ patterns: ["release/**"], id: "a-release" }),
      prAction({ patterns: ["main"], id: "a-disabled", enabled: false }),
    ],
  });
  const result = await harness.deliver("pull_request", prPayload({ number: 8, sha: SHA_A }));
  // "Matched" means the pattern matched: the disabled action is named because its
  // stale queue was cancelled, and only the enabled one produced an event.
  assert.deepEqual(result.matchedActionIds, ["a-main", "a-disabled"]);
  assert.equal(harness.events().length, 1);
  assert.equal(harness.events()[0]!.actionId, "a-main");
});

test("ignores a pull_request action the product does not handle", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const result = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A, action: "labeled" }));
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "action_not_handled");
  assert.equal(harness.events().length, 0);
  assert.equal(harness.deliveries().length, 1);
  assert.equal(harness.deliveries()[0]!.outcome, "ignored");
  assert.equal(harness.deliveries()[0]!.reason, "action_not_handled");
});

test("supersedes the queued event when a synchronize brings a new commit", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, updatedAt: "2026-09-30T11:50:00.000Z",
  }));
  const second = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_B, action: "synchronize", updatedAt: "2026-09-30T11:55:00.000Z",
  }));
  assert.equal(second.outcome, "processed");
  assert.equal(harness.events().length, 2);
  const [first, latest] = harness.events() as [GitHubActionEvent, GitHubActionEvent];
  assert.equal(first.status, "superseded");
  assert.equal(first.reason, "head_superseded");
  assert.ok(first.completedAt);
  assert.equal(latest.status, "queued");
  assert.deepEqual(harness.dispatched(), [first.id, latest.id]);
});

test("supersedes the queued event when the PR closes and scans nothing", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }));
  const closed = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A, action: "closed" }));
  assert.equal(closed.outcome, "ignored");
  assert.equal(closed.reason, "pull_request_closed");
  assert.deepEqual(closed.eventIds, []);
  assert.equal(harness.events().length, 1);
  assert.equal(harness.events()[0]!.status, "superseded");
  assert.equal(harness.events()[0]!.reason, "pull_request_closed");
  assert.equal(harness.dispatched().length, 1);
});

test("ignores a push whose after is all zeros", async () => {
  const harness = ingestHarness({ actions: [pushAction()] });
  const result = await harness.deliver("push", pushPayload({ ref: "refs/heads/main", after: "0".repeat(40) }));
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "branch_deleted");
  assert.equal(harness.events().length, 0);
});

test("ignores a ref outside refs/heads", async () => {
  const harness = ingestHarness({ actions: [pushAction()] });
  const result = await harness.deliver("push", pushPayload({ ref: "refs/tags/v1", after: SHA_A }));
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "ref_not_branch");
});

test("ignores a push to an unfollowed branch", async () => {
  const harness = ingestHarness({ actions: [pushAction({ patterns: ["release/**"] })] });
  const result = await harness.deliver("push", pushPayload({ ref: "refs/heads/main", after: SHA_A }));
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "branch_not_followed");
  assert.equal(harness.events().length, 0);
});

test("creates a push event with the target identity and the base of a non-default branch", async () => {
  const harness = ingestHarness({ actions: [pushAction({ patterns: ["main", "release/**"] })] });
  const onDefault = await harness.deliver("push", pushPayload({ ref: "refs/heads/main", after: SHA_A }));
  assert.equal(onDefault.outcome, "processed");
  assert.equal(harness.events()[0]!.targetIdentity, `push:main@${SHA_A}`);
  assert.equal(harness.events()[0]!.baseRef, null);
  assert.equal(harness.events()[0]!.headRef, "main");
  await harness.deliver("push", pushPayload({ ref: "refs/heads/release/9", after: SHA_B }));
  assert.equal(harness.events()[1]!.targetIdentity, `push:release/9@${SHA_B}`);
  assert.equal(harness.events()[1]!.baseRef, "main");
});

test("ignores a repository that is not enrolled", async () => {
  const harness = ingestHarness({ actions: [prAction()], repository: null });
  const result = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }));
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "repository_not_enrolled");
  assert.equal(harness.deliveries()[0]!.repositoryKey, null);
});

test("ignores a repository whose enrolment belongs to another connection", async () => {
  const harness = ingestHarness({
    actions: [prAction()],
    repository: { ...repository, githubConnectionId: "c2" },
  });
  const result = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }));
  assert.equal(result.reason, "repository_not_enrolled");
});

test("ignores a disabled repository", async () => {
  const harness = ingestHarness({ actions: [prAction()], repository: { ...repository, enabled: false } });
  const result = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }));
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "repository_disabled");
  assert.equal(harness.deliveries()[0]!.repositoryKey, "github:1");
});

test("ignores a repository with no action at all", async () => {
  const harness = ingestHarness({ actions: [] });
  const result = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }));
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "branch_not_followed");
});

test("skips a commit the action already analysed", async () => {
  const harness = ingestHarness({
    actions: [prAction({ id: "a1" })],
    analysed: [{ actionId: "a1", headSha: SHA_A }],
  });
  const result = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }));
  assert.equal(result.outcome, "processed");
  assert.equal(result.reason, "commit_already_analysed");
  assert.equal(result.eventIds.length, 1);
  assert.equal(harness.events()[0]!.status, "skipped");
  assert.equal(harness.events()[0]!.reason, "commit_already_analysed");
  assert.deepEqual(harness.dispatched(), []);
});

test("refreshes the installation cache when repositories are added", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const result = await harness.deliver("installation_repositories", {
    action: "added", installation: { id: 77 }, repositories_added: [{ id: 2 }],
  });
  assert.equal(result.outcome, "processed");
  assert.deepEqual(harness.refreshed(), ["77"]);
  assert.deepEqual(harness.disabled(), []);
});

test("disables actions when installation_repositories removes the repository", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const result = await harness.deliver("installation_repositories", {
    action: "removed", installation: { id: 77 }, repositories_removed: [{ id: 1 }, { id: 9 }],
  });
  assert.equal(result.outcome, "processed");
  assert.equal(result.reason, "repository_unauthorized");
  assert.deepEqual(harness.refreshed(), ["77"]);
  assert.deepEqual(harness.disabled(), [{ target: "github:1", reason: "repository_unauthorized" }]);
});

test("disables every action of a suspended or deleted installation", async () => {
  for (const action of ["suspend", "deleted"]) {
    const harness = ingestHarness({ actions: [prAction()] });
    const result = await harness.deliver("installation", { action, installation: { id: 77 } });
    assert.equal(result.outcome, "processed", action);
    assert.equal(result.reason, "installation_unauthorized", action);
    assert.deepEqual(harness.disabled(), [{ target: "installation:77", reason: "installation_unauthorized" }], action);
  }
  const harness = ingestHarness({ actions: [prAction()] });
  const created = await harness.deliver("installation", { action: "created", installation: { id: 77 } });
  assert.equal(created.outcome, "ignored");
  assert.equal(created.reason, "action_not_handled");
  assert.deepEqual(harness.disabled(), []);
});

test("reruns the gate on check_run.rerequested with a manual origin", async () => {
  const events: GitHubActionEvent[] = [];
  const harness = ingestHarness({
    actions: [prAction({ id: "a1" })],
    rerun: (input) => {
      const identity = rerunTargetIdentity(
        gitHubActionEventTargetIdentity({
          kind: "pull_request", headSha: input.headSha, headRef: "topic", pullRequestNumber: 7,
        }),
        input.checkRunId,
      );
      const event: GitHubActionEvent = {
        id: "rerun-1", actionId: "a1", repositoryKey: "github:1", actionRevision: 3,
        origin: "manual", deliveryId: null, kind: "pull_request", status: "queued",
        headSha: input.headSha, baseRef: "main", headRef: "topic", pullRequestNumber: 7,
        targetIdentity: identity, title: null, gateId: null, costCeilingUsd: 2,
        reason: null, error: null, detectedAt: "2026-09-30T12:00:00.000Z",
        observedAt: null, dispatchedAt: null, completedAt: null,
      };
      events.push(event);
      return event;
    },
  });
  const result = await harness.deliver("check_run", checkRunPayload());
  assert.equal(result.outcome, "processed");
  assert.deepEqual(result.eventIds, ["rerun-1"]);
  assert.equal(events[0]!.origin, "manual");
  assert.ok(events[0]!.targetIdentity.endsWith("#rerun:99"));
  assert.deepEqual(harness.dispatched(), ["rerun-1"]);
  // The lookup is scoped: the connection whose secret signed, the repository the
  // payload resolved to, and only then the check run's own identifiers.
  assert.deepEqual(harness.rerunRequests(), [{
    connectionId: "c1", repositoryKey: "github:1", externalId: "gate-1",
    headSha: SHA_A, checkRunId: "99",
  }]);
});

test("refuses a rerequest for a check run another App created", async () => {
  const harness = ingestHarness({
    actions: [prAction({ id: "a1" })],
    rerun: () => { throw new Error("must not be asked"); },
  });
  const foreign = await harness.deliver("check_run", checkRunPayload({ appId: 9999 }));
  assert.equal(foreign.outcome, "ignored");
  assert.equal(foreign.reason, "check_run_not_ours");
  assert.deepEqual(harness.rerunRequests(), []);

  // No App id on the payload, or none known for the connection: fail closed.
  const anonymous = await harness.deliver("check_run", {
    action: "rerequested",
    check_run: { id: 99, external_id: "gate-1", head_sha: SHA_A },
    repository: { id: 1 },
  });
  assert.equal(anonymous.reason, "check_run_not_ours");
  const unknownApp = ingestHarness({ actions: [prAction({ id: "a1" })], appId: null });
  assert.equal((await unknownApp.deliver("check_run", checkRunPayload())).reason, "check_run_not_ours");
  assert.deepEqual(unknownApp.rerunRequests(), []);
});

test("ignores a rerequest whose check run names no known gate", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const result = await harness.deliver("check_run", checkRunPayload({ externalId: "unknown" }));
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "rerun_target_unknown");
  assert.deepEqual(harness.dispatched(), []);
  const other = await harness.deliver("check_run", checkRunPayload({ action: "completed" }));
  assert.equal(other.reason, "action_not_handled");
});

test("hands a completed workflow run to the importer when there is one", async () => {
  const seen: string[] = [];
  const harness = ingestHarness({ actions: [prAction()], importWorkflowRun: (id) => seen.push(id) });
  const result = await harness.deliver("workflow_run", {
    action: "completed",
    workflow_run: { id: 4242, path: ".github/workflows/csb-security-change-gate.yml" },
    repository: { id: 1 },
  });
  assert.equal(result.outcome, "processed");
  assert.deepEqual(seen, ["4242"]);

  const without = ingestHarness({ actions: [prAction()] });
  const deferred = await without.deliver("workflow_run", {
    action: "completed", workflow_run: { id: 4242 }, repository: { id: 1 },
  });
  assert.equal(deferred.outcome, "ignored");
  assert.equal(deferred.reason, "workflow_run_not_supported");
});

test("ignores a workflow_run that is not the caller", async () => {
  const seen: string[] = [];
  const harness = ingestHarness({ actions: [prAction()], importWorkflowRun: (id) => seen.push(id) });
  const result = await harness.deliver("workflow_run", {
    action: "completed",
    workflow_run: { id: 4242, path: ".github/workflows/release.yml" },
    repository: { id: 1 },
  });
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "workflow_not_dispatched");
  assert.deepEqual(seen, []);
});

test("ignores a workflow_run that is still in progress", async () => {
  const seen: string[] = [];
  const harness = ingestHarness({ actions: [prAction()], importWorkflowRun: (id) => seen.push(id) });
  const result = await harness.deliver("workflow_run", {
    action: "requested",
    workflow_run: { id: 4242, path: ".github/workflows/csb-security-change-gate.yml" },
    repository: { id: 1 },
  });
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "action_not_handled");
  assert.deepEqual(seen, []);
});

test("answers duplicate on a redelivered delivery id", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const first = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }), { delivery: "same" });
  assert.equal(first.outcome, "processed");
  const again = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }), { delivery: "same" });
  assert.equal(again.outcome, "duplicate");
  assert.deepEqual(again.eventIds, []);
  assert.equal(harness.deliveries().length, 1);
  assert.equal(harness.events().length, 1);
  assert.equal(harness.dispatched().length, 1);
});

test("ignores an unhandled event type", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const result = await harness.deliver("star", { action: "created", repository: { id: 1 } });
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "event_not_handled");
  assert.equal(harness.deliveries().length, 1);
});

test("answers processed for ping without creating an event", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const result = await harness.deliver("ping", { zen: "Keep it logically awesome." });
  assert.equal(result.outcome, "processed");
  assert.equal(result.reason, null);
  assert.deepEqual(result.eventIds, []);
  assert.equal(harness.deliveries().length, 1);
});

test("records the delivery only after the signature is verified", async () => {
  const harness = ingestHarness({});
  const result = await harness.deliverUnsigned("pull_request", prPayload({ number: 7, sha: SHA_A }));
  assert.equal(result.outcome, "failed");
  assert.equal(result.reason, "signature_invalid");
  assert.equal(harness.deliveries().length, 0);

  const noSecret = ingestHarness({ secrets: [] });
  const unconfigured = await noSecret.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }));
  assert.equal(unconfigured.outcome, "failed");
  assert.equal(unconfigured.reason, "signature_invalid");
  assert.equal(noSecret.deliveries().length, 0);
});

test("refuses a delivery with no event name, no delivery id or no signature header", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const missingSignature = await harness.deliverUnsigned("pull_request", prPayload({ number: 7, sha: SHA_A }), { signature: undefined });
  assert.equal(missingSignature.outcome, "failed");
  assert.equal(missingSignature.reason, "malformed_delivery");
  const blankEvent = await harness.deliver("  ", prPayload({ number: 7, sha: SHA_A }));
  assert.equal(blankEvent.reason, "malformed_delivery");
  const blankDelivery = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }), { delivery: "" });
  assert.equal(blankDelivery.reason, "malformed_delivery");
  assert.equal(harness.deliveries().length, 0);
});

test("records a payload it cannot parse as a failed delivery", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const result = await harness.deliver("pull_request", "{not json");
  assert.equal(result.outcome, "failed");
  assert.equal(result.reason, "malformed_payload");
  assert.equal(harness.deliveries().length, 1);
  assert.equal(harness.deliveries()[0]!.outcome, "failed");
  assert.equal(harness.deliveries()[0]!.reason, "malformed_payload");
  assert.equal(harness.events().length, 0);

  const missingFields = await harness.deliver("pull_request", { action: "opened", repository: { id: 1 } });
  assert.equal(missingFields.outcome, "failed");
  assert.equal(missingFields.reason, "malformed_payload");
});

test("survives two concurrent deliveries for the same commit", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const payload = prPayload({ number: 7, sha: SHA_A });
  const [first, second] = await Promise.all([
    harness.deliver("pull_request", payload, { delivery: "d1" }),
    harness.deliver("pull_request", payload, { delivery: "d2" }),
  ]);
  assert.equal(harness.events().length, 1);
  assert.equal([first, second].filter((result) => result.eventIds.length === 1).length, 1);
  assert.equal(harness.dispatched().length, 1);
  const loser = [first, second].find((result) => result.eventIds.length === 0)!;
  assert.equal(loser.outcome, "ignored");
  assert.equal(loser.reason, "target_already_recorded");
  assert.equal(harness.deliveries().length, 2);
});

test("claims the delivery id before any work, in one transaction, and dispatches after it", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  let depth = 0;
  let maxDepth = 0;
  const calls: string[] = [];
  const trace = <T>(name: string, run: () => T): T => {
    calls.push(`${name}:${depth}`);
    return run();
  };
  const deps: GitHubWebhookIngestDependencies = {
    ...harness.deps,
    runInTransaction: (work) => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      try {
        return harness.deps.runInTransaction(work);
      } finally {
        depth -= 1;
      }
    },
    claimDelivery: (input) => trace("claim", () => harness.deps.claimDelivery(input)),
    createEvent: (input) => trace("create", () => harness.deps.createEvent(input)),
    supersede: (input) => trace("supersede", () => harness.deps.supersede(input)),
    completeDelivery: (id, patch) => trace("complete", () => harness.deps.completeDelivery(id, patch)),
    dispatch: (id) => trace("dispatch", () => harness.deps.dispatch(id)),
  };
  const body = new TextEncoder().encode(JSON.stringify(prPayload({ number: 7, sha: SHA_A })));
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  const result = await ingestGitHubWebhook({ body, headers: { event: "pull_request", delivery: "d1", signature } }, deps);
  assert.equal(result.outcome, "processed");
  assert.equal(maxDepth, 1);
  // The claim comes first: a concurrent duplicate must lose before anything is
  // written, and the supersession only follows a successful creation.
  assert.deepEqual(calls, ["claim:1", "create:1", "supersede:1", "complete:1", "dispatch:0"]);
});

/**
 * C-1. A delivery that describes an older change than the one already on the books
 * must create nothing and cancel nothing. Without this, a replay or an
 * out-of-order arrival supersedes the *current* head's queued event and no
 * reconciliation ever repairs it: the target identity already exists.
 */
test("a synchronize that arrives out of order leaves the current head queued", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  // The newer commit arrives first, as GitHub gives no ordering guarantee.
  const newer = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_B, action: "synchronize", updatedAt: "2026-09-30T11:59:00.000Z",
  }), { delivery: "d-newer" });
  assert.equal(newer.outcome, "processed");
  const queued = harness.events()[0]!;

  const older = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, action: "synchronize", updatedAt: "2026-09-30T11:50:00.000Z",
  }), { delivery: "d-older" });
  assert.equal(older.outcome, "ignored");
  assert.equal(older.reason, "stale_delivery");
  assert.deepEqual(older.eventIds, []);
  assert.equal(harness.events().length, 1, "no event for the commit already overtaken");
  assert.equal(harness.events()[0]!.id, queued.id);
  assert.equal(harness.events()[0]!.status, "queued", "the current head still has a gate coming");
  assert.deepEqual(harness.dispatched(), [queued.id]);
  assert.equal(harness.deliveries().at(-1)!.reason, "stale_delivery");
});

test("a redelivery of an older commit under a new delivery id cancels nothing", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, updatedAt: "2026-09-30T11:50:00.000Z",
  }), { delivery: "d1" });
  const second = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_B, action: "synchronize", updatedAt: "2026-09-30T11:55:00.000Z",
  }), { delivery: "d2" });
  const current = harness.events().find((event) => event.headSha === SHA_B)!;
  assert.deepEqual(second.eventIds, [current.id]);

  // The operator presses "Redeliver" on the first delivery: same payload, new id.
  const replay = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, updatedAt: "2026-09-30T11:50:00.000Z",
  }), { delivery: "d1-again" });
  assert.equal(replay.outcome, "ignored");
  assert.equal(replay.reason, "stale_delivery");
  assert.equal(harness.events().find((event) => event.headSha === SHA_B)!.status, "queued");
  assert.equal(harness.dispatched().length, 2);
});

test("a delivery whose target is already recorded supersedes nothing", async () => {
  // The same change twice under two delivery ids: the second creates nothing
  // because of the UNIQUE, and must therefore also cancel nothing.
  const harness = ingestHarness({ actions: [prAction()] });
  const payload = prPayload({ number: 7, sha: SHA_A, updatedAt: "2026-09-30T11:50:00.000Z" });
  await harness.deliver("pull_request", payload, { delivery: "d1" });
  const other = await harness.deliver("pull_request", prPayload({
    number: 8, sha: SHA_B, updatedAt: "2026-09-30T11:51:00.000Z",
  }), { delivery: "d2" });
  const second = await harness.deliver("pull_request", payload, { delivery: "d3" });
  assert.equal(second.outcome, "ignored");
  assert.equal(second.reason, "target_already_recorded");
  for (const event of harness.events()) assert.equal(event.status, "queued", event.targetIdentity);
  assert.deepEqual(other.matchedActionIds.length, 1);
});

test("refuses a delivery whose change is older than the freshness bound", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const result = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, updatedAt: "2026-09-28T11:00:00.000Z",
  }));
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "stale_delivery");
  assert.equal(harness.events().length, 0);
  // Inside the window it is business as usual.
  const fresh = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, updatedAt: "2026-09-30T11:00:00.000Z",
  }));
  assert.equal(fresh.outcome, "processed");
});

test("orders a push by the repository's push clock", async () => {
  const harness = ingestHarness({ actions: [pushAction()] });
  await harness.deliver("push", pushPayload({
    ref: "refs/heads/main", after: SHA_B, pushedAt: "2026-09-30T11:59:00.000Z",
  }));
  const queued = harness.events()[0]!;
  const older = await harness.deliver("push", pushPayload({
    ref: "refs/heads/main", after: SHA_A, pushedAt: "2026-09-30T11:50:00.000Z",
  }));
  assert.equal(older.reason, "stale_delivery");
  assert.equal(harness.events().length, 1);
  assert.equal(harness.events()[0]!.id, queued.id);
  assert.equal(harness.events()[0]!.status, "queued");
});

/**
 * I-1, the controller's ruling: a pull request whose head repository is not the
 * base repository runs code nobody in the organisation wrote, on our installation
 * token and our budget, and its own `.csb/guardrails.json` would be the policy
 * judging it. Off unless an administrator opted this action in.
 */
test("does not scan a pull request from a fork by default", async () => {
  const harness = ingestHarness({ actions: [prAction({ patterns: ["main"] })] });
  const result = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, headRepositoryId: 999,
  }));
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "fork_pull_request");
  assert.equal(harness.events().length, 0);
  assert.deepEqual(harness.dispatched(), []);
  assert.equal(harness.deliveries()[0]!.reason, "fork_pull_request");
});

test("scans a fork pull request through the base repository when an action opted in", async () => {
  const harness = ingestHarness({
    actions: [
      anAction({ triggerKind: "pull_request", id: "a-forks", includeForks: true }),
      anAction({ triggerKind: "pull_request", id: "a-no-forks", name: "PR strict" }),
    ],
  });
  const result = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, headRepositoryId: 999, head: "attacker-branch",
  }));
  assert.equal(result.outcome, "processed");
  assert.deepEqual(result.matchedActionIds, ["a-forks"], "the action that did not opt in sees nothing");
  const event = harness.events()[0]!;
  // The fork's head is reachable in the base repository as refs/pull/<n>/head, so
  // nothing downstream ever has to fetch from the fork, and the base branch stays
  // the authority for policy and baseline.
  assert.equal(event.headRef, "pull/7/head");
  assert.equal(event.baseRef, "main");
  assert.equal(event.targetIdentity, `pr:7@${SHA_A}`);
});

test("skips a draft pull request until it is marked ready for review", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const draft = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A, draft: true }));
  assert.equal(draft.outcome, "ignored");
  assert.equal(draft.reason, "draft_pull_request");
  assert.equal(harness.events().length, 0);
  const pushed = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, draft: true, action: "synchronize", updatedAt: "2026-09-30T11:59:30.000Z",
  }));
  assert.equal(pushed.reason, "draft_pull_request");
  // Marking it ready is exactly the moment the current head becomes worth paying for.
  const ready = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, draft: true, action: "ready_for_review", updatedAt: "2026-09-30T11:59:45.000Z",
  }));
  assert.equal(ready.outcome, "processed");
  assert.equal(harness.events().length, 1);
});

test("cancels the stale queue of an action that was disabled between two commits", async () => {
  const action = prAction({ id: "a1" });
  const harness = ingestHarness({ actions: [action] });
  await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, updatedAt: "2026-09-30T11:50:00.000Z",
  }));
  assert.equal(harness.events()[0]!.status, "queued");
  // An operator disables the action; the queued event must not outlive the next
  // commit, which will never be scanned either.
  action.enabled = false;
  const later = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_B, action: "synchronize", updatedAt: "2026-09-30T11:55:00.000Z",
  }));
  assert.equal(later.outcome, "ignored");
  assert.equal(later.reason, "branch_not_followed");
  assert.equal(harness.events().length, 1);
  assert.equal(harness.events()[0]!.status, "superseded");
  assert.equal(harness.events()[0]!.reason, "head_superseded");
});

test("strips control characters from the title it stores", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, title: "Fix\u0000 the\n deploy\r\thook\u001b[31m",
  }));
  assert.equal(harness.events()[0]!.title, "Fix the deploy hook [31m");
});

test("refreshes the installation cache after the transaction, and never twice for one delivery", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const payload = { action: "removed", installation: { id: 77 }, repositories_removed: [{ id: 1 }] };
  assert.equal((await harness.deliver("installation_repositories", payload, { delivery: "same" })).outcome, "processed");
  assert.deepEqual(harness.refreshed(), ["77"]);
  const again = await harness.deliver("installation_repositories", payload, { delivery: "same" });
  assert.equal(again.outcome, "duplicate");
  // A redelivery must not spend another authenticated GitHub call.
  assert.deepEqual(harness.refreshed(), ["77"]);
  assert.deepEqual(harness.disabled(), [{ target: "github:1", reason: "repository_unauthorized" }]);
});

/**
 * I-2. The rollback is asserted against a real `IMMEDIATE` transaction, not against
 * a double that merely records having been asked: a fault after the events are
 * written must leave neither the events nor the delivery row behind.
 */
test("a fault after the events are written leaves nothing behind", async () => {
  const Database = (await import("better-sqlite3")).default;
  const store = await import("./store.js");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO guardrail_repositories VALUES ('github:1')").run();
  store.ensureGitHubActionsSchema(db);
  const action = store.createGitHubAction({
    repositoryKey: "github:1", name: "PR", triggerKind: "pull_request", branchPatterns: ["main"],
    connectionId: "c1", installationId: "i1", repositoryId: "1", executor: "sentinel-managed",
    scanner: null, costCeilingUsd: 2, dailyCostCeilingUsd: 10, enabled: true,
    includeForks: false, createdBy: "u1",
  }, db);

  let breakCompletion = false;
  const dispatched: string[] = [];
  // Pinned to the clock the payloads below carry. With the real one their
  // `updated_at` ages past the staleness window and every delivery here reads
  // `stale_delivery` a day after the test was written.
  let clock = Date.parse("2026-09-30T12:00:00.000Z");
  const deps: GitHubWebhookIngestDependencies = {
    now: () => { clock += 3; return new Date(clock).toISOString(); },
    listSecrets: async () => [{ connectionId: "c1", secret: SECRET }],
    findRepository: (connectionId, repositoryId) =>
      connectionId === "c1" && repositoryId === "1" ? repository : null,
    listActions: (repositoryKey) => store.listGitHubActions({ repositoryKey }, db),
    newestObservedAt: (input) => store.newestObservedEventAt(input, db),
    createEvent: (input) => store.createGitHubActionEvent(input, db),
    supersede: (input) => store.supersedeQueuedEvents(input, db),
    hasAnalysedCommit: (actionId, headSha) => store.hasAnalysedCommit(actionId, headSha, db),
    claimDelivery: (input) => store.recordWebhookDelivery(input, db),
    completeDelivery: (deliveryId, patch) => {
      if (breakCompletion) throw new Error("database is locked");
      store.completeWebhookDelivery(deliveryId, patch, db);
    },
    disableActionsForRepository: () => {},
    disableActionsForInstallation: () => {},
    refreshInstallationRepositories: async () => {},
    dispatch: (id) => { dispatched.push(id); },
    connectionAppId: () => "4242",
    rerunGate: () => null,
    runInTransaction: (work) => db.transaction(work).immediate(),
  };
  const send = async (delivery: string, sha: string, updatedAt: string) => {
    const body = new TextEncoder().encode(JSON.stringify(prPayload({ number: 7, sha, updatedAt })));
    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    return await ingestGitHubWebhook({ body, headers: { event: "pull_request", delivery, signature } }, deps);
  };

  assert.equal((await send("ok-1", SHA_A, "2026-09-30T11:50:00.000Z")).outcome, "processed");
  assert.equal(store.listGitHubActionEvents({ actionId: action.id }, db).length, 1);

  breakCompletion = true;
  await assert.rejects(async () => { await send("broken", SHA_B, "2026-09-30T11:55:00.000Z"); }, /database is locked/);
  const events = store.listGitHubActionEvents({ actionId: action.id }, db);
  assert.equal(events.length, 1, "the event of the faulted delivery was discarded");
  assert.equal(events[0]!.headSha, SHA_A);
  assert.equal(events[0]!.status, "queued", "and so was its supersession");
  assert.equal(store.listWebhookDeliveries(10, db).length, 1);
  assert.deepEqual(dispatched.length, 1);
  db.close();
});

/**
 * N-2. `pull_request.head.repo` is `null` whenever the head repository is gone or
 * inaccessible — the classic case being a contributor who deletes the fork after
 * opening the pull request. A control whose whole point is "untrusted code on our
 * token" must not default to trust when it cannot tell.
 */
test("treats a pull request whose head repository is unknown as untrusted", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const payload = prPayload({ number: 7, sha: SHA_A });
  (payload.pull_request as Record<string, unknown>).head = { ref: "gone", sha: SHA_A, repo: null };
  const result = await harness.deliver("pull_request", payload);
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "pull_request_repository_unknown");
  assert.equal(harness.events().length, 0);

  const withoutBase = prPayload({ number: 8, sha: SHA_B });
  const pullRequest = withoutBase.pull_request as Record<string, unknown>;
  pullRequest.base = { ref: "main" };
  withoutBase.repository = { full_name: "okami/sentinel" };
  const unresolvable = await harness.deliver("pull_request", withoutBase);
  // No repository id at all is a malformed payload long before the fork question.
  assert.equal(unresolvable.reason, "malformed_payload");
});

test("an opted-in action still scans a pull request whose fork is gone, through the base repository", async () => {
  const harness = ingestHarness({
    actions: [anAction({ triggerKind: "pull_request", id: "a-forks", includeForks: true })],
  });
  const payload = prPayload({ number: 7, sha: SHA_A });
  (payload.pull_request as Record<string, unknown>).head = { ref: "gone", sha: SHA_A, repo: null };
  const result = await harness.deliver("pull_request", payload);
  assert.equal(result.outcome, "processed");
  // `refs/pull/<n>/head` exists in the base repository even when the fork does not.
  assert.equal(harness.events()[0]!.headRef, "pull/7/head");
});

/**
 * N-3. `pull_request.updated_at` has one-second resolution, so two heads can share
 * a clock. Neither is "strictly older", and without a tie-break both events stay
 * queued and the action pays twice for one pull request.
 */
test("breaks a clock tie by arrival, so one head survives and one is superseded", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const sameSecond = "2026-09-30T11:59:00.000Z";
  await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_A, action: "synchronize", updatedAt: sameSecond,
  }));
  const second = await harness.deliver("pull_request", prPayload({
    number: 7, sha: SHA_B, action: "synchronize", updatedAt: sameSecond,
  }));
  assert.equal(second.outcome, "processed");
  const [first, latest] = harness.events() as [GitHubActionEvent, GitHubActionEvent];
  assert.equal(first.status, "superseded", "the head that arrived first loses the tie");
  assert.equal(first.reason, "head_superseded");
  assert.equal(latest.status, "queued");
  // Only the survivor is worth a gate; the first was dispatched before the tie
  // existed, which is what the dispatcher's own head check is for.
  assert.equal(harness.events().filter((event) => event.status === "queued").length, 1);
});

test("breaks the tie the same way with no payload clock at all", async () => {
  // N-4: GitHub always sends a clock, but a payload without one must not leave two
  // queued events behind either.
  const harness = ingestHarness({ actions: [pushAction()] });
  const withoutClock = (after: string): Record<string, unknown> => ({
    ref: "refs/heads/main", before: SHA_B, after, repository: { id: 1 }, installation: { id: 77 },
  });
  await harness.deliver("push", withoutClock(SHA_A));
  await harness.deliver("push", withoutClock(SHA_B));
  assert.equal(harness.events().length, 2);
  assert.equal(harness.events()[0]!.status, "superseded");
  assert.equal(harness.events()[1]!.status, "queued");
});

test("hashes against the App the delivery names, and refuses one that names another", async () => {
  // N-1: the App id turns the twenty-secret loop into one hash on the normal path.
  const harness = ingestHarness({
    secrets: [
      { connectionId: "c0", secret: "another-secret-entirely", appId: "1000" },
      { connectionId: "c1", secret: SECRET, appId: "4242" },
    ],
    actions: [prAction()],
  });
  const named = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }), {
    installationTargetId: "4242",
  });
  assert.equal(named.outcome, "processed");
  assert.equal(harness.deliveries()[0]!.connectionId, "c1");
  const wrongApp = await harness.deliver("pull_request", prPayload({ number: 8, sha: SHA_B }), {
    installationTargetId: "1000",
  });
  assert.equal(wrongApp.outcome, "failed");
  assert.equal(wrongApp.reason, "signature_invalid");
  assert.equal(harness.deliveries().length, 1);
});
