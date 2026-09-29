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
