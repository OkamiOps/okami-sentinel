import assert from "node:assert/strict";
import test from "node:test";

import type { SecretRedactorRegistry } from "./credential-vault.js";
import type { NativeCredentialBackend } from "./system-credential-vault.js";
import { SystemXaiOAuthCredentialStore } from "./system-xai-oauth-credential-store.js";

class MemoryBackend implements NativeCredentialBackend {
  readonly values = new Map<string, string>();
  failAfterSet = false;
  setPassword(service: string, account: string, password: string) {
    this.values.set(`${service}:${account}`, password);
    if (this.failAfterSet) return Promise.reject(new Error("native write outcome unknown"));
    return Promise.resolve();
  }
  getPassword(service: string, account: string) {
    return Promise.resolve(this.values.get(`${service}:${account}`) ?? null);
  }
  deletePassword(service: string, account: string) {
    return Promise.resolve(this.values.delete(`${service}:${account}`));
  }
}

class RecordingRedactor implements SecretRedactorRegistry {
  readonly active = new Map<string, readonly string[]>();
  register(scope: string, values: readonly string[]) {
    this.active.set(scope, [...values]);
  }
  unregister(scope: string) {
    this.active.delete(scope);
  }
}

test("stores xAI OAuth tokens in a separate native namespace and never as an API key", async () => {
  const backend = new MemoryBackend();
  const redactor = new RecordingRedactor();
  const store = new SystemXaiOAuthCredentialStore({
    redactor,
    loadBackend: async () => backend,
    platform: "darwin",
  });

  await store.put("connection-1", {
    accessToken: "access-private",
    refreshToken: "refresh-private",
    expiresAt: "2026-08-12T00:00:00.000Z",
  });

  assert.deepEqual(await store.get("connection-1"), {
    accessToken: "access-private",
    refreshToken: "refresh-private",
    expiresAt: "2026-08-12T00:00:00.000Z",
  });
  assert.equal([...backend.values.keys()][0]?.startsWith("com.okamiops.sentinel.oauth.xai:"), true);
  assert.equal([...backend.values.keys()][0]?.includes("connections"), false);
  assert.deepEqual(redactor.active.get("oauth/xai/connection-1"), ["access-private", "refresh-private"]);
});

test("returns null for an absent login and removes both native state and redaction", async () => {
  const backend = new MemoryBackend();
  const redactor = new RecordingRedactor();
  const store = new SystemXaiOAuthCredentialStore({
    redactor,
    loadBackend: async () => backend,
    platform: "linux",
  });

  assert.equal(await store.get("connection-2"), null);
  await store.put("connection-2", {
    accessToken: "access-two",
    refreshToken: "refresh-two",
    expiresAt: null,
  });
  await store.delete("connection-2");

  assert.equal(await store.get("connection-2"), null);
  assert.equal(redactor.active.has("oauth/xai/connection-2"), false);
});

test("fails closed on unsupported platforms and malformed native payloads", async () => {
  const backend = new MemoryBackend();
  const redactor = new RecordingRedactor();
  const unsupported = new SystemXaiOAuthCredentialStore({
    redactor,
    loadBackend: async () => backend,
    platform: "win32",
  });
  await assert.rejects(() => unsupported.get("connection-3"), { code: "secure_storage_unavailable" });

  backend.values.set("com.okamiops.sentinel.oauth.xai:connection-3", JSON.stringify({
    accessToken: "access-only",
  }));
  const supported = new SystemXaiOAuthCredentialStore({
    redactor,
    loadBackend: async () => backend,
    platform: "darwin",
  });
  await assert.rejects(() => supported.get("connection-3"), { code: "secure_storage_unavailable" });
});

test("keeps a pending redaction scope when a native write has an unknown outcome", async () => {
  const backend = new MemoryBackend();
  backend.failAfterSet = true;
  const redactor = new RecordingRedactor();
  const store = new SystemXaiOAuthCredentialStore({
    redactor,
    loadBackend: async () => backend,
    platform: "darwin",
  });

  await assert.rejects(() => store.put("connection-4", {
    accessToken: "access-uncertain",
    refreshToken: "refresh-uncertain",
    expiresAt: null,
  }), { code: "credential_write_failed" });

  assert.equal([...redactor.active.keys()].some((scope) => scope.startsWith("oauth/xai/connection-4:pending:")), true);
});
