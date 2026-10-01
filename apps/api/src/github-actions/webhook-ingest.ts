import type {
  GitHubAction,
  GitHubActionEvent,
  GitHubActionEventCreate,
  GitHubActionTriggerKind,
  GuardrailRepository,
  WebhookDeliveryCompletion,
  WebhookDeliveryRecord,
} from "@csb/shared";

import { ACTIONS_CALLER_WORKFLOW_PATH } from "../guardrails/github-actions-executor.js";
import { matchesAnyBranchPattern } from "./branch-patterns.js";
import { gitHubActionEventTargetIdentity, shortBranchName } from "./schema.js";
import type { newestObservedEventAt, supersedeQueuedEvents } from "./store.js";
import {
  verifyGitHubSignature,
  type GitHubWebhookSecret,
  type VerifyGitHubSignatureInput,
} from "./webhook-signature.js";

/** The delivery outcomes the store records, plus the answer a redelivery gets. */
export interface GitHubWebhookIngestResult {
  outcome: "processed" | "ignored" | "duplicate" | "failed";
  /** Always a fixed snake_case code, never free text: it is written to the delivery row. */
  reason: string | null;
  eventIds: string[];
  matchedActionIds: string[];
}

export interface GitHubWebhookIngestDependencies {
  now(): string;
  /**
   * Every App connection that has a webhook secret, in a stable order, each with
   * its App id so one delivery costs one hash. This runs on **every** delivery,
   * including an unsigned flood, so the production wiring must go through
   * `createWebhookSecretCache` rather than decrypt the vault per connection per
   * request.
   */
  listSecrets(): Promise<ReadonlyArray<GitHubWebhookSecret>>;
  /** Resolved by `repository.id`, and only within the connection that signed. */
  findRepository(connectionId: string, githubRepositoryId: string): GuardrailRepository | null;
  listActions(repositoryKey: string): GitHubAction[];
  /** The newest change already recorded for this target, for the ordering guard. */
  newestObservedAt(input: Parameters<typeof newestObservedEventAt>[0]): string | null;
  createEvent(input: GitHubActionEventCreate): GitHubActionEvent | null;
  supersede(input: Parameters<typeof supersedeQueuedEvents>[0]): number;
  hasAnalysedCommit(actionId: string, headSha: string): boolean;
  /** Takes the delivery id before any work; `duplicate` means another one has it. */
  claimDelivery(input: WebhookDeliveryRecord): "recorded" | "duplicate";
  completeDelivery(deliveryId: string, patch: WebhookDeliveryCompletion): void;
  disableActionsForRepository(repositoryKey: string, reason: string): void;
  disableActionsForInstallation(installationId: string, reason: string): void;
  /** Runs after the transaction commits: it is asynchronous and it calls GitHub. */
  refreshInstallationRepositories(installationId: string): Promise<void>;
  /** Called after the transaction commits; GitHub never waits for a scan. */
  dispatch(eventId: string): void;
  /** The App id of a connection, to prove a check run is one of ours. */
  connectionAppId(connectionId: string): string | null;
  rerunGate(input: {
    connectionId: string;
    repositoryKey: string;
    externalId: string;
    headSha: string;
    checkRunId: string;
  }): GitHubActionEvent | null;
  /**
   * `workflow_run.completed` is the Actions executor's primary import trigger: the
   * run says it finished instead of the fifteen-second loop asking.
   */
  importWorkflowRun?(workflowRunId: string): void;
  /**
   * The delivery row, the events and the supersession in one `IMMEDIATE`
   * transaction. Required, and it must really roll back: a partial delivery would
   * cancel a queued gate and then answer "nothing happened".
   */
  runInTransaction<T>(work: () => T): T;
  /**
   * Overridable so the HTTP layer can hold its HMAC budget around the hash alone
   * and never across I/O. Defaults to `verifyGitHubSignature`.
   */
  verifySignature?(
    input: VerifyGitHubSignatureInput,
  ): Promise<{ connectionId: string } | null> | { connectionId: string } | null;
}

export interface GitHubWebhookIngestInput {
  body: Uint8Array;
  headers: {
    event: string;
    delivery: string;
    signature: string | undefined;
    /**
     * `X-GitHub-Hook-Installation-Target-ID`: the App id for an App webhook. It
     * names the connection before a single hash is computed, which is what keeps
     * an unauthenticated delivery at one HMAC instead of twenty.
     */
    installationTargetId?: string | undefined;
  };
}

