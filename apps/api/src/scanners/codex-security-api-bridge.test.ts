import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCapabilities, ProviderModel } from "@csb/shared";

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

test("selected OpenAI API vault key launches Codex Security without a global key", async () => {
  const selectedVault = vault();
  const key = await resolveCodexSecurityApiKey({
    plan: plan(),
    connection: connection(),
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
  const selectedVault = vault();

  await assert.rejects(
    resolveCodexSecurityApiKey({
      plan: plan(),
      connection: connection({ transport: "local-cli" }),
      vault: selectedVault.value,
    }),
    (error: unknown) =>
      error instanceof CodexSecurityApiBridgeError &&
      error.code === "provider_runner_unavailable",
  );

  assert.equal(selectedVault.reads(), 0);
});
