import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { ServerSettings } from "./deployment-settings.js";
import { validSecurityToken } from "./security-session.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOCAL_FRONTEND_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

export function serverSecurity(settings: ServerSettings): MiddlewareHandler {
  const expected = createHash("sha256").update(`${settings.username}:${settings.password}`).digest();
  let failedAttempts = 0;
  let windowStart = Date.now();
  return async (c, next) => {
    if (settings.mode === "local") return localMutationSecurity(c, next);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
    if ((c.req.path === "/healthz" || c.req.path === "/readyz") && ["GET", "HEAD"].includes(c.req.method)) return next();
    if (new URL(c.req.url).host !== new URL(settings.origin!).host) return c.json({ error: "origin_denied" }, 403);
    const header = c.req.header("Authorization") ?? "";
    const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header)?.[1];
    const supplied = encoded && encoded.length <= 8192 ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
    const actual = createHash("sha256").update(supplied).digest();
    if (!timingSafeEqual(actual, expected)) {
      if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); failedAttempts = 0; }
      if (++failedAttempts > 30) { c.header("Retry-After", "60"); return c.json({ error: "authentication_rate_limited" }, 429); }
      c.header("WWW-Authenticate", 'Basic realm="Sentinel", charset="UTF-8"');
      return c.json({ error: "authentication_required" }, 401);
    }
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    const origin = c.req.header("Origin");
    const callback = c.req.method === "GET" && c.req.path === "/api/guardrails/github-app/manifest/callback";
    if (!callback && ((origin && origin !== settings.origin) ||
        (c.req.path.startsWith("/api/") && ["cross-site", "same-site"].includes(c.req.header("Sec-Fetch-Site") ?? "")))) {
      return c.json({ error: "origin_denied" }, 403);
    }
    if (mutation && (origin !== settings.origin || !validSecurityToken(c.req.header("X-CSRF-Token")))) {
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
async function localMutationSecurity(
  c: Parameters<MiddlewareHandler>[0],
  next: Parameters<MiddlewareHandler>[1],
): Promise<Response | void> {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();

  const url = new URL(c.req.url);
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
