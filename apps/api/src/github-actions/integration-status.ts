/**
 * Read-only view of the GitHub App integration for the Integração screen.
 *
 * This module sits next to `store.ts`, `schema.ts` and `migrate-monitor-rules.ts`
 * and **must not import any of them.** Every read is injected. Importing the
 * store here would put `ensureGitHubActionsSchema` — which renames
 * `github_monitor_rules` — on the boot path of whatever serves the status route,
 * which task 1.1 forbids until the legacy poller is removed in task 1.4.
 */
import type { GitHubAction, WebhookDeliveryRecord } from "@csb/shared";

import {
  GITHUB_APP_MANIFEST_EVENTS,
  GITHUB_APP_MANIFEST_PERMISSIONS,
  githubWebhookUrl,
} from "../github-app/manifest-flow.js";

const DELIVERY_WINDOW_MS = 24 * 60 * 60_000;

/** Ordered so a granted level can be compared against the required one. */
const PERMISSION_RANK: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, {
    read: 1,
    write: 2,
    admin: 3,
  }),
);

/** A level GitHub does not define never satisfies a requirement. */
function satisfies(granted: string | null, required: string): boolean {
  if (granted === null || !Object.hasOwn(PERMISSION_RANK, granted)) return false;
  return PERMISSION_RANK[granted]! >= (PERMISSION_RANK[required] ?? Number.POSITIVE_INFINITY);
}

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

/** The steps a single connection answers on its own. */
type GitHubConnectionChecklistItemId = Extract<
  GitHubChecklistItemId,
  "app_installed" | "permissions" | "events" | "webhook_secret" | "repository_enrolled"
>;

const CONNECTION_CHECKLIST_ORDER: readonly GitHubConnectionChecklistItemId[] = Object.freeze([
  "app_installed",
  "permissions",
  "events",
  "webhook_secret",
  "repository_enrolled",
]);

export interface GitHubIntegrationStatus {
  connections: Array<{
    connectionId: string;
    appSlug: string;
    appName: string;
    webhookSecretConfigured: boolean;
    webhookUrl: string | null;
    /** Every connection-level step this connection satisfies. */
    ready: boolean;
    /** The connection-level steps it does not, in checklist order. */
    missing: GitHubConnectionChecklistItemId[];
    permissions: Array<{
      name: string;
      required: string;
      /** The level every installation has approved, capped by what the App asks for. */
      granted: string | null;
      ok: boolean;
      /** Installations whose permission review has not been approved yet. */
      pendingInstallationIds: string[];
    }>;
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
  /** The connection the checklist speaks for; `null` when none is ready. */
  readyConnectionId: string | null;
}

/** App connection as the status screen needs it: metadata plus what the App asks for. */
export interface GitHubIntegrationConnectionState {
  connectionId: string;
  appSlug: string;
  appName: string;
  /**
   * What the App **requests**, from `GET /app.permissions` — not what any
   * installation has approved. An installation only ever holds a subset.
   * `null` when the App metadata is unreachable.
   */
  requestedPermissions: Readonly<Record<string, string>> | null;
  /** What the App subscribes to. `null` when the App metadata is unreachable. */
  subscribedEvents: readonly string[] | null;
}

export interface GitHubIntegrationInstallationState {
  installationId: string;
  account: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  /**
   * What this installation has **approved**, from
   * `GET /app/installations[].permissions`. Widening an App's permissions
   * queues a review per installation, and until it is approved this set still
   * holds the old levels. `null` when unknown, which reads as pending.
   */
  grantedPermissions: Readonly<Record<string, string>> | null;
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
  const webhookUrl = safeWebhookUrl(dependencies.publicOrigin);

  const connections: GitHubIntegrationStatus["connections"] = [];
  const connectionChecks = new Map<string, Record<GitHubConnectionChecklistItemId, boolean>>();

  for (const connection of await dependencies.listConnections()) {
    const events = requiredEvents(connection.subscribedEvents);
    const secretConfigured = await dependencies
      .readWebhookSecretConfigured(connection.connectionId);
    const installationStates = await dependencies.listInstallations(connection.connectionId);
    const permissions = requiredPermissions(connection.requestedPermissions, installationStates);
    const installations: GitHubIntegrationStatus["connections"][number]["installations"] = [];

    for (const installation of installationStates) {
      const repositories = await dependencies.listRepositories(installation.installationId);
      installations.push({
        installationId: installation.installationId,
        account: installation.account,
        repositorySelection: installation.repositorySelection,
        authorizedRepositoryCount: repositories.length,
        enrolledRepositoryCount: repositories
          .filter((repository) => repository.repositoryKey !== null).length,
        manageUrl: installationManageUrl(installation),
      });
    }

    // Every step is answered by this connection alone. Two half-configured
    // connections must never add up to one ready integration.
    const checks: Record<GitHubConnectionChecklistItemId, boolean> = {
      app_installed: installations.length > 0,
      permissions: permissions.every((permission) => permission.ok),
      events: events.every((event) => event.subscribed),
      webhook_secret: secretConfigured,
      repository_enrolled: installations.some((item) => item.enrolledRepositoryCount > 0),
    };
    connectionChecks.set(connection.connectionId, checks);
    const missing = CONNECTION_CHECKLIST_ORDER.filter((id) => !checks[id]);
    connections.push({
      connectionId: connection.connectionId,
      appSlug: connection.appSlug,
      appName: connection.appName,
      webhookSecretConfigured: secretConfigured,
      webhookUrl,
      ready: missing.length === 0,
      missing,
      permissions,
      events,
      installations,
    });
  }

