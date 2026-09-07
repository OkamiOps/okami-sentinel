import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(webRoot, "../..");
const e2eScripts = path.join(repositoryRoot, "scripts", "e2e");
const apiPort = requiredPort("CSB_E2E_API_PORT");
const webPort = requiredPort("CSB_E2E_WEB_PORT");
const outputDir = requiredOutputDirectory();

function requiredPort(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid local port`);
  }
  return value;
}

function requiredOutputDirectory(): string {
  const value = process.env.CSB_E2E_OUTPUT_DIR?.trim();
  if (!value || !path.isAbsolute(value)) {
    throw new Error("CSB_E2E_OUTPUT_DIR must be an absolute per-invocation path");
  }
  return value;
}

/**
 * This suite is deliberately separate from `playwright.config.ts`: regular
 * browser regression tests retain their fully mocked API and two-project grid.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "real-api.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  outputDir: path.join(outputDir, "test-results"),
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "real-api-desktop", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `${process.execPath} ${path.join(e2eScripts, "real-api-server.mjs")}`,
      cwd: repositoryRoot,
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `pnpm exec vite --config e2e-support/vite.real-api.config.ts --host 127.0.0.1 --port ${webPort} --strictPort`,
      cwd: webRoot,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
