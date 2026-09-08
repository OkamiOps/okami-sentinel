import { randomUUID } from "node:crypto";

import type {
  GateTarget,
  GitHubMonitorActionsRun,
  GitHubMonitorEvent,
  GitHubMonitorOverview,
  GitHubMonitorRule,
  GitHubMonitorScannerSelection,
  GuardrailRepository,
  GuardrailScanSelection,
} from "@csb/shared";

import type { GitHubInstallationPermissions } from "../github-app/github-app-client.js";
import {
  createGitHubMonitorEvent,
  createGitHubMonitorRule,
  acquireGitHubMonitorPollLease,
  getGitHubMonitorRule,
  getGitHubMonitorRuleByRepository,
  listGitHubMonitorActionsRuns,
  listGitHubMonitorEvents,
  listGitHubMonitorRules,
  patchGitHubMonitorEvent,
  patchGitHubMonitorRule,
  releaseGitHubMonitorPollLease,
  renewGitHubMonitorPollLease,
  reconcileOrphanedGitHubMonitorDispatches,
  recordGitHubMonitorPoll,
  reserveGitHubMonitorEventDispatch,
  upsertGitHubMonitorActionsRun,
  type GitHubMonitorRuleCreate,
  type GitHubMonitorRulePatch,
} from "./store.js";

const MAX_PAGES = 20;
const PAGE_SIZE = 100;
const MAX_RULES_PER_POLL = 100;
const ACTIONS_WINDOW_DAYS = 7;
const MAX_ACTIONS_PAGES = 2;
const PRE_DISPATCH_CODES = new Set([
  "head_superseded",
  "monitor_policy_budget_exceeds_rule",
  "monitor_authority_invalid",
  "monitor_budget_required",
  "monitor_rule_changed",
  "monitor_actions_duplicate_triggers",
  "monitor_scanner_required",
  "monitor_actions_policy_required",
  "target_preview_invalid",
  "target_preview_stale",
  "target_preview_executor_unavailable",
  "server_draining",
]);

export type GitHubMonitorErrorCode =
  | "github_monitor_invalid"
  | "github_monitor_repository_not_found"
  | "github_monitor_repository_unsupported"
  | "github_monitor_rule_conflict"
  | "github_monitor_rule_not_found"
  | "github_monitor_poll_failed"
  | "github_monitor_checkout_unavailable";

export class GitHubMonitorError extends Error {
  constructor(readonly code: GitHubMonitorErrorCode) {
    super(code);
    this.name = "GitHubMonitorError";
  }
}

export interface GitHubMonitorStartInput {
  repository: GuardrailRepository;
  rule: GitHubMonitorRule;
  event: GitHubMonitorEvent;
  /** The root integration must preflight this exact target and reject SHA drift. */
  target: GateTarget;
  /** null means the approved GitHub Actions policy route. */
  scanSelection: GuardrailScanSelection | null;
}

export interface GitHubMonitorStartResult {
  gateId: string;
  /** Must be the frozen event SHA, never a newer ref resolution. */
  headSha: string;
}

export interface GitHubMonitorCheckoutInput {
  repository: GuardrailRepository;
  event: GitHubMonitorEvent;
  mode: Exclude<GitHubMonitorRule["checkoutMode"], "none">;
}

export interface GitHubMonitorDependencies {
  listRepositories(): GuardrailRepository[];
  readRepositoryJson(
    repository: GuardrailRepository,
    path: string,
    permissions: GitHubInstallationPermissions,
  ): Promise<unknown>;
  /** Existing TargetPreview + Gate orchestration, supplied by app.ts. */
  startAutomatic(input: GitHubMonitorStartInput): Promise<GitHubMonitorStartResult>;
  /** Optional by design: server/Docker has no writable host checkout. */
  syncCheckout?(input: GitHubMonitorCheckoutInput): Promise<void>;
  checkoutAvailable?(): boolean;
  now?(): Date;
  createActionsRunId?(): string;
}

