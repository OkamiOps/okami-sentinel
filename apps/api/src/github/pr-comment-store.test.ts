import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { defaultToImmediateTransactions } from "../sqlite.js";
import {
  ensurePrCommentSchema,
  getPrComment,
  listPrComments,
  upsertPrComment,
} from "./pr-comment-store.js";

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  defaultToImmediateTransactions(db);
  ensurePrCommentSchema(db);
  return db;
}

function record(overrides: Partial<Parameters<typeof upsertPrComment>[0]> = {}) {
  return {
    repositoryKey: "github:1",
    pullRequestNumber: 7,
    commentId: "91",
    status: "published" as const,
    reason: null,
    bodyHash: "hash-1",
    gateId: "gate-1",
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

test("an unknown pull request has no comment", () => {
  const db = memoryDb();
  assert.equal(getPrComment("github:1", 7, db), null);
  db.close();
});

test("stores and reads back the comment of a pull request", () => {
  const db = memoryDb();
  upsertPrComment(record(), db);
  assert.deepEqual(getPrComment("github:1", 7, db), record());
  db.close();
});

test("the second publication replaces the first, one row per pull request", () => {
  const db = memoryDb();
  upsertPrComment(record(), db);
  upsertPrComment(record({ bodyHash: "hash-2", updatedAt: "2026-09-30T11:00:00.000Z" }), db);
  assert.equal(getPrComment("github:1", 7, db)?.bodyHash, "hash-2");
  assert.equal(listPrComments("github:1", db).length, 1);
  db.close();
});

test("a failure is a state, with its reason, not a missing row", () => {
  const db = memoryDb();
  upsertPrComment(record({ status: "failed", reason: "github_permission_missing", commentId: null }), db);
  const stored = getPrComment("github:1", 7, db);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.reason, "github_permission_missing");
  assert.equal(stored?.commentId, null);
  db.close();
});

test("lists a repository's comments newest pull request first", () => {
  const db = memoryDb();
  upsertPrComment(record({ pullRequestNumber: 3 }), db);
  upsertPrComment(record({ pullRequestNumber: 11 }), db);
  upsertPrComment(record({ repositoryKey: "github:2", pullRequestNumber: 99 }), db);
  assert.deepEqual(
    listPrComments("github:1", db).map((row) => row.pullRequestNumber),
    [11, 3],
  );
  db.close();
});

test("the schema is created once and is safe to ask for twice", () => {
  const db = memoryDb();
  ensurePrCommentSchema(db);
  ensurePrCommentSchema(db);
  const version = db
    .prepare("SELECT max(version) AS version FROM guardrail_pr_comment_schema_migrations")
    .get() as { version: number };
  assert.equal(version.version, 1);
  db.close();
});
