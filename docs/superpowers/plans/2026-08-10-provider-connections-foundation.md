# Secure Provider Connections Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a secure `/settings/connections` vertical slice that stores provider connection secrets in the operating-system vault, persists only safe metadata in SQLite, and exposes CRUD without leaking credentials.

**Architecture:** A process-wide redaction boundary sanitizes scanner output before persistence or SSE. `CredentialVault`, `ConnectionStore`, and `ConnectionsService` separate OS secret storage, SQLite metadata, and write-only orchestration; a Hono sub-app exposes safe DTOs consumed by a Test Bench-styled React page.

**Tech Stack:** Node.js 24, TypeScript, Hono, better-sqlite3, `@napi-rs/keyring` 1.3.x, React 19, React Router, Shadcn/Radix, Tailwind 4, pnpm 11.5.2.

## Global Constraints

- Runtime remains `node >=24 <25` and `pnpm@11.5.2`.
- Scope is local-only in this plan; every stored connection uses `scopeId = "local"`.
- macOS Keychain and Linux Secret Service are the only secret-storage backends; there is no plaintext, SQLite, `.env`, or JSON fallback.
- API keys, tokens, full custom URLs, discovery URLs, and custom headers must never enter SQLite, logs, SSE, manifests, HTTP read responses, or display commands.
- Models are not implemented or hardcoded in this plan; discovery is the next independent plan.
- Existing scanner behavior remains unchanged except for output redaction.
- Do not touch the pre-existing untracked `apps/web/.impeccable/` directory.
- Use existing Shadcn/Radix primitives and Test Bench composition; do not add handwritten global CSS.
- Every task starts RED, reaches GREEN, runs its focused tests, and commits only its own files.

---

## File Structure

### Shared contracts

- Modify `packages/shared/src/index.ts`: public connection DTOs, write-only mutation requests, normalized errors, and route identifiers. No internal `credentialRef` crosses this package.

### API security and persistence

- Create `apps/api/src/redaction.ts`: scoped secret registration and deterministic text/error sanitization.
- Create `apps/api/src/redaction.test.ts`: exact leak-prevention fixtures.
- Modify `apps/api/src/activity.ts`: redact before writing and again while reading legacy logs.
- Modify `apps/api/src/runner.ts`: sanitize messages before in-memory buffering, SSE, progress parsing, and persistence.
- Modify `apps/api/src/scanners/mantis-worker.ts`: redact child stdout/stderr before stage JSONL.
- Modify `apps/api/src/scanners/vulnhunter-worker.ts`: redact app-server stdout/stderr before JSONL.
- Create `apps/api/src/credentials/credential-vault.ts`: vault interface, secret bundle validation, and safe errors.
- Create `apps/api/src/credentials/system-credential-vault.ts`: `@napi-rs/keyring` adapter.
- Create `apps/api/src/credential-vault.test.ts`: fake keyring and bundle round-trip tests.
- Modify `apps/api/package.json` and `pnpm-lock.yaml`: add the native keyring binding.
- Create `apps/api/src/connections-store.ts`: idempotent schema and SQLite metadata operations.
- Create `apps/api/src/connections-store.test.ts`: in-memory schema, isolation, deletion, and secret-absence tests.
- Create `apps/api/src/connections-service.ts`: write-only validation and vault/SQLite consistency orchestration.
- Create `apps/api/src/connections-service.test.ts`: safe CRUD and rollback tests.
- Create `apps/api/src/connections-api.ts`: Hono sub-app, per-process CSRF token, no-store responses, and normalized errors.
- Create `apps/api/src/connections-api.test.ts`: HTTP contract and leak tests.
- Modify `apps/api/src/app.ts`: mount the sub-app and allow `PATCH` plus CSRF header in CORS.
- Modify `apps/api/src/index.ts`: ensure the connection schema during bootstrap.

### Web vertical slice