export interface GitHubMonitorRuleInput {
  repositoryKey: string;
  executor: GitHubMonitorRule["executor"];
  scanner: GitHubMonitorScannerSelection | null;
  costCeilingUsd: number | null;
  dailyCostCeilingUsd?: number | null;
  followBranches: string[];
  checkoutMode: GitHubMonitorRule["checkoutMode"];
  enabled?: boolean;
}

export type GitHubMonitorRulePatchInput = Partial<Omit<GitHubMonitorRuleInput, "repositoryKey">>;

/**
 * Polls GitHub App authorized repositories without webhooks. The first healthy
 * poll after every material rule change only establishes a baseline, so adding
 * a rule can never spend on an historical PR backlog.
 */
export class GitHubMonitorService {
  readonly #deps: GitHubMonitorDependencies;
  readonly #now: () => Date;
  readonly #createActionsRunId: () => string;
  readonly #leaseOwnerId = randomUUID();
  readonly #inFlight = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(dependencies: GitHubMonitorDependencies) {
    this.#deps = dependencies;
    this.#now = dependencies.now ?? (() => new Date());
    this.#createActionsRunId = dependencies.createActionsRunId ?? randomUUID;
  }

  listRules(repositoryKey: string | null = null): GitHubMonitorRule[] {
    return listGitHubMonitorRules(repositoryKey);
  }

  listEvents(filter: { ruleId?: string; repositoryKey?: string } = {}): GitHubMonitorEvent[] {
    return listGitHubMonitorEvents(filter);
  }

  /** Call once on startup before the polling loop; never repeats an uncertain paid launch. */
  reconcileStartup(): number {
    return reconcileOrphanedGitHubMonitorDispatches(this.#now().toISOString());
  }

  overview(repositoryKey: string | null = null): GitHubMonitorOverview {
    const rules = listGitHubMonitorRules(repositoryKey);
    const events = listGitHubMonitorEvents({ repositoryKey: repositoryKey ?? undefined });
    const actionsRuns = listGitHubMonitorActionsRuns({ repositoryKey: repositoryKey ?? undefined });
    const errors = rules.map((rule) => rule.lastError).filter((value): value is string => value !== null);
    const lastPolledAt = rules.map((rule) => rule.lastPolledAt).filter((value): value is string => value !== null)
      .sort().at(-1) ?? null;
    return {
      rules,
      events,
      actionsRuns,
      summary: {
        enabledRules: rules.filter((rule) => rule.enabled).length,
        queuedEvents: events.filter((event) => event.status === "queued").length,
        dispatchingEvents: events.filter((event) => event.status === "dispatching").length,
        lastPolledAt,
        lastError: errors.at(0) ?? null,
        checkoutAvailable: this.#deps.checkoutAvailable?.() === true,
        recentActionsWindowDays: ACTIONS_WINDOW_DAYS,
      },
    };
  }

  createRule(input: GitHubMonitorRuleInput): GitHubMonitorRule {
    const repository = this.#repository(input.repositoryKey);
    const normalized = normalizeRuleInput(input);
    const identity = remoteIdentity(repository);
    if (getGitHubMonitorRuleByRepository(repository.repositoryKey) !== null) {
      throw new GitHubMonitorError("github_monitor_rule_conflict");
    }
    return createGitHubMonitorRule({
      repositoryKey: repository.repositoryKey,
      ...identity,
      ...normalized,
    });
  }

  patchRule(id: string, input: GitHubMonitorRulePatchInput): GitHubMonitorRule {
    const current = getGitHubMonitorRule(id);
    if (current === null) throw new GitHubMonitorError("github_monitor_rule_not_found");
    const repository = this.#repository(current.repositoryKey);
    const identity = remoteIdentity(repository);
    if (identity.connectionId !== current.connectionId
      || identity.installationId !== current.installationId
      || identity.repositoryId !== current.repositoryId) {
      throw new GitHubMonitorError("github_monitor_repository_unsupported");
    }
    const candidate: GitHubMonitorRuleInput = {
      repositoryKey: current.repositoryKey,
      executor: input.executor ?? current.executor,
      scanner: input.scanner === undefined ? current.scanner : input.scanner,
      costCeilingUsd: input.costCeilingUsd === undefined ? current.costCeilingUsd : input.costCeilingUsd,
      dailyCostCeilingUsd: input.dailyCostCeilingUsd === undefined ? current.dailyCostCeilingUsd : input.dailyCostCeilingUsd,
      followBranches: input.followBranches ?? current.followBranches,
      checkoutMode: input.checkoutMode ?? current.checkoutMode,
      enabled: input.enabled ?? current.enabled,
    };
    const normalized = normalizeRuleInput(candidate);
    const patch: GitHubMonitorRulePatch = {
      ...normalized,
      enabled: candidate.enabled ?? false,
    };
    return patchGitHubMonitorRule(id, patch) ?? current;
  }

  /** Starts a bounded background loop. The host owns shutdown through stopPolling(). */
  startPolling(intervalMs = 60_000): () => void {
    const safeInterval = Math.max(15_000, Math.min(intervalMs, 15 * 60_000));
    this.stopPolling();
    this.reconcileStartup();
    void this.poll().catch(() => undefined);
    this.#timer = setInterval(() => { void this.poll().catch(() => undefined); }, safeInterval);
    this.#timer.unref?.();
    return () => this.stopPolling();
  }

  stopPolling(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async poll(repositoryKey: string | null = null): Promise<GitHubMonitorOverview> {
    this.reconcileStartup();
    // Disabled rules remain read-only monitors, so users can see PRs and runs
    // before authorizing any paid automatic scanner.
    const rules = listGitHubMonitorRules(repositoryKey).slice(0, MAX_RULES_PER_POLL);
    for (const rule of rules) await this.#pollRule(rule);
    return this.overview(repositoryKey);
  }

  async #pollRule(rule: GitHubMonitorRule): Promise<void> {
    if (this.#inFlight.has(rule.id)) return;
    const leaseNow = this.#now();
    const leaseExpiresAt = new Date(leaseNow.getTime() + 120_000).toISOString();
    if (!acquireGitHubMonitorPollLease(rule.id, this.#leaseOwnerId, leaseExpiresAt, leaseNow.toISOString())) return;
    this.#inFlight.add(rule.id);
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      const now = this.#now();
      try {
        if (!renewGitHubMonitorPollLease(rule.id, this.#leaseOwnerId, new Date(now.getTime() + 120_000).toISOString(), now.toISOString())) leaseLost = true;
      } catch { leaseLost = true; }
    }, 30_000);
    heartbeat.unref?.();
    try {
      const current = getGitHubMonitorRule(rule.id);
      if (current === null) return;
      const repository = this.#repository(rule.repositoryKey);
      const identity = remoteIdentity(repository);
      if (identity.connectionId !== current.connectionId
        || identity.installationId !== current.installationId
        || identity.repositoryId !== current.repositoryId) {
        throw new GitHubMonitorError("github_monitor_repository_unsupported");
      }
      const [pullRequests, branches] = await Promise.all([
        this.#listPullRequests(repository),
        this.#listBranches(repository),
      ]);
      let actionsRuns: Array<Omit<GitHubMonitorActionsRun, "id" | "ruleId" | "repositoryKey">> = [];
      let actionsUnavailable = false;
      try {
        actionsRuns = await this.#listActionsRuns(repository);
      } catch {
        // Actions permission and endpoint availability must not prevent PR/push
        // monitoring or consume its pending queue.
        actionsUnavailable = true;
      }
      const firstHealthyPoll = current.baselineInitializedAt === null;
      const detectedAt = this.#now().toISOString();
      // PRs come first; if a branch and PR point to one SHA, the richer PR target wins.
      for (const pullRequest of pullRequests) {
        this.#recordObservation(current, {
          kind: "pull_request",
          headSha: pullRequest.headSha,
          baseRef: pullRequest.baseRef,
          headRef: pullRequest.headRef,
          pullRequestNumber: pullRequest.number,
          title: pullRequest.title,
        }, firstHealthyPoll, detectedAt);
      }
      for (const branch of branches) {
        if (!matchesFollowedBranch(branch.name, current.followBranches)) continue;
        this.#recordObservation(current, {
          kind: "push",
          headSha: branch.headSha,
          baseRef: branch.name === repository.defaultBranch ? null : repository.defaultBranch,
          headRef: branch.name,
          pullRequestNumber: null,
          title: null,
        }, firstHealthyPoll, detectedAt);
      }
      for (const actionsRun of actionsRuns) {
        upsertGitHubMonitorActionsRun({
          id: this.#createActionsRunId(),
          ruleId: current.id,
          repositoryKey: current.repositoryKey,
          ...actionsRun,
        });
      }
      recordGitHubMonitorPoll(current.id, { error: actionsUnavailable ? "github_monitor_actions_unavailable" : null, initializeBaseline: firstHealthyPoll }, undefined, detectedAt);
      if (!leaseLost && !firstHealthyPoll && current.enabled) await this.#dispatchQueued(current, repository);
    } catch (error) {
      // Never serialize arbitrary upstream error messages or discard queued work.
      recordGitHubMonitorPoll(rule.id, { error: safePollCode(error) }, undefined, this.#now().toISOString());
    } finally {
      clearInterval(heartbeat);
      this.#inFlight.delete(rule.id);
      releaseGitHubMonitorPollLease(rule.id, this.#leaseOwnerId);
    }
  }

  #recordObservation(
    rule: GitHubMonitorRule,
    event: Omit<GitHubMonitorEvent, "id" | "ruleId" | "repositoryKey" | "ruleRevision" | "status" | "gateId" | "costCeilingUsd" | "reason" | "error" | "detectedAt" | "dispatchedAt" | "completedAt">,
    firstHealthyPoll: boolean,
    detectedAt: string,
  ): void {
    createGitHubMonitorEvent({
      ruleId: rule.id,
      repositoryKey: rule.repositoryKey,
      ruleRevision: rule.revision,
      ...event,
      status: firstHealthyPoll || !rule.enabled ? "observed" : "queued",
      costCeilingUsd: rule.costCeilingUsd,
      reason: firstHealthyPoll ? "initial_baseline" : !rule.enabled ? "automatic_scan_disabled" : null,
      detectedAt,
    });
  }

  async #dispatchQueued(rule: GitHubMonitorRule, repository: GuardrailRepository): Promise<void> {
    const queued = listGitHubMonitorEvents({ ruleId: rule.id, statuses: ["queued"], limit: 100 });
    for (const event of queued) {
      const currentRule = getGitHubMonitorRule(rule.id);
      if (currentRule === null || !currentRule.enabled || currentRule.revision !== event.ruleRevision) {
        patchGitHubMonitorEvent(event.id, {
          status: "skipped",
          reason: "rule_reconfigured",
          completedAt: this.#now().toISOString(),
        });
        continue;
      }
      const now = this.#now();
      const dailyCeiling = currentRule.dailyCostCeilingUsd ?? currentRule.costCeilingUsd!;
      const { start, end } = utcDay(now);
      const dispatching = reserveGitHubMonitorEventDispatch({
        eventId: event.id,
        ruleId: currentRule.id,
        ruleRevision: currentRule.revision,
        dayStart: start,
        dayEnd: end,
        costCeilingUsd: currentRule.costCeilingUsd!,
        dailyCostCeilingUsd: dailyCeiling,
        at: now.toISOString(),
      });
      if (dispatching === null) {
        // Keep it queued; a later UTC day can retry without duplicating the event.
        patchGitHubMonitorEvent(event.id, { reason: "daily_cost_ceiling" });
        continue;
      }
      try {
        if (currentRule.checkoutMode !== "none") {
          if (!this.#deps.syncCheckout) throw new GitHubMonitorError("github_monitor_checkout_unavailable");
          await this.#deps.syncCheckout({ repository, event: dispatching, mode: currentRule.checkoutMode });
        }
        const result = await this.#deps.startAutomatic({
          repository,
          rule: currentRule,
          event: dispatching,
          target: targetForEvent(repository, dispatching),
          scanSelection: selectionForRule(rule),
        });
        if (result.headSha !== dispatching.headSha) {
          patchGitHubMonitorEvent(dispatching.id, {
            status: "failed",
            error: "automatic_dispatch_uncertain",
            completedAt: this.#now().toISOString(),
          });
          continue;
        }
        patchGitHubMonitorEvent(dispatching.id, {
          status: "launched",
          gateId: result.gateId,
          completedAt: this.#now().toISOString(),
        });
      } catch (error) {
        const code = safeDispatchCode(error);
        if (code === "github_monitor_checkout_unavailable") {
          patchGitHubMonitorEvent(dispatching.id, { status: "queued", error: code, dispatchedAt: null });
          continue;
        }
        if (PRE_DISPATCH_CODES.has(code)) {
          patchGitHubMonitorEvent(dispatching.id, {
            status: "skipped",
            reason: code,
            completedAt: this.#now().toISOString(),
          });
          continue;
        }
        // The scan may or may not have reached its provider. Preserve uncertainty
        // and reservation instead of silently retrying a potentially paid call.
        patchGitHubMonitorEvent(dispatching.id, {
          status: "failed",
          error: code,
          completedAt: this.#now().toISOString(),
        });
      }
    }
  }

  async #listPullRequests(repository: GuardrailRepository): Promise<PullRequestObservation[]> {
    const entries = await this.#paginate(repository, "/pulls?state=open&sort=updated&direction=desc");
    return entries.map(parsePullRequest);
  }

  async #listBranches(repository: GuardrailRepository): Promise<BranchObservation[]> {
    const entries = await this.#paginate(repository, "/branches");
    return entries.map(parseBranch);
  }

  async #listActionsRuns(repository: GuardrailRepository): Promise<Omit<GitHubMonitorActionsRun, "id" | "ruleId" | "repositoryKey">[]> {
    const since = new Date(this.#now().getTime() - ACTIONS_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const entries = await this.#paginateObject(
      repository,
      `/actions/runs?created=${encodeURIComponent(`>=${since}`)}`,
      "workflow_runs",
      MAX_ACTIONS_PAGES,
    );
    return entries.map(parseActionsRun);
  }

  async #paginate(repository: GuardrailRepository, path: string): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const value = await this.#deps.readRepositoryJson(
        repository,
        `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`,
        { contents: "read", pull_requests: "read", actions: "read" },
      );
      if (!Array.isArray(value) || value.length > PAGE_SIZE) throw new GitHubMonitorError("github_monitor_poll_failed");
      all.push(...value);
      if (value.length < PAGE_SIZE) return all;
    }
    throw new GitHubMonitorError("github_monitor_poll_failed");
  }

  async #paginateObject(repository: GuardrailRepository, path: string, key: string, maxPages = MAX_PAGES): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const root = record(await this.#deps.readRepositoryJson(
        repository,
        `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`,
        { actions: "read" },
      ));
      const pageItems = root[key];
      if (!Array.isArray(pageItems) || pageItems.length > PAGE_SIZE) throw new GitHubMonitorError("github_monitor_poll_failed");
      all.push(...pageItems);
      if (pageItems.length < PAGE_SIZE || page === maxPages) return all;
    }
    throw new GitHubMonitorError("github_monitor_poll_failed");
  }

  #repository(repositoryKey: string): GuardrailRepository {
    const repository = this.#deps.listRepositories().find((candidate) => candidate.repositoryKey === repositoryKey);
    if (!repository) throw new GitHubMonitorError("github_monitor_repository_not_found");
    if (repository.source !== "github" || repository.repositoryPath !== null) {
      throw new GitHubMonitorError("github_monitor_repository_unsupported");
    }
    return repository;
  }
}

