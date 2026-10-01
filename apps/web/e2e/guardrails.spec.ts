import { expect, test, type Page } from "@playwright/test";
import type {
  GateRun,
  GuardrailBaseline,
  GuardrailEnrollmentSkip,
  GuardrailPolicy,
  GuardrailRepositoryListRow,
} from "@csb/shared";
import { guardrailPolicyPresetRules } from "@csb/shared";

import { translate } from "../src/i18n";
import { accessMessages } from "../src/i18n/access";
import { githubRepository, githubSecondRepository, guardrailRow } from "./fixtures";
import { baselineOf, bootstrapArtifact, gateOf, mockGuardrails, policyOf, prCommentOf, SHA } from "./guardrails-mock";

const pt = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("pt-BR", key, values);

test("the repository list names the baseline, the action count and the policy level", async ({ page }) => {
  await mockGuardrails(page, {
    repositories: [
      { ...githubRepository, baseline: baselineOf({ state: "ready", commitSha: SHA, protectedBranch: "main", builtAt: "2026-10-01T09:00:00.000Z" }), enabledActionCount: 2, lastGate: { gateId: "gate-1", outcome: "pass", completedAt: "2026-10-01T09:05:00.000Z" }, policySource: "repository_file" },
      { ...githubSecondRepository, baseline: baselineOf({ repositoryKey: "github:2", state: "stale", staleReason: "scan_lineage", commitSha: SHA }) },
    ],
  });
  await page.goto("/guardrails");

  const list = page.getByRole("region", { name: pt("guardrails.repositoriesTitle") });
  await expect(list.getByText(pt("guardrails.baseline.ready"), { exact: true })).toBeVisible();
  // The list prints the word and the reason apart, so the chip cannot say
  // "stale" twice on one line.
  await expect(list.getByText(pt("guardrails.baseline.stale"), { exact: true })).toBeVisible();
  await expect(list.getByText(pt("guardrails.baselineReason.scan_lineage"), { exact: true })).toBeVisible();
  await expect(list.getByText(pt("guardrails.policySource.repository_file"), { exact: true })).toBeVisible();
  await expect(list.getByText("2", { exact: true }).first()).toBeVisible();
});

test("an absent baseline is reported without being painted as a failure", async ({ page }) => {
  await mockGuardrails(page, { repositories: [githubRepository] });
  await page.goto("/guardrails");
  const list = page.getByRole("region", { name: pt("guardrails.repositoriesTitle") });
  await expect(list.getByText(pt("guardrails.baseline.absent"), { exact: true })).toBeVisible();
});

test("enrols three repositories at once and shows the partial result", async ({ page }) => {
  const added = ["9003", "9004", "9005"].map((id, index) => guardrailRow({
    ...githubRepository,
    repositoryKey: `github:${id}`,
    displayName: `okamiops/atlas-${["web", "api", "cli"][index]}`,
    githubRepositoryId: id,
  }));
  const mock = await mockGuardrails(page, {
    repositories: [githubRepository],
    enrollResponse: {
      enrolled: added,
      skipped: [{ repositoryId: "9001", reason: "already_enrolled" }],
    },
  });
  await page.goto("/guardrails");
  await page.getByRole("button", { name: pt("guardrails.addRepositories") }).click();

  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: "GitHub App" }).click();
  // The authority chain, in the order the screen asks for it.
  await sheet.getByRole("combobox", { name: pt("guardrails.connection") }).click();
  await page.getByRole("option", { name: "okami-sentinel" }).click();
  await sheet.getByRole("combobox", { name: pt("guardrails.installation") }).click();
  await page.getByRole("option", { name: "okamiops" }).click();

  // The repository already in the register is visible and cannot be chosen.
  const enrolled = sheet.getByRole("checkbox", { name: "okamiops/luna-core" });
  await expect(enrolled).toBeDisabled();

  await sheet.getByRole("button", { name: pt("guardrails.enrollSelectAll") }).click();
  await sheet.getByRole("button", { name: pt("guardrails.enrollSubmit") }).click();

  await expect(sheet.getByText(pt("guardrails.enrollResult", { enrolled: 3, skipped: 1 }))).toBeVisible();
  await expect(sheet.getByText(pt("guardrails.enrollSkip.already_enrolled"), { exact: false }).first()).toBeVisible();
  const body = mock.guardrails.enrolments[0] as { repositoryIds: string[] };
  expect(body.repositoryIds.sort()).toEqual(["9003", "9004", "9005"]);
});

test("removes a repository after confirming what it deletes", async ({ page }) => {
  const mock = await mockGuardrails(page, { repositories: [githubRepository] });
  await page.goto("/guardrails");
  const list = page.getByRole("region", { name: pt("guardrails.repositoriesTitle") });
  await list.getByRole("button", { name: pt("guardrails.removeRepository") }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(pt("guardrails.removeRepositoryConfirm"))).toBeVisible();
  await dialog.getByRole("button", { name: accessMessages["pt-BR"]["users.confirm"] }).click();

  // The empty state first: the request is in flight when the click returns.
  await expect(list.getByText(pt("guardrails.repositoriesEmpty"))).toBeVisible();
  expect(mock.guardrails.deletes).toEqual(["github:1"]);
});

