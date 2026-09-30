import type {
  GitHubAction,
  GitHubActionEvent,
  GitHubActionEventCreate,
  GitHubActionEventPatch,
  GuardrailRepository,
} from "@csb/shared";

import type { GitHubInstallationPermissions } from "../github-app/github-app-client.js";
import { matchesAnyBranchPattern } from "./branch-patterns.js";
import type { InstallationScopeReport } from "./installation-scope.js";
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
 * How long an event may wait **in our queue** before it is retired. Measured on
 * `detectedAt` — the moment *we* learned of the change — and never on the payload
 * clock: the whole point of the reconciliation is to recover a commit whose
 * delivery was lost, and after an outage that commit's own clock is as old as the
 * outage. Ageing a fresh recovery by the payload's clock created the event and
 * threw it away in the same cycle (C-1).
 *
 * What it does still retire: a row a previous release queued and never
 * dispatched — the poller's leftover queue at cutover carries the poller's own
 * `detected_at` — and a row this process has failed to dispatch for a day.
 */
const MAX_QUEUED_AGE_MS = 24 * 60 * 60_000;

const READ_PERMISSIONS: GitHubInstallationPermissions = { contents: "read", pull_requests: "read" };

/** The one read the reconciliation and `GET /github/branches` share. */
export type ReadRepositoryJson = (
  repository: GuardrailRepository,
  resourcePath: string,
  permissions: GitHubInstallationPermissions,
) => Promise<unknown>;

export interface GitHubReconcileResult {
  /** Repositories with at least one enabled action that were actually read. */
  repositories: number;
  /** Events created as `queued`: commits a webhook should have brought and did not. */
  created: number;
  /** Events created as `observed`: a first run, which establishes a baseline and spends nothing. */
  observed: number;
  errors: number;
}

/**
 * What a caller of the shared guard gets back. `joined: true` means this request
 * did not start a cycle — it attached to the one already running, and the counts
 * below are that cycle's, not this request's.
 */
export type GitHubReconcileOutcome = GitHubReconcileResult & { joined: boolean };

