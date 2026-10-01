import assert from "node:assert/strict";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";

import { policyForPreset } from "./policy-presets.js";
import { resolveGuardrailPolicy } from "./policy-precedence.js";

const FILE_POLICY = policyForPreset("warn-only", ["main"]);
const SENTINEL_POLICY = policyForPreset("block-critical", ["main"]);

test("the repository file wins and the editor is read-only", () => {
  const resolved = resolveGuardrailPolicy({
    protectedFile: { present: true, policy: FILE_POLICY, invalidReason: null },
    sentinel: SENTINEL_POLICY,
  });
  assert.deepEqual(resolved, {
    policy: FILE_POLICY,
    source: "repository_file",
    readOnly: true,
    fileInvalidReason: null,
  });
});

test("an invalid repository file falls to the Sentinel policy with a reason", () => {
  const resolved = resolveGuardrailPolicy({
    protectedFile: { present: true, policy: null, invalidReason: "policy_invalid" },
    sentinel: SENTINEL_POLICY,
  });
  assert.deepEqual(resolved, {
    policy: SENTINEL_POLICY,
    source: "sentinel",
    readOnly: false,
    fileInvalidReason: "policy_invalid",
  });
});

test("an invalid repository file with no Sentinel policy falls to the default, still reporting the reason", () => {
  const resolved = resolveGuardrailPolicy({
    protectedFile: { present: true, policy: null, invalidReason: "policy_invalid" },
    sentinel: null,
  });
  assert.deepEqual(resolved, {
    policy: defaultGuardrailPolicy(),
    source: "default",
    readOnly: false,
    fileInvalidReason: "policy_invalid",
  });
});

test("the Sentinel policy wins when there is no file", () => {
  const resolved = resolveGuardrailPolicy({
    protectedFile: { present: false, policy: null, invalidReason: null },
    sentinel: SENTINEL_POLICY,
  });
  assert.deepEqual(resolved, {
    policy: SENTINEL_POLICY,
    source: "sentinel",
    readOnly: false,
    fileInvalidReason: null,
  });
});

test("the default wins when there is neither", () => {
  const resolved = resolveGuardrailPolicy({
    protectedFile: { present: false, policy: null, invalidReason: null },
    sentinel: null,
  });
  assert.deepEqual(resolved, {
    policy: defaultGuardrailPolicy(),
    source: "default",
    readOnly: false,
    fileInvalidReason: null,
  });
});

test("a present file with neither a policy nor a reason is reported as invalid rather than obeyed", () => {
  // A caller that loses both is a bug in the loader, not a repository without a
  // file; treating it as "no file" would silently promote the Sentinel policy
  // over one the repository does carry.
  const resolved = resolveGuardrailPolicy({
    protectedFile: { present: true, policy: null, invalidReason: null },
    sentinel: SENTINEL_POLICY,
  });
  assert.equal(resolved.source, "sentinel");
  assert.equal(resolved.fileInvalidReason, "policy_unreadable");
});

test("the resolved policy is a copy, so a caller cannot edit the stored one", () => {
  const sentinel = policyForPreset("warn-only", ["main"]);
  const resolved = resolveGuardrailPolicy({
    protectedFile: { present: false, policy: null, invalidReason: null },
    sentinel,
  });
  resolved.policy.protectedBranches.push("release/**");
  assert.deepEqual(sentinel.protectedBranches, ["main"]);
});