const HANDLED_PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
const BRANCH_PREFIX = "refs/heads/";
const EMPTY_SHA = "0".repeat(40);
const SHA = /^[0-9a-f]{40}$/i;
const MAX_TITLE = 500;

/**
 * A change older than this is not worth acting on, and a captured signed body must
 * not stay replayable forever once the delivery table has been pruned past it.
 * Anything this old that still matters is the reconciliation's job.
 */
const MAX_CHANGE_AGE_MS = 24 * 60 * 60_000;

/** Thrown inside the transaction so a redelivery's writes are discarded. */
const DUPLICATE_DELIVERY = Symbol("duplicate_delivery");

interface Routed {
  outcome: "processed" | "ignored" | "failed";
  reason: string | null;
  eventIds: string[];
  matchedActionIds: string[];
  dispatchIds: string[];
  repositoryKey: string | null;
  installationId: string | null;
  headSha: string | null;
}

const nothing = (outcome: Routed["outcome"], reason: string | null, extra: Partial<Routed> = {}): Routed => ({
  outcome, reason, eventIds: [], matchedActionIds: [], dispatchIds: [],
  repositoryKey: null, installationId: null, headSha: null, ...extra,
});

/**
 * One delivery, start to finish: verify, parse, map the event onto the actions
 * that follow the branch, and write the delivery row together with whatever
 * events it produced. The delivery id is claimed first, so a concurrent duplicate
 * loses before anything is written; the dispatch and the installation-cache
 * refresh happen after the transaction commits, so the response never waits for a
 * scan or for GitHub.
 */
export async function ingestGitHubWebhook(
  input: GitHubWebhookIngestInput,
  deps: GitHubWebhookIngestDependencies,
): Promise<GitHubWebhookIngestResult> {
  const receivedAt = deps.now();
  const event = input.headers.event.trim();
  const deliveryId = input.headers.delivery.trim();
  const signature = input.headers.signature?.trim() ?? "";
  // A delivery without its three headers is not a delivery; nothing is recorded,
  // so an anonymous caller cannot fill the table.
  if (event === "" || deliveryId === "" || signature === "") {
    return { outcome: "failed", reason: "malformed_delivery", eventIds: [], matchedActionIds: [] };
  }

  const verified = await (deps.verifySignature ?? verifyGitHubSignature)({
    body: input.body,
    header: signature,
    secrets: await deps.listSecrets(),
    appId: input.headers.installationTargetId?.trim() || undefined,
  });
  // Recording before the signature verifies would let anybody fill the table.
  if (!verified) {
    return { outcome: "failed", reason: "signature_invalid", eventIds: [], matchedActionIds: [] };
  }

  const payload = parseJsonObject(input.body);
  const connectionId = verified.connectionId;

  let routed: Routed;
  try {
    routed = deps.runInTransaction(() => {
      const claimed = deps.claimDelivery({
        deliveryId,
        connectionId,
        event,
        action: payload ? text(payload.action) || null : null,
        // Provisional: a claimed delivery whose work never completed *is* a
        // failure, and `completeDelivery` overwrites all of it a moment later.
        repositoryKey: null,
        installationId: null,
        headSha: null,
        outcome: "failed",
        reason: null,
        matchedActionIds: [],
        eventIds: [],
        receivedAt,
        durationMs: null,
      });
      if (claimed === "duplicate") throw DUPLICATE_DELIVERY;
      const result = payload === null
        ? nothing("failed", "malformed_payload")
        : route(event, payload, connectionId, deliveryId, receivedAt, deps);
      deps.completeDelivery(deliveryId, {
        repositoryKey: result.repositoryKey,
        installationId: result.installationId,
        headSha: result.headSha,
        outcome: result.outcome,
        reason: result.reason,
        matchedActionIds: result.matchedActionIds,
        eventIds: result.eventIds,
        durationMs: Math.max(0, Date.parse(deps.now()) - Date.parse(receivedAt)),
      });
      return result;
    });
  } catch (error) {
    if (error === DUPLICATE_DELIVERY) {
      return { outcome: "duplicate", reason: "duplicate_delivery", eventIds: [], matchedActionIds: [] };
    }
    throw error;
  }

  // Outside the transaction: one is asynchronous, the other must not hold a write
  // lock while a scan starts.
  if (routed.installationId !== null && needsInstallationRefresh(event, payload)) {
    await deps.refreshInstallationRepositories(routed.installationId);
  }
  for (const eventId of routed.dispatchIds) deps.dispatch(eventId);
  return {
    outcome: routed.outcome,
    reason: routed.reason,
    eventIds: routed.eventIds,
    matchedActionIds: routed.matchedActionIds,
  };
}

