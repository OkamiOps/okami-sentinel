import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

test("signs in and returns to the requested page", async ({ page }) => {
  await mockApi(page, "en", { signedOut: true });
  await page.goto("/scans?status=all");
  await expect(page).toHaveURL(/\/login\?next=%2Fscans%3Fstatus%3Dall/);
  await page.getByLabel("Username").fill("ana");
  await page.getByLabel("Password", { exact: true }).fill("wrong password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Invalid username or password.")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("ana password 123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/scans\?status=all$/);
});

test("shows the lockout countdown", async ({ page }) => {
  await mockApi(page, "en", { signedOut: true, loginResponse: { status: 423, body: { error: "account_locked", retryAfterSeconds: 65 } } });
  await page.goto("/login");
  await page.getByLabel("Username").fill("ana");
  await page.getByLabel("Password", { exact: true }).fill("anything at all");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/Try again in 01:0[45]/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
});

test("a first visit without a session is not reported as expired", async ({ page }) => {
  await mockApi(page, "en", { signedOut: true });
  await page.goto("/scans?status=all");
  await expect(page).toHaveURL(/\/login\?next=%2Fscans%3Fstatus%3Dall$/);
  await expect(page.getByText("Your session expired. Sign in again.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("a session lost mid-visit is reported as expired", async ({ page }) => {
  const state = await mockApi(page, "en");
  await page.goto("/scans");
  await expect(page.getByRole("link", { name: "Repository alpha", exact: true })).toBeVisible();
  state.auth.signedIn = false;
  await expect(page).toHaveURL(/\/login\?next=%2Fscans&expired=1$/, { timeout: 15000 });
  await expect(page.getByText("Your session expired. Sign in again.")).toBeVisible();
});

test("accepts an invite with a matching password", async ({ page }) => {
  await mockApi(page, "en", { signedOut: true });
  await page.goto(`/invite/${"a".repeat(43)}`);
  await expect(page.getByText("Root invited you to Sentinel.")).toBeVisible();
  await page.getByLabel("New password").fill("a strong password");
  await page.getByLabel("Confirm password").fill("a different password");
  await page.getByRole("button", { name: "Save and sign in" }).click();
  await expect(page.getByText("Passwords do not match.")).toBeVisible();
  await page.getByLabel("Confirm password").fill("a strong password");
  await page.getByRole("button", { name: "Save and sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("repeats the rejected password rule instead of blaming the link", async ({ page }) => {
  await mockApi(page, "en", { signedOut: true, acceptInviteResponse: { status: 400, body: { error: "password_too_long" } } });
  await page.goto(`/invite/${"a".repeat(43)}`);
  const password = "b".repeat(40);
  await page.getByLabel("New password").fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Save and sign in" }).click();
  await expect(page.getByText("The password can have at most 256 characters.")).toBeVisible();
  await expect(page.getByText(/This link is invalid/)).toHaveCount(0);
});

test("keeps the invite form usable when the server fails", async ({ page }) => {
  await mockApi(page, "en", { signedOut: true, acceptInviteResponse: { status: 503, body: { error: "service_unavailable" } } });
  await page.goto(`/invite/${"a".repeat(43)}`);
  const password = "a strong password";
  await page.getByLabel("New password").fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Save and sign in" }).click();
  await expect(page.getByText("Could not save your password. Try again.")).toBeVisible();
  await expect(page.getByText(/This link is invalid/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save and sign in" })).toBeEnabled();
  await expect(page.getByLabel("New password")).toBeEditable();
});

test("a preview the server could not answer offers a retry, not a dead end", async ({ page }) => {
  const state = await mockApi(page, "en", {
    signedOut: true,
    invitePreviewResponse: { status: 503, body: { error: "service_unavailable" } },
  });
  await page.goto(`/invite/${"a".repeat(43)}`);
  // "Ask your administrator for a new link" would burn a token that is still
  // good; a 503 says nothing about the token.
  await expect(page.getByText("Could not read this invite right now.")).toBeVisible();
  await expect(page.getByText(/This link is invalid/)).toHaveCount(0);
  await expect(page.locator(".loading-bars")).toHaveCount(0);
  state.invitePreviewFails = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Root invited you to Sentinel.")).toBeVisible();
  await expect(page.getByLabel("New password")).toBeEditable();
});

test("a rejected invite token still says the link is spent", async ({ page }) => {
  await mockApi(page, "en", {
    signedOut: true,
    invitePreviewResponse: { status: 404, body: { error: "invite_invalid" } },
  });
  await page.goto(`/invite/${"a".repeat(43)}`);
  await expect(page.getByText(/This link is invalid/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("members see only My account under Settings", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [{ repositoryKey: "github:1", role: "viewer" }] } });
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page.getByRole("link", { name: /Users/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /LAUNCH/i })).toHaveCount(0);
});

test("changes the password from My account", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [] } });
  await page.goto("/settings/account");
  await page.getByLabel("Current password").fill("old password 123");
  await page.getByLabel("New password").fill("new password 1234");
  await page.getByLabel("Confirm password").fill("new password 1234");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed. Your other sessions were signed out.")).toBeVisible();
});

test("names the wrong current password instead of a generic failure", async ({ page }) => {
  await mockApi(page, "en", {
    session: { isAdmin: false, grants: [] },
    // The API answers a wrong current password with 400, not 401: a 401 is
    // reserved for a lost session and would sign the reader out.
    changePasswordResponse: { status: 400, body: { error: "invalid_credentials" } },
  });
  await page.goto("/settings/account");
  await page.getByLabel("Current password").fill("not my password");
  await page.getByLabel("New password").fill("new password 1234");
  await page.getByLabel("Confirm password").fill("new password 1234");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Current password is incorrect.")).toBeVisible();
  await expect(page.getByLabel("Current password")).toBeEditable();
});

test("marks the current session and refuses to revoke it", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [] } });
  await page.goto("/settings/account");
  const current = page.getByRole("row").filter({ hasText: "127.0.0.1" });
  await expect(current.getByText("This session")).toBeVisible();
  await expect(current.getByRole("button", { name: "Revoke" })).toBeDisabled();
  const other = page.getByRole("row").filter({ hasText: "10.0.0.8" });
  await expect(other).toContainText("Firefox");
  await page.getByRole("button", { name: "Sign out of other sessions" }).click();
  await expect(other).toHaveCount(0);
  await expect(current).toBeVisible();
});

