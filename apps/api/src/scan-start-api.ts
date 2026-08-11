import type { ScanRun, StartScanRequest } from "@csb/shared";
import { Hono } from "hono";

export interface ScanStartApiDependencies {
  startScan(
    request: StartScanRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ScanRun>;
}

export function createScanStartApp(dependencies: ScanStartApiDependencies): Hono {
  const scans = new Hono();

  scans.post("/scans", async (c) => {
    const body = (await c.req.json()) as StartScanRequest;
    try {
      const scan = await dependencies.startScan(body, { signal: c.req.raw.signal });
      return c.json({ scan }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Falha ao iniciar scan" },
        400,
      );
    }
  });

  return scans;
}
