# GitHub + Guardrails Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Okami Sentinel's 60-second GitHub poller and one-rule-per-repository monitor with signed GitHub App webhooks, N actions per repository, a Sentinel-editable policy, an automatic baseline, and a sticky detailed comment on every pull request.

**Architecture:** A new `POST /github/webhook` endpoint authenticates each delivery by HMAC-SHA256 against a per-connection secret held in the credential vault, records it in `github_webhook_deliveries` keyed by `X-GitHub-Delivery`, maps it onto rows of a new `github_actions` table (event × branch patterns × executor × cost ceiling), and hands the resulting `github_action_events` row to the existing gate dispatcher unchanged. A read-only reconciliation every 15 minutes recovers deliveries lost to downtime without ever spending on a commit it has already seen. The gate pipeline, artifact contract and Check Run publication are reused as-is; what changes around them is the trigger, the number of configurable units, where the policy lives, whether a baseline is required, and that the result is now written back into the pull request.

**Tech Stack:** TypeScript on Node 24, Hono 4, better-sqlite3 11 (IMMEDIATE transactions), React 19 + react-router 7 + Tailwind 4, Playwright 1.63, `node:test` via `apps/api/scripts/run-tests.mjs` and `tsx --test` for `apps/web/src/lib/*.test.ts`. No new runtime dependency: HMAC is `node:crypto`.

**Spec:** `docs/architecture/2026-09-30-github-guardrails-design.md`

## Global Constraints

- SQLite only, always through `openSqliteFile`; every migration idempotent against the production database and wrapped in `migrate.immediate()`.
- Deny-by-default routing: every route added must appear in `ROUTE_POLICY` in `apps/api/src/auth/route-policy.ts`, or the coverage test fails. `POST /github/webhook` is the only new `PUBLIC` route and the only public route that mutates state.
- Cost rule: creating or enabling an action of **either** executor requires `admin`. A `maintainer` may disable, rename, and change branch patterns of a **disabled** action, and may delete an action.
- Webhook secret and GitHub App private key share custody: the credential vault (`SystemGitHubAppCredentialStore`, encrypted by `CSB_VAULT_KEY_FILE` in server mode). No new environment variable for secrets. `CSB_GITHUB_RECONCILE_INTERVAL_MS` is the only new optional env var, clamped to 5–60 minutes.
- Webhook request cap: 1 MiB (`1_048_576` bytes). Deliveries are recorded **only after** the signature verifies.
- PR comment: GitHub's hard limit is 65 536 characters; the renderer budget is 60 000. The comment is always in **English**, always detailed, and every string taken from a scan passes `redactPublicText` from `@csb/gate-core`.
- Five UI locales: `pt-BR`, `en`, `es`, `fr`, `de`. Every new message key exists in all five; `apps/web/src/lib/i18n.test.ts` enforces parity.
- Never block a merge. The Check Run stays informational; `githubConclusion` for `bootstrap` is `neutral`.
- Public origin is `https://sentinel.okamilab.com` via `CSB_PUBLIC_ORIGIN`; with no public origin the comment omits the banner and links.
- Naming hazard: **"action"** in this plan is a Sentinel automation unit (`github_actions` table, `GitHubAction`, `/github/actions`). **GitHub Actions** the CI product keeps its existing names (`GitHubActionsStatus`, `github_actions_dispatches`, `github-actions-executor.ts`, the `"github-actions"` executor value). Never rename across the two; never introduce a symbol whose name alone is ambiguous between them.
- Commit at the end of every task. Never `git push`. Never switch branches; work on `feat/guardrails-github`.

## Review Focus

Five input classes the spec implies but that no task's happy path exercises. Each has a test pinned to the task that owns the code.

1. **HMAC computed over re-serialized JSON instead of raw bytes.** A payload containing a multi-byte character (a PR titled `Corrige acentuação`) verifies in a test that parses then re-stringifies, and fails against real GitHub. Pinned to Task 1.3.
2. **Pull-request titles, branch names and finding titles containing Markdown table syntax or an HTML comment.** A title with `|`, a backtick, or `<!-- okami-sentinel:gate repository=x -->` must not break the comment table and must not be able to forge or collide with the sticky marker. Pinned to Task 3.1.
3. **Two deliveries for the same pull request arriving at the same instant** (a force-push storm, or a webhook racing the reconciler). Exactly one event per `target_identity` must survive, no `SQLITE_BUSY` may escape, and no two gates may be dispatched for one commit. Pinned to Task 1.3.
4. **A repository with thousands of findings.** The rendered comment must stay under 60 000 characters with a correct `+N mais no Sentinel`, and the comment-identity scan must stop at 3 pages instead of walking an unbounded comment history. Pinned to Task 3.1 and Task 3.2.
5. **No connection has a webhook secret configured yet, and a human deleted the sticky comment.** The first must answer `401 signature_invalid` rather than throw, and the second must turn a `404` on `PATCH` into a fresh `POST` rather than a failed gate. Pinned to Task 1.3 and Task 3.2.

---

# Phase 1 — Webhook ingestion, reconciliation, actions, Integration screen

Ships: the poller is gone, a PR or push triggers a gate through a signed webhook, an operator can create several actions per repository and see exactly what the App is missing. Six tasks; this is the largest phase.

### Task 1.1: Actions, events and deliveries schema with migration from monitor rules

**Files:**
- Create: `apps/api/src/github-actions/store.ts`
- Create: `apps/api/src/github-actions/store.test.ts`
- Create: `apps/api/src/github-actions/migrate-monitor-rules.ts`
- Create: `apps/api/src/github-actions/migrate-monitor-rules.test.ts`
- Modify: `packages/shared/src/index.ts` (add the shared types below)
- Reference: `apps/api/src/github-monitor/store.ts` (the shape to replace), `apps/api/src/guardrails-migrations.ts` (migration idiom)

**Interfaces:**
- Consumes: `getDb()` from `apps/api/src/db.js`; `GuardrailRepository` from `@csb/shared`.
- Produces, all exported from `apps/api/src/github-actions/store.ts`:
  - `ensureGitHubActionsSchema(database?: Database.Database): void`
  - `createGitHubAction(input: GitHubActionCreate, database?, now?, id?): GitHubAction`
  - `getGitHubAction(id: string, database?): GitHubAction | null`
  - `listGitHubActions(filter?: { repositoryKey?: string | null; enabledOnly?: boolean }, database?): GitHubAction[]`
  - `patchGitHubAction(id: string, patch: GitHubActionPatch, database?, now?): GitHubAction | null` — bumps `revision` and clears `baseline_initialized_at` when any of `trigger_kind`, `branch_patterns`, `executor`, `scanner`, `connectionId`, `installationId`, `repositoryId` changes
  - `deleteGitHubAction(id: string, database?): boolean`
  - `createGitHubActionEvent(input: GitHubActionEventCreate, database?): GitHubActionEvent | null` — returns `null` when the `UNIQUE (action_id, action_revision, target_identity)` constraint rejects it
  - `patchGitHubActionEvent(id: string, patch: GitHubActionEventPatch, database?): GitHubActionEvent | null`
  - `listGitHubActionEvents(filter: { actionId?: string; repositoryKeys?: string[]; statuses?: GitHubActionEventStatus[]; limit?: number }, database?): GitHubActionEvent[]`
  - `supersedeQueuedEvents(input: { actionId: string; pullRequestNumber?: number; headRef?: string; exceptHeadSha: string; reason: "head_superseded" | "pull_request_closed" }, database?): number`
  - `hasAnalysedCommit(actionId: string, headSha: string, database?): boolean` — true when an event of that action with that `head_sha` is `launched`, `dispatching` or terminal-with-gate
  - `recordWebhookDelivery(input: WebhookDeliveryRecord, database?): "recorded" | "duplicate"`
  - `listWebhookDeliveries(limit: number, database?): WebhookDeliveryRecord[]`
  - `countWebhookDeliveriesSince(isoTimestamp: string, database?): { processed: number; ignored: number; failed: number }`
- Produces in `@csb/shared`: `GitHubActionTriggerKind = "pull_request" | "push"`, `GitHubActionEventOrigin = "webhook" | "reconciliation" | "manual"`, `GitHubActionEventStatus = "observed" | "queued" | "dispatching" | "launched" | "skipped" | "failed" | "superseded"`, and the interfaces `GitHubAction`, `GitHubActionEvent`, `WebhookDeliveryRecord` mirroring the spec's columns in camelCase.
- Produces in `@csb/shared`, the write shapes the store and the API both use: `GitHubActionCreate = Omit<GitHubAction, "id" | "revision" | "baselineInitializedAt" | "lastEventAt" | "lastReconciledAt" | "lastError" | "createdAt" | "updatedAt">`; `GitHubActionPatch = Partial<Pick<GitHubAction, "name" | "triggerKind" | "branchPatterns" | "executor" | "connectionId" | "installationId" | "repositoryId" | "scanner" | "costCeilingUsd" | "dailyCostCeilingUsd" | "enabled">>`; `GitHubActionEventCreate = Omit<GitHubActionEvent, "id" | "dispatchedAt" | "completedAt"> & { status?: GitHubActionEventStatus }`; `GitHubActionEventPatch = Partial<Pick<GitHubActionEvent, "status" | "gateId" | "reason" | "error" | "dispatchedAt" | "completedAt">>`.
- Produces in `apps/api/src/github-actions/migrate-monitor-rules.ts`: `migrateMonitorRulesToActions(database?: Database.Database, now?: string): { actions: number; events: number; skipped: number }`.

- [ ] **Step 1: Write the failing store test**

```ts
// apps/api/src/github-actions/store.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createGitHubAction, ensureGitHubActionsSchema, listGitHubActions } from "./store.js";

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)`);
  db.prepare("INSERT INTO guardrail_repositories VALUES ('github:1')").run();
  ensureGitHubActionsSchema(db);
  return db;
}

test("allows several actions on one repository", () => {
  const db = memoryDb();
  const base = {
    repositoryKey: "github:1", connectionId: "c1", installationId: "i1", repositoryId: "1",
    executor: "sentinel-managed" as const, scanner: null, costCeilingUsd: 2,
    dailyCostCeilingUsd: 10, enabled: false, createdBy: "u1",
  };
  createGitHubAction({ ...base, name: "PR", triggerKind: "pull_request", branchPatterns: ["main"] }, db);
  createGitHubAction({ ...base, name: "Push", triggerKind: "push", branchPatterns: ["main"] }, db);
  createGitHubAction({ ...base, name: "Release", triggerKind: "push", branchPatterns: ["release/**"] }, db);
  assert.equal(listGitHubActions({ repositoryKey: "github:1" }, db).length, 3);
});

