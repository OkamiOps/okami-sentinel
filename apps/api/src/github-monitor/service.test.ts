import assert from "node:assert/strict";
import test from "node:test";

import type { GuardrailRepository } from "@csb/shared";

import { getDb } from "../db.js";
import {
  getGitHubMonitorEvent,
  listGitHubMonitorEvents,
  ensureGitHubMonitorSchema,
  acquireGitHubMonitorPollLease,
  renewGitHubMonitorPollLease,
  reserveGitHubMonitorEventDispatch,
} from "./store.js";
import { GitHubMonitorService } from "./service.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const SHA_E = "e".repeat(40);

let fixtureSequence = 0;

function repository(repositoryKey: string, repositoryId: string): GuardrailRepository {
  return {
    repositoryKey,
    repositoryPath: null,
    source: "github",
    displayName: "Acme/Sentinel",
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: "acme",
    remoteName: "sentinel",
    githubConnectionId: "github-app-1",
    githubInstallationId: "55",
    githubRepositoryId: repositoryId,
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "ready",
  };
}

function scanner() {
  return {
    engine: "codex-security" as const,
    connection: { connectionId: "model-connection-1", modelSelectionMode: "catalog" as const, modelId: "gpt-secure" },
    mode: "standard" as const,
  };
}

function fixture(options: { heads?: string[]; starts?: "ok" | "fail" } = {}) {
  ensureGitHubMonitorSchema(getDb());
  const sequence = ++fixtureSequence;
  const currentRepository = repository(`github:monitor-service-${sequence}`, `monitor-service-${sequence}`);
  const heads = options.heads ?? [SHA_A];
  const launches: Array<{ headSha: string; target: unknown }> = [];
  let now = new Date("2026-09-08T10:00:00.000Z");
  const service = new GitHubMonitorService({
    listRepositories: () => [currentRepository],
    readRepositoryJson: async (_repository, path) => {
      if (path.startsWith("/pulls?")) {
        return heads.map((headSha, index) => ({
          number: index + 1,
          title: `PR ${index + 1}`,
          base: { ref: "main" },
          head: { ref: `feature/${index + 1}`, sha: headSha },
        }));
      }
      if (path.startsWith("/branches?")) {
        return [{ name: "main", commit: { sha: SHA_D } }];
      }
      if (path.startsWith("/actions/runs?")) {
        return { workflow_runs: [{
          id: 1001,
          name: "CI",
          event: "pull_request",
          head_branch: "feature/1",
          head_sha: heads[0]!,
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/acme/sentinel/actions/runs/1001",
          created_at: "2026-09-08T09:00:00.000Z",
          updated_at: "2026-09-08T09:01:00.000Z",
        }] };
      }
      throw new Error(`unexpected path ${path}`);
    },
    startAutomatic: async ({ event, target }) => {
      launches.push({ headSha: event.headSha, target });
      if (options.starts === "fail") throw new Error("ambiguous transport disconnect");
      return { gateId: `gate-${event.headSha.slice(0, 4)}`, headSha: event.headSha };
    },
    now: () => now,
    createActionsRunId: () => `actions-row-${sequence}`,
  });
  return {
    service,
    repository: currentRepository,
    launches,
    setHeads(next: string[]) { heads.splice(0, heads.length, ...next); },
    advance(ms: number) { now = new Date(now.getTime() + ms); },
  };
}

test("disabled monitoring records PRs, branches and Actions without authorizing a paid launch", async () => {
  const { service, launches, repository } = fixture();
  const rule = service.createRule({
    repositoryKey: repository.repositoryKey,
    executor: "sentinel-managed",
    scanner: null,
    costCeilingUsd: null,
    followBranches: [],
    checkoutMode: "none",
  });
  await service.poll();

  const overview = service.overview();
  assert.equal(launches.length, 0);
  assert.equal(overview.events.length, 1);
  assert.equal(overview.events[0]?.status, "observed");
  assert.equal(overview.events[0]?.reason, "initial_baseline");
  assert.equal(overview.actionsRuns.length, 1);
  assert.equal(overview.rules[0]?.baselineInitializedAt, "2026-09-08T10:00:00.000Z");
  assert.equal(rule.enabled, false);
});