function normalizeRuleInput(input: GitHubMonitorRuleInput): Omit<GitHubMonitorRuleCreate, "repositoryKey" | "connectionId" | "installationId" | "repositoryId"> {
  const enabled = input.enabled ?? false;
  const followBranches = normalizedBranches(input.followBranches);
  const costCeilingUsd = positiveUsd(input.costCeilingUsd);
  const dailyCostCeilingUsd = input.dailyCostCeilingUsd === undefined || input.dailyCostCeilingUsd === null
    ? costCeilingUsd
    : positiveUsd(input.dailyCostCeilingUsd);
  if (dailyCostCeilingUsd !== null && costCeilingUsd !== null && dailyCostCeilingUsd < costCeilingUsd) {
    throw new GitHubMonitorError("github_monitor_invalid");
  }
  if (input.executor !== "sentinel-managed" && input.executor !== "github-actions") {
    throw new GitHubMonitorError("github_monitor_invalid");
  }
  if (input.executor === "sentinel-managed" && input.scanner?.engine !== "codex-security") {
    if (enabled) throw new GitHubMonitorError("github_monitor_invalid");
  }
  if (input.executor === "github-actions" && input.scanner !== null) {
    throw new GitHubMonitorError("github_monitor_invalid");
  }
  if (enabled && (costCeilingUsd === null || followBranches.length === 0
    || (input.executor === "sentinel-managed" && input.scanner === null))) {
    throw new GitHubMonitorError("github_monitor_invalid");
  }
  return {
    executor: input.executor,
    scanner: input.scanner === null ? null : normalizeScanner(input.scanner),
    costCeilingUsd,
    dailyCostCeilingUsd,
    followBranches,
    checkoutMode: input.checkoutMode,
    enabled,
  };
}

