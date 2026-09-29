import { Hono, type Context } from "hono";

import type { GitHubMonitorOverview, GitHubMonitorRule } from "@csb/shared";

import {
  canSeeRepository,
  hasRepositoryRole,
  inScope,
  principalOf,
  scopeOf,
  type AccessScope,
} from "../auth/principal.js";
import {
  GitHubMonitorError,
  GitHubMonitorService,
  type GitHubMonitorDependencies,
  type GitHubMonitorRuleInput,
  type GitHubMonitorRulePatchInput,
} from "./service.js";

export interface GitHubMonitorApiDependencies extends GitHubMonitorDependencies {
  service?: GitHubMonitorService;
}

/** Factory only: root mounts it behind the existing CSRF/origin/server middleware. */
export function createGitHubMonitorApi(dependencies: GitHubMonitorApiDependencies): Hono {
  const api = new Hono();
  const service = dependencies.service ?? new GitHubMonitorService(dependencies);

  api.get("/github-monitor/branches", async (c) => {
    try {
      const repositoryKey = string(c.req.query("repositoryKey"), 512);
      // The repository travels in the query string, out of the route policy's
      // reach, so the single repository this route touches is validated here.
      if (!canSeeRepository(principalOf(c), repositoryKey)) return c.json({ error: "not_found" }, 404);
      return c.json({ branches: await service.availableBranches(repositoryKey) });
    } catch (error) { return monitorError(c, error); }
  });

  api.get("/github-monitor/overview", (c) => {
    const repositoryKey = optionalQuery(c.req.query("repositoryKey"));
    return c.json({ overview: scopedOverview(service.overview(repositoryKey), scopeOf(principalOf(c))) });
  });

  api.get("/github-monitor/rules", (c) => {
    const scope = scopeOf(principalOf(c));
    const repositoryKey = optionalQuery(c.req.query("repositoryKey"));
    return c.json({ rules: service.listRules(repositoryKey).filter((rule) => inScope(scope, rule.repositoryKey)) });
  });

  api.post("/github-monitor/rules", async (c) => {
    try {
      return c.json({ rule: service.createRule(parseRuleInput(await c.req.json<unknown>())) }, 201);
    } catch (error) {
      return monitorError(c, error);
    }
  });

  api.patch("/github-monitor/rules/:id", async (c) => {
    try {
      return c.json({ rule: service.patchRule(ruleId(c.req.param("id")), parseRulePatch(await c.req.json<unknown>())) });
    } catch (error) {
      return monitorError(c, error);
    }
  });

  api.get("/github-monitor/events", (c) => {
    const scope = scopeOf(principalOf(c));
    const ruleIdValue = optionalQuery(c.req.query("ruleId"));
    const repositoryKey = optionalQuery(c.req.query("repositoryKey"));
    const events = service.listEvents({ ...(ruleIdValue ? { ruleId: ruleIdValue } : {}), ...(repositoryKey ? { repositoryKey } : {}) });
    return c.json({ events: events.filter((event) => inScope(scope, event.repositoryKey)) });
  });

  api.get("/github-monitor/actions-runs", (c) => {
    const scope = scopeOf(principalOf(c));
    const ruleIdValue = optionalQuery(c.req.query("ruleId"));
    const repositoryKey = optionalQuery(c.req.query("repositoryKey"));
    const overview = service.overview(repositoryKey);
    return c.json({
      actionsRuns: overview.actionsRuns
        .filter((run) => ruleIdValue === null || run.ruleId === ruleIdValue)
        .filter((run) => inScope(scope, run.repositoryKey)),
    });
  });

  api.post("/github-monitor/poll", async (c) => {
    try {
      const body = await optionalBody(c.req.text());
      exactKeys(body, new Set(["repositoryKey"]));
      const repositoryKey = body.repositoryKey === undefined ? null : string(body.repositoryKey, 512);
      // Polling spends the GitHub App's rate budget and can launch paid scans,
      // so a member must name one repository it operates. The key lives in the
      // body, which the route policy cannot resolve.
      const principal = principalOf(c);
      if (!canSeeRepository(principal, repositoryKey)) return c.json({ error: "not_found" }, 404);
      if (!hasRepositoryRole(principal, repositoryKey, "operator")) return c.json({ error: "forbidden" }, 403);
      return c.json({ overview: scopedOverview(await service.poll(repositoryKey), scopeOf(principal)) });
    } catch (error) {
      return monitorError(c, error);
    }
  });

  return api;
}

/**
 * The counters are part of the answer, so they are recomputed from the lists the
 * caller may actually see: a member must not infer another repository's activity
 * from a summary that still counts it.
 */
function scopedOverview(overview: GitHubMonitorOverview, scope: AccessScope): GitHubMonitorOverview {
  if (scope.kind === "all") return overview;
  const rules = overview.rules.filter((rule) => inScope(scope, rule.repositoryKey));
  const events = overview.events.filter((event) => inScope(scope, event.repositoryKey));
  return {
    rules,
    events,
    actionsRuns: overview.actionsRuns.filter((run) => inScope(scope, run.repositoryKey)),
    summary: {
      ...overview.summary,
      enabledRules: rules.filter((rule) => rule.enabled).length,
      queuedEvents: events.filter((event) => event.status === "queued").length,
      dispatchingEvents: events.filter((event) => event.status === "dispatching").length,
      lastPolledAt: rules.map((rule) => rule.lastPolledAt).filter((value): value is string => value !== null).sort().at(-1) ?? null,
      lastError: rules.map((rule) => rule.lastError).filter((value): value is string => value !== null).at(0) ?? null,
    },
  };
}

