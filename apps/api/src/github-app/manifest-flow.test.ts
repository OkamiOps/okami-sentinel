import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_APP_MANIFEST_PERMISSIONS,
  GitHubAppManifestFlow,
  ManifestFlowError,
} from "./manifest-flow.js";

function fixture() {
  let now = new Date("2026-08-12T12:00:00.000Z");
  const flow = new GitHubAppManifestFlow({
    callbackUrl: "http://127.0.0.1:8787/guardrails/github-app/manifest/callback",
    localOrigin: "http://127.0.0.1:8787",
    now: () => now,
  });
  return {
    flow,
    advance(ms: number) { now = new Date(now.getTime() + ms); },
  };
}

test("uses the exact least-privilege GitHub App manifest contract", () => {
  assert.deepEqual(GITHUB_APP_MANIFEST_PERMISSIONS, {
    actions: "write",
    checks: "write",
    contents: "write",
    metadata: "read",
    pull_requests: "read",
    workflows: "write",
  });
  assert.equal(Object.isFrozen(GITHUB_APP_MANIFEST_PERMISSIONS), true);
  assert.equal(GITHUB_APP_MANIFEST_PERMISSIONS.workflows, "write");

  const { flow } = fixture();
  const started = flow.start();
  const authorization = flow.authorization(started.flowId);
  assert.deepEqual(authorization.manifest.default_permissions, GITHUB_APP_MANIFEST_PERMISSIONS);
  assert.deepEqual(authorization.manifest.default_events, []);
  assert.equal(authorization.manifest.public, true);
  assert.equal(authorization.manifest.name, "OKAMI Sentinel Guardrails");
  assert.equal(authorization.manifest.description, "Evidence-backed repository security guardrails");
});

test("creates high-entropy state without returning it in the public start response", () => {
  const { flow } = fixture();
  const first = flow.start();
  const second = flow.start();
  assert.deepEqual(Object.keys(first).sort(), ["authorizeUrl", "flowId"]);
  assert.equal(JSON.stringify(first).includes("state"), false);
  assert.notEqual(first.flowId, second.flowId);

  const firstAuthorization = flow.authorization(first.flowId);
  const secondAuthorization = flow.authorization(second.flowId);
  assert.match(firstAuthorization.state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(firstAuthorization.state, secondAuthorization.state);
  assert.equal(first.authorizeUrl, `http://127.0.0.1:8787/guardrails/github-app/manifest/authorize/${first.flowId}`);
  assert.equal(firstAuthorization.actionUrl.startsWith("https://github.com/settings/apps/new?state="), true);
});

test("consumes state once and rejects replay or a callback for another flow", () => {
  const { flow } = fixture();
  const first = flow.start();
  const second = flow.start();
  const firstState = flow.authorization(first.flowId).state;
  const secondState = flow.authorization(second.flowId).state;

  assert.throws(
    () => flow.beginCallback(first.flowId, secondState, null),
    (error: unknown) => error instanceof ManifestFlowError && error.code === "manifest_state_invalid",
  );
  assert.deepEqual(flow.beginCallback(first.flowId, firstState, null), {
    flowId: first.flowId,
    status: "exchanging",
  });
  assert.throws(
    () => flow.beginCallback(first.flowId, firstState, null),
    (error: unknown) => error instanceof ManifestFlowError && error.code === "manifest_state_invalid",
  );
});

test("expires flows and closes explicit denial without exchanging a code", () => {
  const expiring = fixture();
  const expiringStart = expiring.flow.start();
  const expiringState = expiring.flow.authorization(expiringStart.flowId).state;
  expiring.advance(10 * 60_000 + 1);
  assert.deepEqual(expiring.flow.publicState(expiringStart.flowId), { status: "expired" });
  assert.throws(
    () => expiring.flow.beginCallback(expiringStart.flowId, expiringState, null),
    (error: unknown) => error instanceof ManifestFlowError && error.code === "manifest_flow_expired",
  );

  const denied = fixture();
  const deniedStart = denied.flow.start();
  const deniedState = denied.flow.authorization(deniedStart.flowId).state;
  assert.deepEqual(denied.flow.beginCallback(deniedStart.flowId, deniedState, "access_denied"), {
    flowId: deniedStart.flowId,
    status: "denied",
  });
  assert.deepEqual(denied.flow.publicState(deniedStart.flowId), { status: "denied" });
});

test("does not complete an exchange after the manifest flow expires", () => {
  const expiring = fixture();
  const started = expiring.flow.start();
  const state = expiring.flow.authorization(started.flowId).state;
  expiring.flow.beginCallback(started.flowId, state, null);
  expiring.advance(10 * 60_000 + 1);

  assert.throws(
    () => expiring.flow.complete(started.flowId, "connection-late"),
    (error: unknown) => error instanceof ManifestFlowError && error.code === "manifest_flow_expired",
  );
  assert.deepEqual(expiring.flow.publicState(started.flowId), { status: "expired" });
});

test("polling exposes only closed public state and a completed connection reference", () => {
  const { flow } = fixture();
  const started = flow.start();
  const state = flow.authorization(started.flowId).state;
  assert.deepEqual(flow.publicState(started.flowId), { status: "pending" });
  flow.beginCallback(started.flowId, state, null);
  assert.deepEqual(flow.publicState(started.flowId), { status: "pending" });
  flow.complete(started.flowId, "connection-1");
  assert.deepEqual(flow.publicState(started.flowId), {
    status: "completed",
    connectionId: "connection-1",
  });
  assert.equal(JSON.stringify(flow.publicState(started.flowId)).includes(state), false);
});