export interface GitHubReconcilerDependencies {
  now(): Date;
  listActions(): GitHubAction[];
  getRepository(repositoryKey: string): GuardrailRepository | null;
  /** Read-only GitHub reads, already scoped to the repository's App authority. */
  readRepositoryJson: ReadRepositoryJson;
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
   * Every installation that answered and the repositories it still reaches, plus
   * how many could not be read. GitHub does **not** redeliver an `installation`
   * or `installation_repositories` webhook, so without this a repository removed
   * from the installation would keep its actions enabled for ever. `null` means
   * nothing at all could be read; wire it to `readGitHubInstallationScopes`.
   */
  listInstallationScopes?(): Promise<InstallationScopeReport | null>;
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
 *
 * One consequence worth naming, because it differs from the poller: the second
 * condition is `(action, head_sha)`, not the target identity, so a commit that is
 * the head of two things the same action follows — a fast-forward that puts one
 * SHA on `main` and on `release/1.2` — yields **one** event, for whichever the
 * listing returned first. The poller would have paid for two gates over identical
 * trees (M-5).
 */
export async function reconcileGitHubActions(
  deps: GitHubReconcilerDependencies,
): Promise<GitHubReconcileResult> {
  const result: GitHubReconcileResult = { repositories: 0, created: 0, observed: 0, errors: 0 };
  deps.reconcileOrphans();
  result.errors += await reconcileInstallationScope(deps);

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
        pullRequests = await listOpenPullRequests(repository, deps.readRepositoryJson);
      }
      if (actions.some((action) => action.triggerKind === "push")) {
        branches = await listBranchHeads(repository, deps.readRepositoryJson);
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
 * installation no longer reaches. An installation that could not be read is
 * simply absent from the report, and absent disables **nothing**: a blinking
 * GitHub API must not stop an operator's automation, and the next cycle asks
 * again. Returns how many reads failed, so `errors` counts real failures and one
 * revoked installation does not make the number meaningless.
 */
async function reconcileInstallationScope(deps: GitHubReconcilerDependencies): Promise<number> {
  if (!deps.listInstallationScopes) return 0;
  let report: InstallationScopeReport | null;
  try {
    report = await deps.listInstallationScopes();
  } catch {
    return 1;
  }
  if (report === null) return 1;
  const reachable = new Map<string, Set<string>>();
  for (const scope of report.scopes) reachable.set(scope.installationId, new Set(scope.repositoryIds));
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
  return report.failures;
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
    const age = Date.parse(now) - Date.parse(event.detectedAt);
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
  read: ReadRepositoryJson,
): Promise<RemotePullRequest[]> {
  const entries = await paginate(
    repository, "/pulls?state=open", GITHUB_RECONCILE_MAX_PULL_REQUEST_PAGES, read,
  );
  return entries.map((entry) => parsePullRequest(entry, repository));
}

async function listBranchHeads(
  repository: GuardrailRepository,
  read: ReadRepositoryJson,
): Promise<RemoteBranch[]> {
  const entries = await paginate(repository, "/branches", GITHUB_RECONCILE_MAX_BRANCH_PAGES, read);
  return entries.map(parseBranch);
}

/**
 * The branch names `GET /github/branches` answers with, read exactly as the
 * reconciliation reads them — same ceiling, same validation, one implementation.
 */
export async function listGitHubBranchNames(
  repository: GuardrailRepository,
  read: ReadRepositoryJson,
): Promise<string[]> {
  return (await listBranchHeads(repository, read)).map((branch) => branch.name);
}

async function paginate(
  repository: GuardrailRepository,
  resourcePath: string,
  maxPages: number,
  read: ReadRepositoryJson,
): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = resourcePath.includes("?") ? "&" : "?";
    const value = await read(
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
  /** How long `stop()` waits for the cycle in flight. */
  stopDeadlineMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export interface GitHubReconcilerHandle {
  /**
   * Runs one cycle now unless one is already in flight, and resolves when it
   * ends. Boot uses it, so the "never overlapping" guarantee covers the boot
   * cycle and not only the ticks.
   */
  runNow(): Promise<void>;
  /**
   * Clears the timer and **awaits** the cycle in flight, bounded. A cycle holds a
   * write transaction and may be awaiting a paid dispatch, so a shutdown that did
   * not wait let `closeDb` land on a gate that had already been started: the
   * launch was written to a closed handle and the event stayed `dispatching`
   * until the next boot called it uncertain.
   */
  stop(): Promise<void>;
}

/**
 * How long `stop()` waits. A cycle can be inside a GitHub read with its own
 * timeout, and a shutdown must not wait that out; nothing is lost by cutting it
 * short, because the next boot reconciles again and `reconcileOrphanedGitHubActionDispatches`
 * settles a reservation this process abandoned.
 */
export const GITHUB_RECONCILE_STOP_DEADLINE_MS = 5_000;

/**
 * One cycle at a time, whatever asks for it. The loop's own guard covers only the
 * loop, and `POST /github/reconcile` is a second caller: without a shared guard an
 * administrator pressing "Reconciliar agora" runs a full second set of GitHub reads
 * per repository beside the tick, and the loser of the race reports `errors > 0`
 * that the operator reads as a fault. A concurrent caller joins the cycle in flight
 * and gets its result, because the answer to "reconcile now" is the same answer
 * either way — and because refusing it would make the button fail for being pressed
 * at the wrong second.
 *
 * A failed cycle releases the guard: holding it would leave reconciliation dead for
 * the life of the process.
 *
 * `joined` says which of the two happened. The counts of a joined cycle describe
 * work that started before the button was pressed, so a screen that reported them
 * as "your reconciliation found nothing" would be lying about a cycle that had
 * already passed the repository the operator was looking at.
 */
export function singleFlightReconcile(
  reconcile: () => Promise<GitHubReconcileResult>,
): () => Promise<GitHubReconcileOutcome> {
  let inFlight: Promise<GitHubReconcileResult> | null = null;
  return () => {
    const joined = inFlight !== null;
    inFlight ??= (async () => {
      try {
        return await reconcile();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight.then((result) => ({ ...result, joined }));
  };
}

/**
 * The loop that replaces `startPolling(60_000)`. It is clamped to the spec's five
 * minutes to one hour, it never overlaps itself — including the boot cycle — and
 * it is unref'd so it cannot hold the process open.
 */
export function startGitHubReconciler(options: GitHubReconcilerLoopOptions): GitHubReconcilerHandle {
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  const deadlineMs = options.stopDeadlineMs ?? GITHUB_RECONCILE_STOP_DEADLINE_MS;
  const interval = clampReconcileInterval(options.intervalMs);
  let stopped = false;
  let running = false;
  let inFlight: Promise<void> | null = null;

  const runNow = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    // The body is inside the `try`, so a **synchronous** throw from `reconcile`
    // releases the guard too. Escaping it left `running` true and the loop dead
    // for the life of the process (M-1).
    const cycle = (async (): Promise<void> => {
      try {
        await options.reconcile();
      } catch (error) {
        options.onError?.(error);
      } finally {
        running = false;
      }
    })();
    inFlight = cycle;
    void cycle.then(() => { if (inFlight === cycle) inFlight = null; });
    return cycle;
  };

  const timer = schedule(() => { void runNow(); }, interval);
  timer.unref?.();

  return {
    runNow,
    async stop() {
      stopped = true;
      cancel(timer);
      if (inFlight === null) return;
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([
        inFlight.catch(() => undefined),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, deadlineMs);
          deadline.unref?.();
        }),
      ]);
      if (deadline !== undefined) clearTimeout(deadline);
    },
  };
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
