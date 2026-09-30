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

const prPayload = (options: { number: number; sha: string; base?: string; head?: string; action?: string }): Record<string, unknown> => ({
  action: options.action ?? "opened",
  number: options.number,
  pull_request: {
    number: options.number,
    base: { ref: options.base ?? "main" },
    head: { ref: options.head ?? "topic", sha: options.sha },
    title: "Add gate",
  },
  repository: { id: 1 },
  installation: { id: 77 },
});

const pushPayload = (options: { ref: string; after: string; before?: string }): Record<string, unknown> => ({
  ref: options.ref,
  before: options.before ?? SHA_B,
  after: options.after,
  repository: { id: 1 },
  installation: { id: 77 },
});

interface Harness {
  deliver(event: string, payload: unknown, options?: { delivery?: string }): Promise<GitHubWebhookIngestResult>;
  deliverUnsigned(event: string, payload: unknown, options?: { delivery?: string; signature?: string | undefined }): Promise<GitHubWebhookIngestResult>;
  events(): GitHubActionEvent[];
  deliveries(): WebhookDeliveryRecord[];
  dispatched(): string[];
  disabled(): Array<{ target: string; reason: string }>;
  refreshed(): string[];
  imported(): string[];
  deps: GitHubWebhookIngestDependencies;
}

function ingestHarness(options: {
  actions?: GitHubAction[];
  repository?: GuardrailRepository | null;
  analysed?: Array<{ actionId: string; headSha: string }>;
  secrets?: Array<{ connectionId: string; secret: string }>;
  rerun?: (input: { externalId: string; headSha: string; checkRunId: string }) => GitHubActionEvent | null;
  importWorkflowRun?: (id: string) => void;
} = {}): Harness {
  const actions = options.actions ?? [];
  const events: GitHubActionEvent[] = [];
  const deliveries: WebhookDeliveryRecord[] = [];
  const dispatched: string[] = [];
  const disabled: Array<{ target: string; reason: string }> = [];
  const refreshed: string[] = [];
  const imported: string[] = [];
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
        events[index] = { ...event, status: "superseded", reason: input.reason, completedAt: deps.now() };
        changed += 1;
      }
      return changed;
    },
    hasAnalysedCommit: (actionId, headSha) => analysed.has(`${actionId}|${headSha}`),
    recordDelivery: (input) => {
      if (deliveries.some((delivery) => delivery.deliveryId === input.deliveryId)) return "duplicate";
      deliveries.push(input);
      return "recorded";
    },
    disableActionsForRepository: (repositoryKey, reason) => { disabled.push({ target: repositoryKey, reason }); },
    disableActionsForInstallation: (installationId, reason) => { disabled.push({ target: `installation:${installationId}`, reason }); },
    refreshInstallationRepositories: async (installationId) => { refreshed.push(installationId); },
    dispatch: (eventId) => { dispatched.push(eventId); },
    rerunGate: options.rerun ?? (() => null),
    ...(options.importWorkflowRun ? { importWorkflowRun: (id: string) => { imported.push(id); options.importWorkflowRun!(id); } } : {}),
  };

  const send = async (event: string, payload: unknown, delivery: string, signature: (body: Uint8Array) => string | undefined) => {
    const body = new TextEncoder().encode(typeof payload === "string" ? payload : JSON.stringify(payload));
    return await ingestGitHubWebhook({ body, headers: { event, delivery, signature: signature(body) } }, deps);
  };

  return {
    deliver: (event, payload, opts = {}) =>
      send(event, payload, opts.delivery ?? `d-${randomUUID()}`, (body) =>
        `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`),
    deliverUnsigned: (event, payload, opts = {}) =>
      send(event, payload, opts.delivery ?? `d-${randomUUID()}`, () =>
        "signature" in opts ? opts.signature : `sha256=${"0".repeat(64)}`),
    events: () => events,
    deliveries: () => deliveries,
    dispatched: () => dispatched,
    disabled: () => disabled,
    refreshed: () => refreshed,
    imported: () => imported,
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
  assert.deepEqual(result.matchedActionIds, ["a-main"]);
  assert.equal(harness.events().length, 1);
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
  await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_A }));
  const second = await harness.deliver("pull_request", prPayload({ number: 7, sha: SHA_B, action: "synchronize" }));
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
        dispatchedAt: null, completedAt: null,
      };
      events.push(event);
      return event;
    },
  });
  const result = await harness.deliver("check_run", {
    action: "rerequested",
    check_run: { id: 99, external_id: "gate-1", head_sha: SHA_A },
    repository: { id: 1 },
    installation: { id: 77 },
  });
  assert.equal(result.outcome, "processed");
  assert.deepEqual(result.eventIds, ["rerun-1"]);
  assert.equal(events[0]!.origin, "manual");
  assert.ok(events[0]!.targetIdentity.endsWith("#rerun:99"));
  assert.deepEqual(harness.dispatched(), ["rerun-1"]);
});

