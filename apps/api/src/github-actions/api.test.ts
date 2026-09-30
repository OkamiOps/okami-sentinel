import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";
import type {
  GitHubAction,
  GitHubActionCreate,
  GitHubActionEvent,
  GitHubActionPatch,
  GuardrailRepository,
  RepositoryRole,
  WebhookDeliveryRecord,
} from "@csb/shared";

import type { Principal } from "../auth/principal.js";
import {
  createGitHubActionsApi,
  patchRequiresAdmin,
  type GitHubActionsApiDependencies,
} from "./api.js";
import { buildGitHubIntegrationStatus } from "./integration-status.js";

const SECRET = "super-secret-webhook-value";
const REPO_A = "github:1";
const REPO_B = "github:2";
const LOCAL = "local:/srv/app";

function repository(key: string, overrides: Partial<GuardrailRepository> = {}): GuardrailRepository {
  return {
    repositoryKey: key,
    repositoryPath: null,
    source: "github",
    displayName: key,
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: "okami",
    remoteName: key.replace(":", "-"),
    githubConnectionId: "c1",
    githubInstallationId: "i1",
    githubRepositoryId: key.split(":")[1] ?? "1",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "ready",
    ...overrides,
  };
}

function action(id: string, overrides: Partial<GitHubAction> = {}): GitHubAction {
  return {
    id,
    repositoryKey: REPO_A,
    name: `PR ${id}`,
    triggerKind: "pull_request",
    branchPatterns: ["main"],
    executor: "sentinel-managed",
    connectionId: "c1",
    installationId: "i1",
    repositoryId: "1",
    scanner: null,
    costCeilingUsd: 2,
    dailyCostCeilingUsd: 6,
    enabled: false,
    includeForks: false,
    revision: 1,
    baselineInitializedAt: null,
    createdBy: "admin",
    lastEventAt: null,
    lastReconciledAt: null,
    lastError: null,
    migrationNote: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

function event(id: string, repositoryKey: string, actionId: string): GitHubActionEvent {
  return {
    id,
    actionId,
    repositoryKey,
    actionRevision: 1,
    origin: "webhook",
    deliveryId: `d-${id}`,
    kind: "pull_request",
    status: "queued",
    headSha: "a".repeat(40),
    baseRef: "main",
    headRef: "topic",
    pullRequestNumber: 7,
    targetIdentity: `pr:7@${"a".repeat(40)}` as GitHubActionEvent["targetIdentity"],
    title: "Fixes the deploy hook",
    gateId: null,
    costCeilingUsd: 2,
    reason: null,
    error: null,
    detectedAt: `2026-09-30T1${id.length}:00:00.000Z`,
    observedAt: null,
    dispatchedAt: null,
    completedAt: null,
  };
}

function delivery(id: string, repositoryKey: string | null): WebhookDeliveryRecord {
  return {
    deliveryId: id,
    connectionId: "c1",
    event: "pull_request",
    action: "opened",
    repositoryKey,
    installationId: "i1",
    headSha: "a".repeat(40),
    outcome: "processed",
    reason: null,
    matchedActionIds: ["a1"],
    eventIds: ["e1"],
    receivedAt: "2026-09-30T12:00:00.000Z",
    durationMs: 12,
  };
}

const admin: Principal = {
  kind: "user", userId: "u-admin", sessionId: "s", username: "admin", displayName: "Admin",
  isAdmin: true, grants: new Map(),
};

function member(role: RepositoryRole, repositoryKey = REPO_A): Principal {
  return {
    kind: "user", userId: `u-${role}`, sessionId: "s", username: role, displayName: role,
    isAdmin: false, grants: new Map([[repositoryKey, role]]),
  };
}

interface Harness {
  server: (principal: Principal) => Hono;
  actions: GitHubAction[];
  secrets: Map<string, string>;
  invalidations: number;
  reconciles: number;
}

function harness(options: {
  actions?: GitHubAction[];
  repositories?: GuardrailRepository[];
  events?: GitHubActionEvent[];
  deliveries?: WebhookDeliveryRecord[];
} = {}): Harness {
  const actions = options.actions ?? [];
  const repositories = options.repositories
    ?? [repository(REPO_A), repository(REPO_B), repository(LOCAL, { source: "local", repositoryPath: "/srv/app", githubConnectionId: null, githubInstallationId: null, githubRepositoryId: null })];
  const events = options.events ?? [];
  const deliveries = options.deliveries ?? [];
  const secrets = new Map<string, string>();
  const state = { invalidations: 0, reconciles: 0 };

  const dependencies: GitHubActionsApiDependencies = {
    getAction: (id) => actions.find((candidate) => candidate.id === id) ?? null,
    listActions: (filter) => actions.filter((candidate) =>
      filter.repositoryKey === undefined || filter.repositoryKey === null
      || candidate.repositoryKey === filter.repositoryKey),
    createAction: (input: GitHubActionCreate) => {
      if (actions.some((candidate) => candidate.repositoryKey === input.repositoryKey
        && candidate.triggerKind === input.triggerKind && candidate.name === input.name)) {
        throw new Error("github_action_name_taken");
      }
      const created = action(`a${actions.length + 1}`, { ...input, revision: 1 });
      actions.push(created);
      return created;
    },
    patchAction: (id, patch: GitHubActionPatch) => {
      const index = actions.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const current = actions[index]!;
      if (patch.enabled === true && current.migrationNote === "migrated_pattern_missing"
        && patch.branchPatterns === undefined) {
        throw new Error("github_action_branch_patterns_unreviewed");
      }
      const next = { ...current, ...patch };
      actions[index] = next;
      return next;
    },
    deleteAction: (id) => {
      const index = actions.findIndex((candidate) => candidate.id === id);
      if (index === -1) return false;
      actions.splice(index, 1);
      return true;
    },
    getRepository: (key) => repositories.find((candidate) => candidate.repositoryKey === key) ?? null,
    listEvents: (filter) => events
      .filter((candidate) => filter.actionId === undefined || candidate.actionId === filter.actionId)
      .filter((candidate) => filter.repositoryKeys === undefined
        || filter.repositoryKeys.includes(candidate.repositoryKey))
      .filter((candidate) => filter.statuses === undefined || filter.statuses.includes(candidate.status))
      .slice(filter.offset, filter.offset + filter.limit),
    listDeliveries: (options_) => deliveries.slice(options_.offset, options_.offset + options_.limit),
    readIntegrationStatus: () => buildGitHubIntegrationStatus({
      listConnections: () => [{
        connectionId: "c1", appSlug: "okami", appName: "Okami Sentinel",
        appId: "4242", recordedAppId: "4242",
        requestedPermissions: { metadata: "read" }, subscribedEvents: ["push"],
      }],
      listInstallations: () => [{
        installationId: "i1", account: "okami", accountType: "Organization",
        repositorySelection: "all", grantedPermissions: { metadata: "read" },
      }],
      listRepositories: () => [{ repositoryId: "1", repositoryKey: REPO_A }],
      listActions: () => actions,
      readBaselineState: () => "absent",
      // The value never enters the status: only whether one is stored.
      readWebhookSecretConfigured: (id) => secrets.has(id),
      readLastVerifiedDeliveryAt: () => deliveries[0]?.receivedAt ?? null,
      countDeliveries: () => ({ processed: 1, ignored: 0, failed: 0 }),
      countRecoveredEvents: () => 0,
      lastDelivery: () => deliveries[0] ?? null,
      publicOrigin: "https://sentinel.example",
    }),
    storeWebhookSecret: async (connectionId, secret) => {
      if (connectionId !== "c1") throw new Error("credential_not_found");
      secrets.set(connectionId, secret);
    },
    invalidateWebhookSecrets: () => { state.invalidations += 1; },
    reconcile: async () => {
      state.reconciles += 1;
      return { repositories: 1, created: 2, observed: 3, errors: 0 };
    },
  };

  return {
    actions,
    secrets,
    get invalidations() { return state.invalidations; },
    get reconciles() { return state.reconciles; },
    server: (principal) => {
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("principal" as never, principal as never);
        await next();
      });
      app.route("/", createGitHubActionsApi(dependencies));
      return app;
    },
  };
}

