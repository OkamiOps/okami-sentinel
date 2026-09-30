import type {
  GitHubAction,
  GitHubActionEvent,
  GitHubActionEventCreate,
  GitHubActionEventPatch,
  GuardrailRepository,
} from "@csb/shared";

import type { GitHubInstallationPermissions } from "../github-app/github-app-client.js";
import { matchesAnyBranchPattern } from "./branch-patterns.js";
import { gitHubActionEventTargetIdentity, shortBranchName } from "./schema.js";
import type { supersedeQueuedEvents } from "./store.js";

/** `GET /repos/{o}/{r}/pulls?state=open&per_page=100`, at most three pages. */
export const GITHUB_RECONCILE_MAX_PULL_REQUEST_PAGES = 3;
/** `GET /repos/{o}/{r}/branches?per_page=100`, at most two. */
export const GITHUB_RECONCILE_MAX_BRANCH_PAGES = 2;
const PAGE_SIZE = 100;

/** Five minutes to an hour; the default is the spec's quarter of an hour. */
export const GITHUB_RECONCILE_MIN_INTERVAL_MS = 300_000;
export const GITHUB_RECONCILE_MAX_INTERVAL_MS = 3_600_000;
export const GITHUB_RECONCILE_DEFAULT_INTERVAL_MS = 900_000;

/**
 * A queued change this old is not worth money. It is the same bound the webhook
 * applies to a late delivery (`stale_delivery`), applied to the other end: an
 * event that waited a day — because the process was down, or the daily ceiling
 * never freed — describes a commit nobody is waiting on any more. Without it, the
 * first reconciliation after an upgrade would dispatch the poller's whole leftover
 * queue.
 */
const MAX_QUEUED_AGE_MS = 24 * 60 * 60_000;

const READ_PERMISSIONS: GitHubInstallationPermissions = { contents: "read", pull_requests: "read" };

export interface GitHubReconcileResult {
  /** Repositories with at least one enabled action that were actually read. */
  repositories: number;
  /** Events created as `queued`: commits a webhook should have brought and did not. */
  created: number;
  /** Events created as `observed`: a first run, which establishes a baseline and spends nothing. */
  observed: number;
  errors: number;
}

export interface GitHubReconcilerDependencies {
  now(): Date;
  listActions(): GitHubAction[];
  getRepository(repositoryKey: string): GuardrailRepository | null;
  /** Read-only GitHub reads, already scoped to the repository's App authority. */
  readRepositoryJson(
    repository: GuardrailRepository,
    resourcePath: string,
    permissions: GitHubInstallationPermissions,
  ): Promise<unknown>;
  createEvent(input: GitHubActionEventCreate): GitHubActionEvent | null;
  /** Wire it to `hasGitHubActionEventForHeadSha`. */
  hasEventForHeadSha(actionId: string, headSha: string): boolean;
  supersede(input: Parameters<typeof supersedeQueuedEvents>[0]): number;
  listQueuedEvents(actionId: string): GitHubActionEvent[];
  patchEvent(id: string, patch: GitHubActionEventPatch): void;
  recordReconciliation(
    actionId: string,
    outcome: { error: string | null; initializeBaseline?: boolean },
  ): void;
  /** The dispatcher. Awaited one event at a time, so the day's budget is spent in order. */
  dispatch(eventId: string): Promise<void> | void;
  /** Reservations a dead process left behind. */
  reconcileOrphans(): number;
  disableActionsForRepository(repositoryKey: string, reason: string): void;
  /**
   * Every installation and the repositories it still reaches, or `null` when
   * GitHub could not be asked. GitHub does **not** redeliver an `installation` or
   * `installation_repositories` webhook, so without this a repository removed
   * from the installation would keep its actions enabled for ever.
   */
  listInstallationScopes?(): Promise<ReadonlyArray<{
    installationId: string;
    repositoryIds: readonly string[];
  }> | null>;
  /** The delivery-free half of the spec's `IMMEDIATE` rule: one write lock per repository. */
  runInTransaction<T>(work: () => T): T;
}

interface RemotePullRequest {
  number: number;
  title: string | null;
  baseRef: string;
  headRef: string;
  headSha: string;
  draft: boolean;
  /** A head repository that is not the base one, or one we could not read at all. */
  fromFork: boolean;
  updatedAt: string | null;
}

interface RemoteBranch { name: string; headSha: string }

