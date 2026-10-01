import assert from "node:assert/strict";
import test from "node:test";

import {
  guardrailPolicyPresetRules,
  type GuardrailBaseline,
  type GuardrailPolicy,
} from "@csb/shared";

import { translate, supportedLocales } from "../i18n";
import {
  baselineLabelKey,
  baselineToneOf,
  enrollmentSelectionState,
  policySourceLabelKey,
  selectedPresetFromPolicy,
} from "./guardrail-repository-page";

function baseline(overrides: Partial<GuardrailBaseline> = {}): GuardrailBaseline {
  return {
    repositoryKey: "github:1",
    state: "absent",
    gateId: null,
    commitSha: null,
    protectedBranch: null,
    scanLineageHash: null,
    builtAt: null,
    staleReason: null,
    requestedAt: null,
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

function policy(rules: GuardrailPolicy["rules"]): GuardrailPolicy {
  return {
    schemaVersion: 1,
    protectedBranches: ["main"],
    scope: { mode: "changed", maxChangedPaths: 50, fallback: "repository" },
    scan: { model: "gpt-5.6-sol", effort: "low", mode: "standard", maxCostUsd: 18 },
    rules,
  };
}

test("names every baseline state", () => {
  const keys = (["absent", "building", "ready", "stale"] as const)
    .map((state) => baselineLabelKey(baseline({ state })));
  assert.equal(new Set(keys).size, 4);
  for (const key of keys) {
    for (const locale of supportedLocales) {
      assert.notEqual(translate(locale, key), "", `${locale}.${key}`);
    }
  }
});

test("names a stale baseline with its reason", () => {
  assert.equal(
    baselineLabelKey(baseline({ state: "stale", staleReason: "scan_lineage" })),
    "guardrails.baseline.stale.scan_lineage",
  );
  assert.equal(
    baselineLabelKey(baseline({ state: "stale", staleReason: "protected_branch" })),
    "guardrails.baseline.stale.protected_branch",
  );
});

test("a stale baseline with a reason nobody translated still reads as stale", () => {
  // The projection stores whatever the gate reported, and a future reason must not
  // print a raw key at the operator.
  assert.equal(
    baselineLabelKey(baseline({ state: "stale", staleReason: "something_new" })),
    "guardrails.baseline.stale",
  );
  assert.equal(baselineLabelKey(baseline({ state: "stale", staleReason: null })), "guardrails.baseline.stale");
});

test("a ready baseline reads as good and the other three do not", () => {
  assert.equal(baselineToneOf(baseline({ state: "ready" })), "good");
  assert.equal(baselineToneOf(baseline({ state: "building" })), "active");
  assert.equal(baselineToneOf(baseline({ state: "stale" })), "warning");
  // Absent is the normal state of a repository enrolled a minute ago: it is not a
  // fault, and painting it red would teach the operator to ignore red.
  assert.equal(baselineToneOf(baseline({ state: "absent" })), "neutral");
});

test("says the repository file controls the policy", () => {
  const key = policySourceLabelKey("repository_file", null);
  assert.equal(key, "guardrails.policySource.repository_file");
  for (const locale of supportedLocales) assert.notEqual(translate(locale, key), "");
});

test("says the repository file is invalid and the Sentinel policy is in use", () => {
  // The reason outranks the level: an operator who sees "Sentinel" without being
  // told the file was refused would go looking for a bug in the editor.
  assert.equal(
    policySourceLabelKey("sentinel", "policy_invalid"),
    "guardrails.policySource.fileInvalid",
  );
  assert.equal(
    policySourceLabelKey("default", "policy_invalid"),
    "guardrails.policySource.fileInvalid",
  );
});

test("names the three levels and the local workspace apart", () => {
  const keys = (["repository_file", "sentinel", "default", "workspace"] as const)
    .map((source) => policySourceLabelKey(source, null));
  assert.equal(new Set(keys).size, 4);
  for (const key of keys) {
    for (const locale of supportedLocales) assert.notEqual(translate(locale, key), "");
  }
});

test("recognises the preset a policy stands for, and a hand-edited one as custom", () => {
  assert.equal(selectedPresetFromPolicy(policy(guardrailPolicyPresetRules("warn-only"))), "warn-only");
  assert.equal(
    selectedPresetFromPolicy(policy(guardrailPolicyPresetRules("block-critical-high"))),
    "block-critical-high",
  );
  assert.equal(
    selectedPresetFromPolicy(policy([{ severity: ["low"], lifecycle: ["new"], decision: "block" }])),
    "custom",
  );
});

test("keeps already-enrolled candidates selectable-but-disabled in the multi-select", () => {
  const state = enrollmentSelectionState(
    [
      { repositoryId: "1", owner: "OkamiOps", name: "alpha", archived: false },
      { repositoryId: "2", owner: "OkamiOps", name: "beta", archived: false },
      { repositoryId: "3", owner: "OkamiOps", name: "gamma", archived: true },
    ],
    new Set(["1"]),
    new Set(["2"]),
  );
  assert.deepEqual(state.rows, [
    { repositoryId: "1", label: "OkamiOps/alpha", selected: false, disabled: true, reason: "already_enrolled" },
    { repositoryId: "2", label: "OkamiOps/beta", selected: true, disabled: false, reason: null },
    { repositoryId: "3", label: "OkamiOps/gamma", selected: false, disabled: true, reason: "archived" },
  ]);
  assert.deepEqual(state.selectableIds, ["2"]);
  assert.deepEqual(state.selectedIds, ["2"]);
  assert.equal(state.canSubmit, true);
});

test("a selection of nothing cannot be submitted", () => {
  const state = enrollmentSelectionState(
    [{ repositoryId: "1", owner: "OkamiOps", name: "alpha", archived: false }],
    new Set<string>(),
    new Set<string>(),
  );
  assert.equal(state.canSubmit, false);
  assert.deepEqual(state.selectedIds, []);
});

test("a selected repository that became unselectable is not submitted", () => {
  // The register is re-read while the sheet is open, so a repository somebody else
  // enrolled meanwhile must drop out of the batch rather than be sent and skipped.
  const state = enrollmentSelectionState(
    [{ repositoryId: "1", owner: "OkamiOps", name: "alpha", archived: false }],
    new Set(["1"]),
    new Set(["1"]),
  );
  assert.deepEqual(state.selectedIds, []);
  assert.equal(state.canSubmit, false);
  assert.equal(state.rows[0]?.selected, false);
});

test("the batch bound is reported rather than silently truncating the selection", () => {
  const candidates = Array.from({ length: 51 }, (_, index) => ({
    repositoryId: String(index + 1),
    owner: "OkamiOps",
    name: `repo-${index + 1}`,
    archived: false,
  }));
  const state = enrollmentSelectionState(
    candidates,
    new Set<string>(),
    new Set(candidates.map((candidate) => candidate.repositoryId)),
  );
  assert.equal(state.selectedIds.length, 51);
  assert.equal(state.overBound, true);
  assert.equal(state.canSubmit, false);
});
