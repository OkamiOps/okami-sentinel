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
