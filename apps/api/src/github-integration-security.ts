import type { MiddlewareHandler } from "hono";
import { publicOrigin, runtimeMode } from "./deployment-settings.js";
import { GITHUB_WEBHOOK_PATH } from "./github-app/manifest-flow.js";
import { validRequestCsrf } from "./security-session.js";

/**
 * GitHub has no session, no `Origin` and no CSRF token, and the HMAC over the raw
 * body is what authenticates the delivery. The guard is mounted over all of
 * `/github/*`, so the one path that must stay reachable is named here rather than
 * left to the order the routes happen to be registered in.
 */
function isWebhookDelivery(method: string, requestPath: string): boolean {
  return method === "POST"
    && requestPath.replace(/^\/api(?=\/)/, "") === GITHUB_WEBHOOK_PATH;
}

/** The local API also needs CSRF protection: these routes schedule paid scans and write Git state. */
export function githubIntegrationSecurity(): MiddlewareHandler {
  return async (c, next) => {
    if (isWebhookDelivery(c.req.method, c.req.path)) return next();
    c.header("Cache-Control", "no-store");
    const url = new URL(c.req.url);
    const origin = c.req.header("Origin");
    const server = runtimeMode() === "server";
    const allowed = server
      ? url.host === new URL(publicOrigin()).host && (!origin || origin === publicOrigin())
      : ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        && (!origin || [url.origin, "http://127.0.0.1:5173", "http://localhost:5173"].includes(origin));
    if (!allowed || ["cross-site", "same-site"].includes(c.req.header("Sec-Fetch-Site") ?? "")) {
      return c.json({ error: "origin_denied" }, 403);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !validRequestCsrf(c)) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    await next();
  };
}
