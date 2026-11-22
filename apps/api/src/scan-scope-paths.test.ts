import assert from "node:assert/strict";
import test from "node:test";
import { createScanScopeMatcher, normalizeScanScopePaths } from "./scan-scope-paths.js";

test("scope paths select exact files and directory descendants, not neighboring prefixes or globs", () => {
  const matches = createScanScopeMatcher(["./routes/", "lib\\auth", "server.ts"]);
  for (const file of ["routes/login.ts", "routes/admin/update.ts", "lib/auth/check.ts", "server.ts"]) assert.equal(matches(file), true);
  for (const file of ["routes-old/login.ts", "lib/authentication.ts", "server.ts.old", "src/server.ts"]) assert.equal(matches(file), false);
  assert.equal(createScanScopeMatcher(["routes/*.ts"])("routes/login.ts"), false);
  assert.deepEqual(normalizeScanScopePaths(["./routes/", "routes", "lib\\auth", "lib/auth"]), ["lib/auth", "routes"]);
});

test("empty scope and an explicit repository root retain the complete universe", () => {
  for (const scope of [[], ["."], ["./"], ["routes", "."]]) {
    assert.equal(createScanScopeMatcher(scope)("any/file.ts"), true);
    assert.deepEqual(normalizeScanScopePaths(scope), []);
  }
});
