import assert from "node:assert/strict";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";
import { parseGuardrailPolicy } from "@csb/gate-runtime";

import {
  DEFAULT_GUARDRAIL_POLICY_PRESET,
  GUARDRAIL_POLICY_PRESETS,
  policyForPreset,
  presetForPolicy,
} from "./policy-presets.js";

test("block-critical-high blocks critical and high that are new or reopened", () => {
  const policy = policyForPreset("block-critical-high", ["main"]);
  assert.deepEqual(policy.protectedBranches, ["main"]);
  assert.deepEqual(policy.rules, [
    { severity: ["critical", "high"], lifecycle: ["new", "reopened"], decision: "block" },
    { severity: ["critical", "high"], lifecycle: ["persistent"], decision: "review" },
    {
      severity: ["medium", "low", "info", "unknown"],
      lifecycle: ["new", "reopened", "persistent"],
      decision: "review",
    },
  ]);
});

test("block-critical leaves high as review", () => {
  const policy = policyForPreset("block-critical", ["main", "release/**"]);
  assert.deepEqual(policy.protectedBranches, ["main", "release/**"]);
  assert.deepEqual(policy.rules, [
    { severity: ["critical"], lifecycle: ["new", "reopened"], decision: "block" },
    { severity: ["critical"], lifecycle: ["persistent"], decision: "review" },
    {
      severity: ["high", "medium", "low", "info", "unknown"],
      lifecycle: ["new", "reopened", "persistent"],
      decision: "review",
    },
  ]);
});

test("warn-only never blocks", () => {
  const policy = policyForPreset("warn-only", ["main"]);
  assert.ok(policy.rules.length > 0);
  assert.ok(policy.rules.every((rule) => rule.decision === "review"));
});

test("every preset is a policy the parser accepts", () => {
  for (const preset of GUARDRAIL_POLICY_PRESETS) {
    if (preset === "custom") continue;
    assert.doesNotThrow(() => parseGuardrailPolicy(policyForPreset(preset, ["main"])));
  }
});

test("custom is not a shape anything can build", () => {
  assert.throws(
    () => policyForPreset("custom", ["main"]),
    /guardrail_policy_preset_custom/,
  );
});

test("recognises a hand-edited policy as custom", () => {
  const policy = policyForPreset("block-critical-high", ["main"]);
  policy.rules[0]!.severity = ["critical"];
  assert.equal(presetForPolicy(policy), "custom");
});

test("the untouched product default reads as the named default preset", () => {
  // A repository nobody has configured must not open labelled "Personalizado".
  // The product default's three rules are the shape every repository starts with,
  // so they are recognised as `block-critical-high` by name.
  assert.equal(presetForPolicy(defaultGuardrailPolicy()), DEFAULT_GUARDRAIL_POLICY_PRESET);
  assert.equal(DEFAULT_GUARDRAIL_POLICY_PRESET, "block-critical-high");
});

test("the product default is still the shape the preset detector recognises", () => {
  // `@csb/shared` keeps its own copy of these rules because the browser cannot import
  // gate-core. If the product default ever changes, this is where it is noticed.
  assert.deepEqual(defaultGuardrailPolicy().rules, [
    { severity: ["critical"], lifecycle: ["new", "reopened"], decision: "block" },
    { severity: ["high"], lifecycle: ["new", "reopened"], decision: "block" },
    { severity: ["high"], lifecycle: ["persistent"], decision: "review" },
  ]);
});

test("round-trips every preset", () => {
  for (const preset of GUARDRAIL_POLICY_PRESETS) {
    if (preset === "custom") continue;
    assert.equal(presetForPolicy(policyForPreset(preset, ["main"])), preset);
    // The branch list is the operator's, never the preset's: changing it must not
    // turn a preset into `custom`.
    assert.equal(presetForPolicy(policyForPreset(preset, ["trunk", "release/**"])), preset);
  }
});

test("the scan envelope and scope of a preset are the product default", () => {
  const preset = policyForPreset("warn-only", ["main"]);
  const fallback = defaultGuardrailPolicy();
  assert.deepEqual(preset.scan, fallback.scan);
  assert.deepEqual(preset.scope, fallback.scope);
});

test("a preset only decides the rules, so a changed scan envelope stays the preset", () => {
  const policy = policyForPreset("block-critical", ["main"]);
  policy.scan.maxCostUsd = 3;
  assert.equal(presetForPolicy(policy), "block-critical");
});
