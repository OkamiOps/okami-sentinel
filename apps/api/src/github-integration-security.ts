import type { MiddlewareHandler } from "hono";
import { publicOrigin, runtimeMode } from "./deployment-settings.js";
import { validSecurityToken } from "./security-session.js";

/** The local API also needs CSRF protection: these routes schedule paid scans and write Git state. */
export function githubIntegrationSecurity(): MiddlewareHandler {
  return async (c, next) => {
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
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !validSecurityToken(c.req.header("X-CSRF-Token"))) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    await next();
  };
}
