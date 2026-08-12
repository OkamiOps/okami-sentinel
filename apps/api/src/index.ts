import fs from "node:fs";
import { serve } from "@hono/node-server";
import { app } from "./app.js";
import {
  API_HOST,
  API_PORT,
  DATA_DIR,
  RUNS_DIR,
} from "./config.js";
import { getDb } from "./db.js";
import { ensureConnectionSchema } from "./connections-store.js";
import { importExternalScans, reconcileRunningScans } from "./ingest.js";
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

const { imported, pruned } = importExternalScans();
console.log(
  `[csb-api] Indexed ${imported} scan(s) from Codex Security state` +
    (pruned ? ` (pruned ${pruned} duplicate(s))` : ""),
);

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