  // The checklist speaks for the connection that got furthest, so the operator
  // reads one coherent setup story instead of a union of several.
  const leader = furthestConnection(connectionChecks);
  const actions = await dependencies.listActions();
  const enabledActions = actions.filter((candidate) =>
    candidate.enabled && candidate.connectionId === leader.connectionId);
  let baselineReady = false;
  const seenRepositories = new Set<string>();
  for (const enabled of enabledActions) {
    if (seenRepositories.has(enabled.repositoryKey)) continue;
    seenRepositories.add(enabled.repositoryKey);
    if (await dependencies.readBaselineState(enabled.repositoryKey) === "ready") {
      baselineReady = true;
    }
  }

  const [last, last24h, recoveredLast24h] = await Promise.all([
    dependencies.lastDelivery(),
    dependencies.countDeliveries(since),
    dependencies.countRecoveredEvents(since),
  ]);

  return {
    connections,
    deliveries: { last, last24h },
    reconciliation: {
      lastAt: mostRecent(actions.map((candidate) => candidate.lastReconciledAt)),
      recoveredLast24h,
    },
    checklist: checklist({
      ...leader.checks,
      action_enabled: enabledActions.length > 0,
      baseline: baselineReady,
    }),
    readyConnectionId: connections.find((item) => item.ready)?.connectionId ?? null,
  };
}

/**
 * The connection with the longest run of satisfied steps from the top. Ties go
 * to the first, so a stable listing gives a stable answer.
 */
function furthestConnection(
  checksByConnection: ReadonlyMap<string, Record<GitHubConnectionChecklistItemId, boolean>>,
): {
  connectionId: string | null;
  checks: Record<GitHubConnectionChecklistItemId, boolean>;
} {
  let best: { connectionId: string | null; checks: Record<GitHubConnectionChecklistItemId, boolean> } = {
    connectionId: null,
    checks: {
      app_installed: false,
      permissions: false,
      events: false,
      webhook_secret: false,
      repository_enrolled: false,
    },
  };
  let bestScore = -1;
  for (const [connectionId, checks] of checksByConnection) {
    const score = CONNECTION_CHECKLIST_ORDER.findIndex((id) => !checks[id]);
    const reached = score === -1 ? CONNECTION_CHECKLIST_ORDER.length : score;
    if (reached > bestScore) {
      bestScore = reached;
      best = { connectionId, checks };
    }
  }
  return best;
}

/** A misconfigured origin renders as "no URL", never as a 500 on this screen. */
function safeWebhookUrl(publicOrigin: string | null): string | null {
  if (publicOrigin === null) return null;
  try {
    return githubWebhookUrl(publicOrigin);
  } catch {
    return null;
  }
}

/**
 * `GET /app.permissions` is what the App *asks for*; an installation only holds
 * what it has *approved*. Widening an App queues a review per installation, so
 * a permission counts as granted only when every installation satisfies it, and
 * the ones that do not are named.
 */
function requiredPermissions(
  requested: Readonly<Record<string, string>> | null,
  installations: readonly GitHubIntegrationInstallationState[],
): GitHubIntegrationStatus["connections"][number]["permissions"] {
  return Object.entries(GITHUB_APP_MANIFEST_PERMISSIONS).map(([name, required]) => {
    const requestedLevel = requested?.[name] ?? null;
    const pendingInstallationIds: string[] = [];
    // An installation can never hold more than the App requests.
    let granted = requestedLevel;
    for (const installation of installations) {
      const level = installation.grantedPermissions?.[name] ?? null;
      if (!satisfies(level, required)) pendingInstallationIds.push(installation.installationId);
      if (level === null || !Object.hasOwn(PERMISSION_RANK, level)) granted = null;
      else if (granted !== null && PERMISSION_RANK[level]! < (PERMISSION_RANK[granted] ?? 0)) {
        granted = level;
      }
    }
    return {
      name,
      required,
      granted,
      ok: satisfies(granted, required) && pendingInstallationIds.length === 0,
      pendingInstallationIds,
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
