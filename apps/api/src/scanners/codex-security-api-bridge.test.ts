import assert from "node:assert/strict";
import test from "node:test";

import type {
  ModelCapabilities,
  ProviderModel,
  ScanConnectionSnapshot,
} from "@csb/shared";

import type { StoredProviderConnection } from "../connections-store.js";
import type { ScanLaunchPlan } from "../connections/launch-plan.js";
import type { CredentialVault } from "../credentials/credential-vault.js";
import {
  CodexSecurityApiBridgeError,
  prepareCodexSecurityApiLaunch,
  resolveCodexSecurityApiKey,
} from "./codex-security-api-bridge.js";

const capabilities: ModelCapabilities = {
  tools: "supported",
  artifactOutput: "supported",
  structuredOutput: "supported",
  boundedExecution: "supported",
  osIsolation: "supported",
  streaming: "supported",
  usage: "supported",
  cancellation: "supported",
};

function connection(
  patch: Partial<StoredProviderConnection> = {},
): StoredProviderConnection {
  return {
    id: "openai-api-connection",
    scopeId: "local",
    name: "OpenAI API",
    providerKind: "openai",
    routeKind: "openai-api",
    transport: "http-inference",
    authKind: "api-key",
    protocol: "openai-responses",
    status: "ready",
    credentialRef: "connection/openai-api-connection",
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

function plan(patch: Partial<ScanLaunchPlan> = {}): ScanLaunchPlan {
  const model: ProviderModel = {
    connectionId: "openai-api-connection",
    id: "gpt-5.6-sol-2026-08-01",
    displayName: "GPT 5.6 Sol",
    contextWindow: 128_000,
    capabilities,
    pricing: null,
    discoveredAt: "2026-08-11T12:00:00.000Z",
    source: "provider-api",
  };
  return {
    engine: "codex-security",
    connectionId: "openai-api-connection",
    providerKind: "openai",
    routeKind: "openai-api",
    runnerKind: "codex-security-contract",
    protocol: "openai-responses",
    model,
    capabilityCheckId: null,
    scannerAuthMode: "api-key",
    snapshot: {
      scanId: "scan-codex-api",
      connectionId: "openai-api-connection",
      routeKind: "openai-api",
      modelSelectionMode: "catalog",
      modelId: "gpt-5.6-sol-2026-08-01",
      capabilityCheckId: null,
      capturedAt: "2026-08-11T12:00:00.000Z",
    },
    ...patch,
  };
}

function vault(apiKey = "vault-openai-key-not-process-key") {
  let reads = 0;
  const value: CredentialVault = {
    available: async () => ({ available: true, backend: "keychain" }),
    put: async () => undefined,
    get: async () => {
      reads += 1;
      return { apiKey };
    },
    delete: async () => undefined,
  };
  return { value, reads: () => reads };
}

function currentSnapshot(selectedPlan: ScanLaunchPlan): ScanConnectionSnapshot {
  return { ...selectedPlan.snapshot };
}

function currentModel(selectedPlan: ScanLaunchPlan): ProviderModel | null {
  return selectedPlan.model === null ? null : { ...selectedPlan.model };
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

test("selected OpenAI API vault key launches Codex Security without a global key", async () => {
  const selectedPlan = plan();
  const selectedVault = vault();
  const key = await resolveCodexSecurityApiKey({
    scanId: selectedPlan.snapshot.scanId,
    plan: selectedPlan,
    getConnection: () => connection(),
    getSnapshot: () => currentSnapshot(selectedPlan),
    getModel: () => currentModel(selectedPlan),
    vault: selectedVault.value,
  });
  const launch = prepareCodexSecurityApiLaunch({
    request: { repositoryPath: "/repo", engine: "codex-security" },
    repositoryPath: "/repo",
    outputDir: "/output",
    model: "gpt-5.6-sol-2026-08-01",
    effort: "high",
    mode: "standard",
    apiKey: key,
    environment: {
      PATH: "/bin",
      OPENAI_API_KEY: "global-key-must-not-reach-child",
      CODEX_API_KEY: "other-global-key-must-not-reach-child",
    },
  });

  const serializedSafeLaunch = JSON.stringify({
    request: { repositoryPath: "/repo", engine: "codex-security" },
    args: launch.args,
    cwd: launch.cwd,
    displayCommand: launch.displayCommand,
  });

  assert.equal(selectedVault.reads(), 1);
  assert.equal(launch.authMode, "api-key");
  assert.equal(launch.env.OPENAI_API_KEY, "vault-openai-key-not-process-key");
  assert.equal(launch.env.CODEX_API_KEY, undefined);
  assert.equal(launch.args.includes("vault-openai-key-not-process-key"), false);
  assert.equal(launch.displayCommand.includes("vault-openai-key-not-process-key"), false);
  assert.equal(serializedSafeLaunch.includes("vault-openai-key-not-process-key"), false);
  assert.equal(serializedSafeLaunch.includes("global-key-must-not-reach-child"), false);
});

test("an invalid Codex Security API tuple reads zero vault credentials", async () => {
  const selectedPlan = plan();
  const selectedVault = vault();

  await assert.rejects(
    resolveCodexSecurityApiKey({
      scanId: selectedPlan.snapshot.scanId,
      plan: selectedPlan,
      getConnection: () => connection({ transport: "local-cli" }),
      getSnapshot: () => currentSnapshot(selectedPlan),
      getModel: () => currentModel(selectedPlan),
      vault: selectedVault.value,
    }),
    (error: unknown) =>
      error instanceof CodexSecurityApiBridgeError &&
      error.code === "provider_runner_unavailable",
  );

  assert.equal(selectedVault.reads(), 0);
});

test("a stale persisted snapshot is rejected before reading the vault", async () => {
  const selectedPlan = plan();
  const selectedVault = vault();

  await assert.rejects(
    resolveCodexSecurityApiKey({
      scanId: selectedPlan.snapshot.scanId,
      plan: selectedPlan,
      getConnection: () => connection(),
      getSnapshot: () => ({
        ...currentSnapshot(selectedPlan),
        capturedAt: "2026-08-11T12:00:01.000Z",
      }),
      getModel: () => currentModel(selectedPlan),
      vault: selectedVault.value,
    }),
    (error: unknown) =>
      error instanceof CodexSecurityApiBridgeError &&
      error.code === "provider_runner_unavailable",
  );

  assert.equal(selectedVault.reads(), 0);
});

test("a stale catalog or removed current model is rejected before reading the vault", async () => {
  for (const state of ["stale-catalog", "removed-model"] as const) {
    const selectedPlan = plan();
    const selectedVault = vault();

    await assert.rejects(
      resolveCodexSecurityApiKey({
        scanId: selectedPlan.snapshot.scanId,
        plan: selectedPlan,
        getConnection: () => connection({ modelCatalogStale: state === "stale-catalog" }),
        getSnapshot: () => currentSnapshot(selectedPlan),
        getModel: () => state === "removed-model" ? null : currentModel(selectedPlan),
        vault: selectedVault.value,
      }),
      (error: unknown) =>
        error instanceof CodexSecurityApiBridgeError &&
        error.code === "provider_runner_unavailable",
      state,
    );

    assert.equal(selectedVault.reads(), 0, state);
  }
});

test("a hung vault read settles on the authoritative deadline without spawning", async (t) => {
  const selectedPlan = plan();
  let reads = 0;
  let spawns = 0;
  let rejectLate: ((error: Error) => void) | undefined;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const hungVault: CredentialVault = {
    available: async () => ({ available: true, backend: "keychain" }),
    put: async () => undefined,
    get: async () => {
      reads += 1;
      return new Promise((_resolve, reject) => {
        rejectLate = reject;
      });
    },
    delete: async () => undefined,
  };

  const operation = (async () => {
    await resolveCodexSecurityApiKey({
      scanId: selectedPlan.snapshot.scanId,
      plan: selectedPlan,
      getConnection: () => connection(),
      getSnapshot: () => currentSnapshot(selectedPlan),
      getModel: () => currentModel(selectedPlan),
      vault: hungVault,
      timeoutMs: 10,
    });
    spawns += 1;
  })();

  try {
    await assert.rejects(
      withTestDeadline(operation),
      (error: unknown) =>
        error instanceof CodexSecurityApiBridgeError &&
        error.code === "credential_unavailable",
    );
  } finally {
    rejectLate?.(new Error("late private vault rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(reads, 1);
  assert.equal(spawns, 0);
  assert.deepEqual(unhandled, []);
});

test("an aborted launch stops a hung vault read without spawning", async () => {
  const selectedPlan = plan();
  const controller = new AbortController();
  let reads = 0;
  let spawns = 0;
  const hungVault: CredentialVault = {
    available: async () => ({ available: true, backend: "keychain" }),
    put: async () => undefined,
    get: async () => {
      reads += 1;
      return new Promise(() => undefined);
    },
    delete: async () => undefined,
  };
  const operation = (async () => {
    await resolveCodexSecurityApiKey({
      scanId: selectedPlan.snapshot.scanId,
      plan: selectedPlan,
      getConnection: () => connection(),
      getSnapshot: () => currentSnapshot(selectedPlan),
      getModel: () => currentModel(selectedPlan),
      vault: hungVault,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    spawns += 1;
  })();

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(
    withTestDeadline(operation),
    (error: unknown) =>
      error instanceof CodexSecurityApiBridgeError &&
      error.code === "credential_unavailable",
  );
  assert.equal(reads, 1);
  assert.equal(spawns, 0);
});
