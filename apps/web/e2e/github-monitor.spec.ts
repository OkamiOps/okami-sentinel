import { expect, test, type Page } from "@playwright/test";
import type { GitHubMonitorOverview, GitHubMonitorRule, GuardrailRepository } from "@csb/shared";

import { mockApi } from "./fixtures";

const repository = {
  repositoryKey: "github.com/acme/sentinel",
  repositoryPath: null,
  source: "github",
  displayName: "Sentinel",
  defaultBranch: "main",
  defaultExecutor: "sentinel-managed",
  remoteOwner: "acme",
  remoteName: "sentinel",
  githubConnectionId: "github-connection",
  githubInstallationId: "123",
  githubRepositoryId: "456",
  enabled: true,
  policyPath: ".sentinel/policy.json",
  lastGateId: null,
  githubStatus: "ready",
} satisfies GuardrailRepository;

function overview(): GitHubMonitorOverview {
  return {
    rules: [],
    events: [],
    actionsRuns: [],
    summary: {
      enabledRules: 0,
      queuedEvents: 0,
      dispatchingEvents: 0,
      lastPolledAt: null,
      lastError: null,
      checkoutAvailable: false,
      recentActionsWindowDays: 14,
    },
  };
}

test("manual GitHub monitor sync names and sends only the selected repository", async ({ page }) => {
  await mockApi(page);
  const polls: Array<{ body: unknown; csrf: string | undefined }> = [];

  await page.route("**/api/guardrails/repositories", (route) => route.fulfill({ json: { repositories: [repository] } }));
  await page.route("**/api/github-monitor/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/overview")) return route.fulfill({ json: { overview: overview() } });
    if (path.endsWith("/branches")) return route.fulfill({ json: { branches: ["main"] } });
    if (path.endsWith("/poll")) {
      polls.push({ body: request.postDataJSON(), csrf: request.headers()["x-csrf-token"] });
      return route.fulfill({ json: { overview: overview() } });
    }
    throw new Error(`Unexpected GitHub monitor request: ${request.method()} ${path}`);
  });

  await page.goto("/github");
  const sync = page.getByRole("button", { name: "SYNC NOW acme/sentinel", exact: true });
  await expect(sync).toBeEnabled();
  await sync.click();

  await expect.poll(() => polls).toEqual([{ body: { repositoryKey: repository.repositoryKey }, csrf: "fixture-token" }]);
  await expect(sync).toBeVisible();
});

/**
 * The role table gives the rule to a repository maintainer, while enrolling a
 * repository and wiring the GitHub App stay administrator-only.
 */
const enrolled = { ...repository, repositoryKey: "github:1" } satisfies GuardrailRepository;

const sentinelRule: GitHubMonitorRule = {
  id: "rule-sentinel", repositoryKey: enrolled.repositoryKey,
  connectionId: "github-connection", installationId: "123", repositoryId: "456",
  executor: "sentinel-managed",
  scanner: {
    engine: "codex-security", mode: "standard",
    connection: { connectionId: "provider-connection", modelSelectionMode: "runtime-default", modelId: null },
  },
  costCeilingUsd: 2, dailyCostCeilingUsd: 2, followBranches: ["main"], checkoutMode: "none",
  enabled: true, revision: 1, baselineInitializedAt: null, lastPolledAt: null, lastError: null,
  createdAt: "2026-09-29T10:00:00.000Z", updatedAt: "2026-09-29T10:00:00.000Z",
};

async function openMonitorAs(page: Page, role: "viewer" | "maintainer", rules: GitHubMonitorRule[] = []): Promise<void> {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [{ repositoryKey: enrolled.repositoryKey, role }] } });
  await page.route("**/api/guardrails/repositories", (route) => route.fulfill({ json: { repositories: [enrolled] } }));
  await page.route("**/api/github-monitor/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/branches")) return route.fulfill({ json: { branches: ["main"] } });
    const current = overview();
    return route.fulfill({ json: { overview: { ...current, rules, summary: { ...current.summary, enabledRules: rules.filter((rule) => rule.enabled).length } } } });
  });
  await page.goto("/github");
  // The automation panel is rendered for every role; only its controls are gated.
  await expect(page.getByText("Saving a rule never starts a scan.", { exact: false })).toBeVisible();
}

test("a repository maintainer gets the monitor rule controls", async ({ page }) => {
  await openMonitorAs(page, "maintainer");
  await expect(page.getByRole("button", { name: "FOLLOW REPOSITORY", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "ENABLE AUTOMATION", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "REGISTER REPOSITORY", exact: true })).toHaveCount(0);
});

test("a repository viewer gets none of the monitor rule controls", async ({ page }) => {
  await openMonitorAs(page, "viewer");
  await expect(page.getByRole("button", { name: "FOLLOW REPOSITORY", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "ENABLE AUTOMATION", exact: true })).toHaveCount(0);
});

test("a maintainer is not offered the Sentinel-managed executor", async ({ page }) => {
  await openMonitorAs(page, "maintainer");
  await expect(page.getByRole("radio", { name: /SENTINEL MANAGED/ })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /GITHUB ACTIONS/ })).toBeVisible();
  await expect(page.getByText("Only administrators can use Sentinel-managed execution", { exact: false })).toBeVisible();
  // The connection and model pickers belong to a Sentinel-run scan.
  await expect(page.getByRole("combobox", { name: "Model connection" })).toHaveCount(0);
});

test("an administrator keeps the Sentinel-managed executor", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.route("**/api/guardrails/repositories", (route) => route.fulfill({ json: { repositories: [enrolled] } }));
  await page.route("**/api/github-monitor/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/branches")) return route.fulfill({ json: { branches: ["main"] } });
    return route.fulfill({ json: { overview: overview() } });
  });
  await page.goto("/github");
  await expect(page.getByRole("radio", { name: /SENTINEL MANAGED/ })).toBeVisible();
  await expect(page.getByText("Only administrators can use Sentinel-managed execution", { exact: false })).toHaveCount(0);
});

test("a maintainer can switch off a Sentinel-managed rule but never back on", async ({ page }) => {
  await openMonitorAs(page, "maintainer", [sentinelRule]);
  const patches: unknown[] = [];
  // Registered after the catch-all above, so it wins for this one path.
  await page.route("**/api/github-monitor/rules/*", (route) => {
    patches.push(route.request().postDataJSON());
    return route.fulfill({ json: { rule: { ...sentinelRule, enabled: false } } });
  });

  // Stopping the spending is the one edit a member owns on such a rule.
  await expect(page.getByRole("button", { name: "SAVE CHANGES", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "ENABLE AUTOMATION", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "DISABLE AUTOMATION", exact: true }).click();

  // The server only exempts the switch itself, so the body must carry nothing
  // else: no ceilings, no branches, no scanner.
  await expect.poll(() => patches).toEqual([{ enabled: false }]);
});

test("a maintainer cannot switch a Sentinel-managed rule back on once it is off", async ({ page }) => {
  await openMonitorAs(page, "maintainer", [{ ...sentinelRule, enabled: false }]);
  for (const name of ["ENABLE AUTOMATION", "FOLLOW REPOSITORY", "DISABLE AUTOMATION"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
});
