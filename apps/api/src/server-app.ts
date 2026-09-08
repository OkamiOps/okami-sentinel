import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { loadServerSettings, type ServerSettings } from "./deployment-settings.js";
import { serverSecurity } from "./server-security.js";

export function createServerApp(api: Hono, options: {
  settings?: ServerSettings;
  webRoot: string;
  isReady?: () => boolean;
}): Hono {
  const settings = options.settings ?? loadServerSettings();
  const server = new Hono();
  server.use("*", serverSecurity(settings));
  server.get("/healthz", (c) => c.json({ ok: true }));
  server.get("/readyz", (c) => options.isReady?.() === false ? c.json({ ready: false }, 503) : c.json({ ready: true }));
  server.use("/api/*", async (c, next) => {
    if (options.isReady?.() === false && !["GET", "HEAD"].includes(c.req.method)) return c.json({ error: "server_draining" }, 503);
    await next();
  });
  server.route("/api", api);
  server.all("/api", (c) => c.json({ error: "not_found" }, 404));
  server.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  if (settings.mode === "local") server.use("*", async (c, next) => {
    // Legacy API clients still use /scans, while HTML navigation must reach
    // the compiled application's /scans/:id route when using pnpm start.
    if (!c.req.header("Accept")?.includes("text/html")) {
      const response = await api.fetch(c.req.raw);
      if (response.status !== 404) return response;
    }
    await next();
  });
  if (fs.existsSync(path.join(options.webRoot, "index.html"))) {
    server.get("*", serveStatic({ root: options.webRoot }));
    server.get("*", async (c, next) => {
      // Missing assets stay 404; only browser HTML navigation uses the SPA.
      if (!c.req.header("Accept")?.includes("text/html") || path.extname(c.req.path)) return c.notFound();
      const response = await serveStatic({ path: path.join(options.webRoot, "index.html") })(c, next);
      return response instanceof Response ? response : c.res;
    });
  }
  return server;
}