function needsInstallationRefresh(event: string, payload: Record<string, unknown> | null): boolean {
  if (event !== "installation_repositories" || payload === null) return false;
  const action = text(payload.action);
  return action === "added" || action === "removed";
}

function route(
  event: string,
  payload: Record<string, unknown>,
  connectionId: string,
  deliveryId: string,
  detectedAt: string,
  deps: GitHubWebhookIngestDependencies,
): Routed {
  const action = text(payload.action);
  const installationId = numericId(pick(payload, "installation"), "id");
  switch (event) {
    case "ping":
      return nothing("processed", null, { installationId });
    case "pull_request":
      return routePullRequest(payload, action, connectionId, deliveryId, detectedAt, deps, installationId);
    case "push":
      return routePush(payload, connectionId, deliveryId, detectedAt, deps, installationId);
    case "check_run":
      return routeCheckRun(payload, action, connectionId, deps, installationId);
    case "installation_repositories":
      return routeInstallationRepositories(payload, action, connectionId, deps, installationId);
    case "installation":
      if (action !== "deleted" && action !== "suspend") return nothing("ignored", "action_not_handled", { installationId });
      if (!installationId) return nothing("failed", "malformed_payload");
      deps.disableActionsForInstallation(installationId, "installation_unauthorized");
      return nothing("processed", "installation_unauthorized", { installationId });
    case "workflow_run": {
      if (action !== "completed") return nothing("ignored", "action_not_handled", { installationId });
      const run = pick(payload, "workflow_run");
      const workflowRunId = numericId(run, "id");
      if (!workflowRunId) return nothing("failed", "malformed_payload", { installationId });
      // Every workflow in the repository delivers here. Only the pinned caller can
      // have produced a gate artifact, and the path is what says so without a call.
      const workflowPath = run === null ? null : run.path;
      if (typeof workflowPath === "string" && workflowPath !== ACTIONS_CALLER_WORKFLOW_PATH) {
        return nothing("ignored", "workflow_not_dispatched", { installationId });
      }
      if (!deps.importWorkflowRun) return nothing("ignored", "workflow_run_not_supported", { installationId });
      deps.importWorkflowRun(workflowRunId);
      return nothing("processed", null, { installationId });
    }
    default:
      return nothing("ignored", "event_not_handled", { installationId });
  }
}

interface ResolvedRepository {
  repository: GuardrailRepository;
}

/** `repository.id` decides, and only inside the connection whose secret signed. */
function resolveRepository(
  payload: Record<string, unknown>,
  connectionId: string,
  deps: GitHubWebhookIngestDependencies,
  installationId: string | null,
): ResolvedRepository | Routed {
  const repositoryId = numericId(pick(payload, "repository"), "id");
  if (!repositoryId) return nothing("failed", "malformed_payload", { installationId });
  const repository = deps.findRepository(connectionId, repositoryId);
  if (!repository) return nothing("ignored", "repository_not_enrolled", { installationId });
  if (!repository.enabled) {
    return nothing("ignored", "repository_disabled", { installationId, repositoryKey: repository.repositoryKey });
  }
  return { repository };
}

const isResolved = (value: ResolvedRepository | Routed): value is ResolvedRepository => "repository" in value;

