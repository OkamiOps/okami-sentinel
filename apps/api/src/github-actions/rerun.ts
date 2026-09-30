import type { GitHubAction, GitHubActionEvent, GitHubActionEventCreate } from "@csb/shared";

import { gitHubActionEventTargetIdentity, rerunTargetIdentity } from "./schema.js";

export interface RerunGateDependencies {
  now(): string;
  /** The event that produced the gate whose id the check run carries as `external_id`. */
  findEventByGateId(gateId: string): GitHubActionEvent | null;
  getAction(actionId: string): GitHubAction | null;
  createEvent(input: GitHubActionEventCreate): GitHubActionEvent | null;
}

export interface RerunGateRequest {
  connectionId: string;
  repositoryKey: string;
  externalId: string;
  headSha: string;
  checkRunId: string;
}

/**
 * `check_run.rerequested`: the one exception to "the same commit is never
 * analysed twice", because a person asked for it. The event is minted with
 * `origin='manual'` and a target identity suffixed with the check run, so it
 * cannot collide with the automatic event that already ran.
 *
 * The lookup is scoped by connection **and** repository: an `external_id` is a
 * value anybody who can see a check run can read, and on its own it must never
 * be able to mint a paid scan for somebody else's action.
 */
export function rerunGitHubActionGate(
  request: RerunGateRequest,
  deps: RerunGateDependencies,
): GitHubActionEvent | null {
  const previous = deps.findEventByGateId(request.externalId);
  if (previous === null || previous.repositoryKey !== request.repositoryKey) return null;
  const action = deps.getAction(previous.actionId);
  if (action === null
    || !action.enabled
    || action.connectionId !== request.connectionId
    || action.repositoryKey !== request.repositoryKey) {
    return null;
  }
  // The fork opt-in is read here too: a rerun spends money on a head nobody in
  // the organisation wrote, and the flag may have been turned off since.
  if (previous.headRef.startsWith("pull/") && !action.includeForks) return null;
  const now = deps.now();
  const identity = gitHubActionEventTargetIdentity({
    kind: previous.kind,
    headSha: request.headSha,
    headRef: previous.headRef,
    pullRequestNumber: previous.pullRequestNumber,
  });
  return deps.createEvent({
    actionId: action.id,
    repositoryKey: action.repositoryKey,
    // The revision that is live now: the rerun is judged by today's action.
    actionRevision: action.revision,
    origin: "manual",
    deliveryId: null,
    kind: previous.kind,
    status: "queued",
    headSha: request.headSha,
    baseRef: previous.baseRef,
    headRef: previous.headRef,
    pullRequestNumber: previous.pullRequestNumber,
    targetIdentity: rerunTargetIdentity(identity, request.checkRunId),
    title: previous.title,
    gateId: null,
    costCeilingUsd: action.costCeilingUsd,
    reason: "check_run_rerequested",
    error: null,
    detectedAt: now,
    observedAt: now,
  });
}