test("a failed sessions read offers a retry instead of an endless spinner", async ({ page }) => {
  const state = await mockApi(page, "en", { session: { isAdmin: false, grants: [] }, accountSessionsFail: true });
  await page.goto("/settings/account");
  await expect(page.getByText("Could not load your sessions.")).toBeVisible();
  await expect(page.locator(".loading-bars")).toHaveCount(0);
  state.accountSessionsFail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("row").filter({ hasText: "10.0.0.8" })).toBeVisible();
  await expect(page.getByText("Could not load your sessions.")).toHaveCount(0);
});

test("a password change empties the table it says it emptied", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [] } });
  await page.goto("/settings/account");
  await expect(page.getByRole("row").filter({ hasText: "10.0.0.8" })).toBeVisible();
  await page.getByLabel("Current password").fill("old password 123");
  await page.getByLabel("New password").fill("new password 1234");
  await page.getByLabel("Confirm password").fill("new password 1234");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed. Your other sessions were signed out.")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "10.0.0.8" })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "127.0.0.1" })).toBeVisible();
});

test("an unverified session does not exile an admin from Settings", async ({ page }) => {
  const state = await mockApi(page, "en", { sessionUnreachable: true });
  // Engine updates own their own panel and their own route in the suite; this
  // test only needs the settings page to render at all.
  await page.route("**/api/engine-updates**", (route) => route.fulfill({ json: { items: [], busy: null, blockedReason: null, lastOperation: null } }));
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "System readiness" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Connections/ })).toBeVisible();
  await page.goto("/settings/account");
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page.locator(".loading-bars")).toHaveCount(0);
  await expect(page.getByText("Your session could not be verified, so your details cannot be read right now.")).toBeVisible();
  state.auth.sessionUnreachable = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByLabel("Display name")).toBeVisible();
});

test("the user menu carries the role and reaches My account", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [] } });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account menu" }).click();
  await expect(page.getByText("Member", { exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "My account" }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
});

test("admin invites a user with a repository role and copies the link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Invite user" }).click();
  await page.getByLabel(/^name$/i).fill("Bruno Lima");
  await page.getByLabel("Username").fill(" Bruno.Lima ");
  // The server trims and lowercases before it stores; the preview says so
  // before the invite is created, not after it lands under another name.
  await expect(page.getByText("@bruno.lima")).toBeVisible();
  // A work email is a usable login name, and it is previewed as the address it
  // is rather than gaining a second `@`.
  await page.getByLabel("Username").fill(" Marcos@OkamiOps.com ");
  await expect(page.getByText("Will be created as marcos@okamiops.com", { exact: true })).toBeVisible();
  await page.getByLabel("Username").fill(" Bruno.Lima ");
  await page.getByRole("combobox", { name: "luna-core" }).click();
  await page.getByRole("option", { name: /Viewer/ }).click();
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.getByRole("textbox", { name: "Invite link" })).toHaveValue(/\/invite\/[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText("This link is shown only now.")).toBeVisible();
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/invite\/b{43}$/);
});