test("refuses an action without a cost ceiling", () => {
  const db = memoryDb();
  assert.throws(() => createGitHubAction({
    repositoryKey: "github:1", name: "PR", triggerKind: "pull_request", branchPatterns: ["main"],
    connectionId: "c1", installationId: "i1", repositoryId: "1", executor: "sentinel-managed",
    scanner: null, costCeilingUsd: 0, dailyCostCeilingUsd: null, enabled: false, createdBy: "u1",
  }, db));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && node --test --import tsx src/github-actions/store.test.ts`
Expected: FAIL, `Cannot find module './store.js'`.

- [ ] **Step 3: Write `store.ts`**

Create the three tables exactly as the spec's DDL prescribes (`github_actions`, `github_action_events`, `github_webhook_deliveries`, with every `CHECK`, `UNIQUE` and index listed there), plus:

```ts
export function ensureGitHubActionsSchema(database: Database.Database = getDb()): void {
  database.exec(`/* the three CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS from the spec */`);
}
```

Follow the row/­domain mapping idiom of `apps/api/src/github-monitor/store.ts`: private `Row` interfaces, `rowToAction`, `rowToEvent`, JSON columns parsed with a guard that throws on a non-array. `createGitHubActionEvent` wraps the insert in `try { ... } catch (error) { if (isUniqueViolation(error)) return null; throw error; }` where `isUniqueViolation` checks `error.code === "SQLITE_CONSTRAINT_UNIQUE"`. Retention in `recordWebhookDelivery`: every 100th insert, `DELETE FROM github_webhook_deliveries WHERE delivery_id NOT IN (SELECT delivery_id FROM github_webhook_deliveries ORDER BY received_at DESC LIMIT 2000)`.

- [ ] **Step 4: Add the supersede, dedupe and delivery tests**

```ts
test("supersedes a queued event when a newer commit lands on the same PR", () => { /* two events, same PR, different SHAs; assert the first is 'superseded' with reason 'head_superseded' and the second stays 'queued' */ });
test("rejects a second event for the same target identity at the same revision", () => { /* assert createGitHubActionEvent returns null */ });
test("accepts the same target identity again after a revision bump", () => { /* patch branchPatterns, assert revision === 2 and the insert succeeds */ });
test("reports a commit already analysed by the action", () => { /* launched event, then hasAnalysedCommit === true; a different SHA is false */ });
test("records a delivery once and reports the redelivery as duplicate", () => { /* same delivery_id twice → "recorded" then "duplicate" */ });
test("prunes deliveries beyond the retention ceiling", () => { /* insert 2150, assert count === 2000 and the newest survives */ });
```

- [ ] **Step 5: Run the store suite**

Run: `cd apps/api && node --test --import tsx src/github-actions/store.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Write the failing migration test**

```ts
// apps/api/src/github-actions/migrate-monitor-rules.test.ts
test("turns one monitor rule into a PR action and a push action", () => {
  const db = legacyDb(); // creates github_monitor_rules/_events with one enabled rule and 2 events
  const result = migrateMonitorRulesToActions(db);
  assert.deepEqual(result, { actions: 2, events: 2, skipped: 0 });
  const actions = listGitHubActions({ repositoryKey: "github:1" }, db);
  assert.deepEqual(actions.map((a) => [a.name, a.triggerKind, a.enabled]).sort(),
    [["PR", "pull_request", true], ["Push", "push", true]]);
  assert.deepEqual(actions[0]!.branchPatterns, ["main"]);
});

test("migrates a rule without a ceiling as disabled", () => { /* cost_ceiling_usd NULL → enabled false, costCeilingUsd 1, lastError 'migrated_without_ceiling' */ });
test("preserves the gate id on migrated events", () => { /* the event whose gate_id was 'g1' still carries it */ });
test("renames the legacy tables and is a no-op on the second run", () => {
  const db = legacyDb();
  migrateMonitorRulesToActions(db);
  assert.deepEqual(migrateMonitorRulesToActions(db), { actions: 0, events: 0, skipped: 0 });
  assert.ok(tableExists(db, "github_monitor_rules_migrated"));
  assert.ok(!tableExists(db, "github_monitor_rules"));
});
```

- [ ] **Step 7: Run it, watch it fail, implement the migration**

`migrateMonitorRulesToActions` runs inside `database.transaction(...).immediate()`, creates `github_actions_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`, returns early when version ≥ 1 is recorded, then performs steps 1–4 of the spec's migration section and renames `github_monitor_rules`, `github_monitor_events`, `github_monitor_actions_runs`, `github_monitor_poll_leases` with the `_migrated` suffix (skipping any table that does not exist). Call it from `ensureGitHubActionsSchema` so a cold boot is enough.

- [ ] **Step 8: Run the API suite**

Run: `cd apps/api && npm test`
Expected: PASS. The legacy `github-monitor/store.test.ts` still passes because the legacy module is untouched in this task.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/github-actions packages/shared/src/index.ts
git commit -m "feat(api): as many actions as the work needs, from the rules that existed"
```

---

### Task 1.2: Webhook secret custody, App manifest, and the Integration status service

**Files:**
- Modify: `apps/api/src/credentials/system-github-app-credential-store.ts` (accept an optional `webhookSecret`)
- Modify: `apps/api/src/credentials/system-github-app-credential-store.test.ts` (new file if absent)
- Modify: `apps/api/src/github-app/manifest-flow.ts:8-17`, `:139-150`
- Modify: `apps/api/src/github-app/manifest-flow.test.ts`
- Modify: `apps/api/src/github-app/github-app-client.ts:105-133` (surface `webhook_secret` to the consumer instead of only redacting it)
- Modify: `apps/api/src/github-app/github-app-service.ts` (persist it on manifest completion)
- Create: `apps/api/src/github-actions/integration-status.ts`
- Create: `apps/api/src/github-actions/integration-status.test.ts`

**Interfaces:**
- Consumes: `GitHubAppCredentialStore` from `apps/api/src/credentials/system-github-app-credential-store.js`; `listGitHubAppConnections` / `listGitHubAppInstallations` from `apps/api/src/github-app/github-app-store.js`.
- Produces:
  - `GitHubAppCredentials` gains `webhookSecret?: string` (16..256 chars, no NUL). `validCredentials` accepts `{ privateKeyPem }` **or** `{ privateKeyPem, webhookSecret }` and nothing else.
  - `GitHubAppCredentialStore.putWebhookSecret(connectionId: string, secret: string): Promise<void>` — reads, merges, writes, so the private key is never lost.
  - `GITHUB_APP_MANIFEST_EVENTS` becomes `Object.freeze(["pull_request", "push", "installation", "installation_repositories", "check_run", "workflow_run"] as const)`.
  - `GITHUB_APP_MANIFEST_PERMISSIONS.pull_requests` becomes `"write"`.
  - `GitHubAppManifest` gains `hook_attributes: { url: string; active: true }`; `GitHubAppManifestFlow.authorization()` fills it with `${publicOrigin}/api/github/webhook` (server mode) or omits the field when there is no public origin.
  - `ManifestAppExchange` gains `webhookSecret: string | null`.
  - `apps/api/src/github-actions/integration-status.ts`:
    ```ts
    export interface GitHubIntegrationStatus {
      connections: Array<{
        connectionId: string; appSlug: string; appName: string;
        webhookSecretConfigured: boolean;
        webhookUrl: string | null;
        permissions: Array<{ name: string; required: string; granted: string | null; ok: boolean }>;
        events: Array<{ name: string; subscribed: boolean }>;
        installations: Array<{
          installationId: string; account: string; repositorySelection: "all" | "selected";
          authorizedRepositoryCount: number; enrolledRepositoryCount: number; manageUrl: string;
        }>;
      }>;
      deliveries: { last: WebhookDeliveryRecord | null; last24h: { processed: number; ignored: number; failed: number } };
      reconciliation: { lastAt: string | null; recoveredLast24h: number };
      checklist: Array<{ id: GitHubChecklistItemId; ok: boolean }>;
    }
    export type GitHubChecklistItemId =
      | "app_installed" | "permissions" | "events" | "webhook_secret"
      | "repository_enrolled" | "action_enabled" | "baseline";
    export function buildGitHubIntegrationStatus(deps: GitHubIntegrationStatusDependencies): Promise<GitHubIntegrationStatus>;
    ```
    `GitHubIntegrationStatusDependencies` injects `listConnections`, `listInstallations`, `listRepositories`, `listActions`, `readBaselineState`, `readWebhookSecretConfigured`, `countDeliveries`, `lastDelivery`, `publicOrigin` — so the test needs no network.

- [ ] **Step 1: Write the failing credential-store test**

```ts
test("stores a webhook secret without losing the private key", async () => {
  const store = memoryStore();
  await store.put("c1", { privateKeyPem: RSA_PEM });
  await store.putWebhookSecret("c1", "s".repeat(32));
  assert.deepEqual(await store.get("c1"), { privateKeyPem: RSA_PEM, webhookSecret: "s".repeat(32) });
});
test("refuses a secret shorter than 16 characters", async () => { /* rejects with VaultError */ });
test("refuses an unknown field in the stored bundle", async () => { /* validCredentials throws on { privateKeyPem, nope: 1 } */ });
```

- [ ] **Step 2: Run, fail, implement**

Run: `cd apps/api && node --test --import tsx src/credentials/system-github-app-credential-store.test.ts`
Expected: FAIL, `store.putWebhookSecret is not a function`. Then relax `validCredentials` to the two allowed shapes, register the secret with the redactor exactly like the PEM, and add `putWebhookSecret`.

- [ ] **Step 3: Write the failing manifest test**

```ts
test("subscribes to the six events the product needs", () => {
  assert.deepEqual([...GITHUB_APP_MANIFEST_EVENTS].sort(), [
    "check_run", "installation", "installation_repositories", "pull_request", "push", "workflow_run",
  ]);
});
test("asks for pull_requests write", () => {
  assert.equal(GITHUB_APP_MANIFEST_PERMISSIONS.pull_requests, "write");
});
test("declares the webhook endpoint in the manifest", () => {
  const flow = newFlow({ deploymentOrigin: "https://sentinel.example" });
  const { manifest } = flow.authorization(flow.start().flowId);
  assert.deepEqual(manifest.hook_attributes, { url: "https://sentinel.example/api/github/webhook", active: true });
});
test("omits hook_attributes with no deployment origin", () => { /* loopback flow → manifest.hook_attributes === undefined */ });
```

- [ ] **Step 4: Run, fail, implement the manifest and the exchange**

In `github-app-client.ts`, keep the redaction registration and additionally put `webhookSecret: optionalSecret(body.webhook_secret)` on the `ManifestAppExchange` handed to `consume`. In `github-app-service.ts`, when the exchange completes, call `credentials.put(connectionId, { privateKeyPem, ...(webhookSecret ? { webhookSecret } : {}) })`.

- [ ] **Step 5: Write the failing integration-status test**

```ts
test("names the permission the App is missing", async () => {
  const status = await buildGitHubIntegrationStatus(deps({ granted: { checks: "write", pull_requests: "read" } }));
  const pr = status.connections[0]!.permissions.find((p) => p.name === "pull_requests")!;
  assert.deepEqual(pr, { name: "pull_requests", required: "write", granted: "read", ok: false });
});
test("names the events the App does not subscribe to", async () => { /* subscribed: ["push"] → pull_request.subscribed === false */ });
test("never reports the webhook secret value", async () => {
  const status = await buildGitHubIntegrationStatus(deps({ webhookSecret: "super-secret-value" }));
  assert.equal(status.connections[0]!.webhookSecretConfigured, true);
  assert.ok(!JSON.stringify(status).includes("super-secret-value"));
});
test("points at the installation page when the scope is 'selected'", async () => {
  const status = await buildGitHubIntegrationStatus(deps({ repositorySelection: "selected", installationId: "42" }));
  assert.equal(status.connections[0]!.installations[0]!.manageUrl, "https://github.com/settings/installations/42");
});
test("fails the checklist at the first unmet step", async () => { /* no enabled action → action_enabled.ok === false, baseline.ok === false */ });
```

- [ ] **Step 6: Run, fail, implement `integration-status.ts`, run the API suite**

Run: `cd apps/api && npm test`
Expected: PASS.

- [ ] **Step 7: Write the operator setup documentation now, not in Phase 5**

The operator has to widen an existing App's permissions and events before Phase 1 is of any use, so `docs/dokploy.md` gains its **GitHub App e webhook** section in this task, carrying the spec's "Setup do operador" content verbatim: the six permissions, the six events, the webhook URL `https://sentinel.okamilab.com/api/github/webhook` with content type `application/json`, that a manifest-created App needs nothing because the generated secret is captured, that an existing App needs the secret generated on GitHub and pasted in Integração → Webhook, that **no** new environment variable holds a secret, the optional `CSB_GITHUB_RECONCILE_INTERVAL_MS`, the reverse-proxy requirements (never rewrite `X-Hub-Signature-256`, `X-GitHub-Event` or `X-GitHub-Delivery`; allow a 1 MiB body), and how to widen the installation's repository selection. Task 5.3 only revisits it if Phases 2–4 changed a requirement.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/credentials apps/api/src/github-app apps/api/src/github-actions/integration-status.ts apps/api/src/github-actions/integration-status.test.ts docs/dokploy.md
git commit -m "feat(api): the secret the App already generated, kept where the key lives"
```

---

### Task 1.3: The webhook endpoint — signature, idempotency, and the event → action → gate map

**Files:**
- Create: `apps/api/src/github-actions/webhook-signature.ts`
- Create: `apps/api/src/github-actions/webhook-signature.test.ts`
- Create: `apps/api/src/github-actions/webhook-ingest.ts`
- Create: `apps/api/src/github-actions/webhook-ingest.test.ts`
- Create: `apps/api/src/github-actions/webhook-api.ts`
- Create: `apps/api/src/github-actions/webhook-api.test.ts`
- Create: `apps/api/src/github-actions/branch-patterns.ts`
- Create: `apps/api/src/github-actions/branch-patterns.test.ts`
- Modify: `apps/api/src/server-security.ts:36-46` (exempt the webhook)
- Modify: `apps/api/src/auth/route-policy.ts:46` (add the route)
- Modify: `apps/api/src/app.ts:765-771` (mount the app **before** `githubIntegrationSecurity`)

**Interfaces:**
- Consumes: Task 1.1's store functions; Task 1.2's `GitHubAppCredentialStore`; `dispatchGitHubActionEvent` is **not** available yet — this task injects it as `deps.dispatch` and Task 1.4 supplies the production implementation. Until then `app.ts` wires `deps.dispatch` to the existing `automaticGitHubScanDispatcher` created at `app.ts:773-787`.
- Produces:
  - `verifyGitHubSignature(input: { body: Uint8Array; header: string | undefined; secrets: ReadonlyArray<{ connectionId: string; secret: string }> }): { connectionId: string } | null` — constant-time, length-guarded, at most 20 secrets tried in the given order.
  - `matchesBranchPattern(pattern: string, branch: string): boolean` and `matchesAnyBranchPattern(patterns: readonly string[], branch: string): boolean` — `*` matches within one segment, `**` across segments, exact otherwise.
  - ```ts
    export interface GitHubWebhookIngestResult {
      outcome: "processed" | "ignored" | "duplicate" | "failed";
      reason: string | null;
      eventIds: string[];
      matchedActionIds: string[];
    }
    export interface GitHubWebhookIngestDependencies {
      now(): string;
      listSecrets(): Promise<Array<{ connectionId: string; secret: string }>>;
      findRepository(connectionId: string, githubRepositoryId: string): GuardrailRepository | null;
      listActions(repositoryKey: string): GitHubAction[];
      createEvent(input: GitHubActionEventCreate): GitHubActionEvent | null;
      supersede(input: Parameters<typeof supersedeQueuedEvents>[0]): number;
      hasAnalysedCommit(actionId: string, headSha: string): boolean;
      recordDelivery(input: WebhookDeliveryRecord): "recorded" | "duplicate";
      disableActionsForRepository(repositoryKey: string, reason: string): void;
      refreshInstallationRepositories(installationId: string): Promise<void>;
      dispatch(eventId: string): void;
      rerunGate(checkRunExternalId: string, headSha: string): GitHubActionEvent | null;
      importWorkflowRun?(workflowRunId: string): void;
    }
    export function ingestGitHubWebhook(
      input: { body: Uint8Array; headers: { event: string; delivery: string; signature: string | undefined } },
      deps: GitHubWebhookIngestDependencies,
    ): Promise<GitHubWebhookIngestResult>;
    ```
  - `createGitHubWebhookApp(deps: GitHubWebhookIngestDependencies & { failureWindow?: FailureWindow }): Hono` exposing `POST /github/webhook`.

- [ ] **Step 1: Write the failing signature test, including the raw-bytes case (Review Focus 1)**

```ts
// apps/api/src/github-actions/webhook-signature.test.ts
import { createHmac } from "node:crypto";
const sign = (secret: string, body: Uint8Array) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("accepts a payload with multi-byte characters", () => {
  const body = new TextEncoder().encode(JSON.stringify({ title: "Corrige acentuação — ação" }));
  const header = sign("s1", body);
  assert.deepEqual(verifyGitHubSignature({ body, header, secrets: [{ connectionId: "c1", secret: "s1" }] }), { connectionId: "c1" });
  // The same payload re-serialized after a parse changes no byte here, so also
  // assert on a body whose bytes cannot survive a round trip:
  const raw = new TextEncoder().encode('{"a":1,  "b":"\\u00e9"}');
  assert.ok(verifyGitHubSignature({ body: raw, header: sign("s1", raw), secrets: [{ connectionId: "c1", secret: "s1" }] }));
  const reserialized = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(raw))));
  assert.equal(verifyGitHubSignature({ body: reserialized, header: sign("s1", raw), secrets: [{ connectionId: "c1", secret: "s1" }] }), null);
});