const CREATE_BODY = {
  repositoryKey: REPO_A,
  name: "PR deep",
  triggerKind: "pull_request",
  branchPatterns: ["main", "release/**"],
  executor: "sentinel-managed",
  scanner: null,
  costCeilingUsd: 2.5,
  dailyCostCeilingUsd: 6,
  enabled: true,
};

async function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patch(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("lets an administrator create an action", async () => {
  const bench = harness();
  const response = await post(bench.server(admin), "/github/actions", CREATE_BODY);
  assert.equal(response.status, 201);
  const body = await response.json() as { action: GitHubAction };
  assert.equal(body.action.name, "PR deep");
  assert.equal(body.action.enabled, true);
  // The App authority is copied from the enrolled repository, never entered.
  assert.equal(body.action.connectionId, "c1");
  assert.equal(body.action.installationId, "i1");
  assert.equal(body.action.repositoryId, "1");
  // Authorship comes from the session, never from the body.
  assert.equal(body.action.createdBy, "u-admin");
});

test("refuses an action created by a maintainer", async () => {
  const bench = harness();
  const response = await post(bench.server(member("maintainer")), "/github/actions", CREATE_BODY);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden" });
  assert.deepEqual(bench.actions, []);
});

test("refuses include_forks from anyone but an administrator", async () => {
  const bench = harness({ actions: [action("a1")] });
  const created = await post(bench.server(member("maintainer")), "/github/actions",
    { ...CREATE_BODY, includeForks: true });
  assert.equal(created.status, 403);
  const patched = await patch(bench.server(member("maintainer")), "/github/actions/a1",
    { includeForks: true });
  assert.equal(patched.status, 403);
  assert.deepEqual(await patched.json(), { error: "forbidden" });
  const byAdmin = await patch(bench.server(admin), "/github/actions/a1", { includeForks: true });
  assert.equal(byAdmin.status, 200);
  assert.equal(bench.actions[0]!.includeForks, true);
});

test("lets a maintainer disable an action", async () => {
  const bench = harness({ actions: [action("a1", { enabled: true })] });
  const response = await patch(bench.server(member("maintainer")), "/github/actions/a1", { enabled: false });
  assert.equal(response.status, 200);
  assert.equal(bench.actions[0]!.enabled, false);
});

test("lets a maintainer disable a spending migrated action", async () => {
  // The pair the migration produced spends real money and was enabled before
  // any route existed; switching it off must not need an administrator.
  const bench = harness({
    actions: [action("a1", {
      enabled: true, name: "PR", executor: "github-actions",
      migrationNote: "migrated_pattern_missing", branchPatterns: ["*"],
    })],
  });
  const response = await patch(bench.server(member("maintainer")), "/github/actions/a1", { enabled: false });
  assert.equal(response.status, 200);
  assert.equal(bench.actions[0]!.enabled, false);
});

test("refuses a maintainer enabling an action", async () => {
  const bench = harness({ actions: [action("a1")] });
  const response = await patch(bench.server(member("maintainer")), "/github/actions/a1", { enabled: true });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden" });
  assert.equal(bench.actions[0]!.enabled, false);
});

test("refuses a maintainer renaming an enabled action", async () => {
  const bench = harness({ actions: [action("a1", { enabled: true })] });
  const response = await patch(bench.server(member("maintainer")), "/github/actions/a1", { name: "Renamed" });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden" });
});

test("lets a maintainer rename a disabled action", async () => {
  const bench = harness({ actions: [action("a1")] });
  const response = await patch(bench.server(member("maintainer")), "/github/actions/a1",
    { name: "Renamed", branchPatterns: ["release/**"] });
  assert.equal(response.status, 200);
  assert.equal(bench.actions[0]!.name, "Renamed");
  assert.deepEqual(bench.actions[0]!.branchPatterns, ["release/**"]);
});

test("refuses a maintainer touching a ceiling of a disabled action", async () => {
  const bench = harness({ actions: [action("a1")] });
  const response = await patch(bench.server(member("maintainer")), "/github/actions/a1", { costCeilingUsd: 50 });
  assert.equal(response.status, 403);
});

test("lets a maintainer delete an action", async () => {
  const bench = harness({ actions: [action("a1", { enabled: true })] });
  const response = await bench.server(member("maintainer")).request("/github/actions/a1", { method: "DELETE" });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.deepEqual(bench.actions, []);
});

test("refuses a viewer every write and allows every read", async () => {
  const bench = harness({ actions: [action("a1")], events: [event("e1", REPO_A, "a1")] });
  const viewer = bench.server(member("viewer"));
  assert.equal((await viewer.request("/github/actions")).status, 200);
  assert.equal((await viewer.request("/github/actions/a1/events")).status, 200);
  assert.equal((await patch(viewer, "/github/actions/a1", { enabled: false })).status, 403);
  assert.equal((await viewer.request("/github/actions/a1", { method: "DELETE" })).status, 403);
});

test("answers 404 for an action outside the caller's scope", async () => {
  const bench = harness({ actions: [action("a1")], events: [event("e1", REPO_A, "a1")] });
  const outsider = bench.server(member("maintainer", REPO_B));
  for (const response of [
    await patch(outsider, "/github/actions/a1", { enabled: false }),
    await outsider.request("/github/actions/a1", { method: "DELETE" }),
    await outsider.request("/github/actions/a1/events"),
  ]) {
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  }
  // An unknown id is indistinguishable from an invisible one, for anybody.
  const unknown = await patch(bench.server(admin), "/github/actions/nope", { enabled: false });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "not_found" });
});

