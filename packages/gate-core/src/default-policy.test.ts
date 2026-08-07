import assert from "node:assert/strict";
import test from "node:test";
import { defaultGuardrailPolicy } from "./default-policy.js";

test("default policy blocks new or reopened critical and high findings", () => {
  const policy = defaultGuardrailPolicy();
  assert.equal(policy.schemaVersion, 1);
  assert.deepEqual(policy.protectedBranches, ["main"]);
  assert.deepEqual(policy.rules, [
    { severity: ["critical"], lifecycle: ["new", "reopened"], decision: "block" },
    { severity: ["high"], lifecycle: ["new", "reopened"], decision: "block" },
    { severity: ["high"], lifecycle: ["persistent"], decision: "review" },
  ]);
  assert.equal(policy.scan.maxCostUsd, 18);
});
