import { expect, test, type Page } from "@playwright/test";

import {
  githubAction,
  githubDelivery,
  githubEvent,
  githubRepository,
  githubSecondRepository,
  localRepository,
  mockGitHubTab,
  type GitHubTabOptions,
} from "./fixtures";

/** Every route the previous tab used and the API no longer serves. */
const DELETED_ROUTES = [
  "/github-monitor/overview",
  "/github-monitor/rules",
  "/github-monitor/events",
  "/github-monitor/actions-runs",
  "/github-monitor/poll",
  "/github-monitor/branches",
  "/github-checkouts",
];

async function openTab(page: Page, section: "integration" | "actions" | "activity", options: GitHubTabOptions = {}) {
  const state = await mockGitHubTab(page, options);
  await page.goto(`/github?section=${section}`);
  return state;
}

test("names the permission and the event the App is missing", async ({ page }) => {
  await openTab(page, "integration", { locale: "en", integration: "missing_permissions" });

  // The row is in the warning tone, names the level it actually has, and carries
  // the link that widens the installation.
  const row = page.getByText("workflows", { exact: true }).locator("..");
  await expect(row).toContainText("write");
  await expect(row).toContainText("read");
  await expect(row.getByRole("link", { name: /Review installation/ })).toBeVisible();

  // The checklist stops at the first unmet step and never claims what follows.
  await expect(page.getByRole("listitem").filter({ hasText: "Permissions granted" })).toContainText("pending");
  await expect(page.getByRole("listitem").filter({ hasText: "Delivery verified" })).toContainText("pending");
  // And the last step says it is phase 2's, not that it failed.
  await expect(page.getByRole("listitem").filter({ hasText: "Baseline ready" })).toContainText("arriving in phase 2");
});

test("tells the four installation states apart", async ({ page }) => {
  for (const [scenario, sentence] of [
    ["not_ready", "never finished the manifest exchange"],
    ["installed_nowhere", "installed nowhere"],
    ["suspended", "Every installation is suspended"],
  ] as const) {
    await openTab(page, "integration", { locale: "en", integration: scenario });
    await expect(page.getByText(sentence, { exact: false }).first()).toBeVisible();
    // "unknown" must never be the sentence for any of these.
    await expect(page.getByText("We could not ask GitHub", { exact: false })).toHaveCount(0);
  }
});

test("pastes a webhook secret and shows it as configured", async ({ page }) => {
  const state = await openTab(page, "integration", { locale: "en", integration: "not_configured" });

  await expect(page.getByText("absent", { exact: true }).first()).toBeVisible();
  // Not configured means never verified, and the screen says how to prove it.
  await expect(page.getByText("redeliver the ping", { exact: false })).toBeVisible();

  const field = page.getByLabel("Secret", { exact: true });
  await expect(field).toHaveAttribute("type", "password");
  await field.fill("s".repeat(32));
  await page.getByRole("button", { name: "STORE SECRET" }).click();

  await expect.poll(() => state.github.secretWrites).toEqual([
    { connectionId: "github-connection", secret: "s".repeat(32) },
  ]);
  await expect(page.getByText("Secret stored", { exact: false })).toBeVisible();
  await expect(page.getByText("configured", { exact: true }).first()).toBeVisible();
  // The value is never rendered back anywhere on the page.
  await expect(page.locator("body")).not.toContainText("s".repeat(32));
});

test("warns about a stale delivery without failing the step", async ({ page }) => {
  await openTab(page, "integration", { locale: "en", integration: "stale_delivery" });
  await expect(page.getByText("No recent event for 10 day(s)", { exact: false })).toBeVisible();
  // Ruling N-2: a quiet week is amber, and the step stays met.
  await expect(page.getByRole("listitem").filter({ hasText: "Delivery verified" })).toContainText("ready");
});

test("says so when a reconciliation joins a cycle already in flight", async ({ page }) => {
  const state = await openTab(page, "integration", { locale: "en", reconcileJoined: true });
  await page.getByRole("button", { name: "RECONCILE NOW" }).click();
  await expect(page.getByText("already running and this request joined it", { exact: false })).toBeVisible();
  await expect.poll(() => state.github.reconciles).toBe(1);
});