test("names a taken username instead of a generic failure", async ({ page }) => {
  await mockApi(page, "en", {
    session: { isAdmin: true, grants: [] },
    createUserResponse: { status: 409, body: { error: "username_taken" } },
  });
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Invite user" }).click();
  await page.getByLabel(/^name$/i).fill("Ana Again");
  await page.getByLabel("Username").fill("ana");
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.getByText("That username already exists.")).toBeVisible();
  await expect(page.getByLabel("Username")).toBeEditable();
  await expect(page.getByRole("textbox", { name: "Invite link" })).toHaveCount(0);
});

test("filters the user list by search and status", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/users");
  await expect(page.getByRole("row", { name: /@root/ })).toBeVisible();
  await page.getByLabel("Search").fill("ana");
  await expect(page.getByRole("row", { name: /@ana/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /@root/ })).toHaveCount(0);
  await page.getByLabel("Search").fill("");
  await page.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "Pending invite" }).click();
  await expect(page.getByRole("row", { name: /@bea/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /@ana/ })).toHaveCount(0);
});

test("saves a repository role from the user drawer", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/users");
  await page.getByRole("row", { name: /@ana/ }).click();
  const role = page.getByRole("combobox", { name: "luna-core" });
  await expect(role).toContainText("Viewer");
  await role.click();
  await page.getByRole("option", { name: /Maintainer/ }).click();
  await page.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByText("Repository access updated.")).toBeVisible();
});

test("shows the last-admin refusal", async ({ page }) => {
  await mockApi(page, "en", {
    session: { isAdmin: true, grants: [] },
    patchUserResponse: { status: 409, body: { error: "last_admin" } },
  });
  await page.goto("/settings/users");
  await page.getByRole("row", { name: /@root/ }).click();
  await page.getByRole("tab", { name: "Actions" }).click();
  await page.getByRole("button", { name: "Remove administrator" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("You cannot remove the last active administrator.")).toBeVisible();
});

test("keeps the generated reset link visible across a tab switch", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/users");
  await page.getByRole("row", { name: /@ana/ }).click();
  await page.getByRole("tab", { name: "Actions" }).click();
  await page.getByRole("button", { name: "Generate reset link" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  const link = page.getByRole("textbox", { name: "Reset link" });
  await expect(link).toHaveValue(/\/invite\/[A-Za-z0-9_-]{43}$/);
  const value = await link.inputValue();
  // The tab unmounting the panel is exactly the bug: the server stores only
  // the link's hash, so once it scrolls off screen it cannot be regenerated.
  await page.getByRole("tab", { name: "Sessions" }).click();
  await expect(link).toHaveCount(0);
  await page.getByRole("tab", { name: "Actions" }).click();
  await expect(page.getByRole("textbox", { name: "Reset link" })).toHaveValue(value);
});

test("resets the copy button when a second reset link is generated", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/users");
  await page.getByRole("row", { name: /@ana/ }).click();
  await page.getByRole("tab", { name: "Actions" }).click();
  await page.getByRole("button", { name: "Generate reset link" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  const link = page.getByRole("textbox", { name: "Reset link" });
  await expect(link).toHaveValue(/\/invite\/c{43}$/);
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

  await page.getByRole("button", { name: "Generate reset link" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  // A second link invalidates the first; the button must not keep claiming
  // the clipboard holds a copy of a token that no longer works.
  await expect(link).toHaveValue(/\/invite\/d{43}$/);
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
});

test("re-reads the user after generating a reset link", async ({ page }) => {
  const state = await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/users");
  await page.getByRole("row", { name: /@ana/ }).click();
  await page.getByRole("tab", { name: "Actions" }).click();
  const before = state.requests.filter((request) => request === "GET /users").length;
  await page.getByRole("button", { name: "Generate reset link" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("textbox", { name: "Reset link" })).toBeVisible();
  // The reset endpoint does not return the account, and it just changed
  // pendingInvite server-side, so the drawer must re-read the row.
  await expect.poll(() => state.requests.filter((request) => request === "GET /users").length).toBeGreaterThan(before);
});

test("grants repository access from the access screen", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/access");
  await page.getByRole("combobox", { name: "User for luna-core" }).click();
  await page.getByRole("option", { name: /Bea/ }).click();
  await page.getByRole("combobox", { name: "Role for luna-core" }).click();
  await page.getByRole("option", { name: /Operator/ }).click();
  await page.getByRole("button", { name: "Grant" }).click();
  await expect(page.getByRole("combobox", { name: "Role for Bea in luna-core" })).toContainText("Operator");
});

test("rolls a refused role change back to the stored role", async ({ page }) => {
  await mockApi(page, "en", {
    session: { isAdmin: true, grants: [] },
    setRepositoryRoleResponse: { status: 400, body: { error: "role_invalid" } },
  });
  await page.goto("/settings/access");
  const role = page.getByRole("combobox", { name: "Role for Ana in luna-core" });
  await expect(role).toContainText("Viewer");
  await role.click();
  await page.getByRole("option", { name: /Maintainer/ }).click();
  await expect(page.getByText("Could not save the role. Try again.")).toBeVisible();
  await expect(role).toContainText("Viewer");
});

test("local mode offers no sign out and says accounts are server-only", async ({ page }) => {
  await mockApi(page, "en");
  await page.goto("/settings/account");
  await expect(page.getByText("Accounts and passwords only apply to a server deployment.")).toBeVisible();
  await page.getByRole("button", { name: "Open account menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "My account" })).toBeVisible();
});

test("a viewer sees scans but no destructive or paid actions", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [{ repositoryKey: "github:1", role: "viewer" }] } });
  await page.goto("/scans/scan-one");
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /delete|remove scan/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /confirm|false positive|accept/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /new scan/i })).toHaveCount(0);
});

