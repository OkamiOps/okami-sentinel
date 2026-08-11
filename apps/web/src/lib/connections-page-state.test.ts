import assert from "node:assert/strict";
import test from "node:test";

import { connectionsLoadState } from "./connections-page-state.js";

test("keeps a failed initial connections request out of the loading state", () => {
  assert.equal(connectionsLoadState(null, "Connection routes could not be loaded."), "error");
});

test("keeps successful empty and populated responses distinguishable", () => {
  assert.equal(connectionsLoadState([], null), "empty");
  assert.equal(connectionsLoadState([{ id: "connection-a" }], null), "ready");
});
