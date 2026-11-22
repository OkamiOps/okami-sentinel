import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("SQLite statements can be collected while a non-Node V8 context is active", () => {
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", `
    const assert = require("node:assert/strict");
    const vm = require("node:vm");
    const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
    const database = new Database(":memory:");
    try {
      assert.deepEqual(database.prepare("SELECT 1 AS value").get(), { value: 1 });
      assert.deepEqual(database.prepare("SELECT 1 WHERE 0").all(), []);
      assert.throws(() => database.prepare("INVALID SQL"));
      for (let index = 0; index < 10000; index++) database.prepare("SELECT 1").get();
      vm.runInNewContext("let items = []; for (let i = 0; i < 1000000; i++) items.push({i, text: String(i)});");
      assert.deepEqual(database.prepare("SELECT 2 AS value").get(), { value: 2 });
    } finally {
      database.close();
    }
    console.log("SQLite context GC completed");
  `], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SQLite context GC completed/);
});
