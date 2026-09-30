import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

test("fills the SMTP transport from a preset and saves without inventing a secret", async ({ page }) => {
  const state = await mockApi(page, "en");
  await page.goto("/settings/email");
  await expect(page.getByRole("heading", { name: "E-mail", exact: true })).toBeVisible();

  await page.getByRole("combobox", { name: "Preset" }).click();
  await page.getByRole("option", { name: "Microsoft 365" }).click();
  await expect(page.getByLabel("Host", { exact: true })).toHaveValue("smtp.office365.com");
  await expect(page.getByLabel("Port", { exact: true })).toHaveValue("587");
  await expect(page.getByRole("combobox", { name: "Security" })).toContainText("STARTTLS");

  // Resend is the one preset that also fixes the username.
  await page.getByRole("combobox", { name: "Preset" }).click();
  await page.getByRole("option", { name: "Resend (SMTP)" }).click();
  await expect(page.getByLabel("Host", { exact: true })).toHaveValue("smtp.resend.com");
  await expect(page.getByLabel("Port", { exact: true })).toHaveValue("465");
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue("resend");

  await page.getByLabel("Sender name").fill("Okami Sentinel");
  await page.getByLabel("Sender address").fill("alerts@okami.test");
  await page.getByLabel("API key").fill("re_live_key");
  await page.getByRole("checkbox", { name: "E-mail delivery on" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("Configuration saved.")).toBeVisible();
  await expect.poll(() => state.emailSettingsWrites).toHaveLength(1);
  expect(state.emailSettingsWrites[0]).toEqual({
    provider: "smtp", enabled: true, fromName: "Okami Sentinel", fromAddress: "alerts@okami.test", replyTo: null,
    smtpHost: "smtp.resend.com", smtpPort: 465, smtpSecurity: "tls", smtpUsername: "resend", secret: "re_live_key",
  });
  await expect(page.getByText("Configured", { exact: true })).toBeVisible();
});

test("the Resend API provider sends no SMTP transport at all", async ({ page }) => {
  const state = await mockApi(page, "en", {
    emailSettings: { fromAddress: "alerts@okami.test", smtpHost: "smtp.zoho.eu", smtpPort: 465, smtpUsername: "ana@okami.test", secretConfigured: true },
  });
  await page.goto("/settings/email");
  await expect(page.getByLabel("Host", { exact: true })).toHaveValue("smtp.zoho.eu");

  await page.getByRole("combobox", { name: "Provider type" }).click();
  await page.getByRole("option", { name: "Resend API" }).click();
  await expect(page.getByLabel("Host", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Preset")).toHaveCount(0);
  await expect(page.getByLabel("Resend API key")).toBeVisible();

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Configuration saved.")).toBeVisible();
  const body = state.emailSettingsWrites[0];
  expect(body.provider).toBe("resend");
  expect("smtpHost" in body).toBe(false);
  // Nothing was typed into the key field, so the stored one has to survive.
  expect("secret" in body).toBe(false);
  expect(state.emailSettings.secretConfigured).toBe(true);
});

test("a stored secret is never shown, and staying empty keeps it", async ({ page }) => {
  const state = await mockApi(page, "en", {
    emailSettings: { fromAddress: "alerts@okami.test", smtpHost: "smtp.hostinger.com", smtpPort: 465, smtpUsername: "ana@okami.test", secretConfigured: true, enabled: true },
  });
  await page.goto("/settings/email");
  const secret = page.getByLabel("Password", { exact: true });
  await expect(secret).toHaveValue("");
  await expect(page.getByText("Configured", { exact: true })).toBeVisible();
  await expect(page.getByText("A value is already stored.")).toBeVisible();

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Configuration saved.")).toBeVisible();
  expect("secret" in state.emailSettingsWrites[0]).toBe(false);

  await secret.fill("a replacement");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.emailSettingsWrites).toHaveLength(2);
  expect(state.emailSettingsWrites[1].secret).toBe("a replacement");
  // The replaced value does not come back into the field either.
  await expect(secret).toHaveValue("");
});

test("a refused field is named on the field itself", async ({ page }) => {
  await mockApi(page, "en", {
    emailSettings: { fromAddress: "alerts@okami.test", smtpHost: "smtp.hostinger.com" },
    saveEmailSettingsResponse: { status: 400, body: { error: "smtp_port_invalid" } },
  });
  await page.goto("/settings/email");
  await page.getByLabel("Port", { exact: true }).fill("999999");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Enter a port between 1 and 65535.")).toBeVisible();
  await expect(page.getByLabel("Port", { exact: true })).toHaveAttribute("aria-invalid", "true");
  // The typed value stays on screen: the administrator has to see what was refused.
  await expect(page.getByLabel("Port", { exact: true })).toHaveValue("999999");
});

test("no encryption is allowed and warned about", async ({ page }) => {
  await mockApi(page, "en", { emailSettings: { fromAddress: "alerts@okami.test", smtpHost: "mail.internal", smtpPort: 25 } });
  await page.goto("/settings/email");
  await expect(page.getByText(/^No encryption is only for an internal relay/)).toHaveCount(0);
  await page.getByRole("combobox", { name: "Security" }).click();
  await page.getByRole("option", { name: "No encryption" }).click();
  await expect(page.getByText(/^No encryption is only for an internal relay/)).toBeVisible();
});

test("a successful test names where it went", async ({ page }) => {
  const state = await mockApi(page, "en", {
    emailSettings: { fromAddress: "alerts@okami.test", smtpHost: "smtp.resend.com", smtpPort: 465, smtpUsername: "resend", secretConfigured: true, enabled: true },
  });
  await page.goto("/settings/email");
  await page.getByRole("button", { name: "Send test e-mail" }).click();
  await expect(page.getByText("Test e-mail sent to root@example.test.")).toBeVisible();
  expect(state.emailTestCount).toBe(1);
});

test("a refused test shows the provider's own error", async ({ page }) => {
  await mockApi(page, "en", {
    emailSettings: { fromAddress: "alerts@okami.test", smtpHost: "smtp.resend.com", smtpPort: 465, smtpUsername: "resend", secretConfigured: true, enabled: true },
    emailTestResult: { ok: false, to: "root@example.test", code: "auth_rejected", message: "535 5.7.8 Authentication credentials invalid", providerMessageId: null },
  });
  await page.goto("/settings/email");
  await page.getByRole("button", { name: "Send test e-mail" }).click();
  await expect(page.getByText("The provider refused the message to root@example.test.")).toBeVisible();
  await expect(page.getByText("The provider refused the credentials.")).toBeVisible();
  await expect(page.getByText("535 5.7.8 Authentication credentials invalid")).toBeVisible();
});

test("an incomplete configuration says so instead of testing", async ({ page }) => {
  await mockApi(page, "en");
  await page.goto("/settings/email");
  await expect(page.getByRole("button", { name: "Send test e-mail" })).toBeDisabled();
  await expect(page.getByText("Save a sender and a complete provider before testing.")).toBeVisible();
});

test("local mode says the messages will carry no links", async ({ page }) => {
  await mockApi(page, "en", { publicOrigin: null });
  await page.goto("/settings/email");
  await expect(page.getByText(/messages are sent without links/)).toBeVisible();
});

test("the delivery history states status, attempts and the last error", async ({ page }) => {
  await mockApi(page, "en");
  await page.goto("/settings/email");
  const rows = page.getByRole("row");
  await expect(page.getByText("bea@example.test")).toBeVisible();
  await expect(rows.filter({ hasText: "bea@example.test" }).getByText("Sent", { exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: "ana@example.test" }).getByText("Failed", { exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: "ana@example.test" }).getByText("Gate blocked")).toBeVisible();
  // A resolved operational alert is named as the same event, resolved.
  await expect(page.getByText("Engine unavailable · resolved")).toBeVisible();
  await expect(rows.filter({ hasText: "root@example.test" }).getByText("Queued", { exact: true })).toBeVisible();
  // The error column is hidden on a narrow screen, so presence is the assertion.
  await expect(page.getByTitle("550 5.7.1 Sender address not verified")).toHaveCount(1);
});

test("an empty history says so instead of showing an empty table", async ({ page }) => {
  await mockApi(page, "en", { emailDeliveries: [] });
  await page.goto("/settings/email");
  await expect(page.getByText("No message has been sent yet.")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("a failed history read is retryable without losing the form", async ({ page }) => {
  const state = await mockApi(page, "en", { emailDeliveriesFail: true, emailSettings: { fromAddress: "alerts@okami.test" } });
  await page.goto("/settings/email");
  await expect(page.getByText("Could not load the history.")).toBeVisible();
  await expect(page.getByLabel("Sender address")).toHaveValue("alerts@okami.test");
  state.emailDeliveriesFail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("bea@example.test")).toBeVisible();
});

test("a member never reaches the e-mail section", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [{ repositoryKey: "github:1", role: "viewer" }] } });
  await page.goto("/settings/email");
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page.getByRole("link", { name: /E-mail/ })).toHaveCount(0);
});

