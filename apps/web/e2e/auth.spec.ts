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

test("local mode offers no sign out and says accounts are server-only", async ({ page }) => {
  await mockApi(page, "en");
  await page.goto("/settings/account");
  await expect(page.getByText("Accounts and passwords only apply to a server deployment.")).toBeVisible();
  await page.getByRole("button", { name: "Open account menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "My account" })).toBeVisible();
});
