import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import type { SecretRedactorRegistry } from "./credential-vault.js";
import type { NativeCredentialBackend } from "./system-credential-vault.js";
import { SystemGitHubAppCredentialStore } from "./system-github-app-credential-store.js";

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

function privateKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  }).toString();
}

test("stores GitHub App PEM material in an isolated SCM native namespace", async () => {
  const backend = new MemoryBackend();
  const redactor = new RecordingRedactor();
  const store = new SystemGitHubAppCredentialStore({
    redactor,
    loadBackend: async () => backend,
    platform: "darwin",
  });
  const pem = privateKeyPem();

  await store.put("connection-1", { privateKeyPem: pem });

  assert.deepEqual(await store.get("connection-1"), { privateKeyPem: pem });
  const nativeKey = [...backend.values.keys()][0];
  assert.equal(nativeKey, "com.okamiops.sentinel.scm.github-app:connection-1");
  assert.equal(nativeKey?.includes("connections"), false);
  assert.deepEqual(redactor.active.get("scm/github-app/connection-1"), [pem]);
});

test("deletes GitHub App PEM material and its active redaction scope", async () => {
  const backend = new MemoryBackend();
  const redactor = new RecordingRedactor();
  const store = new SystemGitHubAppCredentialStore({
    redactor,
    loadBackend: async () => backend,
    platform: "linux",
  });

  await store.put("connection-2", { privateKeyPem: privateKeyPem() });
  await store.delete("connection-2");

  assert.equal(await store.get("connection-2"), null);
  assert.equal(redactor.active.has("scm/github-app/connection-2"), false);
});

test("rejects malformed PEM payloads and unsupported native platforms", async () => {
  const backend = new MemoryBackend();
  const redactor = new RecordingRedactor();
  const store = new SystemGitHubAppCredentialStore({
    redactor,
    loadBackend: async () => backend,
    platform: "darwin",
  });
  await assert.rejects(() => store.put("connection-3", {
    privateKeyPem: "not a private key",
  }), { code: "secure_storage_unavailable" });

  const unsupported = new SystemGitHubAppCredentialStore({
    redactor,
    loadBackend: async () => backend,
    platform: "win32",
  });
  await assert.rejects(() => unsupported.get("connection-3"), {
    code: "secure_storage_unavailable",
  });
});

test("stores a webhook secret without losing the private key", async () => {
  const backend = new MemoryBackend();
  const redactor = new RecordingRedactor();
  const store = new SystemGitHubAppCredentialStore({
    redactor,
    loadBackend: async () => backend,
    platform: "darwin",
  });
  const pem = privateKeyPem();
  const secret = "s".repeat(32);

  await store.put("c1", { privateKeyPem: pem });
  await store.putWebhookSecret("c1", secret);

  assert.deepEqual(await store.get("c1"), { privateKeyPem: pem, webhookSecret: secret });
  assert.deepEqual(redactor.active.get("scm/github-app/c1"), [pem, secret]);
});

test("replaces a webhook secret and drops the previous value from redaction", async () => {
  const backend = new MemoryBackend();
  const redactor = new RecordingRedactor();
  const store = new SystemGitHubAppCredentialStore({
    redactor,
    loadBackend: async () => backend,
    platform: "darwin",
  });
  const pem = privateKeyPem();

  await store.put("c1", { privateKeyPem: pem, webhookSecret: "a".repeat(20) });
  await store.putWebhookSecret("c1", "b".repeat(20));

  assert.deepEqual(await store.get("c1"), { privateKeyPem: pem, webhookSecret: "b".repeat(20) });
  assert.deepEqual(redactor.active.get("scm/github-app/c1"), [pem, "b".repeat(20)]);
});

test("refuses a secret shorter than 16 characters", async () => {
  const backend = new MemoryBackend();
  const store = new SystemGitHubAppCredentialStore({
    redactor: new RecordingRedactor(),
    loadBackend: async () => backend,
    platform: "darwin",
  });
  const pem = privateKeyPem();
  await store.put("c1", { privateKeyPem: pem });

  await assert.rejects(() => store.putWebhookSecret("c1", "s".repeat(15)), {
    name: "VaultError",
    code: "secure_storage_unavailable",
  });
  await assert.rejects(() => store.putWebhookSecret("c1", "s".repeat(257)), {
    code: "secure_storage_unavailable",
  });
  await assert.rejects(() => store.putWebhookSecret("c1", `${"s".repeat(20)}\0`), {
    code: "secure_storage_unavailable",
  });
  assert.deepEqual(await store.get("c1"), { privateKeyPem: pem });
});

test("refuses a webhook secret for a connection that has no private key", async () => {
  const store = new SystemGitHubAppCredentialStore({
    redactor: new RecordingRedactor(),
    loadBackend: async () => new MemoryBackend(),
    platform: "darwin",
  });
  await assert.rejects(() => store.putWebhookSecret("absent", "s".repeat(32)), {
    code: "credential_not_found",
  });
});

test("refuses an unknown field in the stored bundle", async () => {
  const backend = new MemoryBackend();
  const store = new SystemGitHubAppCredentialStore({
    redactor: new RecordingRedactor(),
    loadBackend: async () => backend,
    platform: "darwin",
  });
  const pem = privateKeyPem();

  await assert.rejects(
    () => store.put("c1", { privateKeyPem: pem, nope: 1 } as never),
    { code: "secure_storage_unavailable" },
  );

  backend.values.set(
    "com.okamiops.sentinel.scm.github-app:c1",
    JSON.stringify({ privateKeyPem: pem, nope: 1 }),
  );
  await assert.rejects(() => store.get("c1"), { code: "secure_storage_unavailable" });
});

test("keeps pending PEM redaction when the native write outcome is unknown", async () => {
  const backend = new MemoryBackend();
  backend.failAfterSet = true;
  const redactor = new RecordingRedactor();
  const store = new SystemGitHubAppCredentialStore({
    redactor,
    loadBackend: async () => backend,
    platform: "darwin",
  });
  const pem = privateKeyPem();

  await assert.rejects(() => store.put("connection-4", { privateKeyPem: pem }), {
    code: "credential_write_failed",
  });

  assert.equal(
    [...redactor.active.entries()].some(([scope, values]) =>
      scope.startsWith("scm/github-app/connection-4:pending:") && values.includes(pem)),
    true,
  );
});
