import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type {
  CompareRequest,
  HealthResponse,
  StartScanRequest,
  UpdateFindingTriageRequest,
} from "@csb/shared";
import { compareScans } from "./compare.js";
import { getCodexInfo } from "./codex-info.js";
import { CODEX_SECURITY_STATE_DIR } from "./config.js";
import { getRun, listRuns } from "./db.js";
import { listDirectory } from "./fs.js";
import {
  importExternalScans,
  readFindingsFile,
  toFindingSummaries,
} from "./ingest.js";
import { buildMetricsSummary } from "./metrics.js";
import { withProgress, withProgressMany } from "./progress.js";
import { buildRegressionSummary, markScanAsRepositoryBaseline, updateFindingTriage } from "./regression.js";
import { MAX_CONCURRENT_SCANS } from "./config.js";
import {
  cancelScan,
  getActiveScanIds,
  isScanActive,
  startScan,
  subscribe,
} from "./runner.js";

export const app = new Hono();

app.use(
  "*",
  cors({
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

app.get("/health", async (c) => {
  const codexInfo = await getCodexInfo();
  const activeScanIds = getActiveScanIds();
  const body: HealthResponse = {
    ok: true,
    api: "codex-security-benchmark",
    codexStateDir: CODEX_SECURITY_STATE_DIR,
    codexInfo,
    activeScanId: activeScanIds[0] ?? null,
    activeScanIds,
    maxConcurrentScans: MAX_CONCURRENT_SCANS,
  };
  return c.json(body);
});

app.post("/ingest", (c) => {
  const result = importExternalScans();
  return c.json(result);
});

app.get("/metrics/summary", (c) => c.json(buildMetricsSummary()));

app.get("/scans", (c) => c.json({ scans: withProgressMany(listRuns()) }));

app.get("/scans/:id", (c) => {
  const run = getRun(c.req.param("id"));
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  const findings = toFindingSummaries(readFindingsFile(run.scanDir));
  return c.json({ scan: withProgress(run), findings });
});

app.get("/scans/:id/regression", (c) => {
  try {
    return c.json(buildRegressionSummary(c.req.param("id")));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Falha ao calcular regressões" }, 404);
  }
});

app.post("/scans/:id/baseline", (c) => {
  try {
    return c.json(markScanAsRepositoryBaseline(c.req.param("id")));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Falha ao fixar baseline" }, 400);
  }
});

app.get("/scans/:id/findings", (c) => {
  const run = getRun(c.req.param("id"));
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  const severity = c.req.query("severity");
  const q = (c.req.query("q") || "").toLowerCase();
  let findings = readFindingsFile(run.scanDir);
  if (severity) {
    findings = findings.filter((f) => f.severity === severity);
  }
  if (q) {
    findings = findings.filter(
      (f) =>
        f.title.toLowerCase().includes(q) ||
        (f.primaryPath ?? "").toLowerCase().includes(q) ||
        (f.summary ?? "").toLowerCase().includes(q),
    );
  }
  return c.json({ findings: toFindingSummaries(findings), total: findings.length });
});

app.get("/scans/:id/findings/:findingId", (c) => {
  const run = getRun(c.req.param("id"));
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  const findingId = c.req.param("findingId");
  const finding = readFindingsFile(run.scanDir).find(
    (f) => f.findingId === findingId || f.occurrenceId === findingId,
  );
  if (!finding) return c.json({ error: "Finding não encontrado" }, 404);
  return c.json({ finding });
});

app.post("/scans/:id/findings/:findingId/triage", async (c) => {
  const body = (await c.req.json()) as UpdateFindingTriageRequest;
  const allowed = new Set(["unreviewed", "confirmed", "accepted", "false_positive"]);
  if (!allowed.has(body.status)) return c.json({ error: "Estado de triagem inválido" }, 400);
  try {
    const triage = updateFindingTriage(
      c.req.param("id"),
      c.req.param("findingId"),
      body.status,
      typeof body.note === "string" ? body.note : null,
    );
    return c.json({ triage });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Falha ao salvar triagem" }, 400);
  }
});

app.post("/scans", async (c) => {
  const body = (await c.req.json()) as StartScanRequest;
  try {
    const scan = await startScan(body);
    return c.json({ scan }, 201);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Falha ao iniciar scan" },
      400,
    );
  }
});

app.post("/scans/:id/cancel", (c) => {
  const ok = cancelScan(c.req.param("id"));
  if (!ok) return c.json({ error: "Scan não está ativo" }, 404);
  return c.json({ ok: true });
});

app.get("/scans/:id/events", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    let closed = false;
    const unsubscribe = subscribe(id, async (event) => {
      if (closed) return;
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      });
      if (event.type === "done" || event.type === "error") {
        closed = true;
        unsubscribe();
      }
    });

    stream.onAbort(() => {
      closed = true;
      unsubscribe();
    });

    // Keep connection open while scan is active
    while (!closed) {
      await stream.sleep(1000);
      if (!isScanActive(id) && getRun(id)?.status !== "running") {
        // If not active anymore, end after a short grace
        await stream.sleep(500);
        closed = true;
        unsubscribe();
      }
    }
  });
});

app.post("/compare", async (c) => {
  const body = (await c.req.json()) as CompareRequest;
  try {
    return c.json(compareScans(body.scanIds ?? []));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Falha na comparação" },
      400,
    );
  }
});

app.get("/fs/list", (c) => {
  try {
    return c.json(listDirectory(c.req.query("path") ?? undefined));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Falha ao listar" },
      400,
    );
  }
});
