import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { hideRun } from "./db.js";

test("hides a run from the ledger without deleting its record", () => {
  const database = new Database(":memory:");

  try {
    database.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY);
      CREATE TABLE hidden_runs (id TEXT PRIMARY KEY, hidden_at TEXT NOT NULL);
      INSERT INTO runs (id) VALUES ('failed-scan');
    `);

    hideRun("failed-scan", database);

    assert.deepEqual(
      database.prepare("SELECT id FROM runs").all(),
      [{ id: "failed-scan" }],
    );
    assert.deepEqual(
      database.prepare("SELECT id FROM hidden_runs").all(),
      [{ id: "failed-scan" }],
    );
  } finally {
    database.close();
  }
});
