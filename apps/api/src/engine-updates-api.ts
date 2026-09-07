import { execFile } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import type { ManagedRuntimeId } from "@csb/shared";
import {
  CODEX_SECURITY_NPM_CACHE_DIR, DATA_DIR, MANTIS_SOURCE_REF, VULNHUNTER_SOURCE_REF,
  refreshManagedRuntimeCommands, resolveCodexBin,
} from "./config.js";
import {
  ENGINE_UPDATE_RESERVATION_PREFIX, engineUpdateBlockingReason, releaseScanCapacity,
  renewScanCapacity, reserveScanCapacity,
} from "./db.js";
import { invalidateScannerCatalog } from "./scanners/catalog.js";
import { createEngineUpdatesService, EngineUpdateError } from "./scanners/engine-updates.js";

type UpdatesService = Pick<ReturnType<typeof createEngineUpdatesService>, "status" | "check" | "update" | "rollback">;
const execute = promisify(execFile);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEV_ORIGINS = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);

export function createEngineUpdatesApp(supplied?: UpdatesService): Hono {
  const service = supplied ?? createEngineUpdatesService({
    dataDir: DATA_DIR,
    methodologyPins: { mantis: MANTIS_SOURCE_REF, vulnhunter: VULNHUNTER_SOURCE_REF },
    currentRuntime: unmanagedRuntime,
    acquireMaintenance: acquireEngineMaintenance,
    blockingReason: engineUpdateBlockingReason,
    onActivated: () => {
      refreshManagedRuntimeCommands();
      invalidateScannerCatalog();
    },
  });
  const token = randomBytes(32).toString("base64url");
  const app = new Hono();
  app.use("/engine-updates/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const url = new URL(c.req.url);
    const origin = c.req.header("Origin");
    // This endpoint installs executable software; protect against rebinding
    // as well as cross-origin requests to the loopback API.
    if (!LOCAL_HOSTS.has(url.hostname) || (origin && origin !== url.origin && !DEV_ORIGINS.has(origin))) {
      return c.json({ error: "origin_denied" }, 403);
    }
    if (!origin && c.req.header("Sec-Fetch-Site") === "cross-site") return c.json({ error: "origin_denied" }, 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !validToken(c.req.header("X-CSRF-Token"), token)) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    await next();
  });
  app.get("/engine-updates/security-session", (c) => c.json({ csrfToken: token }));
  app.get("/engine-updates", async (c) => {
    try { return c.json(await service.status()); }
    catch { return c.json({ error: "state_invalid" }, 500); }
  });
  app.post("/engine-updates/check", async (c) => {
    try {
      await body(c.req.raw, []);
      return c.json(await service.check());
    } catch (error) { return updateError(c, error); }
  });
  app.post("/engine-updates/:id/update", async (c) => {
    try {
      const id = runtimeId(c.req.param("id"));
      const input = await body(c.req.raw, ["version"]);
      if (typeof input.version !== "string" || input.version.length > 80) throw new Error("invalid_request");
      return c.json(await service.update(id, input.version));
    } catch (error) { return updateError(c, error); }
  });
  app.post("/engine-updates/:id/rollback", async (c) => {
    try {
      const id = runtimeId(c.req.param("id"));
      await body(c.req.raw, []);
      return c.json(await service.rollback(id));
    } catch (error) { return updateError(c, error); }
  });
  return app;
}

function updateError(c: import("hono").Context, error: unknown) {
  if (error instanceof EngineUpdateError) {
    const conflict = ["scan_active", "update_in_progress", "check_required", "version_changed", "external_runtime", "bundled_engine", "rollback_unavailable"].includes(error.code);
    return c.json({ error: error.code }, conflict ? 409 : 502);
  }
  return c.json({ error: "invalid_request" }, 400);
}

function runtimeId(value: string): ManagedRuntimeId {
  if (value !== "codex-security" && value !== "codex-cli") throw new Error("invalid_request");
  return value;
}

function validToken(value: string | undefined, expected: string): boolean {
  if (!value || value.length !== expected.length) return false;
  const supplied = Buffer.from(value);
  const target = Buffer.from(expected);
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}

async function body(request: Request, allowedKeys: readonly string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("Content-Type") ?? "")) throw new Error("invalid_request");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 4096) { await reader.cancel(); throw new Error("invalid_request"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowedKeys.includes(key))) throw new Error("invalid_request");
  return value as Record<string, unknown>;
}

/** Uses the same SQLite transaction as scan admission, including preflight. */
export function acquireEngineMaintenance(): () => void {
  const id = `${ENGINE_UPDATE_RESERVATION_PREFIX}${randomUUID()}`;
  if (!reserveScanCapacity(id, 1)) throw new EngineUpdateError(engineUpdateBlockingReason() ?? "scan_active");
  const timer = setInterval(() => {
    try { renewScanCapacity(id); }
    catch { /* A bounded install remains covered by the five-minute lease. */ }
  }, 30_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    releaseScanCapacity(id);
  };
}

/** Never invoke npx here: a read-only status page must not install a CLI. */
async function unmanagedRuntime(id: ManagedRuntimeId) {
  const explicit = (id === "codex-cli" ? process.env.CODEX_BIN : process.env.CODEX_SECURITY_BIN)?.trim();
  if (id === "codex-security" && !explicit) {
    return { command: null, source: "on-demand" as const, version: cachedSecurityVersion(), explicitOverride: false };
  }
  const command = explicit || resolveCodexBin();
  let version: string | null = null;
  try {
    const result = await execute(command, ["--version"], { timeout: 5_000, maxBuffer: 16_384, shell: false });
    version = result.stdout.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] ?? null;
  } catch { /* Availability is represented by the missing version. */ }
  return { command, source: "external" as const, version, explicitOverride: Boolean(explicit) };
}

function cachedSecurityVersion(): string | null {
  const root = path.join(CODEX_SECURITY_NPM_CACHE_DIR, "_npx");
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).slice(0, 200);
    const packages = entries.flatMap((entry) => {
      try {
        const file = path.join(root, entry.name, "node_modules", "@openai", "codex-security", "package.json");
        if (fs.statSync(file).size > 64_000) return [];
        const json = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string; version?: string };
        return json.name === "@openai/codex-security" && typeof json.version === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(json.version)
          ? [{ version: json.version, modified: fs.statSync(file).mtimeMs }] : [];
      } catch { return []; }
    });
    return packages.sort((a, b) => b.modified - a.modified)[0]?.version ?? null;
  } catch { return null; }
}