/**
 * The safety net under the webhook: every quarter of an hour, read what GitHub
 * would have told us and create the events the deliveries we never got would have
 * created. It reads and it never writes to GitHub, and it creates an event only
 * for a commit no event of that action already carries — so a cycle in which
 * nothing moved costs nothing and scans nothing.
 */
export async function reconcileGitHubActions(
  deps: GitHubReconcilerDependencies,
): Promise<GitHubReconcileResult> {
  const result: GitHubReconcileResult = { repositories: 0, created: 0, observed: 0, errors: 0 };
  deps.reconcileOrphans();
  if (!await reconcileInstallationScope(deps)) result.errors += 1;

  const byRepository = new Map<string, GitHubAction[]>();
  for (const action of deps.listActions()) {
    if (!action.enabled) continue;
    const group = byRepository.get(action.repositoryKey);
    if (group) group.push(action);
    else byRepository.set(action.repositoryKey, [action]);
  }

  for (const [repositoryKey, actions] of byRepository) {
    const repository = deps.getRepository(repositoryKey);
    if (repository === null || repository.source !== "github" || !repository.enabled) {
      result.errors += 1;
      for (const action of actions) {
        deps.recordReconciliation(action.id, { error: "github_action_repository_missing" });
      }
      continue;
    }
    let pullRequests: RemotePullRequest[] = [];
    let branches: RemoteBranch[] = [];
    try {
      if (actions.some((action) => action.triggerKind === "pull_request")) {
        pullRequests = await listOpenPullRequests(repository, deps);
      }
      if (actions.some((action) => action.triggerKind === "push")) {
        branches = await listBranchHeads(repository, deps);
      }
    } catch {
      // Never the upstream message: it is written to a row a screen reads.
      result.errors += 1;
      for (const action of actions) {
        deps.recordReconciliation(action.id, { error: "github_action_reconcile_failed" });
      }
      continue;
    }

    result.repositories += 1;
    const detectedAt = deps.now().toISOString();
    const dispatchable: string[] = [];
    deps.runInTransaction(() => {
      for (const action of actions) {
        const firstRun = action.baselineInitializedAt === null;
        const created = action.triggerKind === "pull_request"
          ? recordPullRequests(action, repository, pullRequests, firstRun, detectedAt, deps)
          : recordBranches(action, repository, branches, firstRun, detectedAt, deps);
        if (firstRun) result.observed += created.length;
        else result.created += created.length;
        deps.recordReconciliation(action.id, { error: null, initializeBaseline: firstRun });
        // A first run establishes the baseline and dispatches nothing, ever.
        if (!firstRun) dispatchable.push(...queuedForDispatch(action, detectedAt, deps));
      }
    });
    for (const eventId of dispatchable) await deps.dispatch(eventId);
  }
  return result;
}

/**
 * Re-lists the installations and disables the actions of a repository the
 * installation no longer reaches. A listing that failed disables **nothing**: a
 * blinking GitHub API must not stop an operator's automation, and the next cycle
 * will ask again.
 */
async function reconcileInstallationScope(deps: GitHubReconcilerDependencies): Promise<boolean> {
  if (!deps.listInstallationScopes) return true;
  let scopes: ReadonlyArray<{ installationId: string; repositoryIds: readonly string[] }> | null;
  try {
    scopes = await deps.listInstallationScopes();
  } catch {
    return false;
  }
  if (scopes === null) return false;
  const reachable = new Map<string, Set<string>>();
  for (const scope of scopes) reachable.set(scope.installationId, new Set(scope.repositoryIds));
  const unauthorized = new Set<string>();
  for (const action of deps.listActions()) {
    if (!action.enabled) continue;
    const repositories = reachable.get(action.installationId);
    // An installation absent from the listing was not observed at all — it may
    // belong to a connection the listing could not cover — so it is left alone.
    if (repositories === undefined || repositories.has(action.repositoryId)) continue;
    unauthorized.add(action.repositoryKey);
  }
  for (const repositoryKey of unauthorized) {
    deps.disableActionsForRepository(repositoryKey, "repository_unauthorized");
  }
  return true;
}