test("never returns the webhook secret", async () => {
  const bench = harness({ deliveries: [delivery("d1", REPO_A)] });
  const server = bench.server(admin);
  const stored = await server.request("/github/integration/webhook-secret", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId: "c1", secret: SECRET }),
  });
  assert.equal(stored.status, 204);
  assert.equal(await stored.text(), "");
  assert.equal(bench.secrets.get("c1"), SECRET);
  // The cache the webhook reads must forget its snapshot, or a fresh secret is
  // ignored for a whole window and reads as the operator's own mistake.
  assert.equal(bench.invalidations, 1);

  const status = await server.request("/github/integration");
  assert.equal(status.status, 200);
  const text = await status.text();
  assert.ok(!text.includes(SECRET), "the status echoed the secret");
  assert.ok(!text.includes("super-secret"), "the status echoed part of the secret");
  const body = JSON.parse(text) as { connections: Array<{ webhookSecretConfigured: boolean }> };
  assert.equal(body.connections[0]!.webhookSecretConfigured, true);
});

test("refuses a webhook secret for an unknown connection and a short one", async () => {
  const bench = harness();
  const server = bench.server(admin);
  const short = await server.request("/github/integration/webhook-secret", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId: "c1", secret: "short" }),
  });
  assert.equal(short.status, 400);
  assert.deepEqual(await short.json(), { error: "webhook_secret_invalid" });
  const unknown = await server.request("/github/integration/webhook-secret", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId: "c9", secret: SECRET }),
  });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "connection_not_found" });
  assert.equal(bench.invalidations, 0);
});

