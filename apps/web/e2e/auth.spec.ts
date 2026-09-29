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
