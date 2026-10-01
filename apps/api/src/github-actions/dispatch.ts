import type { GateTarget, GitHubAction, GitHubActionEvent, GitHubActionEventPatch, GuardrailRepository } from "@csb/shared";

import { listGuardrailRepositories } from "../gate-store.js";
import type { AutomaticGitHubScanInput } from "../github-monitor-dispatch.js";
import {
  failOrphanedGitHubActionDispatches,
  getGitHubAction,
  getGitHubActionEvent,
  patchGitHubActionEvent,
  reserveGitHubActionEventDispatch,
} from "./store.js";

/**
 * Refusals that happen **before** anything was launched. They are recorded as
 * `skipped` with the code as the reason: nothing was spent, and the event is
 * finished rather than pending. Anything else is post-dispatch ambiguity — the
 * scan may have reached its provider — and becomes `failed`, which is never
 * retried blindly.
 */
/**
 * Refusals whose cause is **this process**, not the change. Terminating one would
 * lose the commit for good: the webhook cannot recreate the event (the `UNIQUE`
 * on the target identity refuses it at the same revision) and the reconciliation
 * would not either (the SHA is on the action's books). So the row goes back to
 * `queued` with its reservation released, exactly as a spent daily ceiling does,
 * and the next process's first reconciliation dispatches it.
 *
 * Only server-side transients belong here. `target_preview_executor_unavailable`
 * does not: that is the repository's own configuration — an Actions caller that
 * is not installed — and re-arming it every quarter of an hour would buy a
 * preview call per cycle for a verdict that cannot change on its own.
 */
export const TRANSIENT_DISPATCH_CODES = new Set(["server_draining"]);

const PRE_DISPATCH_CODES = new Set([
  "head_superseded",
  "fork_pull_request",
  "github_action_authority_invalid",
  "github_action_budget_required",
  "github_action_scanner_required",
  "github_action_actions_policy_required",
  "github_action_policy_budget_exceeded",
  "action_revision_changed",
  "monitor_actions_duplicate_triggers",
  "target_preview_invalid",
  "target_preview_stale",
  "target_preview_executor_unavailable",
  "server_draining",
]);

/** The head ref an opted-in fork pull request carries: a ref of the *base* repository. */
const FORK_HEAD_REF = /^pull\/([1-9][0-9]*)\/head$/;

export interface GitHubActionDispatchDependencies {
  /**
   * The paid launch: preview, accept, re-check and start. It has no default
   * because a dispatcher that invents one would spend money by importing.
   */
  start(input: AutomaticGitHubScanInput): Promise<{ gateId: string; headSha: string }>;
  now?(): Date;
  getEvent?(id: string): GitHubActionEvent | null;
  getAction?(id: string): GitHubAction | null;
  getRepository?(repositoryKey: string): GuardrailRepository | null;
  reserve?(input: Parameters<typeof reserveGitHubActionEventDispatch>[0]): GitHubActionEvent | null;
  patchEvent?(id: string, patch: GitHubActionEventPatch): void;
}

/** Events this process is dispatching right now: they are not orphans. */
const inFlight = new Set<string>();

/**
 * One queued event, start to finish. The order is the one the poller established
 * and the spec keeps: revalidate the authority triple against the repository row,
 * refuse a fork the action is no longer opted into, reserve against the UTC-day
 * budget, launch, and write the outcome exactly once.
 *
 * It never throws: the event's own row is where a dispatch reports, and the
 * callers — a webhook that has already answered GitHub, and the reconciliation
 * loop — have nowhere to put an exception.
 */
