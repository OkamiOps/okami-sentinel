import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { app, reconcileGitHubActionsNow } from "./app.js";
import {
  API_HEADERS_TIMEOUT_MS,
  API_HOST,
  API_PORT,
  API_REQUEST_TIMEOUT_MS,
  DATA_DIR,
  GITHUB_RECONCILE_INTERVAL_MS,
  RUNS_DIR,
  ROOT_DIR,
} from "./config.js";
import { backfillRunMetricProjections, getDb, closeDb, listActiveRunIds } from "./db.js";
import { createServerApp } from "./server-app.js";
import { loadServerSettings } from "./deployment-settings.js";
import { createShutdownHandler, isDraining } from "./shutdown.js";
import { cancelScan } from "./runner.js";
import { getProviderRuntime } from "./provider-runtime.js";
import { ensureConnectionSchema } from "./connections-store.js";
import { ensureGitHubActionsSchema } from "./github-actions/store.js";
import { reconcileOrphanedGitHubActionDispatches } from "./github-actions/dispatch.js";
import {
  clampReconcileInterval,
  startGitHubReconciler,
} from "./github-actions/reconciler.js";
import { startOpsEvaluator } from "./email/ops-notifications.js";
import { startEmailWorker } from "./email/worker.js";
import { backfillRunRepositoryKeys } from "./auth/repository-key.js";
import { bootstrapAdmin } from "./auth/auth-service.js";
import {
  backfillFindingCategoryMetrics,
  backfillTerminalMetricArtifacts,
  importExternalScans,
  interruptActiveRunsAfterServerRestart,
  reconcileRunningScansAndRecover,
} from "./ingest.js";
import {
  reconcileGitHubActionsGates,
  reconcileManagedMaterializations,
} from "./gate-orchestrator.js";

const settings = loadServerSettings();
if (settings.mode === "server" && !(await getProviderRuntime().vault.available()).available) {
  throw new Error("Server credential storage is unavailable. Check the vault key and data volume.");
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RUNS_DIR, { recursive: true });
getDb();
ensureConnectionSchema(getDb());
// Once, here, and before anything reads the actions model: this call renames the
// legacy `github_monitor_*` tables and carries every rule over as two actions.
// Nothing else on the boot path may reach the store before it — a module that
// did would recreate the renamed tables empty.
const actionsMigration = ensureGitHubActionsSchema(getDb());
if (actionsMigration.actions > 0 || actionsMigration.events > 0) {
  console.log(`[csb-api] Migrated ${actionsMigration.actions} GitHub action(s)`
    + ` and ${actionsMigration.events} event(s) from the monitor rules`
    + (actionsMigration.skipped > 0 ? ` (skipped ${actionsMigration.skipped} legacy row(s))` : ""));
}
backfillRunRepositoryKeys();

if (settings.mode === "server") {
  // `loadServerSettings` validates both settings, so a rejection here is a rule
  // the account store applies and the loader does not. Name the settings before
  // exiting; the values themselves never reach the log.
  const outcome = await bootstrapAdmin({ username: settings.username, password: settings.password })
    .catch((error: unknown) => {
      console.error(
        "[csb-api] Rejected the administrator from CSB_ADMIN_USER and CSB_ADMIN_PASSWORD_FILE: "
          + `${error instanceof Error ? error.message : "unknown_error"}`,
      );
      throw error;
    });
  if (outcome === "created") console.log(`[csb-api] Created administrator ${settings.username} from CSB_ADMIN_USER`);
  if (outcome === "recovered") console.warn(`[csb-api] No active administrator found; restored ${settings.username} from CSB_ADMIN_PASSWORD_FILE`);
  if (outcome === "unlocked") console.warn(`[csb-api] Cleared the sign-in lockout on administrator ${settings.username}`);
}

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

const interruptedAtBoot = settings.mode === "server" ? listActiveRunIds() : [];
const localReconciliation = settings.mode === "local"
  ? await reconcileRunningScansAndRecover({ afterLocalRestart: true })
  : undefined;
const reconciled = settings.mode === "server"
  ? interruptActiveRunsAfterServerRestart()
  : localReconciliation?.reconciled ?? 0;
if (reconciled > 0) {
  console.log(settings.mode === "server"
    ? `[csb-api] Marked ${reconciled} active scan(s) interrupted after server restart`
    : `[csb-api] Reconciled ${reconciled} running scan(s) from workbench`);
}

for (const outcome of localReconciliation?.recovery ?? []) {
  console.log(`[csb-api] Portable worker recovery ${JSON.stringify(outcome)}`);
}

if (interruptedAtBoot.length > 0) {
  const { recoverPortableScansAfterServerRestart } = await import("./scanners/portable-server-recovery.js");
  const recovery = await recoverPortableScansAfterServerRestart(interruptedAtBoot);
  for (const outcome of recovery) {
    console.log(`[csb-api] Portable restart recovery ${JSON.stringify(outcome)}`);
  }
}

