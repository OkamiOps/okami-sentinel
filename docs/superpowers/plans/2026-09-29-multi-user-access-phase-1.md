# Multi-user Access — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single HTTP Basic credential with per-person accounts, cookie sessions, per-repository roles enforced on every API route and stream, and the login, invite, users and access screens.

**Architecture:** A new `apps/api/src/auth/` module owns users, sessions, invites and grants in `benchmark.db`. `server-security.ts` resolves the session cookie into a `Principal` on the Hono context; a route-policy middleware in `app.ts` denies by default and checks repository roles; list endpoints filter through an `AccessScope`. The web app gains an `AuthProvider`, `/login` and `/invite/:token` outside the shell, and the Settings tab becomes "Configurações" with Users, Repository access and My account sections.

**Tech Stack:** Node 24, TypeScript, Hono 4, better-sqlite3, `node:crypto` (`scrypt`, `randomBytes`, `createHash`), React 19 + react-router, Tailwind, radix-based UI in `apps/web/src/components/ui`, `node:test`, Playwright.

**Spec:** `docs/architecture/2026-09-29-multi-user-access-design.md` (Phase 1 only).

## Global Constraints

- No new runtime dependencies. Use `node:crypto`; `nanoid` and `hono` are already in `apps/api`.
- Local mode (`CSB_RUNTIME_MODE` unset or `local`) keeps working without login: the principal is an implicit administrator.
- Session cookie: `__Host-sentinel_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`.
- Session lifetime: 12h idle, 7 days absolute.
- Password hashing: `scrypt` N=32768, r=8, p=1, 64-byte key, 16-byte salt.
- Lockout: 5 consecutive failures → 15 minutes, doubling each further round of 5, capped at 24h.
- Per-IP login limit: 30 failed attempts per minute → `429` with `Retry-After`.
- Password policy: at least 12 characters, at most 256, not equal to the username (case-insensitive).
- Invite and reset links: single use, 72h, only the SHA-256 of the token is stored.
- Roles, cumulative: `viewer` < `analyst` < `operator` < `maintainer`.
- Phase 1: only administrators use provider connections, so `POST /scans` and `POST /guardrails/gates` are admin-only.
- Invisible resource → `404 {"error":"not_found"}`; visible but insufficient role → `403 {"error":"forbidden"}`; no session → `401 {"error":"authentication_required"}`.
- Never fewer than one active administrator.
- UI copy in the five locales `pt-BR`, `en`, `es`, `de`, `fr`; new page catalogues use the scoped pattern in `apps/web/src/i18n/scoped.ts`.
- `main` is protected: integrate through a PR whose checks "Typecheck, test, and build" and "Build Linux image and smoke server" pass. Run `pnpm check:repository` before opening it.
- After the phase ships, delete this plan file (AGENTS.md: completed plans live in history).

## Review Focus

1. Usernames that differ only by case or surrounding spaces (`"Admin "`) must resolve to the same account for login, creation and uniqueness — test in Task 3.
2. A user disabled while a 4-hour scan stream is open must stop receiving events within 60 seconds — test in Task 12.
3. Demoting or disabling the last active administrator, including demoting yourself, must be refused — test in Task 10.
4. A scan recorded before its repository was registered must become visible to granted members once the repository is registered — test in Task 6.
5. A `next` parameter such as `//evil.example`, `https://evil.example` or `/\evil.example` must never redirect off-site after login — test in Task 14.

---

## File Structure

**API — new (`apps/api/src/auth/`)**

| File | Responsibility |
|---|---|
| `schema.ts` | `ensureAuthSchema(db)`: users, sessions, user_invites, repository_grants; `runs.repository_key` column |
| `passwords.ts` | hash, verify, dummy verify, password policy |
| `tokens.ts` | random tokens and their SHA-256 |
| `principal.ts` | `Principal`, `RepositoryRole`, `AccessScope`, role ranking, scope helpers, context accessors |
| `user-store.ts` | user rows: create, find, update, lockout counters, admin counting |
| `session-store.ts` | session rows: create, resolve, touch, revoke, list |
| `invite-store.ts` | invite/reset links: create, peek, consume |
| `grant-store.ts` | repository grants: list, replace, set, repository access view |
| `repository-key.ts` | derive `repository_key` for runs; backfill |
| `rate-limit.ts` | per-IP failure window |
| `auth-service.ts` | login, logout, session resolution, invite acceptance, password change, admin bootstrap |
| `auth-api.ts` | `/auth/*` and `/account/*` routes |
| `users-api.ts` | admin `/users/*` and `/repository-access/*` routes |
| `route-policy.ts` | route requirement table, matcher, `authorize()` middleware |
| `stream-guard.ts` | periodic re-authorization for SSE |
| `scope-sql.ts` | `scopeSql(scope, column)` SQL fragment |

**API — modified:** `db.ts`, `scan-list.ts`, `metrics.ts`, `app.ts`, `server-security.ts`, `server-app.ts`, `security-session.ts`, `connections-api.ts`, `engine-updates-api.ts`, `github-integration-security.ts`, `index.ts`, `server-app.test.ts`; `packages/shared/src/index.ts`; `scripts/docker/smoke.mjs`, `scripts/docker/workflow-smoke.mjs`; `docs/docker.md`, `docs/dokploy.md`.

**Web — new:** `src/lib/auth-api.ts`, `src/lib/safe-next.ts`, `src/lib/safe-next.test.ts`, `src/auth/AuthProvider.tsx`, `src/i18n/auth.ts`, `src/i18n/access.ts`, `src/pages/LoginPage.tsx`, `src/pages/InvitePage.tsx`, `src/pages/AccountPage.tsx`, `src/pages/UsersPage.tsx`, `src/pages/RepositoryAccessPage.tsx`, `src/components/auth/AuthFrame.tsx`, `src/components/auth/UserMenu.tsx`, `src/components/access/InviteUserDialog.tsx`, `src/components/access/UserDrawer.tsx`, `src/components/access/RoleSelect.tsx`, `e2e/auth.spec.ts`.

**Web — modified:** `src/main.tsx`, `src/App.tsx`, `src/lib/security-session.ts`, `src/components/settings/SettingsSectionNav.tsx`, `src/i18n.tsx`, `src/pages/ScanDetailPage.tsx`, `src/components/guardrails/GuardrailScanMonitor.tsx`, `src/pages/GuardrailsPage.tsx`, `e2e/fixtures.ts`, plus permission gating call sites listed in Task 18.

---

### Task 1: Auth schema and run repository key column

**Files:**
- Create: `apps/api/src/auth/schema.ts`
- Modify: `apps/api/src/db.ts` (`getDb()` after `migrateGuardrailsSchema(db)` at ~line 184; `rowToScanRun`; `BenchmarkRow`)
- Modify: `packages/shared/src/index.ts` (`ScanRun`, ~line 620)
- Test: `apps/api/src/auth/schema.test.ts`

**Interfaces:**
- Produces: `ensureAuthSchema(database: Database.Database): void`; `ScanRun.repositoryKey?: string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/auth/schema.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureAuthSchema } from "./schema.js";

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

test("creates auth tables and the run repository key idempotently", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(db);
  ensureAuthSchema(db);
  assert.deepEqual(
    ["users", "sessions", "user_invites", "repository_grants"].filter((t) => columns(db, t).length === 0),
    [],
  );
  assert.ok(columns(db, "runs").includes("repository_key"));
  assert.ok(columns(db, "users").includes("locked_until"));
});

test("rejects unknown roles and cascades grants with their repository", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(db);
  db.prepare("INSERT INTO guardrail_repositories VALUES ('github:1')").run();
  db.prepare(`INSERT INTO users (id, username, display_name, is_admin, status, failed_attempts, created_at, updated_at)
    VALUES ('u1', 'ana', 'Ana', 0, 'active', 0, 'now', 'now')`).run();
  assert.throws(() => db.prepare(`INSERT INTO repository_grants VALUES ('u1', 'github:1', 'owner', 'u1', 'now')`).run());
  db.prepare(`INSERT INTO repository_grants VALUES ('u1', 'github:1', 'viewer', 'u1', 'now')`).run();
  db.prepare("DELETE FROM guardrail_repositories").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM repository_grants").get() as { n: number }).n, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && node --import tsx --test src/auth/schema.test.ts`
Expected: FAIL — `Cannot find module './schema.js'`.

- [ ] **Step 3: Implement `schema.ts`**

```ts
// apps/api/src/auth/schema.ts
import type Database from "better-sqlite3";

export function ensureAuthSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      email TEXT,
      password_hash TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
      must_change_password INTEGER NOT NULL DEFAULT 0,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS user_invites (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
      created_by TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS repository_grants (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      repository_key TEXT NOT NULL REFERENCES guardrail_repositories(repository_key) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'analyst', 'operator', 'maintainer')),
      granted_by TEXT,
      granted_at TEXT NOT NULL,
      PRIMARY KEY (user_id, repository_key)
    );
  `);
  const runColumns = new Set(
    (database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!runColumns.has("repository_key")) {
    database.exec("ALTER TABLE runs ADD COLUMN repository_key TEXT");
  }
  database.exec("CREATE INDEX IF NOT EXISTS runs_by_repository_key ON runs(repository_key)");
}
```

- [ ] **Step 4: Wire into `getDb()` and the run mapping**

In `apps/api/src/db.ts`, import `ensureAuthSchema` from `./auth/schema.js` and call `ensureAuthSchema(db);` on the line after `migrateGuardrailsSchema(db);`. Add `repository_key: string | null;` to `BenchmarkRow`, and in `rowToScanRun` add `repositoryKey: row.repository_key ?? null,`. In `packages/shared/src/index.ts`, add to `ScanRun` after `repositoryPath`:

```ts
  /** Guardrails repository the run belongs to; null means administrators only. */
  repositoryKey?: string | null;
```

`upsertRun` is not changed in this task (Task 6 fills the column).

- [ ] **Step 5: Run tests**

Run: `cd apps/api && node --import tsx --test src/auth/schema.test.ts && npx tsc -b --pretty false && npm test`
Expected: PASS, full suite still green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/schema.ts apps/api/src/auth/schema.test.ts apps/api/src/db.ts packages/shared/src/index.ts
git commit -m "feat(auth): add users, sessions, invites and repository grants schema"
```

---

### Task 2: Password hashing and tokens

**Files:**
- Create: `apps/api/src/auth/passwords.ts`, `apps/api/src/auth/tokens.ts`
- Test: `apps/api/src/auth/passwords.test.ts`

**Interfaces:**
- Produces: `hashPassword(password: string): Promise<string>`; `verifyPassword(password: string, stored: string | null): Promise<boolean>` (a null `stored` runs a dummy verification and returns false); `passwordPolicyError(password: string, username: string): "password_too_short" | "password_too_long" | "password_matches_username" | null`; `newToken(): string`; `hashToken(token: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/auth/passwords.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, passwordPolicyError, verifyPassword } from "./passwords.js";
import { hashToken, newToken } from "./tokens.js";

test("hashes with scrypt parameters and verifies only the right password", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.match(stored, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(stored, await hashPassword("correct horse battery"));
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("correct horse batterY", stored), false);
});

test("treats missing or malformed hashes as a failed verification", async () => {
  assert.equal(await verifyPassword("anything", null), false);
  assert.equal(await verifyPassword("anything", "plain"), false);
  assert.equal(await verifyPassword("anything", "scrypt$1$1$1$x$y"), false);
});

test("enforces the password policy", () => {
  assert.equal(passwordPolicyError("short", "ana"), "password_too_short");
  assert.equal(passwordPolicyError("x".repeat(257), "ana"), "password_too_long");
  assert.equal(passwordPolicyError("Ana.Silva.123", "ana.silva.123"), "password_matches_username");
  assert.equal(passwordPolicyError("a long enough pass", "ana"), null);
});

test("tokens are random and hashed deterministically", () => {
  const token = newToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, newToken());
  assert.equal(hashToken(token), hashToken(token));
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && node --import tsx --test src/auth/passwords.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/auth/tokens.ts
import { createHash, randomBytes } from "node:crypto";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

```ts
// apps/api/src/auth/passwords.ts
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

let dummyHash: Promise<string> | null = null;

// Unknown users and users without a password still pay for one derivation, so
// response time does not reveal which usernames exist.
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parsed = stored === null ? null : parseHash(stored);
  if (parsed === null) {
    dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
    const dummy = parseHash(await dummyHash)!;
    await derive(password, dummy.salt, dummy.n, dummy.r, dummy.p);
    return false;
  }
  const key = await derive(password, parsed.salt, parsed.n, parsed.r, parsed.p);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

function parseHash(stored: string): { n: number; r: number; p: number; salt: Buffer; key: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (n !== N || r !== R || p !== P) return null;
  const salt = Buffer.from(parts[4]!, "base64");
  const key = Buffer.from(parts[5]!, "base64");
  if (salt.length !== 16 || key.length !== KEY_LENGTH) return null;
  return { n, r, p, salt, key };
}

export function passwordPolicyError(
  password: string,
  username: string,
): "password_too_short" | "password_too_long" | "password_matches_username" | null {
  if (password.length < 12) return "password_too_short";
  if (password.length > 256) return "password_too_long";
  if (password.trim().toLowerCase() === username.trim().toLowerCase()) return "password_matches_username";
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/api && node --import tsx --test src/auth/passwords.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/passwords.ts apps/api/src/auth/tokens.ts apps/api/src/auth/passwords.test.ts
git commit -m "feat(auth): scrypt password hashing and session tokens"
```

---

### Task 3: User store

**Files:**
- Create: `apps/api/src/auth/user-store.ts`
- Test: `apps/api/src/auth/user-store.test.ts`

**Interfaces:**
- Consumes: `ensureAuthSchema` (Task 1).
- Produces:

```ts
export interface UserRecord {
  id: string; username: string; displayName: string; email: string | null;
  passwordHash: string | null; isAdmin: boolean; status: "active" | "disabled";
  failedAttempts: number; lockedUntil: string | null;
  createdAt: string; updatedAt: string; lastLoginAt: string | null;
}
export function normalizeUsername(value: string): string | null; // trimmed, lower-cased, /^[a-z0-9._-]{2,64}$/ or null
export function createUser(input: { username: string; displayName: string; email?: string | null; passwordHash?: string | null; isAdmin: boolean }, database?: Database.Database): UserRecord; // throws Error("username_invalid") | Error("username_taken")
export function getUser(id: string, database?): UserRecord | null;
export function findUserByUsername(username: string, database?): UserRecord | null; // normalizes input
export function listUsers(database?): UserRecord[]; // ordered by username
export function updateUser(id: string, patch: Partial<Pick<UserRecord, "displayName" | "email" | "passwordHash" | "isAdmin" | "status" | "failedAttempts" | "lockedUntil" | "lastLoginAt">>, database?): UserRecord;
export function countActiveAdmins(database?): number;
```

All functions default `database = getDb()`, matching `gate-store.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/auth/user-store.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureAuthSchema } from "./schema.js";
import { countActiveAdmins, createUser, findUserByUsername, listUsers, normalizeUsername, updateUser } from "./user-store.js";

function db() {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  database.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(database);
  return database;
}

test("normalizes usernames so case and spaces cannot create a second account", () => {
  const database = db();
  assert.equal(normalizeUsername("  Ana.Silva "), "ana.silva");
  assert.equal(normalizeUsername("a"), null);
  assert.equal(normalizeUsername("ana silva"), null);
  createUser({ username: "Ana.Silva", displayName: "Ana", isAdmin: false }, database);
  assert.throws(() => createUser({ username: " ana.silva ", displayName: "Other", isAdmin: false }, database), /username_taken/);
  assert.equal(findUserByUsername("ANA.SILVA ", database)?.displayName, "Ana");
});

