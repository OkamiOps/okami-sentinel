import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubAction } from "@csb/shared";

import {
  callerWorkflowChecklist,
  draftFromAction,
  initialGitHubActionDraft,
  validateGitHubActionDraft,
  type GitHubActionDraft,
} from "./github-action-form.js";

const REPOSITORY = "github:1185738028";

function draft(overrides: Partial<GitHubActionDraft> = {}): GitHubActionDraft {
  return {
    ...initialGitHubActionDraft(REPOSITORY),
    name: "PR deep",
    branchPatterns: "main",
    connectionId: "provider-connection",
    costCeilingUsd: "2.50",
    ...overrides,
  };
}

function action(overrides: Partial<GitHubAction> = {}): GitHubAction {
  return {
    id: "a1",
    repositoryKey: REPOSITORY,
    name: "PR deep",
    triggerKind: "pull_request",
    branchPatterns: ["main", "release/**"],
    executor: "sentinel-managed",
    connectionId: "github-connection",
    installationId: "77",
    repositoryId: "9001",
    scanner: {
      engine: "codex-security",
      connection: { connectionId: "provider-connection", modelSelectionMode: "catalog", modelId: "gpt-5" },
      effort: "high",
      mode: "deep",
    },
    costCeilingUsd: 2.5,
    dailyCostCeilingUsd: 6,
    enabled: true,
    includeForks: false,
    revision: 1,
    baselineInitializedAt: null,
    createdBy: "u-root",
    lastEventAt: null,
    lastReconciledAt: null,
    lastError: null,
    migrationNote: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

test("requires a name, a pattern and a positive ceiling", () => {
  const result = validateGitHubActionDraft(
    draft({ name: "  ", branchPatterns: " , ", costCeilingUsd: "" }),
    { isAdmin: true },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok === false ? result.errors : [], [
    { field: "name", code: "required" },
    { field: "branchPatterns", code: "required" },
    { field: "costCeilingUsd", code: "required" },
  ]);
});

test("splits comma-separated patterns and trims them", () => {
  const result = validateGitHubActionDraft(
    draft({ branchPatterns: "main, release/** \n  feature/*  ,main" }),
    { isAdmin: true },
  );
  assert.equal(result.ok, true);
  // Duplicates collapse: the API refuses a repeated pattern, and asking the
  // operator to spot their own repetition in a comma list is not a refusal worth
  // a round trip.
  assert.deepEqual(result.ok ? result.body.branchPatterns : [], ["main", "release/**", "feature/*"]);
});

test("refuses more than twenty patterns and an invalid pattern", () => {
  const tooMany = validateGitHubActionDraft(
    draft({ branchPatterns: Array.from({ length: 21 }, (_, index) => `b${index}`).join(",") }),
    { isAdmin: true },
  );
  assert.deepEqual(tooMany.ok === false ? tooMany.errors : [], [{ field: "branchPatterns", code: "too_many" }]);

  for (const pattern of ["main..old", "trailing/", "trailing.", "-leading", "a*b*c*d*e*f", "x".repeat(256)]) {
    const result = validateGitHubActionDraft(draft({ branchPatterns: pattern }), { isAdmin: true });
    assert.deepEqual(
      result.ok === false ? result.errors : [],
      [{ field: "branchPatterns", code: "invalid" }],
      `"${pattern}" was accepted`,
    );
  }
  // Four wildcards is the matcher's bound, so it is accepted; five is not.
  assert.equal(validateGitHubActionDraft(draft({ branchPatterns: "a*b*c*d*e" }), { isAdmin: true }).ok, true);
});

test("refuses a daily ceiling below the per-scan ceiling", () => {
  const below = validateGitHubActionDraft(
    draft({ costCeilingUsd: "5", dailyCostCeilingUsd: "2" }),
    { isAdmin: true },
  );
  assert.deepEqual(below.ok === false ? below.errors : [], [
    { field: "dailyCostCeilingUsd", code: "below_per_scan" },
  ]);
  const negative = validateGitHubActionDraft(
    draft({ dailyCostCeilingUsd: "0" }),
    { isAdmin: true },
  );
  assert.deepEqual(negative.ok === false ? negative.errors : [], [
    { field: "dailyCostCeilingUsd", code: "not_positive" },
  ]);
  // Empty is "no day budget", which the API stores as null.
  const empty = validateGitHubActionDraft(draft({ dailyCostCeilingUsd: "  " }), { isAdmin: true });
  assert.equal(empty.ok ? empty.body.dailyCostCeilingUsd : "set", null);
});

test("requires a connection for the sentinel-managed executor", () => {
  const missing = validateGitHubActionDraft(
    draft({ connectionId: null }),
    { isAdmin: true },
  );
  assert.deepEqual(missing.ok === false ? missing.errors : [], [{ field: "connectionId", code: "required" }]);
  // The GitHub Actions executor spends the customer's minutes, not a Sentinel
  // provider connection, so it needs none — and sends no scanner at all.
  const actions = validateGitHubActionDraft(
    draft({ executor: "github-actions", connectionId: null }),
    { isAdmin: true },
  );
  assert.equal(actions.ok, true);
  assert.equal(actions.ok ? actions.body.scanner : "set", null);
});

test("refuses enabled: true for a non-administrator", () => {
  const result = validateGitHubActionDraft(draft({ enabled: true }), { isAdmin: false });
  assert.deepEqual(result.ok === false ? result.errors : [], [{ field: "enabled", code: "admin_only" }]);
  // The same draft left off is a maintainer's to save.
  assert.equal(validateGitHubActionDraft(draft({ enabled: false }), { isAdmin: false }).ok, true);
  assert.equal(validateGitHubActionDraft(draft({ enabled: true }), { isAdmin: true }).ok, true);
});

test("round-trips an action through draftFromAction and validate", () => {
  const original = action();
  const result = validateGitHubActionDraft(draftFromAction(original), { isAdmin: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.body : null, {
    repositoryKey: REPOSITORY,
    name: "PR deep",
    triggerKind: "pull_request",
    branchPatterns: ["main", "release/**"],
    executor: "sentinel-managed",
    scanner: {
      engine: "codex-security",
      connection: { connectionId: "provider-connection", modelSelectionMode: "catalog", modelId: "gpt-5" },
      effort: "high",
      mode: "deep",
    },
    costCeilingUsd: 2.5,
    dailyCostCeilingUsd: 6,
    enabled: true,
    includeForks: false,
  });
});

/**
 * `null` in the draft is the provider's own default, which the API expresses as
 * `modelSelectionMode: "runtime-default"` and a `null` model. Sending
 * `{ modelSelectionMode: "catalog", modelId: null }` is a 400.
 */
test("a model left unset asks the provider for its default", () => {
  const result = validateGitHubActionDraft(draft({ model: null, effort: null }), { isAdmin: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.body.scanner : null, {
    engine: "codex-security",
    connection: { connectionId: "provider-connection", modelSelectionMode: "runtime-default", modelId: null },
    mode: "standard",
  });
});

test("an action created with no day budget carries none back into the form", () => {
  const drafted = draftFromAction(action({ dailyCostCeilingUsd: null, scanner: null, executor: "github-actions" }));
  assert.equal(drafted.dailyCostCeilingUsd, "");
  assert.equal(drafted.connectionId, null);
  assert.equal(drafted.executor, "github-actions");
  assert.equal(drafted.includeForks, false);
});

test("a fresh draft is disabled, Sentinel-run and free of a ceiling nobody chose", () => {
  const fresh = initialGitHubActionDraft(REPOSITORY);
  assert.equal(fresh.repositoryKey, REPOSITORY);
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.executor, "sentinel-managed");
  assert.equal(fresh.triggerKind, "pull_request");
  // No invented ceiling: a number the operator did not choose would be spent.
  assert.equal(fresh.costCeilingUsd, "");
  assert.equal(fresh.dailyCostCeilingUsd, "");
  assert.equal(fresh.includeForks, false);
});

test("reports the three Actions prerequisites", () => {
  assert.deepEqual(
    callerWorkflowChecklist({
      ready: true,
      code: "ready",
      workflowPath: ".github/workflows/csb-security-change-gate.yml",
      releaseSha: "f".repeat(40),
      triggers: { push: false, pullRequest: false, merge: false },
    }),
    [
      { id: "workflow_installed", ok: true },
      { id: "triggers_removed", ok: true },
      // Sentinel has no grant to read repository secrets and asks for none, so this
      // is the prerequisite it names and never claims to have checked.
      { id: "secret_present", ok: false },
    ],
  );

  // A caller that still fires on its own is installed and not usable.
  assert.deepEqual(
    callerWorkflowChecklist({
      ready: true,
      code: "ready",
      workflowPath: ".github/workflows/csb-security-change-gate.yml",
      releaseSha: "f".repeat(40),
      triggers: { push: false, pullRequest: true, merge: true },
    }).map((item) => item.ok),
    [true, false, false],
  );

  // The file is there and current; GitHub merely disabled the workflow.
  assert.deepEqual(
    callerWorkflowChecklist({
      ready: false,
      code: "caller_workflow_inactive",
      workflowPath: ".github/workflows/csb-security-change-gate.yml",
      releaseSha: "f".repeat(40),
      triggers: null,
    }).map((item) => item.ok),
    [true, false, false],
  );

  // Nothing installed at all.
  assert.deepEqual(
    callerWorkflowChecklist({
      ready: false,
      code: "caller_workflow_missing",
      workflowPath: ".github/workflows/csb-security-change-gate.yml",
      releaseSha: "f".repeat(40),
      triggers: null,
    }).map((item) => item.ok),
    [false, false, false],
  );
});

test("requires no model connection for the github-actions executor", () => {
  const draft = {
    ...initialGitHubActionDraft("github:1"),
    name: "Actions PR",
    branchPatterns: "main",
    executor: "github-actions" as const,
    connectionId: null,
    costCeilingUsd: "2",
  };
  const result = validateGitHubActionDraft(draft, { isAdmin: true });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.body.executor, "github-actions");
    // The customer's minutes carry no Sentinel scanner selection at all.
    assert.equal(result.body.scanner, null);
  }

  // The Sentinel executor still demands one.
  const managed = validateGitHubActionDraft({ ...draft, executor: "sentinel-managed" }, { isAdmin: true });
  assert.equal(managed.ok, false);
  if (!managed.ok) {
    assert.deepEqual(managed.errors, [{ field: "connectionId", code: "required" }]);
  }
});
