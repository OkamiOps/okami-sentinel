import { expect, test } from "@playwright/test";
import { localeMeta, translate, type Locale } from "../src/i18n";
import { baseRun, mockApi } from "./fixtures";

for (const locale of ["pt-BR", "en", "es", "de", "fr"] as Locale[]) {
  test(`offline status, accessible retry and recovery in ${locale}`, async ({ page }) => {
    const state = await mockApi(page, locale);
    state.offline = true;
    await page.goto("/scans");
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("alert").first()).toContainText(translate(locale, "common.apiUnavailable", { status: 503 }));
    await expect(page.getByText(translate(locale, "shell.engineReady"), { exact: true })).toHaveCount(0);
    await expect(page.getByText(translate(locale, "scans.empty"), { exact: true })).toHaveCount(0);
    const retry = page.getByRole("button", { name: translate(locale, "common.retry"), exact: true }).last();
    await retry.focus();
    await expect(retry).toBeFocused();
    state.offline = false;
    await retry.press("Enter");
    await expect(page.getByRole("link", { name: "Repository alpha", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("ledger preserves filters, supports pages, and keeps loaded rows on a failed refresh", async ({ page }) => {
  const state = await mockApi(page);
  state.runs = Array.from({ length: 31 }, (_, i) => ({ ...baseRun, id: `record-${i}`, displayName: `Repository ${String(i).padStart(2, "0")}` }));
  await page.goto("/scans");
  await expect(page.getByRole("link", { name: "Repository 00", exact: true })).toBeVisible();
  const filter = page.getByPlaceholder(translate("en", "scans.filter"));
  await filter.fill("Repository 30");
  await expect(page.getByRole("link", { name: "Repository 30", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Repository 00", exact: true })).toHaveCount(0);
  state.offline = true;
  await expect(page.getByRole("status").filter({ hasText: translate("en", "common.apiUnavailable", { status: 503 }) })).toBeVisible({ timeout: 10000 });
  await expect(filter).toHaveValue("Repository 30");
  await expect(page.getByRole("link", { name: "Repository 30", exact: true })).toBeVisible();
  state.offline = false;
  await page.getByRole("button", { name: translate("en", "common.retry"), exact: true }).last().click();
  await filter.fill("");
  const next = page.getByRole("button", { name: /next/i });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByRole("link", { name: "Repository 30", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Repository 00", exact: true })).toHaveCount(0);
});

test("connection retry preserves launch choices, then launches only through the mocked API", async ({ page }) => {
  const state = await mockApi(page);
  state.connectionsFail = true;
  await page.goto("/scans/new");
  await expect(page.getByText(translate("en", "newScan.connectionError"), { exact: true })).toBeVisible();
  state.connectionsFail = false;
  await page.getByRole("button", { name: translate("en", "common.retry"), exact: true }).click();
  await expect(page.getByRole("combobox", { name: translate("en", "newScan.selectConnection") })).toContainText("Fixture provider");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("csb-bench-launch-v2")!))).toMatchObject({ repositoryPath: "/fixture/alpha", paths: "src", maxCostUsd: "2" });
  await page.getByRole("checkbox", { name: translate("en", "newScan.authorizeExecution") }).check();
  await page.getByRole("button", { name: translate("en", "newScan.submit"), exact: true }).click();
  await expect.poll(() => state.launchCount).toBe(1);
  expect(state.lastLaunch).toMatchObject({ repositoryPath: "/fixture/alpha", paths: ["src"] });
});

test("model catalog failure can be retried without changing the repository or connection", async ({ page }) => {
  const state = await mockApi(page);
  state.connection.modelSelectionMode = "catalog";
  state.modelsFail = true;
  await page.goto("/scans/new");
  await expect(page.getByText(translate("en", "newScan.modelError"), { exact: true })).toBeVisible();
  state.modelsFail = false;
  await page.getByRole("button", { name: translate("en", "common.retry"), exact: true }).click();
  await expect(page.getByRole("combobox", { name: translate("en", "newScan.selectModel") })).toBeVisible();
  await expect(page.getByRole("combobox", { name: translate("en", "newScan.selectConnection") })).toContainText("Fixture provider");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("csb-bench-launch-v2")!).repositoryPath)).toBe("/fixture/alpha");
});

test("detail cancels only the selected scan and can open its report", async ({ page }) => {
  const state = await mockApi(page);
  state.runs[0].status = "running";
  state.runs[0].startedAt = new Date().toISOString();
  await page.goto("/scans/scan-one");
  await expect(page.getByRole("heading", { name: "Repository alpha", exact: true })).toBeVisible();
  await page.getByRole("button", { name: translate("en", "scanDetail.cancel"), exact: true }).click();
  await expect.poll(() => state.cancelCount).toBe(1);
  expect(state.runs[1].status).toBe("completed");
  await expect(page.getByRole("button", { name: translate("en", "scanDetail.cancel"), exact: true })).toHaveCount(0);
  const report = page.getByRole("link", { name: new RegExp(translate("en", "scanDetail.report"), "i") });
  await expect(report).toHaveAttribute("href", "/scans/scan-one/report");
  await page.goto("/scans/scan-one/report");
  await expect(page.getByText("Repository alpha", { exact: true }).first()).toBeVisible();
});

test("comparison selects two scans and renders its result", async ({ page }) => {
  const state = await mockApi(page);
  state.offline = true;
  await page.goto("/compare?ids=scan-one,scan-two");
  await expect(page.getByRole("alert")).toContainText(translate("en", "common.apiUnavailable", { status: 503 }));
  await expect(page.getByText(translate("en", "compare.noComparable"), { exact: true })).toHaveCount(0);
  state.offline = false;
  await page.getByRole("button", { name: translate("en", "common.retry"), exact: true }).last().click();
  const compare = page.getByRole("button", { name: translate("en", "compare.run", { count: 2 }), exact: true }).first();
  await expect(compare).toBeEnabled();
  await compare.click();
  await expect(page.getByRole("button", { name: translate("en", "compare.changeScans"), exact: true })).toBeVisible();
  expect(state.requests).toContain("POST /compare");
  await expect(page.getByRole("link", { name: /report/i }).first()).toBeVisible();
});


test("detail recovers from offline and retains loaded evidence when polling fails", async ({ page }) => {
  const state = await mockApi(page, "fr");
  state.runs[0].status = "running";
  state.offline = true;
  await page.goto("/scans/scan-one");
  await expect(page.getByRole("alert")).toContainText(translate("fr", "common.apiUnavailable", { status: 503 }));
  state.offline = false;
  await page.getByRole("button", { name: translate("fr", "common.retry"), exact: true }).click();
  await expect(page.getByRole("heading", { name: "Repository alpha", exact: true })).toBeVisible();
  state.offline = true;
  await expect(page.getByRole("status").filter({ hasText: translate("fr", "common.apiUnavailable", { status: 503 }) })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("heading", { name: "Repository alpha", exact: true })).toBeVisible();
  state.offline = false;
  await page.getByRole("button", { name: translate("fr", "common.retry"), exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: translate("fr", "common.apiUnavailable", { status: 503 }) })).toHaveCount(0);
});

test("language changes preserve detail filters and comparison choices", async ({ page }, testInfo) => {
  const state = await mockApi(page);
  state.findings.push({ findingId: "fixture-finding", occurrenceId: null, identity: "fixture-identity", sourceScanId: "scan-one", title: "retained filter evidence", severity: "high", confidence: null, ruleId: null, summary: "Original scanner evidence", primaryPath: "src/example.ts", fingerprints: [], category: null, cwe: [], lifecycle: "persisting", triage: { status: "false_positive", note: null, updatedAt: null } });
  state.runs[0].severity.high = 1;
  state.runs[0].severity.total = 1;
  await page.addInitScript(() => localStorage.setItem("okami-sentinel.theme", "dark"));
  await page.goto("/scans/scan-one");
  await page.getByRole("textbox", { name: translate("en", "scanDetail.searchEvidence") }).fill("retained filter");
  let current: Locale = "en";
  for (const locale of ["pt-BR", "es", "de", "fr"] as Locale[]) {
    await page.getByRole("button", { name: translate(current, "language.label"), exact: true }).click();
    await page.getByRole("menuitem").filter({ hasText: localeMeta[locale].label }).click();
    await expect(page.getByRole("textbox", { name: translate(locale, "scanDetail.searchEvidence") })).toHaveValue("retained filter");
    await expect(page.getByText(translate(locale, "scanDetail.triage.falsePositive"), { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(translate(locale, "scanDetail.report"), "i") })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    current = locale;
  }
  if (process.env.CSB_E2E_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.CSB_E2E_EVIDENCE_DIR}/detail-dark-${testInfo.project.name}.png`, fullPage: true });
  await page.getByRole("link", { name: translate(current, "scanDetail.compare"), exact: true }).click();
  await page.getByRole("button").filter({ hasText: "Repository beta" }).click();
  for (const locale of ["pt-BR", "es", "de", "fr", "en"] as Locale[]) {
    await page.getByRole("button", { name: translate(current, "language.label"), exact: true }).click();
    await page.getByRole("menuitem").filter({ hasText: localeMeta[locale].label }).click();
    await expect(page.getByRole("button", { name: translate(locale, "compare.run", { count: 2 }), exact: true }).first()).toBeEnabled();
    current = locale;
  }
  await page.getByRole("button", { name: translate(current, "compare.run", { count: 2 }), exact: true }).first().click();
  await expect(page.getByRole("button", { name: translate(current, "compare.changeScans"), exact: true })).toBeVisible();
  await page.getByRole("button", { name: translate(current, "language.label"), exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: localeMeta.de.label }).click();
  await expect(page.getByRole("button", { name: translate("de", "compare.changeScans"), exact: true })).toBeVisible();
  expect(state.requests.filter((request) => request === "POST /compare")).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.CSB_E2E_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.CSB_E2E_EVIDENCE_DIR}/compare-dark-${testInfo.project.name}.png`, fullPage: true });
});

test("overview defers code for comparison, launch, detail, and reports", async ({ page }) => {
  const state = await mockApi(page);
  state.offline = true;
  const scripts: string[] = [];
  page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname); });
  await page.goto("/");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(scripts.some((script) => script.includes("DashboardPage-"))).toBe(true);
  expect(scripts.filter((script) => /\/(ComparePage|CompareReportPage|NewScanPage|ScanDetailPage|ScanReportPage)-/.test(script))).toEqual([]);
});
