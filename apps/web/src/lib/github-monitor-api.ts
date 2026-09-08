import type {
  GitHubMonitorActionsRun,
  GitHubMonitorEvent,
  GitHubMonitorOverview,
  GitHubMonitorRule,
} from "@csb/shared";

import { parseApiResponse } from "./http.js";
import {
  API_BASE,
  createSecuritySessionClient,
  securitySession,
  type Fetcher,
} from "./security-session.js";
import type { GitHubMonitorRuleInput } from "./github-monitor-state.js";

const BASE = API_BASE;

export interface GitHubCheckoutStatus {
  repositoryKey: string;
  writable: boolean;
  canFetch: boolean;
  canPull: boolean;
  branch: string | null;
  upstream: string | null;
  trackingRemote: string | null;
  head: string | null;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  remote: string | null;
  remotes: string[];
  reason: string | null;
  checkedAt: string;
}

export function createGitHubMonitorClient(fetcher?: Fetcher) {
  const rawFetch = fetcher ?? fetch;
  const csrf = fetcher ? createSecuritySessionClient(fetcher) : securitySession;
  const query = (params: Record<string, string | undefined>) => {
    const value = new URLSearchParams();
    for (const [key, item] of Object.entries(params)) if (item) value.set(key, item);
    return value.size ? `?${value}` : "";
  };
  const read = async <T>(path: string): Promise<T> => parseApiResponse<T>(await rawFetch(`${BASE}${path}`, {
    headers: { Accept: "application/json" },
  }));
  const write = async <T>(path: string, method: "POST" | "PATCH", body?: unknown): Promise<T> => parseApiResponse<T>(await csrf.request(`${BASE}${path}`, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

  return {
    overview: (repositoryKey?: string) => read<{ overview: GitHubMonitorOverview }>(`/github-monitor/overview${query({ repositoryKey })}`).then(({ overview }) => overview),
    rules: (repositoryKey?: string) => read<{ rules: GitHubMonitorRule[] }>(`/github-monitor/rules${query({ repositoryKey })}`).then(({ rules }) => rules),
    events: (ruleId?: string, repositoryKey?: string) => read<{ events: GitHubMonitorEvent[] }>(`/github-monitor/events${query({ ruleId, repositoryKey })}`).then(({ events }) => events),
    actionsRuns: (ruleId?: string, repositoryKey?: string) => read<{ actionsRuns: GitHubMonitorActionsRun[] }>(`/github-monitor/actions-runs${query({ ruleId, repositoryKey })}`).then(({ actionsRuns }) => actionsRuns),
    createRule: (body: GitHubMonitorRuleInput) => write<{ rule: GitHubMonitorRule }>("/github-monitor/rules", "POST", body).then(({ rule }) => rule),
    updateRule: (id: string, body: Partial<GitHubMonitorRuleInput>) => write<{ rule: GitHubMonitorRule }>(`/github-monitor/rules/${encodeURIComponent(id)}`, "PATCH", body).then(({ rule }) => rule),
    poll: () => write<{ overview: GitHubMonitorOverview }>("/github-monitor/poll", "POST").then(({ overview }) => overview),
    checkout: (repositoryKey: string) => read<{ checkout: GitHubCheckoutStatus }>(`/github-checkouts${query({ repositoryKey })}`).then(({ checkout }) => checkout),
    checkoutSync: (repositoryKey: string, action: "fetch" | "pull") => write<{ checkout: GitHubCheckoutStatus }>(`/github-checkouts/${encodeURIComponent(repositoryKey)}/${action}`, "POST", { remote: "origin" }).then(({ checkout }) => checkout),
  };
}

export const githubMonitorApi = createGitHubMonitorClient();
