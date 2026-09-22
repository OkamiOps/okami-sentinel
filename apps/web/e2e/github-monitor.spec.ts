import { expect, test } from "@playwright/test";
import type { GitHubMonitorOverview, GuardrailRepository } from "@csb/shared";

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
