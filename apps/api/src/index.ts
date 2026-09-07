import fs from "node:fs";
import { serve } from "@hono/node-server";
import { app } from "./app.js";
import {
  API_HOST,
  API_PORT,
  DATA_DIR,
  RUNS_DIR,
} from "./config.js";
import { backfillRunMetricProjections, getDb } from "./db.js";
import { ensureConnectionSchema } from "./connections-store.js";
import {
  backfillFindingCategoryMetrics,
  backfillTerminalMetricArtifacts,
  importExternalScans,
  reconcileRunningScans,
} from "./ingest.js";
import {
  reconcileGitHubActionsGates,
  reconcileManagedMaterializations,
} from "./gate-orchestrator.js";

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RUNS_DIR, { recursive: true });
getDb();
ensureConnectionSchema(getDb());

const materializations = reconcileManagedMaterializations();
if (materializations.released.length > 0 || materializations.retryable.length > 0) {
  console.log(
    `[csb-api] Reconciled ${materializations.released.length} Guardrails materialization lease(s)`
      + (materializations.retryable.length > 0
        ? ` (${materializations.retryable.length} cleanup retry pending)`
        : ""),
  );
}

const { imported, pruned } = importExternalScans({ reindexCategories: false });
console.log(
  `[csb-api] Indexed ${imported} scan(s) from Codex Security state` +
    (pruned ? ` (pruned ${pruned} duplicate(s))` : ""),
);

// Historical artifacts are indexed once before serving requests. The backfills
// persist an explicit marker for absent/empty data, so every batch advances and
// a 10k-row legacy database cannot expose partial totals.
function drainBackfill(backfill: (limit: number) => number): number {
  const limit = 2_000;
  let total = 0;
  for (;;) {
    const indexed = backfill(limit);
    total += indexed;
    if (indexed < limit) return total;
  }
}

const terminalArtifactsBackfilled = drainBackfill(backfillTerminalMetricArtifacts);
const metricBackfilled = drainBackfill(backfillRunMetricProjections);
const categoriesBackfilled = drainBackfill(backfillFindingCategoryMetrics);
if (terminalArtifactsBackfilled > 0 || metricBackfilled > 0 || categoriesBackfilled > 0) {
  console.log(
    `[csb-api] Recovered ${terminalArtifactsBackfilled} terminal artifact(s), ` +
      `backfilled ${metricBackfilled} metric projection(s) and ` +
      `${categoriesBackfilled} category snapshot(s)`,
  );
}

const reconciled = reconcileRunningScans();
if (reconciled > 0) {
  console.log(`[csb-api] Reconciled ${reconciled} running scan(s) from workbench`);
}

void reconcileGitHubActionsGates().then((gates) => {
  if (gates.length > 0) {
    console.log(`[csb-api] Reconciled ${gates.length} GitHub Actions gate(s)`);
  }
}).catch(() => {
  console.warn("[csb-api] GitHub Actions gate reconciliation deferred");
});

// Keep orphaned CLI jobs (surviving an API restart) in sync with workbench.
setInterval(() => {
  try {
    reconcileRunningScans();
  } catch {
    // ignore transient sqlite locks
  }
}, 15_000).unref();

setInterval(() => {
  void reconcileGitHubActionsGates().catch(() => {
    // A persisted dispatch remains retryable after transient App/API failures.
  });
}, 15_000).unref();

serve(
  {
    fetch: app.fetch,
    hostname: API_HOST,
    port: API_PORT,
  },
  (info) => {
    console.log(`[csb-api] Listening on http://${info.address}:${info.port}`);
  },
);
