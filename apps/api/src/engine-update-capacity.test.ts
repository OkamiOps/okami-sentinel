import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { ENGINE_UPDATE_RESERVATION_PREFIX, engineUpdateBlockingReason, releaseScanCapacity, reserveScanCapacity } from "./db.js";

test("engine maintenance is exclusive across SQLite connections and includes pending preflight", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-maintenance-test-"));
  const file = path.join(root, "capacity.sqlite");
  const first = new Database(file);
  first.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  const second = new Database(file);
  const maintenance = `${ENGINE_UPDATE_RESERVATION_PREFIX}test`;
  try {
    assert.equal(reserveScanCapacity("preflight", 8, { database: first }), true);
    assert.equal(engineUpdateBlockingReason({ database: second }), "scan_active");
    assert.equal(reserveScanCapacity(maintenance, 1, { database: second }), false);
    releaseScanCapacity("preflight", first);
    assert.equal(reserveScanCapacity(maintenance, 1, { database: second }), true);
    assert.equal(engineUpdateBlockingReason({ database: first }), "update_in_progress");
    assert.equal(reserveScanCapacity("new-scan", 8, { database: first }), false);
    assert.equal(reserveScanCapacity(`${ENGINE_UPDATE_RESERVATION_PREFIX}other`, 1, { database: first }), false);
    releaseScanCapacity(maintenance, second);
    assert.equal(reserveScanCapacity("new-scan", 8, { database: first }), true);
    releaseScanCapacity("new-scan", first);
    first.prepare("INSERT INTO runs (id,status) VALUES (?,?)").run("worker", "running");
    assert.equal(reserveScanCapacity(maintenance, 1, { database: second }), false);
    first.prepare("UPDATE runs SET status='completed'").run();
    assert.equal(reserveScanCapacity(maintenance, 1, { database: second }), true);
    releaseScanCapacity(maintenance, second);
    assert.equal(engineUpdateBlockingReason({ database: first }), null);
  } finally { second.close(); first.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a stale maintenance lease after a crash does not permanently block scans", () => {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  const now = new Date();
  try {
    assert.equal(reserveScanCapacity(`${ENGINE_UPDATE_RESERVATION_PREFIX}crashed`, 1, { database, now: new Date(now.getTime() - 6 * 60_000) }), true);
    assert.equal(engineUpdateBlockingReason({ database, now }), null);
    assert.equal(reserveScanCapacity("after-crash", 8, { database, now }), true);
  } finally { database.close(); }
});