test("a repository with a running gate is not removed, and the screen says why", async ({ page }) => {
  await mockGuardrails(page, { repositories: [githubRepository], deleteConflict: true });
  await page.goto("/guardrails");
  const list = page.getByRole("region", { name: pt("guardrails.repositoriesTitle") });
  await list.getByRole("button", { name: pt("guardrails.removeRepository") }).click();
  await page.getByRole("dialog").getByRole("button", { name: accessMessages["pt-BR"]["users.confirm"] }).click();
  await expect(page.getByText(pt("guardrails.removeRepositoryBusy"))).toBeVisible();
});

test("saves a policy with a preset and simulates it", async ({ page }) => {
  const mock = await mockGuardrails(page, {
    repositories: [githubRepository],
    gates: [gateOf()],
  });
  await page.goto("/guardrails/repositories/github%3A1");

  await page.getByRole("radio", { name: pt("guardrails.preset.warn-only") }).click();
  await page.getByRole("button", { name: pt("guardrails.savePolicy") }).click();
  await expect(page.getByText(pt("guardrails.policySaved"))).toBeVisible();
  const written = mock.guardrails.policyWrites[0] as { policy: GuardrailPolicy };
  expect(written.policy.rules.every((rule) => rule.decision === "review")).toBe(true);

  await page.getByRole("button", { name: pt("guardrails.simulatePolicy") }).click();
  await expect(page.getByText("1 finding would ask for review.")).toBeVisible();
});

test("shows the repository file banner and refuses to edit", async ({ page }) => {
  await mockGuardrails(page, {
    repositories: [githubRepository],
    policyResponse: {
      policy: policyOf("block-critical"),
      policySource: "repository_file",
      policySha: SHA,
      readOnly: true,
      preset: "block-critical",
      fileInvalidReason: null,
      sentinel: null,
    },
  });
  await page.goto("/guardrails/repositories/github%3A1");

  await expect(page.getByText(pt("guardrails.policyFileBanner"))).toBeVisible();
  await expect(page.getByRole("button", { name: pt("guardrails.savePolicy") })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: pt("guardrails.preset.warn-only") })).toBeDisabled();
  await expect(page.getByLabel(pt("guardrails.protectedBranches"))).toBeDisabled();
  // The rules table too: a control that cannot be saved must not invite an edit.
  await expect(page.getByRole("button", { name: pt("guardrails.addRule") })).toBeDisabled();
});

test("an invalid repository file says the Sentinel policy is the one in force", async ({ page }) => {
  await mockGuardrails(page, {
    repositories: [githubRepository],
    policyResponse: {
      policy: policyOf("block-critical-high"),
      policySource: "sentinel",
      policySha: SHA,
      readOnly: false,
      preset: "block-critical-high",
      fileInvalidReason: "policy_invalid",
      sentinel: { preset: "block-critical-high", updatedAt: "2026-10-01T08:00:00.000Z", updatedBy: "marcos" },
    },
  });
  await page.goto("/guardrails/repositories/github%3A1");
  await expect(page.getByText(pt("guardrails.policyFileInvalid"))).toBeVisible();
  // The editor is writable: the file is broken, not in charge.
  await expect(page.getByRole("radio", { name: pt("guardrails.preset.warn-only") })).toBeEnabled();
});

test("builds the baseline now and shows it building", async ({ page }) => {
  const mock = await mockGuardrails(page, { repositories: [githubRepository] });
  await page.goto("/guardrails/repositories/github%3A1");

  const card = page.getByRole("region", { name: pt("guardrails.baselineSectionTitle") });
  await expect(card.getByText(pt("guardrails.baseline.absent"), { exact: true })).toBeVisible();
  await card.getByRole("button", { name: pt("guardrails.baselineBuildNow") }).click();
  await expect(card.getByText(pt("guardrails.baseline.building"), { exact: true })).toBeVisible();
  expect(mock.guardrails.baselineBuilds).toBe(1);
});

test("a baseline already building offers no second press", async ({ page }) => {
  // The route refuses the second press with a 409. A button that can only fail is
  // worse than no button, so it goes inert and the panel says why.
  const mock = await mockGuardrails(page, {
    repositories: [githubRepository],
    baseline: baselineOf({ state: "building", requestedAt: "2026-10-01T12:30:00.000Z" }),
  });
  await page.goto("/guardrails/repositories/github%3A1");

  const card = page.getByRole("region", { name: pt("guardrails.baselineSectionTitle") });
  await expect(card.getByRole("button", { name: pt("guardrails.baselineBuildNow") })).toBeDisabled();
  await expect(card.getByText(pt("guardrails.baselineBuildInFlight"))).toBeVisible();
  expect(mock.guardrails.baselineBuilds).toBe(0);
});