test("creates two actions on one repository with different events", async ({ page }) => {
  const state = await openTab(page, "actions", {
    locale: "en",
    actions: [],
    repositories: [githubRepository],
  });
  await page.goto(`/github?section=actions&repository=${encodeURIComponent(githubRepository.repositoryKey)}`);

  for (const [name, trigger, patterns] of [
    ["main cheap", "Push", "main"],
    ["release deep", "Pull request", "release/**"],
  ] as const) {
    await page.getByRole("button", { name: "NEW ACTION" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Event", { exact: true }).click();
    await page.getByRole("option", { name: trigger }).click();
    await page.getByLabel("Branch patterns").fill(patterns);
    await page.getByLabel("Model connection").click();
    await page.getByRole("option", { name: /Fixture provider/ }).click();
    await page.getByLabel("Per-scan ceiling / USD").fill("2");
    await page.getByLabel("Day budget / USD").fill("6");
    await page.getByLabel("Enable this action").check();
    await page.getByRole("button", { name: "SAVE", exact: true }).click();
    await expect(page.getByRole("button", { name: "NEW ACTION" })).toBeVisible();
  }

  const posts = state.github.writes.filter((write) => write.method === "POST");
  expect(posts).toHaveLength(2);
  expect(posts.map((write) => (write.body as { name: string; triggerKind: string }))).toEqual([
    expect.objectContaining({ name: "main cheap", triggerKind: "push", enabled: true }),
    expect.objectContaining({ name: "release deep", triggerKind: "pull_request", enabled: true }),
  ]);
  // Both actions live on one repository: the one-rule-per-repository limit is gone.
  await expect(page.getByText("main cheap")).toBeVisible();
  await expect(page.getByText("release deep")).toBeVisible();
});

test("refuses a day budget below the per-scan ceiling before the round trip", async ({ page }) => {
  const state = await openTab(page, "actions", { locale: "en", actions: [], repositories: [githubRepository] });
  await page.goto(`/github?section=actions&repository=${encodeURIComponent(githubRepository.repositoryKey)}`);
  await page.getByRole("button", { name: "NEW ACTION" }).click();
  await page.getByLabel("Name", { exact: true }).fill("main cheap");
  await page.getByLabel("Branch patterns").fill("main");
  await page.getByLabel("Model connection").click();
  await page.getByRole("option", { name: /Fixture provider/ }).click();
  await page.getByLabel("Per-scan ceiling / USD").fill("5");
  await page.getByLabel("Day budget / USD").fill("2");
  await page.getByRole("button", { name: "SAVE", exact: true }).click();
  await expect(page.getByText("cannot be lower than the per-scan ceiling", { exact: false })).toBeVisible();
  expect(state.github.writes).toEqual([]);
});

test("disables an action as a maintainer and cannot enable it", async ({ page }) => {
  const state = await openTab(page, "actions", {
    locale: "en",
    session: { isAdmin: false, grants: [{ repositoryKey: githubRepository.repositoryKey, role: "maintainer" }] },
    repositories: [githubRepository],
    actions: [githubAction({ enabled: true })],
  });

  // A live action is an administrator's to reshape, so a maintainer gets neither
  // the edit button nor the create one.
  await expect(page.getByRole("button", { name: "NEW ACTION" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await page.getByRole("button", { name: "Disable" }).click();
  await expect.poll(() => state.github.writes).toEqual([
    { method: "PATCH", id: "action-pr", body: { enabled: false } },
  ]);

  // Off, it is reshapable — and still not enableable.
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
});

test("gives a viewer the actions in words and no control at all", async ({ page }) => {
  await openTab(page, "actions", {
    locale: "en",
    session: { isAdmin: false, grants: [{ repositoryKey: githubRepository.repositoryKey, role: "viewer" }] },
    repositories: [githubRepository],
    actions: [githubAction({ enabled: true })],
  });
  await expect(page.getByText("PR deep")).toBeVisible();
  for (const name of ["NEW ACTION", "Edit", "Remove", "Disable", "Enable"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByText("nothing here is editable", { exact: false })).toBeVisible();
  // Integration is administrator-only, so the tab is not even offered.
  await expect(page.getByRole("button", { name: /Integration/ })).toHaveCount(0);
});

test("shows a migrated action's note and refuses to enable it until reviewed", async ({ page }) => {
  await openTab(page, "actions", {
    locale: "en",
    repositories: [githubRepository],
    actions: [githubAction({
      enabled: false, branchPatterns: ["*"], migrationNote: "migrated_pattern_missing",
    })],
  });
  await expect(page.getByText("stored \"*\", which nobody chose", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable", exact: true })).toBeDisabled();
  await expect(page.getByText("review patterns")).toBeVisible();
});

test("explains why a local repository cannot be automated", async ({ page }) => {
  await openTab(page, "actions", { locale: "en", repositories: [githubRepository, localRepository], actions: [] });
  await page.goto(`/github?section=actions&repository=${encodeURIComponent(localRepository.repositoryKey)}`);
  await expect(page.getByText("Automation needs remote authority")).toBeVisible();
  await expect(page.getByText("Enrol the repository through the App", { exact: false })).toBeVisible();
  // No create form is offered for it: the API would refuse the body.
  await expect(page.getByRole("button", { name: "NEW ACTION" })).toHaveCount(0);
});

test("offers GitHub Actions as coming soon and never as a choice", async ({ page }) => {
  await openTab(page, "actions", { locale: "en", repositories: [githubRepository], actions: [] });
  await page.goto(`/github?section=actions&repository=${encodeURIComponent(githubRepository.repositoryKey)}`);
  await page.getByRole("button", { name: "NEW ACTION" }).click();
  const actions = page.getByRole("radio", { name: /GitHub Actions/ });
  await expect(actions).toBeVisible();
  await expect(actions).toBeDisabled();
  await expect(actions).toContainText("coming soon");
  await expect(page.getByRole("radio", { name: /Sentinel/ })).toHaveAttribute("aria-checked", "true");
});

test("lists deliveries with the ignore reason in words", async ({ page }) => {
  await openTab(page, "integration", {
    locale: "en",
    deliveries: [
      githubDelivery({ deliveryId: "delivery-fork", outcome: "ignored", reason: "fork_pull_request" }),
      githubDelivery({ deliveryId: "delivery-stale", outcome: "ignored", reason: "stale_delivery" }),
      githubDelivery({ deliveryId: "delivery-cost", outcome: "ignored", reason: "daily_cost_ceiling" }),
      githubDelivery({ deliveryId: "delivery-bad", outcome: "failed", reason: "signature_invalid" }),
    ],
  });
  await expect(page.getByText("Pull request coming from a fork", { exact: false })).toBeVisible();
  await expect(page.getByText("another event for the same commit arrived afterwards", { exact: false })).toBeVisible();
  await expect(page.getByText("UTC day budget was already committed", { exact: false })).toBeVisible();
  await expect(page.getByText("the secret stored here is not the one at GitHub", { exact: false })).toBeVisible();
  // Never the raw code.
  for (const code of ["fork_pull_request", "stale_delivery", "daily_cost_ceiling", "signature_invalid"]) {
    await expect(page.locator("body")).not.toContainText(code);
  }
});

test("spells out every ignored reason in the activity list and links the gate", async ({ page }) => {
  await openTab(page, "activity", {
    locale: "en",
    events: [
      githubEvent({ id: "e1", status: "launched", gateId: "gate-1" }),
      githubEvent({ id: "e2", status: "skipped", gateId: null, reason: "queued_event_expired" }),
      githubEvent({ id: "e3", status: "skipped", gateId: null, reason: "fork_pull_request" }),
      githubEvent({ id: "e4", status: "failed", gateId: null, error: "automatic_dispatch_failed" }),
      githubEvent({ id: "e5", status: "observed", gateId: null, reason: "initial_baseline" }),
    ],
  });
  await expect(page.getByRole("link", { name: /Open gate/ })).toHaveAttribute("href", "/guardrails/gate-1");
  await expect(page.getByText("more than 24 h without being dispatched", { exact: false })).toBeVisible();
  await expect(page.getByText("Pull request coming from a fork", { exact: false })).toBeVisible();
  await expect(page.getByText("Reconciliation tries again on the next cycle", { exact: false })).toBeVisible();
  await expect(page.getByText("without charging a retroactive scan", { exact: false })).toBeVisible();
  for (const code of ["queued_event_expired", "fork_pull_request", "automatic_dispatch_failed", "initial_baseline"]) {
    await expect(page.locator("body")).not.toContainText(code);
  }
});

test("filters the activity by repository and by outcome", async ({ page }) => {
  const state = await openTab(page, "activity", {
    locale: "en",
    repositories: [githubRepository, githubSecondRepository],
    events: [
      githubEvent({ id: "e1", status: "launched" }),
      githubEvent({ id: "e2", status: "skipped", reason: "fork_pull_request", repositoryKey: githubSecondRepository.repositoryKey }),
    ],
  });
  await page.getByLabel("Outcome").click();
  await page.getByRole("option", { name: "ignored", exact: true }).click();
  await expect.poll(() => state.github.requests.some((request) => request.includes("outcome=skipped"))).toBe(true);
  await expect(page.getByText("Pull request coming from a fork", { exact: false })).toBeVisible();
});

test("the tab never calls a route the API no longer serves", async ({ page }) => {
  const state = await openTab(page, "integration", { locale: "en" });
  await page.getByRole("button", { name: /^02/ }).click();
  await expect(page.getByText("Actions per repository")).toBeVisible();
  await page.getByRole("button", { name: /^03/ }).click();
  await expect(page.getByText("Events, matched actions and gates")).toBeVisible();
  await page.getByRole("button", { name: "REFRESH" }).click();
  await expect(page.getByRole("button", { name: "REFRESH" })).toBeEnabled();

  for (const deleted of DELETED_ROUTES) {
    expect(state.requests.filter((request) => request.includes(deleted))).toEqual([]);
  }
  // And the three decorative "✓ followed sources" cards are gone with them.
  await expect(page.getByText("FOLLOWED SOURCES")).toHaveCount(0);
  await expect(page.getByText("LOCAL CHECKOUT")).toHaveCount(0);
});

test("reads the integration once per visit and never on an interval", async ({ page }) => {
  const state = await openTab(page, "integration", { locale: "en" });
  await expect(page.getByText("OKAMI Sentinel Guardrails").first()).toBeVisible();
  const reads = () => state.github.requests.filter((request) => request === "GET /github/integration").length;
  await expect.poll(reads).toBe(1);
  // Long enough that any poll under half a minute would show up.
  await page.waitForTimeout(6000);
  expect(reads()).toBe(1);
  await page.getByRole("button", { name: "REFRESH" }).click();
  await expect.poll(reads).toBe(2);
});

test("keeps reading the actions when GitHub itself is unreachable", async ({ page }) => {
  await openTab(page, "actions", { locale: "en", integrationFails: true });
  await expect(page.getByText("PR deep")).toBeVisible();
  await page.getByRole("button", { name: /^01/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "GitHub could not be reached" })).toBeVisible();
});
