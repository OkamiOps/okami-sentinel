import assert from "node:assert/strict";
import test from "node:test";

import type { StoredProviderConnection } from "../connections-store.js";
import { VaultError, type CredentialVault } from "../credentials/credential-vault.js";
import { CursorBackgroundAgentsError } from "./cursor-background-agents-adapter.js";
import { createCursorRouteAdapter } from "./cursor-route-adapter.js";
import { createRouteRegistry } from "./route-registry.js";

test("Cursor remote route discovers only the authenticated live model catalog", async () => {
  const seenKeys: string[] = [];
  const adapter = createCursorRouteAdapter({
    vault: fakeVault("cursor-secret"),
    client: {
      async listModels({ apiKey }) {
        seenKeys.push(apiKey);
        return [{ id: "cursor-live", displayName: "Cursor Live" }];
      },
    },
    now: () => new Date("2026-08-11T00:00:00.000Z"),
  });

  const result = await adapter.discoverModels(connection());

  assert.deepEqual(seenKeys, ["cursor-secret"]);
  assert.deepEqual(result.models.map((model) => [model.id, model.displayName]), [
    ["cursor-live", "Cursor Live"],
  ]);
  assert.equal(result.models[0]?.source, "provider-api");
  assert.equal(result.models[0]?.capabilities.tools, "unknown");
  assert.equal(JSON.stringify(result).includes("cursor-secret"), false);
});

test("Cursor remote inspection and probe fail closed with safe errors", async () => {
  const missing = createCursorRouteAdapter({
    vault: missingVault(),
    client: { async listModels() { return []; } },
  });
  assert.deepEqual(await missing.inspect(connection()), {
    available: false,
    reason: "credential_rejected",
    supportsRuntimeDefault: false,
  });

  const rejected = createCursorRouteAdapter({
    vault: fakeVault("cursor-secret"),
    client: {
      async listModels() {
        throw new CursorBackgroundAgentsError("rate_limited");
      },
    },
    now: () => new Date("2026-08-11T00:00:00.000Z"),
  });
  const report = await rejected.probe(connection(), {
    connectionId: "cursor-connection",
    modelSelectionMode: "catalog",
    modelId: "cursor-live",
  });
  assert.equal(report.status, "failed");
  assert.equal(report.errorCode, "rate_limited");
  assert.equal(report.modelId, "cursor-live");
});

test("Cursor remote route is registered only with its exact API-key contract", () => {
  const registry = createRouteRegistry({
    vault: fakeVault("cursor-secret"),
    cursor: { async listModels() { return []; } },
  });

  assert.deepEqual(registry.getManifest("cursor-background-agents"), {
    routeKind: "cursor-background-agents",
    providerKind: "cursor",
    transport: "remote-agent-api",
    protocol: "cursor-background-agents",
    authKinds: ["api-key"],
  });
  assert.equal(registry.get("cursor-background-agents")?.transport, "remote-agent-api");
});

function connection(): StoredProviderConnection {
  return {
    id: "cursor-connection",
    scopeId: "local",
    name: "Cursor Cloud",
    providerKind: "cursor",
    routeKind: "cursor-background-agents",
    transport: "remote-agent-api",
    authKind: "api-key",
    protocol: "cursor-background-agents",
    status: "draft",
    modelSelectionMode: "catalog",
    defaultModelId: null,
    lastTestedAt: null,
    lastModelSyncAt: null,
    modelCatalogStale: false,
    credentialRef: "connection/cursor-connection",
    display: {
      providerLabel: "cursor",
      routeLabel: "cursor-background-agents",
      secretConfigured: true,
      endpointConfigured: false,
      endpointKind: "preset",
    },
  };
}

function fakeVault(apiKey: string): CredentialVault {
  return {
    async available() { return { available: true, backend: "keychain" }; },
    async put() {},
    async get() { return { apiKey }; },
    async delete() {},
  };
}

function missingVault(): CredentialVault {
  return {
    async available() { return { available: true, backend: "keychain" }; },
    async put() {},
    async get() { throw new VaultError("credential_not_found"); },
    async delete() {},
  };
}