function normalizeScanner(value: GitHubMonitorScannerSelection): GitHubMonitorScannerSelection {
  if (value.engine !== "codex-security"
    || !value.connection
    || !identifier(value.connection.connectionId)
    || (value.connection.modelSelectionMode !== "catalog" && value.connection.modelSelectionMode !== "runtime-default")
    || (value.connection.modelSelectionMode === "catalog" && !bounded(value.connection.modelId, 320))
    || (value.connection.modelSelectionMode === "runtime-default" && value.connection.modelId !== null)
    || (value.mode !== "standard" && value.mode !== "deep")
    || (value.effort !== undefined && !bounded(value.effort, 64))) {
    throw new GitHubMonitorError("github_monitor_invalid");
  }
  return structuredClone(value);
}

function normalizedBranches(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) throw new GitHubMonitorError("github_monitor_invalid");
  const branches = [...new Set(value.map((branch) => typeof branch === "string" ? branch.trim() : ""))];
  if (branches.some((branch) => !/^[A-Za-z0-9*][A-Za-z0-9._/*-]{0,254}$/.test(branch) || branch.includes(".."))) {
    throw new GitHubMonitorError("github_monitor_invalid");
  }
  return branches;
}

function positiveUsd(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value <= 0 || value > 100_000) throw new GitHubMonitorError("github_monitor_invalid");
  return Math.round(value * 100) / 100;
}

function remoteIdentity(repository: GuardrailRepository): Pick<GitHubMonitorRule, "connectionId" | "installationId" | "repositoryId"> {
  if (repository.githubConnectionId === null || repository.githubInstallationId === null || repository.githubRepositoryId === null) {
    throw new GitHubMonitorError("github_monitor_repository_unsupported");
  }
  return {
    connectionId: repository.githubConnectionId,
    installationId: repository.githubInstallationId,
    repositoryId: repository.githubRepositoryId,
  };
}

function selectionForRule(rule: GitHubMonitorRule): GuardrailScanSelection | null {
  if (rule.executor === "github-actions") return null;
  const scanner = rule.scanner;
  if (scanner === null || rule.costCeilingUsd === null) throw new GitHubMonitorError("github_monitor_invalid");
  return {
    ...scanner,
    connection: structuredClone(scanner.connection),
    costLimit: { kind: "manual", maxCostUsd: rule.costCeilingUsd },
  };
}

function targetForEvent(repository: GuardrailRepository, event: GitHubMonitorEvent): GateTarget {
  if (event.kind === "pull_request" && event.pullRequestNumber !== null) {
    return { kind: "pull_request", number: event.pullRequestNumber };
  }
  if (event.headRef === repository.defaultBranch) {
    return { kind: "protected_branch", ref: event.headRef };
  }
  if (event.baseRef === null) throw new GitHubMonitorError("github_monitor_invalid");
  return { kind: "compare", baseRef: event.baseRef, headRef: event.headRef };
}

function matchesFollowedBranch(branch: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`).test(branch));
}

function utcDay(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

interface PullRequestObservation {
  number: number;
  title: string;
  baseRef: string;
  headRef: string;
  headSha: string;
}

interface BranchObservation { name: string; headSha: string; }

function parsePullRequest(value: unknown): PullRequestObservation {
  const root = record(value);
  const base = record(root.base);
  const head = record(root.head);
  if (!Number.isSafeInteger(root.number) || (root.number as number) <= 0
    || !bounded(root.title, 512) || !ref(base.ref) || !ref(head.ref) || !sha(head.sha)) {
    throw new GitHubMonitorError("github_monitor_poll_failed");
  }
  return { number: root.number as number, title: root.title as string, baseRef: base.ref as string, headRef: head.ref as string, headSha: head.sha as string };
}

function parseBranch(value: unknown): BranchObservation {
  const root = record(value);
  const commit = record(root.commit);
  if (!ref(root.name) || !sha(commit.sha)) throw new GitHubMonitorError("github_monitor_poll_failed");
  return { name: root.name as string, headSha: commit.sha as string };
}

function parseActionsRun(value: unknown): Omit<GitHubMonitorActionsRun, "id" | "ruleId" | "repositoryKey"> {
  const root = record(value);
  const createdAt = timestamp(root.created_at);
  const updatedAt = timestamp(root.updated_at);
  const runId = positiveIdentifier(root.id);
  if (!bounded(root.name, 512) || !bounded(root.event, 128) || !sha(root.head_sha)
    || !bounded(root.status, 64) || !url(root.html_url)) {
    throw new GitHubMonitorError("github_monitor_poll_failed");
  }
  const branch = root.head_branch === null ? null : ref(root.head_branch) ? root.head_branch as string : invalid();
  const conclusion = root.conclusion === null ? null : bounded(root.conclusion, 64) ? root.conclusion as string : invalid();
  return {
    workflowRunId: runId,
    name: root.name as string,
    event: root.event as string,
    headBranch: branch,
    headSha: root.head_sha as string,
    status: root.status as string,
    conclusion,
    url: root.html_url as string,
    createdAt,
    updatedAt,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function bounded(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= length && !value.includes("\0");
}

function identifier(value: unknown): value is string {
  return bounded(value, 255) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function positiveIdentifier(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (!bounded(value, 20) || !/^[1-9][0-9]*$/.test(value)) invalid();
  return value;
}

function ref(value: unknown): value is string {
  return bounded(value, 255) && !value.includes("\n") && !value.includes("\r") && value.toUpperCase() !== "HEAD";
}

function sha(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{40}$/.test(value); }
function timestamp(value: unknown): string { if (!bounded(value, 64) || !Number.isFinite(Date.parse(value))) invalid(); return value; }
function url(value: unknown): value is string { try { return typeof value === "string" && new URL(value).protocol === "https:"; } catch { return false; } }
function escapeRegExp(value: string): string { return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"); }
function safeDispatchCode(error: unknown): string {
  if (error instanceof GitHubMonitorError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && PRE_DISPATCH_CODES.has(error.code)) {
    return error.code;
  }
  return "automatic_dispatch_failed";
}
function safePollCode(error: unknown): string {
  if (error instanceof GitHubMonitorError && error.code === "github_monitor_repository_unsupported") {
    return "github_monitor_authority_invalid";
  }
  return "github_monitor_poll_failed";
}
function invalid(): never { throw new GitHubMonitorError("github_monitor_invalid"); }
