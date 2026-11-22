import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { mockApi } from "./fixtures";

for (const reason of ["budget", "stage", "provider", "rate"] as const) {
  test(`resume ${reason} partial scan reuses stages and reports API errors`, async ({ page }, testInfo) => {
    const state = await mockApi(page, "pt-BR");
    const scan = state.runs[0];
    scan.status = reason === "stage" ? "failed" : "incomplete";
    scan.resume = { suggestedMaxCostUsd: 400 };
    if (reason === "budget") {
      scan.statusReason = "budget_exhausted";
      scan.budgetPartial = { stopReason: "budget", spentUsd: 198.5, maxCostUsd: 200,
        completed: [{ stage: "inventory", page: "inventory", artifactPath: null }, { stage: "threat-model", page: "threat-model", artifactPath: null }],
        interrupted: { stage: "discovery", page: "03", artifactPath: null },
        pending: [{ stage: "validation", page: null, artifactPath: null }] };
    }
    if (reason === "provider" || reason === "rate") {
      scan.statusReason = "provider_unavailable";
      scan.providerPartial = { stopReason: reason === "rate" ? "rate_limited" : "provider_unreachable",
        completed: [{ stage: "inventory", page: "inventory", artifactPath: null }, { stage: "threat-model", page: "threat-model", artifactPath: null }],
        interrupted: { stage: "discovery", page: "03", artifactPath: null },
        pending: [{ stage: "validation", page: null, artifactPath: null }] };
    }
    let fail = true;
    await page.route("**/api/scans/scan-one/resume", async route => {
      expect(route.request().postDataJSON()).toEqual({ maxCostUsd: 500 });
      await route.fulfill({ status: fail ? 422 : 201, contentType: "application/json", body: JSON.stringify(fail ? { error: "O teto deve superar o gasto anterior", code: "resume_budget_cap_must_exceed_prior_spend_and_cap" } : { scanId: "scan-two" }) });
    });
    await page.setViewportSize(testInfo.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.goto("/scans/scan-one");
    const button = page.getByRole("button", { name: "Retomar scan", exact: true });
    await expect(button).toBeVisible();
    await expect(page.getByText(/As etapas salvas serão reutilizadas/)).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Novo teto total (USD)" })).toHaveValue("400");
    await button.scrollIntoViewIfNeeded();
    if (reason === "provider" || reason === "rate") {
      const heading = page.getByRole("heading", { name: reason === "provider" ? "Scan parcial · provedor indisponível" : "Scan parcial · limite de taxa do provedor" });
      await expect(heading).toBeVisible();
      await expect(page.getByText(/Reservas de chamadas sem confirmação continuam no orçamento/)).toBeVisible();
      await heading.scrollIntoViewIfNeeded();
    }
    const screenshots = path.join(homedir(), "screenshots");
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, `resume-${reason}-${testInfo.project.name}.png`), scale: "css" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("spinbutton").fill("500");
    await button.click();
    await expect(page.getByRole("alert").filter({ hasText: "O teto deve superar" })).toBeVisible();
    fail = false;
    await button.click();
    await expect(page).toHaveURL(/\/scans\/scan-two$/);
  });
}

test("non-resumable partial scan does not offer a resume button", async ({ page }) => {
  const state = await mockApi(page);
  state.runs[0].status = "failed";
  await page.goto("/scans/scan-one");
  await expect(page.getByRole("heading", { name: "Repository alpha", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume scan", exact: true })).toHaveCount(0);
});