function recordPullRequests(
  action: GitHubAction,
  repository: GuardrailRepository,
  pullRequests: readonly RemotePullRequest[],
  firstRun: boolean,
  detectedAt: string,
  deps: GitHubReconcilerDependencies,
): GitHubActionEvent[] {
  const created: GitHubActionEvent[] = [];
  for (const pullRequest of pullRequests) {
    if (!matchesAnyBranchPattern(action.branchPatterns, pullRequest.baseRef)) continue;
    // The same two refusals the webhook applies, for the same reasons: a draft is
    // a verdict nobody asked for, and a fork is untrusted code on our token.
    if (pullRequest.draft) continue;
    if (pullRequest.fromFork && !action.includeForks) continue;
    const event = record(action, repository, {
      kind: "pull_request",
      headSha: pullRequest.headSha,
      // The fork's head is reachable in the base repository under this ref, so
      // nothing downstream ever fetches from the fork.
      headRef: pullRequest.fromFork ? `pull/${pullRequest.number}/head` : pullRequest.headRef,
      baseRef: pullRequest.baseRef,
      pullRequestNumber: pullRequest.number,
      title: pullRequest.title,
      observedAt: pullRequest.updatedAt,
    }, firstRun, detectedAt, deps);
    if (event) created.push(event);
  }
  return created;
}

function recordBranches(
  action: GitHubAction,
  repository: GuardrailRepository,
  branches: readonly RemoteBranch[],
  firstRun: boolean,
  detectedAt: string,
  deps: GitHubReconcilerDependencies,
): GitHubActionEvent[] {
  const created: GitHubActionEvent[] = [];
  for (const branch of branches) {
    if (!matchesAnyBranchPattern(action.branchPatterns, branch.name)) continue;
    const event = record(action, repository, {
      kind: "push",
      headSha: branch.headSha,
      headRef: branch.name,
      // A push to the protected branch has nothing to compare against; anything
      // else compares against the default branch, as the poller did.
      baseRef: branch.name === repository.defaultBranch ? null : repository.defaultBranch,
      pullRequestNumber: null,
      title: null,
      observedAt: null,
    }, firstRun, detectedAt, deps);
    if (event) created.push(event);
  }
  return created;
}

interface Observation {
  kind: GitHubAction["triggerKind"];
  headSha: string;
  headRef: string;
  baseRef: string | null;
  pullRequestNumber: number | null;
  title: string | null;
  observedAt: string | null;
}

function record(
  action: GitHubAction,
  repository: GuardrailRepository,
  observation: Observation,
  firstRun: boolean,
  detectedAt: string,
  deps: GitHubReconcilerDependencies,
): GitHubActionEvent | null {
  // Both conditions, as the spec requires: this target is not already on the
  // books at this revision (the UNIQUE answers that), and no event of this action
  // already carries this commit — a commit it has seen is not one it missed.
  if (deps.hasEventForHeadSha(action.id, observation.headSha)) return null;
  const created = deps.createEvent({
    actionId: action.id,
    repositoryKey: repository.repositoryKey,
    actionRevision: action.revision,
    origin: "reconciliation",
    deliveryId: null,
    kind: observation.kind,
    status: firstRun ? "observed" : "queued",
    headSha: observation.headSha,
    baseRef: observation.baseRef,
    headRef: observation.headRef,
    pullRequestNumber: observation.pullRequestNumber,
    targetIdentity: gitHubActionEventTargetIdentity({
      kind: observation.kind,
      headSha: observation.headSha,
      headRef: observation.headRef,
      pullRequestNumber: observation.pullRequestNumber,
    }),
    title: observation.title,
    gateId: null,
    costCeilingUsd: action.costCeilingUsd,
    reason: firstRun ? "initial_baseline" : null,
    error: null,
    detectedAt,
    observedAt: observation.observedAt,
  });
  if (created === null || firstRun) return created;
  // Only now, with the new head recorded, is the older queue obsolete.
  deps.supersede({
    actionId: action.id,
    ...(observation.pullRequestNumber === null
      ? { headRef: observation.headRef }
      : { pullRequestNumber: observation.pullRequestNumber }),
    exceptHeadSha: created.headSha,
    reason: "head_superseded",
    beforeObservedAt: observation.observedAt ?? detectedAt,
    beforeEventId: created.id,
  });
  return created;
}

/**
 * The queue of one action, oldest first: what a webhook created and could not
 * dispatch, what a spent daily ceiling held back, and whatever this cycle just
 * added. A change that has been waiting more than a day is retired instead —
 * nobody is waiting for that verdict, and spending on it is the one thing a
 * safety net must not do.
 */
function queuedForDispatch(
  action: GitHubAction,
  now: string,
  deps: GitHubReconcilerDependencies,
): string[] {
  const dispatchable: string[] = [];
  const queued = [...deps.listQueuedEvents(action.id)]
    .sort((left, right) => left.detectedAt.localeCompare(right.detectedAt));
  for (const event of queued) {
    const age = Date.parse(now) - Date.parse(event.observedAt ?? event.detectedAt);
    if (Number.isFinite(age) && age > MAX_QUEUED_AGE_MS) {
      deps.patchEvent(event.id, {
        status: "skipped", reason: "queued_event_expired", completedAt: now,
      });
      continue;
    }
    dispatchable.push(event.id);
  }
  return dispatchable;
}

