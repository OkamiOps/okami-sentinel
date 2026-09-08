import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubMonitorOverview, GitHubMonitorRule, GuardrailRepository } from "@csb/shared";
import { createGitHubMonitorApi } from "./api.js";
import { GitHubMonitorError } from "./service.js";

let sequence = 0;

function api() {
  const id = ++sequence;
  const repository: GuardrailRepository = {
    repositoryKey: `github:monitor-api-${id}`, repositoryPath: null, source: "github", displayName: "Acme/Sentinel",
    defaultBranch: "main", defaultExecutor: "sentinel-managed", remoteOwner: "acme", remoteName: "sentinel",
    githubConnectionId: "github-app-1", githubInstallationId: "55", githubRepositoryId: `monitor-api-${id}`, enabled: true,
    policyPath: ".csb/guardrails.json", lastGateId: null, githubStatus: "ready",
  };
  const rules: GitHubMonitorRule[] = [];
  const overview = (): GitHubMonitorOverview => ({
    rules, events: [], actionsRuns: [],
    summary: { enabledRules: rules.filter((rule) => rule.enabled).length, queuedEvents: 0, dispatchingEvents: 0, lastPolledAt: null, lastError: null, checkoutAvailable: false, recentActionsWindowDays: 7 },
  });
  const service = {
    overview,
    listRules: () => rules,
    listEvents: () => [],
    createRule: (input: { executor: GitHubMonitorRule["executor"]; scanner: GitHubMonitorRule["scanner"]; costCeilingUsd: number | null; dailyCostCeilingUsd?: number | null; followBranches: string[]; checkoutMode: GitHubMonitorRule["checkoutMode"]; enabled?: boolean }) => {
      if (input.enabled && (input.executor === "sentinel-managed") && (input.scanner === null || input.costCeilingUsd === null)) {
        throw new GitHubMonitorError("github_monitor_invalid");
      }
      const rule = {
        id: `rule-${id}`, repositoryKey: repository.repositoryKey,
        connectionId: repository.githubConnectionId!, installationId: repository.githubInstallationId!, repositoryId: repository.githubRepositoryId!,
        executor: input.executor, scanner: input.scanner, costCeilingUsd: input.costCeilingUsd,
        dailyCostCeilingUsd: input.dailyCostCeilingUsd ?? input.costCeilingUsd, followBranches: input.followBranches,
        checkoutMode: input.checkoutMode, enabled: input.enabled ?? false, revision: 1,
        baselineInitializedAt: null, lastPolledAt: null, lastError: null, createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
      } satisfies GitHubMonitorRule;
      rules.push(rule);
      return rule;
    },
    patchRule: () => rules[0]!,
    poll: async () => overview(),
  };
  const app = createGitHubMonitorApi({
    listRepositories: () => [repository],
    readRepositoryJson: async () => [],
    startAutomatic: async ({ event }) => ({ gateId: "gate-1", headSha: event.headSha }),
    checkoutAvailable: () => false,
    service: service as never,
  });
  return { app, repositoryKey: repository.repositoryKey, repositoryId: repository.githubRepositoryId! };
}

test("monitor API creates disabled observation rules and exposes stable wrappers", async () => {
  const { app, repositoryKey, repositoryId } = api();
  const response = await app.request("/github-monitor/rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repositoryKey,
      executor: "sentinel-managed",
      scanner: null,
      costCeilingUsd: null,
      followBranches: [],
      checkoutMode: "none",
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { rule: { enabled: boolean; repositoryId: string; scanner: unknown } };
  assert.equal(body.rule.enabled, false);
  assert.equal(body.rule.repositoryId, repositoryId);
  assert.equal(body.rule.scanner, null);

  const overview = await app.request(`/github-monitor/overview?repositoryKey=${encodeURIComponent(repositoryKey)}`);
  assert.equal(overview.status, 200);
  const overviewBody = await overview.json() as { overview: { summary: { checkoutAvailable: boolean; recentActionsWindowDays: number } } };
  assert.equal(overviewBody.overview.summary.checkoutAvailable, false);
  assert.equal(overviewBody.overview.summary.recentActionsWindowDays, 7);
});

test("monitor API rejects an enabled managed rule without a scanner and ceiling", async () => {
  const { app, repositoryKey } = api();
  const response = await app.request("/github-monitor/rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repositoryKey,
      executor: "sentinel-managed",
      scanner: null,
      costCeilingUsd: null,
      followBranches: ["main"],
      checkoutMode: "none",
      enabled: true,
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "github_monitor_invalid" });
});

test("monitor API permits a scanner-less Actions rule only with its explicit executor", async () => {
  const { app, repositoryKey } = api();
  const response = await app.request("/github-monitor/rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repositoryKey,
      executor: "github-actions",
      scanner: null,
      costCeilingUsd: 5,
      followBranches: ["main"],
      checkoutMode: "none",
      enabled: true,
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { rule: { executor: string; scanner: unknown; enabled: boolean } };
  assert.equal(body.rule.executor, "github-actions");
  assert.equal(body.rule.scanner, null);
  assert.equal(body.rule.enabled, true);
});

test("manual poll accepts the empty request body used by the browser client", async () => {
  const { app } = api();
  const response = await app.request("/github-monitor/poll", { method: "POST" });
  assert.equal(response.status, 200);
  const body = await response.json() as { overview: { rules: unknown[] } };
  assert.deepEqual(body.overview.rules, []);
});