test("answers the same code for an unknown and an unshared repository", async () => {
  const bench = harness();
  const unknown = await post(bench.server(admin), "/github/actions",
    { ...CREATE_BODY, repositoryKey: "github:404" });
  const unshared = await post(bench.server(member("maintainer", REPO_B)), "/github/actions",
    { ...CREATE_BODY, repositoryKey: REPO_A });
  for (const response of [unknown, unshared]) {
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "repository_not_found" });
  }
});

test("scopes GET /github/actions to the caller's grants", async () => {
  const bench = harness({
    actions: [action("a1"), action("a2", { repositoryKey: REPO_B, name: "PR B" })],
  });
  const viewer = bench.server(member("viewer"));
  const all = await viewer.request("/github/actions");
  assert.deepEqual(((await all.json()) as { actions: GitHubAction[] }).actions.map((item) => item.id), ["a1"]);
  // Naming a repository the caller cannot see is the enumeration attempt the
  // 404 closes; naming a visible one narrows the list.
  const other = await viewer.request(`/github/actions?repositoryKey=${encodeURIComponent(REPO_B)}`);
  assert.equal(other.status, 404);
  assert.deepEqual(await other.json(), { error: "repository_not_found" });
  const mine = await viewer.request(`/github/actions?repositoryKey=${encodeURIComponent(REPO_A)}`);
  assert.deepEqual(((await mine.json()) as { actions: GitHubAction[] }).actions.map((item) => item.id), ["a1"]);
  // An administrator sees both.
  const everything = await bench.server(admin).request("/github/actions");
  assert.deepEqual(
    ((await everything.json()) as { actions: GitHubAction[] }).actions.map((item) => item.id),
    ["a1", "a2"],
  );
});

