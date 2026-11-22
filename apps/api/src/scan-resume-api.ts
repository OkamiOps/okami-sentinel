import { Hono } from "hono";

export function createScanResumeApp(dependencies: {
  resume(scanId: string, maxCostUsd?: number): Promise<string | undefined>;
}) {
  const app = new Hono();
  app.post("/scans/:id/resume", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "Expected a JSON object", code: "resume_invalid_request" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        ("maxCostUsd" in body && (typeof body.maxCostUsd !== "number" || !Number.isFinite(body.maxCostUsd) || body.maxCostUsd <= 0))) {
      return c.json({ error: "maxCostUsd must be a positive number", code: "resume_invalid_request" }, 400);
    }
    try {
      const scanId = await dependencies.resume(c.req.param("id"), (body as { maxCostUsd?: number }).maxCostUsd);
      return c.json({ scanId }, 201);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "scan_capacity_full") return c.json({ code, error: "Scan capacity is full. Try again later." }, 409);
      if (code === "resume_scan_not_found") return c.json({ code, error: "Scan not found" }, 404);
      if (/^resume_[a-z_]+$/.test(code)) return c.json({ code, error: code.replaceAll("_", " ") }, 422);
      return c.json({ code: "resume_failed", error: "Unable to resume scan. Check saved checkpoints and connection availability." }, 500);
    }
  });
  return app;
}
