import type {
  GitHubAction,
  GitHubActionEvent,
  GitHubActionEventCreate,
  GitHubActionTriggerKind,
  GuardrailRepository,
  WebhookDeliveryRecord,
} from "@csb/shared";

import { matchesAnyBranchPattern } from "./branch-patterns.js";
import { gitHubActionEventTargetIdentity, shortBranchName } from "./schema.js";
import type { supersedeQueuedEvents } from "./store.js";
import { verifyGitHubSignature, type GitHubWebhookSecret } from "./webhook-signature.js";

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
  /** Every App connection that has a webhook secret, in a stable order. */
  listSecrets(): Promise<GitHubWebhookSecret[]>;
  /** Resolved by `repository.id`, and only within the connection that signed. */
  findRepository(connectionId: string, githubRepositoryId: string): GuardrailRepository | null;
  listActions(repositoryKey: string): GitHubAction[];
  createEvent(input: GitHubActionEventCreate): GitHubActionEvent | null;
  supersede(input: Parameters<typeof supersedeQueuedEvents>[0]): number;
  hasAnalysedCommit(actionId: string, headSha: string): boolean;
  recordDelivery(input: WebhookDeliveryRecord): "recorded" | "duplicate";
  disableActionsForRepository(repositoryKey: string, reason: string): void;
  disableActionsForInstallation(installationId: string, reason: string): void;
  refreshInstallationRepositories(installationId: string): Promise<void>;
  /** Called after the transaction commits; GitHub never waits for a scan. */
  dispatch(eventId: string): void;
  rerunGate(input: { externalId: string; headSha: string; checkRunId: string }): GitHubActionEvent | null;
  /** Phase 4. Absent until the Actions executor returns by event. */
  importWorkflowRun?(workflowRunId: string): void;
  /**
   * Wraps the delivery row, the events and the supersession in one
   * `IMMEDIATE` transaction. The default runs the work directly, which is what
   * an in-memory test double wants.
   */
  runInTransaction?<T>(work: () => T): T;
}

export interface GitHubWebhookIngestInput {
  body: Uint8Array;
  headers: { event: string; delivery: string; signature: string | undefined };
}

