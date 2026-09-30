import type { GitHubAction, WebhookDeliveryRecord } from "@csb/shared";

import {
  GITHUB_APP_MANIFEST_EVENTS,
  GITHUB_APP_MANIFEST_PERMISSIONS,
  githubWebhookUrl,
} from "../github-app/manifest-flow.js";

const DELIVERY_WINDOW_MS = 24 * 60 * 60_000;

/** Ordered so a granted level can be compared against the required one. */
const PERMISSION_RANK: Readonly<Record<string, number>> = Object.freeze({
  read: 1,
  write: 2,
  admin: 3,
});

export type GitHubBaselineReadiness = "absent" | "building" | "ready" | "stale";

export type GitHubChecklistItemId =
  | "app_installed"
  | "permissions"
  | "events"
  | "webhook_secret"
  | "repository_enrolled"
  | "action_enabled"
  | "baseline";

const CHECKLIST_ORDER: readonly GitHubChecklistItemId[] = Object.freeze([
  "app_installed",
  "permissions",
  "events",
  "webhook_secret",
  "repository_enrolled",
  "action_enabled",
  "baseline",
]);

export interface GitHubIntegrationStatus {
  connections: Array<{
    connectionId: string;
    appSlug: string;
    appName: string;
    webhookSecretConfigured: boolean;
    webhookUrl: string | null;
    permissions: Array<{ name: string; required: string; granted: string | null; ok: boolean }>;
    events: Array<{ name: string; subscribed: boolean }>;
    installations: Array<{
      installationId: string;
      account: string;
      repositorySelection: "all" | "selected";
      authorizedRepositoryCount: number;
      enrolledRepositoryCount: number;
      manageUrl: string;
    }>;
  }>;
  deliveries: {
    last: WebhookDeliveryRecord | null;
    last24h: { processed: number; ignored: number; failed: number };
  };
  reconciliation: { lastAt: string | null; recoveredLast24h: number };
  checklist: Array<{ id: GitHubChecklistItemId; ok: boolean }>;
}

/** App connection as the status screen needs it: metadata plus what GitHub granted. */
export interface GitHubIntegrationConnectionState {
  connectionId: string;
  appSlug: string;
  appName: string;
  /** What GitHub reports the App holds. `null` when the App metadata is unreachable. */
  grantedPermissions: Readonly<Record<string, string>> | null;
  /** What the App subscribes to. `null` when the App metadata is unreachable. */
  subscribedEvents: readonly string[] | null;
}

export interface GitHubIntegrationInstallationState {
  installationId: string;
  account: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
}

export interface GitHubIntegrationRepositoryState {
  repositoryId: string;
  /** The guardrails key when this authorized repository is enrolled; `null` otherwise. */
  repositoryKey: string | null;
}

type Awaitable<T> = Promise<T> | T;

/**
 * Everything injected, so the status is a pure function of what the caller
 * already read. The webhook secret enters as a boolean and never as a value:
 * the status cannot leak what it never receives.
 */
export interface GitHubIntegrationStatusDependencies {
  listConnections: () => Awaitable<readonly GitHubIntegrationConnectionState[]>;
  listInstallations: (
    connectionId: string,
  ) => Awaitable<readonly GitHubIntegrationInstallationState[]>;
  listRepositories: (
    installationId: string,
  ) => Awaitable<readonly GitHubIntegrationRepositoryState[]>;
  listActions: () => Awaitable<readonly GitHubAction[]>;
  readBaselineState: (repositoryKey: string) => Awaitable<GitHubBaselineReadiness>;
  readWebhookSecretConfigured: (connectionId: string) => Awaitable<boolean>;
  countDeliveries: (
    sinceIsoTimestamp: string,
  ) => Awaitable<{ processed: number; ignored: number; failed: number }>;
  /** Events the 15-minute reconciliation recovered since the given instant. */
  countRecoveredEvents: (sinceIsoTimestamp: string) => Awaitable<number>;
  lastDelivery: () => Awaitable<WebhookDeliveryRecord | null>;
  /** Public origin of the deployment; `null` in the loopback desktop profile. */
  publicOrigin: string | null;
  now?: () => Date;
}

