import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.CSB_E2E_WEB_PORT || 4175);
if (!Number.isSafeInteger(webPort) || webPort < 1 || webPort > 65_535) {
  throw new Error("CSB_E2E_WEB_PORT must be a valid local port");
}
const baseURL = `http://127.0.0.1:${webPort}`;

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
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"], browserName: "chromium" } },
  ],
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${webPort} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
