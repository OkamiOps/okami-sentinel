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
  CodexSecurityMimoBridgeError,
  isCodexSecurityMimoConnection,
  prepareCodexSecurityMimoLaunch,
  resolveCodexSecurityMimoCredential,
} from "./codex-security-mimo-bridge.js";

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
    id: "mimo-connection",
    scopeId: "local",
    name: "MiMo Token Plan",
    providerKind: "xiaomi",
    routeKind: "mimo-token-plan",
    transport: "http-inference",
    authKind: "api-key",
    protocol: "openai-chat",
    status: "ready",
    credentialRef: "connection/mimo-connection",
    modelSelectionMode: "catalog",
    defaultModelId: null,
    lastTestedAt: "2026-08-11T12:00:00.000Z",
    lastModelSyncAt: "2026-08-11T12:00:00.000Z",
    modelCatalogStale: false,
    display: {
      providerLabel: "Xiaomi MiMo",
      routeLabel: "Token Plan",
      secretConfigured: true,
      endpointConfigured: true,
      endpointKind: "preset",
    },
    ...patch,
  };
}

function plan(patch: Partial<ScanLaunchPlan> = {}): ScanLaunchPlan {
  const model: ProviderModel = {
    connectionId: "mimo-connection",
    id: "mimo-v2.5",
    displayName: "MiMo V2.5",
    contextWindow: 262_144,
    capabilities,
    pricing: null,
    discoveredAt: "2026-08-11T12:00:00.000Z",
    source: "provider-api",
  };
  return {
    engine: "codex-security",
    connectionId: "mimo-connection",
    providerKind: "xiaomi",
    routeKind: "mimo-token-plan",
    runnerKind: "codex-security-contract",
    protocol: "openai-chat",
    model,
    capabilityCheckId: null,
    scannerAuthMode: "api-key",
    snapshot: {
      scanId: "scan-codex-mimo",
      connectionId: "mimo-connection",
      routeKind: "mimo-token-plan",
      modelSelectionMode: "catalog",
      modelId: "mimo-v2.5",
      capabilityCheckId: null,
      capturedAt: "2026-08-11T12:00:00.000Z",
    },
    ...patch,
  };
}

