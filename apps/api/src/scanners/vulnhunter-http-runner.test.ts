import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  CapabilityReport,
  ModelCapabilities,
  ProviderModel,
  ScanConnectionSnapshot,
} from "@csb/shared";
import type { StoredProviderConnection } from "../connections-store.js";
import type { ConnectionSecretBundle } from "../credentials/credential-vault.js";
import {
  AgentSessionError,
  type AgentEvent,
  type AgentSession,
  type AgentUpstream,
  type CreateAgentSessionInput,
} from "../agent/session-types.js";
import { normalizeVulnHunterWorkspace } from "./vulnhunter-normalize.js";
import { assertVulnHunterNonOperationalArtifacts } from "./vulnhunter-worker-support.js";
import {
  createVulnHunterHttpRunner,
  VulnHunterHttpRunnerError,
  type SafeVulnHunterProviderPlan,
} from "./vulnhunter-http-runner.js";

const CAPABILITIES: ModelCapabilities = {
  tools: "supported",
  artifactOutput: "supported",
  structuredOutput: "supported",
  boundedExecution: "supported",
  osIsolation: "supported",
  streaming: "supported",
  usage: "supported",
  cancellation: "supported",
};

const PLAN: SafeVulnHunterProviderPlan = {
  scanId: "scan-a",
  connectionId: "connection-a",
  routeKind: "openai-api",
  protocol: "openai-responses",
  modelId: "gpt-live",
  capabilityCheckId: "capability-a",
};

function connection(
  patch: Partial<StoredProviderConnection> = {},
): StoredProviderConnection {
  return {
    id: PLAN.connectionId,
    scopeId: "local",
    name: "OpenAI API",
    providerKind: "openai",
    routeKind: PLAN.routeKind,
    transport: "http-inference",
    authKind: "api-key",
    protocol: PLAN.protocol,
    status: "ready",
    credentialRef: "connection/connection-a",
    modelSelectionMode: "catalog",
    defaultModelId: null,
    lastTestedAt: "2026-08-11T12:00:00.000Z",
    lastModelSyncAt: "2026-08-11T12:00:00.000Z",
    modelCatalogStale: false,
    display: {
      providerLabel: "OpenAI",
      routeLabel: "API",
      secretConfigured: true,
      endpointConfigured: false,
      endpointKind: "preset",
    },
    ...patch,
  };
}

function model(patch: Partial<ProviderModel> = {}): ProviderModel {
  return {
    connectionId: PLAN.connectionId,
    id: PLAN.modelId,
    displayName: "GPT Live",
    contextWindow: 128_000,
    capabilities: CAPABILITIES,
    pricing: null,
    discoveredAt: "2026-08-11T12:00:00.000Z",
    source: "provider-api",
    ...patch,
  };
}

function capability(
  patch: Partial<CapabilityReport> = {},
): CapabilityReport {
  return {
    id: PLAN.capabilityCheckId,
    connectionId: PLAN.connectionId,
    modelId: PLAN.modelId,
    protocol: PLAN.protocol,
    status: "passed",
    capabilities: CAPABILITIES,
    errorCode: null,
    checkedAt: "2026-08-11T12:00:00.000Z",
    ...patch,
  };
}

function snapshot(
  patch: Partial<ScanConnectionSnapshot> = {},
): ScanConnectionSnapshot {
  return {
    scanId: PLAN.scanId,
    connectionId: PLAN.connectionId,
    routeKind: PLAN.routeKind,
    modelSelectionMode: "catalog",
    modelId: PLAN.modelId,
    capabilityCheckId: PLAN.capabilityCheckId,
    capturedAt: "2026-08-11T12:00:00.000Z",
    ...patch,
  };
}

interface FixtureOverrides {
  plan?: SafeVulnHunterProviderPlan;
  snapshot?: ScanConnectionSnapshot | null;
  connection?: StoredProviderConnection | null;
  model?: ProviderModel | null;
  capability?: CapabilityReport | null;
  session?: AgentSession;
  useDefaultSession?: boolean;
  upstream?: AgentUpstream;
  timeoutMs?: number;
  now?: () => Date;
  maxProbeAgeMs?: number;
  sessionFactory?: (input: CreateAgentSessionInput) => Promise<AgentSession>;
}