test("an administrator reaches the e-mail section from the settings tabs", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/account");
  await page.getByRole("link", { name: /E-mail/ }).click();
  await expect(page).toHaveURL(/\/settings\/email$/);
  await expect(page.getByRole("heading", { name: "E-mail", exact: true })).toBeVisible();
});

test("toggling a notification sends only the cell that changed", async ({ page }) => {
  const state = await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/account");
  const cell = page.getByRole("checkbox", { name: "Gate passed for luna-core" });
  await expect(cell).not.toBeChecked();
  await cell.click();
  await expect(cell).toBeChecked();
  await expect.poll(() => state.notificationWrites).toEqual([[{ scope: "github:1", event: "gate.passed", enabled: true }]]);

  await page.getByRole("checkbox", { name: "Daily cost at the ceiling for Operational alerts" }).click();
  await expect.poll(() => state.notificationWrites[1]).toEqual([{ scope: "ops", event: "ops.daily_cost", enabled: false }]);

  await page.getByRole("checkbox", { name: "Scan completed for Scans with no repository" }).click();
  await expect.poll(() => state.notificationWrites[2]).toEqual([{ scope: "unassigned", event: "scan.completed", enabled: true }]);
});

test("a refused toggle rolls the cell back and says so", async ({ page }) => {
  await mockApi(page, "en", {
    session: { isAdmin: true, grants: [] },
    notificationsUpdateResponse: { status: 400, body: { error: "scope_unknown" } },
  });
  await page.goto("/settings/account");
  const cell = page.getByRole("checkbox", { name: "Gate blocked for luna-core" });
  await expect(cell).toBeChecked();
  await cell.click();
  await expect(page.getByText("Could not save that choice. The previous value was restored.")).toBeVisible();
  await expect(cell).toBeChecked();
});