function vault(bundle = {
  apiKey: "tp-mimo-token-plan-secret",
  baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
}) {
  let reads = 0;
  const value: CredentialVault = {
    available: async () => ({ available: true, backend: "keychain" }),
    put: async () => undefined,
    get: async () => {
      reads += 1;
      return bundle;
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

test("resolves only the exact MiMo Token Plan credential tuple", async () => {
  const selectedPlan = plan();
  const selectedVault = vault();

  const credential = await resolveCodexSecurityMimoCredential({
    scanId: selectedPlan.snapshot.scanId,
    plan: selectedPlan,
    getConnection: () => connection(),
    getSnapshot: () => currentSnapshot(selectedPlan),
    getModel: () => currentModel(selectedPlan),
    vault: selectedVault.value,
  });

  assert.deepEqual(credential, {
    apiKey: "tp-mimo-token-plan-secret",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
  });
  assert.equal(selectedVault.reads(), 1);
  assert.equal(isCodexSecurityMimoConnection(connection()), true);
});

test("rejects malformed MiMo metadata before reading the vault", async () => {
  for (const malformed of [
    connection({ providerKind: "custom" }),
    connection({ protocol: "openai-responses" }),
    connection({ modelCatalogStale: true }),
  ]) {
    const selectedPlan = plan();
    const selectedVault = vault();
    await assert.rejects(
      resolveCodexSecurityMimoCredential({
        scanId: selectedPlan.snapshot.scanId,
        plan: selectedPlan,
        getConnection: () => malformed,
        getSnapshot: () => currentSnapshot(selectedPlan),
        getModel: () => currentModel(selectedPlan),
        vault: selectedVault.value,
      }),
      (error: unknown) =>
        error instanceof CodexSecurityMimoBridgeError &&
        error.code === "provider_runner_unavailable",
    );
    assert.equal(selectedVault.reads(), 0);
  }
});

test("rejects MiMo speech and TTS catalog models before reading the vault", async () => {
  const selectedVault = vault();
  const basePlan = plan();
  const speechPlan = plan({
    model: { ...basePlan.model!, id: "mimo-v2.5-asr", displayName: "MiMo ASR" },
    snapshot: {
      ...basePlan.snapshot,
      modelId: "mimo-v2.5-asr",
    },
  });

  await assert.rejects(
    resolveCodexSecurityMimoCredential({
      scanId: speechPlan.snapshot.scanId,
      plan: speechPlan,
      getConnection: () => connection(),
      getSnapshot: () => currentSnapshot(speechPlan),
      getModel: () => currentModel(speechPlan),
      vault: selectedVault.value,
    }),
    (error: unknown) =>
      error instanceof CodexSecurityMimoBridgeError &&
      error.code === "provider_runner_unavailable",
  );
  assert.equal(selectedVault.reads(), 0);
});

test("rejects an invalid Token Plan key or region after one bounded vault read", async () => {
  for (const bundle of [
    { apiKey: "sk-paygo-key", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
    { apiKey: "tp-valid-shape", baseUrl: "https://evil.example/v1" },
  ]) {
    const selectedPlan = plan();
    const selectedVault = vault(bundle);
    await assert.rejects(
      resolveCodexSecurityMimoCredential({
        scanId: selectedPlan.snapshot.scanId,
        plan: selectedPlan,
        getConnection: () => connection(),
        getSnapshot: () => currentSnapshot(selectedPlan),
        getModel: () => currentModel(selectedPlan),
        vault: selectedVault.value,
      }),
      (error: unknown) =>
        error instanceof CodexSecurityMimoBridgeError &&
        error.code === "credential_unavailable",
    );
    assert.equal(selectedVault.reads(), 1);
  }
});

test("launches Codex Security with the pinned MiMo Responses provider and child-only token", () => {
  const launch = prepareCodexSecurityMimoLaunch({
    request: { repositoryPath: "/repo", engine: "codex-security" },
    repositoryPath: "/repo",
    outputDir: "/output",
    model: "mimo-v2.5",
    effort: null,
    mode: "standard",
    apiKey: "tp-mimo-token-plan-secret",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    environment: {
      PATH: "/bin",
      OPENAI_API_KEY: "global-openai-key",
      CODEX_API_KEY: "global-codex-key",
      MIMO_API_KEY: "global-mimo-key",
    },
  });

  const serialized = JSON.stringify({
    args: launch.args,
    displayCommand: launch.displayCommand,
  });
  assert.equal(launch.provider, "xiaomi");
  assert.equal(launch.authMode, "api-key");
  assert.equal(launch.env.MIMO_API_KEY, "tp-mimo-token-plan-secret");
  // Upstream 0.1.x requires this alias for its api-key preflight. The active
  // model provider remains MiMo and reads MIMO_API_KEY.
  assert.equal(launch.env.OPENAI_API_KEY, "tp-mimo-token-plan-secret");
  assert.equal(launch.env.CODEX_API_KEY, undefined);
  assert.equal(launch.args.includes("model_provider=\"mimo\""), true);
  assert.equal(launch.args.includes("model_providers.mimo.wire_api=\"responses\""), true);
  assert.equal(launch.args.some((argument) => argument.startsWith("model_reasoning_effort=")), false);
  assert.equal(launch.args.includes("model_supports_reasoning_summaries=true"), true);
  assert.equal(
    launch.args.includes(
      "model_providers.mimo.base_url=\"https://token-plan-sgp.xiaomimimo.com/v1\"",
    ),
    true,
  );
  assert.equal(serialized.includes("tp-mimo-token-plan-secret"), false);
  assert.equal(serialized.includes("global-openai-key"), false);
  assert.equal(launch.args.includes("--effort"), false);
});

test("the MiMo launch adapter rejects a catalog speech model", () => {
  assert.throws(() => prepareCodexSecurityMimoLaunch({
    request: { repositoryPath: "/repo", engine: "codex-security" },
    repositoryPath: "/repo",
    outputDir: "/output",
    model: "mimo-v2.5-tts",
    effort: null,
    mode: "standard",
    apiKey: "tp-mimo-token-plan-secret",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    environment: { PATH: "/bin" },
  }), /unavailable/);
});