test("first activation resets the baseline, then dispatches only a new immutable PR head once", async () => {
  const { service, launches, setHeads, advance, repository } = fixture();
  const created = service.createRule({
    repositoryKey: repository.repositoryKey,
    executor: "sentinel-managed",
    scanner: null,
    costCeilingUsd: null,
    followBranches: [],
    checkoutMode: "none",
  });
  await service.poll();
  service.patchRule(created.id, {
    scanner: scanner(),
    costCeilingUsd: 2,
    dailyCostCeilingUsd: 4,
    followBranches: ["main"],
    enabled: true,
  });
  advance(1_000);
  await service.poll();
  assert.equal(launches.length, 0, "activation baseline must not scan old PRs");

  setHeads([SHA_B]);
  advance(1_000);
  await service.poll();
  assert.deepEqual(launches, [{ headSha: SHA_B, target: { kind: "pull_request", number: 1 } }]);
  const event = service.listEvents().find((candidate) => candidate.headSha === SHA_B);
  assert.equal(event?.status, "launched");
  assert.equal(event?.gateId, "gate-bbbb");

  advance(1_000);
  await service.poll();
  assert.equal(launches.length, 1, "repository/SHA/rule revision dedupe prevents a second paid launch");
});

test("the UTC daily reservation admits one ceiling and leaves later heads queued", async () => {
  const { service, launches, setHeads, advance, repository } = fixture({ heads: [SHA_A, SHA_B] });
  const rule = service.createRule({
    repositoryKey: repository.repositoryKey,
    executor: "sentinel-managed",
    scanner: scanner(),
    costCeilingUsd: 2,
    dailyCostCeilingUsd: 2,
    followBranches: ["main"],
    checkoutMode: "none",
    enabled: true,
  });
  await service.poll();
  setHeads([SHA_C, SHA_E]);
  advance(1_000);
  await service.poll();

  assert.equal(launches.length, 1);
  const events = service.listEvents({ ruleId: rule.id });
  assert.equal(events.filter((event) => event.status === "launched").length, 1);
  assert.equal(events.filter((event) => event.status === "queued" && event.reason === "daily_cost_ceiling").length, 1);
});

test("an unknown launch failure remains terminal and its reservation is not retried", async () => {
  const { service, setHeads, advance, repository } = fixture({ starts: "fail" });
  const rule = service.createRule({
    repositoryKey: repository.repositoryKey,
    executor: "sentinel-managed",
    scanner: scanner(),
    costCeilingUsd: 1,
    followBranches: ["main"],
    checkoutMode: "none",
    enabled: true,
  });
  await service.poll();
  setHeads([SHA_B]);
  advance(1_000);
  await service.poll();
  const failed = service.listEvents({ ruleId: rule.id }).find((event) => event.headSha === SHA_B);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "automatic_dispatch_failed");
  advance(1_000);
  await service.poll();
  assert.equal(getGitHubMonitorEvent(failed!.id)?.status, "failed");
});


