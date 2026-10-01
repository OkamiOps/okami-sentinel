import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "./http.js";
import { createGitHubActionsClient } from "./github-actions-api.js";

interface Call { method: string; path: string; csrf: string | null; body: string }

function client(handle: (path: string, method: string) => Response) {
  const calls: Call[] = [];
  const api = createGitHubActionsClient(async (input, init) => {
    const request = new Request(`http://sentinel.local${String(input)}`, init);
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    calls.push({
      method: request.method,
      path,
      csrf: request.headers.get("x-csrf-token"),
      body: await request.text(),
    });
    if (url.pathname === "/api/auth/session") return Response.json({ csrfToken: "browser-only" });
    return handle(path, request.method);
  });
  return { api, calls };
}

test("reads the integration status with no token and no interval", async () => {
  const { api, calls } = client(() => Response.json({ connections: [], checklist: [] }));
  await api.fetchIntegration();
  assert.deepEqual(calls, [
    { method: "GET", path: "/api/github/integration", csrf: null, body: "" },
  ]);
});

test("stores a webhook secret inside the CSRF scope and never reads it back", async () => {
  const { api, calls } = client(() => new Response(null, { status: 204 }));
  await api.saveWebhookSecret("github-connection", "s".repeat(32));
  assert.deepEqual(calls.map((call) => [call.method, call.path]), [
    ["GET", "/api/auth/session"],
    ["PUT", "/api/github/integration/webhook-secret"],
  ]);
  const write = calls[1]!;
  assert.equal(write.csrf, "browser-only");
  assert.deepEqual(JSON.parse(write.body), {
    connectionId: "github-connection",
    secret: "s".repeat(32),
  });
});

test("pages the deliveries and the consolidated activity", async () => {
  const { api, calls } = client(() => Response.json({ deliveries: [], events: [], limit: 50, offset: 0, hasMore: false }));
  await api.fetchDeliveries(50);
  await api.fetchEvents({ repositoryKey: "github:1", outcome: "skipped", limit: 25, offset: 25 });
  // An absent repository means "every repository the caller can see": the API
  // treats an empty value the same way, so the parameter is simply left off.
  await api.fetchEvents({});
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/github/deliveries?limit=50",
    "/api/github/events?repositoryKey=github%3A1&outcome=skipped&limit=25&offset=25",
    "/api/github/events",
  ]);
});

test("reconciles through the CSRF scope and reports a joined cycle", async () => {
  const { api, calls } = client(() => Response.json({
    repositories: 2, created: 1, observed: 0, errors: 0, joined: true,
  }));
  const result = await api.reconcileNow();
  assert.equal(result.joined, true);
  assert.equal(result.created, 1);
  assert.deepEqual(calls.map((call) => [call.method, call.path, call.csrf]), [
    ["GET", "/api/auth/session", null],
    ["POST", "/api/github/reconcile", "browser-only"],
  ]);
});

test("lists, creates, patches and deletes actions on the actions routes", async () => {
  const { api, calls } = client((path, method) => {
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (path.startsWith("/api/github/actions?")) {
      return Response.json({ actions: [], limit: 200, offset: 0, hasMore: false });
    }
    return Response.json({ action: { id: "a1" } });
  });

  await api.fetchActions("github:1");
  await api.fetchActions();
  await api.fetchActions(null, { limit: 50, offset: 50 });
  await api.createAction({
    repositoryKey: "github:1", name: "PR deep", triggerKind: "pull_request",
    branchPatterns: ["main"], executor: "sentinel-managed", scanner: null,
    costCeilingUsd: 2, dailyCostCeilingUsd: null, enabled: false, includeForks: false,
  });
  await api.patchAction("a1", { enabled: false });
  await api.deleteAction("a 1/b");
  await api.fetchActionEvents("a1", 10);

  assert.deepEqual(calls.filter((call) => call.path !== "/api/auth/session")
    .map((call) => [call.method, call.path]), [
    ["GET", "/api/github/actions?repositoryKey=github%3A1"],
    ["GET", "/api/github/actions"],
    ["GET", "/api/github/actions?limit=50&offset=50"],
    ["POST", "/api/github/actions"],
    ["PATCH", "/api/github/actions/a1"],
    // The id is a path segment, so it is encoded and cannot climb out of it.
    ["DELETE", "/api/github/actions/a%201%2Fb"],
    ["GET", "/api/github/actions/a1/events?limit=10"],
  ]);
  assert.deepEqual(
    JSON.parse(calls.find((call) => call.method === "PATCH")!.body),
    { enabled: false },
  );
});

test("reads the live branches of a repository", async () => {
  const { api, calls } = client(() => Response.json({ branches: ["main", "release/1"] }));
  assert.deepEqual(await api.fetchBranches("github:1"), ["main", "release/1"]);
  assert.deepEqual(calls.map((call) => call.path), ["/api/github/branches?repositoryKey=github%3A1"]);
});

/**
 * The page has to tell a maintainer "an administrator has to do this" apart from
 * "that repository is not yours", so the refusal has to arrive as a code with a
 * status and not as a rendered sentence.
 */
test("surfaces a refusal as a typed error the page can translate", async () => {
  const { api } = client(() => Response.json({ error: "forbidden" }, { status: 403 }));
  await assert.rejects(api.fetchIntegration(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 403);
    assert.equal(error.message, "forbidden");
    return true;
  });

  const conflict = client(() => Response.json({ error: "github_action_name_taken" }, { status: 409 }));
  await assert.rejects(conflict.api.patchAction("a1", { name: "PR deep" }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.message, "github_action_name_taken");
    return true;
  });

  // A 204 carries no body, and parsing one as JSON would turn success into
  // `empty_api_response`.
  const deleted = client(() => new Response(null, { status: 204 }));
  await deleted.api.deleteAction("a1");
});