test("picks the connection whose secret matches", () => { /* three secrets, the third matches */ });
test("returns null with no secrets configured", () => {
  assert.equal(verifyGitHubSignature({ body: new Uint8Array([1]), header: "sha256=ab", secrets: [] }), null);
});
test("rejects a missing header, a header without the sha256= prefix, a non-hex digest and a truncated digest", () => { /* four asserts, all null, none throwing */ });
test("tries at most twenty secrets", () => { /* 25 secrets, the 25th matches → null */ });
```

- [ ] **Step 2: Run, fail, implement `webhook-signature.ts`**

Run: `cd apps/api && node --test --import tsx src/github-actions/webhook-signature.test.ts`

```ts
export function verifyGitHubSignature(input: VerifyInput): { connectionId: string } | null {
  const header = input.header?.trim() ?? "";
  if (!header.startsWith("sha256=")) return null;
  const provided = Buffer.from(header.slice(7), "hex");
  if (provided.length !== 32 || !/^[0-9a-f]{64}$/i.test(header.slice(7))) return null;
  for (const { connectionId, secret } of input.secrets.slice(0, 20)) {
    const expected = createHmac("sha256", secret).update(input.body).digest();
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) return { connectionId };
  }
  return null;
}
```

- [ ] **Step 3: Write and satisfy the branch-pattern test**

```ts
test("matches a literal branch", () => { assert.ok(matchesBranchPattern("main", "main")); assert.ok(!matchesBranchPattern("main", "mainline")); });
test("matches one segment with a single star", () => { assert.ok(matchesBranchPattern("release/*", "release/9")); assert.ok(!matchesBranchPattern("release/*", "release/9/rc1")); });
test("matches across segments with a double star", () => { assert.ok(matchesBranchPattern("release/**", "release/9/rc1")); });
test("escapes regex metacharacters in the pattern", () => { assert.ok(matchesBranchPattern("fix.a+b", "fix.a+b")); assert.ok(!matchesBranchPattern("fix.a+b", "fixXaab")); });
```

- [ ] **Step 4: Write the failing ingestion test with the whole event map**

```ts
// apps/api/src/github-actions/webhook-ingest.test.ts
test("creates one event per matching action on pull_request.opened", async () => {
  const harness = ingestHarness({ actions: [prAction({ patterns: ["main"] }), pushAction({ patterns: ["main"] })] });
  const result = await harness.deliver("pull_request", { action: "opened", number: 7,
    pull_request: { number: 7, base: { ref: "main" }, head: { ref: "topic", sha: "a".repeat(40) }, title: "Add gate" },
    repository: { id: 1 } });
  assert.equal(result.outcome, "processed");
  assert.equal(result.eventIds.length, 1);
  assert.deepEqual(harness.events()[0]!.targetIdentity, `pr:7@${"a".repeat(40)}`);
});

test("ignores a pull_request action the product does not handle", async () => { /* action: "labeled" → ignored / action_not_handled, still recorded */ });
test("supersedes the queued event when a synchronize brings a new commit", async () => { /* first opened, then synchronize → first 'superseded'/'head_superseded' */ });
test("supersedes the queued event when the PR closes and scans nothing", async () => { /* closed → ignored / pull_request_closed, 0 new events, 1 superseded */ });
test("ignores a push whose after is all zeros", async () => { /* ignored / branch_deleted */ });
test("ignores a ref outside refs/heads", async () => { /* refs/tags/v1 → ignored / ref_not_branch */ });
test("ignores a push to an unfollowed branch", async () => { /* ignored / branch_not_followed */ });
test("ignores a repository that is not enrolled", async () => { /* findRepository → null → ignored / repository_not_enrolled */ });
test("ignores a disabled repository", async () => { /* ignored / repository_disabled */ });
test("skips a commit the action already analysed", async () => { /* hasAnalysedCommit → event created with status 'skipped' and reason 'commit_already_analysed', not dispatched */ });
test("disables actions when installation_repositories removes the repository", async () => { /* disableActionsForRepository called with 'repository_unauthorized' */ });
test("reruns the gate on check_run.rerequested with a manual origin", async () => { /* origin 'manual', targetIdentity ends with '#rerun:99' */ });
test("answers duplicate on a redelivered delivery id", async () => { /* recordDelivery → 'duplicate' → outcome 'duplicate', no events */ });
test("ignores an unhandled event type", async () => { /* 'star' → ignored / event_not_handled */ });
test("answers processed for ping without creating an event", async () => { /* processed, 0 events */ });
test("records the delivery only after the signature is verified", async () => {
  const harness = ingestHarness({});
  const result = await harness.deliverUnsigned("pull_request", { action: "opened" });
  assert.equal(result.outcome, "failed");
  assert.equal(harness.deliveries().length, 0);
});
test("survives two concurrent deliveries for the same commit", async () => { // Review Focus 3
  const harness = ingestHarness({ actions: [prAction({ patterns: ["main"] })] });
  const payload = prPayload({ number: 7, sha: "a".repeat(40) });
  const [first, second] = await Promise.all([
    harness.deliver("pull_request", payload, { delivery: "d1" }),
    harness.deliver("pull_request", payload, { delivery: "d2" }),
  ]);
  assert.equal(harness.events().length, 1);
  assert.equal([first, second].filter((r) => r.eventIds.length === 1).length, 1);
  assert.equal(harness.dispatched().length, 1);
});
```

- [ ] **Step 5: Run, fail, implement `webhook-ingest.ts`**

Order of operations, exactly: verify signature → parse JSON (a parse failure is `failed`/`malformed_payload`, recorded) → `recordDelivery` with `outcome` still provisional inside one `database.transaction(...).immediate()` together with event creation and supersession → return. `deps.dispatch(eventId)` is called **after** the transaction commits, never inside it. Every `reason` is a fixed snake_case code from the spec's table; no free text ever reaches the delivery row.

- [ ] **Step 6: Write the failing HTTP test**

```ts
// apps/api/src/github-actions/webhook-api.test.ts
test("answers 200 processed for a signed delivery", async () => { /* status 200, body { status: "processed" } */ });
test("answers 401 signature_invalid with no secret configured", async () => { // Review Focus 5
  const app = createGitHubWebhookApp(deps({ secrets: [] }));
  const response = await app.request("http://localhost/github/webhook", signedRequest("s1"));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "signature_invalid" });
});
test("answers 400 for a missing delivery id or event name", async () => { /* malformed_delivery */ });
test("answers 413 above one mebibyte and records nothing", async () => { /* payload_too_large, deliveries().length === 0 */ });
test("answers 429 after thirty bad signatures from one address", async () => { /* 30 × 401 then 429 rate_limited */ });
test("answers 200 duplicate on a redelivery", async () => {});
test("never echoes the payload", async () => { /* body length <= 200 and does not contain the PR title */ });
```

- [ ] **Step 7: Run, fail, implement `webhook-api.ts`**

Read the body with `new Uint8Array(await c.req.arrayBuffer())`; if `content-length` exceeds `1_048_576`, or the read exceeds it, answer 413 before any work. Rate limit with `new FailureWindow(30, 5 * 60_000)` keyed by the client IP resolved the same way `apps/api/src/auth/login-client-ip.ts` resolves it, plus a module-level accepted-delivery counter of 600 per rolling minute answering `429 rate_limited`.

- [ ] **Step 8: Wire the route and its two exemptions, with tests**

In `route-policy.ts` add `["POST", "/github/webhook", PUBLIC],`. In `server-security.ts`, next to the existing `callback` constant, add:

```ts
const webhook = c.req.method === "POST" && c.req.path === "/api/github/webhook";
```

and include `!webhook` in both the Origin/`Sec-Fetch-Site` guard and the `PUBLIC_API` mutation guard, and return `next()` for it before the session lookup. Add to `apps/api/src/server-app.test.ts`:

```ts
test("lets a signed webhook through with no session, no Origin and no CSRF token", async () => { /* 200 */ });
test("denies a webhook post carrying a foreign Origin", async () => { /* 403 origin_denied */ });
```

and to `apps/api/src/auth/route-policy.test.ts`:

```ts
test("the webhook is the only public route that mutates state", () => {
  const publicMutations = ROUTE_POLICY.filter(([method, , requirement]) =>
    requirement.kind === "public" && !["GET", "HEAD", "OPTIONS"].includes(method));
  assert.deepEqual(publicMutations.map(([method, pattern]) => `${method} ${pattern}`).sort(), [
    "POST /auth/invites/:token", "POST /auth/login", "POST /github/webhook",
  ]);
});
```

Mount in `app.ts` with `app.route("/", createGitHubWebhookApp({ ... }))` placed **before** the `for (const route of [...]) app.use(route, githubIntegrationSecurity())` loop, and make sure no pattern in that loop matches `/github/webhook`.

- [ ] **Step 9: Run the suites**

Run: `cd apps/api && npm test`
Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/github-actions apps/api/src/server-security.ts apps/api/src/auth/route-policy.ts apps/api/src/app.ts apps/api/src/server-app.test.ts apps/api/src/auth/route-policy.test.ts
git commit -m "feat(api): a door only GitHub can knock on, and only once per knock"
```

---

### Task 1.4: The reconciler replaces the poller

**Files:**
- Create: `apps/api/src/github-actions/reconciler.ts`
- Create: `apps/api/src/github-actions/reconciler.test.ts`
- Create: `apps/api/src/github-actions/dispatch.ts`
- Create: `apps/api/src/github-actions/dispatch.test.ts`
- Modify: `apps/api/src/index.ts:169` (`githubMonitor.startPolling()` → `startGitHubReconciler()`)
- Modify: `apps/api/src/app.ts:773-809` (build the dispatcher against actions; drop the monitor service)
- Modify: `apps/api/src/config.ts` (add `GITHUB_RECONCILE_INTERVAL_MS`)
- Delete: `apps/api/src/github-monitor/service.ts`, `service.test.ts`, `api.ts`, `api.test.ts`, `store.ts`, `store.test.ts`
- Modify: `apps/api/src/github-monitor-dispatch.ts` (keep; retarget its input type at `GitHubActionEvent`)

**Interfaces:**
- Consumes: Task 1.1's store, Task 1.3's `GitHubWebhookIngestDependencies.dispatch` contract.
- Produces:
  - `dispatchGitHubActionEvent(eventId: string, deps?: GitHubActionDispatchDependencies): Promise<void>` in `dispatch.ts`, preserving every guarantee the current dispatcher has: revalidate the authority triple (`connectionId`/`installationId`/`repositoryId` against the repository row, else `github_action_authority_invalid`), reserve against the UTC-day budget (`reservedGitHubActionCostForUtcDay`, ported from `github-monitor/store.ts:509-524`), create and accept a `TargetPreview`, abort as `skipped`/`head_superseded` when the head SHA moved, verify the policy budget against `costCeilingUsd`, re-check `revision`, then `startManaged` or `startActions`. Pre-dispatch refusals become `skipped` with the code; post-dispatch ambiguity becomes `failed` and is never retried.
  - `reconcileGitHubActions(deps: GitHubReconcilerDependencies): Promise<{ repositories: number; created: number; observed: number; errors: number }>`
  - `startGitHubReconciler(intervalMs?: number): () => void` — `setInterval(...).unref()`, non-overlapping via an in-flight flag, default `GITHUB_RECONCILE_INTERVAL_MS`, clamped to `[300_000, 3_600_000]`.
  - `reconcileOrphanedGitHubActionDispatches(): number` — ported from `github-monitor/service.ts:156-158`.

