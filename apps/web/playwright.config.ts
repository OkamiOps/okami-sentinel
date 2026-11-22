import { defineConfig, devices } from "@playwright/test";
import { e2ePreviewServer } from "./src/lib/e2e-web-port";

const preview = e2ePreviewServer();

export default defineConfig({
  testDir: "./e2e",
  // Real API/SQLite coverage owns private processes and has a dedicated
  // launcher; keeping it out of the mocked CI grid prevents accidental use of
  // workstation state or ports.
  testIgnore: "real-api.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: "list",
  outputDir: "../../output/playwright-improvements/test-results",
  use: {
    baseURL: preview.baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"], browserName: "chromium" } },
  ],
  webServer: {
    command: preview.command,
    url: preview.url,
    reuseExistingServer: preview.reuseExistingServer,
    timeout: 30_000,
  },
});