const HANDLED_PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
const BRANCH_PREFIX = "refs/heads/";
const EMPTY_SHA = "0".repeat(40);
const SHA = /^[0-9a-f]{40}$/i;
const MAX_TITLE = 500;

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
 * events it produced. Dispatch happens after the transaction commits, so the
 * response does not wait for a scan.
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

  const verified = verifyGitHubSignature({
    body: input.body,
    header: signature,
    secrets: await deps.listSecrets(),
  });
  // Recording before the signature verifies would let anybody fill the table.
  if (!verified) {
    return { outcome: "failed", reason: "signature_invalid", eventIds: [], matchedActionIds: [] };
  }

  const payload = parseJsonObject(input.body);

  // The only asynchronous side effect: it must not run inside the transaction.
  if (payload && event === "installation_repositories") {
    const installationId = numericId(pick(payload, "installation"), "id");
    const action = text(payload.action);
    if (installationId && (action === "added" || action === "removed")) {
      await deps.refreshInstallationRepositories(installationId);
    }
  }

  const transaction = deps.runInTransaction ?? (<T>(work: () => T): T => work());
  let routed: Routed;
  try {
    routed = transaction(() => {
      const result = payload === null
        ? nothing("failed", "malformed_payload")
        : route(event, payload, verified.connectionId, deliveryId, receivedAt, deps);
      const recorded = deps.recordDelivery({
        deliveryId,
        connectionId: verified.connectionId,
        event,
        action: payload ? text(payload.action) || null : null,
        repositoryKey: result.repositoryKey,
        installationId: result.installationId,
        headSha: result.headSha,
        outcome: result.outcome,
        reason: result.reason,
        matchedActionIds: result.matchedActionIds,
        eventIds: result.eventIds,
        receivedAt,
        durationMs: Math.max(0, Date.parse(deps.now()) - Date.parse(receivedAt)),
      });
      if (recorded === "duplicate") throw DUPLICATE_DELIVERY;
      return result;
    });
  } catch (error) {
    if (error === DUPLICATE_DELIVERY) {
      return { outcome: "duplicate", reason: "duplicate_delivery", eventIds: [], matchedActionIds: [] };
    }
    throw error;
  }

  for (const eventId of routed.dispatchIds) deps.dispatch(eventId);
  return {
    outcome: routed.outcome,
    reason: routed.reason,
    eventIds: routed.eventIds,
    matchedActionIds: routed.matchedActionIds,
  };
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
      const workflowRunId = numericId(pick(payload, "workflow_run"), "id");
      if (!workflowRunId) return nothing("failed", "malformed_payload", { installationId });
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

  const resolved = resolveRepository(payload, connectionId, deps, installationId);
  if (!isResolved(resolved)) return { ...resolved, headSha };
  const repository = resolved.repository;
  const base: Partial<Routed> = { installationId, repositoryKey: repository.repositoryKey, headSha };

  const matched = deps.listActions(repository.repositoryKey).filter((candidate) =>
    candidate.triggerKind === "pull_request" && matchesAnyBranchPattern(candidate.branchPatterns, baseRef));
  if (matched.length === 0) return nothing("ignored", "branch_not_followed", base);

  if (action === "closed") {
    // Nothing is scanned: the queue of this pull request stops here.
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

  return createEvents(matched.filter((candidate) => candidate.enabled), {
    kind: "pull_request",
    repository,
    deliveryId,
    detectedAt,
    headSha,
    headRef,
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

  const resolved = resolveRepository(payload, connectionId, deps, installationId);
  if (!isResolved(resolved)) return { ...resolved, headSha };
  const repository = resolved.repository;
  const base: Partial<Routed> = { installationId, repositoryKey: repository.repositoryKey, headSha };

  const matched = deps.listActions(repository.repositoryKey).filter((candidate) =>
    candidate.triggerKind === "push" && candidate.enabled
    && matchesAnyBranchPattern(candidate.branchPatterns, branch));
  if (matched.length === 0) return nothing("ignored", "branch_not_followed", base);

  return createEvents(matched, {
    kind: "push",
    repository,
    deliveryId,
    detectedAt,
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
  const base: Partial<Routed> = {
    installationId, repositoryKey: resolved.repository.repositoryKey, headSha,
  };
  // A person asked for this run, so it is the one exception to "the same commit
  // is never analysed twice". The event is minted with `origin='manual'` and a
  // target identity suffixed with the check run, which is why the id travels.
  const event = deps.rerunGate({ externalId, headSha, checkRunId });
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
  if (actions.length === 0) return nothing("ignored", "branch_not_followed", base);
  const eventIds: string[] = [];
  const dispatchIds: string[] = [];
  let skipped = 0;
  for (const action of actions) {
    // Whatever was queued for an older commit of this target never runs: the
    // money has not been spent and the head has moved.
    deps.supersede({
      actionId: action.id,
      ...plan.supersedeScope,
      exceptHeadSha: plan.headSha,
      reason: "head_superseded",
    });
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
    });
    // `null` means this target is already on the books at this revision: the
    // reconciliation or a concurrent delivery got there first.
    if (!created) continue;
    eventIds.push(created.id);
    if (alreadyAnalysed) skipped += 1;
    else dispatchIds.push(created.id);
  }
  const matchedActionIds = actions.map((action) => action.id);
  if (eventIds.length === 0) return nothing("ignored", "target_already_recorded", { ...base, matchedActionIds });
  return {
    ...nothing("processed", skipped === eventIds.length ? "commit_already_analysed" : null, base),
    eventIds,
    matchedActionIds,
    dispatchIds,
  };
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

const title = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, MAX_TITLE) : null;

const sha = (value: unknown): string | null => {
  const candidate = text(value).toLowerCase();
  return SHA.test(candidate) ? candidate : null;
};

const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

/** GitHub sends numeric ids as JSON numbers; the store keys them as strings. */
function numericId(value: Record<string, unknown> | null, key: string): string | null {
  const raw = value?.[key];
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return String(raw);
  const candidate = text(raw);
  return /^[0-9]+$/.test(candidate) ? candidate : null;
}
