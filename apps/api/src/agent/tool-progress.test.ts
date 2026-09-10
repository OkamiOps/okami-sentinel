import test from "node:test";
import assert from "node:assert/strict";
import { ToolProgressTracker } from "./tool-progress.js";

test("301 different source results are progress, regardless of action count", () => {
  const tracker = new ToolProgressTracker();
  for (let i = 0; i < 301; i++) assert.equal(tracker.observe("workspace.read", { path: `${i}.ts` }, "code", false), false);
});

test("cyclic repeated inspection receives guidance; new evidence resets stagnation", () => {
  const tracker = new ToolProgressTracker();
  const read = (path: string, content = "code") => tracker.observe("workspace.read", { path }, content, false);
  assert.equal(read("a"), false); assert.equal(read("b"), false);
  assert.equal(read("a"), false); assert.equal(read("b"), false); assert.equal(read("a"), true);
  assert.equal(read("c"), false); assert.equal(read("c"), false);
  assert.equal(read("c", "new source range result"), false);
  assert.equal(read("c"), false);
});

test("canonical arguments and failed calls cannot hide stagnation; artifact repair stays separate", () => {
  const tracker = new ToolProgressTracker();
  tracker.observe("workspace.read", { path: "a", startLine: 1 }, "code", false);
  assert.equal(tracker.observe("workspace.read", { startLine: 1, path: "a" }, "code", false), false);
  assert.equal(tracker.observe("workspace.read", { path: "bad" }, "invalid", true), false);
  assert.equal(tracker.observe("workspace.read", { path: "other bad" }, "invalid", true), true);
  assert.equal(tracker.observe("results.write", {}, "invalid", true), false);
});
