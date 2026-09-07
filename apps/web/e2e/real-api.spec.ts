import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { MetricsSummary, ScanRun } from "@csb/shared";

const fixtureRoot = requiredEnvironment("CSB_E2E_FIXTURE_ROOT");
const apiPort = requiredPort("CSB_E2E_API_PORT");
const apiBase = `http://127.0.0.1:${apiPort}`;
const repositoryPath = path.join(fixtureRoot, "repository");
const apiPidPath = path.join(fixtureRoot, "api.pid");
const networkLogPath = path.join(fixtureRoot, "network.jsonl");

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real API E2E suite`);
  return value;
}

function requiredPort(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid local port`);
  }
  return value;
}

async function startControlledScan(
  request: APIRequestContext,
  displayName: string,
  paths: string[],
): Promise<ScanRun> {
  const response = await request.post("/api/scans", {
    data: {
      repositoryPath,
      displayName,
      engine: "codex-security",
      authMode: "chatgpt",
      model: "gpt-5.6-terra",
      effort: "high",
      mode: "standard",
      paths,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { scan: ScanRun }).scan;
}

async function readScan(request: APIRequestContext, id: string): Promise<ScanRun> {
  const response = await request.get(`/api/scans/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json() as { scan: ScanRun }).scan;
}

function markRunOlderThanNativeGrace(id: string): void {
  const repositoryRoot = requiredEnvironment("CSB_E2E_REPOSITORY_ROOT");
  const apiRequire = createRequire(path.join(repositoryRoot, "apps", "api", "package.json"));
  const Database = apiRequire("better-sqlite3") as new (filename: string) => {
    prepare(sql: string): { run(...values: unknown[]): void };
    close(): void;
  };
  const database = new Database(path.join(fixtureRoot, "data", "benchmark.db"));
  try {
    database.prepare("UPDATE runs SET started_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), id);
  } finally {
    database.close();
  }
}

function currentApiPid(): number {
  const value = Number(fs.readFileSync(apiPidPath, "utf8").trim());
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("The API supervisor did not record a process id");
  return value;
}

async function isApiReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function externalNetworkEvents(): Array<{ action: "stubbed" | "blocked"; url: string }> {
  return fs.existsSync(networkLogPath)
    ? fs.readFileSync(networkLogPath, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { action: "stubbed" | "blocked"; url: string })
    : [];
}

test("real API and SQLite retain an active controlled scan across restart, expose incomplete attention, cancel in the UI, and render the report", async ({ page, request }) => {
  test.setTimeout(60_000);
  const browserExternalRequests: string[] = [];
  page.on("request", (outgoing) => {
    const url = new URL(outgoing.url());
    if (url.protocol.startsWith("http") && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      browserExternalRequests.push(url.href);
    }
  });

  const live = await startControlledScan(request, "E2E controlled live scan", ["controlled-live"]);
  const incomplete = await startControlledScan(request, "E2E interrupted scan", ["controlled-incomplete"]);
  assert.notEqual(live.pid, null, "the live scan must own a real controlled scanner process");
  assert.notEqual(incomplete.pid, null, "the interrupted scan must own a real controlled scanner process");

  await page.goto(`/scans/${live.id}`);
  await expect(page.getByRole("heading", { name: live.displayName, exact: true })).toBeVisible();
  await expect(page.locator("pre")).toContainText("E2E scanner fixture active");
  await expect(page.getByRole("button", { name: "Cancel process", exact: true })).toBeVisible();

  // The scanner fixture has already sealed evidence. Aging only this private
  // SQLite row models a process that was running before the native recovery
  // grace period, without weakening that production guardrail.
  markRunOlderThanNativeGrace(incomplete.id);
  const firstApiPid = currentApiPid();
  process.kill(firstApiPid, "SIGTERM");
  await expect.poll(isApiReachable, { timeout: 10_000 }).toBe(false);
  process.kill(incomplete.pid!, "SIGTERM");

  await expect.poll(isApiReachable, { timeout: 15_000 }).toBe(true);
  await expect.poll(() => currentApiPid() !== firstApiPid, { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => (await readScan(request, incomplete.id)).status, { timeout: 15_000 }).toBe("incomplete");
  await expect.poll(async () => (await readScan(request, live.id)).status, { timeout: 15_000 }).toBe("running");

  const attentionResponse = await request.get("/api/metrics/summary?status=attention");
  expect(attentionResponse.status()).toBe(200);
  const attention = await attentionResponse.json() as MetricsSummary;
  expect(attention.attentionScans).toBe(1);
  expect(attention.recent.some((run) => run.id === incomplete.id && run.status === "incomplete")).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: live.displayName, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel process", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel process", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await readScan(request, live.id)).status).toBe("cancelled");

  const reportResponse = await request.get(`/api/scans/${live.id}/report`);
  expect(reportResponse.status()).toBe(200);
  const report = await reportResponse.json() as { scan: ScanRun; findings: Array<{ title: string }> };
  expect(report.scan.status).toBe("cancelled");
  expect(report.findings.map((finding) => finding.title)).toContain("Controlled scanner evidence");

  await page.goto(`/scans/${live.id}/report`);
  await expect(page.locator(".report-cover")).toContainText(live.displayName);
  await expect(page.getByText("Controlled scanner evidence", { exact: true }).first()).toBeVisible();
  const networkEvents = externalNetworkEvents();
  expect(networkEvents.some((event) => event.action === "stubbed" && event.url === "https://openrouter.ai/api/v1/models")).toBe(true);
  expect(networkEvents.every((event) => event.action === "stubbed")).toBe(true);
  expect(browserExternalRequests).toEqual([]);
});