export async function dispatchGitHubActionEvent(
  eventId: string,
  deps: GitHubActionDispatchDependencies,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const getEvent = deps.getEvent ?? ((id: string) => getGitHubActionEvent(id));
  const getAction = deps.getAction ?? ((id: string) => getGitHubAction(id));
  const reserve = deps.reserve ?? ((input: Parameters<typeof reserveGitHubActionEventDispatch>[0]) =>
    reserveGitHubActionEventDispatch(input));
  const patch = deps.patchEvent ?? ((id: string, value: GitHubActionEventPatch) => {
    patchGitHubActionEvent(id, value);
  });
  const getRepository = deps.getRepository ?? ((repositoryKey: string) =>
    listGuardrailRepositories().find((candidate) => candidate.repositoryKey === repositoryKey) ?? null);
  const skip = (id: string, reason: string): void => {
    patch(id, { status: "skipped", reason, completedAt: now().toISOString() });
  };

  const event = getEvent(eventId);
  // A terminal event is finished, and one already reserved is somebody else's.
  if (event === null || event.status !== "queued") return;
  const action = getAction(event.actionId);
  if (action === null) {
    skip(event.id, "github_action_authority_invalid");
    return;
  }
  // The authority triple is revalidated against the repository row on every
  // dispatch, not trusted from the action: an enrolment that was re-pointed at
  // another installation must not spend on the old one's token.
  const repository = getRepository(action.repositoryKey);
  if (!action.enabled
    || action.repositoryKey !== event.repositoryKey
    || repository === null
    || repository.source !== "github"
    || !repository.enabled
    || repository.githubConnectionId !== action.connectionId
    || repository.githubInstallationId !== action.installationId
    || repository.githubRepositoryId !== action.repositoryId) {
    skip(event.id, "github_action_authority_invalid");
    return;
  }
  const fork = FORK_HEAD_REF.exec(event.headRef);
  if (fork !== null) {
    // The opt-in may have been turned off after this event was queued. The head
    // of a fork is code nobody in the organisation wrote, so the flag is read at
    // dispatch as well as at ingestion, and the refusal costs nothing.
    if (!action.includeForks) {
      skip(event.id, "fork_pull_request");
      return;
    }
    // `pull/<n>/head` exists in the base repository, and only as the head of that
    // pull request. Anything else carrying the ref would be resolved as a branch,
    // which is the one read that could reach the fork.
    if (event.kind !== "pull_request" || event.pullRequestNumber !== Number(fork[1])) {
      skip(event.id, "github_action_authority_invalid");
      return;
    }
  }
  // Last, because turning the fork opt-in off moves the revision too, and the
  // refusal an operator reads should name what they changed.
  if (action.revision !== event.actionRevision) {
    skip(event.id, "action_revision_changed");
    return;
  }

  const at = now();
  const { start: dayStart, end: dayEnd } = utcDay(at);
  const dispatching = reserve({
    eventId: event.id,
    actionId: action.id,
    repositoryKey: action.repositoryKey,
    actionRevision: action.revision,
    dayStart,
    dayEnd,
    costCeilingUsd: action.costCeilingUsd,
    dailyCostCeilingUsd: action.dailyCostCeilingUsd ?? action.costCeilingUsd,
    at: at.toISOString(),
  });
  if (dispatching === null) {
    // `reserve` also answers `null` when another caller won the row — the
    // webhook's fire-and-forget dispatch and the reconciliation's awaited one can
    // address the same event — so the reason is only written while the row really
    // is still waiting for a budget. Stamping it on a live dispatch would report a
    // ceiling that was never hit (M-2).
    if (getEvent(event.id)?.status === "queued") patch(event.id, { reason: "daily_cost_ceiling" });
    return;
  }

  inFlight.add(dispatching.id);
  try {
    let target: GateTarget;
    try {
      target = targetForEvent(dispatching, repository);
    } catch {
      skip(dispatching.id, "github_action_authority_invalid");
      return;
    }
    const result = await deps.start({ action, event: dispatching, target });
    if (result.headSha !== dispatching.headSha) {
      // The launch answered about another commit, so no gate of ours is linked and
      // the reservation is released with the failure.
      patch(dispatching.id, {
        status: "failed", error: "automatic_dispatch_uncertain", completedAt: now().toISOString(),
      });
      return;
    }
    patch(dispatching.id, {
      status: "launched", gateId: result.gateId, completedAt: now().toISOString(),
    });
  } catch (error) {
    const code = dispatchCode(error);
    if (TRANSIENT_DISPATCH_CODES.has(code)) {
      patch(dispatching.id, { status: "queued", reason: code, dispatchedAt: null });
      return;
    }
    if (PRE_DISPATCH_CODES.has(code)) {
      skip(dispatching.id, code);
      return;
    }
    // The scan may or may not have reached its provider. The uncertainty is
    // preserved — the event is terminal, never retried blindly — but the day's
    // budget is not: a standing refusal would otherwise spend it on nothing.
    patch(dispatching.id, { status: "failed", error: code, completedAt: now().toISOString() });
  } finally {
    inFlight.delete(dispatching.id);
  }
}

export interface OrphanedDispatchDependencies {
  now?(): Date;
  failOrphans?(now: string, options: { exceptEventIds: readonly string[] }): number;
}

/**
 * A process that died between the reservation and the launch left events stuck in
 * `dispatching`. They become terminal — the money may well have been spent — and
 * the dispatches this process is running right now are excluded, so the
 * reconciliation loop can call it every quarter of an hour without killing live
 * work.
 */
export function reconcileOrphanedGitHubActionDispatches(
  deps: OrphanedDispatchDependencies = {},
): number {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const fail = deps.failOrphans
    ?? ((at: string, options: { exceptEventIds: readonly string[] }) =>
      failOrphanedGitHubActionDispatches(at, options));
  return fail(now, { exceptEventIds: [...inFlight] });
}

/**
 * The gate a event describes. A pull request is always addressed by its number,
 * which is what keeps every read on the base repository — including an opted-in
 * fork, whose head is reachable there as `pull/<n>/head` and nowhere else we ask.
 * A push to the protected branch builds the baseline; anything else is compared
 * against the default branch, exactly as the poller did.
 */
function targetForEvent(event: GitHubActionEvent, repository: GuardrailRepository | null): GateTarget {
  if (event.kind === "pull_request" && event.pullRequestNumber !== null) {
    return { kind: "pull_request", number: event.pullRequestNumber };
  }
  if (event.kind === "pull_request") throw new Error("github_action_authority_invalid");
  if (repository !== null && event.headRef === repository.defaultBranch) {
    return { kind: "protected_branch", ref: event.headRef };
  }
  if (event.baseRef === null) throw new Error("github_action_authority_invalid");
  return { kind: "compare", baseRef: event.baseRef, headRef: event.headRef };
}

function utcDay(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}

/** Only a code the dispatcher itself defines survives; upstream text never does. */
function dispatchCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (PRE_DISPATCH_CODES.has(message)) return message;
  if (error && typeof error === "object" && "code" in error
    && typeof error.code === "string" && PRE_DISPATCH_CODES.has(error.code)) {
    return error.code;
  }
  return "automatic_dispatch_failed";
}