test("a GitHub outage reading the policy costs one block, not the page", async ({ page }) => {
  await mockGuardrails(page, {
    repositories: [githubRepository],
    baseline: baselineOf({ state: "ready", commitSha: SHA, protectedBranch: "main" }),
    policyOutage: true,
  });
  await page.goto("/guardrails/repositories/github%3A1");

  await expect(page.getByText(pt("guardrails.policyUnavailableDescription")).first()).toBeVisible();
  // The three blocks that need no policy are still there, with their facts.
  const card = page.getByRole("region", { name: pt("guardrails.baselineSectionTitle") });
  await expect(card.getByText(pt("guardrails.baseline.ready"), { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: pt("guardrails.prCommentTitle") })).toBeVisible();
  await expect(page.getByRole("region", { name: pt("guardrails.gateHistoryTitle") })).toBeVisible();
});

test("says when no push action would ever build the baseline", async ({ page }) => {
  await mockGuardrails(page, { repositories: [githubRepository], hasProtectedBranchAction: false });
  await page.goto("/guardrails/repositories/github%3A1");
  await expect(page.getByText(pt("guardrails.baselineNoPushAction"))).toBeVisible();
});

test("the old policy address still lands on the repository page", async ({ page }) => {
  await mockGuardrails(page, { repositories: [githubRepository] });
  await page.goto("/guardrails/repositories/github%3A1/policy");
  await expect(page).toHaveURL(/\/guardrails\/repositories\/github%3A1$/);
  await expect(page.getByText(pt("guardrails.repositoryPageDescription"))).toBeVisible();
});

test("shows the no-baseline notice on a bootstrap gate", async ({ page }) => {
  const bootstrapGate = gateOf();
  await mockGuardrails(page, {
    repositories: [githubRepository],
    gates: [bootstrapGate],
    artifact: bootstrapArtifact(),
  });
  await page.goto(`/guardrails/${bootstrapGate.id}`);
  await expect(page.getByText(pt("guardrails.baselineNotice.absent"))).toBeVisible();
});

test("a member sees the repository page in read-only and no administrator controls", async ({ page }) => {
  await mockGuardrails(page, {
    session: { isAdmin: false, grants: [{ repositoryKey: "github:1", role: "viewer" }] },
    repositories: [githubRepository],
  });
  await page.goto("/guardrails/repositories/github%3A1");
  await expect(page.getByRole("button", { name: pt("guardrails.savePolicy") })).toHaveCount(0);
  await expect(page.getByRole("button", { name: pt("guardrails.baselineBuildNow") })).toHaveCount(0);
});

test("opens the pull request and the published comment from the gate page", async ({ page }) => {
  const gate = gateOf({ publishStatus: "published" });
  await mockGuardrails(page, {
    repositories: [githubRepository],
    gates: [gate],
    artifact: bootstrapArtifact(),
    prComments: [prCommentOf()],
  });
  await page.goto(`/guardrails/${gate.id}`);
  await expect(page.getByTestId("open-pull-request")).toHaveAttribute(
    "href",
    "https://github.com/okamiops/luna-core/pull/7",
  );
  await expect(page.getByTestId("open-published-comment")).toHaveAttribute(
    "href",
    "https://github.com/okamiops/luna-core/pull/7#issuecomment-101",
  );
  await expect(page.getByTestId("gate-comment-state")).toHaveText(pt("guardrails.comment.published"));
});

test("republishes a failed comment", async ({ page }) => {
  const gate = gateOf({ publishStatus: "published" });
  const mock = await mockGuardrails(page, {
    repositories: [githubRepository],
    gates: [gate],
    artifact: bootstrapArtifact(),
    prComments: [prCommentOf({ status: "failed", commentId: null, reason: "github_permission_missing" })],
  });
  await page.goto(`/guardrails/${gate.id}`);
  await expect(page.getByTestId("gate-comment-state")).toHaveText(pt("guardrails.comment.failed"));
  await expect(page.getByTestId("open-published-comment")).toHaveCount(0);
  await page.getByTestId("republish-comment").click();
  await expect(page.getByTestId("gate-comment-state")).toHaveText(pt("guardrails.comment.published"));
  await expect(page.getByTestId("open-published-comment")).toBeVisible();
  expect(mock.guardrails.commentRepublishes).toBe(1);
});

test("turns the pull request comment off for a repository", async ({ page }) => {
  const mock = await mockGuardrails(page, { repositories: [githubRepository] });
  await page.goto("/guardrails/repositories/github%3A1");
  await expect(page.getByText(pt("guardrails.prCommentTitle"))).toBeVisible();
  await page.getByRole("button", { name: pt("guardrails.disableRepository"), exact: true }).click();
  await expect.poll(() => mock.guardrails.patches.at(-1)?.body).toEqual({ prCommentEnabled: false });
});

test("writes the comment in the language the repository chose", async ({ page }) => {
  const mock = await mockGuardrails(page, { repositories: [githubRepository] });
  await page.goto("/guardrails/repositories/github%3A1");
  await page.getByRole("combobox", { name: pt("guardrails.prCommentLanguage") }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect.poll(() => mock.guardrails.patches.at(-1)?.body).toEqual({ prCommentLocale: "en" });
});
