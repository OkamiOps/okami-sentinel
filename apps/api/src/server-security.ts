import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { principalForSession } from "./auth/auth-service.js";
import { resolveSession } from "./auth/session-store.js";
import type { ServerSettings } from "./deployment-settings.js";
import { validSecurityToken } from "./security-session.js";
import { sessionCookieName } from "./session-cookie.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOCAL_FRONTEND_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

/**
 * Reachable before a session exists: the login form posts here, and an invited
 * user follows a mailed link to set their first password. Everything else under
 * `/api/` needs a session, including `/api/auth/session` itself.
 */
const PUBLIC_API = [/^\/api\/auth\/login$/, /^\/api\/auth\/invites\/[A-Za-z0-9_-]{43}$/];

export function serverSecurity(settings: ServerSettings): MiddlewareHandler {
  return async (c, next) => {
    if (settings.mode === "local") return localRequestSecurity(c, next);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
    if ((c.req.path === "/healthz" || c.req.path === "/readyz") && ["GET", "HEAD"].includes(c.req.method)) return next();
    if (new URL(c.req.url).host !== new URL(settings.origin!).host) return c.json({ error: "origin_denied" }, 403);
    // The SPA shell and its assets carry no data of their own; /login has to
    // render for a visitor who does not hold a session yet.
    if (!c.req.path.startsWith("/api/")) return next();
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    const origin = c.req.header("Origin");
    const callback = c.req.method === "GET" && c.req.path === "/api/guardrails/github-app/manifest/callback";
    if (!callback && ((origin && origin !== settings.origin) ||
        ["cross-site", "same-site"].includes(c.req.header("Sec-Fetch-Site") ?? ""))) {
      return c.json({ error: "origin_denied" }, 403);
    }
    if (PUBLIC_API.some((pattern) => pattern.test(c.req.path))) {
      // No session means no CSRF token to compare, so an exact Origin match is
      // the only defence these mutations have against a cross-site form post.
      if (mutation && origin !== settings.origin) return c.json({ error: "origin_denied" }, 403);
      return next();
    }
    const session = resolveSession(getCookie(c, sessionCookieName(settings)) ?? "");
    const principal = session ? principalForSession(session) : null;
    if (!session || !principal) return c.json({ error: "authentication_required" }, 401);
    c.set("principal" as never, principal as never);
    c.set("csrfToken" as never, session.csrfToken as never);
    if (mutation && (origin !== settings.origin || !validSecurityToken(c.req.header("X-CSRF-Token"), session.csrfToken))) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    await next();
  };
}

/**
 * The local runtime is loopback-only, but browsers on another origin can still
 * send a request to it. Every local mutation therefore needs the process-only
 * session token; browser callers must also be the compiled app or Vite dev
 * server. A CLI can omit Origin, provided it obtained the same local token.
 */
async function localRequestSecurity(
  c: Parameters<MiddlewareHandler>[0],
  next: Parameters<MiddlewareHandler>[1],
): Promise<Response | void> {
  const url = new URL(c.req.url);
  // Validate reads as well: a loopback listener alone does not prevent a
  // browser from addressing it through an attacker-controlled DNS name.
  const host = c.req.header("Host");
  if (!LOCAL_HOSTS.has(url.hostname)
      || (host !== undefined && !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host))) {
    return c.json({ error: "origin_denied" }, 403);
  }
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();

  const origin = c.req.header("Origin");
  const fetchSite = c.req.header("Sec-Fetch-Site");
  const trustedBrowserOrigin = origin === url.origin || LOCAL_FRONTEND_ORIGINS.has(origin ?? "");
  const trustedCaller = LOCAL_HOSTS.has(url.hostname)
    && (origin ? trustedBrowserOrigin : !fetchSite);
  if (!trustedCaller || fetchSite === "cross-site") {
    return c.json({ error: "origin_denied" }, 403);
  }
  if (!validSecurityToken(c.req.header("X-CSRF-Token"))) {
    return c.json({ error: "csrf_invalid" }, 403);
  }
  await next();
}
