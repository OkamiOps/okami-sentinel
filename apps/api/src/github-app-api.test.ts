import assert from "node:assert/strict";
import test from "node:test";

import type {
  GitHubAppConnectionMetadata,
  GitHubAppInstallationMetadata,
  GitHubInstallationRepositoryMetadata,
} from "./gate-store.js";
import { createGitHubAppApi, type GitHubAppApiService } from "./github-app-api.js";

function fixture() {
  const calls = {
    callback: [] as unknown[],
    disconnected: [] as string[],
    installationConnections: [] as string[],
    repositoryInstallations: [] as string[],
  };
  const connection: GitHubAppConnectionMetadata = {
    id: "connection-1", appId: "123", appSlug: "sentinel-local", clientId: "Iv1.client",
    status: "ready", createdAt: "2026-08-12T12:00:00.000Z", updatedAt: "2026-08-12T12:00:00.000Z",
  };
  const installation: GitHubAppInstallationMetadata = {
    id: "77", connectionId: "connection-1", accountLogin: "OkamiOps",
    accountType: "Organization", status: "ready",
    createdAt: "2026-08-12T12:00:00.000Z", updatedAt: "2026-08-12T12:00:00.000Z",
  };
  const repository: GitHubInstallationRepositoryMetadata = {
    repositoryId: "9001", installationId: "77", owner: "OkamiOps", name: "sentinel",
    defaultBranch: "main", private: true, archived: false, updatedAt: "2026-08-12T12:00:00.000Z",
  };
  const service: GitHubAppApiService = {
    startManifest: () => ({ flowId: "flow-1", authorizeUrl: "http://127.0.0.1:8787/authorize/flow-1" }),
    manifestAuthorization: () => ({
      actionUrl: "https://github.com/settings/apps/new?state=private-state",
      state: "private-state",
      manifest: {
        name: "Okami Sentinel Local",
        url: "https://github.com/OkamiOps/okami-sentinel",
        description: "Local-first repository security guardrails",
        redirect_url: "http://127.0.0.1:8787/callback?flowId=flow-1",
        public: false,
        default_permissions: {
          actions: "write", checks: "write", contents: "read", metadata: "read", pull_requests: "read",
        },
        default_events: [],
        request_oauth_on_install: false,
      },
    }),
    manifestState: () => ({ status: "pending" }),
    completeManifestCallback: async (input) => {
      calls.callback.push(input);
      return { status: "completed", connectionId: "connection-1" };
    },
    listConnections: () => [connection],
    refreshInstallations: async (connectionId) => {
      calls.installationConnections.push(connectionId);
      return [installation];
    },
    refreshRepositories: async (installationId) => {
      calls.repositoryInstallations.push(installationId);
      return [repository];
    },
    disconnect: async (connectionId) => { calls.disconnected.push(connectionId); },
  };
  return { api: createGitHubAppApi(service), calls, connection, installation, repository };
}

test("covers the seven public GitHub App routes without exposing flow state or credentials", async () => {
  const { api, calls, connection, installation, repository } = fixture();

  const started = await api.request("/guardrails/github-app/manifest/start", { method: "POST" });
  assert.equal(started.status, 201);
  const startedText = await started.text();
  assert.deepEqual(JSON.parse(startedText), {
    flowId: "flow-1",
    authorizeUrl: "http://127.0.0.1:8787/authorize/flow-1",
  });
  assert.equal(startedText.includes("private-state"), false);

  const poll = await api.request("/guardrails/github-app/manifest/flows/flow-1");
  assert.deepEqual(await poll.json(), { flow: { status: "pending" } });

  const callback = await api.request(
    "/guardrails/github-app/manifest/callback?flowId=flow-1&state=state-value&code=code-value&installation_id=attacker-value",
  );
  assert.equal(callback.status, 200);
  assert.equal((await callback.text()).includes("connection-1"), false);
  assert.deepEqual(calls.callback, [{
    flowId: "flow-1", state: "state-value", code: "code-value", error: null,
  }]);

  const connections = await api.request("/guardrails/github-app/connections");
  assert.deepEqual(await connections.json(), {
    connections: [{
      ...connection,
      installationUrl: "https://github.com/apps/sentinel-local/installations/new",
    }],
  });

  const installations = await api.request("/guardrails/github-app/connections/connection-1/installations");
  assert.deepEqual(await installations.json(), { installations: [installation] });
  assert.deepEqual(calls.installationConnections, ["connection-1"]);

  const repositories = await api.request("/guardrails/github-app/installations/77/repositories");
  assert.deepEqual(await repositories.json(), { repositories: [repository] });
  assert.deepEqual(calls.repositoryInstallations, ["77"]);

  const disconnected = await api.request("/guardrails/github-app/connections/connection-1", { method: "DELETE" });
  assert.deepEqual(await disconnected.json(), { ok: true });
  assert.deepEqual(calls.disconnected, ["connection-1"]);
});

test("renders an auto-submit POST bridge with the manifest but no response-side token", async () => {
  const { api } = fixture();
  const response = await api.request("/guardrails/github-app/manifest/authorize/flow-1");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /form-action https:\/\/github\.com/);
  assert.match(html, /method="post"/i);
  assert.match(html, /name="manifest"/i);
  assert.match(html, /&quot;contents&quot;:&quot;read&quot;/);
  assert.doesNotMatch(html, /pem|privateKey|installation[_-]?token/i);
});

test("guides a completed manifest connection into the separate GitHub installation step", async () => {
  const { api } = fixture();
  const response = await api.request(
    "/guardrails/github-app/manifest/callback?flowId=flow-1&state=state-value&code=code-value",
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /https:\/\/github\.com\/apps\/sentinel-local\/installations\/new/);
  assert.match(html, /Instalar no GitHub/);
  assert.doesNotMatch(html, /connection-1|privateKey|installation[_-]?token/i);
});

test("returns closed errors and never serializes arbitrary upstream messages", async () => {
  const { api } = fixture();
  const failing = createGitHubAppApi({
    startManifest: () => { throw new Error("private token ghs_should_not_escape"); },
    manifestAuthorization: () => { throw new Error("unused"); },
    manifestState: () => { throw new Error("unused"); },
    completeManifestCallback: async () => { throw new Error("unused"); },
    listConnections: () => [],
    refreshInstallations: async () => [],
    refreshRepositories: async () => [],
    disconnect: async () => undefined,
  });

  const response = await failing.request("/guardrails/github-app/manifest/start", { method: "POST" });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "github_app_operation_failed" });
});
