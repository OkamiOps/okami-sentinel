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
import type { XaiOAuthFlow } from "../connections/xai-oauth-flow.js";
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
  validateVulnHunterHttpWorkerConfiguration,
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

const XAI_PLAN: SafeVulnHunterProviderPlan = {
  scanId: "scan-xai",
  connectionId: "connection-xai",
  routeKind: "xai-oauth",
  protocol: "xai-oauth-responses",
  modelId: "grok-live",
  capabilityCheckId: "capability-xai",
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

function xaiConnection(
  patch: Partial<StoredProviderConnection> = {},
): StoredProviderConnection {
  return {
    ...connection({
      id: XAI_PLAN.connectionId,
      name: "xAI OAuth",
      providerKind: "xai",
      routeKind: XAI_PLAN.routeKind,
      authKind: "device-code",
      protocol: XAI_PLAN.protocol,
      credentialRef: null,
      display: {
        providerLabel: "xAI",
        routeLabel: "OAuth",
        secretConfigured: true,
        endpointConfigured: false,
        endpointKind: "preset",
      },
    }),
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

function xaiModel(patch: Partial<ProviderModel> = {}): ProviderModel {
  return model({
    connectionId: XAI_PLAN.connectionId,
    id: XAI_PLAN.modelId,
    displayName: "Grok Live",
    ...patch,
  });
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

function xaiCapability(patch: Partial<CapabilityReport> = {}): CapabilityReport {
  return capability({
    id: XAI_PLAN.capabilityCheckId,
    connectionId: XAI_PLAN.connectionId,
    modelId: XAI_PLAN.modelId,
    protocol: XAI_PLAN.protocol,
    ...patch,
  });
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
    executionProfile: patch.executionProfile ?? null,
    profileVersion: patch.profileVersion ?? null,
    methodologyRef: patch.methodologyRef ?? null,
    protocol: patch.protocol ?? PLAN.protocol,
    authKind: patch.authKind ?? "api-key",
  };
}

function xaiSnapshot(patch: Partial<ScanConnectionSnapshot> = {}): ScanConnectionSnapshot {
  return snapshot({
    scanId: XAI_PLAN.scanId,
    connectionId: XAI_PLAN.connectionId,
    routeKind: XAI_PLAN.routeKind,
    modelId: XAI_PLAN.modelId,
    capabilityCheckId: XAI_PLAN.capabilityCheckId,
    ...patch,
  });
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
  xaiToken?: string;
  xaiError?: Error;
  xaiAccessToken?: (connectionId: string, signal?: AbortSignal) => Promise<string>;
  sessionFactory?: (input: CreateAgentSessionInput) => Promise<AgentSession>;
}

function fixture(overrides: FixtureOverrides = {}) {
  const observed = {
    vaultReads: 0,
    xaiReads: 0,
    xaiSignals: [] as Array<AbortSignal | undefined>,
    upstreams: 0,
    sessions: 0,
    upstreamCredentials: null as ConnectionSecretBundle | null,
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
    xaiOAuth: {
      getAccessToken: async (connectionId, signal) => {
        observed.xaiReads += 1;
        observed.xaiSignals.push(signal);
        if (overrides.xaiAccessToken !== undefined) {
          return overrides.xaiAccessToken(connectionId, signal);
        }
        if (overrides.xaiError !== undefined) throw overrides.xaiError;
        return overrides.xaiToken ?? "private-xai-oauth-token";
      },
    } satisfies Pick<XaiOAuthFlow, "getAccessToken">,
    createUpstream: (options) => {
      observed.upstreams += 1;
      observed.upstreamCredentials = options.credentials;
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

function withTestDeadline<T>(operation: Promise<T>, timeoutMs = 250): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("test_deadline_exceeded")), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
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
      xaiReads: 0,
      xaiSignals: [],
      upstreams: 0,
      sessions: 0,
      upstreamCredentials: null,
      plan: tampered,
    });
    assert.equal(JSON.stringify(run.value).includes(secret.apiKey!), false);
    assert.equal(JSON.stringify(run.value).includes(secret.baseUrl!), false);
    assert.equal(JSON.stringify(run.value).includes(secret.headers!["x-private"]!), false);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP accepts only its secret-free configuration allowlist", () => {
  const configuration = {
    outputDir: "/output",
    repositoryPath: "/repository",
    model: "gpt-live",
    effort: "high",
    paths: ["src"],
    readOnly: true as const,
    profileVersion: "v1",
    source: { repositoryUrl: "https://example.invalid/vulnhunter", ref: "main" },
    providerPlan: PLAN,
  };

  assert.doesNotThrow(() => validateVulnHunterHttpWorkerConfiguration(configuration));
  assert.throws(
    () => validateVulnHunterHttpWorkerConfiguration({ ...configuration, apiKey: "must-not-cross" } as never),
    { code: "provider_plan_invalid" },
  );
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

test("VulnHunter HTTP runner rejects an invalid xAI OAuth connection before OAuth access", async () => {
  const blocked = XAI_PLAN;
  const { runner, observed } = fixture({
    plan: blocked,
    snapshot: xaiSnapshot(),
    connection: xaiConnection({ providerKind: "openai" }),
    model: xaiModel(),
    capability: xaiCapability(),
  });
  const run = input(blocked);
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
        error.code === "provider_plan_invalid",
    );
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.xaiReads, 0);
    assert.equal(observed.upstreams, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter rejects direct xAI OAuth with a vault credential reference before credential access", async () => {
  const { runner, observed } = fixture({
    plan: XAI_PLAN,
    snapshot: xaiSnapshot(),
    connection: xaiConnection({ credentialRef: "connection/xai-oauth-impostor" }),
    model: xaiModel(),
    capability: xaiCapability(),
  });
  const run = input(XAI_PLAN);
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
        error.code === "provider_plan_invalid",
    );
    assert.equal(observed.xaiReads, 0);
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.upstreams, 0);
    assert.equal(observed.sessions, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner resolves direct xAI OAuth internally without an API-key vault read", async () => {
  const token = "private-xai-oauth-token";
  const { runner, observed } = fixture({
    plan: XAI_PLAN,
    snapshot: xaiSnapshot(),
    connection: xaiConnection(),
    model: xaiModel(),
    capability: xaiCapability(),
    xaiToken: token,
  });
  const run = input(XAI_PLAN);
  try {
    await runner.run(run.value);
    assert.equal(observed.xaiReads, 1);
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.upstreams, 1);
    assert.deepEqual(observed.upstreamCredentials, { apiKey: token });
    assert.equal(JSON.stringify(run.value).includes(token), false);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter direct xAI OAuth rejects a pre-aborted run before credential access", async () => {
  const { runner, observed } = fixture({
    plan: XAI_PLAN,
    snapshot: xaiSnapshot(),
    connection: xaiConnection(),
    model: xaiModel(),
    capability: xaiCapability(),
  });
  const run = input(XAI_PLAN);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      runner.run({ ...run.value, signal: controller.signal }),
      (error: unknown) => error instanceof AgentSessionError && error.code === "agent_cancelled",
    );
    assert.equal(observed.xaiReads, 0);
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.upstreams, 0);
    assert.equal(observed.sessions, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter direct xAI OAuth bounds a hung token resolver and consumes its late rejection", async (t) => {
  let rejectLate: ((error: Error) => void) | undefined;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const { runner, observed } = fixture({
    plan: XAI_PLAN,
    snapshot: xaiSnapshot(),
    connection: xaiConnection(),
    model: xaiModel(),
    capability: xaiCapability(),
    timeoutMs: 10,
    xaiAccessToken: async () => new Promise<string>((_resolve, reject) => {
      rejectLate = reject;
    }),
  });
  const run = input(XAI_PLAN);
  try {
    await assert.rejects(
      withTestDeadline(runner.run(run.value)),
      (error: unknown) => error instanceof AgentSessionError && error.code === "agent_time_limit",
    );
    assert.equal(observed.xaiReads, 1);
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.sessions, 0);
    rejectLate?.(new Error("private-late-refresh-rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter direct xAI OAuth charges preflight time against the session deadline", async () => {
  let sessionTimeoutMs: number | null = null;
  const { runner } = fixture({
    plan: XAI_PLAN,
    snapshot: xaiSnapshot(),
    connection: xaiConnection(),
    model: xaiModel(),
    capability: xaiCapability(),
    timeoutMs: 100,
    xaiAccessToken: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return "private-xai-oauth-token";
    },
    sessionFactory: async (sessionInput) => {
      sessionTimeoutMs = sessionInput.limits.timeoutMs;
      return completedSession();
    },
  });
  const run = input(XAI_PLAN);
  try {
    await runner.run(run.value);
    assert.equal(typeof sessionTimeoutMs, "number");
    assert.ok(sessionTimeoutMs! > 0 && sessionTimeoutMs! < 100);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter direct xAI OAuth aborts during refresh without starting a session", async () => {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const { runner, observed } = fixture({
    plan: XAI_PLAN,
    snapshot: xaiSnapshot(),
    connection: xaiConnection(),
    model: xaiModel(),
    capability: xaiCapability(),
    timeoutMs: 10_000,
    xaiAccessToken: async () => {
      markStarted?.();
      return new Promise<string>(() => undefined);
    },
  });
  const run = input(XAI_PLAN);
  const controller = new AbortController();
  try {
    const pending = runner.run({ ...run.value, signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(
      withTestDeadline(pending),
      (error: unknown) => error instanceof AgentSessionError && error.code === "agent_cancelled",
    );
    assert.equal(observed.xaiReads, 1);
    assert.equal(observed.xaiSignals[0]?.aborted, true);
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.sessions, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter rejects an API-key record that impersonates the xAI OAuth route before credential access", async () => {
  const tamperedPlan: SafeVulnHunterProviderPlan = {
    ...PLAN,
    scanId: "scan-tampered-xai-route",
    routeKind: "xai-oauth",
  };
  const { runner, observed } = fixture({
    plan: tamperedPlan,
    snapshot: snapshot({
      scanId: tamperedPlan.scanId,
      routeKind: tamperedPlan.routeKind,
    }),
    connection: connection({
      providerKind: "xai",
      routeKind: "xai-oauth",
      authKind: "api-key",
      protocol: "openai-responses",
    }),
  });
  const run = input(tamperedPlan);
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
        error.code === "provider_plan_invalid",
    );
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.xaiReads, 0);
    assert.equal(observed.upstreams, 0);
    assert.equal(observed.sessions, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner rejects stale xAI OAuth plans before OAuth access", async () => {
  const { runner, observed } = fixture({
    plan: XAI_PLAN,
    snapshot: xaiSnapshot(),
    connection: xaiConnection({ modelCatalogStale: true }),
    model: xaiModel(),
    capability: xaiCapability(),
  });
  const run = input(XAI_PLAN);
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
        error.code === "provider_plan_invalid",
    );
    assert.equal(observed.xaiReads, 0);
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.upstreams, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner returns a safe error when direct xAI OAuth refresh fails", async () => {
  const privateRefreshFailure = "private-xai-refresh-failure";
  const { runner, observed } = fixture({
    plan: XAI_PLAN,
    snapshot: xaiSnapshot(),
    connection: xaiConnection(),
    model: xaiModel(),
    capability: xaiCapability(),
    xaiError: new Error(privateRefreshFailure),
  });
  const run = input(XAI_PLAN);
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof VulnHunterHttpRunnerError &&
        error.code === "provider_plan_invalid" && !error.message.includes(privateRefreshFailure),
    );
    assert.equal(observed.xaiReads, 1);
    assert.equal(observed.vaultReads, 0);
    assert.equal(observed.upstreams, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP runner re-resolves the exact model and probe then forwards bounded events", async () => {
  const events: AgentEvent[] = [
    {
      type: "usage",
      usage: {
        inputTokens: 42,
        cachedInputTokens: 4,
        cacheWriteInputTokens: null,
        outputTokens: 7,
        reasoningTokens: 2,
      },
    },
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

test("VulnHunter HTTP forwards only an effort published by the exact model", async () => {
  const specs: CreateAgentSessionInput[] = [];
  const { runner, observed } = fixture({
    model: model({ reasoningEffort: { options: ["low", "high"], default: "high" } }),
    sessionFactory: async (spec) => {
      specs.push(spec);
      return completedSession();
    },
  });
  const run = input();
  try {
    await runner.run({ ...run.value, reasoningEffort: "high" });
    assert.deepEqual(specs.map((spec) => spec.reasoningEffort), ["high"]);
    assert.equal(observed.vaultReads, 1);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP rejects an unpublished effort before vault access", async () => {
  const { runner, observed } = fixture({
    model: model({ reasoningEffort: { options: ["low", "high"], default: "high" } }),
  });
  const run = input();
  try {
    await assert.rejects(
      runner.run({ ...run.value, reasoningEffort: "ultra" }),
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

test("VulnHunter HTTP rejects a MiMo effort before vault access", async () => {
  const mimoPlan: SafeVulnHunterProviderPlan = {
    ...PLAN,
    routeKind: "mimo-token-plan",
    protocol: "openai-chat",
  };
  const { runner, observed } = fixture({
    plan: mimoPlan,
    snapshot: snapshot({ routeKind: "mimo-token-plan", protocol: "openai-chat" }),
    connection: connection({ routeKind: "mimo-token-plan", protocol: "openai-chat" }),
    model: model({ reasoningEffort: { options: ["low", "high"], default: "high" } }),
    capability: capability({ protocol: "openai-chat" }),
  });
  const run = input(mimoPlan);
  try {
    await assert.rejects(
      runner.run({ ...run.value, reasoningEffort: "high" }),
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

test("VulnHunter direct xAI OAuth preserves the bounded deadline", async () => {
  const { runner, observed } = fixture({
    plan: XAI_PLAN,
    snapshot: xaiSnapshot(),
    connection: xaiConnection(),
    model: xaiModel(),
    capability: xaiCapability(),
    useDefaultSession: true,
    timeoutMs: 10,
    upstream: {
      request: async () => new Promise<unknown>(() => undefined),
      cancel: async () => new Promise<boolean>(() => undefined),
    },
  });
  const run = input(XAI_PLAN);
  try {
    await assert.rejects(
      runner.run(run.value),
      (error: unknown) => error instanceof AgentSessionError && error.code === "agent_time_limit",
    );
    assert.equal(observed.xaiReads, 1);
    assert.equal(observed.vaultReads, 0);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test("VulnHunter direct xAI OAuth preserves bounded external cancellation", async () => {
  const { runner, observed } = fixture({
    plan: XAI_PLAN,
    snapshot: xaiSnapshot(),
    connection: xaiConnection(),
    model: xaiModel(),
    capability: xaiCapability(),
    useDefaultSession: true,
    timeoutMs: 10_000,
    upstream: {
      request: async () => new Promise<unknown>(() => undefined),
      cancel: async () => new Promise<boolean>(() => undefined),
    },
  });
  const run = input(XAI_PLAN);
  const controller = new AbortController();
  try {
    const pending = runner.run({ ...run.value, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await pending;
    assert.equal(observed.xaiReads, 1);
    assert.equal(observed.vaultReads, 0);
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