- Modify `apps/web/src/api.ts`: acquire CSRF token once in memory and expose safe Connection CRUD.
- Create `apps/web/src/components/settings/SettingsSectionNav.tsx`: route-backed System/Connections navigation.
- Create `apps/web/src/lib/connections.ts`: pure reducer/filter helpers for testability.
- Create `apps/web/src/lib/connections.test.ts`: selection, draft validation, and response-safety tests.
- Create `apps/web/src/components/connections/ConnectionList.tsx`: operational list and status.
- Create `apps/web/src/components/connections/ConnectionInspector.tsx`: safe connection detail.
- Create `apps/web/src/components/connections/ConnectionEditorSheet.tsx`: route and write-only secret form for the foundation slice.
- Create `apps/web/src/pages/ConnectionsPage.tsx`: data loading and desktop/mobile composition.
- Modify `apps/web/src/pages/SettingsPage.tsx`: include the section navigation.
- Modify `apps/web/src/components/ui/sheet.tsx`: localized close label and narrow-screen width support.
- Modify `apps/web/src/App.tsx`: add `/settings/connections`.
- Modify `apps/web/src/i18n.tsx`: complete EN, PT-BR, ES, DE, and FR strings.

---

### Task 1: Global Secret Redaction Boundary

**Files:**
- Create: `apps/api/src/redaction.ts`
- Create: `apps/api/src/redaction.test.ts`
- Modify: `apps/api/src/activity.ts`
- Modify: `apps/api/src/runner.ts`
- Modify: `apps/api/src/scanners/mantis-worker.ts`
- Modify: `apps/api/src/scanners/vulnhunter-worker.ts`

**Interfaces:**
- Produces: `SecretRedactor`, `globalSecretRedactor`, `redactText`, `redactErrorMessage`, and `processSecretValues`.
- Consumes later: Task 2 registers vault values by connection scope; Task 4 uses safe error conversion.

- [ ] **Step 1: Write failing redaction tests**

Create fixtures that cover known values, bearer/basic headers, API-key headers, query parameters, JSON fields, errors, and values inherited by scanner workers:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  SecretRedactor,
  processSecretValues,
  redactErrorMessage,
} from "./redaction.js";

test("redacts registered values and credential-shaped text", () => {
  const redactor = new SecretRedactor();
  redactor.register("connection/one", ["sk-live-abc123", "https://secret.example/v1"]);
  const output = redactor.redactText(
    "Authorization: Bearer sk-live-abc123 X-Api-Key=sk-live-abc123 " +
      "url=https://secret.example/v1?api_key=sk-live-abc123",
  );
  assert.equal(output.includes("sk-live-abc123"), false);
  assert.equal(output.includes("secret.example"), false);
  assert.match(output, /\[REDACTED\]/);
});

test("unregister removes only the requested scope", () => {
  const redactor = new SecretRedactor();
  redactor.register("one", ["same-secret"]);
  redactor.register("two", ["same-secret", "second-secret"]);
  redactor.unregister("one");
  assert.equal(redactor.redactText("same-secret second-secret"), "[REDACTED] [REDACTED]");
});

test("safe errors do not echo arbitrary payloads", () => {
  assert.equal(
    redactErrorMessage(new Error("request failed Authorization: Bearer sk-leak")),
    "request failed Authorization: [REDACTED]",
  );
});