test("ignores a rerequest whose check run names no known gate", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const result = await harness.deliver("check_run", {
    action: "rerequested",
    check_run: { id: 99, external_id: "unknown", head_sha: SHA_A },
    repository: { id: 1 },
  });
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "rerun_target_unknown");
  assert.deepEqual(harness.dispatched(), []);
  const other = await harness.deliver("check_run", {
    action: "completed", check_run: { id: 99, external_id: "gate-1", head_sha: SHA_A }, repository: { id: 1 },
  });
  assert.equal(other.reason, "action_not_handled");
});

test("hands a completed workflow run to the importer when there is one", async () => {
  const seen: string[] = [];
  const harness = ingestHarness({ actions: [prAction()], importWorkflowRun: (id) => seen.push(id) });
  const result = await harness.deliver("workflow_run", {
    action: "completed", workflow_run: { id: 4242 }, repository: { id: 1 },
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

test("writes the delivery, the events and the supersession in one transaction", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  let depth = 0;
  let maxDepth = 0;
  const calls: string[] = [];
  const deps: GitHubWebhookIngestDependencies = {
    ...harness.deps,
    runInTransaction: (work) => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      try {
        return work();
      } finally {
        depth -= 1;
      }
    },
    createEvent: (input) => { calls.push(`create:${depth}`); return harness.deps.createEvent(input); },
    supersede: (input) => { calls.push(`supersede:${depth}`); return harness.deps.supersede(input); },
    recordDelivery: (input) => { calls.push(`delivery:${depth}`); return harness.deps.recordDelivery(input); },
    dispatch: (id) => { calls.push(`dispatch:${depth}`); harness.deps.dispatch(id); },
  };
  const body = new TextEncoder().encode(JSON.stringify(prPayload({ number: 7, sha: SHA_A })));
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  const result = await ingestGitHubWebhook({ body, headers: { event: "pull_request", delivery: "d1", signature } }, deps);
  assert.equal(result.outcome, "processed");
  assert.equal(maxDepth, 1);
  assert.deepEqual(calls, ["supersede:1", "create:1", "delivery:1", "dispatch:0"]);
});

test("a redelivery rolls its writes back instead of superseding twice", async () => {
  const harness = ingestHarness({ actions: [prAction()] });
  const rolled: string[] = [];
  const deps: GitHubWebhookIngestDependencies = {
    ...harness.deps,
    // A real IMMEDIATE transaction discards the writes; the fake records that it
    // was asked to, which is the behaviour the store relies on.
    runInTransaction: (work) => {
      try {
        return work();
      } catch (error) {
        rolled.push("rollback");
        throw error;
      }
    },
  };
  const body = new TextEncoder().encode(JSON.stringify(prPayload({ number: 7, sha: SHA_A })));
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  const headers = { event: "pull_request", delivery: "same", signature };
  assert.equal((await ingestGitHubWebhook({ body, headers }, deps)).outcome, "processed");
  const again = await ingestGitHubWebhook({ body, headers }, deps);
  assert.equal(again.outcome, "duplicate");
  assert.deepEqual(rolled, ["rollback"]);
  assert.equal(harness.dispatched().length, 1);
});