function routePullRequest(
  payload: Record<string, unknown>,
  action: string,
  connectionId: string,
  deliveryId: string,
  detectedAt: string,
  deps: GitHubWebhookIngestDependencies,
  installationId: string | null,
): Routed {
  if (action !== "closed" && !HANDLED_PULL_REQUEST_ACTIONS.has(action)) {
    return nothing("ignored", "action_not_handled", { installationId });
  }
  const pullRequest = pick(payload, "pull_request");
  const number = positiveInteger(pullRequest?.number);
  const baseRef = text(pick(pullRequest, "base")?.ref);
  const headRef = text(pick(pullRequest, "head")?.ref);
  const headSha = sha(pick(pullRequest, "head")?.sha);
  if (!number || !baseRef || !headRef || !headSha) return nothing("failed", "malformed_payload", { installationId });
  // GitHub's own clock for this change, which is what orders two deliveries of the
  // same target; the author cannot choose it, unlike a commit timestamp.
  const observedAt = timestamp(pullRequest?.updated_at);
  if (tooOld(observedAt, detectedAt)) return nothing("ignored", "stale_delivery", { installationId, headSha });

  const resolved = resolveRepository(payload, connectionId, deps, installationId);
  if (!isResolved(resolved)) return { ...resolved, headSha };
  const repository = resolved.repository;
  const base: Partial<Routed> = { installationId, repositoryKey: repository.repositoryKey, headSha };

  // A draft is a work in progress nobody has asked to be judged yet, and
  // `ready_for_review` is the moment they do. Scanning every draft commit is the
  // same money for an answer the author is not reading.
  if (action !== "closed" && action !== "ready_for_review" && pullRequest?.draft === true) {
    return nothing("ignored", "draft_pull_request", base);
  }

  const matched = deps.listActions(repository.repositoryKey).filter((candidate) =>
    candidate.triggerKind === "pull_request" && matchesAnyBranchPattern(candidate.branchPatterns, baseRef));
  if (matched.length === 0) return nothing("ignored", "branch_not_followed", base);

  if (action === "closed") {
    // Nothing is scanned: the queue of this pull request stops here, whatever the
    // order the deliveries arrived in, and including the queues of actions that
    // were disabled in the meantime.
    for (const candidate of matched) {
      deps.supersede({
        actionId: candidate.id,
        pullRequestNumber: number,
        exceptHeadSha: "",
        reason: "pull_request_closed",
      });
    }
    return nothing("ignored", "pull_request_closed", {
      ...base,
      matchedActionIds: matched.map((candidate) => candidate.id),
    });
  }

  // A head repository that is not the base repository is a fork: untrusted code,
  // our installation token, and a `.csb/guardrails.json` the author controls.
  // `head.repo` is `null` whenever the head repository is gone or out of reach —
  // a contributor who deletes the fork after opening the pull request — and a
  // control against untrusted code must not read missing data as trust.
  const headRepositoryId = numericId(pick(pick(pullRequest, "head"), "repo"), "id");
  const baseRepositoryId = numericId(pick(pick(pullRequest, "base"), "repo"), "id")
    ?? numericId(pick(payload, "repository"), "id");
  const unknownOrigin = headRepositoryId === null || baseRepositoryId === null;
  const fromFork = unknownOrigin || headRepositoryId !== baseRepositoryId;
  const eligible = fromFork ? matched.filter((candidate) => candidate.includeForks) : matched;
  if (eligible.length === 0) {
    return nothing("ignored", unknownOrigin ? "pull_request_repository_unknown" : "fork_pull_request", {
      ...base,
      matchedActionIds: matched.map((one) => one.id),
    });
  }

  return createEvents(eligible, {
    kind: "pull_request",
    repository,
    deliveryId,
    detectedAt,
    observedAt,
    headSha,
    // The fork's head is reachable in the base repository as `refs/pull/<n>/head`,
    // so no path downstream ever fetches from the fork, and the base branch stays
    // the only authority for policy and baseline.
    headRef: fromFork ? `pull/${number}/head` : headRef,
    baseRef,
    pullRequestNumber: number,
    title: title(pullRequest?.title),
    supersedeScope: { pullRequestNumber: number },
  }, deps, base);
}

function routePush(
  payload: Record<string, unknown>,
  connectionId: string,
  deliveryId: string,
  detectedAt: string,
  deps: GitHubWebhookIngestDependencies,
  installationId: string | null,
): Routed {
  const ref = text(payload.ref);
  const after = text(payload.after).toLowerCase();
  if (!ref || !after) return nothing("failed", "malformed_payload", { installationId });
  if (!ref.startsWith(BRANCH_PREFIX)) return nothing("ignored", "ref_not_branch", { installationId });
  if (after === EMPTY_SHA) return nothing("ignored", "branch_deleted", { installationId });
  const headSha = sha(after);
  if (!headSha) return nothing("failed", "malformed_payload", { installationId });
  const branch = shortBranchName(ref);
  if (!branch) return nothing("ignored", "ref_not_branch", { installationId });
  // `repository.pushed_at` is GitHub's observation. `head_commit.timestamp` is the
  // committer's, so a contributor could backdate it and silence later pushes.
  const observedAt = timestamp(pick(payload, "repository")?.pushed_at);
  if (tooOld(observedAt, detectedAt)) return nothing("ignored", "stale_delivery", { installationId, headSha });

  const resolved = resolveRepository(payload, connectionId, deps, installationId);
  if (!isResolved(resolved)) return { ...resolved, headSha };
  const repository = resolved.repository;
  const base: Partial<Routed> = { installationId, repositoryKey: repository.repositoryKey, headSha };

  const matched = deps.listActions(repository.repositoryKey).filter((candidate) =>
    candidate.triggerKind === "push" && matchesAnyBranchPattern(candidate.branchPatterns, branch));
  if (matched.length === 0) return nothing("ignored", "branch_not_followed", base);

  return createEvents(matched, {
    kind: "push",
    repository,
    deliveryId,
    detectedAt,
    observedAt,
    headSha,
    headRef: branch,
    // A push to the protected branch has nothing to compare against; anything
    // else compares against the repository's default branch, as the poller did.
    baseRef: branch === repository.defaultBranch ? null : repository.defaultBranch,
    pullRequestNumber: null,
    title: null,
    supersedeScope: { headRef: branch },
  }, deps, base);
}

