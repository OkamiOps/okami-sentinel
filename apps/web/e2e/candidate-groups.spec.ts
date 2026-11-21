import { expect, test, type Page } from "@playwright/test";
import type { ScanCandidateGroups, ScanRun } from "@csb/shared";
import { mockApi } from "./fixtures";

const portable: ScanRun["execution"] = {
  executionProfile: "portable", profileVersion: "fixture-v1", methodologyRef: "fixture@v1",
  capabilityCheckId: null, connectionId: "fixture-connection", routeKind: "openai-api", protocol: "openai-responses", authKind: "api-key",
};

const grouped: ScanCandidateGroups = {
  scanId: "scan-one", recorded: true, rule: "same-category-attacker-primary-anchor-v1", candidates: 7, reviewed: 4,
  groups: [
    {
      representativeId: "orders-tenant-check", memberIds: ["orders-tenant-check", "orders-tenant-review", "orders-tenant-deep"],
      members: [
        { id: "orders-tenant-check", category: "authorization", hypothesis: "GET /orders/:id loads an order without checking that it belongs to the caller's tenant.", anchors: [{ path: "src/routes/orders.ts", startLine: 41, endLine: 46, role: "control" }, { path: "src/routes/orders.ts", startLine: 52, endLine: 52, role: "sink" }] },
        { id: "orders-tenant-review", category: "authorization", hypothesis: "The order lookup trusts the supplied identifier and may return another tenant's order.", anchors: [{ path: "src/routes/orders.ts", startLine: 43, endLine: 47, role: "control" }] },
        { id: "orders-tenant-deep", category: "Authorization", hypothesis: "Missing tenant scoping before the order is serialized.", anchors: [{ path: "src/routes/orders.ts", startLine: 41, endLine: 44, role: "control" }, { path: "src/routes/orders.ts", startLine: 52, endLine: 53, role: "sink" }] },
      ],
      verdict: { status: "rejected", stage: "validation", reason: "not-vulnerable" },
    },
    {
      representativeId: "export-sql", memberIds: ["export-sql", "export-sql-review"],
      members: [
        { id: "export-sql", category: "injection", hypothesis: "The export filter is concatenated into a raw SQL query.", anchors: [{ path: "src/reports/export.ts", startLine: 88, endLine: 88, role: "sink" }] },
        { id: "export-sql-review", category: "injection", hypothesis: "User-controlled sort column reaches db.raw without an allowlist.", anchors: [{ path: "src/reports/export.ts", startLine: 88, endLine: 90, role: "sink" }] },
      ],
      verdict: { status: "confirmed", stage: "validation", reason: "untrusted-flow-reaches-sink" },
    },
  ],
};

async function openPortableScan(page: Page, groups?: ScanCandidateGroups) {
  const state = await mockApi(page, "pt-BR", groups ? { candidateGroups: { "scan-one": groups } } : {});
  state.runs[0] = { ...state.runs[0]!, execution: portable };
  await page.goto("/scans/scan-one");
  return page.getByRole("region", { name: "Duplicatas agrupadas" });
}

async function evidence(page: Page, name: string) {
  const directory = process.env.SENTINEL_SCREENSHOT_DIR;
  if (directory && test.info().project.name === "desktop") {
    await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
  }
}

test("scan page shows deterministic groups and the verdict every member shares", async ({ page }) => {
  const panel = await openPortableScan(page, grouped);
  await expect(panel.getByRole("status")).toHaveText("Candidatos: 7 · Revisões por IA: 4 · Grupos: 2");
  const tenant = panel.getByRole("listitem", { name: "authorization · 3 membros" });
  await expect(tenant).toContainText("Rejeitado · not-vulnerable");
  await expect(tenant.getByText("Revisado pela IA")).toHaveCount(1);
  await expect(tenant.getByText("Herda o veredito")).toHaveCount(2);
  await expect(panel.getByRole("listitem", { name: "injection · 2 membros" })).toContainText("Confirmado · untrusted-flow-reaches-sink");
  await panel.scrollIntoViewIfNeeded();
  await evidence(page, "candidate-groups");
});

test("scans that predate grouping say every candidate is reviewed on its own", async ({ page }) => {
  const panel = await openPortableScan(page);
  await expect(panel).toContainText("O agrupamento não foi registrado neste scan");
  await expect(panel.getByRole("listitem")).toHaveCount(0);
  await panel.scrollIntoViewIfNeeded();
  await evidence(page, "candidate-groups-legacy");
});

test("non-portable scans do not request candidate groups", async ({ page }) => {
  const state = await mockApi(page, "pt-BR");
  await page.goto("/scans/scan-one");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(state.requests.some((request) => request.endsWith("/candidate-groups"))).toBe(false);
});
