import type { EngineUpdateId, EngineUpdatesResponse } from "@csb/shared";

import { parseApiResponse } from "./http.js";
import {
  API_BASE,
  createSecuritySessionClient,
  securitySession,
  type Fetcher,
} from "./security-session.js";

const BASE = API_BASE;

/**
 * Updater writes share the browser-wide CSRF session with the API client.
 * The helper remains scoped to relative API routes, so provider endpoints
 * cannot inherit Sentinel credentials.
 */
export function createEngineUpdatesClient(fetcher?: Fetcher): {
  list(): Promise<EngineUpdatesResponse>;
  check(): Promise<EngineUpdatesResponse>;
  update(id: EngineUpdateId, version: string): Promise<EngineUpdatesResponse>;
  rollback(id: EngineUpdateId): Promise<EngineUpdatesResponse>;
} {
  const rawFetch = fetcher ?? fetch;
  const csrf = fetcher ? createSecuritySessionClient(fetcher) : securitySession;

  const read = async (): Promise<EngineUpdatesResponse> =>
    parseApiResponse<EngineUpdatesResponse>(await rawFetch(`${BASE}/engine-updates`, {
      headers: { Accept: "application/json" },
    }));

  const write = async (path: string, body: unknown): Promise<EngineUpdatesResponse> =>
    parseApiResponse<EngineUpdatesResponse>(await csrf.request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }));

  return {
    list: read,
    check: () => write("/engine-updates/check", {}),
    update: (id, version) => write(`/engine-updates/${encodeURIComponent(id)}/update`, { version }),
    rollback: (id) => write(`/engine-updates/${encodeURIComponent(id)}/rollback`, {}),
  };
}

export const engineUpdatesApi = createEngineUpdatesClient();
