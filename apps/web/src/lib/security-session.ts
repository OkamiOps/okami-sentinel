import { parseApiResponse } from "./http.js";

export const API_BASE = "/api";

export type RuntimeMode = "local" | "server";

export interface SecuritySession {
  csrfToken: string;
  runtimeMode: RuntimeMode;
  repositoryRoots: string[];
}

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Mirrors the server-root boundary for a UI default only; the API remains authoritative. */
export function isUnderRepositoryRoot(candidate: string, roots: readonly string[]): boolean {
  const requested = candidate.trim();
  return roots.some((root) => {
    const normalized = root.length > 1 ? root.replace(/\/+$/, "") : root;
    return normalized === "/" || requested === normalized || requested.startsWith(`${normalized}/`);
  });
}

function isApiMutation(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(method)) return false;

  // The helper is deliberately opt-in and accepts only same-origin, relative
  // API paths. Provider endpoints and any other absolute request retain their
  // original headers and credentials.
  return typeof input === "string" && (input === API_BASE || input.startsWith(`${API_BASE}/`));
}

async function isInvalidCsrfResponse(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const body = await response.clone().json() as { error?: unknown };
    return body.error === "csrf_invalid";
  } catch {
    return false;
  }
}

export function createSecuritySessionClient(fetcher: Fetcher = fetch) {
  let current: Promise<SecuritySession> | null = null;

  const get = () => {
    if (current === null) {
      const pending = fetcher(`${API_BASE}/security-session`, {
        headers: { Accept: "application/json" },
      }).then((response) => parseApiResponse<SecuritySession>(response));
      current = pending;
      void pending.catch(() => {
        if (current === pending) current = null;
      });
    }
    return current;
  };

  const clear = () => { current = null; };

  const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isApiMutation(input, init)) return fetcher(input, init);

    const attempt = async () => {
      const session = await get();
      const headers = new Headers(init?.headers);
      headers.set("X-CSRF-Token", session.csrfToken);
      return fetcher(input, { ...init, headers });
    };

    const response = await attempt();
    if (!await isInvalidCsrfResponse(response)) return response;

    clear();
    return attempt();
  };

  return { get, clear, request };
}

/** Browser-wide API session. It remains in memory and is never persisted. */
export const securitySession = createSecuritySessionClient();

export const apiFetch = securitySession.request;
