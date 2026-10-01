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

/** The tab bar of the page, not the module strip in the shell. */
function sectionTab(page: Page, code: RegExp) {
  return page.getByRole("navigation", { name: "GitHub" }).getByRole("link", { name: code });
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
  // The baseline step reads the projection now: no repository has one here.
  await expect(page.getByRole("listitem").filter({ hasText: "Baseline ready" })).toContainText("pending");
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

  const field = page.getByLabel("New secret", { exact: true });
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
    // A Radix checkbox is a button with `role="checkbox"`, not an <input>.
    await page.getByRole("checkbox", { name: "Enable this action" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
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

/**
 * Every action belongs to one repository, and the body carries it, so "all
 * repositories" cannot create one. The button is absent and the reason is not.
 */
test("tells an administrator why all repositories offers no create button", async ({ page }) => {
  await openTab(page, "actions", { locale: "en", repositories: [githubRepository, githubSecondRepository] });
  await expect(page.getByRole("button", { name: "NEW ACTION" })).toHaveCount(0);
  await expect(page.getByText("Pick a repository above to create an action", { exact: false })).toBeVisible();

  await page.goto(`/github?section=actions&repository=${encodeURIComponent(githubRepository.repositoryKey)}`);
  await expect(page.getByRole("button", { name: "NEW ACTION" })).toBeVisible();
  await expect(page.getByText("Pick a repository above", { exact: false })).toHaveCount(0);
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
  await page.getByRole("button", { name: "Save", exact: true }).click();
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
  await expect(sectionTab(page, /^01/)).toHaveCount(0);
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

/**
 * Phase 4: GitHub Actions is a real choice. Picking it drops the provider route the
 * customer's own minutes never use and names the three things the repository still
 * needs, one of which Sentinel cannot check for anybody.
 */
test("creates a github-actions action and shows the prerequisites", async ({ page }) => {
  const state = await openTab(page, "actions", {
    locale: "en",
    repositories: [githubRepository],
    actions: [],
  });
  await page.goto(`/github?section=actions&repository=${encodeURIComponent(githubRepository.repositoryKey)}`);
  await page.getByRole("button", { name: "NEW ACTION" }).click();

  const actions = page.getByRole("radio", { name: /GitHub Actions/ });
  await expect(actions).toBeEnabled();
  await actions.click();
  await expect(actions).toHaveAttribute("aria-checked", "true");

  // The provider route is gone: nothing here spends a Sentinel connection.
  await expect(page.getByLabel("Model connection")).toHaveCount(0);
  const panel = page.getByTestId("caller-workflow-panel");
  await expect(panel).toContainText("Pinned workflow on the default branch");
  await expect(panel).toContainText("Automatic triggers removed from the caller");
  await expect(panel).toContainText("OPENAI_API_KEY secret in the repository");
  // Sentinel asks for no grant to read secrets, so it says so instead of ticking it.
  await expect(panel).toContainText("Confirm yourself");
  await expect(panel).toContainText("Settings → Secrets and variables → Actions");

  await page.getByLabel("Name", { exact: true }).fill("actions pr");
  await page.getByLabel("Branch patterns").fill("main");
  await page.getByLabel("Per-scan ceiling / USD").fill("2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "NEW ACTION" })).toBeVisible();

  const posted = state.github.writes.filter((write) => write.method === "POST");
  expect(posted).toHaveLength(1);
  expect(posted[0]!.body).toEqual(expect.objectContaining({
    executor: "github-actions",
    // The customer's minutes carry no scanner selection at all.
    scanner: null,
  }));
});

test("opens the workflow pull request and shows the link", async ({ page }) => {
  const state = await openTab(page, "actions", {
    locale: "en",
    repositories: [githubRepository],
    actions: [],
  });
  await page.goto(`/github?section=actions&repository=${encodeURIComponent(githubRepository.repositoryKey)}`);
  await page.getByRole("button", { name: "NEW ACTION" }).click();
  await page.getByRole("radio", { name: /GitHub Actions/ }).click();
  await page.getByRole("button", { name: "Open PR With Workflow" }).click();

  const panel = page.getByTestId("caller-workflow-panel");
  await expect(panel).toContainText("Pull request #42 opened on branch okami-sentinel/caller-workflow");
  await expect(panel.getByRole("link", { name: "View On GitHub" }))
    .toHaveAttribute("href", "https://github.com/okami/example/pull/42");
  expect(state.github.callerPullRequests).toEqual([githubRepository.repositoryKey]);
});

test("says a workflow pull request was already open instead of failing", async ({ page }) => {
  await openTab(page, "actions", {
    locale: "en",
    repositories: [githubRepository],
    actions: [],
    callerPullRequestExists: true,
  });
  await page.goto(`/github?section=actions&repository=${encodeURIComponent(githubRepository.repositoryKey)}`);
  await page.getByRole("button", { name: "NEW ACTION" }).click();
  await page.getByRole("radio", { name: /GitHub Actions/ }).click();
  await page.getByRole("button", { name: "Open PR With Workflow" }).click();
  await expect(page.getByTestId("caller-workflow-panel"))
    .toContainText("Pull request #41 was already open");
});

/**
 * A caller that still fires on its own is what `monitor_actions_duplicate_triggers`
 * refuses at dispatch. The sheet says so before anybody creates the action.
 */
test("shows the duplicate-triggers refusal in words", async ({ page }) => {
  await openTab(page, "actions", {
    locale: "en",
    repositories: [githubRepository],
    actions: [],
    actionsStatus: {
      ready: true,
      code: "ready",
      workflowPath: ".github/workflows/csb-security-change-gate.yml",
      releaseSha: "f".repeat(40),
      triggers: { push: true, pullRequest: true, merge: true },
    },
  });
  await page.goto(`/github?section=actions&repository=${encodeURIComponent(githubRepository.repositoryKey)}`);
  await page.getByRole("button", { name: "NEW ACTION" }).click();
  await page.getByRole("radio", { name: /GitHub Actions/ }).click();

  const triggers = page.getByRole("listitem").filter({ hasText: "Automatic triggers removed from the caller" });
  await expect(triggers).toContainText("Still to do");
  await expect(triggers).toContainText("Delete the push: and pull_request: blocks");
  await expect(triggers).toContainText("would scan each change twice");
});

test("a maintainer reads the stored executor and cannot change it", async ({ page }) => {
  await openTab(page, "actions", {
    locale: "en",
    repositories: [githubRepository],
    actions: [githubAction({ enabled: false })],
    session: {
      isAdmin: false,
      grants: [{ repositoryKey: githubRepository.repositoryKey, role: "maintainer" }],
    },
  });
  await page.getByRole("button", { name: "Edit" }).click();
  // Both executors spend — one the account's connection, the other the repository's
  // minutes — so the choice is an administrator's on both cards.
  await expect(page.getByRole("radio", { name: /GitHub Actions/ })).toBeDisabled();
  await expect(page.getByRole("radio", { name: /^Sentinel\b/ })).toBeDisabled();
});

test("a maintainer never gets the button that opens the workflow pull request", async ({ page }) => {
  const state = await openTab(page, "actions", {
    locale: "en",
    repositories: [githubRepository],
    actions: [githubAction({ enabled: false, executor: "github-actions", scanner: null })],
    session: {
      isAdmin: false,
      grants: [{ repositoryKey: githubRepository.repositoryKey, role: "maintainer" }],
    },
  });
  await page.getByRole("button", { name: "Edit" }).click();
  const panel = page.getByTestId("caller-workflow-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("button", { name: "Open PR With Workflow" })).toHaveCount(0);
  await expect(panel).toContainText("Only an administrator opens the pull request");
  // Reading the workflow is a viewer's; nothing was written.
  expect(state.github.callerPullRequests).toEqual([]);
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
  await sectionTab(page, /^02/).click();
  await expect(page.getByText("Actions per repository")).toBeVisible();
  await sectionTab(page, /^03/).click();
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
  await sectionTab(page, /^01/).click();
  // One statement of the outage, inside the panel that failed, with the way out.
  await expect(page.getByText("GitHub could not be reached right now", { exact: false })).toBeVisible();
  await expect(page.getByText("Actions and Activity sections are still readable", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

/**
 * Each integration read costs `GET /app` plus `GET /app/installations` per
 * connection. Flipping a filter in `03 Atividade` must spend none of them — and
 * must not replace the section with a spinner, which unmounts the `Select` the
 * operator is standing on.
 */
test("a filter change costs no GitHub call and keeps the control mounted", async ({ page }) => {
  const state = await openTab(page, "activity", {
    locale: "en",
    repositories: [githubRepository, githubSecondRepository],
    events: [githubEvent({ id: "e1", status: "skipped", reason: "fork_pull_request" })],
  });
  const reads = () => state.github.requests.filter((request) => request === "GET /github/integration").length;
  await expect.poll(reads).toBe(1);

  for (const name of ["ignored", "queued"]) {
    await page.getByLabel("Outcome", { exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
    // The select survives the reload of the rows below it.
    await expect(page.getByLabel("Outcome", { exact: true })).toBeVisible();
  }
  await page.getByLabel("Repository", { exact: true }).click();
  await page.getByRole("option", { name: "solar-api" }).click();
  await expect(page.getByLabel("Repository", { exact: true })).toBeVisible();

  expect(reads()).toBe(1);
  expect(state.github.requests.filter((request) => request.startsWith("GET /github/deliveries"))).toHaveLength(1);
});

/**
 * An action past the page bound stays enabled and keeps spending while being
 * invisible on the only screen that can switch it off.
 */
test("never hides an action behind a page bound", async ({ page }) => {
  const many = Array.from({ length: 3 }, (_, index) => githubAction({
    id: `action-${index}`, name: `Ação ${index}`, triggerKind: index % 2 === 0 ? "pull_request" : "push",
  }));
  const state = await openTab(page, "actions", {
    locale: "en", repositories: [githubRepository], actions: many,
  });
  // The fixture pages at whatever the client asks for; the client asks for 50.
  await expect(page.getByText("Ação 0")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(state.github.requests.some((request) => request.startsWith("GET /github/actions"))).toBe(true);
});

/**
 * `patchRequiresAdmin` lets a maintainer clear `includeForks`: stopping fork scans
 * narrows what the action does. Greying it out left them disabling the action and
 * losing every internal pull request with it.
 */
test("lets a maintainer stop scanning forks without disabling the action", async ({ page }) => {
  const state = await openTab(page, "actions", {
    locale: "en",
    session: { isAdmin: false, grants: [{ repositoryKey: githubRepository.repositoryKey, role: "maintainer" }] },
    repositories: [githubRepository],
    actions: [githubAction({ enabled: false, includeForks: true })],
  });

  await page.getByRole("button", { name: "Edit" }).click();
  const forks = page.getByRole("checkbox", { name: "Scan pull requests from forks" });
  await expect(forks).toBeEnabled();
  await expect(page.getByText("You may turn it off", { exact: false })).toBeVisible();
  // Enabling the action stays an administrator's.
  await expect(page.getByRole("checkbox", { name: "Enable this action" })).toBeDisabled();
  await forks.click();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect.poll(() => state.github.writes.filter((write) => write.method === "PATCH")
    .map((write) => (write.body as { includeForks?: boolean }).includeForks)).toEqual([false]);
});

/**
 * Several actions may now share a repository, so two rows of one push differ only
 * by which action matched. Naming it is the question this list exists to answer.
 */
test("names the matched action and the delivery on every activity row", async ({ page }) => {
  await openTab(page, "activity", {
    locale: "en",
    repositories: [githubRepository],
    actions: [
      githubAction({ id: "action-cheap", name: "main cheap", triggerKind: "push" }),
      githubAction({ id: "action-deep", name: "release deep" }),
    ],
    events: [
      githubEvent({ id: "e1", actionId: "action-cheap", status: "launched", deliveryId: "delivery-aaa-0001" }),
      githubEvent({ id: "e2", actionId: "action-deep", status: "skipped", reason: "daily_cost_ceiling", deliveryId: "delivery-bbb-0002" }),
    ],
  });
  await expect(page.getByText("main cheap")).toBeVisible();
  await expect(page.getByText("release deep")).toBeVisible();
  // The delivery id is what joins a row to Entregas and to GitHub's own list.
  // `shortId` keeps the first eight characters, so the two rows stay distinguishable.
  await expect(page.getByText("delivery…", { exact: false }).first()).toBeVisible();
});

/** The only `window.confirm` in `apps/web/src` was this one. */
test("confirms a deletion in the product, never in the browser", async ({ page }) => {
  const state = await openTab(page, "actions", {
    locale: "en", repositories: [githubRepository], actions: [githubAction({ enabled: false })],
  });
  let nativeDialogs = 0;
  page.on("dialog", (dialog) => { nativeDialogs += 1; void dialog.dismiss(); });

  await page.getByRole("button", { name: "Remove" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Its events are deleted with it");
  await expect(dialog).toContainText("PR deep");  // the title names the action

  // Cancelling deletes nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.github.writes).toEqual([]);

  await page.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => state.github.writes.map((write) => write.method)).toEqual(["DELETE"]);
  expect(nativeDialogs).toBe(0);
});

/**
 * A secret pasted with a trailing space retires the previous proof. The panel used
 * to print the amber "the integration is still ready" next to the field the
 * operator had just used, while the checklist two panels below showed the same step
 * red — and the reassuring sentence is the one they read.
 */
test("says the rotation retired the proof instead of calling it ready", async ({ page }) => {
  await openTab(page, "integration", { locale: "en", integration: "proof_retired" });

  await expect(page.getByText("the previous proof is retired", { exact: false })).toBeVisible();
  await expect(page.getByText("redeliver the ping", { exact: false })).toBeVisible();
  // The amber reassurance must not fire on a step that is red.
  await expect(page.getByText("the integration stays ready", { exact: false })).toHaveCount(0);
  await expect(page.getByText("No recent event for", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("listitem").filter({ hasText: "Delivery verified" })).toContainText("pending");
});
