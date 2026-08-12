import assert from "node:assert/strict";
import test from "node:test";

import { createGuardrailsGitHubAppClient } from "../api.js";
import {
  canEnrollGuardrailRepository,
  enrollmentRequest,
  initialEnrollmentState,
  selectEnrollmentConnection,
  selectEnrollmentInstallation,
  selectEnrollmentSource,
  type GuardrailEnrollmentState,
} from "./guardrails-enrollment.js";

test("local and GitHub enrollment bodies never mix filesystem and App authority", () => {
  const local = {
    ...initialEnrollmentState(),
    repositoryPath: "/fixture/repository",
    displayName: "Fixture",
  };
  assert.deepEqual(enrollmentRequest(local), {
    source: "local",
    repositoryPath: "/fixture/repository",
    displayName: "Fixture",
  });

  const github: GuardrailEnrollmentState = {
    ...selectEnrollmentSource(local, "github"),
    connectionId: "connection-1",
    installationId: "77",
    repositoryId: "991122",
    defaultExecutor: "github-actions",
  };
  assert.deepEqual(enrollmentRequest(github), {
    source: "github",
    connectionId: "connection-1",
    installationId: "77",
    repositoryId: "991122",
    defaultExecutor: "github-actions",
    displayName: "Fixture",
  });
  assert.equal("repositoryPath" in enrollmentRequest(github), false);
});

test("changing enrollment authority clears every dependent selection", () => {
  const selected: GuardrailEnrollmentState = {
    ...initialEnrollmentState(),
    source: "github",
    connectionId: "connection-1",
    installationId: "77",
    repositoryId: "991122",
  };
  assert.deepEqual(selectEnrollmentConnection(selected, "connection-2"), {
    ...selected,
    connectionId: "connection-2",
    installationId: "",
    repositoryId: "",
  });
  assert.deepEqual(selectEnrollmentInstallation(selected, "88"), {
    ...selected,
    installationId: "88",
    repositoryId: "",
  });
  const local = selectEnrollmentSource(selected, "local");
  assert.equal(local.connectionId, "");
  assert.equal(local.installationId, "");
  assert.equal(local.repositoryId, "");
});

test("an unavailable executor prevents remote enrollment", () => {
  const state: GuardrailEnrollmentState = {
    ...initialEnrollmentState(),
    source: "github",
    connectionId: "connection-1",
    installationId: "77",
    repositoryId: "991122",
    defaultExecutor: "github-actions",
  };
  assert.equal(canEnrollGuardrailRepository(state, { managed: true, actions: false }), false);
  assert.equal(canEnrollGuardrailRepository(state, { managed: true, actions: true }), true);
  assert.equal(canEnrollGuardrailRepository({ ...state, defaultExecutor: "sentinel-managed" }, { managed: true, actions: false }), true);
});

test("GitHub enrollment client calls only Guardrails GitHub App endpoints", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    const body = String(input).endsWith("/manifest/start")
      ? { flowId: "flow-1", authorizeUrl: "/api/guardrails/github-app/manifest/authorize/flow-1" }
      : { connections: [] };
    return new Response(JSON.stringify(body), {
      status: String(input).endsWith("/manifest/start") ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = createGuardrailsGitHubAppClient(fetcher);
  await client.startManifest();
  await client.listConnections();

  assert.deepEqual(calls, [
    "POST /api/guardrails/github-app/manifest/start",
    "GET /api/guardrails/github-app/connections",
  ]);
  assert.equal(calls.some((call) => call.includes("/connections/")), false);
});

test("GitHub App connections expose only the public installation URL needed by the browser", async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    connections: [{
      id: "connection-1",
      appId: "123",
      appSlug: "sentinel-local",
      clientId: "Iv1.client",
      installationUrl: "https://github.com/apps/sentinel-local/installations/new",
      status: "ready",
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  const [connection] = await createGuardrailsGitHubAppClient(fetcher).listConnections();
  assert.equal(connection?.installationUrl, "https://github.com/apps/sentinel-local/installations/new");
  assert.equal(JSON.stringify(connection).includes("privateKey"), false);
});
