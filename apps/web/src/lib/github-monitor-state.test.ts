import assert from "node:assert/strict";
import test from "node:test";

import {
  branchesFromInput,
  initialGitHubMonitorDraft,
  ruleInputFromDraft,
} from "./github-monitor-state.js";

test("normalizes monitored branches without losing their order", () => {
  assert.deepEqual(branchesFromInput("main, release/**\nmain"), ["main", "release/**"]);
});

test("does not activate an automation rule without a real scan route and budget", () => {
  const draft = initialGitHubMonitorDraft("main");
  assert.equal(ruleInputFromDraft("repo-1", draft, true), null);
});

test("serializes an active automatic Codex Security rule with enforced ceilings", () => {
  const input = ruleInputFromDraft("repo-1", {
    ...initialGitHubMonitorDraft("main"),
    providerConnectionId: "provider-1",
    modelId: "model-1",
    costCeilingUsd: "2.50",
    dailyCostCeilingUsd: "12",
    checkoutMode: "none",
  }, true);

  assert.deepEqual(input, {
    repositoryKey: "repo-1",
    executor: "sentinel-managed",
    scanner: {
      engine: "codex-security",
      connection: { connectionId: "provider-1", modelSelectionMode: "catalog", modelId: "model-1" },
      mode: "standard",
    },
    costCeilingUsd: 2.5,
    dailyCostCeilingUsd: 12,
    followBranches: ["main"],
    checkoutMode: "none",
    enabled: true,
  });
});

test("allows following a repository without storing a paid automation route", () => {
  const input = ruleInputFromDraft("repo-1", initialGitHubMonitorDraft("main"), false);
  assert.deepEqual(input, {
    repositoryKey: "repo-1",
    executor: "sentinel-managed",
    scanner: null,
    costCeilingUsd: null,
    dailyCostCeilingUsd: null,
    followBranches: ["main"],
    checkoutMode: "none",
    enabled: false,
  });
});
