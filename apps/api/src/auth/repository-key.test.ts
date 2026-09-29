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