test("an analyst can triage findings but cannot delete the scan", async ({ page }) => {
  const state = await mockApi(page, "en", { session: { isAdmin: false, grants: [{ repositoryKey: "github:1", role: "analyst" }] } });
  state.findings.push({
    findingId: "fixture-finding", occurrenceId: null, identity: "fixture-identity", sourceScanId: "scan-one",
    title: "Sample finding", severity: "high", confidence: null, ruleId: null, summary: "Sample evidence",
    primaryPath: "src/example.ts", fingerprints: [], category: null, cwe: [], lifecycle: "new",
    triage: { status: "unreviewed", note: null, updatedAt: null },
  });
  await page.goto("/scans/scan-one?f=fixture-finding");
  await expect(page.getByRole("combobox").filter({ hasText: "Not reviewed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(page.getByRole("button", { name: /delete|remove scan/i })).toHaveCount(0);
});

test("a maintainer sees the delete control on their own repository", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [{ repositoryKey: "github:1", role: "maintainer" }] } });
  await page.goto("/scans/scan-one");
  await expect(page.getByRole("button", { name: /delete|remove scan/i })).toBeVisible();
});

// The shell's top nav strip only unhides at the xl breakpoint; a wide
// viewport keeps this assertion meaningful under both the desktop and
// mobile Playwright projects instead of silently testing an unmounted menu.
test("an admin sees the Operate tab and a member does not", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Operate/i })).toBeVisible();
});

test("a member does not see the Operate tab and /scans/new redirects to /scans", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, "en", { session: { isAdmin: false, grants: [{ repositoryKey: "github:1", role: "maintainer" }] } });
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Operate/i })).toHaveCount(0);
  await page.goto("/scans/new");
  await expect(page).toHaveURL(/\/scans$/);
  await expect(page.getByRole("link", { name: "Repository alpha", exact: true })).toBeVisible();
});

test("an admin sees Repeat on a portable scan and a member never does", async ({ page }) => {
  const adminState = await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  adminState.runs[0] = {
    ...adminState.runs[0],
    execution: {
      executionProfile: "portable", profileVersion: "sentinel-portable-v1", methodologyRef: "sentinel/portable-agent-session/v1",
      capabilityCheckId: null, connectionId: "fixture-connection", routeKind: null, protocol: null, authKind: null,
    },
    launchSelection: { modelSelectionMode: "runtime-default", modelId: null, paths: ["src"] },
  };
  await page.goto("/scans/scan-one");
  await expect(page.getByRole("link", { name: /retry portable/i })).toBeVisible();
});

test("a member does not see Repeat on a portable scan", async ({ page }) => {
  const state = await mockApi(page, "en", { session: { isAdmin: false, grants: [{ repositoryKey: "github:1", role: "maintainer" }] } });
  state.runs[0] = {
    ...state.runs[0],
    execution: {
      executionProfile: "portable", profileVersion: "sentinel-portable-v1", methodologyRef: "sentinel/portable-agent-session/v1",
      capabilityCheckId: null, connectionId: "fixture-connection", routeKind: null, protocol: null, authKind: null,
    },
    launchSelection: { modelSelectionMode: "runtime-default", modelId: null, paths: ["src"] },
  };
  await page.goto("/scans/scan-one");
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /retry portable/i })).toHaveCount(0);
});
