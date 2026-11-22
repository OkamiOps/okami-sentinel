import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { FindingDetail, LifecycleFinding } from "@csb/shared";
import { mockApi, reportFinding } from "./fixtures";
import { scanReportMessages } from "../src/i18n/scan-report";

const sastFinding: FindingDetail = {
  ...reportFinding, findingId: "opengrep-fixture", title: "Execução dinâmica de código",
  origin: { kind: "sast", tool: "opengrep" }, ruleId: "sentinel.javascript-eval",
  summary: "Verifique a origem dos dados antes de executar código dinâmico.",
  primaryPath: "src/handler.ts", codeEvidence: [{ path: "src/handler.ts", startLine: 12, endLine: 12, code: "eval(request.body.code)" }],
};
const aiFinding: FindingDetail = { ...reportFinding, findingId: "ai-fixture", title: "Consulta SQL insegura" };

async function setup(page: Page, partial = false) {
  const state = await mockApi(page, "pt-BR");
  state.runs[0].sast = { status: "completed", tool: "opengrep", version: "2.0.0", count: 1, durationMs: 1250, reason: null };
  const details = partial ? [sastFinding] : [sastFinding, aiFinding];
  state.findings = details.map((finding): LifecycleFinding => ({
    ...finding, identity: finding.findingId, sourceScanId: "scan-one", lifecycle: "new",
    triage: { status: "unreviewed", note: null, updatedAt: null },
  }));
  await page.route("**/api/scans/scan-one/findings/*", route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ finding: details.find(finding => finding.findingId === id) }) });
  });
  if (partial) {
    state.runs[0].status = "incomplete";
    state.runs[0].statusReason = "budget_exhausted";
    state.runs[0].budgetPartial = {
      stopReason: "budget", spentUsd: 0, maxCostUsd: 0.001, completed: [],
      interrupted: { stage: "surface", page: null, artifactPath: null },
      pending: [{ stage: "review", page: null, artifactPath: null }],
    };
  }
  return state;
}

async function capture(page: Page, info: TestInfo, name: string) {
  if (process.env.CSB_SCREENSHOT_DIR && info.project.name === "desktop") {
    await page.screenshot({ path: path.join(process.env.CSB_SCREENSHOT_DIR, name), fullPage: true, animations: "disabled" });
  }
}