export function parseRuleInput(value: unknown): GitHubMonitorRuleInput {
  const input = object(value);
  exactKeys(input, new Set([
    "repositoryKey", "executor", "scanner", "costCeilingUsd", "dailyCostCeilingUsd",
    "followBranches", "checkoutMode", "enabled",
  ]));
  return {
    repositoryKey: string(input.repositoryKey, 512),
    executor: executor(input.executor),
    scanner: scanner(input.scanner),
    costCeilingUsd: nullableUsd(input.costCeilingUsd),
    ...(input.dailyCostCeilingUsd === undefined ? {} : { dailyCostCeilingUsd: nullableUsd(input.dailyCostCeilingUsd) }),
    followBranches: branches(input.followBranches),
    checkoutMode: checkoutMode(input.checkoutMode),
    ...(input.enabled === undefined ? {} : { enabled: boolean(input.enabled) }),
  };
}

export function parseRulePatch(value: unknown): GitHubMonitorRulePatchInput {
  const input = object(value);
  exactKeys(input, new Set([
    "executor", "scanner", "costCeilingUsd", "dailyCostCeilingUsd", "followBranches", "checkoutMode", "enabled",
  ]));
  if (Object.keys(input).length === 0) invalid();
  return {
    ...(input.executor === undefined ? {} : { executor: executor(input.executor) }),
    ...(input.scanner === undefined ? {} : { scanner: scanner(input.scanner) }),
    ...(input.costCeilingUsd === undefined ? {} : { costCeilingUsd: nullableUsd(input.costCeilingUsd) }),
    ...(input.dailyCostCeilingUsd === undefined ? {} : { dailyCostCeilingUsd: nullableUsd(input.dailyCostCeilingUsd) }),
    ...(input.followBranches === undefined ? {} : { followBranches: branches(input.followBranches) }),
    ...(input.checkoutMode === undefined ? {} : { checkoutMode: checkoutMode(input.checkoutMode) }),
    ...(input.enabled === undefined ? {} : { enabled: boolean(input.enabled) }),
  };
}

function scanner(value: unknown): GitHubMonitorRule["scanner"] {
  if (value === null) return null;
  const input = object(value);
  exactKeys(input, new Set(["engine", "connection", "effort", "mode"]));
  if (input.engine !== "codex-security" || (input.mode !== "standard" && input.mode !== "deep")) invalid();
  const connection = object(input.connection);
  exactKeys(connection, new Set(["connectionId", "modelSelectionMode", "modelId"]));
  const modelSelectionMode = connection.modelSelectionMode;
  if (modelSelectionMode !== "catalog" && modelSelectionMode !== "runtime-default") invalid();
  const modelId = connection.modelId;
  if ((modelSelectionMode === "catalog" && typeof modelId !== "string")
    || (modelSelectionMode === "runtime-default" && modelId !== null)) invalid();
  return {
    engine: "codex-security",
    connection: {
      connectionId: string(connection.connectionId, 100),
      modelSelectionMode,
      modelId: modelId === null ? null : string(modelId, 320),
    },
    ...(input.effort === undefined ? {} : { effort: string(input.effort, 64) }),
    mode: input.mode,
  };
}

function branches(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) invalid();
  return value.map((branch) => string(branch, 255));
}

function nullableUsd(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100_000) invalid();
  return value;
}

function executor(value: unknown): GitHubMonitorRule["executor"] {
  if (value === "sentinel-managed" || value === "github-actions") return value;
  invalid();
}

function checkoutMode(value: unknown): GitHubMonitorRule["checkoutMode"] {
  if (value === "none" || value === "fetch" || value === "pull") return value;
  invalid();
}

function monitorError(c: Context, error: unknown) {
  const code = error instanceof GitHubMonitorError ? error.code : "github_monitor_operation_failed";
  const status = code === "github_monitor_rule_not_found" || code === "github_monitor_repository_not_found" ? 404
    : code === "github_monitor_rule_conflict" ? 409
      : code === "github_monitor_poll_failed" ? 502
        : 400;
  return c.json({ error: code }, status as 400 | 404 | 409 | 502);
}

async function optionalBody(value: Promise<string>): Promise<Record<string, unknown>> {
  const text = await value;
  if (text.trim() === "") return {};
  try { return object(JSON.parse(text)); } catch { invalid(); }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(input).some((key) => !allowed.has(key))) invalid();
}

function string(value: unknown, maximum: number): string {
  if (typeof value !== "string") invalid();
  const result = value.trim();
  if (result.length === 0 || result.length > maximum || result.includes("\0")) invalid();
  return result;
}

function boolean(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function optionalQuery(value: string | undefined): string | null { return value === undefined ? null : string(value, 512); }
function ruleId(value: string): string { return string(value, 128); }
function invalid(): never { throw new GitHubMonitorError("github_monitor_invalid"); }