- [ ] **Step 1: Write the failing reconciler test**

```ts
test("creates nothing when no commit moved", async () => {
  const harness = reconcilerHarness({ actions: [prAction()], openPullRequests: [{ number: 7, baseRef: "main", headRef: "t", headSha: SHA_A, title: "t" }], events: [launchedEvent({ targetIdentity: `pr:7@${SHA_A}` })] });
  assert.deepEqual(await harness.run(), { repositories: 1, created: 0, observed: 0, errors: 0 });
});
test("creates an event for a commit the webhook missed", async () => { /* open PR at SHA_B, last event at SHA_A → created 1, status 'queued', origin 'reconciliation' */ });
test("creates nothing for a SHA any event of the action already carries", async () => { /* a 'skipped' event at SHA_B → created 0 */ });
test("marks the first run as observed and never scans the backlog", async () => {
  const harness = reconcilerHarness({ actions: [prAction({ baselineInitializedAt: null })], openPullRequests: threeOpenPrs() });
  assert.deepEqual(await harness.run(), { repositories: 1, created: 0, observed: 3, errors: 0 });
  assert.equal(harness.dispatched().length, 0);
  assert.ok(harness.action().baselineInitializedAt);
});
test("treats an edited action as new again", async () => { /* patch branchPatterns → revision 2, baselineInitializedAt null → next run observes, dispatches nothing */ });
test("skips a repository whose actions are all disabled and makes no remote call", async () => { /* harness.remoteCalls() === 0 */ });
test("records the error on the action and keeps going", async () => { /* one repository throws → errors 1, the other still reconciles */ });
test("stops branch listing at two pages and PR listing at three", async () => { /* assert page counts */ });
```

- [ ] **Step 2: Run, fail, implement `reconciler.ts`**

Run: `cd apps/api && node --test --import tsx src/github-actions/reconciler.test.ts`

- [ ] **Step 3: Write the failing dispatch test**

```ts
test("refuses when the head SHA moved between queue and dispatch", async () => { /* status 'skipped', reason 'head_superseded', no gate */ });
test("keeps the event queued when the daily ceiling is spent", async () => { /* reason 'daily_cost_ceiling', still 'queued' */ });
test("refuses when the authority triple no longer matches the repository", async () => { /* 'skipped'/'github_action_authority_invalid' */ });
test("refuses when the revision changed after the reservation", async () => { /* 'skipped'/'action_revision_changed' */ });
test("records an ambiguous post-dispatch failure as failed and never retries", async () => { /* status 'failed', dispatch twice → one start call */ });
test("crosses the UTC-day boundary correctly", async () => { // Review Focus, cost
  // A dispatch at 23:59:59Z exhausts the ceiling; a dispatch at 00:00:01Z the next day succeeds.
});
```

- [ ] **Step 4: Run, fail, implement `dispatch.ts` by porting `github-monitor/service.ts:350-428` and `github-monitor-dispatch.ts`**

- [ ] **Step 5: Delete the monitor service and API, rewire `index.ts` and `app.ts`**

`index.ts:169` becomes `const stopGitHubReconciler = startGitHubReconciler();` and the shutdown handler calls it. Remove the `githubMonitor` export from `app.ts` and every import of `apps/api/src/github-monitor/*`. Remove `POST /github-monitor/poll`, `/github-monitor/rules`, `/github-monitor/overview`, `/github-monitor/events`, `/github-monitor/actions-runs` from `ROUTE_POLICY` (Task 1.5 adds the replacements) and delete `"monitorRule"` from `RepositorySource`.

- [ ] **Step 6: Run the suites**

Run: `cd apps/api && npm test`
Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm typecheck`
Expected: PASS. The route-policy coverage test will fail until Task 1.5 if any handler still answers a removed path — delete the handlers in this task, not just the policy rows.

- [ ] **Step 7: Commit**

```bash
git add -A apps/api/src
git commit -m "fix(api): stop asking every minute what nobody changed"
```

---

### Task 1.5: HTTP API for actions, events, deliveries and integration

**Files:**
- Create: `apps/api/src/github-actions/api.ts`
- Create: `apps/api/src/github-actions/api.test.ts`
- Modify: `apps/api/src/auth/route-policy.ts` (add the nine routes and the `"action"` source)
- Modify: `apps/api/src/auth/route-policy.test.ts`
- Modify: `apps/api/src/app.ts` (mount, and extend `githubIntegrationSecurity` to `/github/*` except the webhook)

**Interfaces:**
- Consumes: Task 1.1 store, Task 1.2 `buildGitHubIntegrationStatus` and `putWebhookSecret`, Task 1.4 `reconcileGitHubActions`.
- Produces `createGitHubActionsApi(deps): Hono` with:
  - `GET /github/integration` → `GitHubIntegrationStatus` (admin)
  - `PUT /github/integration/webhook-secret` → body `{ connectionId: string; secret: string }`, 204 (admin). Never returns the value.
  - `GET /github/deliveries?limit=200` → `{ deliveries: WebhookDeliveryRecord[] }` (admin)
  - `POST /github/reconcile` → `{ repositories, created, observed, errors }` (admin)
  - `GET /github/actions?repositoryKey=` → `{ actions: GitHubAction[] }` (scoped, filtered by grants)
  - `POST /github/actions` → 201 `{ action }` (admin)
  - `PATCH /github/actions/:actionId` → `{ action }` (maintainer on the action's repository; **admin** when the patch sets `enabled: true` or touches `executor`, `connectionId`, `scanner`, `costCeilingUsd`, `dailyCostCeilingUsd`, or when the action is currently enabled and the patch touches `name`/`branchPatterns`/`triggerKind`)
  - `DELETE /github/actions/:actionId` → 204 (maintainer on the action's repository)
  - `GET /github/actions/:actionId/events?limit=100` → `{ events }` (viewer on the action's repository)
  - `GET /github/events?repositoryKey=&outcome=&limit=100` → `{ events }` (scoped)
  - `GET /github/branches?repositoryKey=` → `{ branches }` (scoped) — the handler ported from `github-monitor/api.ts:31-39`
- Produces in `route-policy.ts`: `RepositorySource` gains `"action"`, resolved by `getGitHubAction(c.req.param("actionId"))?.repositoryKey`.

- [ ] **Step 1: Write the failing route-policy coverage and cost-rule tests**

```ts
// apps/api/src/auth/route-policy.test.ts
test("declares every route the API registers", () => { /* the existing coverage test, now green with the new paths */ });

// apps/api/src/github-actions/api.test.ts
test("lets an administrator create an action", async () => { /* 201 */ });
test("refuses an action created by a maintainer", async () => { /* 403 forbidden */ });
test("lets a maintainer disable an action", async () => { /* PATCH { enabled: false } → 200 */ });
test("refuses a maintainer enabling an action", async () => { /* PATCH { enabled: true } → 403 */ });
test("refuses a maintainer renaming an enabled action", async () => { /* 403 */ });
test("lets a maintainer rename a disabled action", async () => { /* 200 */ });
test("lets a maintainer delete an action", async () => { /* 204 */ });
test("never returns the webhook secret", async () => { /* PUT then GET /github/integration → no 'super-secret' anywhere */ });
test("answers the same code for an unknown and an unshared repository", async () => {
  // POST /github/actions for repositoryKey 'github:404' and for a repository the caller cannot see
  // must both answer 404 with { error: "repository_not_found" }, so the error cannot enumerate.
});
test("scopes GET /github/actions to the caller's grants", async () => { /* a viewer of repo A never sees repo B's actions */ });
test("validates branch patterns and the cost ceiling", async () => { /* 21 patterns → 400 invalid_branch_patterns; ceiling 0 → 400 invalid_cost_ceiling */ });
test("refuses an action for a local repository", async () => { /* 400 repository_source_unsupported */ });
```

- [ ] **Step 2: Run, fail, implement `api.ts` and the policy rows**

Run: `cd apps/api && node --test --import tsx src/github-actions/api.test.ts`

The `PATCH` privilege split lives in one exported pure function so it is testable alone:

```ts
export function patchRequiresAdmin(action: GitHubAction, patch: GitHubActionPatch): boolean {
  const spending: Array<keyof GitHubActionPatch> = ["executor", "connectionId", "installationId", "repositoryId", "scanner", "costCeilingUsd", "dailyCostCeilingUsd"];
  if (patch.enabled === true) return true;
  if (spending.some((key) => patch[key] !== undefined)) return true;
  const shape: Array<keyof GitHubActionPatch> = ["name", "branchPatterns", "triggerKind"];
  return action.enabled && shape.some((key) => patch[key] !== undefined);
}
```

- [ ] **Step 3: Mount and guard**

In `app.ts`, replace the `/github-monitor/*` entry of the `githubIntegrationSecurity` loop with `/github/*`, and add a guard inside `githubIntegrationSecurity` — or a narrower mount list — so `POST /github/webhook` is not subjected to the Origin/CSRF check. A test asserts both: the webhook passes, `POST /github/actions` without a CSRF token answers `403 csrf_invalid`.

- [ ] **Step 4: Run the suites and commit**

Run: `cd apps/api && npm test`
Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm typecheck`

```bash
git add apps/api/src
git commit -m "feat(api): routes for actions that spend, with the role that may spend"
```

---

### Task 1.6: The GitHub tab — Integration, Actions, Activity

**Files:**
- Rewrite: `apps/web/src/pages/GitHubMonitorPage.tsx` → `apps/web/src/pages/GitHubPage.tsx`
- Create: `apps/web/src/components/github/IntegrationPanel.tsx`
- Create: `apps/web/src/components/github/ActionList.tsx`
- Create: `apps/web/src/components/github/ActionSheet.tsx`
- Create: `apps/web/src/components/github/DeliveryList.tsx`
- Create: `apps/web/src/components/github/ActivityList.tsx`
- Create: `apps/web/src/lib/github-actions-api.ts`
- Create: `apps/web/src/lib/github-actions-api.test.ts`
- Create: `apps/web/src/lib/github-action-form.ts`
- Create: `apps/web/src/lib/github-action-form.test.ts`
- Create: `apps/web/src/i18n/github-actions.ts`
- Delete: `apps/web/src/lib/github-monitor-state.ts`, `github-monitor-state.test.ts`, `github-monitor-api.ts`, `github-monitor-api.test.ts`, `apps/web/src/i18n/github-monitor.ts`
- Modify: `apps/web/src/App.tsx:32`, `:187`
- Modify: `apps/web/e2e/github-monitor.spec.ts` → `apps/web/e2e/github.spec.ts`

**Interfaces:**
- Consumes: the ten routes of Task 1.5.
- Produces:
  - `apps/web/src/lib/github-actions-api.ts`: `fetchIntegration()`, `saveWebhookSecret(connectionId, secret)`, `fetchDeliveries(limit)`, `reconcileNow()`, `fetchActions(repositoryKey?)`, `createAction(draft)`, `patchAction(id, patch)`, `deleteAction(id)`, `fetchActionEvents(id)`, `fetchEvents(filter)`, `fetchBranches(repositoryKey)` — all through the existing `apiFetch` helper in `apps/web/src/lib/http.ts`.
  - `apps/web/src/lib/github-action-form.ts`:
    ```ts
    export interface GitHubActionDraft {
      repositoryKey: string; name: string; triggerKind: "pull_request" | "push";
      branchPatterns: string; executor: "sentinel-managed" | "github-actions";
      connectionId: string | null; model: string | null; effort: string | null;
      mode: "standard" | "deep"; costCeilingUsd: string; dailyCostCeilingUsd: string; enabled: boolean;
    }
    export function initialGitHubActionDraft(repositoryKey: string): GitHubActionDraft;
    export function draftFromAction(action: GitHubAction): GitHubActionDraft;
    export function validateGitHubActionDraft(draft: GitHubActionDraft, context: { isAdmin: boolean }):
      { ok: true; body: GitHubActionCreate } | { ok: false; errors: GitHubActionFieldError[] };
    export type GitHubActionFieldError =
      | { field: "name"; code: "required" | "too_long" }
      | { field: "branchPatterns"; code: "required" | "too_many" | "invalid" }
      | { field: "costCeilingUsd"; code: "required" | "not_positive" }
      | { field: "dailyCostCeilingUsd"; code: "not_positive" | "below_per_scan" }
      | { field: "connectionId"; code: "required" }
      | { field: "enabled"; code: "admin_only" };
    ```
  - `githubActionsMessages: ScopedMessages<...>` in all five locales.

- [ ] **Step 1: Write the failing form test**

```ts
// apps/web/src/lib/github-action-form.test.ts
test("requires a name, a pattern and a positive ceiling", () => { /* three errors */ });
test("splits comma-separated patterns and trims them", () => { /* "main, release/** " → ["main","release/**"] */ });
test("refuses more than twenty patterns and an invalid pattern", () => {});
test("refuses a daily ceiling below the per-scan ceiling", () => {});
test("requires a connection for the sentinel-managed executor", () => {});
test("refuses enabled: true for a non-administrator", () => { /* { field: "enabled", code: "admin_only" } */ });
test("round-trips an action through draftFromAction and validate", () => {});
```

- [ ] **Step 2: Run, fail, implement**

Run: `cd apps/web && npx tsx --test src/lib/github-action-form.test.ts`

- [ ] **Step 3: Write and satisfy the API-client test**

Mirror `apps/web/src/lib/github-monitor-api.test.ts`: a stubbed `fetch` asserts each method's URL, verb, and that a 403 surfaces as a typed error the page can translate.

- [ ] **Step 4: Build the page and its four components**

Three numbered sections, matching the existing Settings/Guardrails visual grammar (`01 INTEGRAÇÃO`, `02 AÇÕES`, `03 ATIVIDADE`):

- `IntegrationPanel` — App identity; the permissions table rendering `ok: false` rows in the warning tone with the installation review link; the events table; the installation scope row with **Ampliar seleção de repositórios** pointing at `manageUrl`; the webhook block (copyable URL, `configurado`/`ausente`, a password input plus "Substituir segredo", 24 h counters, "Reconciliar agora"); the seven-item checklist. Admin-only editing; other roles see it read-only.
- `ActionList` + `ActionSheet` — repository selector over **every** enrolled repository plus "Todos os repositórios"; the table with the spec's columns; create/edit/delete in the sheet; both executor cards always rendered, `sentinel-managed` disabled with the admin explanation for non-admins; a local repository selected renders an explanation instead of the form.
- `DeliveryList` and `ActivityList` — with the ignore reason spelled out in words, never as a raw code.

Remove the three decorative `✓` cards and the whole checkout panel; do not re-add the enrollment form (it lives in Guardrails now, Task 2.4).

- [ ] **Step 5: Add the five locales and run the i18n parity test**

Run: `cd apps/web && npx tsx --test src/lib/i18n.test.ts`
Expected: PASS. Every `githubActions.*` key present in `pt-BR`, `en`, `es`, `fr`, `de`.

- [ ] **Step 6: Rewrite the e2e spec**

`apps/web/e2e/github.spec.ts`, against the mocked API fixtures in `apps/web/e2e/fixtures.ts`:

```ts
test("names the permission and the event the App is missing", async ({ page }) => {});
test("pastes a webhook secret and shows it as configured", async ({ page }) => {});
test("creates two actions on one repository with different events", async ({ page }) => {});
test("disables an action as a maintainer and cannot enable it", async ({ page }) => {});
test("explains why a local repository cannot be automated", async ({ page }) => {});
test("lists deliveries with the ignore reason in words", async ({ page }) => {});
```

- [ ] **Step 7: Visual QA and Playwright cleanup**

Run: `cd apps/web && pnpm test && pnpm build && pnpm test:e2e`
Then verify the three sections at 1440×900 and at the Pixel 7 viewport the config already runs. Per `AGENTS.md`: remove only the temporary artifacts this task produced in `.playwright-cli/`, `test-results/` and `output/` (intermediate screenshots, traces, videos, snapshots, YAMLs, logs), move any final evidence to its destination first, and never touch `output/worktree-archives/` or artifacts belonging to another task. Then run `git status --short` and confirm no Playwright artifact remains staged or untracked.

- [ ] **Step 8: Full verification and commit**

Run: `cd apps/api && npm test`
Run: `cd apps/web && pnpm test && pnpm build`
Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm typecheck`
Run: `pnpm check:repository`

