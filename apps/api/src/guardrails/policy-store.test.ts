import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { defaultToImmediateTransactions } from "../sqlite.js";
import { policyForPreset } from "./policy-presets.js";
import {
  deleteRepositoryPolicy,
  ensureRepositoryPolicySchema,
  getRepositoryPolicy,
  putRepositoryPolicy,
} from "./policy-store.js";

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  defaultToImmediateTransactions(db);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO guardrail_repositories VALUES ('github:1')").run();
  db.prepare("INSERT INTO guardrail_repositories VALUES ('github:2')").run();
  ensureRepositoryPolicySchema(db);
  return db;
}

test("a repository with no saved policy reads as null", () => {
  const db = memoryDb();
  assert.equal(getRepositoryPolicy("github:1", db), null);
});

test("saves and reads back a policy with its preset and author", () => {
  const db = memoryDb();
  const policy = policyForPreset("block-critical", ["main"]);
  putRepositoryPolicy("github:1", policy, "block-critical", "user-1", db, "2026-10-01T10:00:00.000Z");
  const stored = getRepositoryPolicy("github:1", db);
  assert.deepEqual(stored, {
    policy,
    preset: "block-critical",
    updatedAt: "2026-10-01T10:00:00.000Z",
    updatedBy: "user-1",
  });
});

test("saving twice replaces the row rather than failing", () => {
  const db = memoryDb();
  putRepositoryPolicy("github:1", policyForPreset("warn-only", ["main"]), "warn-only", "user-1", db, "2026-10-01T10:00:00.000Z");
  putRepositoryPolicy("github:1", policyForPreset("block-critical", ["trunk"]), "block-critical", "user-2", db, "2026-10-01T11:00:00.000Z");
  const stored = getRepositoryPolicy("github:1", db);
  assert.equal(stored?.preset, "block-critical");
  assert.equal(stored?.updatedBy, "user-2");
  assert.equal(stored?.updatedAt, "2026-10-01T11:00:00.000Z");
  assert.deepEqual(stored?.policy.protectedBranches, ["trunk"]);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS total FROM guardrail_repository_policies").get() as { total: number }).total,
    1,
  );
});

test("one repository's policy is not another's", () => {
  const db = memoryDb();
  putRepositoryPolicy("github:1", policyForPreset("warn-only", ["main"]), "warn-only", null, db);
  assert.equal(getRepositoryPolicy("github:2", db), null);
});

test("refuses a preset the schema does not know", () => {
  const db = memoryDb();
  assert.throws(
    // @ts-expect-error the route validates first; the store refuses anyway.
    () => putRepositoryPolicy("github:1", policyForPreset("warn-only", ["main"]), "block-everything", null, db),
    /guardrail_policy_preset_invalid/,
  );
});

test("refuses a policy the parser would not accept", () => {
  const db = memoryDb();
  const policy = policyForPreset("warn-only", ["main"]);
  policy.rules = [];
  assert.throws(() => putRepositoryPolicy("github:1", policy, "custom", null, db));
});

test("refuses a repository that is not enrolled", () => {
  const db = memoryDb();
  assert.throws(() => putRepositoryPolicy("github:absent", policyForPreset("warn-only", ["main"]), "warn-only", null, db));
});

test("deleting is idempotent and removes the row", () => {
  const db = memoryDb();
  putRepositoryPolicy("github:1", policyForPreset("warn-only", ["main"]), "warn-only", null, db);
  assert.equal(deleteRepositoryPolicy("github:1", db), true);
  assert.equal(getRepositoryPolicy("github:1", db), null);
  assert.equal(deleteRepositoryPolicy("github:1", db), false);
});

test("removing the repository takes its policy with it", () => {
  const db = memoryDb();
  putRepositoryPolicy("github:1", policyForPreset("warn-only", ["main"]), "warn-only", null, db);
  db.prepare("DELETE FROM guardrail_repositories WHERE repository_key = 'github:1'").run();
  assert.equal(getRepositoryPolicy("github:1", db), null);
});

test("the schema migration runs twice with no effect", () => {
  const db = memoryDb();
  putRepositoryPolicy("github:1", policyForPreset("warn-only", ["main"]), "warn-only", null, db);
  ensureRepositoryPolicySchema(db);
  ensureRepositoryPolicySchema(db);
  assert.equal(getRepositoryPolicy("github:1", db)?.preset, "warn-only");
  assert.equal(
    (db.prepare("SELECT max(version) AS version FROM guardrail_policy_schema_migrations").get() as { version: number }).version,
    1,
  );
});

test("a corrupt policy row reads as absent instead of throwing at the screen", () => {
  const db = memoryDb();
  putRepositoryPolicy("github:1", policyForPreset("warn-only", ["main"]), "warn-only", null, db);
  db.prepare("UPDATE guardrail_repository_policies SET policy_json = '{' WHERE repository_key = 'github:1'").run();
  assert.equal(getRepositoryPolicy("github:1", db), null);
});
