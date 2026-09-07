import { expect, test } from "@playwright/test";
import type { EngineUpdatesResponse } from "@csb/shared";

import { mockApi } from "./fixtures";

function snapshot(overrides: Partial<EngineUpdatesResponse> = {}): EngineUpdatesResponse {
  return {
    items: [
      {
        id: "codex-security", name: "Codex Security", kind: "cli", source: "managed",
        currentVersion: "1.0.0", latestVersion: "1.1.0", previousVersion: "0.9.0",
        status: "available", checkedAt: "2026-09-08T10:00:00.000Z", error: null,
        canUpdate: true, canRollback: true, sourceUrl: "https://github.com/openai/codex-security",
      },
      {
        id: "codex-cli", name: "Codex CLI", kind: "cli", source: "external",
        currentVersion: "0.80.0", latestVersion: "0.81.0", previousVersion: null,
        status: "available", checkedAt: "2026-09-08T10:00:00.000Z", error: null,
        canUpdate: true, canRollback: false, sourceUrl: "https://github.com/openai/codex",
      },
      {
        id: "mantis", name: "Mantis", kind: "methodology", source: "bundled",
        currentVersion: "Sentinel 0.1", latestVersion: "upstream review", previousVersion: null,
        status: "review_required", checkedAt: "2026-09-08T10:00:00.000Z", error: null,
        canUpdate: false, canRollback: false, sourceUrl: "https://github.com/google/mantis",
      },
      {
        id: "vulnhunter", name: "VulnHunter", kind: "methodology", source: "bundled",
        currentVersion: "Sentinel 0.1", latestVersion: null, previousVersion: null,
        status: "current", checkedAt: "2026-09-08T10:00:00.000Z", error: null,
        canUpdate: false, canRollback: false, sourceUrl: "javascript:alert('never')",
      },
    ],
    busy: null,
    blockedReason: null,
    lastOperation: null,
    ...overrides,
  };
}

test("updates are checked and installed through the Sentinel-owned updater only", async ({ page }) => {
  await mockApi(page);
  let current = snapshot({ items: snapshot().items.map((item) => item.id === "codex-security" ? { ...item, status: "unchecked", latestVersion: null, checkedAt: null } : item) });
  const calls: Array<{ path: string; method: string; body: unknown; csrf: string | null }> = [];

  await page.route("**/api/engine-updates**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({ path, method: request.method(), body: request.postDataJSON() ?? null, csrf: request.headers()["x-csrf-token"] ?? null });
    if (path.endsWith("/security-session")) return route.fulfill({ json: { csrfToken: "fixture-updater-token" } });
    if (path.endsWith("/check")) {
      current = snapshot();
      return route.fulfill({ json: current });
    }
    if (path.endsWith("/codex-cli/update")) {
      current = snapshot({ items: snapshot().items.map((item) => item.id === "codex-cli" ? { ...item, source: "managed", currentVersion: "0.81.0", status: "current", canUpdate: false } : item) });
      return route.fulfill({ json: current });
    }
    return route.fulfill({ json: current });
  });

  await page.goto("/settings");
  const panel = page.getByText("Analysis tools", { exact: true }).locator("xpath=ancestor::section[1]");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Mantis and VulnHunter are integrated analysis profiles.", { exact: false })).toBeVisible();
  await expect(panel.getByRole("link", { name: "OPEN SOURCE" }).first()).toHaveAttribute("href", "https://github.com/openai/codex-security");
  await expect(panel.getByText("VulnHunter").locator("xpath=ancestor::article").getByRole("link")).toHaveCount(0);

  await panel.getByRole("button", { name: "CHECK FOR UPDATES" }).click();
  await expect(panel.getByRole("button", { name: "UPDATE TO 1.1.0" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "INSTALL 0.81.0 FOR SENTINEL" })).toBeVisible();
  await panel.getByRole("button", { name: "INSTALL 0.81.0 FOR SENTINEL" }).click();
  const codexRow = panel.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Codex CLI", exact: true }) });
  await expect(codexRow.getByText("Managed by Sentinel", { exact: true })).toBeVisible();
  await expect(codexRow.getByText("0.81.0", { exact: true })).toHaveCount(2);
  await expect(codexRow.getByRole("button", { name: "INSTALL 0.81.0 FOR SENTINEL" })).toHaveCount(0);

  expect(calls).toContainEqual(expect.objectContaining({ path: "/api/engine-updates/check", method: "POST", body: {}, csrf: "fixture-updater-token" }));
  expect(calls).toContainEqual(expect.objectContaining({ path: "/api/engine-updates/codex-cli/update", method: "POST", body: { version: "0.81.0" }, csrf: "fixture-updater-token" }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
