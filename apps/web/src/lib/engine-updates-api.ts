import type { EngineUpdateId, EngineUpdatesResponse } from "@csb/shared";

import { parseApiResponse } from "./http.js";

const BASE = "/api";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Keeps the update-session token only in the browser process. The update
 * endpoint is deliberately separate from the general API client so a future
 * updater cannot accidentally inherit broader write capabilities.
 */
export function createEngineUpdatesClient(fetcher: Fetcher = fetch): {
  list(): Promise<EngineUpdatesResponse>;
  check(): Promise<EngineUpdatesResponse>;
  update(id: EngineUpdateId, version: string): Promise<EngineUpdatesResponse>;
  rollback(id: EngineUpdateId): Promise<EngineUpdatesResponse>;
} {
  let csrfToken: Promise<string> | null = null;

  const getCsrfToken = () => {
    if (csrfToken === null) {
      const pending = fetcher(`${BASE}/engine-updates/security-session`, {
        headers: { Accept: "application/json" },
      })
        .then((response) => parseApiResponse<{ csrfToken: string }>(response))
        .then(({ csrfToken: token }) => token);
      csrfToken = pending;
      void pending.catch(() => {
        if (csrfToken === pending) csrfToken = null;
      });
    }
    return csrfToken;
  };

  const withCsrfRetry = async <T>(operation: (token: string) => Promise<T>): Promise<T> => {
    try {
      return await operation(await getCsrfToken());
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "csrf_invalid") throw error;
      csrfToken = null;
      return operation(await getCsrfToken());
    }
  };

  const read = async (): Promise<EngineUpdatesResponse> =>
    parseApiResponse<EngineUpdatesResponse>(await fetcher(`${BASE}/engine-updates`, {
      headers: { Accept: "application/json" },
    }));

  const write = (path: string, body: unknown): Promise<EngineUpdatesResponse> =>
    withCsrfRetry(async (token) => parseApiResponse<EngineUpdatesResponse>(await fetcher(`${BASE}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
      },
      body: JSON.stringify(body),
    })));

  return {
    list: read,
    check: () => write("/engine-updates/check", {}),
    update: (id, version) => write(`/engine-updates/${encodeURIComponent(id)}/update`, { version }),
    rollback: (id) => write(`/engine-updates/${encodeURIComponent(id)}/rollback`, {}),
  };
}

export const engineUpdatesApi = createEngineUpdatesClient();
