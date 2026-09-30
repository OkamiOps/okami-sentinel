import type {
  GitHubAction,
  GitHubActionEvent,
  GitHubActionEventStatus,
  GitHubActionPatch,
  WebhookDeliveryRecord,
} from "@csb/shared";

import type { GitHubActionRequestBody } from "./github-action-form.js";
import { ApiError, parseApiResponse } from "./http.js";
import {
  API_BASE,
  createSecuritySessionClient,
  securitySession,
  type Fetcher,
} from "./security-session.js";

/**
 * The integration status as `GET /github/integration` returns it. Mirrored here
 * rather than imported from the API: the web bundle must not pull a server module
 * in, and the shape is the contract between the two.
 */
export interface GitHubIntegrationChecklistItem {
  id:
    | "app_installed"
    | "permissions"
    | "events"
    | "webhook_secret"
    | "delivery_verified"
    | "repository_enrolled"
    | "action_enabled"
    | "baseline";
  ok: boolean;
}

export type GitHubIntegrationMissingStep = Extract<
  GitHubIntegrationChecklistItem["id"],
  "app_installed" | "permissions" | "events" | "webhook_secret" | "delivery_verified" | "repository_enrolled"
>;

/**
 * Four ways the installation list can be useless and one way it can be useful.
 * They are separate states because they need separate sentences: `not_ready` is
 * "finish the connection", `unknown` is "we could not ask GitHub", `none` is "the
 * App is installed nowhere". Collapsing them sends the operator to the wrong page.
 */
export type GitHubInstallationsState = "not_ready" | "unknown" | "none" | "suspended" | "active";

export interface GitHubIntegrationConnection {
  connectionId: string;
  appSlug: string;
  appName: string;
  appId: string | null;
  recordedAppId: string | null;
  webhookSecretConfigured: boolean;
  lastVerifiedDeliveryAt: string | null;
  /** Verified, but longer than a week ago: an amber warning, never a failure. */
  deliveryVerifiedStale: boolean;
  deliveryVerifiedAgeDays: number | null;
  webhookUrl: string | null;
  ready: boolean;
  installationsState: GitHubInstallationsState;
  missing: GitHubIntegrationMissingStep[];
  permissions: Array<{
    name: string;
    required: string;
    granted: string | null;
    ok: boolean;
    pendingInstallationIds: string[];
  }>;
  events: Array<{ name: string; subscribed: boolean }>;
  installations: Array<{
    installationId: string;
    account: string;
    repositorySelection: "all" | "selected";
    suspended: boolean;
    authorizedRepositoryCount: number;
    enrolledRepositoryCount: number;
    manageUrl: string;
  }>;
}

export interface GitHubIntegrationStatus {
  connections: GitHubIntegrationConnection[];
  deliveries: {
    last: WebhookDeliveryRecord | null;
    last24h: { processed: number; ignored: number; failed: number };
  };
  reconciliation: { lastAt: string | null; recoveredLast24h: number };
  checklist: GitHubIntegrationChecklistItem[];
  readyConnectionId: string | null;
}

export interface GitHubReconcileResponse {
  repositories: number;
  created: number;
  observed: number;
  errors: number;
  /** The request attached to a cycle already running; the counts are that cycle's. */
  joined: boolean;
}

export interface GitHubEventsFilter {
  repositoryKey?: string | null;
  outcome?: GitHubActionEventStatus | null;
  limit?: number;
  offset?: number;
}

export interface GitHubActionsPage {
  actions: GitHubAction[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface GitHubEventsPage {
  events: GitHubActionEvent[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface GitHubDeliveriesPage {
  deliveries: WebhookDeliveryRecord[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function createGitHubActionsClient(fetcher?: Fetcher) {
  const rawFetch = fetcher ?? fetch;
  const csrf = fetcher ? createSecuritySessionClient(fetcher) : securitySession;

  const query = (params: Record<string, string | number | null | undefined>) => {
    const value = new URLSearchParams();
    for (const [key, item] of Object.entries(params)) {
      if (item === null || item === undefined || item === "") continue;
      value.set(key, String(item));
    }
    return value.size ? `?${value}` : "";
  };

  const read = async <T>(path: string): Promise<T> => parseApiResponse<T>(
    await rawFetch(`${API_BASE}${path}`, { headers: { Accept: "application/json" } }),
  );

  const write = async <T>(
    path: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    body?: unknown,
  ): Promise<T> => parseApiResponse<T>(await csrf.request(`${API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

  /**
   * `204` is a success with no body. Handing it to `parseApiResponse` would turn a
   * stored secret or a deleted action into `empty_api_response`.
   */
  const writeEmpty = async (
    path: string,
    method: "PUT" | "DELETE",
    body?: unknown,
  ): Promise<void> => {
    const response = await csrf.request(`${API_BASE}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.ok) return;
    const text = await response.text();
    let code: string | null = null;
    if (text) {
      try {
        code = (JSON.parse(text) as { error?: string }).error ?? null;
      } catch {
        code = null;
      }
    }
    throw new ApiError(code ?? `api_http_${response.status}`, "http", response.status);
  };

  return {
    /**
     * On demand only. Every read calls `GET /app` and `GET /app/installations` per
     * connection, so an interval would spend two GitHub calls per connection per
     * tick on a screen nobody is looking at.
     */
    fetchIntegration: () => read<GitHubIntegrationStatus>("/github/integration"),
    /** The value goes in and never comes back; the response is a bare 204. */
    saveWebhookSecret: (connectionId: string, secret: string) =>
      writeEmpty("/github/integration/webhook-secret", "PUT", { connectionId, secret }),
    fetchDeliveries: (limit = 50) =>
      read<GitHubDeliveriesPage>(`/github/deliveries${query({ limit })}`),
    reconcileNow: () => write<GitHubReconcileResponse>("/github/reconcile", "POST", {}),
    fetchActions: (repositoryKey?: string | null) =>
      read<GitHubActionsPage>(`/github/actions${query({ repositoryKey })}`),
    createAction: (body: GitHubActionRequestBody) =>
      write<{ action: GitHubAction }>("/github/actions", "POST", body).then(({ action }) => action),
    patchAction: (actionId: string, patch: GitHubActionPatch) =>
      write<{ action: GitHubAction }>(`/github/actions/${encodeURIComponent(actionId)}`, "PATCH", patch)
        .then(({ action }) => action),
    deleteAction: (actionId: string) =>
      writeEmpty(`/github/actions/${encodeURIComponent(actionId)}`, "DELETE"),
    fetchActionEvents: (actionId: string, limit = 50) =>
      read<GitHubEventsPage>(`/github/actions/${encodeURIComponent(actionId)}/events${query({ limit })}`),
    fetchEvents: (filter: GitHubEventsFilter = {}) =>
      read<GitHubEventsPage>(`/github/events${query({
        repositoryKey: filter.repositoryKey,
        outcome: filter.outcome,
        limit: filter.limit,
        offset: filter.offset,
      })}`),
    /**
     * The branch pickers of the Guardrails tab read this too, so it lives with the
     * rest of the GitHub API rather than in the removed poller's module.
     */
    fetchBranches: (repositoryKey: string) =>
      read<{ branches: string[] }>(`/github/branches${query({ repositoryKey })}`)
        .then(({ branches }) => branches),
  };
}

export const githubActionsApi = createGitHubActionsClient();
