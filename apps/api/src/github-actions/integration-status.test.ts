import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubAction, WebhookDeliveryRecord } from "@csb/shared";

import {
  buildGitHubIntegrationStatus,
  type GitHubIntegrationInstallationState,
  type GitHubIntegrationStatusDependencies,
} from "./integration-status.js";

const REQUIRED_GRANTS = {
  actions: "read",
  checks: "write",
  contents: "write",
  metadata: "read",
  pull_requests: "read",
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
    includeForks: false,
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
  /** GitHub's own switch: a suspended installation refuses every token. */
  suspended?: boolean;
  repositories?: Array<{ repositoryId: string; repositoryKey: string | null }>;
}

interface ConnectionSpec {
  connectionId?: string;
  /** When this connection last proved its secret; `null` means never. */
  lastVerifiedDeliveryAt?: string | null;
  /** What the App asks for, from `GET /app`. */
  requested?: Record<string, string> | null;
  subscribed?: string[] | null;
  webhookSecret?: string | null;
  installations?: InstallationSpec[];
  /** GitHub's own numeric App id; `null` when `GET /app` could not be read. */
  appId?: string | null;
  /** The id the connection row holds, which may be a slug or a client id. */
  recordedAppId?: string | null;
  /** `false` reproduces a connection whose manifest exchange never finished. */
  connectionReady?: boolean;
  /** When the current secret was stored; `undefined` means "before the log existed". */
  secretStoredAt?: string | null;
}

interface Overrides {
  lastVerifiedDeliveryAt?: string | null;
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
  connectionReady?: boolean;
  secretStoredAt?: string | null;
}