function fixture(overrides: FixtureOverrides = {}) {
  const observed = {
    vaultReads: 0,
    upstreams: 0,
    sessions: 0,
    plan: overrides.plan ?? PLAN,
  };
  const storedConnection = overrides.connection === undefined ? connection() : overrides.connection;
  const storedModel = overrides.model === undefined ? model() : overrides.model;
  const storedCapability = overrides.capability === undefined ? capability() : overrides.capability;
  const storedSnapshot = overrides.snapshot === undefined ? snapshot() : overrides.snapshot;
  const secret: ConnectionSecretBundle = {
    apiKey: "secret-never-in-worker-config",
    baseUrl: "https://private.example.invalid/v1",
    headers: { "x-private": "also-secret" },
  };
  const runner = createVulnHunterHttpRunner({
    store: {
      getSnapshot: (scanId) => storedSnapshot?.scanId === scanId ? storedSnapshot : null,
      get: (id) => storedConnection?.id === id ? storedConnection : null,
      getModel: (connectionId, modelId) =>
        storedModel?.connectionId === connectionId && storedModel.id === modelId
          ? storedModel
          : null,
      getLatestCapabilityCheck: (connectionId, modelId, protocol) =>
        storedCapability?.connectionId === connectionId &&
        storedCapability.modelId === modelId &&
        storedCapability.protocol === protocol
          ? storedCapability
          : null,
    },
    vault: {
      get: async () => {
        observed.vaultReads += 1;
        return secret;
      },
    },
    createUpstream: () => {
      observed.upstreams += 1;
      return overrides.upstream ?? { request: async () => ({}) };
    },
    ...(overrides.useDefaultSession === true
      ? {}
      : {
        createSession: async (input) => {
          observed.sessions += 1;
          if (overrides.sessionFactory !== undefined) return overrides.sessionFactory(input);
          return overrides.session ?? completedSession();
        },
      }),
    ...(overrides.timeoutMs === undefined ? {} : { limits: { timeoutMs: overrides.timeoutMs } }),
    now: overrides.now ?? (() => new Date("2026-08-11T12:30:00.000Z")),
    ...(overrides.maxProbeAgeMs === undefined ? {} : { maxProbeAgeMs: overrides.maxProbeAgeMs }),
  });
  return { runner, observed, secret };
}

function completedSession(events: AgentEvent[] = []): AgentSession {
  return {
    async *run() {
      for (const event of events) yield event;
      yield {
        type: "completion",
        text: "completed",
        structured: { status: "complete" },
      };
    },
    async cancel() {
      return { remote: false };
    },
  };
}

function input(plan: SafeVulnHunterProviderPlan = PLAN) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-http-"));
  const snapshotRoot = path.join(root, "snapshot");
  const resultsDir = path.join(root, "results");
  fs.mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  return {
    root,
    value: {
      plan,
      snapshotRoot,
      resultsDir,
      instructions: "Defensive static review only.",
      signal: new AbortController().signal,
    },
  };
}

test("VulnHunter HTTP runner rejects a stale immutable plan before vault or network access", async () => {
  const tampered = { ...PLAN, modelId: "other-model" };
  const { runner, observed, secret } = fixture({ plan: tampered });
  const run = input(tampered);
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
        error.code === "provider_plan_invalid",
    );
    assert.deepEqual(observed, {
      vaultReads: 0,
      upstreams: 0,
      sessions: 0,
      plan: tampered,
    });
    assert.equal(JSON.stringify(run.value).includes(secret.apiKey!), false);
    assert.equal(JSON.stringify(run.value).includes(secret.baseUrl!), false);
    assert.equal(JSON.stringify(run.value).includes(secret.headers!["x-private"]!), false);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner rejects a changed capability check before native vault access", async () => {
  const tampered = { ...PLAN, capabilityCheckId: "capability-b" };
  const { runner, observed } = fixture({
    plan: tampered,
    snapshot: snapshot({ capabilityCheckId: tampered.capabilityCheckId }),
  });
  const run = input(tampered);
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
        error.code === "provider_plan_invalid",
    );
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.upstreams, 0);
    assert.equal(observed.sessions, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner rejects a changed connection reference before native vault access", async () => {
  const tampered = { ...PLAN, connectionId: "connection-b" };
  const { runner, observed } = fixture({
    plan: tampered,
    snapshot: snapshot({ connectionId: tampered.connectionId }),
  });
  const run = input(tampered);
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
        error.code === "provider_plan_invalid",
    );
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.upstreams, 0);
    assert.equal(observed.sessions, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner rejects a stale model catalog before vault or network access", async () => {
  const { runner, observed } = fixture({
    connection: connection({ modelCatalogStale: true }),
  });
  const run = input();
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
        error.code === "provider_plan_invalid",
    );
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.upstreams, 0);
    assert.equal(observed.sessions, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner rejects an expired probe before vault or network access", async () => {
  const { runner, observed } = fixture({
    capability: capability({ checkedAt: "2026-08-11T10:29:59.999Z" }),
  });
  const run = input();
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
        error.code === "provider_plan_invalid",
    );
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.upstreams, 0);
    assert.equal(observed.sessions, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner rejects a future probe before vault or network access", async () => {
  const { runner, observed } = fixture({
    capability: capability({ checkedAt: "2026-08-11T12:30:00.001Z" }),
  });
  const run = input();
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
        error.code === "provider_plan_invalid",
    );
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.upstreams, 0);
    assert.equal(observed.sessions, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner revalidates cancellation and isolation support before vault access", async () => {
  for (const capabilities of [
    { ...CAPABILITIES, cancellation: "unsupported" as const },
    { ...CAPABILITIES, osIsolation: "unsupported" as const },
  ]) {
    const { runner, observed } = fixture({ capability: capability({ capabilities }) });
    const run = input();
    try {
      await assert.rejects(
        runner.run(run.value),
        (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
          error.code === "provider_plan_invalid",
      );
      assert.equal(observed.vaultReads, 0);
      assert.equal(observed.upstreams, 0);
      assert.equal(observed.sessions, 0);
    } finally {
      fs.rmSync(run.root, { recursive: true, force: true });
    }
  }
});