async function listOpenPullRequests(
  repository: GuardrailRepository,
  deps: GitHubReconcilerDependencies,
): Promise<RemotePullRequest[]> {
  const entries = await paginate(
    repository, "/pulls?state=open", GITHUB_RECONCILE_MAX_PULL_REQUEST_PAGES, deps,
  );
  return entries.map((entry) => parsePullRequest(entry, repository));
}

async function listBranchHeads(
  repository: GuardrailRepository,
  deps: GitHubReconcilerDependencies,
): Promise<RemoteBranch[]> {
  const entries = await paginate(repository, "/branches", GITHUB_RECONCILE_MAX_BRANCH_PAGES, deps);
  return entries.map(parseBranch);
}

async function paginate(
  repository: GuardrailRepository,
  resourcePath: string,
  maxPages: number,
  deps: GitHubReconcilerDependencies,
): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = resourcePath.includes("?") ? "&" : "?";
    const value = await deps.readRepositoryJson(
      repository,
      `${resourcePath}${separator}per_page=${PAGE_SIZE}&page=${page}`,
      READ_PERMISSIONS,
    );
    if (!Array.isArray(value) || value.length > PAGE_SIZE) throw new Error("github_action_reconcile_failed");
    all.push(...value);
    // A page shorter than the size is the last one; the ceiling is the other exit,
    // and a repository busier than it simply waits for its webhooks.
    if (value.length < PAGE_SIZE) break;
  }
  return all;
}

function parsePullRequest(value: unknown, repository: GuardrailRepository): RemotePullRequest {
  const root = record_(value);
  const base = record_(root.base);
  const head = record_(root.head);
  const number = root.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0
    || !ref(base.ref) || !ref(head.ref) || !sha(head.sha)) {
    throw new Error("github_action_reconcile_failed");
  }
  const headRepositoryId = numericId(head.repo);
  const baseRepositoryId = numericId(base.repo) ?? repository.githubRepositoryId;
  return {
    number,
    title: typeof root.title === "string" ? root.title.slice(0, 500) : null,
    baseRef: base.ref,
    headRef: head.ref,
    headSha: head.sha.toLowerCase(),
    draft: root.draft === true,
    // Unknown provenance counts as a fork: a control whose reason is "untrusted
    // code on our token" cannot read missing data as trust.
    fromFork: headRepositoryId === null || baseRepositoryId === null || headRepositoryId !== baseRepositoryId,
    updatedAt: timestamp(root.updated_at),
  };
}

function parseBranch(value: unknown): RemoteBranch {
  const root = record_(value);
  const commit = record_(root.commit);
  if (!ref(root.name) || !sha(commit.sha)) throw new Error("github_action_reconcile_failed");
  return { name: shortBranchName(root.name), headSha: commit.sha.toLowerCase() };
}

export interface GitHubReconcilerLoopOptions {
  reconcile(): Promise<GitHubReconcileResult>;
  intervalMs?: number | undefined;
  onError?(error: unknown): void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/**
 * The loop that replaces `startPolling(60_000)`. It is clamped to the spec's five
 * minutes to one hour, it never overlaps itself, and it is unref'd so it cannot
 * hold the process open. The returned function stops it.
 */
export function startGitHubReconciler(options: GitHubReconcilerLoopOptions): () => void {
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  const interval = clampReconcileInterval(options.intervalMs);
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void options.reconcile()
      .catch((error: unknown) => { options.onError?.(error); })
      .finally(() => { running = false; });
  };
  const timer = schedule(tick, interval);
  timer.unref?.();
  return () => { cancel(timer); };
}

export function clampReconcileInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return GITHUB_RECONCILE_DEFAULT_INTERVAL_MS;
  return Math.max(GITHUB_RECONCILE_MIN_INTERVAL_MS, Math.min(value, GITHUB_RECONCILE_MAX_INTERVAL_MS));
}

function record_(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("github_action_reconcile_failed");
  }
  return value as Record<string, unknown>;
}

function ref(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255
    && !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
}

function sha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function numericId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>).id;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return String(raw);
  return typeof raw === "string" && /^[0-9]+$/.test(raw) ? raw : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
