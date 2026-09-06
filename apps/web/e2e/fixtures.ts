import type { Page } from "@playwright/test";
import type { LifecycleFinding, ProviderConnection, ScanRun } from "@csb/shared";

export const baseRun: ScanRun = {
  id: "scan-one", displayName: "Repository alpha", repositoryPath: "/fixture/alpha", scanDir: "/fixture/scans/one",
  revision: "main", status: "completed", engine: "codex-security", model: "fixture-model", effort: "high",
  mode: "standard", provider: "fixture", authMode: "api-key", scannerVersion: null, recipeHash: null,
  startedAt: "2026-09-07T10:00:00Z", completedAt: "2026-09-07T10:01:00Z", durationMs: 60000,
  cost: null, severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
  source: "benchmark", pid: null, execution: null,
};

export const connection: ProviderConnection = {
  id: "fixture-connection", scopeId: "local", name: "Fixture provider", providerKind: "codex", routeKind: "codex-local-cli",
  transport: "local-cli", authKind: "existing-session", protocol: "codex-app-server", status: "ready",
  modelSelectionMode: "runtime-default", defaultModelId: null, lastTestedAt: null, lastModelSyncAt: null,
  modelCatalogStale: false, display: { providerLabel: "Fixture", routeLabel: "Local fixture", secretConfigured: false, endpointConfigured: false, endpointKind: null },
};

export async function mockApi(page: Page, locale = "en") {
  const state = {
    offline: false, connectionsFail: false, modelsFail: false, launchCount: 0, cancelCount: 0,
    runs: [structuredClone(baseRun), { ...structuredClone(baseRun), id: "scan-two", displayName: "Repository beta" }],
    requests: [] as string[],
    findings: [] as LifecycleFinding[],
    lastLaunch: null as Record<string, unknown> | null,
    connection: structuredClone(connection),
  };
  await page.addInitScript(({ locale }) => {
    localStorage.setItem("okami-sentinel.locale", locale);
    localStorage.setItem("csb-bench-launch-v2", JSON.stringify({ repositoryPath: "/fixture/alpha", connectionId: "fixture-connection", paths: "src", maxCostUsd: "2" }));
  }, { locale });
  // Every API request is intercepted. No running API, credentials, or external provider is used.
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    state.requests.push(`${req.method()} ${path}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (state.offline) return route.fulfill({ status: 503, contentType: "text/plain", body: "Service unavailable" });
    if (path === "/scans/active") return json({ scans: state.runs.filter((run) => ["running", "queued"].includes(run.status)) });
    if (path === "/scans" && req.method() === "GET") {
      let scans = state.runs;
      const status = url.searchParams.get("status") ?? "all";
      if (status === "active") scans = scans.filter((run) => !["cancelled", "failed"].includes(run.status));
      else if (status !== "all") scans = scans.filter((run) => run.status === status);
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      scans = scans.filter((run) => run.displayName.toLowerCase().includes(query));
      const limit = Number(url.searchParams.get("limit") ?? scans.length);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return json({ scans: scans.slice(offset, offset + limit), total: scans.length, limit, offset, summary: { evidence: 0, costUsd: null, costIsUpperBound: false, archivedCount: 0 } });
    }
    if (path === "/scans" && req.method() === "POST") {
      state.launchCount++;
      state.lastLaunch = req.postDataJSON();
      const run = { ...baseRun, id: "launched-scan", status: "running" as const, completedAt: null, startedAt: new Date().toISOString() };
      state.runs.push(run);
      return json({ scan: run }, 201);
    }
    const match = path.match(/^\/scans\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const run = state.runs.find((item) => item.id === match[1]) ?? baseRun;
      const regression = { scanId: run.id, baseline: null, baselineSource: "none", isRepositoryBaseline: false, counts: Object.fromEntries(["new", "persisting", "fixed", "regressed"].map((status) => [status, state.findings.filter((finding) => finding.lifecycle === status).length])), findings: state.findings };
      if (!match[2]) return json({ scan: run, findings: [] });
      if (match[2] === "cancel") { state.cancelCount++; run.status = "cancelled"; return json({ ok: true }); }
      if (match[2] === "regression") return json(regression);
      if (match[2] === "telemetry") return json({ lines: [], cursor: 0 });
      if (match[2] === "report") return json({ scan: run, findings: [], regression, generatedAt: "2026-09-07T10:02:00Z" });
      if (match[2] === "events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    }
    if (path === "/connections") return state.connectionsFail ? json({ error: "fixture unavailable" }, 503) : json({ connections: [state.connection] });
    if (path === "/connections/security-session") return json({ csrfToken: "fixture-token" });
    if (path === "/connections/fixture-connection/models" || path === "/connections/fixture-connection/models/refresh") {
      if (state.modelsFail) return json({ error: "fixture unavailable" }, 503);
      const models = [{ connectionId: "fixture-connection", id: "fixture-model", displayName: "Fixture model", contextWindow: 8192, capabilities: {}, pricing: null, discoveredAt: "2026-09-07T10:00:00Z", source: "runtime" }];
      return path.endsWith("/refresh") ? json({ connection: state.connection, discovery: { models, supportsRuntimeDefault: false } }) : json({ models });
    }
    if (path === "/connections/compatibility") return json({ ...req.postDataJSON().selection, eligible: true, reasons: [], selectedProfile: "native", availableProfiles: ["native"] });
    if (path === "/health") return json({ ok: true, api: "fixture", codexStateDir: "/fixture", codexInfo: null, activeScanId: null, activeScanIds: [], maxConcurrentScans: 1 });
    if (path === "/scanners") return json({ scanners: [{ engine: "codex-security", name: "Codex Security", enabled: true, available: true, maturity: "stable", reason: null, sourceUrl: "", authModes: [], models: [], efforts: [], modes: ["standard"], stageCount: 6, writesTarget: false, executesGeneratedCode: false }], refreshedAt: "2026-09-07T10:00:00Z" });
    if (path === "/fs/list") return json({ path: "/fixture/alpha", parent: "/fixture", entries: [] });
    if (path === "/compare") {
      const ids: string[] = req.postDataJSON().scanIds;
      return json({ scans: state.runs.filter((run) => ids.includes(run.id)), baselineScanId: ids[0], candidateScanIds: ids.slice(1), comparisons: ids.slice(1).map((id) => ({ candidateScanId: id, counts: { candidate_only: 0, baseline_only: 0, both: 0, severity_changed: 0 }, findings: [] })), ranking: [] });
    }
    throw new Error(`Unmocked API request: ${req.method()} ${path}`);
  });
  return state;
}