test("worker environment discovery returns only sensitive names", () => {
  assert.deepEqual(
    processSecretValues({ NORMAL: "visible", XAI_API_KEY: "xai-secret", ACCESS_TOKEN: "token-value" }),
    ["xai-secret", "token-value"],
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @csb/api exec tsx --test src/redaction.test.ts
```

Expected: FAIL because `apps/api/src/redaction.ts` does not exist.

- [ ] **Step 3: Implement the redactor without logging its registry**

Use a map of scopes to exact values. Replace registered values longest-first with `split(value).join("[REDACTED]")`, then sanitize credential-shaped headers, JSON keys, and query parameters:

```ts
const REDACTED = "[REDACTED]";
const SENSITIVE_NAME = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)/i;

export class SecretRedactor {
  readonly #scopes = new Map<string, Set<string>>();

  register(scope: string, values: Iterable<string>): void {
    const safe = new Set([...values].map((value) => value.trim()).filter((value) => value.length >= 4));
    if (safe.size === 0) this.#scopes.delete(scope);
    else this.#scopes.set(scope, safe);
  }

  unregister(scope: string): void {
    this.#scopes.delete(scope);
  }

  redactText(input: string): string {
    const exact = [...new Set([...this.#scopes.values()].flatMap((values) => [...values]))]
      .sort((left, right) => right.length - left.length);
    let output = input;
    for (const value of exact) output = output.split(value).join(REDACTED);
    output = output.replace(/(authorization\s*[:=]\s*)(?:bearer|basic)?\s*[^\s,;"}]+/gi, `$1${REDACTED}`);
    output = output.replace(/((?:x-api-key|api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;&"}]+/gi, `$1${REDACTED}`);
    output = output.replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&#\s]+/gi, `$1${REDACTED}`);
    return output;
  }
}

export const globalSecretRedactor = new SecretRedactor();
export const redactText = (value: string): string => globalSecretRedactor.redactText(value);
export const redactErrorMessage = (error: unknown): string =>
  redactText(error instanceof Error ? error.message : "Unexpected provider error");

export function processSecretValues(environment: NodeJS.ProcessEnv | Record<string, string | undefined>): string[] {
  return Object.entries(environment)
    .filter(([name, value]) => SENSITIVE_NAME.test(name) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value!);
}
```

Do not export registry contents and do not add debug logging.

- [ ] **Step 4: Place redaction before every current persistence/stream boundary**

Make `appendCliLog()` write `redactText(line)`. Make `readCliLogSnapshot()` and `readCliLogSince()` redact returned legacy lines. In `runner.emit()`, create the public event with a redacted `message` before appending it to `logBuffer` or notifying listeners:

```ts
function safeEvent(event: Omit<ScanEvent, "at"> & { at?: string }): ScanEvent {
  return {
    ...event,
    ...(event.message === undefined ? {} : { message: redactText(event.message) }),
    at: event.at ?? new Date().toISOString(),
  };
}
```

In both workers, create a local redactor registered with `processSecretValues(process.env)` and write only sanitized lines to JSONL. Parse the sanitized JSONL line for usage/activity so the raw child line is never persisted.

- [ ] **Step 5: Run focused and regression tests**

Run:

```bash
pnpm --filter @csb/api exec tsx --test src/redaction.test.ts src/activity.test.ts src/scanner-adapters.test.ts src/vulnhunter-worker.test.ts
```

Expected: all tests PASS; repeated telemetry lines remain distinct and cursors increase according to the sanitized file bytes.

- [ ] **Step 6: Commit the redaction boundary**

```bash
git add apps/api/src/redaction.ts apps/api/src/redaction.test.ts apps/api/src/activity.ts apps/api/src/runner.ts apps/api/src/scanners/mantis-worker.ts apps/api/src/scanners/vulnhunter-worker.ts
git commit -m "security: redact scanner telemetry globally"
```

---

### Task 2: Native CredentialVault

**Files:**
- Create: `apps/api/src/credentials/credential-vault.ts`
- Create: `apps/api/src/credentials/system-credential-vault.ts`
- Create: `apps/api/src/credential-vault.test.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `globalSecretRedactor.register(scope, values)` from Task 1.
- Produces: `ConnectionSecretBundle`, `CredentialVault`, `SystemCredentialVault`, `VaultError`, and `connectionSecretValues`.

- [ ] **Step 1: Add the native keyring dependency**

Run:

```bash
pnpm --filter @csb/api add @napi-rs/keyring@^1.3.0
```

Expected: `apps/api/package.json` and `pnpm-lock.yaml` include `@napi-rs/keyring`; no postinstall error on Node 24.

- [ ] **Step 2: Write failing vault contract tests with an injected keyring factory**

Define a fake `EntryLike` map and assert safe round-trip, missing entry, unavailable backend, deletion, and redactor registration:

```ts
test("stores a validated bundle and registers its values for redaction", async () => {
  const backend = new FakeKeyring();
  const vault = createSystemCredentialVault({ entry: backend.entry });
  await vault.put("connection/abc", {
    baseUrl: "https://token-plan.example/v1",
    discoveryUrl: "https://token-plan.example/v1/models",
    apiKey: "plan-secret",
    headers: { "X-Tenant": "tenant-secret" },
  });
  assert.equal((await vault.get("connection/abc")).apiKey, "plan-secret");
  assert.equal(redactText("plan-secret tenant-secret"), "[REDACTED] [REDACTED]");
});

test("never falls back when the native store is unavailable", async () => {
  const vault = createSystemCredentialVault({ entry: () => { throw new Error("locked"); } });
  await assert.rejects(vault.put("connection/abc", { apiKey: "secret-value" }), {
    code: "secure_storage_unavailable",
  });
});
```

- [ ] **Step 3: Run the vault test and verify RED**

Run:

```bash
pnpm --filter @csb/api exec tsx --test src/credential-vault.test.ts
```

Expected: FAIL because the vault modules do not exist.

- [ ] **Step 4: Implement the strict bundle and vault interface**

Use a closed bundle and validate every field before serializing:

```ts
export interface ConnectionSecretBundle {
  apiKey?: string;
  baseUrl?: string;
  discoveryUrl?: string;
  headers?: Record<string, string>;
}

export interface CredentialVault {
  available(): Promise<{ available: boolean; backend: "keychain" | "secret-service" | "unsupported" }>;
  put(ref: string, value: ConnectionSecretBundle): Promise<void>;
  get(ref: string): Promise<ConnectionSecretBundle>;
  delete(ref: string): Promise<void>;
}

export class VaultError extends Error {
  constructor(readonly code: "secure_storage_unavailable" | "credential_not_found" | "credential_write_failed") {
    super(code);
  }
}
```

Reject unknown keys, empty secrets, non-HTTP(S) URLs, header names outside `/^[A-Za-z0-9-]+$/`, and control characters. `connectionSecretValues()` returns URL, key, discovery URL, and header values for Task 1 without returning header names.

- [ ] **Step 5: Implement `SystemCredentialVault` using native bindings**

Use service `com.okamiops.sentinel.connections` and account equal to the server-generated credential ref:

```ts
import { Entry } from "@napi-rs/keyring";

const SERVICE = "com.okamiops.sentinel.connections";

export function createSystemCredentialVault(deps = { entry: (account: string) => new Entry(SERVICE, account) }): CredentialVault {
  return {
    async available() {
      if (process.platform !== "darwin" && process.platform !== "linux") {
        return { available: false, backend: "unsupported" };
      }
      try {
        deps.entry("availability-probe").getPassword();
        return { available: true, backend: process.platform === "darwin" ? "keychain" : "secret-service" };
      } catch (error) {
        if (isMissingEntry(error)) {
          return { available: true, backend: process.platform === "darwin" ? "keychain" : "secret-service" };
        }
        return { available: false, backend: process.platform === "darwin" ? "keychain" : "secret-service" };
      }
    },
    async put(ref, value) {
      const bundle = validateConnectionSecretBundle(value);
      try {
        deps.entry(ref).setPassword(JSON.stringify(bundle));
        globalSecretRedactor.register(ref, connectionSecretValues(bundle));
      } catch {
        throw new VaultError("credential_write_failed");
      }
    },
    async get(ref) {
      try {
        const bundle = validateConnectionSecretBundle(JSON.parse(deps.entry(ref).getPassword()));
        globalSecretRedactor.register(ref, connectionSecretValues(bundle));
        return bundle;
      } catch (error) {
        if (isMissingEntry(error)) throw new VaultError("credential_not_found");
        throw new VaultError("secure_storage_unavailable");
      }
    },
    async delete(ref) {
      try { deps.entry(ref).deletePassword(); } catch (error) { if (!isMissingEntry(error)) throw new VaultError("secure_storage_unavailable"); }
      globalSecretRedactor.unregister(ref);
    },
  };
}
```

Map native errors in one `isMissingEntry()` helper. Never include the native error message or bundle in `VaultError`.

- [ ] **Step 6: Run tests, typecheck, and a bounded native smoke test**

Run:

```bash
pnpm --filter @csb/api exec tsx --test src/credential-vault.test.ts
pnpm --filter @csb/api typecheck
node -e "import('@napi-rs/keyring').then(({Entry})=>{const e=new Entry('com.okamiops.sentinel.smoke','node24'); e.setPassword('ok'); if(e.getPassword()!=='ok') process.exit(1); e.deletePassword(); console.log('keyring smoke ok')})"
```

Expected: tests PASS, typecheck exits 0, smoke prints `keyring smoke ok`, and the smoke entry is deleted.

- [ ] **Step 7: Commit the vault**

```bash
git add apps/api/src/credentials apps/api/src/credential-vault.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat: store provider credentials in the system vault"
```

---

### Task 3: Shared Contracts and ConnectionStore

**Files:**
- Modify: `packages/shared/src/index.ts`
- Create: `apps/api/src/connections-store.ts`
- Create: `apps/api/src/connections-store.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Produces: public `ProviderConnection`, `ConnectionDisplay`, mutation DTOs, `StoredProviderConnection`, and `ConnectionStore` operations.
- Consumes later: Task 4 service/API and Task 5 frontend.

- [ ] **Step 1: Write failing shared/store tests**

Cover schema idempotence, same-provider isolation, closed display columns, cascade of models/checks, preservation of scan snapshots, and absence of secret strings from the SQLite dump:

```ts
test("schema stores only closed connection metadata", () => {
  const db = new Database(":memory:");
  ensureConnectionSchema(db);
  insertConnection(connectionFixture(), db);
  const sql = db.serialize().toString("utf8");
  assert.equal(sql.includes("sk-secret"), false);
  assert.equal(sql.includes("https://private.example/v1"), false);
  assert.deepEqual(Object.keys(getConnection("conn-1", db)!.display).sort(), [
    "endpointConfigured",
    "endpointKind",
    "providerLabel",
    "routeLabel",
    "secretConfigured",
  ]);
});
```

- [ ] **Step 2: Run the store test and verify RED**

Run:

```bash
pnpm --filter @csb/api exec tsx --test src/connections-store.test.ts
```

Expected: FAIL because `connections-store.ts` and public DTOs do not exist.

- [ ] **Step 3: Add closed public DTOs to shared**

Add the exact transport, auth, protocol, status, display, and model-selection unions from the approved design. Public mutations are write-only:

```ts
export interface ConnectionSecretInput {
  apiKey?: string;
  baseUrl?: string;
  discoveryUrl?: string;
  headers?: Record<string, string>;
}

export interface CreateProviderConnectionRequest {
  name: string;
  providerKind: string;
  routeKind: string;
  transport: ConnectionTransport;
  authKind: ConnectionAuthKind;
  protocol: ProviderProtocol;
  modelSelectionMode: ModelSelectionMode;
  secret?: ConnectionSecretInput;
}

export interface UpdateProviderConnectionRequest {
  name?: string;
  secret?: ConnectionSecretInput;
}

export interface ProviderConnectionResponse { connection: ProviderConnection }
export interface ProviderConnectionsResponse { connections: ProviderConnection[] }
```

Do not export `credentialRef` or `StoredProviderConnection` from shared.

- [ ] **Step 4: Implement an idempotent store with injected Database**

Create tables with explicit columns, not arbitrary safe-display JSON:

```sql
CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL CHECK(scope_id = 'local'),
  name TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  route_kind TEXT NOT NULL,
  transport TEXT NOT NULL,
  auth_kind TEXT NOT NULL,
  protocol TEXT NOT NULL,
  status TEXT NOT NULL,
  credential_ref TEXT,
  model_selection_mode TEXT NOT NULL,
  default_model_id TEXT,
  provider_label TEXT NOT NULL,
  route_label TEXT NOT NULL,
  secret_configured INTEGER NOT NULL,
  endpoint_configured INTEGER NOT NULL,
  endpoint_kind TEXT,
  last_tested_at TEXT,
  last_model_sync_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Also create `provider_models`, `connection_capability_checks`, and `scan_connection_snapshots` with foreign keys only from models/checks to connections. Snapshot rows deliberately have no foreign key so deletion cannot erase history.

Export functions with `database: Database.Database = getDb()` as the final argument:

```ts
ensureConnectionSchema(database): void
listConnections(database): StoredProviderConnection[]
getConnection(id, database): StoredProviderConnection | null
insertConnection(connection, database): void
updateConnectionRecord(id, patch, database): StoredProviderConnection
deleteConnectionRecord(id, database): boolean
```

`deleteConnectionRecord` removes models and checks in a transaction and leaves snapshots untouched.

- [ ] **Step 5: Initialize the schema at API bootstrap**

After `getDb()` in `apps/api/src/index.ts`, call:

```ts
ensureConnectionSchema(getDb());
```

Do not add connection tables to the already large `db.ts`.

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
pnpm --filter @csb/api exec tsx --test src/connections-store.test.ts
pnpm --filter @csb/api typecheck
pnpm --filter @csb/web typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the store and contracts**

```bash
git add packages/shared/src/index.ts apps/api/src/connections-store.ts apps/api/src/connections-store.test.ts apps/api/src/index.ts
git commit -m "feat: add provider connection metadata store"
```

---

### Task 4: Write-Only Connections Service and Hono API

**Files:**
- Create: `apps/api/src/connections-service.ts`
- Create: `apps/api/src/connections-service.test.ts`
- Create: `apps/api/src/connections-api.ts`
- Create: `apps/api/src/connections-api.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `CredentialVault`, `ConnectionStore`, shared DTOs, and `redactErrorMessage`.
- Produces: `ConnectionsService`, `createConnectionsApp`, and `GET /connections/security-session`.

- [ ] **Step 1: Write failing service consistency and leak tests**

Use a fake vault and in-memory database. Assert server-generated refs, rollback, CLI connection without secret, API connection requiring secret, and DTOs without secret/ref:

```ts
test("create rolls back the vault if metadata insertion fails", async () => {
  const vault = new FakeVault();
  const service = createConnectionsService({ vault, store: failingInsertStore() });
  await assert.rejects(service.create(apiConnectionInput("sk-write-only")));
  assert.equal(vault.size, 0);
});

test("public DTO never exposes secret or credential ref", async () => {
  const connection = await service.create(apiConnectionInput("sk-write-only"));
  const serialized = JSON.stringify(connection);
  assert.equal(serialized.includes("sk-write-only"), false);
  assert.equal(serialized.includes("credentialRef"), false);
});
```

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
pnpm --filter @csb/api exec tsx --test src/connections-service.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement validation and vault/SQLite saga**

`createConnectionsService()` receives narrow dependencies and returns:

```ts
interface ConnectionsService {
  list(): ProviderConnection[];
  get(id: string): ProviderConnection | null;
  create(input: CreateProviderConnectionRequest): Promise<ProviderConnection>;
  update(id: string, input: UpdateProviderConnectionRequest): Promise<ProviderConnection | null>;
  remove(id: string): Promise<boolean>;
}
```

Rules:

- generate `id` and `credentialRef = connection/${id}` server-side;
- `local-cli` + `existing-session` may omit a secret;
- `http-inference` requires a validated secret bundle;
- create writes vault first and deletes it if SQLite insert fails;
- update writes the new bundle before metadata and restores the previous bundle if metadata fails;
- delete removes the vault entry first, then metadata/models/checks; snapshots remain;
- errors expose only normalized codes and never request values.

- [ ] **Step 4: Write failing HTTP contract tests**

Test CRUD, `Cache-Control: no-store`, CSRF, 400/404, CORS headers, and a fake vault error containing a secret:

```ts
test("mutations require the per-process CSRF token", async () => {
  const api = createConnectionsApp(fakeDependencies());
  const denied = await api.request("/connections", { method: "POST", body: "{}" });
  assert.equal(denied.status, 403);
  const session = await api.request("/connections/security-session");
  const { csrfToken } = await session.json() as { csrfToken: string };
  const allowed = await api.request("/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(cliConnectionInput()),
  });
  assert.equal(allowed.status, 201);
});
```

- [ ] **Step 5: Implement the Hono sub-app**

Generate a 32-byte token once per `createConnectionsApp()` instance. Require exact `X-CSRF-Token` on POST/PATCH/DELETE and use timing-safe comparison for equal-length buffers. Add `Cache-Control: no-store` to every response:

```ts
connections.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

connections.get("/connections/security-session", (c) => c.json({ csrfToken }));
connections.get("/connections", (c) => c.json({ connections: deps.service.list() }));
```

Mount with `app.route("/", createConnectionsApp())`. Extend current CORS to:

```ts
allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
allowHeaders: ["Content-Type", "X-CSRF-Token"],
```

Do not place request bodies or caught exception messages in JSON errors.

- [ ] **Step 6: Run service, API, and existing API tests**

Run:

```bash
pnpm --filter @csb/api exec tsx --test src/connections-service.test.ts src/connections-api.test.ts
pnpm --filter @csb/api test
pnpm --filter @csb/api typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 7: Commit the safe API**

```bash
git add apps/api/src/connections-service.ts apps/api/src/connections-service.test.ts apps/api/src/connections-api.ts apps/api/src/connections-api.test.ts apps/api/src/app.ts
git commit -m "feat: expose write-only provider connection API"
```

---

### Task 5: Connections Settings Screen

**Files:**
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/components/settings/SettingsSectionNav.tsx`
- Create: `apps/web/src/lib/connections.ts`
- Create: `apps/web/src/lib/connections.test.ts`
- Create: `apps/web/src/components/connections/ConnectionList.tsx`
- Create: `apps/web/src/components/connections/ConnectionInspector.tsx`
- Create: `apps/web/src/components/connections/ConnectionEditorSheet.tsx`
- Create: `apps/web/src/pages/ConnectionsPage.tsx`
- Modify: `apps/web/src/pages/SettingsPage.tsx`
- Modify: `apps/web/src/components/ui/sheet.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/i18n.tsx`

**Interfaces:**
- Consumes: public Connection DTOs and CRUD endpoints from Tasks 3-4.
- Produces: a responsive connection registry UI; the next plan extends its editor with OAuth, discovery, and probes.

- [ ] **Step 1: Write failing pure UI-state tests**

Test deterministic selection, create validation, and absence of secret material from retained state:

```ts
test("selects the first connection only when the current id is absent", () => {
  assert.equal(resolveConnectionSelection([connection("a"), connection("b")], null), "a");
  assert.equal(resolveConnectionSelection([connection("a"), connection("b")], "b"), "b");
});

test("clears write-only values after a successful save", () => {
  const cleared = clearConnectionSecretDraft({ apiKey: "secret", baseUrl: "https://private/v1", headers: [] });
  assert.deepEqual(cleared, { apiKey: "", baseUrl: "", headers: [] });
});
```

- [ ] **Step 2: Run the web test and verify RED**

Run:

```bash
pnpm --filter @csb/web exec tsx --test src/lib/connections.test.ts
```

Expected: FAIL because `connections.ts` does not exist.

- [ ] **Step 3: Add CSRF-aware API methods**

Keep the CSRF token in module memory only:

```ts
let csrfTokenPromise: Promise<string> | null = null;

async function csrfToken(): Promise<string> {
  csrfTokenPromise ??= request<{ csrfToken: string }>("/connections/security-session")
    .then((response) => response.csrfToken);
  return csrfTokenPromise;
}

async function connectionMutation<T>(path: string, init: RequestInit): Promise<T> {
  const token = await csrfToken();
  return request<T>(path, {
    ...init,
    headers: { ...init.headers, "X-CSRF-Token": token },
  });
}
```

Expose `listConnections`, `createConnection`, `updateConnection`, and `deleteConnection`; encode every path id.

- [ ] **Step 4: Add route-backed Settings navigation and route**

`SettingsSectionNav` renders two native links with `aria-current`: `/settings` and `/settings/connections`. Add it immediately below both Settings page headers. Add to `App.tsx`:

```tsx
<Route path="/settings/connections" element={<ConnectionsPage />} />
```

Update the System nav active rule so `/settings/connections` keeps the System module highlighted.

- [ ] **Step 5: Implement the operational list and inspector**

Desktop uses a connected grid:

```tsx
<div className="grid min-w-0 border border-border lg:grid-cols-[22rem_minmax(0,1fr)]">
  <ConnectionList connections={connections} selectedId={selectedId} onSelect={setSelectedId} />
  <ConnectionInspector connection={selected} onEdit={openEdit} onDelete={removeSelected} />
</div>
```

The list displays connection name, route label, status text, transport, and secret-configured marker. The inspector displays only fields from `ProviderConnection`; it must not infer or reconstruct endpoint information.

- [ ] **Step 6: Implement the foundation editor with write-only secret fields**

This first editor supports:

- existing local CLI metadata without a secret;
- API/custom route with name, provider label, protocol, base URL, discovery URL, API key, and custom header pairs;
- secret inputs initialized empty on every open;
- cancel discards the draft;
- success clears the draft before reloading the list.

Use the existing Sheet with this width:

```tsx
<SheetContent
  side="right"
  closeLabel={t("common.close")}
  className="w-[calc(100vw-1rem)] max-w-none sm:w-[34rem] sm:max-w-none"
>
```

Add `closeLabel?: string` to `SheetContent`; replace the fixed `Close` screen-reader string.

- [ ] **Step 7: Add all locale strings in the existing five locales**

Add the same keys to PT-BR, EN, ES, DE, and FR. Required groups:

```text
settings.section.system
settings.section.connections
connections.title
connections.description
connections.add
connections.empty
connections.route
connections.transport
connections.status
connections.secretConfigured
connections.endpointConfigured
connections.edit
connections.remove
connections.editor.title
connections.editor.apiKey
connections.editor.baseUrl
connections.editor.discoveryUrl
connections.editor.headers
connections.editor.save
connections.editor.writeOnlyHelp
connections.error.load
connections.error.save
connections.error.remove
common.close
common.save
```

The `TranslationKey` type must force completeness; no fallback literal remains in the new components.

- [ ] **Step 8: Run deterministic frontend gates**

Run:

```bash
pnpm --filter @csb/web exec tsx --test src/lib/connections.test.ts src/lib/i18n.test.ts
pnpm --filter @csb/web typecheck
pnpm --filter @csb/web build
```

Expected: tests PASS, typecheck exits 0, and Vite build succeeds.

- [ ] **Step 9: Commit the Settings vertical slice**

```bash
git add apps/web/src/api.ts apps/web/src/components/settings apps/web/src/components/connections apps/web/src/lib/connections.ts apps/web/src/lib/connections.test.ts apps/web/src/pages/ConnectionsPage.tsx apps/web/src/pages/SettingsPage.tsx apps/web/src/components/ui/sheet.tsx apps/web/src/App.tsx apps/web/src/i18n.tsx
git commit -m "feat: add secure provider connections settings"
```

---

### Task 6: End-to-End Foundation Verification

**Files:**
- Modify only if a preceding gate exposes a scoped defect.

**Interfaces:**
- Consumes: completed Tasks 1-5.
- Produces: verified foundation ready for the Authentication and Model Discovery plan.

- [ ] **Step 1: Run the complete deterministic suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all commands exit 0. `git status --short` shows only the pre-existing `apps/web/.impeccable/` plus intentional plan bookkeeping, if any.

- [ ] **Step 2: Start the local application with the supported project command**

Run:

```bash
pnpm dev
```

Expected: API listens on its configured localhost port, Vite serves `http://localhost:5173`, and `/settings/connections` loads without console errors.

- [ ] **Step 3: Verify the security boundary manually with a disposable connection**

Create one custom API connection using sentinel values `sentinel-secret-probe` and `https://secret-probe.invalid/v1`. Confirm:

1. the UI never redisplays either full value after save;
2. GET `/connections` contains neither value nor `credentialRef`;
3. the SQLite database contains neither value;
4. scan telemetry and API logs contain neither value;
5. deleting the connection removes its Keychain/Secret Service entry while historical scan tables remain untouched.

Use only the disposable connection created for this check.

- [ ] **Step 4: Run visual and responsive inspection**

Capture and inspect `/settings/connections` at:

- 1600×1000;
- 1024×768;
- 820×1180;
- 390×844;
- 344×882.

Verify list/inspector composition, Sheet width, keyboard focus, error association, localized close label, no document-level horizontal scroll, no clipping behind the command dock, and no overlap.

- [ ] **Step 5: Route any discovered defect back to its owning task**

If Steps 1-4 expose a defect, return to the task that owns the affected boundary, add an explicit regression test, implement the smallest scoped fix, rerun that task's focused commands and the complete deterministic suite, then amend that task before proceeding. If no defect is found, do not create an empty verification commit.