test("mixed findings show origin badges, SAST summary, and composable origin filters", async ({ page }, info) => {
  await setup(page);
  await page.goto("/scans/scan-one");
  const card = page.getByRole("region", { name: "Análise estática · OpenGrep" });
  await expect(card).toContainText("Concluído");
  await expect(card).toContainText("1 achados");
  await expect(card).toContainText("Versão 2.0.0");
  await expect(card).toContainText("1,3 s");
  const sast = page.getByRole("button", { name: /Execução dinâmica de código/ });
  const ai = page.getByRole("button", { name: /Consulta SQL insegura/ });
  await expect(sast.getByText("SAST · OpenGrep", { exact: true })).toBeVisible();
  await expect(ai.getByText("IA", { exact: true })).toBeVisible();
  await capture(page, info, "01-scan-mixed.png");

  const origin = page.getByRole("group", { name: "Origem", exact: true });
  await origin.getByRole("button", { name: "SAST", exact: true }).click();
  await expect(ai).toHaveCount(0);
  await expect(sast).toBeVisible();
  await sast.click();
  await expect(page.getByText("SAST · OpenGrep", { exact: true })).toHaveCount(2);
  await expect(page).toHaveURL(/f=opengrep-fixture/);
  await capture(page, info, "02-scan-sast-inspector.png");

  const query = page.getByRole("textbox", { name: "Buscar evidência", exact: true });
  await query.fill("não existe");
  await expect(sast).toHaveCount(0);
  await query.clear();
  await expect(sast).toBeVisible();
  await sast.click();
  await expect(page.getByText("SAST · OpenGrep", { exact: true })).toHaveCount(2);
  await origin.getByRole("button", { name: "IA", exact: true }).click();
  await expect(sast).toHaveCount(0);
  await expect(ai).toBeVisible();
  await expect(page.getByText("Inspector desarmado", { exact: true })).toBeVisible();
  await expect(page.getByText("SAST · OpenGrep", { exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]f=/);
  await ai.click();
  await expect(page.getByText("IA", { exact: true })).toHaveCount(3);
  await origin.getByRole("button", { name: "Todos", exact: true }).click();
  await expect(sast).toBeVisible();
  await expect(ai).toBeVisible();
});

test("budget-partial scan retains SAST summary and inspectable findings", async ({ page }, info) => {
  await setup(page, true);
  await page.goto("/scans/scan-one");
  await expect(page.getByRole("heading", { name: "Parcial por orçamento", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Análise estática · OpenGrep" })).toContainText("Concluído");
  await page.getByRole("button", { name: /Execução dinâmica de código/ }).click();
  await expect(page.getByText("SAST · OpenGrep", { exact: true })).toHaveCount(2);
  await capture(page, info, "03-scan-budget-partial.png");
});

for (const [status, label, reason] of [
  ["failed", "Falhou", "invalid_json"], ["skipped", "Ignorado", "binary_missing"], ["timeout", "Tempo esgotado", "timeout"],
] as const) {
  test(`SAST ${status} status remains visible without findings`, async ({ page }) => {
    const state = await setup(page);
    state.findings = [];
    state.runs[0].sast = { status, tool: "opengrep", version: null, count: 0, durationMs: 50, reason };
    await page.goto("/scans/scan-one");
    const card = page.getByRole("region", { name: "Análise estática · OpenGrep" });
    await expect(card).toContainText(label);
    await expect(card).toContainText("0 achados");
    await expect(card).toContainText("Versão não informada");
    if (status === "skipped") await expect(card).toContainText("Binário não encontrado");
    if (status === "failed") await expect(card).toContainText("Saída JSON inválida");
  });
}

test("scan report keeps OpenGrep alerts out of AI totals and lists them separately", async ({ page }) => {
  const state = await setup(page);
  state.reportFindings = [sastFinding, aiFinding];
  state.runs[0].severity.high = 1;
  state.runs[0].severity.total = 1;
  await page.goto("/scans/scan-one/report");
  await expect(page.getByText("1 findings critical/high possuem ficha técnica", { exact: false })).toBeVisible();
  await expect(page.getByText("Alertas de análise estática · OpenGrep", { exact: true })).toBeVisible();
  await expect(page.getByText("SAST-001", { exact: true })).toBeVisible();
  await expect(page.getByText("OKS-002", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1 alertas brutos do OpenGrep", { exact: false })).toBeVisible();
  const newMetric = page.locator(".report-metric").filter({ hasText: scanReportMessages["pt-BR"]["scanReport.new"] });
  await expect(newMetric.locator(".report-metric-value")).toHaveText("1");
});

test("scan report paginates long OpenGrep alert lists", async ({ page }) => {
  const state = await setup(page);
  state.reportFindings = Array.from({ length: 13 }, (_, index) => ({ ...sastFinding, findingId: `opengrep-${index}`, title: `Alerta ${String(index).padStart(2, "0")}` }));
  await page.goto("/scans/scan-one/report");
  await expect(page.getByText("Alertas de análise estática · OpenGrep / 2", { exact: true })).toBeVisible();
  await expect(page.getByText("SAST-013", { exact: true })).toBeVisible();
});

test("scan report without OpenGrep alerts has no static analysis sheet", async ({ page }) => {
  const state = await setup(page);
  state.reportFindings = [aiFinding];
  state.runs[0].severity.high = 1;
  state.runs[0].severity.total = 1;
  await page.goto("/scans/scan-one/report");
  await expect(page.getByText("OKS-001", { exact: true })).toBeVisible();
  await expect(page.getByText("Alertas de análise estática · OpenGrep", { exact: false })).toHaveCount(0);
});