```bash
git add -A apps/web docs
git commit -m "feat(web): an integration screen that says what is missing, and actions that are plural"
```

**Phase 1 gate:** all four commands green, `git status --short` clean. This is the Phase 1 PR.

---

# Phase 2 — Bulk repositories, editable policy, automatic baseline

Ships: the first PR of a freshly enrolled repository returns a useful verdict instead of `baseline_absent`.

### Task 2.1: Policy storage and the three-level precedence

**Files:**
- Create: `apps/api/src/guardrails/policy-store.ts`
- Create: `apps/api/src/guardrails/policy-store.test.ts`
- Create: `apps/api/src/guardrails/policy-precedence.ts`
- Create: `apps/api/src/guardrails/policy-precedence.test.ts`
- Create: `apps/api/src/guardrails/policy-presets.ts`
- Create: `apps/api/src/guardrails/policy-presets.test.ts`
- Modify: `apps/api/src/guardrails/protected-policy-loader.ts` (report an invalid file instead of falling back)
- Modify: `apps/api/src/app.ts:458-533` (`GET`/`PUT`/`simulate`)
- Modify: `packages/gate-core/src/artifact.ts` (`policySource` enum)

**Interfaces:**
- Produces:
  - `policy-store.ts`: `ensureRepositoryPolicySchema(db?)`, `getRepositoryPolicy(repositoryKey, db?): { policy: GuardrailPolicy; preset: GuardrailPolicyPreset; updatedAt: string; updatedBy: string | null } | null`, `putRepositoryPolicy(repositoryKey, policy, preset, updatedBy, db?, now?)`, `deleteRepositoryPolicy(repositoryKey, db?)`.
  - `policy-presets.ts`: `GuardrailPolicyPreset = "block-critical-high" | "block-critical" | "warn-only" | "custom"`, `policyForPreset(preset, protectedBranches): GuardrailPolicy`, `presetForPolicy(policy): GuardrailPolicyPreset`.
  - `policy-precedence.ts`:
    ```ts
    export type ResolvedPolicySource = "repository_file" | "sentinel" | "default";
    export interface ResolvedGuardrailPolicy {
      policy: GuardrailPolicy;
      source: ResolvedPolicySource;
      readOnly: boolean;
      fileInvalidReason: string | null;
    }
    export function resolveGuardrailPolicy(input: {
      protectedFile: { present: boolean; policy: GuardrailPolicy | null; invalidReason: string | null };
      sentinel: GuardrailPolicy | null;
    }): ResolvedGuardrailPolicy;
    ```
  - `GateArtifactV2.policy.source` accepts the three values; the parser rejects anything else.

- [ ] **Step 1: Write the failing precedence test**

```ts
test("the repository file wins and the editor is read-only", () => {
  const resolved = resolveGuardrailPolicy({ protectedFile: { present: true, policy: FILE_POLICY, invalidReason: null }, sentinel: SENTINEL_POLICY });
  assert.deepEqual(resolved, { policy: FILE_POLICY, source: "repository_file", readOnly: true, fileInvalidReason: null });
});
test("an invalid repository file falls to the Sentinel policy with a reason", () => {
  const resolved = resolveGuardrailPolicy({ protectedFile: { present: true, policy: null, invalidReason: "policy_invalid" }, sentinel: SENTINEL_POLICY });
  assert.deepEqual(resolved, { policy: SENTINEL_POLICY, source: "sentinel", readOnly: false, fileInvalidReason: "policy_invalid" });
});
test("an invalid repository file with no Sentinel policy falls to the default, still reporting the reason", () => {});
test("the Sentinel policy wins when there is no file", () => {});
test("the default wins when there is neither", () => {});
```

- [ ] **Step 2: Run, fail, implement the three modules, and satisfy the preset tests**

```ts
test("block-critical-high blocks critical and high that are new or reopened", () => { /* assert the exact rules array */ });
test("warn-only never blocks", () => { /* every rule.decision === 'review' */ });
test("recognises a hand-edited policy as custom", () => {});
test("round-trips every preset", () => { /* presetForPolicy(policyForPreset(p, ["main"])) === p for all four but 'custom' */ });
```

- [ ] **Step 3: Rewire the three routes with tests**

```ts
// in apps/api/src/app.test.ts or a new guardrails-policy-api.test.ts
test("saves a policy for a GitHub repository instead of answering 409", async () => { /* PUT → 200, GET reflects it, source 'sentinel' */ });
test("answers 409 policy_controlled_by_repository when the file wins", async () => {});
test("reports the invalid-file reason on GET", async () => { /* fileInvalidReason: 'policy_invalid' */ });
test("refuses a policy save from an analyst", async () => { /* 403 */ });
test("simulates the policy about to be saved against the last gate", async () => {});
```

- [ ] **Step 4: Run the API suite and commit**

Run: `cd apps/api && npm test`

```bash
git add apps/api/src packages/gate-core/src
git commit -m "feat(api): a policy the interface can write, and a file that still wins when it exists"
```

---

### Task 2.2: Baseline projection, automatic build on merge, and the button

**Files:**
- Create: `apps/api/src/guardrails/baseline-state.ts`
- Create: `apps/api/src/guardrails/baseline-state.test.ts`
- Modify: `apps/api/src/gate-orchestrator.ts:636-661` (refresh the projection when a gate completes)
- Modify: `apps/api/src/app.ts` (add `GET`/`POST .../baseline`, remove `POST .../baseline/sync`)
- Modify: `apps/api/src/auth/route-policy.ts`
- Modify: `apps/api/src/guardrails/policy-store.ts` (call the refresh on save)

**Interfaces:**
- Produces:
  - ```ts
    export type BaselineState = "absent" | "building" | "ready" | "stale";
    export interface RepositoryBaseline {
      repositoryKey: string; state: BaselineState; gateId: string | null;
      commitSha: string | null; protectedBranch: string | null; scanLineageHash: string | null;
      builtAt: string | null; staleReason: string | null; requestedAt: string | null; updatedAt: string;
    }
    export function ensureRepositoryBaselineSchema(db?: Database.Database): void;
    export function getRepositoryBaselineState(repositoryKey: string, db?): RepositoryBaseline;
    export function refreshRepositoryBaselineState(repositoryKey: string, deps?: BaselineStateDependencies): RepositoryBaseline;
    export function markRepositoryBaselineBuilding(repositoryKey: string, requestedAt: string, db?): RepositoryBaseline;
    export function markRepositoryBaselineStale(repositoryKey: string, reason: string, db?): RepositoryBaseline;
    ```
    `refreshRepositoryBaselineState` reads the newest protected-branch gate of the repository through the rule that already exists (`managedBaselineCandidate` in `gate-orchestrator.ts:1288-1326`, extracted into an injectable dependency) and derives the word; an absent repository row returns `{ state: "absent" }` without inserting.
  - `POST /guardrails/repositories/:repositoryKey/baseline` (admin) → marks `building`, starts a `protected_branch` gate on the repository's protected branch, returns `{ gateId, baseline }`.
  - `GET /guardrails/repositories/:repositoryKey/baseline` (viewer) → `{ baseline: RepositoryBaseline; hasProtectedBranchAction: boolean }`.

- [ ] **Step 1: Write the failing state test**

```ts
test("an enrolled repository starts absent", () => {});
test("a completed protected-branch gate makes it ready", () => { /* gateId, commitSha, builtAt, protectedBranch filled */ });
test("a newer protected-branch gate replaces the baseline", () => {});
test("a failed protected-branch gate does not make it ready", () => { /* outcome 'error' → still absent */ });
test("a lineage change makes it stale", () => { /* candidate incompatible: scan_lineage → state 'stale', staleReason 'scan_lineage' */ });
test("a protected-branch change makes it stale", () => { /* staleReason 'protected_branch' */ });
test("a merge after staleness rebuilds it", () => { /* stale → new gate → ready, staleReason null */ });
test("the button marks it building and the gate resolves it", () => {});
test("refreshing twice with no change writes the same row", () => { /* idempotent: updatedAt aside, deep equal */ });
```

- [ ] **Step 2: Run, fail, implement `baseline-state.ts`**

- [ ] **Step 3: Hook the gate lifecycle and the policy save**

In `gate-orchestrator.ts`, after the `completed` update of both the managed and the local path, call `deps.refreshBaselineState(repositoryKey)` (a new injected dependency defaulting to `refreshRepositoryBaselineState`). In `policy-store.putRepositoryPolicy`, call it too. In `patchGitHubAction`, when `scanner` changed, call `markRepositoryBaselineStale(repositoryKey, "scan_lineage")`.

- [ ] **Step 4: Add the two routes with tests, and delete `baseline/sync`**

```ts
test("an administrator can build the baseline now", async () => { /* 202, baseline.state 'building' */ });
test("an operator cannot build the baseline", async () => { /* 403 — it spends */ });
test("reports that no push action covers the protected branch", async () => { /* hasProtectedBranchAction: false */ });
test("the removed sync route answers 404", async () => {});
```

- [ ] **Step 5: Run the API suite and commit**

```bash
git add apps/api/src
git commit -m "feat(api): a baseline the first merge builds, in one word the screen can read"
```

---

### Task 2.3: Evaluate a pull request with no baseline

**Files:**
- Modify: `apps/api/src/guardrails/sentinel-managed-executor.ts:291-297` (delete the early return)
- Modify: `apps/api/src/guardrails/sentinel-managed-executor.test.ts`
- Modify: `packages/gate-core/src/artifact.ts` (add `baselineNotice`)
- Modify: `packages/gate-core/src/artifact.test.ts`
- Modify: `packages/gate-core/src/baseline.ts` (no behaviour change; the reason string becomes part of the notice)
- Modify: `apps/web/src/lib/guardrails.ts` (surface the notice; the message text lands in Task 2.5)