function deps(overrides: Overrides = {}): GitHubIntegrationStatusDependencies & {
  readonly windows: string[];
} {
  const specs: ConnectionSpec[] = overrides.connections ?? [{
    requested: overrides.granted,
    subscribed: overrides.subscribed,
    webhookSecret: overrides.webhookSecret,
    lastVerifiedDeliveryAt: overrides.lastVerifiedDeliveryAt,
    ...(overrides.connectionReady === undefined ? {} : { connectionReady: overrides.connectionReady }),
    ...(overrides.secretStoredAt === undefined ? {} : { secretStoredAt: overrides.secretStoredAt }),
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
  const verified = new Map<string, string | null>();
  const storedAt = new Map<string, string | null>();
  const installations = new Map<string, GitHubIntegrationInstallationState[]>();
  const repositories = new Map<string, Array<{ repositoryId: string; repositoryKey: string | null }>>();
  const connections = specs.map((spec, index) => {
    const connectionId = spec.connectionId ?? `connection-${index + 1}`;
    const secretConfigured = (spec.webhookSecret === undefined ? "s".repeat(32) : spec.webhookSecret) !== null;
    secrets.set(connectionId, secretConfigured);
    // A configured secret is assumed proven unless a case says otherwise: the new
    // step exists for the case where it is present and has never worked.
    verified.set(connectionId, spec.lastVerifiedDeliveryAt === undefined
      ? (secretConfigured ? "2026-09-30T11:55:00.000Z" : null)
      : spec.lastVerifiedDeliveryAt);
    storedAt.set(connectionId, spec.secretStoredAt ?? null);
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
        suspended: installation.suspended ?? false,
      };
    }));
    return {
      connectionId,
      appSlug: "okami-sentinel",
      appName: "OKAMI Sentinel Guardrails",
      appId: spec.appId === undefined ? "4242" : spec.appId,
      recordedAppId: spec.recordedAppId === undefined ? "4242" : spec.recordedAppId,
      connectionReady: spec.connectionReady ?? true,
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
    readLastVerifiedDeliveryAt: (connectionId) => verified.get(connectionId) ?? null,
    readWebhookSecretStoredAt: (connectionId) => storedAt.get(connectionId) ?? null,
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
    { id: "delivery_verified", ok: true },
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
    suspended: false,
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
  // `contents` is the write the product uses today, so it is the one a narrowed
  // grant has to be caught on.
  const status = await buildGitHubIntegrationStatus(
    deps({ granted: { checks: "write", contents: "read" } }),
  );
  const pr = status.connections[0]!.permissions.find((p) => p.name === "pull_requests")!;
  assert.deepEqual(pr, {
    name: "pull_requests",
    required: "read",
    granted: null,
    ok: false,
    pendingInstallationIds: [],
  });
  const contents = status.connections[0]!.permissions.find((p) => p.name === "contents")!;
  assert.deepEqual(contents, {
    name: "contents",
    required: "write",
    granted: "read",
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
    { id: "delivery_verified", ok: false },
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
        requested: { ...REQUIRED_GRANTS, contents: "read" },
        installations: [{ granted: { ...REQUIRED_GRANTS, contents: "read" } }],
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
    { id: "delivery_verified", ok: false },
    { id: "repository_enrolled", ok: false },
    { id: "action_enabled", ok: false },
    { id: "baseline", ok: false },
  ]);
  assert.deepEqual(status.connections.map((item) => [item.connectionId, item.ready, item.missing]), [
    ["connection-a", false, ["webhook_secret", "delivery_verified"]],
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
  assert.deepEqual(status.connections[1]!.missing, ["events", "webhook_secret", "delivery_verified"]);
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
        { installationId: "88", granted: { ...REQUIRED_GRANTS, contents: "read" } },
      ],
    }],
  }));

  const pr = status.connections[0]!.permissions.find((p) => p.name === "contents")!;
  assert.deepEqual(pr, {
    name: "contents",
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

/**
 * A secret can be present and still wrong — pasted with a space, rotated on GitHub
 * only, or recorded against the wrong App id, which filters the connection out of
 * the candidate set and answers `401` for every delivery. "Configured" cannot mean
 * "working": only a delivery whose signature verified proves that, and a delivery
 * row exists **only** after a signature verifies.
 */
test("holds the checklist until a delivery has actually verified", async () => {
  const status = await buildGitHubIntegrationStatus(deps({ lastVerifiedDeliveryAt: null }));
  assert.equal(status.connections[0]!.webhookSecretConfigured, true);
  assert.equal(status.connections[0]!.lastVerifiedDeliveryAt, null);
  assert.deepEqual(status.checklist.slice(3), [
    { id: "webhook_secret", ok: true },
    { id: "delivery_verified", ok: false },
    { id: "repository_enrolled", ok: false },
    { id: "action_enabled", ok: false },
    { id: "baseline", ok: false },
  ]);
  assert.equal(status.readyConnectionId, null);
  assert.deepEqual(status.connections[0]!.missing, ["delivery_verified"]);
});

test("reports the moment each connection last proved its secret", async () => {
  const status = await buildGitHubIntegrationStatus(deps({
    connections: [
      { connectionId: "connection-a", lastVerifiedDeliveryAt: "2026-09-30T11:00:00.000Z" },
      { connectionId: "connection-b", lastVerifiedDeliveryAt: null },
    ],
    actions: [action({ connectionId: "connection-a" })],
  }));
  assert.deepEqual(
    status.connections.map((item) => [item.connectionId, item.lastVerifiedDeliveryAt]),
    [["connection-a", "2026-09-30T11:00:00.000Z"], ["connection-b", null]],
  );
  // The connection that has proved its secret is the one the checklist describes.
  assert.equal(status.readyConnectionId, "connection-a");
});

/**
 * An unreadable `GET /app/installations` is the one case where "no installations"
 * must not be believed: with `[]` the permission rows would fall back to what the
 * App *requests* and read green over a read that never happened.
 */
test("fails closed when the installation list cannot be read", async () => {
  const base = deps();
  const status = await buildGitHubIntegrationStatus({
    ...base,
    listInstallations: () => null,
  });
  const connection = status.connections[0]!;
  assert.equal(connection.installationsState, "unknown");
  assert.deepEqual(connection.installations, []);
  assert.equal(connection.ready, false);
  assert.ok(connection.missing.includes("app_installed"));
  assert.ok(connection.missing.includes("permissions"));
  assert.ok(connection.missing.includes("repository_enrolled"));
  assert.deepEqual(
    connection.permissions.filter((permission) => permission.ok).map((permission) => permission.name),
    [],
  );
  assert.deepEqual(
    connection.permissions.map((permission) => permission.granted).filter((value) => value !== null),
    [],
  );
  assert.deepEqual(status.checklist.filter((item) => item.ok), []);
  assert.equal(status.readyConnectionId, null);
});

test("an App installed nowhere is not the same as an unreadable list", async () => {
  const base = deps();
  const status = await buildGitHubIntegrationStatus({
    ...base,
    listInstallations: () => [],
  });
  const connection = status.connections[0]!;
  assert.equal(connection.installationsState, "none");
  assert.equal(connection.ready, false);
  assert.ok(connection.missing.includes("app_installed"));
});

/**
 * `X-GitHub-Hook-Installation-Target-ID` carries GitHub's numeric App id, and it
 * is what keeps a delivery at one HMAC. A column holding a slug or a client id
 * instead costs every delivery the capped loop over every connection, and a wrong
 * secret anywhere then looks like a wrong secret here — so the screen gets both
 * numbers rather than a verdict.
 */
test("reports GitHub's own App id next to the one the connection recorded", async () => {
  const status = await buildGitHubIntegrationStatus(deps({
    connections: [{ appId: "4242", recordedAppId: "okami-sentinel" }],
  }));
  assert.equal(status.connections[0]!.appId, "4242");
  assert.equal(status.connections[0]!.recordedAppId, "okami-sentinel");
  // Unreachable App metadata reports no id at all rather than echoing the column.
  const unreadable = await buildGitHubIntegrationStatus(deps({
    connections: [{ appId: null, recordedAppId: "4242", requested: null, subscribed: null }],
  }));
  assert.equal(unreadable.connections[0]!.appId, null);
  assert.equal(unreadable.connections[0]!.recordedAppId, "4242");
});

/**
 * The App exists and is installed nowhere — registered through the manifest and
 * never installed, or uninstalled by an org owner. `granted` may only ever come
 * from an installation, so with no installation nothing is granted. Reporting what
 * the App *requests* here told the operator the permission review was done while
 * the checklist said the App was not installed (I-1).
 */
test("an App installed nowhere grants nothing", async () => {
  const status = await buildGitHubIntegrationStatus({
    ...deps(),
    listInstallations: () => [],
  });
  const connection = status.connections[0]!;
  assert.equal(connection.installationsState, "none");
  assert.deepEqual(connection.permissions.filter((permission) => permission.ok), []);
  assert.deepEqual(
    connection.permissions.map((permission) => permission.granted).filter((value) => value !== null),
    [],
  );
  assert.deepEqual(connection.permissions[0]!.pendingInstallationIds, []);
  assert.equal(connection.ready, false);
  assert.deepEqual(status.checklist.filter((item) => item.ok), []);
});

/**
 * Suspension is one click in GitHub's UI and it refuses every installation token.
 * An integration that reads healthy through it is the screen lying at the exact
 * moment it is consulted (I-2).
 */
test("a suspended installation is neither installed nor granted", async () => {
  const status = await buildGitHubIntegrationStatus(deps({
    connections: [{ installations: [{ installationId: "77", suspended: true }] }],
  }));
  const connection = status.connections[0]!;
  assert.equal(connection.installationsState, "suspended");
  assert.equal(connection.ready, false);
  assert.ok(connection.missing.includes("app_installed"));
  assert.deepEqual(connection.permissions.filter((permission) => permission.ok), []);
  // The row survives so the screen can offer the un-suspend link.
  assert.equal(connection.installations.length, 1);
  assert.equal(connection.installations[0]!.suspended, true);
  assert.deepEqual(status.checklist.filter((item) => item.ok), []);
});

test("a suspended installation neither lends nor withholds another one's grants", async () => {
  const status = await buildGitHubIntegrationStatus(deps({
    connections: [{
      installations: [
        { installationId: "77" },
        // Suspended and approving nothing: it must not drag the live one down.
        { installationId: "78", suspended: true, granted: {} },
      ],
    }],
  }));
  const connection = status.connections[0]!;
  assert.equal(connection.installationsState, "active");
  assert.deepEqual(connection.permissions.filter((permission) => !permission.ok), []);
  assert.deepEqual(connection.permissions[0]!.pendingInstallationIds, []);
  assert.equal(connection.installations.length, 2);
  assert.equal(connection.installations[1]!.suspended, true);
});

test("a suspended installation does not enrol a repository", async () => {
  const status = await buildGitHubIntegrationStatus(deps({
    connections: [{
      installations: [{
        installationId: "77",
        suspended: true,
        repositories: [{ repositoryId: "9001", repositoryKey: "okamiops/sentinel" }],
      }],
    }],
  }));
  assert.ok(status.connections[0]!.missing.includes("repository_enrolled"));
});

/**
 * Ruling N-2: a quiet week is a warning, not a broken integration. The step stays
 * met, the connection stays `ready`, and the screen says "sem evento recente há N
 * dias" beside it. Turning the whole screen red because nobody opened a pull
 * request over a holiday teaches the operator to ignore the one signal that
 * matters.
 */
test("a stale verified delivery warns without unmeeting the step", async () => {
  const fresh = await buildGitHubIntegrationStatus(deps({
    lastVerifiedDeliveryAt: "2026-09-24T12:00:00.000Z",
  }));
  assert.equal(fresh.connections[0]!.deliveryVerifiedStale, false);
  assert.equal(fresh.connections[0]!.deliveryVerifiedAgeDays, 6);
  assert.equal(fresh.checklist.find((item) => item.id === "delivery_verified")?.ok, true);

  // Eight days before the frozen clock of 2026-09-30T12:00:00Z.
  const stale = await buildGitHubIntegrationStatus(deps({
    lastVerifiedDeliveryAt: "2026-09-22T11:59:59.000Z",
  }));
  assert.equal(stale.connections[0]!.lastVerifiedDeliveryAt, "2026-09-22T11:59:59.000Z");
  assert.equal(stale.connections[0]!.deliveryVerifiedStale, true);
  assert.equal(stale.connections[0]!.deliveryVerifiedAgeDays, 8);
  // The warning does not flip the step, the connection, or the integration.
  assert.equal(stale.checklist.find((item) => item.id === "delivery_verified")?.ok, true);
  assert.deepEqual(stale.connections[0]!.missing, []);
  assert.equal(stale.connections[0]!.ready, true);
  assert.equal(stale.readyConnectionId, "connection-1");

  // Never verified is not "stale": the screen says something different for it.
  const never = await buildGitHubIntegrationStatus(deps({ lastVerifiedDeliveryAt: null }));
  assert.equal(never.connections[0]!.deliveryVerifiedStale, false);
  assert.equal(never.connections[0]!.deliveryVerifiedAgeDays, null);
  assert.equal(never.connections[0]!.lastVerifiedDeliveryAt, null);
});

/**
 * The proof belongs to the value that was verified. Rotating the secret retires it:
 * every old delivery verified against something GitHub no longer signs with, and a
 * step that stayed green would vouch for a paste nobody has tested.
 */
test("rotating the webhook secret retires the verified delivery", async () => {
  const rotated = await buildGitHubIntegrationStatus(deps({
    lastVerifiedDeliveryAt: "2026-09-30T10:00:00.000Z",
    secretStoredAt: "2026-09-30T11:00:00.000Z",
  }));
  assert.equal(rotated.checklist.find((item) => item.id === "delivery_verified")?.ok, false);
  assert.deepEqual(rotated.connections[0]!.missing, ["delivery_verified"]);
  assert.equal(rotated.connections[0]!.ready, false);
  assert.equal(rotated.readyConnectionId, null);
  // Not "stale": it verified an hour ago. It verified the *previous* secret.
  assert.equal(rotated.connections[0]!.deliveryVerifiedStale, false);

  const proven = await buildGitHubIntegrationStatus(deps({
    lastVerifiedDeliveryAt: "2026-09-30T11:30:00.000Z",
    secretStoredAt: "2026-09-30T11:00:00.000Z",
  }));
  assert.equal(proven.connections[0]!.ready, true);

  // No rotation was ever recorded: the existing proof still stands.
  const legacy = await buildGitHubIntegrationStatus(deps({
    lastVerifiedDeliveryAt: "2026-09-30T10:00:00.000Z",
    secretStoredAt: null,
  }));
  assert.equal(legacy.connections[0]!.ready, true);
});

/**
 * An unfinished connection was never asked anything, so "installed nowhere" and
 * "GitHub did not answer" are both lies about it. The screen has one sentence for
 * this state and it is about finishing the connection.
 */
test("an unfinished connection reports not_ready rather than unknown", async () => {
  const status = await buildGitHubIntegrationStatus(deps({ connectionReady: false }));
  const connection = status.connections[0]!;
  assert.equal(connection.installationsState, "not_ready");
  assert.deepEqual(connection.installations, []);
  assert.equal(connection.ready, false);
  assert.ok(connection.missing.includes("app_installed"));
  assert.deepEqual(
    connection.permissions.map((permission) => permission.granted).filter((value) => value !== null),
    [],
  );
  assert.equal(status.readyConnectionId, null);
});