test("atomic claims reserve a daily ceiling once and expired crash leases reconcile on a later poll", async () => {
  const { service, launches, advance, repository } = fixture();
  const rule = service.createRule({ repositoryKey: repository.repositoryKey, executor: "sentinel-managed", scanner: scanner(), costCeilingUsd: 2, dailyCostCeilingUsd: 2, followBranches: ["main"], checkoutMode: "none", enabled: true });
  await service.poll();
  const events = service.listEvents({ ruleId: rule.id });
  getDb().prepare("UPDATE github_monitor_events SET status = 'queued' WHERE rule_id = ?").run(rule.id);
  const reservation = (eventId: string) => reserveGitHubMonitorEventDispatch({ eventId, ruleId: rule.id, ruleRevision: rule.revision, dayStart: "2026-09-08T00:00:00.000Z", dayEnd: "2026-09-09T00:00:00.000Z", costCeilingUsd: 2, dailyCostCeilingUsd: 2, at: "2026-09-08T10:00:00.000Z" });
  assert.equal(acquireGitHubMonitorPollLease(rule.id, "crashed-worker", "2026-09-08T10:02:00.000Z", "2026-09-08T10:00:00.000Z"), true);
  assert.ok(reservation(events[0]!.id));
  assert.equal(reservation(events[0]!.id), null, "a second worker cannot claim the same event");
  assert.equal(reservation(events[1]!.id), null, "another event cannot exceed the daily ceiling");
  assert.equal(renewGitHubMonitorPollLease(rule.id, "other-worker", "2026-09-08T10:03:00.000Z", "2026-09-08T10:00:01.000Z"), false);
  assert.equal(service.reconcileStartup(), 0, "a restarted API must respect an existing lease until expiry");
  advance(121_000);
  await service.poll();
  assert.equal(getGitHubMonitorEvent(events[0]!.id)?.error, "automatic_dispatch_uncertain");
  assert.equal(launches.length, 0, "the uncertain paid dispatch keeps the day's reservation");
});

test("branch picker paginates enrolled remote branches and rejects unknown repositories", async () => {
  const remote = repository("github:branch-picker-test", "branch-picker-test");
  const paths: string[] = [];
  const service = new GitHubMonitorService({
    listRepositories: () => [remote],
    readRepositoryJson: async (_repository, path) => {
      paths.push(path);
      return path.endsWith("page=1")
        ? Array.from({ length: 100 }, (_, index) => ({ name: `topic-${index}`, commit: { sha: SHA_A } }))
        : [{ name: "main", commit: { sha: SHA_B } }];
    },
    startAutomatic: async () => { throw new Error("must not scan while listing branches"); },
  });
  const branches = await service.availableBranches(remote.repositoryKey);
  assert.equal(branches.length, 101);
  assert.equal(branches[0], "main");
  assert.deepEqual(paths, ["/branches?per_page=100&page=1", "/branches?per_page=100&page=2"]);
  await assert.rejects(service.availableBranches("github:unknown"));
  assert.equal(paths.length, 2);
});

test("following all branches catches newly created branches without scanning the initial inventory or duplicate heads", async () => {
  const remote = repository("github:all-branches-test", "all-branches-test");
  const branches = [{ name: "main", commit: { sha: SHA_A } }];
  const launches: string[] = [];
  const service = new GitHubMonitorService({
    listRepositories: () => [remote],
    readRepositoryJson: async (_repository, path) => path.startsWith("/branches?") ? branches : path.startsWith("/pulls?") ? [] : { workflow_runs: [] },
    startAutomatic: async ({ event }) => { launches.push(event.headSha); return { gateId: `all-${event.headSha}`, headSha: event.headSha }; },
  });
  service.createRule({ repositoryKey: remote.repositoryKey, executor: "sentinel-managed", scanner: scanner(), costCeilingUsd: 1, dailyCostCeilingUsd: 5, followBranches: ["*"], checkoutMode: "none", enabled: true });
  await service.poll(remote.repositoryKey);
  assert.deepEqual(launches, []);
  branches.push({ name: "feature/created-after-setup", commit: { sha: SHA_B } });
  await service.poll(remote.repositoryKey);
  assert.deepEqual(launches, [SHA_B]);
  await service.poll(remote.repositoryKey);
  assert.deepEqual(launches, [SHA_B]);
  branches.push({ name: "another-name-same-head", commit: { sha: SHA_B } });
  await service.poll(remote.repositoryKey);
  assert.deepEqual(launches, [SHA_B]);
});