test("validates branch patterns and the cost ceiling", async () => {
  const bench = harness();
  const server = bench.server(admin);
  const tooMany = await post(server, "/github/actions",
    { ...CREATE_BODY, branchPatterns: Array.from({ length: 21 }, (_, index) => `b${index}`) });
  assert.equal(tooMany.status, 400);
  assert.deepEqual(await tooMany.json(), { error: "invalid_branch_patterns" });
  const none = await post(server, "/github/actions", { ...CREATE_BODY, branchPatterns: [] });
  assert.equal(none.status, 400);
  assert.deepEqual(await none.json(), { error: "invalid_branch_patterns" });
  // Five wildcards is polynomial backtracking against a branch name any
  // contributor can choose, and the matcher refuses to compile it at all.
  const wild = await post(server, "/github/actions",
    { ...CREATE_BODY, branchPatterns: ["a*b*c*d*e*f"] });
  assert.equal(wild.status, 400);
  assert.deepEqual(await wild.json(), { error: "invalid_branch_patterns" });
  const fourWildcards = await post(server, "/github/actions",
    { ...CREATE_BODY, name: "PR four", branchPatterns: ["a*b*c*d*e"] });
  assert.equal(fourWildcards.status, 201);
  const zero = await post(server, "/github/actions", { ...CREATE_BODY, name: "PR zero", costCeilingUsd: 0 });
  assert.equal(zero.status, 400);
  assert.deepEqual(await zero.json(), { error: "invalid_cost_ceiling" });
  const daily = await post(server, "/github/actions",
    { ...CREATE_BODY, name: "PR daily", dailyCostCeilingUsd: -1 });
  assert.equal(daily.status, 400);
  assert.deepEqual(await daily.json(), { error: "invalid_cost_ceiling" });
});

test("refuses a wildcard storm in a patch too", async () => {
  const bench = harness({ actions: [action("a1")] });
  const response = await patch(bench.server(admin), "/github/actions/a1",
    { branchPatterns: ["a*b*c*d*e*f"] });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_branch_patterns" });
});

test("refuses an action for a local repository", async () => {
  const bench = harness();
  const response = await post(bench.server(admin), "/github/actions",
    { ...CREATE_BODY, repositoryKey: LOCAL });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "repository_source_unsupported" });
});

test("refuses enabling an action whose migrated patterns were never reviewed", async () => {
  const bench = harness({
    actions: [action("a1", { migrationNote: "migrated_pattern_missing", branchPatterns: ["*"] })],
  });
  const response = await patch(bench.server(admin), "/github/actions/a1", { enabled: true });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "github_action_branch_patterns_unreviewed" });
  assert.equal(bench.actions[0]!.enabled, false);
  // Naming the branches in the same patch is exactly what clears it.
  const withPatterns = await patch(bench.server(admin), "/github/actions/a1",
    { enabled: true, branchPatterns: ["main"] });
  assert.equal(withPatterns.status, 200);
});

test("answers 409 when the name is already taken", async () => {
  const bench = harness({ actions: [action("a1", { name: "PR" })] });
  const response = await post(bench.server(admin), "/github/actions", { ...CREATE_BODY, name: "PR" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "github_action_name_taken" });
});

test("refuses a body with an unknown field and an empty patch", async () => {
  const bench = harness({ actions: [action("a1")] });
  const server = bench.server(admin);
  const extra = await post(server, "/github/actions", { ...CREATE_BODY, connectionId: "c9" });
  assert.equal(extra.status, 400);
  assert.deepEqual(await extra.json(), { error: "invalid_request" });
  const empty = await patch(server, "/github/actions/a1", {});
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: "invalid_request" });
});

test("scopes and paginates the consolidated events listing", async () => {
  const bench = harness({
    actions: [action("a1"), action("a2", { repositoryKey: REPO_B, name: "PR B" })],
    events: [event("e1", REPO_A, "a1"), event("e2", REPO_A, "a1"), event("e3", REPO_B, "a2")],
  });
  const viewer = bench.server(member("viewer"));
  const mine = await viewer.request("/github/events");
  assert.equal(mine.status, 200);
  const body = await mine.json() as { events: GitHubActionEvent[]; limit: number; offset: number; hasMore: boolean };
  assert.deepEqual(body.events.map((item) => item.id), ["e1", "e2"]);
  assert.equal(body.hasMore, false);
  assert.equal(body.offset, 0);

  const page = await viewer.request("/github/events?limit=1");
  const first = await page.json() as { events: GitHubActionEvent[]; hasMore: boolean };
  assert.deepEqual(first.events.map((item) => item.id), ["e1"]);
  assert.equal(first.hasMore, true);
  const second = await (await viewer.request("/github/events?limit=1&offset=1")).json() as
    { events: GitHubActionEvent[]; hasMore: boolean };
  assert.deepEqual(second.events.map((item) => item.id), ["e2"]);
  assert.equal(second.hasMore, false);

  // A repository outside the grant answers like one that does not exist.
  const other = await viewer.request(`/github/events?repositoryKey=${encodeURIComponent(REPO_B)}`);
  assert.equal(other.status, 404);
  assert.deepEqual(await other.json(), { error: "repository_not_found" });

  const filtered = await viewer.request("/github/events?outcome=launched");
  assert.deepEqual(((await filtered.json()) as { events: GitHubActionEvent[] }).events, []);
  const bad = await viewer.request("/github/events?outcome=nonsense");
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "invalid_request" });
});

