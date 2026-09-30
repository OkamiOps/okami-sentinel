import { parseApiResponse } from "./http.js";
import { API_BASE, apiFetch } from "./security-session.js";

/**
 * The authenticated JSON request shape every account-scoped client shares: the
 * CSRF-attaching fetch, the two JSON headers and `parseApiResponse`, which
 * keeps the server's error code as the raised message. Extracted so the auth,
 * users, e-mail and notification clients cannot drift on any of the three.
 */
const jsonHeaders = { "Content-Type": "application/json", Accept: "application/json" };

export async function authedRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...jsonHeaders, ...(init?.headers ?? {}) },
  });
  return parseApiResponse<T>(response);
}

export async function authedVoidRequest(path: string, init?: RequestInit): Promise<void> {
  const response = await apiFetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...jsonHeaders, ...(init?.headers ?? {}) },
  });
  if (response.status === 204) return;
  await parseApiResponse<unknown>(response);
}

export { jsonHeaders };
