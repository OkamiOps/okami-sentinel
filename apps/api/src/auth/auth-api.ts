import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AuthSessionResponse, AuthSessionUser, UserSessionSummary } from "@csb/shared";
import type { ServerSettings } from "../deployment-settings.js";
import { SESSION_COOKIE } from "../server-security.js";
import { acceptInvite, changePassword, login, logout } from "./auth-service.js";
import { listUserGrants } from "./grant-store.js";
import { peekInvite } from "./invite-store.js";
import { csrfTokenOf, principalOf } from "./principal.js";
import { getSessionById, listUserSessions, revokeSession, revokeUserSessions } from "./session-store.js";
import { getUser, updateUser } from "./user-store.js";

/**
 * `secure` and `path: "/"` are what the `__Host-` prefix demands, and no
 * `domain` may be set; `maxAge` matches the session's own absolute lifetime so
 * the browser drops a cookie the server would refuse anyway.
 */
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 7 * 24 * 3600 } as const;

/**
 * The per-IP login limiter is only worth anything if the caller cannot choose
 * its own bucket. `X-Forwarded-For` is caller-supplied unless exactly one
 * trusted proxy terminates the connection, and even then only the entry that
 * proxy appended — the RIGHTMOST one — is its own observation.
 */
export function loginBucket(forwardedFor: string | undefined, peer: string | null, trustProxy: boolean): string | null {
  if (!trustProxy) return peer?.trim().slice(0, 64) || null;
  const appended = (forwardedFor ?? "").split(",").at(-1)?.trim() ?? "";
  return appended.slice(0, 64) || null;
}

/** `getConnInfo` needs the Node listener; `app.request` has no socket at all. */
function peerAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

function clientIp(c: Context, trustProxy: boolean): string | null {
  return loginBucket(c.req.header("X-Forwarded-For"), peerAddress(c), trustProxy);
}

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const text = (value: unknown, max = 256): string => (typeof value === "string" ? value.slice(0, max) : "");
// Above the 256-character policy ceiling, so an oversized password is rejected
// as `password_too_long` instead of being silently truncated into a valid one.
const password = (value: unknown): string => text(value, 512);

export function createAuthApi(deps: { settings: ServerSettings; now?: () => Date }): Hono {
  const api = new Hono();
  const server = deps.settings.mode === "server";
  const clock = (): Date => deps.now?.() ?? new Date();

  api.post("/auth/login", async (c) => {
    const input = await body(c);
    const result = await login({
      username: text(input.username, 64),
      password: password(input.password),
      ip: clientIp(c, deps.settings.trustProxy),
      userAgent: c.req.header("User-Agent") ?? null,
      now: clock(),
    });
    if (result.ok) {
      // A fresh token on every login, so a pre-seeded cookie can never be
      // promoted into an authenticated session.
      setCookie(c, SESSION_COOKIE, result.token, COOKIE_OPTIONS);
      return c.json({ ok: true });
    }
    if (result.error === "account_locked") return c.json({ error: result.error, retryAfterSeconds: result.retryAfterSeconds }, 423);
    if (result.error === "rate_limited") {
      c.header("Retry-After", String(result.retryAfterSeconds));
      return c.json({ error: result.error, retryAfterSeconds: result.retryAfterSeconds }, 429);
    }
    return c.json({ error: "invalid_credentials" }, 401);
  });

  api.post("/auth/logout", (c) => {
    const principal = principalOf(c);
    if (principal.sessionId) logout(principal.sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.body(null, 204);
  });

  api.get("/auth/session", (c) => {
    const principal = principalOf(c);
    const response: AuthSessionResponse = {
      user: {
        id: principal.userId ?? "local",
        username: principal.username,
        displayName: principal.displayName,
        isAdmin: principal.isAdmin,
      },
      grants: principal.userId ? listUserGrants(principal.userId) : [],
      csrfToken: csrfTokenOf(c),
      runtimeMode: deps.settings.mode,
      repositoryRoots: deps.settings.repositoryRoots,
    };
    return c.json(response);
  });

  api.get("/auth/invites/:token", (c) => {
    const invite = peekInvite(c.req.param("token"), clock());
    const user = invite ? getUser(invite.userId) : null;
    if (!invite || !user) return c.json({ error: "invite_invalid" }, 404);
    const invitedBy = invite.createdBy ? getUser(invite.createdBy)?.displayName ?? null : null;
    return c.json({
      username: user.username,
      displayName: user.displayName,
      purpose: invite.purpose,
      invitedBy,
      expiresAt: invite.expiresAt,
    });
  });

  api.post("/auth/invites/:token", async (c) => {
    const input = await body(c);
    const result = await acceptInvite({
      token: c.req.param("token"),
      password: password(input.password),
      ip: clientIp(c, deps.settings.trustProxy),
      userAgent: c.req.header("User-Agent") ?? null,
      now: clock(),
    });
    if (!result.ok) return c.json({ error: result.error }, result.error === "invite_invalid" ? 404 : 400);
    setCookie(c, SESSION_COOKIE, result.token, COOKIE_OPTIONS);
    return c.json({ ok: true });
  });

  api.patch("/account/profile", async (c) => {
    const principal = principalOf(c);
    if (!server || !principal.userId) return c.json({ error: "not_found" }, 404);
    const displayName = text((await body(c)).displayName, 120).trim();
    if (!displayName) return c.json({ error: "display_name_invalid" }, 400);
    const user = updateUser(principal.userId, { displayName });
    const response: AuthSessionUser = {
      id: user.id, username: user.username, displayName: user.displayName, isAdmin: user.isAdmin,
    };
    return c.json(response);
  });

  api.post("/account/password", async (c) => {
    const principal = principalOf(c);
    if (!server || !principal.userId || !principal.sessionId) return c.json({ error: "not_found" }, 404);
    const input = await body(c);
    const result = await changePassword({
      userId: principal.userId,
      sessionId: principal.sessionId,
      currentPassword: password(input.currentPassword),
      newPassword: password(input.newPassword),
    });
    return result.ok ? c.body(null, 204) : c.json({ error: result.error }, 400);
  });

  api.get("/account/sessions", (c) => {
    const principal = principalOf(c);
    if (!server || !principal.userId) return c.json({ error: "not_found" }, 404);
    const sessions: UserSessionSummary[] = listUserSessions(principal.userId, clock()).map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      ip: session.ip,
      userAgent: session.userAgent,
      current: session.id === principal.sessionId,
    }));
    return c.json({ sessions });
  });

  api.delete("/account/sessions/others", (c) => {
    const principal = principalOf(c);
    if (!server || !principal.userId) return c.json({ error: "not_found" }, 404);
    revokeUserSessions(principal.userId, principal.sessionId);
    return c.body(null, 204);
  });

  api.delete("/account/sessions/:id", (c) => {
    const principal = principalOf(c);
    const session = getSessionById(c.req.param("id"), clock());
    // Someone else's session id is indistinguishable from an unknown one.
    if (!server || !principal.userId || !session || session.userId !== principal.userId) {
      return c.json({ error: "not_found" }, 404);
    }
    revokeSession(session.id);
    return c.body(null, 204);
  });

  return api;
}