test("scopes the per-action events listing to the action's repository", async () => {
  const bench = harness({
    actions: [action("a1")],
    events: [event("e1", REPO_A, "a1"), event("e2", REPO_A, "a1")],
  });
  const response = await bench.server(member("viewer")).request("/github/actions/a1/events?limit=1");
  assert.equal(response.status, 200);
  const body = await response.json() as { events: GitHubActionEvent[]; hasMore: boolean };
  assert.deepEqual(body.events.map((item) => item.id), ["e1"]);
  assert.equal(body.hasMore, true);
});

test("keeps the deliveries listing for administrators and free of payloads", async () => {
  const bench = harness({ deliveries: [delivery("d1", REPO_A), delivery("d2", null)] });
  const refused = await bench.server(member("maintainer")).request("/github/deliveries");
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "forbidden" });

  const response = await bench.server(admin).request("/github/deliveries?limit=1");
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text) as { deliveries: WebhookDeliveryRecord[]; hasMore: boolean };
  assert.deepEqual(body.deliveries.map((item) => item.deliveryId), ["d1"]);
  assert.equal(body.hasMore, true);
  // A delivery row carries a result and a reason, never the payload or a secret.
  for (const forbidden of ["payload", "signature", "secret", "body"]) {
    assert.ok(!text.includes(forbidden), `the deliveries listing exposed ${forbidden}`);
  }
  assert.deepEqual(
    Object.keys(body.deliveries[0]!).sort(),
    ["action", "connectionId", "deliveryId", "durationMs", "event", "eventIds", "headSha",
      "installationId", "matchedActionIds", "outcome", "reason", "receivedAt", "repositoryKey"],
  );
});

test("reconciles on demand for an administrator only", async () => {
  const bench = harness();
  const refused = await post(bench.server(member("maintainer")), "/github/reconcile", {});
  assert.equal(refused.status, 403);
  assert.equal(bench.reconciles, 0);
  const response = await post(bench.server(admin), "/github/reconcile", {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { repositories: 1, created: 2, observed: 3, errors: 0 });
  assert.equal(bench.reconciles, 1);
});

test("keeps the integration status for administrators only", async () => {
  const bench = harness();
  const response = await bench.server(member("maintainer")).request("/github/integration");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden" });
});

test("the cost rule is one pure function", () => {
  const disabled = action("a1");
  const enabled = action("a1", { enabled: true });
  assert.equal(patchRequiresAdmin(disabled, { enabled: false }), false);
  assert.equal(patchRequiresAdmin(enabled, { enabled: false }), false);
  assert.equal(patchRequiresAdmin(disabled, { enabled: true }), true);
  assert.equal(patchRequiresAdmin(disabled, { name: "x" }), false);
  assert.equal(patchRequiresAdmin(enabled, { name: "x" }), true);
  assert.equal(patchRequiresAdmin(disabled, { branchPatterns: ["main"] }), false);
  assert.equal(patchRequiresAdmin(enabled, { branchPatterns: ["main"] }), true);
  assert.equal(patchRequiresAdmin(disabled, { triggerKind: "push" }), false);
  assert.equal(patchRequiresAdmin(enabled, { triggerKind: "push" }), true);
  for (const spending of [
    { executor: "github-actions" as const },
    { connectionId: "c2" },
    { installationId: "i2" },
    { repositoryId: "9" },
    { scanner: null },
    { costCeilingUsd: 1 },
    { dailyCostCeilingUsd: 1 },
    { includeForks: true },
    { includeForks: false },
  ]) {
    assert.equal(patchRequiresAdmin(disabled, spending), true, JSON.stringify(spending));
  }
});
