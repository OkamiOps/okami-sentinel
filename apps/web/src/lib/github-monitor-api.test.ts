import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubMonitorClient } from "./github-monitor-api.js";

test("reads a repository-specific monitor overview without browser credentials", async () => {
  const calls: Array<{ method: string; path: string; csrf: string | null }> = [];
  const client = createGitHubMonitorClient(async (input, init) => {
    const request = new Request(`http://sentinel.local${String(input)}`, init);
    calls.push({ method: request.method, path: `${new URL(request.url).pathname}${new URL(request.url).search}`, csrf: request.headers.get("x-csrf-token") });
    return Response.json({ overview: { rules: [], events: [], actionsRuns: [], summary: { enabledRules: 0, queuedEvents: 0, dispatchingEvents: 0, lastPolledAt: null, lastError: null, checkoutAvailable: false } } });
  });

  await client.overview("github.com/acme/sentinel");
  assert.deepEqual(calls, [{ method: "GET", path: "/api/github-monitor/overview?repositoryKey=github.com%2Facme%2Fsentinel", csrf: null }]);
});

test("keeps the monitor rule and checkout mutations inside Sentinel CSRF scope", async () => {
  const calls: Array<{ method: string; path: string; csrf: string | null; body: string }> = [];
  const client = createGitHubMonitorClient(async (input, init) => {
    const request = new Request(`http://sentinel.local${String(input)}`, init);
    const path = new URL(request.url).pathname;
    calls.push({ method: request.method, path, csrf: request.headers.get("x-csrf-token"), body: await request.text() });
    if (path.endsWith("/security-session")) return Response.json({ csrfToken: "browser-only" });
    if (path.includes("github-checkouts")) return Response.json({ checkout: {} });
    return Response.json({ rule: {} });
  });

  await client.createRule({
    repositoryKey: "github.com/acme/sentinel",
    executor: "sentinel-managed",
    scanner: null,
    costCeilingUsd: null,
    dailyCostCeilingUsd: null,
    followBranches: ["main"],
    checkoutMode: "none",
    enabled: false,
  });
  await client.checkoutSync("github.com/acme/sentinel", "fetch");

  assert.deepEqual(calls, [
    { method: "GET", path: "/api/security-session", csrf: null, body: "" },
    { method: "POST", path: "/api/github-monitor/rules", csrf: "browser-only", body: "{\"repositoryKey\":\"github.com/acme/sentinel\",\"executor\":\"sentinel-managed\",\"scanner\":null,\"costCeilingUsd\":null,\"dailyCostCeilingUsd\":null,\"followBranches\":[\"main\"],\"checkoutMode\":\"none\",\"enabled\":false}" },
    { method: "POST", path: "/api/github-checkouts/github.com%2Facme%2Fsentinel/fetch", csrf: "browser-only", body: "{\"remote\":\"origin\"}" },
  ]);
});