test("counts only active administrators", () => {
  const database = db();
  const admin = createUser({ username: "root", displayName: "Root", isAdmin: true }, database);
  createUser({ username: "ana", displayName: "Ana", isAdmin: false }, database);
  assert.equal(countActiveAdmins(database), 1);
  updateUser(admin.id, { status: "disabled" }, database);
  assert.equal(countActiveAdmins(database), 0);
  assert.deepEqual(listUsers(database).map((u) => u.username), ["ana", "root"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --import tsx --test src/auth/user-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/auth/user-store.ts
import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { getDb } from "../db.js";

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  passwordHash: string | null;
  isAdmin: boolean;
  status: "active" | "disabled";
  failedAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

interface UserRow {
  id: string; username: string; display_name: string; email: string | null;
  password_hash: string | null; is_admin: number; status: "active" | "disabled";
  failed_attempts: number; locked_until: string | null;
  created_at: string; updated_at: string; last_login_at: string | null;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin === 1,
    status: row.status,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

export function normalizeUsername(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9._-]{2,64}$/.test(normalized) ? normalized : null;
}

export function createUser(
  input: { username: string; displayName: string; email?: string | null; passwordHash?: string | null; isAdmin: boolean },
  database: Database.Database = getDb(),
): UserRecord {
  const username = normalizeUsername(input.username);
  if (username === null) throw new Error("username_invalid");
  if (findUserByUsername(username, database)) throw new Error("username_taken");
  const now = new Date().toISOString();
  const id = nanoid(16);
  database.prepare(`
    INSERT INTO users (id, username, display_name, email, password_hash, is_admin, status, failed_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)
  `).run(id, username, input.displayName.trim().slice(0, 120) || username, input.email?.trim() || null,
    input.passwordHash ?? null, input.isAdmin ? 1 : 0, now, now);
  return getUser(id, database)!;
}

export function getUser(id: string, database: Database.Database = getDb()): UserRecord | null {
  const row = database.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ? toRecord(row) : null;
}

export function findUserByUsername(username: string, database: Database.Database = getDb()): UserRecord | null {
  const normalized = normalizeUsername(username);
  if (normalized === null) return null;
  const row = database.prepare("SELECT * FROM users WHERE username = ?").get(normalized) as UserRow | undefined;
  return row ? toRecord(row) : null;
}

export function listUsers(database: Database.Database = getDb()): UserRecord[] {
  return (database.prepare("SELECT * FROM users ORDER BY username").all() as UserRow[]).map(toRecord);
}

const columns = {
  displayName: "display_name",
  email: "email",
  passwordHash: "password_hash",
  isAdmin: "is_admin",
  status: "status",
  failedAttempts: "failed_attempts",
  lockedUntil: "locked_until",
  lastLoginAt: "last_login_at",
} as const;

export function updateUser(
  id: string,
  patch: Partial<Pick<UserRecord, keyof typeof columns>>,
  database: Database.Database = getDb(),
): UserRecord {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns) as Array<[keyof typeof columns, string]>) {
    if (!(key in patch)) continue;
    const value = patch[key];
    sets.push(`${column} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : value ?? null);
  }
  sets.push("updated_at = ?");
  values.push(new Date().toISOString(), id);
  database.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  const updated = getUser(id, database);
  if (!updated) throw new Error("user_not_found");
  return updated;
}

export function countActiveAdmins(database: Database.Database = getDb()): number {
  return (database.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND status = 'active'")
    .get() as { n: number }).n;
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/api && node --import tsx --test src/auth/user-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/user-store.ts apps/api/src/auth/user-store.test.ts
git commit -m "feat(auth): user store with normalized usernames"
```

---

### Task 4: Session and invite stores

**Files:**
- Create: `apps/api/src/auth/session-store.ts`, `apps/api/src/auth/invite-store.ts`
- Test: `apps/api/src/auth/session-store.test.ts`

**Interfaces:**
- Consumes: `newToken`, `hashToken` (Task 2); `createUser` (Task 3).
- Produces:

```ts
// session-store.ts
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export interface SessionRecord { id: string; userId: string; csrfToken: string; createdAt: string; lastSeenAt: string; expiresAt: string; ip: string | null; userAgent: string | null; }
export function createSession(input: { userId: string; ip: string | null; userAgent: string | null; now?: Date }, database?): { token: string; session: SessionRecord };
export function resolveSession(token: string, now?: Date, database?): SessionRecord | null; // null when unknown, revoked, idle > 12h or past expires_at; touches last_seen_at at most once per minute
export function getSessionById(id: string, now?: Date, database?): SessionRecord | null; // same validity rules, no touch
export function revokeSession(id: string, database?): void;
export function revokeUserSessions(userId: string, exceptSessionId?: string | null, database?): void;
export function listUserSessions(userId: string, now?: Date, database?): SessionRecord[]; // valid only, newest first

// invite-store.ts
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
export interface InviteRecord { tokenHash: string; userId: string; purpose: "invite" | "reset"; createdBy: string | null; createdAt: string; expiresAt: string; }
export function createInvite(input: { userId: string; purpose: "invite" | "reset"; createdBy: string | null; now?: Date }, database?): { token: string; invite: InviteRecord }; // also voids the user's previous unused links
export function peekInvite(token: string, now?: Date, database?): InviteRecord | null;
export function consumeInvite(token: string, now?: Date, database?): InviteRecord | null; // marks used atomically; second call returns null
export function hasOpenInvite(userId: string, now?: Date, database?): boolean;
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/auth/session-store.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureAuthSchema } from "./schema.js";
import { createUser } from "./user-store.js";
import { createSession, listUserSessions, resolveSession, revokeUserSessions } from "./session-store.js";
import { consumeInvite, createInvite, peekInvite } from "./invite-store.js";

function setup() {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  database.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(database);
  const user = createUser({ username: "ana", displayName: "Ana", isAdmin: false }, database);
  return { database, user };
}

test("stores only the token hash and expires idle and old sessions", () => {
  const { database, user } = setup();
  const start = new Date("2026-09-29T10:00:00.000Z");
  const { token, session } = createSession({ userId: user.id, ip: "10.0.0.1", userAgent: "ua", now: start }, database);
  assert.notEqual(session.id, token);
  assert.equal((database.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(token) as { n: number }).n, 0);
  assert.equal(resolveSession(token, new Date(start.getTime() + 11 * 3600_000), database)?.id, session.id);
  // Touched at +11h, so idle expiry moves to +23h.
  assert.ok(resolveSession(token, new Date(start.getTime() + 22 * 3600_000), database));
  assert.equal(resolveSession(token, new Date(start.getTime() + 35 * 3600_000), database), null);
  const second = createSession({ userId: user.id, ip: null, userAgent: null, now: start }, database);
  let now = start.getTime();
  for (let hour = 0; hour < 7 * 24; hour += 6) {
    now = start.getTime() + hour * 3600_000;
    assert.ok(resolveSession(second.token, new Date(now), database), `hour ${hour}`);
  }
  assert.equal(resolveSession(second.token, new Date(start.getTime() + 7 * 24 * 3600_000 + 1), database), null);
});

test("revokes every session of a user except the current one", () => {
  const { database, user } = setup();
  const a = createSession({ userId: user.id, ip: null, userAgent: null }, database);
  const b = createSession({ userId: user.id, ip: null, userAgent: null }, database);
  revokeUserSessions(user.id, a.session.id, database);
  assert.ok(resolveSession(a.token, undefined, database));
  assert.equal(resolveSession(b.token, undefined, database), null);
  assert.deepEqual(listUserSessions(user.id, undefined, database).map((s) => s.id), [a.session.id]);
});

test("invite links are single use, expire, and replace older links", () => {
  const { database, user } = setup();
  const now = new Date("2026-09-29T10:00:00.000Z");
  const first = createInvite({ userId: user.id, purpose: "invite", createdBy: null, now }, database);
  const second = createInvite({ userId: user.id, purpose: "reset", createdBy: null, now }, database);
  assert.equal(peekInvite(first.token, now, database), null);
  assert.equal(peekInvite(second.token, new Date(now.getTime() + 73 * 3600_000), database), null);
  assert.equal(consumeInvite(second.token, now, database)?.purpose, "reset");
  assert.equal(consumeInvite(second.token, now, database), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --import tsx --test src/auth/session-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `session-store.ts`**

```ts
// apps/api/src/auth/session-store.ts
import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { hashToken, newToken } from "./tokens.js";

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface SessionRecord {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

interface SessionRow {
  id: string; user_id: string; csrf_token: string; created_at: string; last_seen_at: string;
  expires_at: string; ip: string | null; user_agent: string | null; revoked_at: string | null;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id, userId: row.user_id, csrfToken: row.csrf_token, createdAt: row.created_at,
    lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, ip: row.ip, userAgent: row.user_agent,
  };
}

function valid(row: SessionRow | undefined, now: Date): row is SessionRow {
  if (!row || row.revoked_at !== null) return false;
  const time = now.getTime();
  return time < Date.parse(row.expires_at) && time - Date.parse(row.last_seen_at) < SESSION_IDLE_MS;
}

export function createSession(
  input: { userId: string; ip: string | null; userAgent: string | null; now?: Date },
  database: Database.Database = getDb(),
): { token: string; session: SessionRecord } {
  const now = input.now ?? new Date();
  const token = newToken();
  const id = hashToken(token);
  database.prepare(`
    INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.userId, newToken(), now.toISOString(), now.toISOString(),
    new Date(now.getTime() + SESSION_MAX_MS).toISOString(), input.ip?.slice(0, 64) ?? null,
    input.userAgent?.slice(0, 300) ?? null);
  return { token, session: getSessionById(id, now, database)! };
}

export function getSessionById(id: string, now: Date = new Date(), database: Database.Database = getDb()): SessionRecord | null {
  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return valid(row, now) ? toRecord(row) : null;
}

export function resolveSession(token: string, now: Date = new Date(), database: Database.Database = getDb()): SessionRecord | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const id = hashToken(token);
  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  if (!valid(row, now)) return null;
  if (now.getTime() - Date.parse(row.last_seen_at) >= TOUCH_INTERVAL_MS) {
    database.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now.toISOString(), id);
    row.last_seen_at = now.toISOString();
  }
  return toRecord(row);
}

export function revokeSession(id: string, database: Database.Database = getDb()): void {
  database.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), id);
}

export function revokeUserSessions(userId: string, exceptSessionId: string | null = null, database: Database.Database = getDb()): void {
  database.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?")
    .run(new Date().toISOString(), userId, exceptSessionId);
}

export function listUserSessions(userId: string, now: Date = new Date(), database: Database.Database = getDb()): SessionRecord[] {
  return (database.prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC").all(userId) as SessionRow[])
    .filter((row) => valid(row, now))
    .map(toRecord);
}
```

- [ ] **Step 4: Implement `invite-store.ts`**

```ts
// apps/api/src/auth/invite-store.ts
import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { hashToken, newToken } from "./tokens.js";

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export interface InviteRecord {
  tokenHash: string;
  userId: string;
  purpose: "invite" | "reset";
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
}

interface InviteRow {
  token_hash: string; user_id: string; purpose: "invite" | "reset"; created_by: string | null;
  created_at: string; expires_at: string; used_at: string | null;
}

function toRecord(row: InviteRow): InviteRecord {
  return {
    tokenHash: row.token_hash, userId: row.user_id, purpose: row.purpose, createdBy: row.created_by,
    createdAt: row.created_at, expiresAt: row.expires_at,
  };
}

export function createInvite(
  input: { userId: string; purpose: "invite" | "reset"; createdBy: string | null; now?: Date },
  database: Database.Database = getDb(),
): { token: string; invite: InviteRecord } {
  const now = input.now ?? new Date();
  const token = newToken();
  database.transaction(() => {
    database.prepare("UPDATE user_invites SET used_at = ? WHERE user_id = ? AND used_at IS NULL")
      .run(now.toISOString(), input.userId);
    database.prepare(`
      INSERT INTO user_invites (token_hash, user_id, purpose, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hashToken(token), input.userId, input.purpose, input.createdBy, now.toISOString(),
      new Date(now.getTime() + INVITE_TTL_MS).toISOString());
  })();
  return { token, invite: peekInvite(token, now, database)! };
}

export function peekInvite(token: string, now: Date = new Date(), database: Database.Database = getDb()): InviteRecord | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = database.prepare("SELECT * FROM user_invites WHERE token_hash = ?").get(hashToken(token)) as InviteRow | undefined;
  if (!row || row.used_at !== null || now.getTime() >= Date.parse(row.expires_at)) return null;
  return toRecord(row);
}

export function consumeInvite(token: string, now: Date = new Date(), database: Database.Database = getDb()): InviteRecord | null {
  const invite = peekInvite(token, now, database);
  if (!invite) return null;
  const result = database.prepare("UPDATE user_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .run(now.toISOString(), invite.tokenHash);
  return result.changes === 1 ? invite : null;
}

export function hasOpenInvite(userId: string, now: Date = new Date(), database: Database.Database = getDb()): boolean {
  return database.prepare("SELECT 1 FROM user_invites WHERE user_id = ? AND used_at IS NULL AND expires_at > ?")
    .get(userId, now.toISOString()) !== undefined;
}
```

- [ ] **Step 5: Run tests**

Run: `cd apps/api && node --import tsx --test src/auth/session-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/session-store.ts apps/api/src/auth/invite-store.ts apps/api/src/auth/session-store.test.ts
git commit -m "feat(auth): hashed sessions and single-use invite links"
```

---

### Task 5: Grants, roles and principal

**Files:**
- Create: `apps/api/src/auth/principal.ts`, `apps/api/src/auth/grant-store.ts`, `apps/api/src/auth/scope-sql.ts`
- Modify: `packages/shared/src/index.ts` (append auth types)
- Test: `apps/api/src/auth/principal.test.ts`

**Interfaces:**
- Produces (shared, appended to `packages/shared/src/index.ts`):

```ts
export type RepositoryRole = "viewer" | "analyst" | "operator" | "maintainer";
export interface RepositoryGrant { repositoryKey: string; role: RepositoryRole; }
export interface AuthSessionUser { id: string; username: string; displayName: string; isAdmin: boolean; }
export interface AuthSessionResponse {
  user: AuthSessionUser;
  grants: RepositoryGrant[];
  csrfToken: string;
  runtimeMode: "local" | "server";
  repositoryRoots: string[];
}
export interface UserSummary {
  id: string; username: string; displayName: string; email: string | null;
  isAdmin: boolean; status: "active" | "disabled"; hasPassword: boolean; pendingInvite: boolean;
  repositoryCount: number; lastLoginAt: string | null; createdAt: string;
}
export interface UserSessionSummary { id: string; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null; current: boolean; }
export interface RepositoryAccessEntry {
  repositoryKey: string; displayName: string; source: "local" | "github";
  grants: Array<{ userId: string; username: string; displayName: string; role: RepositoryRole }>;
}
export interface InviteLinkResponse { inviteUrl: string; expiresAt: string; }
```

- Produces (API):

```ts
// principal.ts
export const ROLE_RANK: Record<RepositoryRole, number>; // viewer 1, analyst 2, operator 3, maintainer 4
export interface Principal { kind: "user" | "local"; userId: string | null; sessionId: string | null; username: string; displayName: string; isAdmin: boolean; grants: ReadonlyMap<string, RepositoryRole>; }
export type AccessScope = { kind: "all" } | { kind: "repositories"; keys: ReadonlySet<string> };
export const LOCAL_PRINCIPAL: Principal;
export function hasRepositoryRole(principal: Principal, repositoryKey: string | null | undefined, role: RepositoryRole): boolean;
export function canSeeRepository(principal: Principal, repositoryKey: string | null | undefined): boolean;
export function scopeOf(principal: Principal): AccessScope;
export function inScope(scope: AccessScope, repositoryKey: string | null | undefined): boolean;
export function principalOf(c: Context): Principal; // c.get("principal") or LOCAL_PRINCIPAL in local mode; throws Error("principal_missing") in server mode
export function csrfTokenOf(c: Context): string; // c.get("csrfToken") or the process securitySessionToken

// grant-store.ts
export function listUserGrants(userId: string, database?): RepositoryGrant[];
export function replaceUserGrants(userId: string, grants: RepositoryGrant[], grantedBy: string | null, database?): void; // throws Error("repository_unknown") | Error("role_invalid")
export function setRepositoryGrant(userId: string, repositoryKey: string, role: RepositoryRole | null, grantedBy: string | null, database?): void;
export function countUserGrants(userId: string, database?): number;
export function listRepositoryAccess(database?): RepositoryAccessEntry[];

// scope-sql.ts
export function scopeSql(scope: AccessScope, column: string): { sql: string; params: string[] }; // "" for all; " AND 0" for no keys; " AND column IN (?, …)"
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/auth/principal.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { canSeeRepository, hasRepositoryRole, inScope, LOCAL_PRINCIPAL, scopeOf, type Principal } from "./principal.js";
import { scopeSql } from "./scope-sql.js";

const member: Principal = {
  kind: "user", userId: "u1", sessionId: "s1", username: "ana", displayName: "Ana", isAdmin: false,
  grants: new Map([["github:1", "analyst"]]),
};

test("roles are cumulative and scoped to one repository", () => {
  assert.equal(hasRepositoryRole(member, "github:1", "viewer"), true);
  assert.equal(hasRepositoryRole(member, "github:1", "analyst"), true);
  assert.equal(hasRepositoryRole(member, "github:1", "operator"), false);
  assert.equal(hasRepositoryRole(member, "github:2", "viewer"), false);
  assert.equal(canSeeRepository(member, null), false);
  assert.equal(canSeeRepository(LOCAL_PRINCIPAL, null), true);
});

test("scopes translate to SQL without trusting keys as SQL", () => {
  assert.deepEqual(scopeSql(scopeOf(LOCAL_PRINCIPAL), "runs.repository_key"), { sql: "", params: [] });
  assert.deepEqual(scopeSql(scopeOf(member), "runs.repository_key"), { sql: " AND runs.repository_key IN (?)", params: ["github:1"] });
  assert.deepEqual(scopeSql({ kind: "repositories", keys: new Set() }, "x"), { sql: " AND 0", params: [] });
  assert.equal(inScope(scopeOf(member), null), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --import tsx --test src/auth/principal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `principal.ts` and `scope-sql.ts`**

```ts
// apps/api/src/auth/principal.ts
import type { Context } from "hono";
import type { RepositoryRole } from "@csb/shared";
import { runtimeMode } from "../deployment-settings.js";
import { securitySessionToken } from "../security-session.js";

export const ROLE_RANK: Record<RepositoryRole, number> = { viewer: 1, analyst: 2, operator: 3, maintainer: 4 };

export interface Principal {
  kind: "user" | "local";
  userId: string | null;
  sessionId: string | null;
  username: string;
  displayName: string;
  isAdmin: boolean;
  grants: ReadonlyMap<string, RepositoryRole>;
}

export type AccessScope = { kind: "all" } | { kind: "repositories"; keys: ReadonlySet<string> };

export const LOCAL_PRINCIPAL: Principal = {
  kind: "local", userId: null, sessionId: null, username: "local", displayName: "Local", isAdmin: true, grants: new Map(),
};

export function hasRepositoryRole(principal: Principal, repositoryKey: string | null | undefined, role: RepositoryRole): boolean {
  if (principal.isAdmin) return true;
  if (!repositoryKey) return false;
  const granted = principal.grants.get(repositoryKey);
  return granted !== undefined && ROLE_RANK[granted] >= ROLE_RANK[role];
}

export function canSeeRepository(principal: Principal, repositoryKey: string | null | undefined): boolean {
  return hasRepositoryRole(principal, repositoryKey, "viewer");
}

export function scopeOf(principal: Principal): AccessScope {
  return principal.isAdmin ? { kind: "all" } : { kind: "repositories", keys: new Set(principal.grants.keys()) };
}

export function inScope(scope: AccessScope, repositoryKey: string | null | undefined): boolean {
  return scope.kind === "all" || (!!repositoryKey && scope.keys.has(repositoryKey));
}

const serverMode = (() => {
  try { return runtimeMode(process.env) === "server"; } catch { return true; }
})();

export function principalOf(c: Context): Principal {
  const principal = c.get("principal" as never) as Principal | undefined;
  if (principal) return principal;
  if (serverMode) throw new Error("principal_missing");
  return LOCAL_PRINCIPAL;
}

export function csrfTokenOf(c: Context): string {
  return (c.get("csrfToken" as never) as string | undefined) ?? securitySessionToken;
}
```

```ts
// apps/api/src/auth/scope-sql.ts
import type { AccessScope } from "./principal.js";

export function scopeSql(scope: AccessScope, column: string): { sql: string; params: string[] } {
  if (scope.kind === "all") return { sql: "", params: [] };
  const keys = [...scope.keys];
  if (keys.length === 0) return { sql: " AND 0", params: [] };
  return { sql: ` AND ${column} IN (${keys.map(() => "?").join(", ")})`, params: keys };
}
```

- [ ] **Step 4: Implement `grant-store.ts`**

```ts
// apps/api/src/auth/grant-store.ts
import type Database from "better-sqlite3";
import type { RepositoryAccessEntry, RepositoryGrant, RepositoryRole } from "@csb/shared";
import { getDb } from "../db.js";
import { ROLE_RANK } from "./principal.js";

function assertRole(role: string): asserts role is RepositoryRole {
  if (!(role in ROLE_RANK)) throw new Error("role_invalid");
}

function assertRepository(repositoryKey: string, database: Database.Database): void {
  if (!database.prepare("SELECT 1 FROM guardrail_repositories WHERE repository_key = ?").get(repositoryKey)) {
    throw new Error("repository_unknown");
  }
}

export function listUserGrants(userId: string, database: Database.Database = getDb()): RepositoryGrant[] {
  return (database.prepare("SELECT repository_key, role FROM repository_grants WHERE user_id = ? ORDER BY repository_key")
    .all(userId) as Array<{ repository_key: string; role: RepositoryRole }>)
    .map((row) => ({ repositoryKey: row.repository_key, role: row.role }));
}

export function replaceUserGrants(userId: string, grants: RepositoryGrant[], grantedBy: string | null, database: Database.Database = getDb()): void {
  database.transaction(() => {
    for (const grant of grants) {
      assertRole(grant.role);
      assertRepository(grant.repositoryKey, database);
    }
    database.prepare("DELETE FROM repository_grants WHERE user_id = ?").run(userId);
    const insert = database.prepare("INSERT INTO repository_grants (user_id, repository_key, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)");
    const now = new Date().toISOString();
    for (const grant of grants) insert.run(userId, grant.repositoryKey, grant.role, grantedBy, now);
  })();
}

export function setRepositoryGrant(userId: string, repositoryKey: string, role: RepositoryRole | null, grantedBy: string | null, database: Database.Database = getDb()): void {
  if (role === null) {
    database.prepare("DELETE FROM repository_grants WHERE user_id = ? AND repository_key = ?").run(userId, repositoryKey);
    return;
  }
  assertRole(role);
  assertRepository(repositoryKey, database);
  database.prepare(`
    INSERT INTO repository_grants (user_id, repository_key, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, repository_key) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at
  `).run(userId, repositoryKey, role, grantedBy, new Date().toISOString());
}

export function countUserGrants(userId: string, database: Database.Database = getDb()): number {
  return (database.prepare("SELECT COUNT(*) AS n FROM repository_grants WHERE user_id = ?").get(userId) as { n: number }).n;
}

export function listRepositoryAccess(database: Database.Database = getDb()): RepositoryAccessEntry[] {
  const repositories = database.prepare("SELECT repository_key, display_name, source FROM guardrail_repositories ORDER BY display_name")
    .all() as Array<{ repository_key: string; display_name: string; source: "local" | "github" }>;
  const grants = database.prepare(`
    SELECT g.repository_key, g.role, u.id, u.username, u.display_name
    FROM repository_grants g JOIN users u ON u.id = g.user_id ORDER BY u.username
  `).all() as Array<{ repository_key: string; role: RepositoryRole; id: string; username: string; display_name: string }>;
  return repositories.map((repository) => ({
    repositoryKey: repository.repository_key,
    displayName: repository.display_name,
    source: repository.source,
    grants: grants.filter((g) => g.repository_key === repository.repository_key)
      .map((g) => ({ userId: g.id, username: g.username, displayName: g.display_name, role: g.role })),
  }));
}
```

- [ ] **Step 5: Add the shared types**, exactly as in the Interfaces block, at the end of `packages/shared/src/index.ts`.

- [ ] **Step 6: Run tests and typecheck**

Run: `cd apps/api && node --import tsx --test src/auth/principal.test.ts && cd ../.. && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/principal.ts apps/api/src/auth/grant-store.ts apps/api/src/auth/scope-sql.ts apps/api/src/auth/principal.test.ts packages/shared/src/index.ts
git commit -m "feat(auth): repository roles, access scopes and grants"
```

---

### Task 6: Run repository keys

**Files:**
- Create: `apps/api/src/auth/repository-key.ts`
- Modify: `apps/api/src/db.ts` (`upsertRun` at ~line 456: persist `repository_key`), `apps/api/src/index.ts` (call backfill after `getDb()`), `apps/api/src/app.ts` (`POST /guardrails/repositories` handler at ~line 392+: call backfill after a successful upsert)
- Test: `apps/api/src/auth/repository-key.test.ts`

**Interfaces:**
- Produces: `resolveRunRepositoryKey(repositoryPath: string | null, database?): string | null`; `backfillRunRepositoryKeys(database?): number` (fills rows with `repository_key IS NULL`, returns count updated); `getRunRepositoryKey(runId: string, database?): string | null | undefined` (`undefined` when the run does not exist).

Rules: `github:<digits>@<anything>` → the repository with that `github_repository_id`. Absolute path → the local repository whose `repository_path` equals it or is its parent directory (`startsWith(path + "/")`); longest match wins. Anything else → `null`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/auth/repository-key.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureAuthSchema } from "./schema.js";
import { backfillRunRepositoryKeys, getRunRepositoryKey, resolveRunRepositoryKey } from "./repository-key.js";

function setup() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  db.exec(`CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY, repository_path TEXT, source TEXT, github_repository_id TEXT)`);
  ensureAuthSchema(db);
  return db;
}

test("maps GitHub and local run paths to registered repositories", () => {
  const db = setup();
  db.prepare("INSERT INTO guardrail_repositories VALUES ('github:42', NULL, 'github', '42')").run();
  db.prepare("INSERT INTO guardrail_repositories VALUES ('local/app', '/repos/app', 'local', NULL)").run();
  db.prepare("INSERT INTO guardrail_repositories VALUES ('local/app-api', '/repos/app/api', 'local', NULL)").run();
  assert.equal(resolveRunRepositoryKey(`github:42@${"a".repeat(40)}`, db), "github:42");
  assert.equal(resolveRunRepositoryKey("github:43@abc", db), null);
  assert.equal(resolveRunRepositoryKey("/repos/app", db), "local/app");
  assert.equal(resolveRunRepositoryKey("/repos/app/api/src", db), "local/app-api");
  assert.equal(resolveRunRepositoryKey("/repos/application", db), null);
  assert.equal(resolveRunRepositoryKey(null, db), null);
});

test("a run recorded before its repository was registered gains the key on backfill", () => {
  const db = setup();
  db.prepare("INSERT INTO runs (id, repository_path) VALUES ('r1', '/repos/late')").run();
  assert.equal(backfillRunRepositoryKeys(db), 0);
  assert.equal(getRunRepositoryKey("r1", db), null);
  db.prepare("INSERT INTO guardrail_repositories VALUES ('local/late', '/repos/late', 'local', NULL)").run();
  assert.equal(backfillRunRepositoryKeys(db), 1);
  assert.equal(getRunRepositoryKey("r1", db), "local/late");
  assert.equal(getRunRepositoryKey("missing", db), undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --import tsx --test src/auth/repository-key.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/auth/repository-key.ts
import type Database from "better-sqlite3";
import { getDb } from "../db.js";

export function resolveRunRepositoryKey(repositoryPath: string | null, database: Database.Database = getDb()): string | null {
  if (!repositoryPath) return null;
  const github = /^github:(\d+)@/.exec(repositoryPath);
  if (github) {
    const row = database.prepare("SELECT repository_key FROM guardrail_repositories WHERE github_repository_id = ?")
      .get(github[1]) as { repository_key: string } | undefined;
    return row?.repository_key ?? null;
  }
  if (!repositoryPath.startsWith("/")) return null;
  const candidates = database.prepare("SELECT repository_key, repository_path FROM guardrail_repositories WHERE repository_path IS NOT NULL")
    .all() as Array<{ repository_key: string; repository_path: string }>;
  let best: { key: string; length: number } | null = null;
  for (const candidate of candidates) {
    const root = candidate.repository_path.replace(/\/+$/, "");
    if (repositoryPath === root || repositoryPath.startsWith(`${root}/`)) {
      if (!best || root.length > best.length) best = { key: candidate.repository_key, length: root.length };
    }
  }
  return best?.key ?? null;
}

export function backfillRunRepositoryKeys(database: Database.Database = getDb()): number {
  const rows = database.prepare("SELECT id, repository_path FROM runs WHERE repository_key IS NULL AND repository_path IS NOT NULL")
    .all() as Array<{ id: string; repository_path: string }>;
  const update = database.prepare("UPDATE runs SET repository_key = ? WHERE id = ?");
  let updated = 0;
  database.transaction(() => {
    for (const row of rows) {
      const key = resolveRunRepositoryKey(row.repository_path, database);
      if (key !== null) { update.run(key, row.id); updated += 1; }
    }
  })();
  return updated;
}

export function getRunRepositoryKey(runId: string, database: Database.Database = getDb()): string | null | undefined {
  const row = database.prepare("SELECT repository_key FROM runs WHERE id = ?").get(runId) as { repository_key: string | null } | undefined;
  return row === undefined ? undefined : row.repository_key;
}
```

- [ ] **Step 4: Persist on upsert.** In `db.ts` `upsertRun`, add `repository_key` to the INSERT column list and values as `@repository_key`, and to the `ON CONFLICT … DO UPDATE SET` list as `repository_key = COALESCE(runs.repository_key, excluded.repository_key)`. Compute the parameter before the statement runs:

```ts
    repository_key: run.repositoryKey ?? resolveRunRepositoryKey(run.repositoryPath),
```

Import `resolveRunRepositoryKey` from `./auth/repository-key.js` (circular import with `getDb` is safe: both are used only inside functions).

- [ ] **Step 5: Backfill on startup and on registration.** In `index.ts`, after `ensureConnectionSchema(getDb());` add `backfillRunRepositoryKeys();`. In the `POST /guardrails/repositories` handler in `app.ts`, call `backfillRunRepositoryKeys();` after the repository is stored and before responding.

- [ ] **Step 6: Run tests**

Run: `cd apps/api && node --import tsx --test src/auth/repository-key.test.ts && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/repository-key.ts apps/api/src/auth/repository-key.test.ts apps/api/src/db.ts apps/api/src/index.ts apps/api/src/app.ts
git commit -m "feat(auth): attribute runs to registered repositories"
```

---

### Task 7: Auth service (login, lockout, invites, password change, admin bootstrap)

**Files:**
- Create: `apps/api/src/auth/rate-limit.ts`, `apps/api/src/auth/auth-service.ts`
- Test: `apps/api/src/auth/auth-service.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:

```ts
// rate-limit.ts
export class FailureWindow { constructor(limit: number, windowMs: number, now?: () => number); blocked(key: string): number | null; /* seconds to wait */ fail(key: string): void; reset(key: string): void; }

// auth-service.ts
export type LoginResult =
  | { ok: true; token: string; session: SessionRecord; user: UserRecord }
  | { ok: false; error: "invalid_credentials" }
  | { ok: false; error: "account_locked"; retryAfterSeconds: number }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number };
export function lockoutMs(failedAttempts: number): number; // 0 below 5; 15min * 2^(floor(n/5)-1), capped at 24h
export async function login(input: { username: string; password: string; ip: string | null; userAgent: string | null; now?: Date }, database?): Promise<LoginResult>;
export function logout(sessionId: string, database?): void;
export function principalForSession(session: SessionRecord, database?): Principal | null; // null when user missing or disabled
export async function acceptInvite(input: { token: string; password: string; ip: string | null; userAgent: string | null; now?: Date }, database?): Promise<{ ok: true; token: string; session: SessionRecord } | { ok: false; error: "invite_invalid" | ReturnType<typeof passwordPolicyError> & string }>;
export async function changePassword(input: { userId: string; sessionId: string; currentPassword: string; newPassword: string }, database?): Promise<{ ok: true } | { ok: false; error: "invalid_credentials" | "password_too_short" | "password_too_long" | "password_matches_username" }>;
export async function bootstrapAdmin(settings: { username: string; password: string }, database?): Promise<"created" | "recovered" | "unchanged">;
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/auth/auth-service.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureAuthSchema } from "./schema.js";
import { createUser, findUserByUsername, updateUser } from "./user-store.js";
import { hashPassword } from "./passwords.js";
import { createInvite } from "./invite-store.js";
import { resolveSession } from "./session-store.js";
import { acceptInvite, bootstrapAdmin, changePassword, lockoutMs, login, principalForSession } from "./auth-service.js";

function setup() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(db);
  return db;
}

test("logs in with a normalized username and returns a principal", async () => {
  const db = setup();
  createUser({ username: "ana", displayName: "Ana", isAdmin: false, passwordHash: await hashPassword("ana password 123") }, db);
  const result = await login({ username: " ANA ", password: "ana password 123", ip: "1.1.1.1", userAgent: null }, db);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(principalForSession(result.session, db)?.username, "ana");
  assert.ok(findUserByUsername("ana", db)?.lastLoginAt);
});

test("locks the account after five failures and doubles the lock", async () => {
  assert.equal(lockoutMs(4), 0);
  assert.equal(lockoutMs(5), 15 * 60_000);
  assert.equal(lockoutMs(10), 30 * 60_000);
  assert.equal(lockoutMs(100), 24 * 3600_000);
  const db = setup();
  createUser({ username: "ana", displayName: "Ana", isAdmin: false, passwordHash: await hashPassword("ana password 123") }, db);
  const now = new Date("2026-09-29T10:00:00.000Z");
  for (let i = 0; i < 5; i += 1) {
    const failed = await login({ username: "ana", password: "wrong", ip: `10.0.0.${i}`, userAgent: null, now }, db);
    assert.equal(failed.ok, false);
  }
  const locked = await login({ username: "ana", password: "ana password 123", ip: "10.0.1.1", userAgent: null, now }, db);
  assert.deepEqual(locked, { ok: false, error: "account_locked", retryAfterSeconds: 900 });
  const later = await login({ username: "ana", password: "ana password 123", ip: "10.0.1.1", userAgent: null, now: new Date(now.getTime() + 901_000) }, db);
  assert.equal(later.ok, true);
});

test("does not reveal whether the username exists and refuses disabled users", async () => {
  const db = setup();
  const user = createUser({ username: "ana", displayName: "Ana", isAdmin: false, passwordHash: await hashPassword("ana password 123") }, db);
  assert.deepEqual(await login({ username: "nobody", password: "x", ip: "2.2.2.2", userAgent: null }, db), { ok: false, error: "invalid_credentials" });
  updateUser(user.id, { status: "disabled" }, db);
  assert.deepEqual(await login({ username: "ana", password: "ana password 123", ip: "2.2.2.3", userAgent: null }, db), { ok: false, error: "invalid_credentials" });
});

test("accepting an invite sets the password, consumes the link and signs in", async () => {
  const db = setup();
  const user = createUser({ username: "ana", displayName: "Ana", isAdmin: false }, db);
  const { token } = createInvite({ userId: user.id, purpose: "invite", createdBy: null }, db);
  assert.deepEqual(await acceptInvite({ token, password: "short", ip: null, userAgent: null }, db), { ok: false, error: "password_too_short" });
  const accepted = await acceptInvite({ token, password: "a strong password", ip: null, userAgent: null }, db);
  assert.equal(accepted.ok, true);
  assert.deepEqual(await acceptInvite({ token, password: "a strong password", ip: null, userAgent: null }, db), { ok: false, error: "invite_invalid" });
});

test("changing the password revokes the other sessions only", async () => {
  const db = setup();
  createUser({ username: "ana", displayName: "Ana", isAdmin: false, passwordHash: await hashPassword("ana password 123") }, db);
  const a = await login({ username: "ana", password: "ana password 123", ip: "3.3.3.1", userAgent: null }, db);
  const b = await login({ username: "ana", password: "ana password 123", ip: "3.3.3.2", userAgent: null }, db);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(await changePassword({ userId: a.user.id, sessionId: a.session.id, currentPassword: "wrong", newPassword: "another password" }, db), { ok: false, error: "invalid_credentials" });
  assert.deepEqual(await changePassword({ userId: a.user.id, sessionId: a.session.id, currentPassword: "ana password 123", newPassword: "another password" }, db), { ok: true });
  assert.ok(resolveSession(a.token, undefined, db));
  assert.equal(resolveSession(b.token, undefined, db), null);
});

test("bootstraps the first admin and recovers when no active admin remains", async () => {
  const db = setup();
  const settings = { username: "admin", password: "docker-secret-password-24chars" };
  assert.equal(await bootstrapAdmin(settings, db), "created");
  assert.equal(await bootstrapAdmin(settings, db), "unchanged");
  const admin = findUserByUsername("admin", db)!;
  updateUser(admin.id, { status: "disabled", passwordHash: await hashPassword("forgotten password") }, db);
  assert.equal(await bootstrapAdmin(settings, db), "recovered");
  const login1 = await login({ username: "admin", password: settings.password, ip: "4.4.4.4", userAgent: null }, db);
  assert.equal(login1.ok, true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --import tsx --test src/auth/auth-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `rate-limit.ts`**

```ts
// apps/api/src/auth/rate-limit.ts
export class FailureWindow {
  readonly #entries = new Map<string, { count: number; start: number }>();

  constructor(readonly limit: number, readonly windowMs: number, readonly now: () => number = Date.now) {}

  blocked(key: string): number | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    const elapsed = this.now() - entry.start;
    if (elapsed >= this.windowMs) { this.#entries.delete(key); return null; }
    return entry.count >= this.limit ? Math.ceil((this.windowMs - elapsed) / 1000) : null;
  }

  fail(key: string): void {
    const now = this.now();
    const entry = this.#entries.get(key);
    if (!entry || now - entry.start >= this.windowMs) this.#entries.set(key, { count: 1, start: now });
    else entry.count += 1;
    if (this.#entries.size > 10_000) this.#entries.delete(this.#entries.keys().next().value!);
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }
}
```

- [ ] **Step 4: Implement `auth-service.ts`**

```ts
// apps/api/src/auth/auth-service.ts
import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { listUserGrants } from "./grant-store.js";
import { consumeInvite, peekInvite } from "./invite-store.js";
import { hashPassword, passwordPolicyError, verifyPassword } from "./passwords.js";
import type { Principal } from "./principal.js";
import { FailureWindow } from "./rate-limit.js";
import { createSession, revokeSession, revokeUserSessions, type SessionRecord } from "./session-store.js";
import { countActiveAdmins, createUser, findUserByUsername, getUser, updateUser, type UserRecord } from "./user-store.js";

const ipFailures = new FailureWindow(30, 60_000);
const LOCK_BASE_MS = 15 * 60_000;
const LOCK_MAX_MS = 24 * 3600_000;

export type LoginResult =
  | { ok: true; token: string; session: SessionRecord; user: UserRecord }
  | { ok: false; error: "invalid_credentials" }
  | { ok: false; error: "account_locked"; retryAfterSeconds: number }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number };

export function lockoutMs(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  return Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (Math.floor(failedAttempts / 5) - 1));
}

export async function login(
  input: { username: string; password: string; ip: string | null; userAgent: string | null; now?: Date },
  database: Database.Database = getDb(),
): Promise<LoginResult> {
  const now = input.now ?? new Date();
  const ipKey = input.ip ?? "unknown";
  const ipWait = ipFailures.blocked(ipKey);
  if (ipWait !== null) return { ok: false, error: "rate_limited", retryAfterSeconds: ipWait };
  const user = findUserByUsername(input.username, database);
  if (user?.lockedUntil && Date.parse(user.lockedUntil) > now.getTime()) {
    return { ok: false, error: "account_locked", retryAfterSeconds: Math.ceil((Date.parse(user.lockedUntil) - now.getTime()) / 1000) };
  }
  const matches = await verifyPassword(input.password, user?.passwordHash ?? null);
  if (!user || !matches || user.status !== "active") {
    ipFailures.fail(ipKey);
    if (user && !matches) {
      const failedAttempts = user.failedAttempts + 1;
      const lock = failedAttempts % 5 === 0 ? lockoutMs(failedAttempts) : 0;
      updateUser(user.id, {
        failedAttempts,
        lockedUntil: lock > 0 ? new Date(now.getTime() + lock).toISOString() : user.lockedUntil,
      }, database);
    }
    return { ok: false, error: "invalid_credentials" };
  }
  updateUser(user.id, { failedAttempts: 0, lockedUntil: null, lastLoginAt: now.toISOString() }, database);
  const { token, session } = createSession({ userId: user.id, ip: input.ip, userAgent: input.userAgent, now }, database);
  return { ok: true, token, session, user: getUser(user.id, database)! };
}

export function logout(sessionId: string, database: Database.Database = getDb()): void {
  revokeSession(sessionId, database);
}

export function principalForSession(session: SessionRecord, database: Database.Database = getDb()): Principal | null {
  const user = getUser(session.userId, database);
  if (!user || user.status !== "active") return null;
  return {
    kind: "user",
    userId: user.id,
    sessionId: session.id,
    username: user.username,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
    grants: new Map(listUserGrants(user.id, database).map((grant) => [grant.repositoryKey, grant.role])),
  };
}

export async function acceptInvite(
  input: { token: string; password: string; ip: string | null; userAgent: string | null; now?: Date },
  database: Database.Database = getDb(),
): Promise<
  | { ok: true; token: string; session: SessionRecord }
  | { ok: false; error: "invite_invalid" | "password_too_short" | "password_too_long" | "password_matches_username" }
> {
  const now = input.now ?? new Date();
  const invite = peekInvite(input.token, now, database);
  const user = invite ? getUser(invite.userId, database) : null;
  if (!invite || !user || user.status !== "active") return { ok: false, error: "invite_invalid" };
  const policy = passwordPolicyError(input.password, user.username);
  if (policy) return { ok: false, error: policy };
  const passwordHash = await hashPassword(input.password);
  if (!consumeInvite(input.token, now, database)) return { ok: false, error: "invite_invalid" };
  updateUser(user.id, { passwordHash, failedAttempts: 0, lockedUntil: null, lastLoginAt: now.toISOString() }, database);
  revokeUserSessions(user.id, null, database);
  const { token, session } = createSession({ userId: user.id, ip: input.ip, userAgent: input.userAgent, now }, database);
  return { ok: true, token, session };
}

export async function changePassword(
  input: { userId: string; sessionId: string; currentPassword: string; newPassword: string },
  database: Database.Database = getDb(),
): Promise<{ ok: true } | { ok: false; error: "invalid_credentials" | "password_too_short" | "password_too_long" | "password_matches_username" }> {
  const user = getUser(input.userId, database);
  if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash))) return { ok: false, error: "invalid_credentials" };
  const policy = passwordPolicyError(input.newPassword, user.username);
  if (policy) return { ok: false, error: policy };
  updateUser(user.id, { passwordHash: await hashPassword(input.newPassword) }, database);
  revokeUserSessions(user.id, input.sessionId, database);
  return { ok: true };
}

export async function bootstrapAdmin(
  settings: { username: string; password: string },
  database: Database.Database = getDb(),
): Promise<"created" | "recovered" | "unchanged"> {
  const existing = findUserByUsername(settings.username, database);
  const anyUser = database.prepare("SELECT 1 FROM users LIMIT 1").get() !== undefined;
  if (!anyUser) {
    createUser({ username: settings.username, displayName: settings.username, isAdmin: true, passwordHash: await hashPassword(settings.password) }, database);
    return "created";
  }
  if (countActiveAdmins(database) > 0) return "unchanged";
  const passwordHash = await hashPassword(settings.password);
  if (existing) {
    updateUser(existing.id, { isAdmin: true, status: "active", passwordHash, failedAttempts: 0, lockedUntil: null }, database);
  } else {
    createUser({ username: settings.username, displayName: settings.username, isAdmin: true, passwordHash }, database);
  }
  return "recovered";
}
```

- [ ] **Step 5: Run tests**

Run: `cd apps/api && node --import tsx --test src/auth/auth-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/rate-limit.ts apps/api/src/auth/auth-service.ts apps/api/src/auth/auth-service.test.ts
git commit -m "feat(auth): login with lockout, invites, password change and admin bootstrap"
```

---

### Task 8: Session-based server security and per-session CSRF

**Files:**
- Modify: `apps/api/src/server-security.ts` (server branch of `serverSecurity`), `apps/api/src/security-session.ts` (add `validRequestCsrf`), `apps/api/src/app.ts:154-157` (`/security-session`), `apps/api/src/connections-api.ts:39,47`, `apps/api/src/engine-updates-api.ts:38-58`, `apps/api/src/github-integration-security.ts:19`, `apps/api/src/server-app.ts`
- Modify test: `apps/api/src/server-app.test.ts`

**Interfaces:**
- Consumes: `resolveSession` (Task 4), `principalForSession` (Task 7), `principalOf`/`csrfTokenOf` (Task 5).
- Produces:
  - `SESSION_COOKIE = "__Host-sentinel_session"` exported from `server-security.ts`.
  - Context variables set in server mode for authenticated `/api/*` requests: `principal: Principal`, `csrfToken: string`.
  - `validRequestCsrf(c: Context): boolean` in `security-session.ts`: compares `X-CSRF-Token` with `csrfTokenOf(c)` using `validSecurityToken`.
  - Public API paths in server mode (no session needed): `POST /api/auth/login`, `GET /api/auth/invites/:token`, `POST /api/auth/invites/:token`. `GET /api/auth/session` without a session returns `401`.
  - Non-API paths (SPA HTML and assets) are served without a session so `/login` can render.

Behaviour of the new server branch, in order:
1. Security headers (unchanged).
2. `/healthz`, `/readyz` GET/HEAD pass (unchanged).
3. Host check (unchanged).
4. Paths not starting with `/api/` → `next()`.
5. Origin/`Sec-Fetch-Site` checks (unchanged, same manifest-callback exemption).
6. Public auth paths: mutations require `Origin === settings.origin`; then `next()`.
7. Read cookie `__Host-sentinel_session`; `resolveSession`; `principalForSession`. Missing or invalid → `401 {"error":"authentication_required"}`.
8. `c.set("principal", …)`, `c.set("csrfToken", session.csrfToken)`.
9. Mutations require `Origin === settings.origin` and `X-CSRF-Token === session.csrfToken` → else `403 {"error":"csrf_invalid"}`.

- [ ] **Step 1: Rewrite the server test first.** Replace the Basic-auth expectations in `server-app.test.ts` with session expectations. Add a helper that seeds a user and a session in the test data dir:

```ts
import { getDb } from "./db.js";
import { createUser } from "./auth/user-store.js";
import { hashPassword } from "./auth/passwords.js";
import { createSession } from "./auth/session-store.js";

async function sessionCookie(isAdmin = true): Promise<{ cookie: string; csrf: string }> {
  const user = createUser({ username: `u${Math.random().toString(36).slice(2, 10)}`, displayName: "T", isAdmin, passwordHash: await hashPassword("test password 1234") }, getDb());
  const { token, session } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  return { cookie: `__Host-sentinel_session=${token}`, csrf: session.csrfToken };
}
```

Tests to write (replacing the Basic-auth test body; keep the local-mode tests unchanged):

```ts
test("server serves the SPA publicly but requires a session for the API", async () => {
  // … same webRoot/api setup as the existing test …
  assert.equal((await app.request(origin + "/")).status, 200);
  assert.equal((await app.request(origin + "/app.js")).status, 200);
  for (const resource of ["/api/scans", "/api/events"]) {
    const response = await app.request(origin + resource);
    assert.equal(response.status, 401, resource);
    assert.deepEqual(await response.json(), { error: "authentication_required" });
  }
  const { cookie, csrf } = await sessionCookie();
  assert.equal((await app.request(origin + "/api/scans", { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await app.request(origin + "/api/scans", { method: "POST", headers: { Cookie: cookie, Origin: origin } })).status, 403);
  assert.equal((await app.request(origin + "/api/scans", { method: "POST", headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": securitySessionToken } })).status, 403);
  assert.equal((await app.request(origin + "/api/scans", { method: "POST", headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf } })).status, 201);
  assert.equal((await app.request(origin + "/api/scans", { headers: { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}` } })).status, 401);
});

test("login is public but refuses foreign origins", async () => {
  // api stub: api.post("/auth/login", (c) => c.json({ ok: true }));
  assert.equal((await app.request(origin + "/api/auth/login", { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await app.request(origin + "/api/auth/login", { method: "POST", headers: { Origin: origin } })).status, 200);
});

test("a revoked session is refused on the next request", async () => {
  const { cookie } = await sessionCookie();
  // revoke via revokeUserSessions for that user, then expect 401
});
```

Write the third test concretely: capture the user id from `sessionCookie` (return it too), call `revokeUserSessions(userId, null, getDb())`, then assert `401` on `GET /api/scans`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --import tsx --test src/server-app.test.ts`
Expected: FAIL — SPA returns 401 and Basic auth still accepted.

- [ ] **Step 3: Implement the server branch**

Replace the body of the server branch of `serverSecurity` (everything after the security headers) with:

```ts
import { getCookie } from "hono/cookie";
import { principalForSession } from "./auth/auth-service.js";
import { resolveSession } from "./auth/session-store.js";

export const SESSION_COOKIE = "__Host-sentinel_session";
const PUBLIC_API = [/^\/api\/auth\/login$/, /^\/api\/auth\/invites\/[A-Za-z0-9_-]{43}$/];

export function serverSecurity(settings: ServerSettings): MiddlewareHandler {
  return async (c, next) => {
    if (settings.mode === "local") return localRequestSecurity(c, next);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
    if ((c.req.path === "/healthz" || c.req.path === "/readyz") && ["GET", "HEAD"].includes(c.req.method)) return next();
    if (new URL(c.req.url).host !== new URL(settings.origin!).host) return c.json({ error: "origin_denied" }, 403);
    if (!c.req.path.startsWith("/api/")) return next();
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    const origin = c.req.header("Origin");
    const callback = c.req.method === "GET" && c.req.path === "/api/guardrails/github-app/manifest/callback";
    if (!callback && ((origin && origin !== settings.origin) ||
        ["cross-site", "same-site"].includes(c.req.header("Sec-Fetch-Site") ?? ""))) {
      return c.json({ error: "origin_denied" }, 403);
    }
    if (PUBLIC_API.some((pattern) => pattern.test(c.req.path))) {
      if (mutation && origin !== settings.origin) return c.json({ error: "origin_denied" }, 403);
      return next();
    }
    const session = resolveSession(getCookie(c, SESSION_COOKIE) ?? "");
    const principal = session ? principalForSession(session) : null;
    if (!session || !principal) return c.json({ error: "authentication_required" }, 401);
    c.set("principal" as never, principal as never);
    c.set("csrfToken" as never, session.csrfToken as never);
    if (mutation && (origin !== settings.origin || !validSecurityToken(c.req.header("X-CSRF-Token"), session.csrfToken))) {
      return c.json({ error: "csrf_invalid" }, 403);
    }
    await next();
  };
}
```

Remove the unused `createHash`/`timingSafeEqual` imports and the global failure counter. `ServerSettings.username/password` stay: they are the bootstrap credentials (Task 13).

- [ ] **Step 4: Per-request CSRF everywhere.** In `security-session.ts` add:

```ts
import type { Context } from "hono";
import { csrfTokenOf } from "./auth/principal.js";

export function validRequestCsrf(c: Context): boolean {
  return validSecurityToken(c.req.header("X-CSRF-Token"), csrfTokenOf(c));
}
```

Then:
- `app.ts` `GET /security-session`: return `csrfToken: csrfTokenOf(c)`.
- `connections-api.ts`: `GET /connections/security-session` returns `{ csrfToken: csrfTokenOf(c) }`; every `validSecurityToken(header)` / `timingSafeEqual` CSRF check in the file becomes `validRequestCsrf(c)`.
- `engine-updates-api.ts`: `/engine-updates/security-session` returns `csrfTokenOf(c)`; the middleware at :40-57 validates with `validRequestCsrf(c)`.
- `github-integration-security.ts`: CSRF check becomes `validRequestCsrf(c)`.

`csrfTokenOf` falls back to the process token, so local mode behaves exactly as today.

- [ ] **Step 5: Run the full API suite**

Run: `cd apps/api && npx tsc -b --pretty false && npm test`
Expected: PASS (existing local-mode tests unchanged; `server-app.test.ts` new expectations pass).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/server-security.ts apps/api/src/security-session.ts apps/api/src/app.ts apps/api/src/connections-api.ts apps/api/src/engine-updates-api.ts apps/api/src/github-integration-security.ts apps/api/src/server-app.test.ts
git commit -m "feat(auth): cookie sessions and per-session CSRF replace HTTP Basic"
```

---

### Task 9: Auth and account API

**Files:**
- Create: `apps/api/src/auth/auth-api.ts`
- Modify: `apps/api/src/app.ts` (mount `app.route("/", createAuthApi({ settings: loadServerSettings() }))` next to the other `app.route("/", …)` calls at ~line 724)
- Test: `apps/api/src/auth/auth-api.test.ts`

**Interfaces:**
- Consumes: Tasks 4–8.
- Produces routes (paths relative to the `api` app):

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /auth/login` | `{ username, password }` | `200 { ok: true }` + `Set-Cookie` | `401 invalid_credentials`, `423 account_locked { retryAfterSeconds }`, `429 rate_limited` + `Retry-After` |
| `POST /auth/logout` | — | `204`, cookie cleared | — |
| `GET /auth/session` | — | `200 AuthSessionResponse` | `401` (server, no session) |
| `GET /auth/invites/:token` | — | `200 { username, displayName, purpose, invitedBy, expiresAt }` | `404 invite_invalid` |
| `POST /auth/invites/:token` | `{ password }` | `200 { ok: true }` + `Set-Cookie` | `404 invite_invalid`, `400 password_*` |
| `PATCH /account/profile` | `{ displayName }` | `200 AuthSessionUser` | `400 display_name_invalid`, `404` in local mode |
| `POST /account/password` | `{ currentPassword, newPassword }` | `204` | `400 invalid_credentials` / `password_*`, `404` in local mode |
| `GET /account/sessions` | — | `200 { sessions: UserSessionSummary[] }` | `404` in local mode |
| `DELETE /account/sessions/others` | — | `204` | |
| `DELETE /account/sessions/:id` | — | `204` (only own sessions, else `404`) | |

`createAuthApi(deps: { settings: ServerSettings; now?: () => Date }): Hono`. Cookie options: `{ httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 7 * 24 * 3600 }`. Client IP: first entry of `X-Forwarded-For` when present (Dokploy's Traefik sets it), else `null`. `/auth/session` in local mode returns `{ user: { id: "local", username: "local", displayName: "Local", isAdmin: true }, grants: [], csrfToken: csrfTokenOf(c), runtimeMode: "local", repositoryRoots: settings.repositoryRoots }`.

- [ ] **Step 1: Write the failing test.** Build a server app in server mode around a Hono `api` that mounts `createAuthApi`, as in `server-app.test.ts`, and cover:

```ts
test("logs in, reads the session, and logs out", async () => {
  const { app, origin } = serverWithAuthApi();
  await seedUser("ana", "ana password 123");
  const login = await app.request(`${origin}/api/auth/login`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Ana", password: "ana password 123" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!;
  assert.match(cookie, /^__Host-sentinel_session=[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  const pair = cookie.split(";")[0]!;
  const session = await (await app.request(`${origin}/api/auth/session`, { headers: { Cookie: pair } })).json();
  assert.equal(session.user.username, "ana");
  assert.equal(session.runtimeMode, "server");
  const logout = await app.request(`${origin}/api/auth/logout`, { method: "POST", headers: { Cookie: pair, Origin: origin, "X-CSRF-Token": session.csrfToken } });
  assert.equal(logout.status, 204);
  assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: pair } })).status, 401);
});

test("returns the lockout contract after five failures", async () => {
  const { app, origin } = serverWithAuthApi();
  const username = await seedUser(`lock${Date.now()}`, "right password 1");
  const attempt = (password: string, ip: string) => app.request(`${origin}/api/auth/login`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ username, password }),
  });
  for (let i = 0; i < 5; i += 1) assert.equal((await attempt("wrong", `10.9.0.${i}`)).status, 401);
  const locked = await attempt("right password 1", "10.9.1.1");
  assert.equal(locked.status, 423);
  assert.deepEqual(await locked.json(), { error: "account_locked", retryAfterSeconds: 900 });
});

test("an invite link can be read once and accepted once", async () => {
  const { app, origin } = serverWithAuthApi();
  const user = createUser({ username: `inv${Date.now()}`, displayName: "Invited", isAdmin: false }, getDb());
  const { token } = createInvite({ userId: user.id, purpose: "invite", createdBy: null }, getDb());
  const peek = await app.request(`${origin}/api/auth/invites/${token}`);
  assert.equal(peek.status, 200);
  assert.equal((await peek.json()).username, user.username);
  const accept = () => app.request(`${origin}/api/auth/invites/${token}`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "a strong password" }),
  });
  const first = await accept();
  assert.equal(first.status, 200);
  assert.match(first.headers.get("set-cookie")!, /^__Host-sentinel_session=/);
  assert.equal((await accept()).status, 404);
});

test("account routes change the password and list only the caller's sessions", async () => {
  const { app, origin } = serverWithAuthApi();
  const username = await seedUser(`acct${Date.now()}`, "account password 1");
  const signIn = async (ip: string) => {
    const response = await app.request(`${origin}/api/auth/login`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ username, password: "account password 1" }),
    });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await app.request(`${origin}/api/auth/session`, { headers: { Cookie: cookie } })).json();
    return { cookie, csrf: session.csrfToken as string };
  };
  const a = await signIn("10.8.0.1");
  const b = await signIn("10.8.0.2");
  const sessions = await (await app.request(`${origin}/api/account/sessions`, { headers: { Cookie: a.cookie } })).json();
  assert.equal(sessions.sessions.length, 2);
  assert.equal(sessions.sessions.filter((s: { current: boolean }) => s.current).length, 1);
  const change = await app.request(`${origin}/api/account/password`, {
    method: "POST", headers: { Cookie: a.cookie, Origin: origin, "X-CSRF-Token": a.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: "account password 1", newPassword: "account password 2" }),
  });
  assert.equal(change.status, 204);
  assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: a.cookie } })).status, 200);
  assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: b.cookie } })).status, 401);
});
```

Helpers for this file:

```ts
import { Hono } from "hono";
import { createServerApp } from "../server-app.js";
import { getDb } from "../db.js";
import { createAuthApi } from "./auth-api.js";
import { createInvite } from "./invite-store.js";
import { hashPassword } from "./passwords.js";
import { createUser } from "./user-store.js";

const origin = "https://sentinel.example";
const settings = { mode: "server", origin, username: "admin", password: "x".repeat(24), repositoryRoots: [] } as const;

function serverWithAuthApi() {
  const api = new Hono().route("/", createAuthApi({ settings }));
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-auth-web-"));
  return { app: createServerApp(api, { webRoot, settings }), origin };
}

async function seedUser(username: string, password: string): Promise<string> {
  createUser({ username, displayName: username, isAdmin: false, passwordHash: await hashPassword(password) }, getDb());
  return username;
}
```

Each test uses its own `X-Forwarded-For` range so the per-IP limiter from other tests does not interfere.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --import tsx --test src/auth/auth-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auth-api.ts`**

```ts
// apps/api/src/auth/auth-api.ts
import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AuthSessionResponse, UserSessionSummary } from "@csb/shared";
import type { ServerSettings } from "../deployment-settings.js";
import { SESSION_COOKIE } from "../server-security.js";
import { acceptInvite, changePassword, login, logout } from "./auth-service.js";
import { listUserGrants } from "./grant-store.js";
import { peekInvite } from "./invite-store.js";
import { csrfTokenOf, principalOf } from "./principal.js";
import { getSessionById, listUserSessions, revokeSession, revokeUserSessions } from "./session-store.js";
import { getUser, updateUser } from "./user-store.js";

const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 7 * 24 * 3600 } as const;

function clientIp(c: Context): string | null {
  return c.req.header("X-Forwarded-For")?.split(",")[0]?.trim().slice(0, 64) || null;
}

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const text = (value: unknown, max = 256): string => (typeof value === "string" ? value.slice(0, max) : "");

export function createAuthApi(deps: { settings: ServerSettings }): Hono {
  const api = new Hono();
  const server = deps.settings.mode === "server";

  api.post("/auth/login", async (c) => {
    const input = await body(c);
    const result = await login({ username: text(input.username, 64), password: text(input.password), ip: clientIp(c), userAgent: c.req.header("User-Agent") ?? null });
    if (result.ok) {
      setCookie(c, SESSION_COOKIE, result.token, COOKIE_OPTIONS);
      return c.json({ ok: true });
    }
    if (result.error === "account_locked") return c.json({ error: result.error, retryAfterSeconds: result.retryAfterSeconds }, 423);
    if (result.error === "rate_limited") {
      c.header("Retry-After", String(result.retryAfterSeconds));
      return c.json({ error: result.error, retryAfterSeconds: result.retryAfterSeconds }, 429);
    }
    return c.json({ error: "invalid_credentials" }, 401);
  });

  api.post("/auth/logout", (c) => {
    const principal = principalOf(c);
    if (principal.sessionId) logout(principal.sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.body(null, 204);
  });

  api.get("/auth/session", (c) => {
    const principal = principalOf(c);
    const response: AuthSessionResponse = {
      user: { id: principal.userId ?? "local", username: principal.username, displayName: principal.displayName, isAdmin: principal.isAdmin },
      grants: principal.userId ? listUserGrants(principal.userId) : [],
      csrfToken: csrfTokenOf(c),
      runtimeMode: deps.settings.mode,
      repositoryRoots: deps.settings.repositoryRoots,
    };
    return c.json(response);
  });

  api.get("/auth/invites/:token", (c) => {
    const invite = peekInvite(c.req.param("token"));
    const user = invite ? getUser(invite.userId) : null;
    if (!invite || !user) return c.json({ error: "invite_invalid" }, 404);
    const invitedBy = invite.createdBy ? getUser(invite.createdBy)?.displayName ?? null : null;
    return c.json({ username: user.username, displayName: user.displayName, purpose: invite.purpose, invitedBy, expiresAt: invite.expiresAt });
  });

  api.post("/auth/invites/:token", async (c) => {
    const input = await body(c);
    const result = await acceptInvite({ token: c.req.param("token"), password: text(input.password), ip: clientIp(c), userAgent: c.req.header("User-Agent") ?? null });
    if (!result.ok) return c.json({ error: result.error }, result.error === "invite_invalid" ? 404 : 400);
    setCookie(c, SESSION_COOKIE, result.token, COOKIE_OPTIONS);
    return c.json({ ok: true });
  });

  api.patch("/account/profile", async (c) => {
    const principal = principalOf(c);
    if (!server || !principal.userId) return c.json({ error: "not_found" }, 404);
    const displayName = text((await body(c)).displayName, 120).trim();
    if (!displayName) return c.json({ error: "display_name_invalid" }, 400);
    const user = updateUser(principal.userId, { displayName });
    return c.json({ id: user.id, username: user.username, displayName: user.displayName, isAdmin: user.isAdmin });
  });

  api.post("/account/password", async (c) => {
    const principal = principalOf(c);
    if (!server || !principal.userId || !principal.sessionId) return c.json({ error: "not_found" }, 404);
    const input = await body(c);
    const result = await changePassword({ userId: principal.userId, sessionId: principal.sessionId, currentPassword: text(input.currentPassword), newPassword: text(input.newPassword) });
    return result.ok ? c.body(null, 204) : c.json({ error: result.error }, 400);
  });

  api.get("/account/sessions", (c) => {
    const principal = principalOf(c);
    if (!server || !principal.userId) return c.json({ error: "not_found" }, 404);
    const sessions: UserSessionSummary[] = listUserSessions(principal.userId).map((s) => ({
      id: s.id, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, userAgent: s.userAgent, current: s.id === principal.sessionId,
    }));
    return c.json({ sessions });
  });

  api.delete("/account/sessions/others", (c) => {
    const principal = principalOf(c);
    if (!server || !principal.userId) return c.json({ error: "not_found" }, 404);
    revokeUserSessions(principal.userId, principal.sessionId);
    return c.body(null, 204);
  });

  api.delete("/account/sessions/:id", (c) => {
    const principal = principalOf(c);
    const session = getSessionById(c.req.param("id"));
    if (!server || !principal.userId || !session || session.userId !== principal.userId) return c.json({ error: "not_found" }, 404);
    revokeSession(session.id);
    return c.body(null, 204);
  });

  return api;
}
```

- [ ] **Step 4: Mount in `app.ts`**: `app.route("/", createAuthApi({ settings: loadServerSettings() }));` Because importing `app.ts` in tests runs in local mode, `loadServerSettings()` returns local settings.

- [ ] **Step 5: Run tests**

Run: `cd apps/api && node --import tsx --test src/auth/auth-api.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/auth-api.ts apps/api/src/auth/auth-api.test.ts apps/api/src/app.ts
git commit -m "feat(auth): login, logout, session, invite and account routes"
```

---

### Task 10: Users and repository access admin API

**Files:**
- Create: `apps/api/src/auth/users-api.ts`
- Modify: `apps/api/src/app.ts` (mount `createUsersApi({ publicOrigin })`)
- Test: `apps/api/src/auth/users-api.test.ts`

**Interfaces:**
- Consumes: Tasks 3–7.
- Produces routes (all admin-only through Task 11's policy; the handlers also assert `principalOf(c).isAdmin` as defense in depth):

| Method & path | Body | Response |
|---|---|---|
| `GET /users` | — | `{ users: UserSummary[] }` |
| `POST /users` | `{ username, displayName, email?, isAdmin, grants: RepositoryGrant[] }` | `201 { user: UserSummary, invite: InviteLinkResponse }`; `400 username_invalid`, `409 username_taken`, `400 repository_unknown`/`role_invalid` |
| `PATCH /users/:id` | `{ displayName?, email?, isAdmin?, status? }` | `200 UserSummary`; `409 last_admin` |
| `POST /users/:id/reset` | — | `200 InviteLinkResponse`; revokes sessions |
| `DELETE /users/:id/sessions` | — | `204` |
| `GET /users/:id/sessions` | — | `{ sessions: UserSessionSummary[] }` (`current` always false) |
| `GET /users/:id/grants` | — | `{ grants: RepositoryGrant[] }` |
| `PUT /users/:id/grants` | `{ grants: RepositoryGrant[] }` | `200 { grants }` |
| `GET /repository-access` | — | `{ repositories: RepositoryAccessEntry[] }` |
| `PUT /repository-access/:repositoryKey/users/:userId` | `{ role: RepositoryRole \| null }` | `204` |

`inviteUrl` = `${publicOrigin}/invite/${token}` in server mode, `/invite/${token}` in local mode. User creation and the initial grants run in one transaction. `PATCH` rules: disabling revokes all sessions; `isAdmin: false` or `status: "disabled"` on the last active admin → `409 { error: "last_admin" }` (this includes the caller demoting themself).

- [ ] **Step 1: Write the failing tests** — cover: create returns an invite link and the grants; duplicate username (`" Ana "` vs `"ana"`) → 409; last-admin demote and disable → 409 while a second admin exists → 200; disable revokes the user's sessions (`resolveSession` returns null); `PUT /users/:id/grants` with an unknown repository → 400 and no partial write; `GET /repository-access` lists grants per repository. Use `new Hono()` + `app.route("/", createUsersApi(...))` and call routes directly (local mode ⇒ `LOCAL_PRINCIPAL`, an admin), seeding `guardrail_repositories` rows through `getDb()`.

```ts
test("refuses to demote or disable the last active administrator", async () => {
  const api = new Hono().route("/", createUsersApi({ publicOrigin: null }));
  const only = createUser({ username: `root${Date.now()}`, displayName: "Root", isAdmin: true }, getDb());
  for (const user of listUsers(getDb())) if (user.id !== only.id && user.isAdmin) updateUser(user.id, { isAdmin: false }, getDb());
  const demote = await api.request(`/users/${only.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isAdmin: false }) });
  assert.equal(demote.status, 409);
  assert.deepEqual(await demote.json(), { error: "last_admin" });
  const disable = await api.request(`/users/${only.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "disabled" }) });
  assert.equal(disable.status, 409);
  const second = createUser({ username: `root2${Date.now()}`, displayName: "Root 2", isAdmin: true }, getDb());
  assert.equal((await api.request(`/users/${only.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isAdmin: false }) })).status, 200);
  assert.ok(second);
});
```

```ts
const JSON_HEADERS = { "Content-Type": "application/json" };

function seedRepository(key: string): void {
  getDb().prepare(`INSERT OR IGNORE INTO guardrail_repositories
    (repository_key, repository_path, source, display_name, default_branch, default_executor, enabled, policy_path, created_at, updated_at)
    VALUES (?, ?, 'local', ?, 'main', 'sentinel-managed', 1, '.csb/guardrails.json', 'now', 'now')`).run(key, `/repos/${key}`, key);
}

test("creates a user with grants and a single invite link, refusing duplicates", async () => {
  const api = new Hono().route("/", createUsersApi({ publicOrigin: "https://sentinel.example" }));
  const key = `local/users${Date.now()}`;
  seedRepository(key);
  const name = `bruno${Date.now()}`;
  const created = await api.request("/users", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({
    username: ` ${name.toUpperCase()} `, displayName: "Bruno", isAdmin: false, grants: [{ repositoryKey: key, role: "viewer" }],
  }) });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.user.username, name);
  assert.equal(body.user.pendingInvite, true);
  assert.equal(body.user.repositoryCount, 1);
  assert.match(body.invite.inviteUrl, /^https:\/\/sentinel\.example\/invite\/[A-Za-z0-9_-]{43}$/);
  const duplicate = await api.request("/users", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ username: name, displayName: "Other", isAdmin: false, grants: [] }) });
  assert.equal(duplicate.status, 409);
});

test("replacing grants with an unknown repository writes nothing", async () => {
  const api = new Hono().route("/", createUsersApi({ publicOrigin: null }));
  const key = `local/grants${Date.now()}`;
  seedRepository(key);
  const user = createUser({ username: `carla${Date.now()}`, displayName: "Carla", isAdmin: false }, getDb());
  await api.request(`/users/${user.id}/grants`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ grants: [{ repositoryKey: key, role: "operator" }] }) });
  const bad = await api.request(`/users/${user.id}/grants`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ grants: [{ repositoryKey: key, role: "viewer" }, { repositoryKey: "local/missing", role: "viewer" }] }) });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "repository_unknown" });
  const grants = await (await api.request(`/users/${user.id}/grants`)).json();
  assert.deepEqual(grants.grants, [{ repositoryKey: key, role: "operator" }]);
  const access = await (await api.request("/repository-access")).json();
  const entry = access.repositories.find((r: { repositoryKey: string }) => r.repositoryKey === key);
  assert.deepEqual(entry.grants.map((g: { userId: string; role: string }) => [g.userId, g.role]), [[user.id, "operator"]]);
});

test("disabling a user revokes their sessions", async () => {
  const api = new Hono().route("/", createUsersApi({ publicOrigin: null }));
  const admin2 = createUser({ username: `keep${Date.now()}`, displayName: "Keep", isAdmin: true }, getDb());
  const user = createUser({ username: `dora${Date.now()}`, displayName: "Dora", isAdmin: false }, getDb());
  const { token } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  const response = await api.request(`/users/${user.id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ status: "disabled" }) });
  assert.equal(response.status, 200);
  assert.equal(resolveSession(token, undefined, getDb()), null);
  assert.ok(admin2);
});
```

Imports for this file: `Hono`, `getDb`, `createUsersApi`, `createUser`, `listUsers`, `updateUser`, `createSession`, `resolveSession`. If the `guardrail_repositories` CHECK constraint needs more columns, extend `seedRepository` accordingly.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --import tsx --test src/auth/users-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `users-api.ts`**

```ts
// apps/api/src/auth/users-api.ts
import { Hono, type Context } from "hono";
import type { InviteLinkResponse, RepositoryGrant, RepositoryRole, UserSummary } from "@csb/shared";
import { getDb } from "../db.js";
import { countUserGrants, listRepositoryAccess, listUserGrants, replaceUserGrants, setRepositoryGrant } from "./grant-store.js";
import { createInvite, hasOpenInvite } from "./invite-store.js";
import { principalOf, ROLE_RANK } from "./principal.js";
import { listUserSessions, revokeUserSessions } from "./session-store.js";
import { countActiveAdmins, createUser, getUser, listUsers, updateUser, type UserRecord } from "./user-store.js";

function summary(user: UserRecord): UserSummary {
  return {
    id: user.id, username: user.username, displayName: user.displayName, email: user.email,
    isAdmin: user.isAdmin, status: user.status, hasPassword: user.passwordHash !== null,
    pendingInvite: hasOpenInvite(user.id), repositoryCount: countUserGrants(user.id),
    lastLoginAt: user.lastLoginAt, createdAt: user.createdAt,
  };
}

function grantsFrom(value: unknown): RepositoryGrant[] | null {
  if (!Array.isArray(value)) return null;
  const grants: RepositoryGrant[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { repositoryKey, role } = entry as Record<string, unknown>;
    if (typeof repositoryKey !== "string" || typeof role !== "string" || !(role in ROLE_RANK)) return null;
    grants.push({ repositoryKey, role: role as RepositoryRole });
  }
  return grants;
}

async function json(c: Context): Promise<Record<string, unknown>> {
  try { const value = await c.req.json(); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}

export function createUsersApi(deps: { publicOrigin: string | null }): Hono {
  const api = new Hono();
  const inviteLink = (token: string, expiresAt: string): InviteLinkResponse => ({
    inviteUrl: `${deps.publicOrigin ?? ""}/invite/${token}`, expiresAt,
  });
  api.use("/users/*", async (c, next) => (principalOf(c).isAdmin ? next() : c.json({ error: "forbidden" }, 403)));
  api.use("/users", async (c, next) => (principalOf(c).isAdmin ? next() : c.json({ error: "forbidden" }, 403)));
  api.use("/repository-access/*", async (c, next) => (principalOf(c).isAdmin ? next() : c.json({ error: "forbidden" }, 403)));
  api.use("/repository-access", async (c, next) => (principalOf(c).isAdmin ? next() : c.json({ error: "forbidden" }, 403)));

  api.get("/users", (c) => c.json({ users: listUsers().map(summary) }));

  api.post("/users", async (c) => {
    const input = await json(c);
    const grants = grantsFrom(input.grants ?? []);
    if (grants === null) return c.json({ error: "role_invalid" }, 400);
    const actor = principalOf(c).userId;
    try {
      const { user, token, expiresAt } = getDb().transaction(() => {
        const created = createUser({
          username: String(input.username ?? ""), displayName: String(input.displayName ?? ""),
          email: typeof input.email === "string" ? input.email : null, isAdmin: input.isAdmin === true,
        });
        replaceUserGrants(created.id, grants, actor);
        const link = createInvite({ userId: created.id, purpose: "invite", createdBy: actor });
        return { user: created, token: link.token, expiresAt: link.invite.expiresAt };
      })();
      return c.json({ user: summary(user), invite: inviteLink(token, expiresAt) }, 201);
    } catch (error) {
      const code = error instanceof Error ? error.message : "user_create_failed";
      return c.json({ error: code }, code === "username_taken" ? 409 : 400);
    }
  });

  api.patch("/users/:id", async (c) => {
    const user = getUser(c.req.param("id"));
    if (!user) return c.json({ error: "not_found" }, 404);
    const input = await json(c);
    const demotes = (input.isAdmin === false && user.isAdmin) || (input.status === "disabled" && user.isAdmin && user.status === "active");
    if (demotes && countActiveAdmins() <= 1) return c.json({ error: "last_admin" }, 409);
    const patch: Parameters<typeof updateUser>[1] = {};
    if (typeof input.displayName === "string" && input.displayName.trim()) patch.displayName = input.displayName.trim().slice(0, 120);
    if (typeof input.email === "string" || input.email === null) patch.email = (input.email as string | null)?.trim() || null;
    if (typeof input.isAdmin === "boolean") patch.isAdmin = input.isAdmin;
    if (input.status === "active" || input.status === "disabled") patch.status = input.status;
    const updated = updateUser(user.id, patch);
    if (patch.status === "disabled") revokeUserSessions(user.id);
    return c.json(summary(updated));
  });

  api.post("/users/:id/reset", (c) => {
    const user = getUser(c.req.param("id"));
    if (!user) return c.json({ error: "not_found" }, 404);
    const link = createInvite({ userId: user.id, purpose: "reset", createdBy: principalOf(c).userId });
    revokeUserSessions(user.id);
    return c.json(inviteLink(link.token, link.invite.expiresAt));
  });

  api.delete("/users/:id/sessions", (c) => {
    if (!getUser(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    revokeUserSessions(c.req.param("id"));
    return c.body(null, 204);
  });

  api.get("/users/:id/sessions", (c) => c.json({
    sessions: listUserSessions(c.req.param("id")).map((s) => ({
      id: s.id, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, userAgent: s.userAgent, current: false,
    })),
  }));

  api.get("/users/:id/grants", (c) => c.json({ grants: listUserGrants(c.req.param("id")) }));

  api.put("/users/:id/grants", async (c) => {
    if (!getUser(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    const grants = grantsFrom((await json(c)).grants);
    if (grants === null) return c.json({ error: "role_invalid" }, 400);
    try {
      replaceUserGrants(c.req.param("id"), grants, principalOf(c).userId);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "grant_failed" }, 400);
    }
    return c.json({ grants: listUserGrants(c.req.param("id")) });
  });

  api.get("/repository-access", (c) => c.json({ repositories: listRepositoryAccess() }));

  api.put("/repository-access/:repositoryKey/users/:userId", async (c) => {
    if (!getUser(c.req.param("userId"))) return c.json({ error: "not_found" }, 404);
    const role = (await json(c)).role;
    if (role !== null && (typeof role !== "string" || !(role in ROLE_RANK))) return c.json({ error: "role_invalid" }, 400);
    try {
      setRepositoryGrant(c.req.param("userId"), decodeURIComponent(c.req.param("repositoryKey")), role as RepositoryRole | null, principalOf(c).userId);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "grant_failed" }, 400);
    }
    return c.body(null, 204);
  });

  return api;
}
```

- [ ] **Step 4: Mount** in `app.ts`: `app.route("/", createUsersApi({ publicOrigin: loadServerSettings().origin }));`

- [ ] **Step 5: Run tests**

Run: `cd apps/api && node --import tsx --test src/auth/users-api.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/users-api.ts apps/api/src/auth/users-api.test.ts apps/api/src/app.ts
git commit -m "feat(auth): user administration and repository access API"
```

---

### Task 11: Route policy registry and authorization middleware

**Files:**
- Create: `apps/api/src/auth/route-policy.ts`
- Modify: `apps/api/src/app.ts` (register `app.use("*", authorize())` immediately after the `cors` middleware at ~line 152, before any route)
- Test: `apps/api/src/auth/route-policy.test.ts`

**Interfaces:**
- Consumes: `principalOf`, `hasRepositoryRole`, `canSeeRepository` (Task 5); `getRunRepositoryKey` (Task 6); `getGateRun` from `gate-store.ts`.
- Produces:

```ts
export type Requirement =
  | { kind: "public" }
  | { kind: "authenticated" }
  | { kind: "admin" }
  | { kind: "scoped" }
  | { kind: "repository"; role: RepositoryRole; from: "param" | "scan" | "gate" };
export const ROUTE_POLICY: ReadonlyArray<readonly [method: string, pattern: string, requirement: Requirement]>;
export function matchPolicy(method: string, path: string): { requirement: Requirement; params: Record<string, string> } | null;
export function authorize(): MiddlewareHandler;
```

The full table (patterns are exactly as registered in Hono, without the `/api` prefix). `R(role, from)` means `{ kind: "repository", role, from }`:

```ts
const viewerScan = R("viewer", "scan");
export const ROUTE_POLICY = [
  ["GET", "/healthz", PUBLIC], ["GET", "/readyz", PUBLIC],
  ["POST", "/auth/login", PUBLIC], ["GET", "/auth/invites/:token", PUBLIC], ["POST", "/auth/invites/:token", PUBLIC],
  ["POST", "/auth/logout", AUTH], ["GET", "/auth/session", AUTH],
  ["PATCH", "/account/profile", AUTH], ["POST", "/account/password", AUTH], ["GET", "/account/sessions", AUTH],
  ["DELETE", "/account/sessions/others", AUTH], ["DELETE", "/account/sessions/:id", AUTH],
  ["GET", "/security-session", AUTH], ["GET", "/scanners", AUTH], ["GET", "/health", SCOPED],
  ["GET", "/users", ADMIN], ["POST", "/users", ADMIN], ["PATCH", "/users/:id", ADMIN], ["POST", "/users/:id/reset", ADMIN],
  ["DELETE", "/users/:id/sessions", ADMIN], ["GET", "/users/:id/sessions", ADMIN], ["GET", "/users/:id/grants", ADMIN],
  ["PUT", "/users/:id/grants", ADMIN], ["GET", "/repository-access", ADMIN], ["PUT", "/repository-access/:repositoryKey/users/:userId", ADMIN],
  ["POST", "/ingest", ADMIN], ["GET", "/fs/list", ADMIN], ["GET", "/metrics/summary", SCOPED], ["POST", "/compare", SCOPED],
  ["GET", "/scans", SCOPED], ["POST", "/scans", ADMIN], ["GET", "/scans/active", SCOPED], ["GET", "/scans/catalog", SCOPED],
  ["GET", "/scans/:id", viewerScan], ["DELETE", "/scans/:id", R("maintainer", "scan")],
  ["GET", "/scans/:id/analysis-metrics", viewerScan], ["GET", "/scans/:id/files-graph", viewerScan],
  ["GET", "/scans/:id/candidate-preview", viewerScan], ["GET", "/scans/:id/telemetry", viewerScan],
  ["GET", "/scans/:id/report", viewerScan], ["GET", "/scans/:id/regression", viewerScan],
  ["POST", "/scans/:id/baseline", R("operator", "scan")], ["GET", "/scans/:id/findings", viewerScan],
  ["GET", "/scans/:id/findings/:findingId", viewerScan], ["POST", "/scans/:id/findings/:findingId/triage", R("analyst", "scan")],
  ["POST", "/scans/:id/cancel", R("operator", "scan")], ["GET", "/scans/:id/events", viewerScan],
  ["GET", "/guardrails/repositories", SCOPED], ["POST", "/guardrails/repositories", ADMIN],
  ["POST", "/guardrails/repositories/:repositoryKey/actions-dispatch", R("operator", "param")],
  ["GET", "/guardrails/repositories/:repositoryKey/actions-status", R("viewer", "param")],
  ["POST", "/guardrails/repositories/:repositoryKey/baseline/sync", R("operator", "param")],
  ["GET", "/guardrails/repositories/:repositoryKey/caller-workflow", R("viewer", "param")],
  ["PUT", "/guardrails/repositories/:repositoryKey/caller-workflow", R("maintainer", "param")],
  ["GET", "/guardrails/repositories/:repositoryKey/github-status", R("viewer", "param")],
  ["GET", "/guardrails/repositories/:repositoryKey/policy", R("viewer", "param")],
  ["PUT", "/guardrails/repositories/:repositoryKey/policy", R("maintainer", "param")],
  ["POST", "/guardrails/repositories/:repositoryKey/policy/simulate", R("analyst", "param")],
  ["GET", "/guardrails/repositories/:repositoryKey/pull-requests", R("viewer", "param")],
  ["POST", "/guardrails/repositories/:repositoryKey/target-preview", R("operator", "param")],
  ["GET", "/guardrails/gates", SCOPED], ["POST", "/guardrails/gates", ADMIN],
  ["GET", "/guardrails/gates/:gateId", R("viewer", "gate")], ["DELETE", "/guardrails/gates/:gateId", R("maintainer", "gate")],
  ["POST", "/guardrails/gates/:gateId/cancel", R("operator", "gate")], ["GET", "/guardrails/gates/:gateId/events", R("viewer", "gate")],
  ["POST", "/guardrails/gates/:gateId/publish", R("operator", "gate")],
  ["GET", "/guardrails/github-app/connections", ADMIN], ["DELETE", "/guardrails/github-app/connections/:connectionId", ADMIN],
  ["GET", "/guardrails/github-app/connections/:connectionId/installations", ADMIN],
  ["GET", "/guardrails/github-app/installations/:installationId/repositories", ADMIN],
  ["GET", "/guardrails/github-app/manifest/authorize/:flowId", ADMIN], ["GET", "/guardrails/github-app/manifest/callback", ADMIN],
  ["GET", "/guardrails/github-app/manifest/flows/:flowId", ADMIN], ["POST", "/guardrails/github-app/manifest/start", ADMIN],
  ["GET", "/github-monitor/overview", SCOPED], ["GET", "/github-monitor/rules", SCOPED], ["GET", "/github-monitor/events", SCOPED],
  ["GET", "/github-monitor/actions-runs", SCOPED], ["GET", "/github-monitor/branches", SCOPED],
  ["POST", "/github-monitor/rules", ADMIN], ["PATCH", "/github-monitor/rules/:id", ADMIN], ["POST", "/github-monitor/poll", SCOPED],
  ["GET", "/github-checkouts", SCOPED], ["GET", "/github-checkouts/:repositoryKey", R("viewer", "param")],
  ["POST", "/github-checkouts/:repositoryKey/fetch", R("operator", "param")], ["POST", "/github-checkouts/:repositoryKey/pull", R("operator", "param")],
  ["GET", "/connections", ADMIN], ["POST", "/connections", ADMIN], ["POST", "/connections/compatibility", ADMIN],
  ["GET", "/connections/security-session", AUTH], ["GET", "/connections/:id", ADMIN], ["PATCH", "/connections/:id", ADMIN],
  ["DELETE", "/connections/:id", ADMIN], ["GET", "/connections/:id/auth/:flowId", ADMIN],
  ["POST", "/connections/:id/auth/:flowId/cancel", ADMIN], ["POST", "/connections/:id/auth/disconnect", ADMIN],
  ["POST", "/connections/:id/auth/start", ADMIN], ["POST", "/connections/:id/inspect", ADMIN],
  ["GET", "/connections/:id/models", ADMIN], ["POST", "/connections/:id/models/refresh", ADMIN], ["POST", "/connections/:id/probe", ADMIN],
  ["GET", "/engine-updates", ADMIN], ["POST", "/engine-updates/check", ADMIN], ["GET", "/engine-updates/security-session", AUTH],
  ["POST", "/engine-updates/:id/update", ADMIN], ["POST", "/engine-updates/:id/rollback", ADMIN],
] as const;
```

Notes the implementer must keep: GitHub monitor rule writes are `ADMIN` in Phase 1 (rules are looked up by id without a repository resolver); `POST /github-monitor/poll` is `SCOPED` because its body carries `repositoryKey` — the handler checks `hasRepositoryRole(principal, body.repositoryKey, "operator")` (Task 12). `github-checkouts/:repositoryKey/${action}` registers two concrete paths; confirm the literal registered patterns with the coverage test and adjust the table to match exactly.

Matching: split pattern and path on `/`; same segment count; `:name` matches any non-empty segment and captures it (decoded with `decodeURIComponent`); a candidate with more literal segments wins (`/scans/active` beats `/scans/:id`). The path is `c.req.path` with a leading `/api` removed (`path.replace(/^\/api(?=\/)/, "")`).

`authorize()` decision:

```ts
export function authorize(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const path = c.req.path.replace(/^\/api(?=\/)/, "");
    const matched = matchPolicy(c.req.method === "HEAD" ? "GET" : c.req.method, path);
    if (!matched) return c.json({ error: "not_found" }, 404);
    const { requirement, params } = matched;
    if (requirement.kind === "public") return next();
    let principal: Principal;
    try { principal = principalOf(c); } catch { return c.json({ error: "authentication_required" }, 401); }
    if (requirement.kind === "authenticated" || requirement.kind === "scoped") return next();
    if (requirement.kind === "admin") return principal.isAdmin ? next() : c.json({ error: "forbidden" }, 403);
    if (principal.isAdmin) return next();
    const key = requirement.from === "param" ? params.repositoryKey
      : requirement.from === "scan" ? getRunRepositoryKey(params.id!)
      : getGateRun(params.gateId!)?.repositoryKey;
    if (!canSeeRepository(principal, key)) return c.json({ error: "not_found" }, 404);
    if (!hasRepositoryRole(principal, key, requirement.role)) return c.json({ error: "forbidden" }, 403);
    return next();
  };
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/auth/route-policy.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { app } from "../app.js";
import { matchPolicy } from "./route-policy.js";

test("every registered API route declares a requirement", () => {
  const missing = app.routes
    .filter((route) => route.method !== "ALL" && !route.path.endsWith("*"))
    .map((route) => `${route.method} ${route.path}`)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .filter((entry) => {
      const [method, path] = entry.split(" ") as [string, string];
      return matchPolicy(method, path.replaceAll(/:([A-Za-z]+)/g, "x"))?.requirement === undefined;
    });
  assert.deepEqual(missing, []);
});

test("literal segments win over parameters", () => {
  assert.equal(matchPolicy("GET", "/scans/active")?.requirement.kind, "scoped");
  assert.deepEqual(matchPolicy("GET", "/scans/abc")?.params, { id: "abc" });
  assert.equal(matchPolicy("GET", "/nope"), null);
});
```

Add an HTTP matrix test that builds `createServerApp(app, { settings: serverSettings, webRoot })`, seeds a repository `github:1`, a run `r1` with `repository_key = 'github:1'`, a run `r2` with `repository_key = 'github:2'`, and three members (viewer, analyst, maintainer on `github:1`). Assert:
- viewer `GET /api/scans/r1` → 200; `GET /api/scans/r2` → 404; `POST /api/scans/r1/findings/f/triage` → 403; `DELETE /api/scans/r1` → 403; `GET /api/users` → 403; `GET /api/connections` → 403; `POST /api/scans` → 403.
- analyst triage on `r1` passes authorization (status is not 401/403/404-with-`not_found` from the middleware; the handler may return its own 404 for the unknown finding — assert the error body is not `{"error":"forbidden"}`).
- maintainer `DELETE /api/scans/r2` → 404.
- A route missing from `ROUTE_POLICY` is denied: register `app.get("/__policy_probe", …)` on a fresh Hono with `authorize()` and assert 404.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --import tsx --test src/auth/route-policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `route-policy.ts`** with the table, `matchPolicy` and `authorize` above. Constants: `const PUBLIC = { kind: "public" } as const; const AUTH = { kind: "authenticated" } as const; const ADMIN = { kind: "admin" } as const; const SCOPED = { kind: "scoped" } as const; const R = (role: RepositoryRole, from: "param" | "scan" | "gate") => ({ kind: "repository", role, from }) as const;`

- [ ] **Step 4: Register the middleware** in `app.ts` right after the `cors` block: `app.use("*", authorize());`

- [ ] **Step 5: Run the coverage test and fix the table** until `missing` is empty; then run the full suite.

Run: `cd apps/api && node --import tsx --test src/auth/route-policy.test.ts && npm test`
Expected: PASS. Existing tests run in local mode with the implicit admin, so they are unaffected.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/route-policy.ts apps/api/src/auth/route-policy.test.ts apps/api/src/app.ts
git commit -m "feat(auth): deny-by-default route policy with repository roles"
```

---

### Task 12: Scoped lists and stream re-authorization

**Files:**
- Create: `apps/api/src/auth/stream-guard.ts`
- Modify: `apps/api/src/scan-list.ts` (`listActiveRuns`, `scanCatalog`, `listRunPage`), `apps/api/src/metrics.ts` (`MetricsFilters`, `metricSelection`), `apps/api/src/app.ts` (handlers for `/health`, `/scans`, `/scans/active`, `/scans/catalog`, `/metrics/summary`, `/compare`, `/guardrails/repositories`, `/guardrails/gates`, SSE at ~617 and ~1011), `apps/api/src/github-monitor/api.ts` (overview, rules, events, actions-runs, branches, poll), `apps/api/src/github-checkouts.ts` (`GET /github-checkouts`)
- Test: `apps/api/src/auth/scoped-data.test.ts`, `apps/api/src/auth/stream-guard.test.ts`

**Interfaces:**
- Consumes: `AccessScope`, `scopeOf`, `inScope`, `principalOf`, `hasRepositoryRole` (Task 5); `scopeSql` (Task 5); `getSessionById` (Task 4); `principalForSession` (Task 7).
- Produces:
  - `listActiveRuns(scope: AccessScope = { kind: "all" })`, `scanCatalog(scope = all)`, `listRunPage(options, summarize = true, scope = all)` — the scope clause is appended to every `WHERE` in these functions, including `archivedCount`.
  - `MetricsFilters.scope?: AccessScope` — `metricSelection` appends `scopeSql(filters.scope ?? all, "runs.repository_key")`.
  - `createStreamGuard(c: Context, repositoryKey: () => string | null | undefined, intervalMs = 60_000, now = Date.now): () => boolean` — returns `true` while the principal is local/admin-unchanged or the session is still valid, the user active and still able to see the repository; re-checks at most once per `intervalMs`.

Handler changes (each obtains `const scope = scopeOf(principalOf(c))`):
- `GET /health`: return only active scan ids whose run is in scope (`getRunRepositoryKey`).
- `GET /scans`: paged path passes `scope` to `listRunPage`; unpaged path filters `readRunsWithEngineRefresh()` results with `inScope(scope, run.repositoryKey)`; `listActiveRuns(scope)`.
- `GET /scans/active` → `listActiveRuns(scope)`; `GET /scans/catalog` → `scanCatalog(scope)`.
- `GET /metrics/summary` → pass `scope` in the filters.
- `POST /compare`: before comparing, every `scanIds[i]` must satisfy `inScope(scope, getRunRepositoryKey(id))`, else `404 {"error":"not_found"}`.
- `GET /guardrails/repositories` → filter by `inScope(scope, repository.repositoryKey)`.
- `GET /guardrails/gates` → filter `listGateRuns(...)` by `inScope(scope, gate.repositoryKey)`; if the `repositoryKey` query is given and not in scope → `{ gates: [] }`.
- GitHub monitor: `overview` → filter `rules`, `events`, `actionsRuns` by `inScope`, and recompute `summary.enabledRules`, `summary.queuedEvents`, `summary.dispatchingEvents` from the filtered lists; `rules`/`events`/`actions-runs` → filter; `branches` and `poll` → require `hasRepositoryRole(principal, repositoryKey, "viewer" | "operator")` else 404/403.
- `GET /github-checkouts` → filter by scope.
- SSE (`/scans/:id/events` loop and `/guardrails/gates/:gateId/events` loop): create `const allowed = createStreamGuard(c, () => getRunRepositoryKey(id))` (or the gate's repository key) and set `closed = true` when `!allowed()` inside the existing loop.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/auth/stream-guard.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { getDb } from "../db.js";
import { createStreamGuard } from "./stream-guard.js";
import { createUser, updateUser } from "./user-store.js";
import { createSession } from "./session-store.js";
import { principalForSession } from "./auth-service.js";

test("a stream closes within the interval after the user is disabled", async () => {
  getDb().prepare("INSERT OR IGNORE INTO guardrail_repositories (repository_key, repository_path, source, display_name, default_branch, default_executor, enabled, policy_path, created_at, updated_at) VALUES ('local/guard', '/repos/guard', 'local', 'guard', 'main', 'sentinel-managed', 1, '.csb/guardrails.json', 'now', 'now')").run();
  const user = createUser({ username: `g${Date.now()}`, displayName: "G", isAdmin: false }, getDb());
  getDb().prepare("INSERT INTO repository_grants VALUES (?, 'local/guard', 'viewer', NULL, 'now')").run(user.id);
  const { session } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  let clock = 0;
  let guard: (() => boolean) | null = null;
  const app = new Hono();
  app.get("/", (c) => {
    c.set("principal" as never, principalForSession(session)! as never);
    guard = createStreamGuard(c, () => "local/guard", 60_000, () => clock);
    return c.text("ok");
  });
  await app.request("/");
  assert.equal(guard!(), true);
  updateUser(user.id, { status: "disabled" }, getDb());
  clock = 30_000;
  assert.equal(guard!(), true);
  clock = 60_001;
  assert.equal(guard!(), false);
});
```

The guardrail row literal must match the columns of `guardrail_repositories` (see `createRepositoryTable` in `guardrails-migrations.ts`); adjust the column list if the CHECK constraint requires more fields.

```ts
// apps/api/src/auth/scoped-data.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "../db.js";
import { listActiveRuns, listRunPage, scanCatalog } from "../scan-list.js";
import { buildMetricsSummary } from "../metrics.js";
import type { AccessScope } from "./principal.js";

function insertRun(id: string, key: string | null, status: string, name: string): void {
  getDb().prepare(`
    INSERT INTO runs (id, display_name, repository_path, scan_dir, status, source, created_at, updated_at, started_at, repository_key)
    VALUES (?, ?, ?, ?, ?, 'benchmark', ?, ?, ?, ?)
  `).run(id, name, `/repos/${name}`, `/tmp/${id}`, status, "2026-09-29T00:00:00.000Z", "2026-09-29T00:00:00.000Z", "2026-09-29T00:00:00.000Z", key);
}

const tag = `scope${Date.now()}`;
insertRun(`${tag}-a1`, `${tag}:a`, "completed", `${tag}-alpha`);
insertRun(`${tag}-a2`, `${tag}:a`, "failed", `${tag}-alpha`);
insertRun(`${tag}-a3`, `${tag}:a`, "running", `${tag}-alpha`);
insertRun(`${tag}-b1`, `${tag}:b`, "completed", `${tag}-beta`);
insertRun(`${tag}-n1`, null, "running", `${tag}-orphan`);

const onlyA: AccessScope = { kind: "repositories", keys: new Set([`${tag}:a`]) };
const nothing: AccessScope = { kind: "repositories", keys: new Set() };

test("paged lists, totals and archived counts honor the scope", () => {
  const page = listRunPage({ limit: 100, offset: 0, status: "all", query: tag }, true, onlyA);
  assert.deepEqual(page.scans.map((s) => s.id).sort(), [`${tag}-a1`, `${tag}-a2`, `${tag}-a3`]);
  assert.equal(page.total, 3);
  assert.equal(page.summary.archivedCount, 1);
});

test("catalog and active runs honor the scope", () => {
  assert.deepEqual(scanCatalog(onlyA).repositories, [`${tag}-alpha`]);
  assert.deepEqual(listActiveRuns(onlyA).map((s) => s.id), [`${tag}-a3`]);
  assert.equal(listActiveRuns(nothing).length, 0);
});

test("metrics count only in-scope runs", () => {
  assert.equal(buildMetricsSummary({ scope: onlyA, query: tag }).recentTotal, 3);
  assert.equal(buildMetricsSummary({ scope: nothing }).recentTotal, 0);
});
```

If `runs` has other `NOT NULL` columns without defaults, add them to `insertRun` with neutral values (check `db.ts` `CREATE TABLE runs`). `archivedCount` is scoped but not filtered by the text query; the assertion expects exactly the one failed run in scope, so if other in-scope runs exist in the shared test database, keep the unique `tag` repository key as done here.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && node --import tsx --test src/auth/stream-guard.test.ts src/auth/scoped-data.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `stream-guard.ts`**

```ts
// apps/api/src/auth/stream-guard.ts
import type { Context } from "hono";
import { principalForSession } from "./auth-service.js";
import { canSeeRepository, principalOf } from "./principal.js";
import { getSessionById } from "./session-store.js";

export function createStreamGuard(
  c: Context,
  repositoryKey: () => string | null | undefined,
  intervalMs = 60_000,
  now: () => number = Date.now,
): () => boolean {
  const initial = principalOf(c);
  if (initial.kind === "local") return () => true;
  let checkedAt = now();
  let allowed = true;
  return () => {
    if (!allowed) return false;
    if (now() - checkedAt < intervalMs) return true;
    checkedAt = now();
    const session = initial.sessionId ? getSessionById(initial.sessionId) : null;
    const principal = session ? principalForSession(session) : null;
    allowed = principal !== null && canSeeRepository(principal, repositoryKey());
    return allowed;
  };
}
```

- [ ] **Step 4: Apply the scope to `scan-list.ts` and `metrics.ts`** — add the `scope` parameter as specified, build `const clause = scopeSql(scope, "runs.repository_key")`, append `clause.sql` to each `WHERE` and spread `clause.params` before the other parameters of that statement.

- [ ] **Step 5: Apply the handler changes** listed above.

- [ ] **Step 6: Run tests**

Run: `cd apps/api && node --import tsx --test src/auth/*.test.ts && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/stream-guard.ts apps/api/src/auth/stream-guard.test.ts apps/api/src/auth/scoped-data.test.ts apps/api/src/scan-list.ts apps/api/src/metrics.ts apps/api/src/app.ts apps/api/src/github-monitor/api.ts apps/api/src/github-checkouts.ts
git commit -m "feat(auth): scope lists and re-authorize long streams"
```

---

### Task 13: Admin bootstrap at startup, smoke scripts and deployment docs

**Files:**
- Modify: `apps/api/src/index.ts` (after `backfillRunRepositoryKeys()`), `scripts/docker/smoke.mjs`, `scripts/docker/workflow-smoke.mjs`, `docs/docker.md`, `docs/dokploy.md`

**Interfaces:**
- Consumes: `bootstrapAdmin` (Task 7), auth routes (Task 9).

- [ ] **Step 1: Bootstrap.** In `index.ts`, server mode only:

```ts
if (settings.mode === "server") {
  const outcome = await bootstrapAdmin({ username: settings.username, password: settings.password });
  if (outcome === "created") console.log(`[csb-api] Created administrator ${settings.username} from CSB_ADMIN_USER`);
  if (outcome === "recovered") console.warn(`[csb-api] No active administrator found; restored ${settings.username} from CSB_ADMIN_PASSWORD_FILE`);
}
```

If `index.ts` is not an ES module top-level-await context, wrap startup in the existing async entry function; do not start `serve(...)` before this resolves.

- [ ] **Step 2: Smoke scripts.** Replace Basic auth with a login helper in both scripts:

```js
async function signIn(baseUrl, origin, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  if (response.status !== 200) throw new Error(`login failed: ${response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  const session = await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: cookie, Origin: origin } })).json();
  return { cookie, csrfToken: session.csrfToken };
}
```

- `smoke.mjs`: the HTML request no longer needs credentials (expect `200` for `/` without auth); API checks send `Cookie`.
- `workflow-smoke.mjs`: the "expects 401 without auth" check targets `/api/scans`; replace `Authorization` with `Cookie` in the `api()` helper and use `session.csrfToken` for `X-CSRF-Token`; after the container restart (`:345`), sign in again (sessions persist in the volume, but re-reading the CSRF token is required).

The smoke server runs with `CSB_PUBLIC_ORIGIN` on `http://127.0.0.1:…`; `Secure` cookies are accepted by Node's `fetch` only when sent manually, which this helper does. Confirm by running the smoke locally.

- [ ] **Step 3: Docs.** In `docs/docker.md` and `docs/dokploy.md`, replace the "HTTP Basic" description with: first start creates the administrator from `CSB_ADMIN_USER` / `CSB_ADMIN_PASSWORD_FILE`; later starts use these only to restore an administrator when none is active; other people are invited from Configurações → Usuários.

- [ ] **Step 4: Run**

Run: `pnpm typecheck && (cd apps/api && npm test) && node scripts/docker/smoke.mjs`
Expected: PASS (the smoke needs Docker; if Docker is unavailable locally, rely on the CI job "Build Linux image and smoke server" and say so in the PR).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/index.ts scripts/docker/smoke.mjs scripts/docker/workflow-smoke.mjs docs/docker.md docs/dokploy.md
git commit -m "feat(auth): bootstrap administrator and session-based smoke checks"
```

---

### Task 14: Web auth client, session provider and 401 handling

**Files:**
- Create: `apps/web/src/lib/auth-api.ts`, `apps/web/src/lib/safe-next.ts`, `apps/web/src/lib/safe-next.test.ts`, `apps/web/src/auth/AuthProvider.tsx`
- Modify: `apps/web/src/lib/security-session.ts` (fetch the token from `/auth/session`; emit `sentinel:unauthorized` on 401), `apps/web/src/main.tsx` (wrap `<App/>` in `<AuthProvider>` inside `BrowserRouter`), the three `EventSource` call sites (`ScanDetailPage.tsx:76`, `GuardrailScanMonitor.tsx:66`, `GuardrailsPage.tsx:161`: in `onerror`, call `revalidateSession()`)

**Interfaces:**
- Produces:

```ts
// safe-next.ts
export function safeNext(value: string | null | undefined): string; // "/" unless value starts with a single "/" and not "//" or "/\"
// auth-api.ts
export const authApi: {
  session(): Promise<AuthSessionResponse>;            // throws ApiError(status 401) when signed out
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  invite(token: string): Promise<{ username: string; displayName: string; purpose: "invite" | "reset"; invitedBy: string | null; expiresAt: string }>;
  acceptInvite(token: string, password: string): Promise<void>;
  updateProfile(displayName: string): Promise<AuthSessionUser>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  sessions(): Promise<UserSessionSummary[]>;
  revokeSession(id: string): Promise<void>;
  revokeOtherSessions(): Promise<void>;
};
// AuthProvider.tsx
export function AuthProvider(props: { children: ReactNode }): JSX.Element;
export function useAuth(): {
  session: AuthSessionResponse | null; status: "loading" | "signed-in" | "signed-out";
  refresh(): Promise<void>; logout(): Promise<void>;
  isAdmin: boolean; roleFor(repositoryKey: string | null | undefined): RepositoryRole | null;
  can(role: RepositoryRole, repositoryKey: string | null | undefined): boolean; // admins always true; null key → admin only
  canAny(role: RepositoryRole): boolean;
};
export function revalidateSession(): void; // dispatches "sentinel:revalidate"
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/safe-next.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { safeNext } from "./safe-next.js";

test("keeps in-app paths and refuses off-site redirects", () => {
  assert.equal(safeNext("/scans/abc?tab=2#x"), "/scans/abc?tab=2#x");
  for (const value of [null, "", "scans", "//evil.example", "/\\evil.example", "https://evil.example", "/login", "javascript:alert(1)"]) {
    assert.equal(safeNext(value), "/", String(value));
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx tsx --test src/lib/safe-next.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `safe-next.ts`**

```ts
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/invite/")) return "/";
  return value;
}
```

- [ ] **Step 4: Implement `auth-api.ts`** using `apiFetch` and `parseApiResponse` from the existing libs (`POST`s get CSRF automatically for authenticated calls; login and invite accept are public and work without a token). `session()` calls `GET /api/auth/session`.

- [ ] **Step 5: Change `security-session.ts`:** the token source becomes `${API_BASE}/auth/session` (its response contains `csrfToken`, `runtimeMode`, `repositoryRoots` — the same fields consumers read today). In `request()`, when a response has status `401` and the URL is not under `/api/auth/`, call `window.dispatchEvent(new Event("sentinel:unauthorized"))` and reset the cached token promise. Keep the existing `csrf_invalid` retry. Update `security-session.test.ts` for the new endpoint and add a test that a 401 dispatches the event (use a stub `window` with `dispatchEvent` in the test).

- [ ] **Step 6: Implement `AuthProvider.tsx`**

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { AuthSessionResponse, RepositoryRole } from "@csb/shared";
import { authApi } from "../lib/auth-api";

const RANK: Record<RepositoryRole, number> = { viewer: 1, analyst: 2, operator: 3, maintainer: 4 };
const PUBLIC_PATHS = [/^\/login$/, /^\/invite\/[^/]+$/];
type Status = "loading" | "signed-in" | "signed-out";
type AuthValue = ReturnType<typeof buildValue>;
const AuthContext = createContext<AuthValue | null>(null);

function buildValue(session: AuthSessionResponse | null, status: Status, refresh: () => Promise<void>, logout: () => Promise<void>) {
  const isAdmin = session?.user.isAdmin ?? false;
  const grants = new Map((session?.grants ?? []).map((g) => [g.repositoryKey, g.role] as const));
  const roleFor = (key: string | null | undefined) => (key ? grants.get(key) ?? null : null);
  const can = (role: RepositoryRole, key: string | null | undefined) => {
    if (isAdmin) return true;
    const granted = roleFor(key);
    return granted !== null && RANK[granted] >= RANK[role];
  };
  const canAny = (role: RepositoryRole) => isAdmin || [...grants.values()].some((g) => RANK[g] >= RANK[role]);
  return { session, status, refresh, logout, isAdmin, roleFor, can, canAny };
}

export function revalidateSession(): void {
  window.dispatchEvent(new Event("sentinel:revalidate"));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const navigate = useNavigate();
  const location = useLocation();

  const refresh = useCallback(async () => {
    try {
      setSession(await authApi.session());
      setStatus("signed-in");
    } catch {
      setSession(null);
      setStatus("signed-out");
    }
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => undefined);
    setSession(null);
    setStatus("signed-out");
    navigate("/login", { replace: true });
  }, [navigate]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const signedOut = () => { setSession(null); setStatus("signed-out"); };
    const revalidate = () => { void refresh(); };
    window.addEventListener("sentinel:unauthorized", signedOut);
    window.addEventListener("sentinel:revalidate", revalidate);
    return () => {
      window.removeEventListener("sentinel:unauthorized", signedOut);
      window.removeEventListener("sentinel:revalidate", revalidate);
    };
  }, [refresh]);

  useEffect(() => {
    if (status !== "signed-out") return;
    if (PUBLIC_PATHS.some((pattern) => pattern.test(location.pathname))) return;
    const next = `${location.pathname}${location.search}${location.hash}`;
    navigate(`/login?next=${encodeURIComponent(next)}&expired=1`, { replace: true });
  }, [status, location.pathname, location.search, location.hash, navigate]);

  const value = useMemo(() => buildValue(session, status, refresh, logout), [session, status, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth outside AuthProvider");
  return value;
}
```

- [ ] **Step 7: EventSource error handling.** In each of the three call sites, add `revalidateSession()` to the existing `onerror` handler (create one if absent). A signed-out session then triggers the provider redirect.

- [ ] **Step 8: Run**

Run: `cd apps/web && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/auth-api.ts apps/web/src/lib/safe-next.ts apps/web/src/lib/safe-next.test.ts apps/web/src/auth/AuthProvider.tsx apps/web/src/lib/security-session.ts apps/web/src/lib/security-session.test.ts apps/web/src/main.tsx apps/web/src/pages/ScanDetailPage.tsx apps/web/src/components/guardrails/GuardrailScanMonitor.tsx apps/web/src/pages/GuardrailsPage.tsx
git commit -m "feat(web): session provider, safe redirects and 401 handling"
```

---

### Task 15: Login and invite pages

**Files:**
- Create: `apps/web/src/i18n/auth.ts`, `apps/web/src/components/auth/AuthFrame.tsx`, `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/pages/InvitePage.tsx`
- Modify: `apps/web/src/App.tsx` (render `/login` and `/invite/:token` outside the shell, the same early-return pattern as the report routes at ~line 100; while `useAuth().status === "loading"` render `<Loading />`; when `signed-out` on a shell route render nothing — the provider redirects)

**Interfaces:**
- Consumes: `authApi`, `useAuth`, `safeNext` (Task 14).
- Produces: `authMessages: ScopedMessages<AuthMessageKey>`; `AuthFrame({ children, footer? })`.

Design (dark Sentinel look, matches `styles.css` utilities):
- `AuthFrame`: full-height `grid lg:grid-cols-[1.1fr_1fr]`.
  - Left panel (`hidden lg:flex`): `bench-panel bench-corners scanline` with the `/brand/okami-sentinel-mark.png` mark at 56px, `OKAMI` wordmark, `bench-label` line `SENTINEL / EVIDENCE-DRIVEN SECURITY`, a 12×12 grid of 1px lines whose opacity pulses via a CSS keyframe (`@media (prefers-reduced-motion: reduce)` disables it), and a mono status line with `live-dot` + the engine status copy.
  - Right side: centered `max-w-sm` card with `bench-panel`, header code label (`00 / ACCESS`), title and description; footer row with `<LanguageSwitcher />` and `<ThemeSwitcher />`.
- `LoginPage`:
  - Fields: username (`autoComplete="username"`, autofocus), password (`autoComplete="current-password"`) with show/hide toggle button (`aria-pressed`) and Caps Lock warning (`onKeyUp` → `event.getModifierState("CapsLock")`).
  - Submit button full width, orange primary, shows a spinner and "Entrando…" while pending; the form is disabled while pending.
  - Errors in an `aria-live="polite"` region: `invalid_credentials` → generic copy; `account_locked` → countdown `mm:ss` from `retryAfterSeconds` updated every second, submit disabled until zero; `rate_limited` → same countdown copy; network → generic retry copy.
  - When `?expired=1`, show an info banner "Sua sessão expirou. Entre novamente."
  - On success: `await refresh()` then `navigate(safeNext(params.get("next")), { replace: true })`.
  - If already signed in on mount, redirect to `safeNext(next)`.
- `InvitePage`:
  - On mount `authApi.invite(token)`; invalid → panel with the "link inválido ou expirado" copy and a link to `/login`.
  - Valid → "{invitedBy} convidou você" (or "Redefina sua senha" for `purpose: "reset"`), read-only username, display name, new password + confirmation, strength meter (4 segments: `<12` weak, `12–15` fair, `16–23` good, `≥24` strong), client-side checks mirror the server policy (length, equals username, confirmation mismatch).
  - Submit → `acceptInvite` → `refresh()` → navigate `/`.

Message keys (all five locales required by the `ScopedMessages` type; pt-BR and en shown — write es, de and fr translations of the same keys):

```ts
const ptBR = {
  "frame.tagline": "Segurança guiada por evidências",
  "frame.engine": "Motor pronto",
  "login.code": "00 / ACESSO",
  "login.title": "Entrar no Sentinel",
  "login.description": "Use a conta criada pelo administrador.",
  "login.username": "Usuário",
  "login.password": "Senha",
  "login.show": "Mostrar senha",
  "login.hide": "Ocultar senha",
  "login.capsLock": "Caps Lock está ativado.",
  "login.submit": "Entrar",
  "login.submitting": "Entrando…",
  "login.invalid": "Usuário ou senha inválidos.",
  "login.locked": "Conta bloqueada temporariamente. Tente novamente em {time}.",
  "login.rateLimited": "Muitas tentativas deste endereço. Tente novamente em {time}.",
  "login.network": "Não foi possível falar com o servidor. Tente novamente.",
  "login.expired": "Sua sessão expirou. Entre novamente.",
  "invite.code": "00 / CONVITE",
  "invite.title": "Criar sua senha",
  "invite.resetTitle": "Redefinir sua senha",
  "invite.invitedBy": "{name} convidou você para o Sentinel.",
  "invite.invitedAnonymous": "Você foi convidado para o Sentinel.",
  "invite.username": "Usuário",
  "invite.password": "Nova senha",
  "invite.confirm": "Confirmar senha",
  "invite.policy": "Mínimo de 12 caracteres. Não use o seu usuário.",
  "invite.mismatch": "As senhas não coincidem.",
  "invite.tooShort": "A senha precisa ter pelo menos 12 caracteres.",
  "invite.matchesUsername": "A senha não pode ser igual ao usuário.",
  "invite.submit": "Salvar e entrar",
  "invite.invalid": "Este link é inválido, expirou ou já foi usado. Peça um novo link ao administrador.",
  "invite.backToLogin": "Ir para o login",
  "strength.weak": "Fraca",
  "strength.fair": "Razoável",
  "strength.good": "Boa",
  "strength.strong": "Forte",
};
const en: typeof ptBR = {
  "frame.tagline": "Evidence-driven security",
  "frame.engine": "Engine ready",
  "login.code": "00 / ACCESS",
  "login.title": "Sign in to Sentinel",
  "login.description": "Use the account your administrator created.",
  "login.username": "Username",
  "login.password": "Password",
  "login.show": "Show password",
  "login.hide": "Hide password",
  "login.capsLock": "Caps Lock is on.",
  "login.submit": "Sign in",
  "login.submitting": "Signing in…",
  "login.invalid": "Invalid username or password.",
  "login.locked": "Account temporarily locked. Try again in {time}.",
  "login.rateLimited": "Too many attempts from this address. Try again in {time}.",
  "login.network": "Could not reach the server. Try again.",
  "login.expired": "Your session expired. Sign in again.",
  "invite.code": "00 / INVITE",
  "invite.title": "Create your password",
  "invite.resetTitle": "Reset your password",
  "invite.invitedBy": "{name} invited you to Sentinel.",
  "invite.invitedAnonymous": "You were invited to Sentinel.",
  "invite.username": "Username",
  "invite.password": "New password",
  "invite.confirm": "Confirm password",
  "invite.policy": "At least 12 characters. Do not use your username.",
  "invite.mismatch": "Passwords do not match.",
  "invite.tooShort": "The password must be at least 12 characters.",
  "invite.matchesUsername": "The password cannot be your username.",
  "invite.submit": "Save and sign in",
  "invite.invalid": "This link is invalid, expired or already used. Ask your administrator for a new link.",
  "invite.backToLogin": "Go to sign in",
  "strength.weak": "Weak",
  "strength.fair": "Fair",
  "strength.good": "Good",
  "strength.strong": "Strong",
};
export const authMessages: ScopedMessages<keyof typeof ptBR> = { "pt-BR": ptBR, en, es, de, fr };
```

- [ ] **Step 1: Write the e2e test first** in `apps/web/e2e/auth.spec.ts` (Task 19 extends fixtures; write this spec now and let it fail):

```ts
import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

test("signs in and returns to the requested page", async ({ page }) => {
  await mockApi(page, "en", { signedOut: true });
  await page.goto("/scans?status=all");
  await expect(page).toHaveURL(/\/login\?next=%2Fscans%3Fstatus%3Dall/);
  await page.getByLabel("Username").fill("ana");
  await page.getByLabel("Password", { exact: true }).fill("wrong password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Invalid username or password.")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("ana password 123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/scans\?status=all$/);
});

test("shows the lockout countdown", async ({ page }) => {
  await mockApi(page, "en", { signedOut: true, loginResponse: { status: 423, body: { error: "account_locked", retryAfterSeconds: 65 } } });
  await page.goto("/login");
  await page.getByLabel("Username").fill("ana");
  await page.getByLabel("Password", { exact: true }).fill("anything at all");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/Try again in 01:0[45]/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
});

test("accepts an invite with a matching password", async ({ page }) => {
  await mockApi(page, "en", { signedOut: true });
  await page.goto(`/invite/${"a".repeat(43)}`);
  await expect(page.getByText("Root invited you to Sentinel.")).toBeVisible();
  await page.getByLabel("New password").fill("a strong password");
  await page.getByLabel("Confirm password").fill("a different password");
  await page.getByRole("button", { name: "Save and sign in" }).click();
  await expect(page.getByText("Passwords do not match.")).toBeVisible();
  await page.getByLabel("Confirm password").fill("a strong password");
  await page.getByRole("button", { name: "Save and sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
});
```

- [ ] **Step 2: Implement `AuthFrame`, `LoginPage`, `InvitePage`, `i18n/auth.ts`** per the design above, and the `App.tsx` routing changes.

- [ ] **Step 3: Run after Task 19's fixture change** (the spec depends on `mockApi` options). Run: `cd apps/web && pnpm build && pnpm exec playwright test e2e/auth.spec.ts`
Expected: PASS on desktop and mobile projects.

- [ ] **Step 4: Visual check.** Take desktop (1440×900) and mobile (390×844) screenshots of `/login` and `/invite/<token>` in dark and light themes with Playwright; review against the design notes. Delete the screenshots afterwards (AGENTS.md Playwright cleanup) unless kept as PR evidence.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/i18n/auth.ts apps/web/src/components/auth/AuthFrame.tsx apps/web/src/pages/LoginPage.tsx apps/web/src/pages/InvitePage.tsx apps/web/src/App.tsx apps/web/e2e/auth.spec.ts
git commit -m "feat(web): login and invite pages"
```

---

### Task 16: Configurações navigation, user menu and My account

**Files:**
- Create: `apps/web/src/components/auth/UserMenu.tsx`, `apps/web/src/pages/AccountPage.tsx`, `apps/web/src/i18n/access.ts`
- Modify: `apps/web/src/components/settings/SettingsSectionNav.tsx`, `apps/web/src/App.tsx` (nav entry label, user menu between `LanguageSwitcher` and LAUNCH at ~line 115, route `/settings/account`, hide LAUNCH and the dock's New scan for non-admins), `apps/web/src/i18n.tsx` (keys below in `ptBR`, `enUi`, `esUi`, `deUi`, `frUi`)

**Interfaces:**
- Consumes: `useAuth`, `authApi` (Task 14).
- Produces: `accessMessages` scoped catalogue (shared by Tasks 16–17); `SettingsSectionNav` sections with an `adminOnly` flag.

Global keys (add to all five locale tables):

| Key | pt-BR | en |
|---|---|---|
| `nav.system` | Configurações | Settings |
| `settings.systemSection` | Sistema | System |
| `settings.usersSection` | Usuários | Users |
| `settings.accessSection` | Repositórios e acessos | Repository access |
| `settings.accountSection` | Minha conta | My account |
| `userMenu.admin` | Administrador | Administrator |
| `userMenu.member` | Membro | Member |
| `userMenu.account` | Minha conta | My account |
| `userMenu.logout` | Sair | Sign out |

`SettingsSectionNav` sections:

```ts
const sections: ReadonlyArray<{ to: string; code: string; label: TranslationKey; adminOnly: boolean }> = [
  { to: "/settings", code: "01", label: "settings.systemSection", adminOnly: true },
  { to: "/settings/connections", code: "02", label: "settings.connectionsSection", adminOnly: true },
  { to: "/settings/users", code: "03", label: "settings.usersSection", adminOnly: true },
  { to: "/settings/access", code: "04", label: "settings.accessSection", adminOnly: true },
  { to: "/settings/account", code: "05", label: "settings.accountSection", adminOnly: false },
];
```

Render `sections.filter((s) => isAdmin || !s.adminOnly)`; change the container to `grid grid-cols-2 gap-px sm:grid-cols-3 lg:flex` so five items wrap cleanly. For non-admins, the `/settings` nav tab links to `/settings/account`, and visiting `/settings` or `/settings/connections` redirects to `/settings/account`.

`UserMenu`: `DropdownMenu` trigger shows a 28px square with the user's initials (first letters of up to two words of `displayName`), name on `xl:` screens. Content: name, `@username`, role badge (`userMenu.admin`/`userMenu.member`), separator, "Minha conta" → `/settings/account`, "Sair" → `logout()`. In local mode (`session.runtimeMode === "local"`) omit "Sair".

`AccountPage` (all users; in local mode show a note that accounts apply only to server deployments):
- Profile panel: display name input + Save (`authApi.updateProfile`), username read-only, role.
- Password panel: current, new, confirm; same client-side checks as the invite page; success banner "Senha alterada. As outras sessões foram encerradas."; `invalid_credentials` → "Senha atual incorreta."
- Sessions panel: table (device from `userAgent` shortened to browser + OS, IP, last activity relative time, "Esta sessão" badge on `current`), per-row "Encerrar" (disabled for current), "Sair das outras sessões" button.

- [ ] **Step 1: e2e first** — extend `e2e/auth.spec.ts`:

```ts
test("members see only My account under Settings", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [{ repositoryKey: "github:1", role: "viewer" }] } });
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page.getByRole("link", { name: /Users/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /LAUNCH/i })).toHaveCount(0);
});

test("changes the password from My account", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [] } });
  await page.goto("/settings/account");
  await page.getByLabel("Current password").fill("old password 123");
  await page.getByLabel("New password").fill("new password 1234");
  await page.getByLabel("Confirm password").fill("new password 1234");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed. Your other sessions were signed out.")).toBeVisible();
});
```

- [ ] **Step 2: Implement** the files above; `accessMessages` keys used here (write all five locales):

```ts
const ptBR = {
  "account.code": "08.05 / CONTA", "account.title": "Minha conta", "account.description": "Seus dados, sua senha e onde você está conectado.",
  "account.localNote": "Contas e senhas valem apenas na implantação em servidor.",
  "account.profile": "Perfil", "account.displayName": "Nome de exibição", "account.username": "Usuário", "account.role": "Papel",
  "account.save": "Salvar", "account.saved": "Perfil atualizado.",
  "account.password": "Senha", "account.current": "Senha atual", "account.new": "Nova senha", "account.confirm": "Confirmar senha",
  "account.change": "Alterar senha", "account.changed": "Senha alterada. As outras sessões foram encerradas.",
  "account.wrongCurrent": "Senha atual incorreta.",
  "account.sessions": "Sessões ativas", "account.thisSession": "Esta sessão", "account.revoke": "Encerrar",
  "account.revokeOthers": "Sair das outras sessões", "account.lastActive": "Última atividade", "account.device": "Dispositivo", "account.ip": "IP",
};
// en: "Current password", "New password", "Confirm password", "Change password",
//     "Password changed. Your other sessions were signed out.", etc. — translate every key.
```

- [ ] **Step 3: Run**

Run: `cd apps/web && pnpm typecheck && pnpm build && pnpm exec playwright test e2e/auth.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/auth/UserMenu.tsx apps/web/src/pages/AccountPage.tsx apps/web/src/i18n/access.ts apps/web/src/components/settings/SettingsSectionNav.tsx apps/web/src/App.tsx apps/web/src/i18n.tsx apps/web/e2e/auth.spec.ts
git commit -m "feat(web): settings navigation, user menu and my account"
```

---

### Task 17: Users and repository access screens

**Files:**
- Create: `apps/web/src/pages/UsersPage.tsx`, `apps/web/src/pages/RepositoryAccessPage.tsx`, `apps/web/src/components/access/InviteUserDialog.tsx`, `apps/web/src/components/access/UserDrawer.tsx`, `apps/web/src/components/access/RoleSelect.tsx`
- Modify: `apps/web/src/lib/auth-api.ts` (admin client), `apps/web/src/i18n/access.ts` (keys), `apps/web/src/App.tsx` (routes `/settings/users`, `/settings/access`, admin-only)

**Interfaces:**
- Consumes: shared types `UserSummary`, `RepositoryGrant`, `RepositoryAccessEntry`, `InviteLinkResponse`, `UserSessionSummary`; `api.listGuardrailRepositories()` (existing) for the repository list.
- Produces (`auth-api.ts`):

```ts
export const usersApi: {
  list(): Promise<UserSummary[]>;
  create(input: { username: string; displayName: string; email: string | null; isAdmin: boolean; grants: RepositoryGrant[] }): Promise<{ user: UserSummary; invite: InviteLinkResponse }>;
  update(id: string, patch: Partial<Pick<UserSummary, "displayName" | "email" | "isAdmin" | "status">>): Promise<UserSummary>;
  reset(id: string): Promise<InviteLinkResponse>;
  revokeSessions(id: string): Promise<void>;
  sessions(id: string): Promise<UserSessionSummary[]>;
  grants(id: string): Promise<RepositoryGrant[]>;
  replaceGrants(id: string, grants: RepositoryGrant[]): Promise<RepositoryGrant[]>;
  repositoryAccess(): Promise<RepositoryAccessEntry[]>;
  setRepositoryRole(repositoryKey: string, userId: string, role: RepositoryRole | null): Promise<void>;
};
```

Screens:
- `RoleSelect({ value, onChange, allowNone })`: `Select` with "Sem acesso" (when `allowNone`), Leitura, Analista, Operador, Mantenedor, each with a one-line description from the spec's role table.
- `UsersPage`: `PageHeader` code `08.03 / USUÁRIOS`; toolbar with search (username/name) and status filter (Todos/Ativos/Desativados/Convite pendente); `Table` columns Nome (+ `@username`), Status badge (Ativo / Desativado / Convite pendente), Admin badge, Repositórios (count), Último login (relative, "Nunca"), 2FA ("—" in Phase 1), GitHub ("—" in Phase 1); row click opens `UserDrawer`; primary button "Convidar usuário".
- `InviteUserDialog`: `Dialog` with name, username (live-normalized preview), email (optional), "Administrador do sistema" checkbox (`Checkbox`), repository list with a `RoleSelect` per repository (hidden when admin is checked, with the note "Administradores veem todos os repositórios"). Submit → shows the result step: invite URL in a read-only mono input, "Copiar link" button (`navigator.clipboard.writeText`, then "Copiado"), expiry date, warning "Este link aparece só agora. Envie para a pessoa por um canal seguro." Errors: `username_taken` → "Esse usuário já existe."; `username_invalid` → "Use 2 a 64 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado."
- `UserDrawer`: `Sheet` (right, `sm:max-w-xl`) with header (name, username, badges) and `Tabs`:
  - Acesso: repository list with `RoleSelect allowNone`; Save → `replaceGrants`; when the user is admin, show the note instead.
  - Sessões: table of `sessions(id)` + "Encerrar todas as sessões" (confirmation dialog).
  - Ações: toggle admin (confirmation; show server `last_admin` error as "Não é possível remover o último administrador ativo."), Desativar/Reativar (confirmation copy: "A pessoa perde o acesso imediatamente e todas as sessões são encerradas."), "Gerar link de redefinição" (confirmation; then the same copy-link result as the invite dialog).
- `RepositoryAccessPage`: `PageHeader` code `08.04 / ACESSOS`; one `Panel` per repository (`displayName`, source badge GitHub/Local, key in mono), list of users with `RoleSelect allowNone` inline (saves on change via `setRepositoryRole`, optimistic with rollback on error), and "Conceder acesso" row with a user picker (`Select` of active users without a grant) + `RoleSelect`. Empty state when no repositories are registered: "Nenhum repositório registrado. Registre repositórios em Guardrails."

- [ ] **Step 1: e2e first** (`e2e/auth.spec.ts`):

```ts
test("admin invites a user with a repository role and copies the link", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Invite user" }).click();
  await page.getByLabel("Name").fill("Bruno Lima");
  await page.getByLabel("Username").fill(" Bruno.Lima ");
  await page.getByRole("combobox", { name: "luna-core" }).click();
  await page.getByRole("option", { name: /Viewer/ }).click();
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.getByRole("textbox", { name: "Invite link" })).toHaveValue(/\/invite\/[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText("This link is shown only now.")).toBeVisible();
});

test("shows the last-admin refusal", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] }, patchUserResponse: { status: 409, body: { error: "last_admin" } } });
  await page.goto("/settings/users");
  await page.getByRole("row", { name: /root/ }).click();
  await page.getByRole("tab", { name: "Actions" }).click();
  await page.getByRole("button", { name: "Remove administrator" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("You cannot remove the last active administrator.")).toBeVisible();
});
```

- [ ] **Step 2: Implement** the files and the i18n keys (all five locales) for every label and message named above.

- [ ] **Step 3: Run**

Run: `cd apps/web && pnpm typecheck && pnpm build && pnpm exec playwright test`
Expected: PASS (all specs, desktop and mobile).

- [ ] **Step 4: Visual check** of `/settings/users` (table, dialog, drawer) and `/settings/access` at desktop and mobile widths; remove screenshots afterwards unless kept as PR evidence.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/UsersPage.tsx apps/web/src/pages/RepositoryAccessPage.tsx apps/web/src/components/access apps/web/src/lib/auth-api.ts apps/web/src/i18n/access.ts apps/web/src/App.tsx apps/web/e2e/auth.spec.ts
git commit -m "feat(web): user administration and repository access screens"
```

---

### Task 18: Permission-aware actions

**Files (modify):** components that trigger role-gated API calls. Locate them with:

```bash
cd apps/web && git grep -n -E "deleteScan|cancelScan|markBaseline|triage|saveGuardrailPolicy|putPolicy|simulatePolicy|startGate|createGate|cancelGate|publishGate|dispatchActions|syncBaseline|checkoutSync|poll\(|createRule|updateRule|to=\"/scans/new\"|/settings/connections" src -- ':!src/lib/*.test.ts'
```

**Interfaces:**
- Consumes: `useAuth().can(role, repositoryKey)`, `useAuth().isAdmin` (Task 14); `ScanRun.repositoryKey` (Task 1) and `GateRun.repositoryKey` / `GuardrailRepository.repositoryKey` (existing).

Mapping (hide the control when not allowed; the server remains authoritative):

| Control | Condition |
|---|---|
| New scan / LAUNCH / CommandDock new scan | `isAdmin` |
| Start gate (preflight "Run" / "Start") | `isAdmin` |
| Delete scan, delete gate | `can("maintainer", key)` |
| Cancel scan, cancel/publish gate, mark baseline, baseline sync, target preview, Actions dispatch, checkout fetch/pull, monitor poll | `can("operator", key)` |
| Triage buttons, policy simulate | `can("analyst", key)` |
| Policy edit/save, caller workflow save | `can("maintainer", key)` (else read-only view) |
| GitHub monitor rule create/edit, Register repository, GitHub App setup, Connections links | `isAdmin` |

- [ ] **Step 1: e2e first** (`e2e/auth.spec.ts`):

```ts
test("a viewer sees scans but no destructive or paid actions", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [{ repositoryKey: "github:1", role: "viewer" }] } });
  await page.goto("/scans/fixture-scan");
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /confirm|false positive|accept/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /new scan/i })).toHaveCount(0);
});
```

Use the fixture scan id and button labels that exist in `e2e/fixtures.ts` and the scan detail page; set the fixture scan's `repositoryKey` to `"github:1"`.

- [ ] **Step 2: Apply the mapping** at each call site found by the grep, wrapping controls in the condition from the table.

- [ ] **Step 3: Run**

Run: `cd apps/web && pnpm typecheck && pnpm build && pnpm exec playwright test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src apps/web/e2e/auth.spec.ts
git commit -m "feat(web): hide actions the signed-in role cannot perform"
```

---

### Task 19: E2E fixtures for auth

This task's change is needed by the e2e steps of Tasks 15–18; implement it before running those specs (it can be done right after Task 14).

**Files:**
- Modify: `apps/web/e2e/fixtures.ts`

**Interfaces:**
- Produces: `mockApi(page, locale = "en", options: { signedOut?: boolean; session?: { isAdmin: boolean; grants: RepositoryGrant[] }; loginResponse?: { status: number; body: unknown }; patchUserResponse?: { status: number; body: unknown } } = {})`.

Behaviour:
- `GET /api/auth/session`: when `signedOut` and no successful login yet → `401 {"error":"authentication_required"}`; otherwise → `{ user: { id: "u-root", username: "root", displayName: "Root", isAdmin }, grants, csrfToken: "fixture-token", runtimeMode: options.session ? "server" : "local", repositoryRoots: [] }`. Default (no options) returns a local admin so every existing spec keeps passing.
- `POST /api/auth/login`: `loginResponse` if given; else `200 {ok:true}` when the posted password is `"ana password 123"` (and flips the fixture to signed in), else `401 {"error":"invalid_credentials"}`.
- `POST /api/auth/logout` → `204`.
- `GET /api/auth/invites/:token` → `{ username: "ana", displayName: "Ana", purpose: "invite", invitedBy: "Root", expiresAt: "2026-10-02T10:00:00.000Z" }`; `POST` → `200 {ok:true}` and signs in.
- `GET /api/account/sessions` → one current session; `POST /api/account/password` → `204`; `PATCH /api/account/profile` → the updated user.
- `GET /api/users` → `[root (admin), ana (member, 1 repository)]`; `POST /api/users` → `201` with `invite.inviteUrl = "http://127.0.0.1:4175/invite/" + "b".repeat(43)`; `PATCH /api/users/:id` → `patchUserResponse` or the patched user; `GET /api/users/:id/grants|sessions` and `PUT …/grants` → consistent fixtures; `GET /api/repository-access` → `[{ repositoryKey: "github:1", displayName: "luna-core", source: "github", grants: [...] }]`.
- Keep `/security-session` for backward compatibility (the web client no longer calls it after Task 14, but keeping it avoids breaking other specs).

- [ ] **Step 1: Implement the fixture branches.**
- [ ] **Step 2: Run the whole e2e suite**

Run: `cd apps/web && pnpm build && pnpm exec playwright test`
Expected: all existing specs PASS; `auth.spec.ts` passes as its owning tasks land.

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/fixtures.ts
git commit -m "test(web): auth fixtures for login, invites and users"
```

---

### Task 20: Integration, PR and cleanup

- [ ] **Step 1: Full verification**

Run:
```bash
pnpm typecheck
pnpm test
(cd apps/web && pnpm build && pnpm exec playwright test)
pnpm check:repository
git status --short
```
Expected: everything passes; no Playwright artifacts left in `.playwright-cli/`, `test-results/`, `output/` (AGENTS.md).

- [ ] **Step 2: Manual server-mode check** with `docker compose` (or the smoke script): first start creates `admin`; sign in at `/login`; invite a member with Viewer on one repository; open the invite link in a private window; confirm the member sees only that repository's scans and cannot open another scan by id (404); disable the member and confirm the open scan page is sent to `/login` within 60 seconds.

- [ ] **Step 3: Open the PR** from the feature branch to `main` with the verification summary; wait for "Typecheck, test, and build" and "Build Linux image and smoke server"; merge.

- [ ] **Step 4: Cleanup** — after merge and deploy: delete this plan file in a follow-up commit, remove the feature worktree/branch if one was created, run `git worktree list --porcelain` and `git status --short`.
