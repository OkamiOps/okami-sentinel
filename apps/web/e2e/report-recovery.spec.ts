import { expect, test, type Page } from "@playwright/test";
import { localeMeta, translate, type Locale } from "../src/i18n";
import { scanReportMessages } from "../src/i18n/scan-report";
import { compareReportMessages } from "../src/i18n/compare-report";
import { baseRun, fixtureMetrics, mockApi, reportFinding } from "./fixtures";

async function changeLanguage(page: Page, current: Locale, locale: Locale) {
  if (current === locale) return;
  await page.getByRole("button", { name: translate(current, "language.label"), exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: localeMeta[locale].label }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
}

test("dashboard retries initial failure, polls with the small catalog and retains filters after failure", async ({ page }) => {
  const state = await mockApi(page);
  state.offline = true;
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(translate("en", "common.apiUnavailable", { status: 503 }));
  state.offline = false;
  await page.getByRole("button", { name: translate("en", "common.retry"), exact: true }).click();
  await expect(page.getByRole("link", { name: "Repository alpha", exact: true })).toBeVisible();
  await page.getByPlaceholder(translate("en", "dashboard.searchPlaceholder")).fill("beta");
  await expect(page.getByRole("link", { name: "Repository alpha", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Repository beta", exact: true }).first()).toBeVisible();
  const requests = state.requests.filter((request) => request === "GET /metrics/summary").length;
  await changeLanguage(page, "en", "de");
  expect(state.requests.filter((request) => request === "GET /metrics/summary")).toHaveLength(requests);
  state.offline = true;
  await expect(page.getByRole("status").filter({ hasText: translate("de", "common.apiUnavailable", { status: 503 }) })).toBeVisible({ timeout: 12000 });
  await expect(page.getByPlaceholder(translate("de", "dashboard.searchPlaceholder"))).toHaveValue("beta");
  await expect(page.getByRole("link", { name: "Repository beta", exact: true })).toBeVisible();
  state.offline = false;
  await page.getByRole("button", { name: translate("de", "common.retry"), exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: translate("de", "common.apiUnavailable", { status: 503 }) })).toHaveCount(0);
  expect(state.requests).toContain("GET /scans/catalog");
  expect(state.requests).not.toContain("GET /scans");
});

test("an old dashboard response cannot replace the current search", async ({ page }) => {
  const state = await mockApi(page);
  let releaseOld: (() => void) | undefined;
  let oldFinished = false;
  await page.route("**/api/metrics/summary?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("query") !== "alpha") return route.fallback();
    await new Promise<void>((resolve) => { releaseOld = resolve; });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(fixtureMetrics([state.runs[0]])) });
    oldFinished = true;
  });
  await page.goto("/");
  const input = page.getByPlaceholder(translate("en", "dashboard.searchPlaceholder"));
  await input.fill("alpha");
  await expect.poll(() => !!releaseOld).toBe(true);
  await input.fill("beta");
  await expect(page.getByRole("link", { name: "Repository beta", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Repository alpha", exact: true })).toHaveCount(0);
  releaseOld!();
  await expect.poll(() => oldFinished).toBe(true);
  await page.getByRole("heading", { name: "Repository beta", exact: true }).first().click();
  await expect(page.getByRole("link", { name: "Repository alpha", exact: true })).toHaveCount(0);
  await expect(input).toHaveValue("beta");
});

test("dashboard lets a slow response finish before polling again", async ({ page }) => {
  const state = await mockApi(page);
  await page.clock.install();
  let release: (() => void) | undefined;
  let requests = 0;
  await page.route("**/api/metrics/summary?**", async (route) => {
    requests++;
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(fixtureMetrics(state.runs)) });
  });
  await page.goto("/");
  await expect.poll(() => !!release).toBe(true);
  await page.clock.fastForward(25000);
  expect(requests).toBe(1);
  release!();
  await expect(page.getByRole("link", { name: "Repository alpha", exact: true })).toBeVisible();
});

test("dashboard labels capped metric previews and keeps the full ledger reachable", async ({ page }) => {
  const state = await mockApi(page);
  await page.route("**/api/metrics/summary**", async (route) => {
    const metrics = fixtureMetrics(state.runs);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...metrics,
        totalScans: 1_000,
        recentTotal: 1_000,
        costTrendTotal: 1_000,
        costTrend: state.runs.map((run) => ({
          scanId: run.id,
          displayName: run.displayName,
          startedAt: run.startedAt!,
          estimatedUsd: 1.25,
          findingsHigh: 0,
          findingsTotal: 0,
          model: run.model,
          effort: run.effort,
          estimateKind: null,
        })),
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByText("Latest 2 of 1000 scans", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Latest 2 of 1000 points. Indicators include the entire filter.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /open ledger/i }).last()).toHaveAttribute("href", "/scans");
});

for (const kind of ["scan", "compare"] as const) {
  const path = kind === "scan" ? "/scans/scan-one/report" : "/compare/report?ids=scan-one,scan-two&objective=speed";
  const request = kind === "scan" ? "GET /scans/scan-one/report" : "POST /compare";

  test(`${kind} report retries and preserves loaded content after a failed refresh`, async ({ page }) => {
    const state = await mockApi(page, "fr");
    state.offline = true;
    await page.goto(path);
    await expect(page.getByRole("alert")).toContainText(translate("fr", "common.apiUnavailable", { status: 503 }));
    state.offline = false;
    await page.getByRole("button", { name: translate("fr", "common.retry"), exact: true }).click();
    await expect(page.locator(".report-cover")).toContainText("Repository alpha");
    const sheets = await page.locator(".report-sheet").count();
    state.offline = true;
    await page.getByRole("button", { name: translate("fr", "report.refresh"), exact: true }).click();
    const refreshError = page.locator('[role="alert"], [role="status"]').filter({ hasText: translate("fr", "common.apiUnavailable", { status: 503 }) });
    await expect(refreshError).toBeVisible();
    await expect(page.locator(".report-sheet")).toHaveCount(sheets);
    await expect(page.locator(".report-cover")).toContainText("Repository alpha");
    await changeLanguage(page, "fr", "de");
    await expect(page.locator('[role="alert"], [role="status"]').filter({ hasText: translate("de", "common.apiUnavailable", { status: 503 }) })).toBeVisible();
    state.offline = false;
    await page.getByRole("button", { name: translate("de", "common.retry"), exact: true }).click();
    await expect(page.locator('[role="alert"], [role="status"]').filter({ hasText: translate("de", "common.apiUnavailable", { status: 503 }) })).toHaveCount(0);
    await expect(page.locator(".report-sheet")).toHaveCount(sheets);
  });

  test(`${kind} report clears previous content when the selected scan IDs change`, async ({ page }) => {
    const state = await mockApi(page);
    await page.goto(path);
    await expect(page.locator(".report-cover")).toContainText("Repository alpha");
    state.offline = true;
    const nextPath = kind === "scan" ? "/scans/scan-two/report" : "/compare/report?ids=scan-two,scan-one&objective=speed";
    await page.evaluate((url) => { history.pushState(null, "", url); window.dispatchEvent(new PopStateEvent("popstate")); }, nextPath);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator(".report-sheet")).toHaveCount(0);
    state.offline = false;
    await page.getByRole("button", { name: translate("en", "common.retry"), exact: true }).click();
    await expect(page.locator(".report-cover")).toContainText("Repository beta");
  });

  test(`${kind} report localizes all languages without fetching again and exports unclipped A4 pages`, async ({ page }, testInfo) => {
    test.setTimeout(90000);
    const state = await mockApi(page);
    state.reportFindings = [structuredClone(reportFinding)];
    state.runs[0].severity.high = 1;
    state.runs[0].severity.total = 1;
    state.findings = [{ ...reportFinding, identity: "fixture-identity", lifecycle: "persisting", sourceScanId: "scan-one", triage: { status: "false_positive", note: null, updatedAt: null } }];
    // Six profiles exercise the densest supported comparison ranking.
    if (kind === "compare") state.runs.push(...Array.from({ length: 4 }, (_, i) => ({ ...structuredClone(baseRun), id: `scan-${i + 3}`, model: `Long model profile ${i + 3}`, displayName: `Repository ${i + 3}` })));
    for (const [index, run] of state.runs.entries()) run.cost = { estimatedUsd: (index + 1) * 1.23, inputTokens: 123456, cachedInputTokens: 2345, cacheWriteInputTokens: 0, outputTokens: 7890 };
    const reportPath = kind === "compare" ? `/compare/report?ids=${state.runs.map((run) => run.id).join(",")}&objective=speed` : path;
    await page.goto(reportPath);
    await expect(page.locator(".report-cover")).toBeVisible();
    const initialRequests = state.requests.filter((item) => item === request).length;
    let current: Locale = "en";
    for (const locale of ["pt-BR", "en", "es", "de", "fr"] as Locale[]) {
      await changeLanguage(page, current, locale);
      current = locale;
      const title = kind === "scan" ? scanReportMessages[locale]["scanReport.documentTitle"].replace("{name}", "Repository alpha") : compareReportMessages[locale]["compareReport.documentTitle"].replace("{count}", "6");
      await expect(page).toHaveTitle(title);
      const cover = kind === "scan" ? scanReportMessages[locale]["scanReport.coverTitle"] : compareReportMessages[locale]["compareReport.coverTitleLead"];
      await expect(page.locator(".report-cover h1")).toContainText(cover);
      if (kind === "scan") {
        await expect(page.getByText(reportFinding.title, { exact: true }).first()).toBeVisible();
        await expect(page.locator("pre").filter({ hasText: "schema.parse(input)" })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (testInfo.project.name === "desktop") {
        // Portaled menus live outside the toolbar and must never enter the PDF.
        await page.getByRole("button", { name: translate(locale, "language.label"), exact: true }).click();
        await expect(page.getByRole("menu")).toBeVisible();
        await page.emulateMedia({ media: "print" });
        await expect(page.getByRole("menu", { includeHidden: true })).toBeHidden();
        await page.evaluate(() => document.fonts.ready);
        const clipped = await page.locator(".report-sheet").evaluateAll((sheets) => sheets.flatMap((sheet, index) => {
          const bounds = sheet.getBoundingClientRect();
          const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
          const failures: string[] = [];
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.textContent?.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              if (!rect.width || !rect.height) continue;
              if (rect.bottom > bounds.bottom + 1 || rect.right > bounds.right + 1 || rect.left < bounds.left - 1) {
                failures.push(`Page ${index + 1}: ${node.textContent.slice(0, 80)}`); break;
              }
            }
          }
          return failures;
        }));
        expect(clipped, `${kind} ${locale}: clipped print text`).toEqual([]);
        const pdf = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true, ...(process.env.CSB_E2E_EVIDENCE_DIR ? { path: `${process.env.CSB_E2E_EVIDENCE_DIR}/${kind}-${locale}.pdf` } : {}) });
        expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
        await page.emulateMedia({ media: "screen" });
        await page.keyboard.press("Escape");
      }
    }
    expect(state.requests.filter((item) => item === request)).toHaveLength(initialRequests);
    if (process.env.CSB_E2E_EVIDENCE_DIR) {
      await page.locator(".report-cover").screenshot({ path: `${process.env.CSB_E2E_EVIDENCE_DIR}/${kind}-cover-${testInfo.project.name}.png` });
      await page.locator(".report-sheet").nth(1).screenshot({ path: `${process.env.CSB_E2E_EVIDENCE_DIR}/${kind}-executive-${testInfo.project.name}.png` });
    }
  });
}

test("comparison report rejects fewer than two distinct scan IDs", async ({ page }) => {
  const state = await mockApi(page, "de");
  await page.goto("/compare/report?ids=scan-one,scan-one");
  await expect(page.getByRole("alert")).toContainText(compareReportMessages.de["compareReport.invalidSelection"]);
  expect(state.requests).not.toContain("POST /compare");
  await expect(page.locator(".report-sheet")).toHaveCount(0);
});
