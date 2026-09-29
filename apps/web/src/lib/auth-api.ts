import type { AuthSessionResponse, AuthSessionUser, UserSessionSummary } from "@csb/shared";
import { parseApiResponse } from "./http.js";
import { API_BASE, apiFetch } from "./security-session.js";

export interface InvitePreview {
  username: string;
  displayName: string;
  purpose: "invite" | "reset";
  invitedBy: string | null;
  expiresAt: string;
}

const jsonHeaders = { "Content-Type": "application/json", Accept: "application/json" };

/**
 * `parseApiResponse` collapses an error body into a translated message, which
 * loses the two fields the sign-in screen needs to render a lockout: the
 * machine-readable code and how long the caller must wait. The public auth
 * mutations therefore parse their own failures and keep both.
 */
export class AuthRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(code: string, status: number, retryAfterSeconds: number | null) {
    super(code);
    this.name = "AuthRequestError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function positiveSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

/** A `Retry-After` header in delta-seconds form is the HTTP-native fallback. */
function retryAfterHeader(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  return header === null ? null : positiveSeconds(Number(header));
}

async function publicMutation(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  if (response.ok) return;
  let parsed: { error?: unknown; retryAfterSeconds?: unknown } | null = null;
  try {
    parsed = await response.json() as { error?: unknown; retryAfterSeconds?: unknown };
  } catch {
    parsed = null;
  }
  throw new AuthRequestError(
    typeof parsed?.error === "string" ? parsed.error : `api_http_${response.status}`,
    response.status,
    positiveSeconds(parsed?.retryAfterSeconds) ?? retryAfterHeader(response),
  );
}

/**
 * `/auth/login` and `/auth/invites/:token` are reachable before a session (and
 * therefore a CSRF token) exists, so they bypass the CSRF-attaching mutation
 * path entirely and rely on the server's same-origin check instead.
 */
async function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...jsonHeaders, ...(init?.headers ?? {}) },
  });
  return parseApiResponse<T>(response);
}

async function authedRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...jsonHeaders, ...(init?.headers ?? {}) },
  });
  return parseApiResponse<T>(response);
}

async function authedVoidRequest(path: string, init?: RequestInit): Promise<void> {
  const response = await apiFetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...jsonHeaders, ...(init?.headers ?? {}) },
  });
  if (response.status === 204) return;
  await parseApiResponse<unknown>(response);
}

export const authApi = {
  session(): Promise<AuthSessionResponse> {
    return authedRequest<AuthSessionResponse>("/auth/session");
  },

  async login(username: string, password: string): Promise<void> {
    await publicMutation("/auth/login", { username, password });
  },

  async logout(): Promise<void> {
    await authedVoidRequest("/auth/logout", { method: "POST" });
  },

  invite(token: string): Promise<InvitePreview> {
    return publicRequest<InvitePreview>(`/auth/invites/${encodeURIComponent(token)}`);
  },

  async acceptInvite(token: string, password: string): Promise<void> {
    await publicMutation(`/auth/invites/${encodeURIComponent(token)}`, { password });
  },

  updateProfile(displayName: string): Promise<AuthSessionUser> {
    return authedRequest<AuthSessionUser>("/account/profile", {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    });
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await authedVoidRequest("/account/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  async sessions(): Promise<UserSessionSummary[]> {
    return (await authedRequest<{ sessions: UserSessionSummary[] }>("/account/sessions")).sessions;
  },

  async revokeSession(id: string): Promise<void> {
    await authedVoidRequest(`/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async revokeOtherSessions(): Promise<void> {
    await authedVoidRequest("/account/sessions/others", { method: "DELETE" });
  },
};
