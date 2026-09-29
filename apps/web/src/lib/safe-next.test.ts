import assert from "node:assert/strict";
import test from "node:test";
import { safeNext } from "./safe-next.js";

test("keeps in-app paths and refuses off-site redirects", () => {
  assert.equal(safeNext("/scans/abc?tab=2#x"), "/scans/abc?tab=2#x");
  for (const value of [null, "", "scans", "//evil.example", "/\\evil.example", "https://evil.example", "/login", "javascript:alert(1)"]) {
    assert.equal(safeNext(value), "/", String(value));
  }
});