function routeCheckRun(
  payload: Record<string, unknown>,
  action: string,
  connectionId: string,
  deps: GitHubWebhookIngestDependencies,
  installationId: string | null,
): Routed {
  if (action !== "rerequested") return nothing("ignored", "action_not_handled", { installationId });
  const checkRun = pick(payload, "check_run");
  const checkRunId = numericId(checkRun, "id");
  const externalId = text(checkRun?.external_id);
  const headSha = sha(checkRun?.head_sha);
  if (!checkRunId || !externalId || !headSha) return nothing("failed", "malformed_payload", { installationId });

  const resolved = resolveRepository(payload, connectionId, deps, installationId);
  if (!isResolved(resolved)) return { ...resolved, headSha };
  const repositoryKey = resolved.repository.repositoryKey;
  const base: Partial<Routed> = { installationId, repositoryKey, headSha };

  // A rerun is exempt from the repeated-commit rule and spends money, so the check
  // run has to be one of ours. Fail closed when either side is unknown.
  const appId = numericId(pick(checkRun, "app"), "id");
  const ours = deps.connectionAppId(connectionId);
  if (!appId || !ours || appId !== ours) return nothing("ignored", "check_run_not_ours", base);

  // A person asked for this run, so it is the one exception to "the same commit is
  // never analysed twice". The event is minted with `origin='manual'` and a target
  // identity suffixed with the check run, which is why the id travels — and the
  // lookup is scoped by connection and repository so an `external_id` alone can
  // never mint a paid scan for somebody else's action.
  const event = deps.rerunGate({ connectionId, repositoryKey, externalId, headSha, checkRunId });
  if (!event) return nothing("ignored", "rerun_target_unknown", base);
  return {
    ...nothing("processed", null, base),
    eventIds: [event.id],
    matchedActionIds: [event.actionId],
    dispatchIds: [event.id],
  };
}

function routeInstallationRepositories(
  payload: Record<string, unknown>,
  action: string,
  connectionId: string,
  deps: GitHubWebhookIngestDependencies,
  installationId: string | null,
): Routed {
  if (action !== "added" && action !== "removed") return nothing("ignored", "action_not_handled", { installationId });
  if (!installationId) return nothing("failed", "malformed_payload");
  if (action === "added") return nothing("processed", null, { installationId });
  const removed = Array.isArray(payload.repositories_removed) ? payload.repositories_removed : [];
  for (const entry of removed) {
    const repositoryId = numericId(entry as Record<string, unknown> | null, "id");
    if (!repositoryId) continue;
    const repository = deps.findRepository(connectionId, repositoryId);
    // Nothing is deleted: the operator's actions stay, disabled, with the reason.
    if (repository) deps.disableActionsForRepository(repository.repositoryKey, "repository_unauthorized");
  }
  return nothing("processed", "repository_unauthorized", { installationId });
}

interface EventPlan {
  kind: GitHubActionTriggerKind;
  repository: GuardrailRepository;
  deliveryId: string;
  detectedAt: string;
  observedAt: string | null;
  headSha: string;
  headRef: string;
  baseRef: string | null;
  pullRequestNumber: number | null;
  title: string | null;
  supersedeScope: { pullRequestNumber: number } | { headRef: string };
}

