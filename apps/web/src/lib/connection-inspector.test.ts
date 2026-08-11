import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderAuthFlow, ProviderModel } from "@csb/shared";

import {
  authFlowPresentation,
  createAuthFlowPoller,
  disconnectMessageForStatus,
  probeSelectionForModel,
} from "./connection-inspector.js";

function flow(status: ProviderAuthFlow["status"] = "pending"): ProviderAuthFlow {
  return {
    flowId: "flow-a",
    status,
    authUrl: "https://accounts.example.test/authorize",
    verificationUrl: "https://accounts.example.test/device",
    userCode: "ABCD-EFGH",
    expiresAt: "2026-08-11T18:00:00.000Z",
  };
}

function model(id: string): ProviderModel {
  return {
    connectionId: "connection-a",
    id,
    displayName: id,
    contextWindow: null,
    capabilities: {
      tools: "unknown", artifactOutput: "unknown", structuredOutput: "unknown",
      boundedExecution: "unknown", osIsolation: "unknown", streaming: "unknown",
      usage: "unknown", cancellation: "unknown",
    },
    pricing: null,
    discoveredAt: "2026-08-11T17:00:00.000Z",
    source: "provider-api",
  };
}

function manualScheduler() {
  const callbacks: Array<() => void> = [];
  return {
    schedule(callback: () => void) { callbacks.push(callback); return callback; },
    clear(handle: unknown) {
      const callback = handle as () => void;
      const index = callbacks.indexOf(callback);
      if (index >= 0) callbacks.splice(index, 1);
    },
    async runNext() { await callbacks.shift()?.(); },
    get size() { return callbacks.length; },
  };
}

test("polls an auth flow only until terminal and keeps the public presentation token-free", async () => {
  const scheduler = manualScheduler();
  const observed: ProviderAuthFlow[] = [];
  const starts: Array<{ connectionId: string; mode: string }> = [];
  let reads = 0;
  const poller = createAuthFlowPoller({
    client: {
      async startAuth(connectionId, mode) { starts.push({ connectionId, mode }); return flow(); },
      async getAuth() { reads += 1; return flow(reads === 1 ? "pending" : "completed"); },
      async cancelAuth() {},
    },
    onFlow(next) { if (next) observed.push(next); },
    schedule: scheduler.schedule,
    clearSchedule: scheduler.clear,
    now: () => new Date("2026-08-11T17:00:00.000Z"),
  });

  await poller.start("connection-a", "device-code");
  assert.deepEqual(starts, [{ connectionId: "connection-a", mode: "device-code" }]);
  assert.equal(scheduler.size, 1);
  await scheduler.runNext();
  assert.equal(scheduler.size, 1);
  await scheduler.runNext();

  assert.equal(observed.at(-1)?.status, "completed");
  assert.equal(scheduler.size, 0);
  assert.deepEqual(authFlowPresentation(flow()), {
    authUrl: "https://accounts.example.test/authorize",
    verificationUrl: "https://accounts.example.test/device",
    userCode: "ABCD-EFGH",
    expiresAt: "2026-08-11T18:00:00.000Z",
  });
  assert.equal(JSON.stringify(authFlowPresentation(flow())).includes("token"), false);
});

test("cancels the active remote auth flow on connection change or unmount", async () => {
  const scheduler = manualScheduler();
  const cancelled: Array<{ connectionId: string; flowId: string }> = [];
  const poller = createAuthFlowPoller({
    client: {
      async startAuth() { return flow(); },
      async getAuth() { return flow(); },
      async cancelAuth(connectionId, flowId) { cancelled.push({ connectionId, flowId }); },
    },
    onFlow() {},
    schedule: scheduler.schedule,
    clearSchedule: scheduler.clear,
  });

  await poller.start("connection-a", "browser-oauth");
  await poller.dispose();

  assert.deepEqual(cancelled, [{ connectionId: "connection-a", flowId: "flow-a" }]);
  assert.equal(scheduler.size, 0);
});

test("does not report cancellation when remote cancellation fails and resumes polling", async () => {
  const scheduler = manualScheduler();
  const observed: ProviderAuthFlow[] = [];
  let errors = 0;
  const poller = createAuthFlowPoller({
    client: {
      async startAuth() { return flow(); },
      async getAuth() { return flow(); },
      async cancelAuth() { throw new Error("remote cancel unavailable"); },
    },
    onFlow(next) { if (next) observed.push(next); },
    onError() { errors += 1; },
    schedule: scheduler.schedule,
    clearSchedule: scheduler.clear,
  });

  await poller.start("connection-a", "browser-oauth");
  assert.equal(await poller.cancel(), false);

  assert.equal(observed.at(-1)?.status, "pending");
  assert.equal(errors, 1);
  assert.equal(scheduler.size, 1);
});

test("converts a polling error into a visible terminal failure", async () => {
  const scheduler = manualScheduler();
  const observed: ProviderAuthFlow[] = [];
  let errors = 0;
  const poller = createAuthFlowPoller({
    client: {
      async startAuth() { return flow(); },
      async getAuth() { throw new Error("network unavailable"); },
      async cancelAuth() {},
    },
    onFlow(next) { if (next) observed.push(next); },
    onError() { errors += 1; },
    schedule: scheduler.schedule,
    clearSchedule: scheduler.clear,
  });

  await poller.start("connection-a", "browser-oauth");
  await scheduler.runNext();

  assert.equal(observed.at(-1)?.status, "failed");
  assert.equal(errors, 1);
  assert.equal(scheduler.size, 0);
});

test("probes only a model returned by the selected connection catalog", () => {
  const models = [model("live-a"), model("live-b")];
  assert.deepEqual(probeSelectionForModel("connection-a", models, "live-b"), {
    connectionId: "connection-a",
    modelSelectionMode: "catalog",
    modelId: "live-b",
  });
  assert.equal(probeSelectionForModel("connection-a", models, "not-in-catalog"), null);
  assert.equal(probeSelectionForModel("connection-a", models, null), null);
});

test("describes each disconnect outcome without claiming an unsupported revoke succeeded", () => {
  assert.deepEqual(disconnectMessageForStatus("revoked"), {
    key: "connections.operations.disconnectRevoked",
    tone: "success",
  });
  assert.deepEqual(disconnectMessageForStatus("local_removed"), {
    key: "connections.operations.disconnectLocalRemoved",
    tone: "success",
  });
  assert.deepEqual(disconnectMessageForStatus("revoke_pending"), {
    key: "connections.operations.disconnectRevokePending",
    tone: "info",
  });
  assert.deepEqual(disconnectMessageForStatus("not_supported"), {
    key: "connections.operations.disconnectNotSupported",
    tone: "info",
  });
});
