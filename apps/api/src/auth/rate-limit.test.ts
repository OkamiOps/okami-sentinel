import assert from "node:assert/strict";
import test from "node:test";
import { FailureWindow } from "./rate-limit.js";

test("does not block below the failure limit", () => {
  let now = 0;
  const window = new FailureWindow(3, 10_000, () => now);
  window.fail("a");
  window.fail("a");
  assert.equal(window.blocked("a"), null);
});

test("blocks once the limit is reached and reports the ceil'd remaining seconds", () => {
  let now = 0;
  const window = new FailureWindow(3, 10_000, () => now);
  window.fail("a");
  window.fail("a");
  window.fail("a");
  now = 3_500;
  assert.equal(window.blocked("a"), 7); // ceil((10_000 - 3_500) / 1000) = 7
});

test("clears the block exactly when the window rolls over", () => {
  let now = 0;
  const window = new FailureWindow(3, 10_000, () => now);
  window.fail("a");
  window.fail("a");
  window.fail("a");
  now = 10_000;
  assert.equal(window.blocked("a"), null);
  // The rollover also resets the counter: one more failure alone doesn't re-block.
  window.fail("a");
  assert.equal(window.blocked("a"), null);
});

test("reset clears a key immediately, independent of elapsed time", () => {
  let now = 0;
  const window = new FailureWindow(1, 10_000, () => now);
  window.fail("a");
  assert.ok((window.blocked("a") ?? 0) > 0);
  window.reset("a");
  assert.equal(window.blocked("a"), null);
});

test("evicts the oldest tracked key once more than 10,000 distinct keys accumulate", () => {
  const window = new FailureWindow(1, 60_000, () => 0);
  for (let i = 0; i <= 10_000; i += 1) window.fail(`key-${i}`);
  // key-0 was the oldest entry and should have been evicted to keep the map bounded.
  assert.equal(window.blocked("key-0"), null);
  // The most recently inserted key is still tracked and still blocked.
  assert.ok((window.blocked("key-10000") ?? 0) > 0);
});