test("VulnHunter HTTP runner rejects xAI OAuth and unsupported protocols before reading native credentials", async () => {
  const blocked = {
    ...PLAN,
    routeKind: "xai-oauth",
    protocol: "xai-oauth-responses" as const,
  };
  const { runner, observed } = fixture({
    plan: blocked,
    snapshot: snapshot({ routeKind: blocked.routeKind }),
    connection: connection({ routeKind: blocked.routeKind, protocol: blocked.protocol }),
    capability: capability({ protocol: blocked.protocol }),
  });
  const run = input(blocked);
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
        error.code === "provider_plan_invalid",
    );
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.upstreams, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner re-resolves the exact model and probe then forwards bounded events", async () => {
  const events: AgentEvent[] = [
    { type: "usage", usage: { inputTokens: 42, cachedInputTokens: 4, outputTokens: 7, reasoningTokens: 2 } },
    { type: "tool", phase: "requested", callId: "tool-1", name: "workspace.read" },
    { type: "artifact", path: "coverage-sweep.md", bytes: 12 },
  ];
  const { runner, observed } = fixture({ session: completedSession(events) });
  const run = input();
  const observedEvents: AgentEvent[] = [];
  try {
    await runner.run({
      ...run.value,
      onEvent: (event) => {
        observedEvents.push(event);
      },
    });
    assert.equal(observed.vaultReads, 1);
    assert.equal(observed.upstreams, 1);
    assert.equal(observed.sessions, 1);
    assert.deepEqual(observedEvents, [...events, {
      type: "completion",
      text: "completed",
      structured: { status: "complete" },
    }]);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner enforces its local deadline when a provider ignores abort", async () => {
  const { runner } = fixture({
    useDefaultSession: true,
    timeoutMs: 10,
    upstream: {
      request: async () => new Promise<unknown>(() => undefined),
      cancel: async () => new Promise<boolean>(() => undefined),
    },
  });
  const run = input();
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof AgentSessionError && error.code === "agent_time_limit",
    );
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner turns an external abort into a bounded local cancellation", async () => {
  const { runner } = fixture({
    useDefaultSession: true,
    timeoutMs: 10_000,
    upstream: {
      request: async () => new Promise<unknown>(() => undefined),
      cancel: async () => new Promise<boolean>(() => undefined),
    },
  });
  const run = input();
  const controller = new AbortController();
  try {
    const pending = runner.run({ ...run.value, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await pending;
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP session keeps the defensive artifact allowlist normalizable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-http-artifacts-"));
  const snapshotRoot = path.join(root, "vulnhunter-snapshot");
  const resultsDir = path.join(root, "vulnhunter", "results");
  fs.mkdirSync(path.join(snapshotRoot, "src"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(snapshotRoot, "src", "app.ts"), "export const safe = true;\n");
  const { runner } = fixture({
    sessionFactory: async (spec) => {
      for (const name of [
        "reconnaissance.md",
        "trace-review.md",
        "verification.md",
        "validation-notes.md",
        "coverage-sweep.md",
        "README.md",
      ]) fs.writeFileSync(path.join(spec.artifactRoot, name), "# Defensive artifact\n");
      fs.writeFileSync(path.join(spec.artifactRoot, "sentinel-findings.json"), JSON.stringify({
        schemaVersion: 1,
        findings: [],
      }));
      return completedSession([{ type: "artifact", path: "coverage-sweep.md", bytes: 21 }]);
    },
  });
  try {
    await runner.run({
      plan: PLAN,
      snapshotRoot,
      resultsDir,
      instructions: "Defensive static review only.",
      signal: new AbortController().signal,
    });
    assert.doesNotThrow(() => assertVulnHunterNonOperationalArtifacts(resultsDir));
    assert.equal(normalizeVulnHunterWorkspace(resultsDir, root), 0);
    assert.equal(fs.existsSync(path.join(root, "findings.json")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