void reconcileGitHubActionsGates().then((gates) => {
  if (gates.length > 0) {
    console.log(`[csb-api] Reconciled ${gates.length} GitHub Actions gate(s)`);
  }
}).catch(() => {
  console.warn("[csb-api] GitHub Actions gate reconciliation deferred");
});

// Keep orphaned CLI jobs (surviving an API restart) in sync with workbench.
let scanReconciliationInFlight = false;
const scanReconciler = setInterval(() => {
  if (scanReconciliationInFlight) return;
  scanReconciliationInFlight = true;
  void reconcileRunningScansAndRecover().then((result) => {
    for (const outcome of result.recovery) {
      console.log(`[csb-api] Portable worker recovery ${JSON.stringify(outcome)}`);
    }
  }).catch(() => {
    // ignore transient sqlite/provider locks
  }).finally(() => {
    scanReconciliationInFlight = false;
  });
}, 15_000).unref();

const gateReconciler = setInterval(() => {
  void reconcileGitHubActionsGates().catch(() => {
    // A persisted dispatch remains retryable after transient App/API failures.
  });
}, 15_000).unref();

// Notifications are written to the outbox by whatever event produced them and
// sent from here, in both modes: a local workbench with a provider configured
// still has invites and security alerts to deliver. Building the worker touches
// nothing; the rows a previous process left claimed are returned to the queue by
// its first tick, so a locked database at boot cannot stop the API.
const emailWorker = startEmailWorker();

// The operational conditions have no moment to hook, so they are sampled. Same
// process, same non-wedging guard, same shutdown drain as the outbox worker.
const opsEvaluator = startOpsEvaluator();

// A dispatch the previous process reserved and never finished is terminal: the
// scan may have reached its provider, so it is never retried blindly.
const orphanedDispatches = reconcileOrphanedGitHubActionDispatches();
if (orphanedDispatches > 0) {
  console.warn(`[csb-api] Marked ${orphanedDispatches} GitHub action dispatch(es) uncertain after restart`);
}

// The 60 s poller is gone: webhooks are the trigger, and this is the read-only
// safety net for the deliveries GitHub never retries.
const githubReconciler = startGitHubReconciler({
  reconcile: async () => {
    const outcome = await reconcileGitHubActionsNow();
    if (outcome.created > 0 || outcome.observed > 0 || outcome.errors > 0) {
      console.log(`[csb-api] Reconciled ${outcome.repositories} GitHub repository(ies):`
        + ` ${outcome.created} event(s) recovered, ${outcome.observed} observed, ${outcome.errors} error(s)`);
    }
    return outcome;
  },
  intervalMs: GITHUB_RECONCILE_INTERVAL_MS,
  onError: () => {
    // Every failure is already recorded on the action rows it concerns.
    console.warn("[csb-api] GitHub reconciliation cycle failed");
  },
});
// One cycle at boot recovers whatever arrived while the process was down, through
// the loop's own guard so it cannot be overlapped by the first tick.
void githubReconciler.runNow();

const serverApp = createServerApp(app, {
  settings,
  webRoot: process.env.CSB_WEB_DIST_DIR || path.join(ROOT_DIR, "apps", "web", "dist"),
  isReady: () => !isDraining(),
});

const server = serve(
  {
    fetch: serverApp.fetch,
    hostname: API_HOST,
    port: API_PORT,
    // `headersTimeout` bounds the one phase every route shares and no handler can
    // observe — it ends before routing, so it touches neither SSE nor a slow
    // response — and tightening it ends a header-slowloris on every route at once.
    // `requestTimeout` is Node's own default, stated and not changed: `POST
    // /ingest` already runs under these five minutes (the timer stays armed until
    // the response finishes for a request whose body nothing read), and the route
    // that needs a tight bound is the unauthenticated webhook, which enforces its
    // own (10 s of progress, 2 s of silence).
    serverOptions: {
      headersTimeout: API_HEADERS_TIMEOUT_MS,
      requestTimeout: API_REQUEST_TIMEOUT_MS,
    },
  },
  (info) => {
    console.log(`[csb-api] Listening on http://${info.address}:${info.port}`);
  },
);

if (settings.mode === "server") {
  const shutdown = createShutdownHandler({
    stopHttp() {
      clearInterval(scanReconciler);
      clearInterval(gateReconciler);
      server.close();
      if ("closeAllConnections" in server) server.closeAllConnections();
    },
    cancelWork() {
      const ids = listActiveRunIds();
      for (const id of ids) cancelScan(id);
      return ids.length > 0;
    },
    // The outbox worker owns the store while a send is in flight; the tick has
    // to finish before `closeDb`, or a delivered message would lose its mark and
    // be sent again after the restart.
    drain: async () => {
      // A reconciliation cycle holds a write transaction and may be awaiting a
      // paid dispatch, so it is awaited here — before `closeDb` — exactly like the
      // two other loops that own the store.
      await githubReconciler.stop();
      await opsEvaluator.stop();
      await emailWorker.stop();
    },
    closeStore: closeDb,
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
    void shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  });
}
