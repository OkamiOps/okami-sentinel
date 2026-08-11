import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import type { ConnectionSecretBundle, CredentialVault } from "./credentials/credential-vault.js";
import type { XaiOAuthCredentialStore, XaiOAuthTransport } from "./connections/xai-oauth-flow.js";
import { createProviderRuntime } from "./provider-runtime.js";

class MemoryVault implements CredentialVault {
  readonly values = new Map<string, ConnectionSecretBundle>();
  async available() { return { available: true, backend: "keychain" as const }; }
  async put(ref: string, value: ConnectionSecretBundle) { this.values.set(ref, structuredClone(value)); }
  async get(ref: string) { return structuredClone(this.values.get(ref)!); }
  async delete(ref: string) { this.values.delete(ref); }
}

class MemoryOAuthStore implements XaiOAuthCredentialStore {
  get() { return Promise.resolve(null); }
  put() { return Promise.resolve(); }
  delete() { return Promise.resolve(); }
}

const oauthTransport: XaiOAuthTransport = {
  requestDeviceCode: async () => ({
    deviceCode: "private-device-code",
    verificationUri: "https://auth.x.ai/activate",
    userCode: "XAI-ABCD",
    expiresIn: 600,
  }),
  requestToken: async () => ({ error: "authorization_pending" }),
  revoke: async () => undefined,
};

test("one runtime composes connection metadata, direct OAuth, catalogs, and scan snapshots", async () => {
  const database = new Database(":memory:");
  try {
    const runtime = createProviderRuntime({
      database,
      vault: new MemoryVault(),
      xaiCredentialStore: new MemoryOAuthStore(),
      xaiTransport: oauthTransport,
      oauthSleep: (_milliseconds, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    const connection = await runtime.connections.create({
      name: "xAI subscription",
      providerKind: "xai",
      routeKind: "xai-oauth",
      transport: "http-inference",
      authKind: "device-code",
      protocol: "xai-oauth-responses",
      modelSelectionMode: "catalog",
    });

    const flow = await runtime.authFlows.start(connection.id, "device-code");
    assert.equal(flow.verificationUrl, "https://auth.x.ai/activate");
    assert.equal(flow.userCode, "XAI-ABCD");
    assert.equal(JSON.stringify(flow).includes("private-device-code"), false);
    assert.equal(runtime.routes.get("xai-oauth")?.protocol, "xai-oauth-responses");
    assert.equal(runtime.store.get(connection.id)?.routeKind, "xai-oauth");

    await runtime.authFlows.cancel(connection.id, flow.flowId);
  } finally {
    database.close();
  }
});
