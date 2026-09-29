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

// Deliberately opt-in: only a same-origin, relative Sentinel API path (a
// plain string starting with API_BASE) counts. Provider endpoints and any
// other absolute or non-string request are never treated as ours, so they
// keep their original headers/credentials and can never trigger our own
// CSRF attachment or session-loss handling below.
function isSentinelApiRequest(input: RequestInfo | URL): boolean {
  return typeof input === "string" && (input === API_BASE || input.startsWith(`${API_BASE}/`));
}

function isApiMutation(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(method)) return false;
  return isSentinelApiRequest(input);
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

const AUTH_PATH_PREFIX = `${API_BASE}/auth/`;

function isUnderAuthPath(input: RequestInfo | URL): boolean {
  return typeof input === "string" && input.startsWith(AUTH_PATH_PREFIX);
}

/**
 * Signals every consumer (the auth provider, in particular) that the browser
 * no longer holds a valid session, without importing React state here. A 401
 * from `/api/auth/*` itself is an expected sign-in/sign-out response, not a
 * session loss, so it is excluded. A 401 from anywhere that isn't our own API
 * (an external provider endpoint, in particular) must never sign Sentinel's
 * user out either.
 */
function notifyUnauthorized(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event("sentinel:unauthorized"));
  }
}

export function createSecuritySessionClient(fetcher: Fetcher = fetch) {
  let current: Promise<SecuritySession> | null = null;

  const get = () => {
    if (current === null) {
      const pending = fetcher(`${API_BASE}/auth/session`, {
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
    const respond = async (response: Response): Promise<Response> => {
      if (response.status === 401 && isSentinelApiRequest(input) && !isUnderAuthPath(input)) {
        clear();
        notifyUnauthorized();
      }
      return response;
    };

    if (!isApiMutation(input, init)) return respond(await fetcher(input, init));

    const attempt = async () => {
      const session = await get();
      const headers = new Headers(init?.headers);
      headers.set("X-CSRF-Token", session.csrfToken);
      return fetcher(input, { ...init, headers });
    };

    const response = await attempt();
    if (!await isInvalidCsrfResponse(response)) return respond(response);

    clear();
    return respond(await attempt());
  };

  return { get, clear, request };
}

/** Browser-wide API session. It remains in memory and is never persisted. */
export const securitySession = createSecuritySessionClient();

export const apiFetch = securitySession.request;