**Interfaces:**
- Produces: `GateArtifactV2.baselineNotice: { kind: "absent" | "incompatible"; reason: string | null } | null`. `parseGateArtifact` accepts the field as optional (historical artifacts stay parseable) and normalises a missing field to `null`.

- [ ] **Step 1: Write the failing executor test**

```ts
test("evaluates a pull request with no baseline instead of erroring", async () => {
  const result = await executor.execute(prInput({ baseline: { kind: "absent" }, findings: [critical(), high()] }));
  const artifact = result.artifact as GateArtifactV2;
  assert.equal(artifact.decision.outcome, "bootstrap");
  assert.equal(artifact.decision.githubConclusion, "neutral");
  assert.equal(artifact.findings.length, 2);
  assert.ok(artifact.findings.every((f) => f.lifecycle === "new"));
  assert.deepEqual(artifact.baselineNotice, { kind: "absent", reason: null });
  assert.equal(artifact.decision.violations.length, 0);
});

test("never blocks without a baseline, even with critical findings and a blocking policy", async () => {
  const result = await executor.execute(prInput({ baseline: { kind: "absent" }, policy: blockCriticalHigh(), findings: [critical()] }));
  assert.notEqual((result.artifact as GateArtifactV2).decision.outcome, "blocked");
});

test("an incompatible baseline degrades to the same path with the reason", async () => {
  const result = await executor.execute(prInput({ baseline: { kind: "incompatible", reason: "scan_lineage" } }));
  assert.deepEqual((result.artifact as GateArtifactV2).baselineNotice, { kind: "incompatible", reason: "scan_lineage" });
  assert.equal((result.artifact as GateArtifactV2).decision.outcome, "bootstrap");
});

test("an unavailable baseline is still an operational error", async () => {
  const result = await executor.execute(prInput({ baseline: { kind: "unavailable", reason: "artifact_unreadable" } }));
  assert.match((result.artifact as GateArtifactV2).decision.summary, /baseline_unavailable/);
});

test("incomplete coverage is still an operational error", async () => {});
test("a comparable baseline leaves baselineNotice null", async () => {});
test("parses a historical artifact with no baselineNotice", () => { assert.equal(parseGateArtifact(V2_WITHOUT_NOTICE).baselineNotice, null); });
```

- [ ] **Step 2: Run, fail, implement**

Delete the `baseline.kind === "absent" && target !== protected_branch && changeSet.files.length > 0` early return. Keep the `unavailable` and `incompatible` early returns, but move `incompatible` to the same path as `absent` by mapping it to `{ kind: "absent" }` for `evaluateGate` while recording `baselineNotice = { kind: "incompatible", reason }`.

- [ ] **Step 3: Run the suites and commit**

Run: `cd apps/api && npm test`
Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm typecheck`

```bash
git add apps/api/src packages/gate-core/src apps/web/src/lib
git commit -m "fix(api): a first pull request deserves a verdict, not a code string"
```

---

### Task 2.4: Repository registry — bulk enrolment, patch, delete, one-shot list

**Files:**
- Modify: `apps/api/src/app.ts:413-433` (`POST /guardrails/repositories` accepts a batch)
- Modify: `apps/api/src/gate-store.ts` (add `patchGuardrailRepository`, `deleteGuardrailRepository`)
- Modify: `apps/api/src/guardrails-migrations.ts` (version 6: `pr_comment_enabled`, `pr_comment_detail`)
- Modify: `apps/api/src/auth/route-policy.ts`
- Create: `apps/api/src/guardrails/repository-registry.test.ts`

**Interfaces:**
- Produces:
  - `POST /guardrails/repositories` body `{ connectionId, installationId, repositoryIds: string[] }` (1..50) → `200 { enrolled: GuardrailRepository[]; skipped: Array<{ repositoryId: string; reason: "already_enrolled" | "not_authorized" | "archived" }> }`. The legacy single-`repositoryId` body keeps working (a one-element batch), so no client breaks mid-phase.
  - `PATCH /guardrails/repositories/:repositoryKey` body `{ enabled?: boolean; defaultExecutor?: GateExecutorKind; prCommentEnabled?: boolean }` (admin) → `{ repository }`.
  - `DELETE /guardrails/repositories/:repositoryKey` (admin) → 204, deletes the row (cascading gates, events, grants, baselines, policies, subscriptions) and removes `data/gates/<gateId>/` for every gate it owned.
  - `GET /guardrails/repositories` response rows gain `baseline: RepositoryBaseline`, `enabledActionCount: number`, `lastGate: { gateId, outcome, completedAt } | null`, `policySource: ResolvedPolicySource`, and make **zero** remote GitHub calls.

- [ ] **Step 1: Write the failing registry test**

```ts
test("enrols three repositories in one request", async () => { /* enrolled.length === 3 */ });
test("reports an already-enrolled repository as skipped rather than 409", async () => {});
test("refuses a batch above fifty", async () => { /* 400 too_many_repositories */ });
test("refuses a repository the installation does not authorize", async () => { /* skipped with 'not_authorized' */ });
test("disables a repository without deleting it", async () => { /* PATCH { enabled: false } → enabled false, gates still readable */ });
test("deletes a repository with its gates, grants and artifacts", async () => { /* 204; gate rows gone; the artifact directory gone */ });
test("refuses a delete from a maintainer", async () => { /* 403 */ });
test("lists repositories with baseline and action count in one call and no remote request", async () => {
  const remote = countingRemote();
  const response = await api.request("/guardrails/repositories", { headers: adminHeaders });
  assert.equal(remote.calls, 0);
  const row = (await response.json()).repositories[0];
  assert.equal(row.baseline.state, "ready");
  assert.equal(row.enabledActionCount, 2);
});
```

- [ ] **Step 2: Run, fail, implement, run the API suite, commit**

```bash
git add apps/api/src
git commit -m "feat(api): enrol a list, disable one, remove one, read it all at once"
```

---

### Task 2.5: Guardrails tab — repository list and repository page

**Files:**
- Modify: `apps/web/src/pages/GuardrailsPage.tsx`
- Create: `apps/web/src/pages/GuardrailRepositoryPage.tsx`
- Modify: `apps/web/src/pages/GuardrailPolicyPage.tsx` → becomes a redirect to the new page
- Modify: `apps/web/src/components/guardrails/RepositoryEnrollmentForm.tsx` (multi-select)
- Create: `apps/web/src/components/guardrails/BaselineCard.tsx`
- Create: `apps/web/src/components/guardrails/PolicyPresetPicker.tsx`
- Create: `apps/web/src/lib/guardrail-repository-page.ts`
- Create: `apps/web/src/lib/guardrail-repository-page.test.ts`
- Modify: `apps/web/src/App.tsx:183-186`
- Modify: `apps/web/e2e/critical-flows.spec.ts`

**Interfaces:**
- Consumes: Tasks 2.1, 2.2, 2.4 routes; Task 1.5 `fetchActions`.
- Produces:
  - `apps/web/src/lib/guardrail-repository-page.ts`: `baselineLabelKey(baseline: RepositoryBaseline): string`, `policySourceLabelKey(source, fileInvalidReason): string`, `selectedPresetFromPolicy(policy): GuardrailPolicyPreset`, `enrollmentSelectionState(candidates, enrolledKeys, selectedIds)`.
  - Route `/guardrails/repositories/:repositoryKey`; `/guardrails/repositories/:repositoryKey/policy` renders `<Navigate replace to="../">` so the `EvidenceTrace` link keeps working.

- [ ] **Step 1: Write the failing label test**

```ts
test("names every baseline state", () => { /* four states → four distinct keys */ });
test("names a stale baseline with its reason", () => { /* 'guardrails.baseline.stale.scan_lineage' */ });
test("says the repository file controls the policy", () => { /* source 'repository_file' → the read-only key */ });
test("says the repository file is invalid and the Sentinel policy is in use", () => {});
test("keeps already-enrolled candidates selectable-but-disabled in the multi-select", () => {});
```

- [ ] **Step 2: Run, fail, implement, then build the two screens**

`/guardrails`: repository rows with name, baseline word, last analysis, enabled action count, last verdict; **Adicionar repositórios** opening the multi-select with the partial result shown after submit; per-row disable and remove with a confirmation naming what the removal deletes. Gate list unchanged below.

`/guardrails/repositories/:key`: five blocks — política (preset picker + `PolicyRuleEditor` + the existing simulation + the read-only banner when the file wins + the invalid-file warning), baseline (`BaselineCard` with the state, the commit, and **Criar baseline agora** admin-only, plus the "no push action covers the protected branch" hint), comentário no PR (the toggle from Task 2.4, wired to the renderer in Phase 3), histórico de gates, and a link to the repository's actions in the GitHub tab.

- [ ] **Step 3: Five locales, i18n parity test**

Run: `cd apps/web && npx tsx --test src/lib/i18n.test.ts`

- [ ] **Step 4: e2e**

```ts
test("enrols three repositories at once and shows the partial result", async ({ page }) => {});
test("removes a repository after confirming what it deletes", async ({ page }) => {});
test("saves a policy with a preset and simulates it", async ({ page }) => {});
test("shows the repository file banner and refuses to edit", async ({ page }) => {});
test("builds the baseline now and shows it building", async ({ page }) => {});
test("shows the no-baseline notice on a bootstrap gate", async ({ page }) => {});
```

- [ ] **Step 5: Visual QA and Playwright cleanup**

Run: `cd apps/web && pnpm test && pnpm build && pnpm test:e2e`
Then verify both screens at 1440×900 and Pixel 7. Apply the `AGENTS.md` cleanup rule exactly as in Task 1.6: remove only this task's temporary artifacts from `.playwright-cli/`, `test-results/` and `output/`, preserve final evidence by moving it first, never touch `output/worktree-archives/`, and end with a clean `git status --short`.

- [ ] **Step 6: Full verification and commit**

Run: `cd apps/api && npm test`; `cd apps/web && pnpm test && pnpm build`; `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm typecheck`; `pnpm check:repository`

```bash
git add -A apps/web
git commit -m "feat(web): one page per repository, where the policy and the baseline live"
```

**Phase 2 gate:** four commands green, `git status --short` clean. This is the Phase 2 PR.

---

# Phase 3 — The pull-request comment and App-based publication

Ships: the PR author reads the verdict inside the PR.

### Task 3.1: The comment renderer

**Files:**
- Create: `apps/api/src/github/pr-comment-render.ts`
- Create: `apps/api/src/github/pr-comment-render.test.ts`
- Create: `apps/web/public/brand/pr-comment-banner.png` (reuse the existing console banner artwork; 1200×240, under 120 KB)

**Interfaces:**
- Consumes: `redactPublicText`, `isRepositoryRelativePath` from `@csb/gate-core`; `GateArtifactV2`.
- Produces:
  ```ts
  export const PR_COMMENT_MARKER_PREFIX = "<!-- okami-sentinel:gate repository=";
  export function prCommentMarker(repositoryKey: string): string;
  export function isSentinelComment(body: string, repositoryKey: string): boolean;
  export interface RenderPrCommentInput {
    artifact: GateArtifactV2;
    repositoryKey: string;
    gateUrl: string | null;      // null with no public origin
    bannerUrl: string | null;
    findingUrl(findingIdentity: string): string | null;
    durationMs: number | null;
  }
  export function renderPrComment(input: RenderPrCommentInput): { body: string; truncatedCount: number };
  export const PR_COMMENT_BUDGET = 60_000;
  export const PR_COMMENT_MAX_ROWS = 50;
  ```

- [ ] **Step 1: Write the failing renderer test, including Review Focus 2 and 4**

```ts
test("renders the blocked verdict with counts, baseline, cost and table", () => {
  const { body } = renderPrComment(input({ outcome: "blocked", newFindings: [critical("Command injection in the deploy hook", "scripts/deploy.ts:88")], fixed: 3 }));
  assert.ok(body.startsWith('<!-- okami-sentinel:gate repository=github:1 -->'));
  assert.match(body, /## Okami Sentinel — BLOCKED/);
  assert.match(body, /\| \*\*Fixed by this PR\*\* \| 3 \|/);
  assert.match(body, /`scripts\/deploy\.ts:88`/);
  assert.match(body, /This check is informational/);
});

test("renders every verdict word", () => { /* blocked→BLOCKED, warning→WARNING, pass→APPROVED, bootstrap→REVIEW, no_changes→NO CHANGES, error→ERROR */ });

test("says there is no baseline and drops the fixed row", () => {
  const { body } = renderPrComment(input({ outcome: "bootstrap", baselineNotice: { kind: "absent", reason: null } }));
  assert.match(body, /none yet — findings are reported without comparison/);
  assert.ok(!body.includes("Fixed by this PR"));
});

test("names the reason for an incompatible baseline", () => { /* 'scan_lineage' visible in words */ });

test("escapes a pipe, a backtick and an HTML comment in a finding title", () => { // Review Focus 2
  const { body } = renderPrComment(input({ newFindings: [critical("a | b `c` <!-- okami-sentinel:gate repository=evil -->", "src/a.ts:1")] }));
  const rows = body.split("\n").filter((line) => line.startsWith("| critical"));
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.includes("a \\| b"));
  assert.equal(body.indexOf(PR_COMMENT_MARKER_PREFIX), body.lastIndexOf(PR_COMMENT_MARKER_PREFIX));
  assert.ok(!isSentinelComment(body, "evil"));
});