export async function buildGitHubIntegrationStatus(
  dependencies: GitHubIntegrationStatusDependencies,
): Promise<GitHubIntegrationStatus> {
  const now = (dependencies.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - DELIVERY_WINDOW_MS).toISOString();
  const webhookUrl = dependencies.publicOrigin === null
    ? null
    : githubWebhookUrl(dependencies.publicOrigin);

  const connections: GitHubIntegrationStatus["connections"] = [];
  let anyInstallation = false;
  let anyEnrolled = false;
  let allPermissionsGranted = false;
  let allEventsSubscribed = false;
  let anySecretConfigured = false;

  for (const connection of await dependencies.listConnections()) {
    const permissions = requiredPermissions(connection.grantedPermissions);
    const events = requiredEvents(connection.subscribedEvents);
    const secretConfigured = await dependencies
      .readWebhookSecretConfigured(connection.connectionId);
    const installations: GitHubIntegrationStatus["connections"][number]["installations"] = [];

    for (const installation of await dependencies.listInstallations(connection.connectionId)) {
      const repositories = await dependencies.listRepositories(installation.installationId);
      const enrolled = repositories.filter((repository) => repository.repositoryKey !== null).length;
      anyInstallation = true;
      anyEnrolled ||= enrolled > 0;
      installations.push({
        installationId: installation.installationId,
        account: installation.account,
        repositorySelection: installation.repositorySelection,
        authorizedRepositoryCount: repositories.length,
        enrolledRepositoryCount: enrolled,
        manageUrl: installationManageUrl(installation),
      });
    }

    allPermissionsGranted ||= permissions.every((permission) => permission.ok);
    allEventsSubscribed ||= events.every((event) => event.subscribed);
    anySecretConfigured ||= secretConfigured;
    connections.push({
      connectionId: connection.connectionId,
      appSlug: connection.appSlug,
      appName: connection.appName,
      webhookSecretConfigured: secretConfigured,
      webhookUrl,
      permissions,
      events,
      installations,
    });
  }

  const actions = await dependencies.listActions();
  const enabledActions = actions.filter((candidate) => candidate.enabled);
  let baselineReady = false;
  const seenRepositories = new Set<string>();
  for (const enabled of enabledActions) {
    if (seenRepositories.has(enabled.repositoryKey)) continue;
    seenRepositories.add(enabled.repositoryKey);
    if (await dependencies.readBaselineState(enabled.repositoryKey) === "ready") {
      baselineReady = true;
    }
  }

  return {
    connections,
    deliveries: {
      last: await dependencies.lastDelivery(),
      last24h: await dependencies.countDeliveries(since),
    },
    reconciliation: {
      lastAt: mostRecent(actions.map((candidate) => candidate.lastReconciledAt)),
      recoveredLast24h: await dependencies.countRecoveredEvents(since),
    },
    checklist: checklist({
      app_installed: anyInstallation,
      permissions: allPermissionsGranted,
      events: allEventsSubscribed,
      webhook_secret: anySecretConfigured,
      repository_enrolled: anyEnrolled,
      action_enabled: enabledActions.length > 0,
      baseline: baselineReady,
    }),
  };
}

function requiredPermissions(
  granted: Readonly<Record<string, string>> | null,
): GitHubIntegrationStatus["connections"][number]["permissions"] {
  return Object.entries(GITHUB_APP_MANIFEST_PERMISSIONS).map(([name, required]) => {
    const value = granted?.[name] ?? null;
    return {
      name,
      required,
      granted: value,
      ok: value !== null && (PERMISSION_RANK[value] ?? 0) >= (PERMISSION_RANK[required] ?? 0),
    };
  });
}

function requiredEvents(
  subscribed: readonly string[] | null,
): GitHubIntegrationStatus["connections"][number]["events"] {
  const active = new Set(subscribed ?? []);
  return GITHUB_APP_MANIFEST_EVENTS.map((name) => ({ name, subscribed: active.has(name) }));
}

/**
 * The page that widens an installation's repository selection — the literal
 * cause of "the tab is stuck on one repository".
 */
function installationManageUrl(installation: GitHubIntegrationInstallationState): string {
  const id = encodeURIComponent(installation.installationId);
  return installation.accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(installation.account)}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}

/** Setup is sequential, so every step after the first unmet one reads as unmet. */
function checklist(
  met: Record<GitHubChecklistItemId, boolean>,
): GitHubIntegrationStatus["checklist"] {
  let blocked = false;
  return CHECKLIST_ORDER.map((id) => {
    blocked ||= !met[id];
    return { id, ok: !blocked };
  });
}

function mostRecent(values: readonly (string | null)[]): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (latest === null || Date.parse(value) > Date.parse(latest)) latest = value;
  }
  return latest;
}