test("a member sees their repositories and neither reserved row", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [{ repositoryKey: "github:1", role: "viewer" }] } });
  await page.goto("/settings/account");
  await expect(page.getByRole("checkbox", { name: "Gate blocked for luna-core" })).toBeVisible();
  await expect(page.getByText("Operational alerts")).toHaveCount(0);
  await expect(page.getByText("Scans with no repository")).toHaveCount(0);
  // Account notices are listed, and none of them is a control.
  await expect(page.getByText("Sign-in from a new device")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Sign-in from a new device/ })).toHaveCount(0);
});

test("an account with no address is told no notification can be sent", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: false, grants: [] }, notificationsAddress: null, noNotificationRepositories: true });
  await page.goto("/settings/account");
  await expect(page.getByText("Your account has no e-mail address, so no notification can be sent.")).toBeVisible();
  await expect(page.getByText("You do not reach any repository yet.")).toBeVisible();
});

test("a fragment from an e-mail footer lands on the notifications section", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/account#notifications");
  const section = page.locator("#notifications");
  await expect(section).toBeVisible();
  await expect(section.getByRole("checkbox", { name: "Gate blocked for luna-core" })).toBeInViewport();
});

test("local mode says notifications only apply to a server deployment", async ({ page }) => {
  await mockApi(page, "en");
  await page.goto("/settings/account");
  await expect(page.locator("#notifications").getByText("E-mail notifications only apply to the server deployment.")).toBeVisible();
});

test("the invite dialog names where the invitation will be sent, and what happened", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Invite user" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("No e-mail address: the link is the only way to deliver this invitation.")).toBeVisible();

  await dialog.getByLabel(/^name$/i).fill("Bea");
  await dialog.getByLabel("Username").fill("bea");
  await expect(dialog.getByText("No e-mail address: the link is the only way to deliver this invitation.")).toBeVisible();
  await dialog.getByLabel("Email (optional)").fill("bea@example.test");
  await expect(dialog.getByText("The invitation will be e-mailed to bea@example.test, if e-mail delivery is configured.")).toBeVisible();

  await dialog.getByRole("button", { name: "Create invite" }).click();
  await expect(dialog.getByText("E-mail sent to bea@example.test.")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Invite link" })).toHaveValue(/\/invite\/b{43}$/);
});

test("a username that is itself an address is the invite destination", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Invite user" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Username").fill("bea@example.test");
  await expect(dialog.getByText("The invitation will be e-mailed to bea@example.test, if e-mail delivery is configured.")).toBeVisible();
});

test("an invitation nobody could e-mail explains why the link is all there is", async ({ page }) => {
  await mockApi(page, "en", {
    session: { isAdmin: true, grants: [] },
    inviteEmail: { emailQueued: false, emailSkipped: "disabled", emailTo: null },
  });
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Invite user" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^name$/i).fill("Bea");
  await dialog.getByLabel("Username").fill("bea");
  await dialog.getByRole("button", { name: "Create invite" }).click();
  await expect(dialog.getByText("E-mail delivery is off, so nothing was sent. Share the link.")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Invite link" })).toBeVisible();
});

test("a password reset reports its e-mail next to the link", async ({ page }) => {
  await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/users");
  await page.getByRole("row", { name: /@bea/ }).click();
  await page.getByRole("tab", { name: "Actions" }).click();
  await page.getByRole("button", { name: "Generate reset link" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("E-mail sent to bea@example.test.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Reset link" })).toHaveValue(/\/invite\/c{43}$/);
});

test("changing the interface language records it on the account", async ({ page }) => {
  const state = await mockApi(page, "en", { session: { isAdmin: true, grants: [] } });
  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Language" }).click();
  await page.getByRole("menuitem", { name: /Español/ }).click();
  await expect(page.getByRole("heading", { name: "Mi cuenta" })).toBeVisible();
  await expect.poll(() => state.localeWrites).toEqual(["es"]);
});