test("redacts a secret and a host path out of a finding title", () => {
  const { body } = renderPrComment(input({ newFindings: [critical("API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaa leaked", "src/a.ts:1")] }));
  assert.ok(!body.includes("sk-proj-"));
  assert.match(body, /\[REDACTED\]/);
});

test("withholds a location that is not repository-relative", () => {
  const { body } = renderPrComment(input({ newFindings: [critical("x", "/Users/marcos/secret/a.ts:1")] }));
  assert.match(body, /path withheld/);
  assert.ok(!body.includes("/Users/"));
});

test("stays under the budget with three thousand findings and reports the remainder", () => { // Review Focus 4
  const { body, truncatedCount } = renderPrComment(input({ newFindings: manyFindings(3_000) }));
  assert.ok(body.length <= PR_COMMENT_BUDGET, `body length ${body.length}`);
  assert.ok(body.length <= 65_536);
  const shown = body.split("\n").filter((line) => line.startsWith("| ")).length - 1; // minus the header separator
  assert.equal(truncatedCount, 3_000 - shown);
  assert.match(body, new RegExp(`\\+${truncatedCount} mais no Sentinel`));
});

test("caps the table at fifty rows even when everything fits", () => {});
test("drops the lowest severity first when truncating", () => { /* with 60 findings, no 'low' row survives before a 'critical' one is dropped */ });
test("degrades to banner, verdict and link when even the header exceeds the budget", () => { /* a 60k-character decision summary */ });
test("omits the banner and the links with no public origin", () => { /* gateUrl null, bannerUrl null → no http(s) link in the body */ });
test("is always in English regardless of any locale input", () => {});
```

- [ ] **Step 2: Run, fail, implement the renderer**

Run: `cd apps/api && node --test --import tsx src/github/pr-comment-render.test.ts`

Cell escaping is one function: `redactPublicText` first, then `\` before `|`, then replace `` ` `` with `'`, then strip `<!--` and `-->`, then collapse newlines to spaces, then truncate at 160 characters with `…`. Truncation loop: build the full body, and while `body.length > PR_COMMENT_BUDGET` remove the last row of the table (rows already sorted by severity rank then title) and re-render the footer count.

- [ ] **Step 3: Add the banner asset, verify it serves without a session**

```ts
// apps/api/src/server-app.test.ts
test("serves the pull-request banner without a session", async () => { /* GET /brand/pr-comment-banner.png → 200 */ });
```

- [ ] **Step 4: Run, commit**

```bash
git add apps/api/src/github apps/web/public/brand
git commit -m "feat(api): the console's own voice, inside the pull request, under the limit"
```

---

### Task 3.2: The sticky publisher

**Files:**
- Create: `apps/api/src/github/pr-comment-store.ts`
- Create: `apps/api/src/github/pr-comment-store.test.ts`
- Create: `apps/api/src/github/pr-comment-publisher.ts`
- Create: `apps/api/src/github/pr-comment-publisher.test.ts`
- Modify: `apps/api/src/gate-orchestrator.ts:636-661` (publish the comment next to the Check)
- Modify: `apps/api/src/app.ts` (`POST /guardrails/gates/:gateId/comment`)
- Modify: `apps/api/src/auth/route-policy.ts`

**Interfaces:**
- Produces:
  - `ensurePrCommentSchema(db?)`, `getPrComment(repositoryKey, pullRequestNumber, db?)`, `upsertPrComment(record, db?)`.
  - ```ts
    export interface PublishPrCommentInput {
      artifact: GateArtifactV2;
      repositoryKey: string;
      authority: { connectionId: string; installationId: string; repositoryId: string };
      owner: string; name: string; pullRequestNumber: number;
      durationMs: number | null;
    }
    export type PublishPrCommentResult =
      | { status: "created" | "updated"; commentId: string }
      | { status: "unchanged"; commentId: string }
      | { status: "skipped"; reason: "comments_disabled" | "not_a_pull_request" }
      | { status: "failed"; reason: string };
    export function publishPrComment(input: PublishPrCommentInput, deps: PrCommentPublisherDependencies): Promise<PublishPrCommentResult>;
    ```
    `PrCommentPublisherDependencies` injects `readAuthorizedRepositoryJson`, `writeAuthorizedRepositoryJson` (the same two methods `ManagedGitHubCheckClient` already declares, with `{ pull_requests: "write" }` permissions), `getComment`, `upsertComment`, `commentsEnabled(repositoryKey)`, `publicOrigin`, `now`.

- [ ] **Step 1: Write the failing publisher test, including Review Focus 5**

```ts
test("creates the comment on the first gate of a pull request", async () => { /* POST .../issues/7/comments, status 'created', row stored */ });
test("edits the same comment on the next commit", async () => { /* PATCH .../issues/comments/91, status 'updated' */ });
test("makes no call when the body is unchanged", async () => {
  const deps = publisherDeps();
  await publishPrComment(input(), deps);
  const before = deps.calls.length;
  const second = await publishPrComment(input(), deps);
  assert.equal(second.status, "unchanged");
  assert.equal(deps.calls.length, before);
});
test("recreates the comment a human deleted", async () => { // Review Focus 5
  const deps = publisherDeps({ patchStatus: 404, existingComments: [] });
  const result = await publishPrComment(input({ storedCommentId: "91" }), deps);
  assert.equal(result.status, "created");
  assert.ok(deps.calls.some((c) => c.method === "POST"));
});
test("finds an existing comment by its marker when the row is missing", async () => {
  const deps = publisherDeps({ existingComments: [{ id: "77", body: prCommentMarker("github:1") + "\nold" }] });
  const result = await publishPrComment(input({ storedCommentId: null }), deps);
  assert.deepEqual(result, { status: "updated", commentId: "77" });
});
test("stops the marker scan at three pages", async () => { // Review Focus 4
  const deps = publisherDeps({ commentPages: 10 });
  await publishPrComment(input({ storedCommentId: null }), deps);
  assert.equal(deps.calls.filter((c) => c.path.includes("/issues/7/comments")).length, 3);
});
test("uses the oldest of two marked comments and records the ambiguity", async () => { /* reason 'ambiguous_comment' stored, nothing deleted */ });
test("skips a repository with comments disabled", async () => { /* status 'skipped', reason 'comments_disabled', no call */ });
test("skips a protected-branch gate", async () => { /* reason 'not_a_pull_request' */ });
test("records a failure and its reason without throwing", async () => { /* 403 → status 'failed', reason 'github_permission_missing', row status 'failed' */ });
```

- [ ] **Step 2: Run, fail, implement**

- [ ] **Step 3: Hook the orchestrator and add the manual route**

In `gate-orchestrator.ts`'s `finalize`, after the Check publication block, publish the comment for `pull_request` targets. A comment failure must never fail the gate: catch, store `failed`, and call `notifyGitHubPublishFailed(gateId)` — reusing the existing `ops.github_publish_failed` alert, no new email event.

```ts
test("a comment failure leaves the gate completed", async () => {});
test("an operator republishes the comment", async () => { /* POST /guardrails/gates/:id/comment → 200 */ });
test("a viewer cannot republish the comment", async () => { /* 403 */ });
test("republishing a non-pull-request gate answers 409", async () => {});
```

- [ ] **Step 4: Run the API suite and commit**

```bash
git add apps/api/src
git commit -m "feat(api): one comment per pull request, edited in place at every commit"
```

---

### Task 3.3: Publish the Check through the App, everywhere

**Files:**
- Modify: `apps/api/src/app.ts:397`, `:700-761` (point the manual publish at `publishManagedGateCheck`)
- Modify: `apps/api/src/github-check.ts` (delete `publishGateCheck` and `PublishGateCheckInput`; fill `details_url`; add the informational note)
- Modify: `apps/api/src/github-check.test.ts`
- Modify: `packages/gate-core/src/artifact.ts:220-232` (widen `publication.eligible`)
- Modify: `packages/gate-core/src/artifact.test.ts`
- Modify: `apps/api/src/gate-orchestrator.ts:643-647` (`detailsUrl`)

**Interfaces:**
- Produces: `publishManagedGateCheck` unchanged in signature; `detailsUrl` is now `${publicOrigin()}/guardrails/${gateId}` or `null`. `GateArtifactV2.publication.eligible` becomes true for `target.kind === "pull_request"` on a `source: "github"` repository, in addition to the current protected-branch rule; `publication.protectedBranch` keeps its current meaning and `baseline.ts` is untouched.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gate-core/src/artifact.test.ts
test("a pull request to a non-protected base is publishable", () => { assert.equal(artifact.publication.eligible, true); });
test("the protected branch field is unchanged for that artifact", () => { assert.equal(artifact.publication.protectedBranch, null); });
test("a local-source gate is still not publishable", () => {});
test("baseline comparability still demands a protected branch", () => { /* baseline.ts returns incompatible: 'publication' */ });

// apps/api/src/github-check.test.ts
test("the check carries a details url pointing at the gate", () => {});
test("the check summary says it is informational", () => {});
test("publishGateCheck no longer exists", () => { /* the export is gone; the gh runner is not imported by github-check.ts */ });

// apps/api/src/app.test.ts
test("the manual publish uses the App and succeeds without a gh token", async () => { /* the injected App client receives the call; no child process is spawned */ });
test("the manual publish answers 409 for a github-actions gate", async () => { /* existing behaviour preserved */ });
```

- [ ] **Step 2: Run, fail, implement, run the suites**

Run: `cd apps/api && npm test`
Run: `cd packages/gate-core && npm test` (or the root `pnpm test`)
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src packages/gate-core/src
git commit -m "fix(api): the retry uses the credential the first attempt used"
```

---

### Task 3.4: Web — the comment in the interface

**Files:**
- Modify: `apps/web/src/pages/GuardrailsPage.tsx` (gate page: PR link, comment link, no-baseline notice)
- Modify: `apps/web/src/pages/GuardrailRepositoryPage.tsx` (the PR-comment block becomes real)
- Modify: `apps/web/src/components/guardrails/PublishGateControl.tsx` (add "Republicar comentário")
- Create: `apps/web/src/lib/gate-publication.ts`
- Create: `apps/web/src/lib/gate-publication.test.ts`
- Modify: `apps/web/e2e/critical-flows.spec.ts`

**Interfaces:**
- Produces: `apps/web/src/lib/gate-publication.ts`: `publicationStateLabelKey(gate: GateRun): string`, `commentStateLabelKey(comment)`, `pullRequestUrl(gate): string | null`, `commentUrl(gate, comment): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
test("builds the pull request url from the gate's locator and number", () => {});
test("returns null for a gate with no pull request", () => {});
test("builds the comment permalink as <prUrl>#issuecomment-<id>", () => {});
test("names a failed publication and a failed comment separately", () => {});
```

- [ ] **Step 2: Run, fail, implement, then wire the UI**

The gate page gains, beside the existing Check status: "Abrir PR", "Ver comentário publicado", and the "sem baseline" notice rendered from `artifact.baselineNotice` in words, never as a code. The repository page's PR-comment block toggles `prCommentEnabled` and shows the last published comment per PR.

- [ ] **Step 3: Five locales, i18n parity**

Run: `cd apps/web && npx tsx --test src/lib/i18n.test.ts`

- [ ] **Step 4: e2e**

```ts
test("opens the pull request and the published comment from the gate page", async ({ page }) => {});
test("republishes a failed comment", async ({ page }) => {});
test("turns the pull request comment off for a repository", async ({ page }) => {});
```

- [ ] **Step 5: Visual QA and Playwright cleanup**