function createEvents(
  actions: readonly GitHubAction[],
  plan: EventPlan,
  deps: GitHubWebhookIngestDependencies,
  base: Partial<Routed>,
): Routed {
  const matchedActionIds = actions.map((action) => action.id);
  const eventIds: string[] = [];
  const dispatchIds: string[] = [];
  let skipped = 0;
  let collided = 0;
  let stale = 0;
  // Whatever is cancelled has to be strictly older than this change, so a late
  // delivery can never cancel the newer head it missed.
  const boundary = plan.observedAt ?? plan.detectedAt;
  for (const action of actions) {
    const newest = deps.newestObservedAt({ actionId: action.id, ...plan.supersedeScope });
    if (plan.observedAt !== null && newest !== null && plan.observedAt < newest) {
      // Already overtaken: this delivery creates nothing and cancels nothing.
      stale += 1;
      continue;
    }
    if (!action.enabled) {
      // The action was disabled between two commits. Its queue is dead — nothing
      // will dispatch it — so the stale rows must not outlive the head they name.
      deps.supersede({
        actionId: action.id,
        ...plan.supersedeScope,
        exceptHeadSha: plan.headSha,
        reason: "head_superseded",
        beforeObservedAt: boundary,
      });
      continue;
    }
    const alreadyAnalysed = deps.hasAnalysedCommit(action.id, plan.headSha);
    const created = deps.createEvent({
      actionId: action.id,
      repositoryKey: plan.repository.repositoryKey,
      actionRevision: action.revision,
      origin: "webhook",
      deliveryId: plan.deliveryId,
      kind: plan.kind,
      ...(alreadyAnalysed ? { status: "skipped" as const } : {}),
      headSha: plan.headSha,
      baseRef: plan.baseRef,
      headRef: plan.headRef,
      pullRequestNumber: plan.pullRequestNumber,
      targetIdentity: gitHubActionEventTargetIdentity({
        kind: plan.kind,
        headSha: plan.headSha,
        headRef: plan.headRef,
        pullRequestNumber: plan.pullRequestNumber,
      }),
      title: plan.title,
      gateId: null,
      costCeilingUsd: action.costCeilingUsd,
      reason: alreadyAnalysed ? "commit_already_analysed" : null,
      error: null,
      detectedAt: plan.detectedAt,
      observedAt: plan.observedAt,
    });
    // `null` means this target is already on the books at this revision: the
    // reconciliation or a concurrent delivery got there first, so there is nothing
    // new here and nothing older to cancel either.
    if (!created) {
      collided += 1;
      continue;
    }
    // Only now, with the new head recorded, is the older queue obsolete — and the
    // new row itself breaks a clock tie, so two heads sharing one second of
    // GitHub's clock leave exactly one queued event rather than two gates.
    deps.supersede({
      actionId: action.id,
      ...plan.supersedeScope,
      exceptHeadSha: created.headSha,
      reason: "head_superseded",
      beforeObservedAt: boundary,
      beforeEventId: created.id,
    });
    eventIds.push(created.id);
    if (alreadyAnalysed) skipped += 1;
    else dispatchIds.push(created.id);
  }
  if (eventIds.length > 0) {
    return {
      ...nothing("processed", skipped === eventIds.length ? "commit_already_analysed" : null, base),
      eventIds,
      matchedActionIds,
      dispatchIds,
    };
  }
  const reason = stale > 0 ? "stale_delivery" : collided > 0 ? "target_already_recorded" : "branch_not_followed";
  return nothing("ignored", reason, { ...base, matchedActionIds });
}

function parseJsonObject(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function pick(value: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const nested = value?.[key];
  return nested !== null && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : null;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * The title is attacker-chosen text on a public repository, bound for a Markdown
 * comment and a screen. Control characters and line breaks go now; escaping at
 * render is phase 3's job.
 */
const title = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replaceAll(/[\u0000-\u001f\u007f]+/g, " ").replaceAll(/\s+/g, " ").trim();
  return clean === "" ? null : clean.slice(0, MAX_TITLE);
};

const sha = (value: unknown): string | null => {
  const candidate = text(value).toLowerCase();
  return SHA.test(candidate) ? candidate : null;
};

const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

/** GitHub sends a clock as an ISO string, and sometimes as epoch seconds. */
function timestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  const candidate = text(value);
  if (candidate === "") return null;
  const parsed = Date.parse(candidate);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

const tooOld = (observedAt: string | null, detectedAt: string): boolean =>
  observedAt !== null && Date.parse(detectedAt) - Date.parse(observedAt) > MAX_CHANGE_AGE_MS;

/** GitHub sends numeric ids as JSON numbers; the store keys them as strings. */
function numericId(value: Record<string, unknown> | null, key: string): string | null {
  const raw = value?.[key];
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return String(raw);
  const candidate = text(raw);
  return /^[0-9]+$/.test(candidate) ? candidate : null;
}
