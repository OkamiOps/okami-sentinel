import type {
  AuthSessionResponse,
  AuthSessionUser,
  InviteLinkResponse,
  RepositoryAccessEntry,
  RepositoryGrant,
  RepositoryRole,
  UserLocale,
  UserSessionSummary,
  UserSummary,
} from "@csb/shared";
import { authedRequest, authedVoidRequest, jsonHeaders } from "./api-request.js";
import { ApiError, parseApiResponse } from "./http.js";
import { API_BASE } from "./security-session.js";

export interface InvitePreview {
  username: string;
  displayName: string;
  purpose: "invite" | "reset";
  invitedBy: string | null;
  expiresAt: string;
}

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

/**
 * The public auth mutations raise `AuthRequestError`; the authenticated ones
 * go through `parseApiResponse` and raise `ApiError`, which keeps the server's
 * code as its message unless it had to invent a generic HTTP one. Callers that
 * want to answer a named rejection ("wrong current password") should not have
 * to know which of the two they caught.
 */
export function authErrorCode(error: unknown): string | null {
  if (error instanceof AuthRequestError) return error.code;
  if (error instanceof ApiError && error.kind === "http" && !error.hasGenericHttpMessage) return error.message;
  return null;
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

  /**
   * The language the interface is in is also the language this account's
   * e-mails are written in, so switching it has to reach the server. A
   * locale-only body is a valid patch: it never touches the display name.
   */
  updateLocale(locale: UserLocale): Promise<AuthSessionUser> {
    return authedRequest<AuthSessionUser>("/account/profile", {
      method: "PATCH",
      body: JSON.stringify({ locale }),
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

export interface CreateUserInput {
  username: string;
  displayName: string;
  email: string | null;
  isAdmin: boolean;
  grants: RepositoryGrant[];
}

/**
 * Administration of other people's accounts. Every path segment is encoded
 * once — the API decodes once — so a repository key such as `github:1` or a
 * local path survives the round trip intact.
 */
export const usersApi = {
  async list(): Promise<UserSummary[]> {
    return (await authedRequest<{ users: UserSummary[] }>("/users")).users;
  },

  create(input: CreateUserInput): Promise<{ user: UserSummary; invite: InviteLinkResponse }> {
    return authedRequest<{ user: UserSummary; invite: InviteLinkResponse }>("/users", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  update(id: string, patch: Partial<Pick<UserSummary, "displayName" | "email" | "isAdmin" | "status">>): Promise<UserSummary> {
    return authedRequest<UserSummary>(`/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },

  reset(id: string): Promise<InviteLinkResponse> {
    return authedRequest<InviteLinkResponse>(`/users/${encodeURIComponent(id)}/reset`, { method: "POST" });
  },

  async revokeSessions(id: string): Promise<void> {
    await authedVoidRequest(`/users/${encodeURIComponent(id)}/sessions`, { method: "DELETE" });
  },

  async sessions(id: string): Promise<UserSessionSummary[]> {
    return (await authedRequest<{ sessions: UserSessionSummary[] }>(`/users/${encodeURIComponent(id)}/sessions`)).sessions;
  },

  async grants(id: string): Promise<RepositoryGrant[]> {
    return (await authedRequest<{ grants: RepositoryGrant[] }>(`/users/${encodeURIComponent(id)}/grants`)).grants;
  },

  async replaceGrants(id: string, grants: RepositoryGrant[]): Promise<RepositoryGrant[]> {
    const body = await authedRequest<{ grants: RepositoryGrant[] }>(`/users/${encodeURIComponent(id)}/grants`, {
      method: "PUT",
      body: JSON.stringify({ grants }),
    });
    return body.grants;
  },

  async repositoryAccess(): Promise<RepositoryAccessEntry[]> {
    return (await authedRequest<{ repositories: RepositoryAccessEntry[] }>("/repository-access")).repositories;
  },

  async setRepositoryRole(repositoryKey: string, userId: string, role: RepositoryRole | null): Promise<void> {
    await authedVoidRequest(
      `/repository-access/${encodeURIComponent(repositoryKey)}/users/${encodeURIComponent(userId)}`,
      { method: "PUT", body: JSON.stringify({ role }) },
    );
  },
};
