import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubAction, WebhookDeliveryRecord } from "@csb/shared";

import {
  buildGitHubIntegrationStatus,
  type GitHubIntegrationInstallationState,
  type GitHubIntegrationStatusDependencies,
} from "./integration-status.js";

const REQUIRED_GRANTS = {
  actions: "write",
  checks: "write",
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  workflows: "write",
} as const;

const ALL_EVENTS = [
  "pull_request",
  "push",
  "installation",
  "installation_repositories",
  "check_run",
  "workflow_run",
];

function action(overrides: Partial<GitHubAction> = {}): GitHubAction {
  return {
    id: "action-1",
    repositoryKey: "okamiops/sentinel",
    name: "Pull requests",
    triggerKind: "pull_request",
    branchPatterns: ["main"],
    executor: "sentinel-managed",
    connectionId: "connection-1",
    installationId: "77",
    repositoryId: "9001",
    scanner: null,
    costCeilingUsd: 2,
    dailyCostCeilingUsd: null,
    enabled: true,
    revision: 1,
    baselineInitializedAt: "2026-09-29T00:00:00.000Z",
    createdBy: null,
    lastEventAt: null,
    lastReconciledAt: "2026-09-30T11:45:00.000Z",
    lastError: null,
    migrationNote: null,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

const LAST_DELIVERY: WebhookDeliveryRecord = {
  deliveryId: "delivery-1",
  connectionId: "connection-1",
  event: "pull_request",
  action: "opened",
  repositoryKey: "okamiops/sentinel",
  installationId: "77",
  headSha: "a".repeat(40),
  outcome: "processed",
  reason: null,
  matchedActionIds: ["action-1"],
  eventIds: ["event-1"],
  receivedAt: "2026-09-30T11:50:00.000Z",
  durationMs: 12,
};

interface InstallationSpec {
  installationId?: string;
  account?: string;
  accountType?: "User" | "Organization";
  repositorySelection?: "all" | "selected";
  /** What this installation has actually approved; `null` when unknown. */
  granted?: Record<string, string> | null;
  repositories?: Array<{ repositoryId: string; repositoryKey: string | null }>;
}

interface ConnectionSpec {
  connectionId?: string;
  /** What the App asks for, from `GET /app`. */
  requested?: Record<string, string> | null;
  subscribed?: string[] | null;
  webhookSecret?: string | null;
  installations?: InstallationSpec[];
}

interface Overrides {
  granted?: Record<string, string> | null;
  subscribed?: string[] | null;
  webhookSecret?: string | null;
  repositorySelection?: "all" | "selected";
  installationId?: string;
  accountType?: "User" | "Organization";
  installationGrants?: Record<string, string> | null;
  actions?: GitHubAction[];
  repositories?: Array<{ repositoryId: string; repositoryKey: string | null }>;
  baseline?: Record<string, "absent" | "building" | "ready" | "stale">;
  publicOrigin?: string | null;
  lastDelivery?: WebhookDeliveryRecord | null;
  connections?: ConnectionSpec[];
}

function deps(overrides: Overrides = {}): GitHubIntegrationStatusDependencies & {
  readonly windows: string[];
} {
  const specs: ConnectionSpec[] = overrides.connections ?? [{
    requested: overrides.granted,
    subscribed: overrides.subscribed,
    webhookSecret: overrides.webhookSecret,
    installations: [{
      installationId: overrides.installationId,
      accountType: overrides.accountType,
      repositorySelection: overrides.repositorySelection,
      granted: overrides.installationGrants,
      repositories: overrides.repositories,
    }],
  }];
  const windows: string[] = [];
  const secrets = new Map<string, boolean>();
  const installations = new Map<string, GitHubIntegrationInstallationState[]>();
  const repositories = new Map<string, Array<{ repositoryId: string; repositoryKey: string | null }>>();
  const connections = specs.map((spec, index) => {
    const connectionId = spec.connectionId ?? `connection-${index + 1}`;
    secrets.set(
      connectionId,
      (spec.webhookSecret === undefined ? "s".repeat(32) : spec.webhookSecret) !== null,
    );
    installations.set(connectionId, (spec.installations ?? [{}]).map((installation, position) => {
      const installationId = installation.installationId ?? `${77 + index * 10 + position}`;
      repositories.set(installationId, installation.repositories ?? [
        { repositoryId: "9001", repositoryKey: "okamiops/sentinel" },
      ]);
      return {
        installationId,
        account: installation.account ?? "OkamiOps",
        accountType: installation.accountType ?? "User",
        repositorySelection: installation.repositorySelection ?? "all",
        grantedPermissions: installation.granted === undefined
          ? { ...REQUIRED_GRANTS }
          : installation.granted,
      };
    }));
    return {
      connectionId,
      appSlug: "okami-sentinel",
      appName: "OKAMI Sentinel Guardrails",
      requestedPermissions: spec.requested === undefined ? { ...REQUIRED_GRANTS } : spec.requested,
      subscribedEvents: spec.subscribed === undefined ? [...ALL_EVENTS] : spec.subscribed,
    };
  });
  return {
    windows,
    publicOrigin: overrides.publicOrigin === undefined ? "https://sentinel.example" : overrides.publicOrigin,
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    listConnections: () => connections,
    listInstallations: (connectionId) => installations.get(connectionId) ?? [],
    listRepositories: (installationId) => repositories.get(installationId) ?? [],
    listActions: () => overrides.actions ?? [action()],
    readBaselineState: (repositoryKey) =>
      overrides.baseline?.[repositoryKey] ?? "ready",
    readWebhookSecretConfigured: (connectionId) => secrets.get(connectionId) ?? false,
    countDeliveries: (since) => {
      windows.push(since);
      return { processed: 4, ignored: 2, failed: 1 };
    },
    countRecoveredEvents: (since) => {
      windows.push(since);
      return 3;
    },
    lastDelivery: () => overrides.lastDelivery === undefined ? LAST_DELIVERY : overrides.lastDelivery,
  };
}

test("reports a ready integration with every checklist step met", async () => {
  const status = await buildGitHubIntegrationStatus(deps());

  assert.deepEqual(status.checklist, [
    { id: "app_installed", ok: true },
    { id: "permissions", ok: true },
    { id: "events", ok: true },
    { id: "webhook_secret", ok: true },
    { id: "repository_enrolled", ok: true },
    { id: "action_enabled", ok: true },
    { id: "baseline", ok: true },
  ]);
  assert.equal(status.readyConnectionId, "connection-1");
  const connection = status.connections[0]!;
  assert.equal(connection.appName, "OKAMI Sentinel Guardrails");
  assert.equal(connection.ready, true);
  assert.deepEqual(connection.missing, []);
  assert.equal(connection.webhookUrl, "https://sentinel.example/api/github/webhook");
  assert.equal(connection.permissions.every((permission) => permission.ok), true);
  assert.equal(connection.events.every((event) => event.subscribed), true);
  assert.deepEqual(connection.installations, [{
    installationId: "77",
    account: "OkamiOps",
    repositorySelection: "all",
    authorizedRepositoryCount: 1,
    enrolledRepositoryCount: 1,
    manageUrl: "https://github.com/settings/installations/77",
  }]);
  assert.deepEqual(status.deliveries, {
    last: LAST_DELIVERY,
    last24h: { processed: 4, ignored: 2, failed: 1 },
  });
  assert.deepEqual(status.reconciliation, {
    lastAt: "2026-09-30T11:45:00.000Z",
    recoveredLast24h: 3,
  });
});

test("names the permission the App is missing", async () => {
  const status = await buildGitHubIntegrationStatus(
    deps({ granted: { checks: "write", pull_requests: "read" } }),
  );
  const pr = status.connections[0]!.permissions.find((p) => p.name === "pull_requests")!;
  assert.deepEqual(pr, {
    name: "pull_requests",
    required: "write",
    granted: "read",
    ok: false,
    pendingInstallationIds: [],
  });
  const contents = status.connections[0]!.permissions.find((p) => p.name === "contents")!;
  assert.deepEqual(contents, {
    name: "contents",
    required: "write",
    granted: null,
    ok: false,
    pendingInstallationIds: [],
  });
  const checks = status.connections[0]!.permissions.find((p) => p.name === "checks")!;
  assert.equal(checks.ok, true);
  assert.deepEqual(status.checklist.find((item) => item.id === "permissions"), {
    id: "permissions",
    ok: false,
  });
});

test("accepts a permission granted above the required level", async () => {
  const status = await buildGitHubIntegrationStatus(
    deps({
      granted: { ...REQUIRED_GRANTS, metadata: "write" },
      installationGrants: { ...REQUIRED_GRANTS, metadata: "write" },
    }),
  );
  const metadata = status.connections[0]!.permissions.find((p) => p.name === "metadata")!;
  assert.deepEqual(metadata, {
    name: "metadata",
    required: "read",
    granted: "write",
    ok: true,
    pendingInstallationIds: [],
  });
});

test("reports every permission unknown when the App metadata is unreachable", async () => {
  const status = await buildGitHubIntegrationStatus(deps({ granted: null, subscribed: null }));
  assert.equal(status.connections[0]!.permissions.every((p) => p.granted === null && !p.ok), true);
  assert.equal(status.connections[0]!.events.every((event) => !event.subscribed), true);
});

test("names the events the App does not subscribe to", async () => {
  const status = await buildGitHubIntegrationStatus(deps({ subscribed: ["push"] }));
  const events = status.connections[0]!.events;
  assert.equal(events.find((event) => event.name === "pull_request")!.subscribed, false);
  assert.equal(events.find((event) => event.name === "push")!.subscribed, true);
  assert.deepEqual(events.filter((event) => !event.subscribed).map((event) => event.name), [
    "pull_request",
    "installation",
    "installation_repositories",
    "check_run",
    "workflow_run",
  ]);
  assert.equal(status.checklist.find((item) => item.id === "events")!.ok, false);
});

test("never reports the webhook secret value", async () => {
  const status = await buildGitHubIntegrationStatus(deps({ webhookSecret: "super-secret-value" }));
  assert.equal(status.connections[0]!.webhookSecretConfigured, true);
  assert.ok(!JSON.stringify(status).includes("super-secret-value"));
});

test("marks the webhook secret absent and stops the checklist there", async () => {
  const status = await buildGitHubIntegrationStatus(deps({ webhookSecret: null }));
  assert.equal(status.connections[0]!.webhookSecretConfigured, false);
  assert.deepEqual(status.checklist.slice(3), [
    { id: "webhook_secret", ok: false },
    { id: "repository_enrolled", ok: false },
    { id: "action_enabled", ok: false },
    { id: "baseline", ok: false },
  ]);
});

test("points at the installation page when the scope is 'selected'", async () => {
  const status = await buildGitHubIntegrationStatus(
    deps({ repositorySelection: "selected", installationId: "42" }),
  );
  assert.equal(
    status.connections[0]!.installations[0]!.manageUrl,
    "https://github.com/settings/installations/42",
  );
});

test("points at the organization settings when the App is installed on an organization", async () => {
  const status = await buildGitHubIntegrationStatus(
    deps({ accountType: "Organization", installationId: "42" }),
  );
  assert.equal(
    status.connections[0]!.installations[0]!.manageUrl,
    "https://github.com/organizations/OkamiOps/settings/installations/42",
  );
});

test("counts authorized and enrolled repositories separately", async () => {
  const status = await buildGitHubIntegrationStatus(deps({
    repositories: [
      { repositoryId: "1", repositoryKey: "okamiops/sentinel" },
      { repositoryId: "2", repositoryKey: null },
      { repositoryId: "3", repositoryKey: null },
    ],
  }));
  const installation = status.connections[0]!.installations[0]!;
  assert.equal(installation.authorizedRepositoryCount, 3);
  assert.equal(installation.enrolledRepositoryCount, 1);
});

test("fails the checklist at the first unmet step", async () => {
  const status = await buildGitHubIntegrationStatus(
    deps({ actions: [action({ enabled: false })] }),
  );
  assert.equal(status.checklist.find((item) => item.id === "action_enabled")!.ok, false);
  assert.equal(status.checklist.find((item) => item.id === "baseline")!.ok, false);
  assert.equal(status.checklist.find((item) => item.id === "repository_enrolled")!.ok, true);
});

test("holds the baseline step until an enabled action reports a ready baseline", async () => {
  const status = await buildGitHubIntegrationStatus(
    deps({ baseline: { "okamiops/sentinel": "building" } }),
  );
  assert.equal(status.checklist.find((item) => item.id === "action_enabled")!.ok, true);
  assert.equal(status.checklist.find((item) => item.id === "baseline")!.ok, false);
});

test("reports no webhook URL without a public origin", async () => {
  const status = await buildGitHubIntegrationStatus(deps({ publicOrigin: null }));
  assert.equal(status.connections[0]!.webhookUrl, null);
});

test("asks for the deliveries of the last 24 hours only", async () => {
  const dependencies = deps();
  await buildGitHubIntegrationStatus(dependencies);
  assert.deepEqual(dependencies.windows, [
    "2026-09-29T12:00:00.000Z",
    "2026-09-29T12:00:00.000Z",
  ]);
});

test("reports an integration with no connection at all", async () => {
  const status = await buildGitHubIntegrationStatus({
    ...deps(),
    listConnections: () => [],
    listActions: () => [],
    lastDelivery: () => null,
  });
  assert.deepEqual(status.connections, []);
  assert.deepEqual(status.checklist.map((item) => item.ok), [
    false,
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
  assert.equal(status.deliveries.last, null);
  assert.equal(status.reconciliation.lastAt, null);
});

test("takes the most recent reconciliation across actions", async () => {
  const status = await buildGitHubIntegrationStatus(deps({
    actions: [
      action({ id: "a", lastReconciledAt: "2026-09-30T10:00:00.000Z" }),
      action({ id: "b", name: "Push", triggerKind: "push", lastReconciledAt: "2026-09-30T11:00:00.000Z" }),
      action({ id: "c", name: "Other", lastReconciledAt: null }),
    ],
  }));
  assert.equal(status.reconciliation.lastAt, "2026-09-30T11:00:00.000Z");
});

test("never reads as ready when two connections are each half configured", async () => {
  const status = await buildGitHubIntegrationStatus(deps({
    connections: [
      { connectionId: "connection-a", webhookSecret: null },
      {
        connectionId: "connection-b",
        requested: { ...REQUIRED_GRANTS, pull_requests: "read" },
        installations: [{ granted: { ...REQUIRED_GRANTS, pull_requests: "read" } }],
      },
    ],
    actions: [action({ connectionId: "connection-a" }), action({ id: "action-2", connectionId: "connection-b" })],
  }));

  assert.equal(status.readyConnectionId, null);
  assert.deepEqual(status.checklist, [
    { id: "app_installed", ok: true },
    { id: "permissions", ok: true },
    { id: "events", ok: true },
    { id: "webhook_secret", ok: false },
    { id: "repository_enrolled", ok: false },
    { id: "action_enabled", ok: false },
    { id: "baseline", ok: false },
  ]);
  assert.deepEqual(status.connections.map((item) => [item.connectionId, item.ready, item.missing]), [
    ["connection-a", false, ["webhook_secret"]],
    ["connection-b", false, ["permissions"]],
  ]);
});

test("a broken second connection does not spoil the healthy one", async () => {
  const status = await buildGitHubIntegrationStatus(deps({
    connections: [
      { connectionId: "connection-a" },
      { connectionId: "connection-b", subscribed: ["push"], webhookSecret: null },
    ],
    actions: [action({ connectionId: "connection-a" })],
  }));

  assert.equal(status.readyConnectionId, "connection-a");
  assert.equal(status.checklist.every((item) => item.ok), true);
  assert.deepEqual(status.connections[1]!.missing, ["events", "webhook_secret"]);
});

test("credits only the actions that belong to the healthy connection", async () => {
  const status = await buildGitHubIntegrationStatus(deps({
    connections: [
      { connectionId: "connection-a" },
      { connectionId: "connection-b", webhookSecret: null },
    ],
    actions: [action({ connectionId: "connection-b" })],
  }));

  assert.equal(status.readyConnectionId, "connection-a");
  assert.equal(status.checklist.find((item) => item.id === "repository_enrolled")!.ok, true);
  assert.equal(status.checklist.find((item) => item.id === "action_enabled")!.ok, false);
  assert.equal(status.checklist.find((item) => item.id === "baseline")!.ok, false);
});

test("names the installation whose permission review is still pending", async () => {
  const status = await buildGitHubIntegrationStatus(deps({
    granted: { ...REQUIRED_GRANTS },
    connections: [{
      requested: { ...REQUIRED_GRANTS },
      installations: [
        { installationId: "77", granted: { ...REQUIRED_GRANTS } },
        { installationId: "88", granted: { ...REQUIRED_GRANTS, pull_requests: "read" } },
      ],
    }],
  }));

  const pr = status.connections[0]!.permissions.find((p) => p.name === "pull_requests")!;
  assert.deepEqual(pr, {
    name: "pull_requests",
    required: "write",
    granted: "read",
    ok: false,
    pendingInstallationIds: ["88"],
  });
  assert.equal(status.connections[0]!.permissions.find((p) => p.name === "checks")!.ok, true);
  assert.deepEqual(status.connections[0]!.missing, ["permissions"]);
  assert.equal(status.checklist.find((item) => item.id === "permissions")!.ok, false);
});

test("treats an installation with unknown grants as pending", async () => {
  const status = await buildGitHubIntegrationStatus(deps({ installationGrants: null }));
  const permissions = status.connections[0]!.permissions;
  assert.equal(permissions.every((p) => p.granted === null && !p.ok), true);
  assert.deepEqual(permissions[0]!.pendingInstallationIds, ["77"]);
});

test("reports no webhook URL for a public origin that is not an absolute URL", async () => {
  const status = await buildGitHubIntegrationStatus(deps({ publicOrigin: "sentinel.okamilab.com" }));
  assert.equal(status.connections[0]!.webhookUrl, null);
});

test("fails a permission level GitHub does not define", async () => {
  const status = await buildGitHubIntegrationStatus(deps({
    installationGrants: { ...REQUIRED_GRANTS, checks: "toString" },
  }));
  const checks = status.connections[0]!.permissions.find((p) => p.name === "checks")!;
  assert.equal(checks.ok, false);
  assert.deepEqual(checks.pendingInstallationIds, ["77"]);
});
