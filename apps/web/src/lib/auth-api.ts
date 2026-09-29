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
    await publicRequest<{ ok: true }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },

  async logout(): Promise<void> {
    await authedVoidRequest("/auth/logout", { method: "POST" });
  },

  invite(token: string): Promise<InvitePreview> {
    return publicRequest<InvitePreview>(`/auth/invites/${encodeURIComponent(token)}`);
  },

  async acceptInvite(token: string, password: string): Promise<void> {
    await publicRequest<{ ok: true }>(`/auth/invites/${encodeURIComponent(token)}`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
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