Run: `cd apps/web && pnpm test && pnpm build && pnpm test:e2e`, verify at 1440×900 and Pixel 7, then apply the `AGENTS.md` cleanup rule (only this task's temporary artifacts in `.playwright-cli/`, `test-results/`, `output/`; final evidence moved first; `output/worktree-archives/` untouched; `git status --short` clean).

- [ ] **Step 6: Full verification and commit**

Run: `cd apps/api && npm test`; `cd apps/web && pnpm test && pnpm build`; `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm typecheck`; `pnpm check:repository`

```bash
git add -A apps/web
git commit -m "feat(web): the gate page points at the pull request it already wrote in"
```

**Phase 3 gate:** four commands green, `git status --short` clean. This is the Phase 3 PR.

---

# Phase 4 — The GitHub Actions executor, per action

Ships: 1,700 lines of working code stop being unreachable.

### Task 4.1: Honour the executor of the action end to end

**Files:**
- Modify: `apps/api/src/github-actions/dispatch.ts` (branch on `action.executor`)
- Modify: `apps/api/src/github-actions/dispatch.test.ts`
- Modify: `apps/api/src/guardrails-enrollment.ts:29`, `:44`, `:53` (stop forcing `sentinel-managed`)
- Modify: `apps/api/src/app.ts` (`PATCH /guardrails/repositories/:key` already accepts `defaultExecutor` from Task 2.4; validate it here)
- Modify: `apps/web/src/components/guardrails/GuardrailPreflightSheet.tsx:741-743` (offer both executors)
- Modify: `apps/web/src/lib/guardrails-target.ts`, `guardrails-target.test.ts`

**Interfaces:**
- Consumes: `startRemoteActionsGate`, `getGitHubActionsStatus`, `GITHUB_ACTIONS_WORKFLOW_SHA` — all already wired in `app.ts:773-787`.
- Produces: no new export; `dispatchGitHubActionEvent` picks `startActions` when `action.executor === "github-actions"` and pre-validates the caller with `validateActions`, mapping `monitor_actions_duplicate_triggers` and `target_preview_executor_unavailable` to `skipped` with those reasons.

- [ ] **Step 1: Write the failing tests**

```ts
test("dispatches a github-actions action through the Actions executor", async () => { /* startActions called, startManaged not */ });
test("refuses when the caller still has automatic triggers", async () => { /* 'skipped'/'monitor_actions_duplicate_triggers' */ });
test("refuses when the caller workflow is absent", async () => { /* 'skipped'/'target_preview_executor_unavailable' */ });
test("enrolment no longer forces the sentinel executor", () => { /* enrollmentBody({ defaultExecutor: 'github-actions' }) keeps it */ });
test("the preflight sheet offers both executors for a github repository", () => {});
```

- [ ] **Step 2: Run, fail, implement, run both suites, commit**

```bash
git add apps/api/src apps/web/src
git commit -m "feat(api): the executor the action chose is the executor that runs"
```

---

### Task 4.2: Open a pull request that installs the caller workflow

**Files:**
- Create: `apps/api/src/guardrails/caller-workflow-pull-request.ts`
- Create: `apps/api/src/guardrails/caller-workflow-pull-request.test.ts`
- Modify: `apps/api/src/app.ts:349-386` (reuse the existing workflow writer)
- Modify: `apps/api/src/auth/route-policy.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface OpenCallerWorkflowPullRequestResult {
    status: "created" | "exists";
    pullRequestNumber: number;
    pullRequestUrl: string;
    branch: string; // "okami-sentinel/caller-workflow"
  }
  export function openCallerWorkflowPullRequest(
    input: { repository: GuardrailRepository; workflowSha: string },
    deps: CallerWorkflowPullRequestDependencies,
  ): Promise<OpenCallerWorkflowPullRequestResult>;
  ```
  Sequence: read the default branch's head SHA → `POST /git/refs` for `refs/heads/okami-sentinel/caller-workflow` (a `422` means it exists: reuse it) → `PUT /contents/.github/workflows/csb-security-change-gate.yml` with the pinned body and the branch's current blob SHA when the file already exists → `POST /pulls` (a `422` with `A pull request already exists` resolves to `status: "exists"` after a `GET /pulls?head=`). Every call goes through `writeAuthorizedRepositoryJson` with `{ contents: "write", pull_requests: "write" }`.

- [ ] **Step 1: Write the failing test**

```ts
test("creates the branch, the file and the pull request", async () => { /* assert the four calls in order and the result */ });
test("reuses an existing branch", async () => { /* 422 on the ref → no failure, file still written */ });
test("reports an existing pull request instead of failing", async () => { /* status 'exists' with the real number */ });
test("updates the file when it already exists on the branch", async () => { /* the PUT carries the blob sha */ });
test("pins the workflow to the configured sha", async () => { /* the body contains the sha, not a branch name */ });
test("refuses a repository with no remote authority", async () => {});
```

- [ ] **Step 2: Run, fail, implement, add the route with its authorization test**

```ts
test("an administrator opens the workflow pull request", async () => { /* 201 */ });
test("a maintainer cannot", async () => { /* 403 */ });
```

- [ ] **Step 3: Run the API suite, commit**

```bash
git add apps/api/src
git commit -m "feat(api): a button that writes the workflow it wants installed"
```

---

### Task 4.3: `workflow_run` becomes the primary import trigger

**Files:**
- Modify: `apps/api/src/github-actions/webhook-ingest.ts` (implement the `workflow_run` branch left as `importWorkflowRun?`)
- Modify: `apps/api/src/github-actions/webhook-ingest.test.ts`
- Modify: `apps/api/src/gate-orchestrator.ts` (expose `importGitHubActionsGateByWorkflowRun(workflowRunId: string): Promise<string | null>`)
- Modify: `apps/api/src/index.ts:145-150` (keep the 15 s reconciler as a safety net; log that it is a fallback)

**Interfaces:**
- Produces: `importGitHubActionsGateByWorkflowRun(workflowRunId)` → the gate id it advanced, or `null` when the run belongs to no Sentinel dispatch. Reuses `actions-artifact-importer` and the existing validation unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
test("imports the artifact when the caller run completes", async () => { /* importWorkflowRun called with the run id; delivery 'processed' */ });
test("ignores a workflow_run that is not the caller", async () => { /* ignored / workflow_not_dispatched */ });
test("ignores a workflow_run still in progress", async () => { /* action 'requested' → ignored / action_not_handled */ });
test("is idempotent with the fifteen-second reconciler", async () => { /* webhook then reconciler → one import */ });
test("an unknown workflow run id imports nothing and returns null", async () => {});
```

- [ ] **Step 2: Run, fail, implement, run the API suite, commit**

```bash
git add apps/api/src
git commit -m "feat(api): the run tells us it finished instead of us asking"
```

---

### Task 4.4: Web — the Actions executor in the action sheet

**Files:**
- Modify: `apps/web/src/components/github/ActionSheet.tsx`
- Create: `apps/web/src/components/github/CallerWorkflowPanel.tsx`
- Modify: `apps/web/src/lib/github-action-form.ts`, `github-action-form.test.ts`
- Modify: `apps/web/src/i18n/github-actions.ts`
- Modify: `apps/web/e2e/github.spec.ts`

**Interfaces:**
- Produces: `callerWorkflowChecklist(status: GitHubActionsStatus): Array<{ id: "workflow_installed" | "triggers_removed" | "secret_present"; ok: boolean }>` in `github-action-form.ts`, where `GitHubActionsStatus` is the existing type from `apps/api/src/guardrails/github-actions-status.ts` as the API returns it.

- [ ] **Step 1: Write the failing test**

```ts
test("reports the three Actions prerequisites", () => { /* three items, exact ok values from a status fixture */ });
test("requires no model connection for the github-actions executor", () => { /* validate passes with connectionId null */ });
```

- [ ] **Step 2: Run, fail, implement, then build `CallerWorkflowPanel`**

It shows the workflow YAML with a copy button, the **Abrir PR com o workflow** button (admin-only, with the resulting PR link after success and an "already open" state), and the three-item checklist with the `OPENAI_API_KEY` and trigger-removal instructions in words.

- [ ] **Step 3: Five locales, i18n parity, e2e**

```ts
test("creates a github-actions action and shows the prerequisites", async ({ page }) => {});
test("opens the workflow pull request and shows the link", async ({ page }) => {});
test("shows the duplicate-triggers refusal in words", async ({ page }) => {});
```

- [ ] **Step 4: Visual QA and Playwright cleanup**

Run: `cd apps/web && pnpm test && pnpm build && pnpm test:e2e`, verify at both viewports, then apply the `AGENTS.md` cleanup rule and confirm `git status --short` is clean.

- [ ] **Step 5: Full verification and commit**

Run: `cd apps/api && npm test`; `cd apps/web && pnpm test && pnpm build`; `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm typecheck`; `pnpm check:repository`

```bash
git add -A apps/web
git commit -m "feat(web): the second executor, reachable at last, with its prerequisites named"
```

**Phase 4 gate:** four commands green, `git status --short` clean. This is the Phase 4 PR.

---

# Phase 5 — Remove what was decorative or dead

Ships: no control in the product lies, and no parallel path remains.

### Task 5.1: The local checkout path

**Files:**
- Delete: `apps/api/src/github-checkouts.ts`, `github-checkouts.test.ts`
- Modify: `apps/api/src/app.ts:800-810` (drop the mount and `checkoutAvailable`)
- Modify: `apps/api/src/auth/route-policy.ts` (drop the four `/github-checkouts` rows)
- Delete: `apps/web/src/lib/github-checkouts*.ts` if present; remove every checkout import from the web app
- Modify: `apps/api/src/github-actions/store.ts` — assert there is no `checkout_mode` column anywhere

**Interfaces:** removes only. Nothing new.

- [ ] **Step 1: Write the failing removal test**

```ts
test("the checkout routes answer 404", async () => { /* all four paths */ });
test("no route policy row mentions github-checkouts", () => {
  assert.equal(ROUTE_POLICY.filter(([, pattern]) => pattern.includes("github-checkouts")).length, 0);
});
test("no source file references checkout_mode", () => { /* a grep over apps/api/src and apps/web/src finds nothing */ });
```

- [ ] **Step 2: Run, fail, delete, run every suite, commit**

Run: `cd apps/api && npm test`; `cd apps/web && pnpm test && pnpm build`; `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm typecheck`

```bash
git add -A apps/api apps/web
git commit -m "refactor: a panel that could never write is not a feature"
```

---

### Task 5.2: The parallel baseline and the gh publisher

**Files:**
- Delete: `apps/api/src/guardrails/github-baseline.ts`, `github-baseline.test.ts`
- Modify: `apps/api/src/gate-orchestrator.ts:182-199`, `:1056` (drop `githubBaselineProvider`)
- Modify: `apps/api/src/app.ts:388-396`, `:601-613` (drop `baseline/sync`)
- Modify: `apps/api/src/auth/route-policy.ts`
- Modify: `apps/web/src/components/guardrails/GitHubStatusPanel.tsx` (drop the sync button)
- Modify: `apps/api/src/github-check.ts` (confirm `publishGateCheck` is gone; keep `github-cli.ts` for `github-status.ts`)

**Interfaces:** removes only.

- [ ] **Step 1: Write the failing removal test**

```ts
test("the baseline sync route answers 404", async () => {});
test("no module imports GitHubBaselineProvider", () => {});
test("github-check.ts does not import the gh runner", () => {});
test("github-status.ts still reports a local repository's git state", async () => { /* the one legitimate gh use survives */ });
```

- [ ] **Step 2: Run, fail, delete, run every suite, commit**

```bash
git add -A apps/api apps/web
git commit -m "refactor: one notion of a ready baseline, one credential for a check"
```

---

### Task 5.3: Drop the migrated tables and close the documentation

**Files:**
- Modify: `apps/api/src/github-actions/migrate-monitor-rules.ts` (version 2: drop the `_migrated` tables)
- Modify: `apps/api/src/github-actions/migrate-monitor-rules.test.ts`
- Modify: `docs/dokploy.md` (only if Phases 2–4 changed a requirement of the section Task 1.2 wrote)
- Modify: `docs/github-monitoring.md` (mark it superseded, pointing at the new design)
- Modify: `docs/repository-map.md` (the new and removed modules)

**Interfaces:**
- Produces: `migrateMonitorRulesToActions` records version 2 named `drop_migrated_monitor_tables` and executes `DROP TABLE IF EXISTS` for the four `_migrated` tables, guarded by a check that `github_actions` holds at least as many rows as the legacy table held (recorded in the version-1 row as a count), so a half-finished Phase 1 can never lose data.

- [ ] **Step 1: Write the failing test**

```ts
test("drops the migrated tables once the actions are in place", () => { /* version 2 applied, four tables gone */ });
test("refuses to drop when no action exists but legacy rows did", () => { /* version stays 1, tables survive, no throw */ });
test("is a no-op on a database that never had the legacy tables", () => {});
```

- [ ] **Step 2: Run, fail, implement**

- [ ] **Step 3: Close the documentation**

`docs/repository-map.md` gains the new modules (`apps/api/src/github-actions/*`, `apps/api/src/github/pr-comment-*`, `apps/api/src/guardrails/policy-*`, `apps/api/src/guardrails/baseline-state.ts`, `apps/web/src/components/github/*`) and loses the deleted ones (`github-monitor/*`, `github-checkouts.ts`, `guardrails/github-baseline.ts`). Re-read the **GitHub App e webhook** section Task 1.2 wrote in `docs/dokploy.md` and correct anything Phases 2–4 changed.

`docs/github-monitoring.md` gets a header: `> **Superseded by** docs/architecture/2026-09-30-github-guardrails-design.md (2026-09-30). Polling and the one-rule-per-repository limit no longer exist.`

- [ ] **Step 4: Full verification and commit**

Run: `cd apps/api && npm test`; `cd apps/web && pnpm test && pnpm build`; `cd apps/web && pnpm test:e2e`; `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm typecheck`; `pnpm check:repository`
Then `git status --short` and confirm no Playwright artifact survived the e2e run, per `AGENTS.md`.

```bash
git add -A apps/api docs
git commit -m "refactor(api): the tables the migration replaced, and the page that told the old story"
```

**Phase 5 gate:** all five commands green, `git status --short` clean, `git worktree list --porcelain` unchanged. This is the Phase 5 PR.
