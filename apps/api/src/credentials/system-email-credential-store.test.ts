import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { SecretRedactorRegistry } from "./credential-vault.js";
import { VaultError } from "./credential-vault.js";
import { EncryptedSecretStore } from "./encrypted-secret-store.js";
import type { NativeCredentialBackend } from "./system-credential-vault.js";
import {
  newEmailSecretRef,
  SystemEmailCredentialStore,
} from "./system-email-credential-store.js";

class MemoryBackend implements NativeCredentialBackend {
  readonly values = new Map<string, string>();

  setPassword(service: string, account: string, password: string) {
    this.values.set(`${service}:${account}`, password);
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

function localStore(backend = new MemoryBackend(), redactor = new RecordingRedactor()) {
  return {
    backend,
    redactor,
    store: new SystemEmailCredentialStore({
      redactor, loadBackend: async () => backend, platform: "darwin", runtimeMode: "local",
    }),
  };
}

test("a reference is unique, and only a well-formed one is accepted", async () => {
  assert.notEqual(newEmailSecretRef(), newEmailSecretRef());
  assert.match(newEmailSecretRef(), /^email-[0-9a-f-]{36}$/);
  const { store } = localStore();
  for (const bad of ["", "email/../escape", "a".repeat(101), "with space", "nul\u0000"]) {
    await assert.rejects(store.get(bad), VaultError);
    await assert.rejects(store.put(bad, { secret: "x" }), VaultError);
  }
});

test("the secret round-trips through its own native namespace and is redacted", async () => {
  const { store, backend, redactor } = localStore();
  const ref = newEmailSecretRef();

  await store.put(ref, { secret: "smtp-password-42" });

  assert.deepEqual(await store.get(ref), { secret: "smtp-password-42" });
  // A namespace of its own, never the model-connection or GitHub App service.
  assert.deepEqual([...backend.values.keys()], [`com.okamiops.sentinel.email:${ref}`]);
  assert.deepEqual([...redactor.active.entries()], [[`email/${ref}`, ["smtp-password-42"]]]);
  // The stored envelope carries nothing but the secret.
  assert.deepEqual(JSON.parse([...backend.values.values()][0]!), { secret: "smtp-password-42" });

  assert.equal(await store.get(newEmailSecretRef()), null);

  await store.delete(ref);
  assert.equal(await store.get(ref), null);
  assert.equal(redactor.active.size, 0);
});

test("a replacement writes a new reference and leaves nothing behind once deleted", async () => {
  const { store, backend } = localStore();
  const first = newEmailSecretRef();
  const second = newEmailSecretRef();
  await store.put(first, { secret: "old-key" });
  await store.put(second, { secret: "new-key" });
  assert.equal(backend.values.size, 2);
  await store.delete(first);
  assert.equal(await store.get(first), null);
  assert.deepEqual(await store.get(second), { secret: "new-key" });
});

test("a malformed or oversized secret is refused rather than stored", async () => {
  const { store, backend } = localStore();
  const ref = newEmailSecretRef();
  for (const bad of [
    {}, { secret: "" }, { secret: "a".repeat(4_097) }, { secret: "line\nbreak" },
    { secret: 42 }, { secret: "ok", extra: "no" }, null, "raw",
  ]) {
    await assert.rejects(store.put(ref, bad as never), VaultError);
  }
  assert.equal(backend.values.size, 0);
});

test("a platform without a native vault fails closed", async () => {
  const store = new SystemEmailCredentialStore({
    redactor: new RecordingRedactor(), loadBackend: async () => new MemoryBackend(),
    platform: "win32", runtimeMode: "local",
  });
  await assert.rejects(store.put(newEmailSecretRef(), { secret: "x" }), VaultError);
  await assert.rejects(store.get(newEmailSecretRef()), VaultError);
});

test("server mode keeps the secret in the encrypted file store under the email namespace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "csb-email-vault-"));
  const keyFile = path.join(root, "vault.key");
  await writeFile(keyFile, "a".repeat(64), "utf8");
  const redactor = new RecordingRedactor();
  const encryptedStore = new EncryptedSecretStore({ dataDir: root, keyFile });
  const store = new SystemEmailCredentialStore({ redactor, runtimeMode: "server", encryptedStore });
  const ref = newEmailSecretRef();

  await store.put(ref, { secret: "re_live_key" });
  assert.deepEqual(await store.get(ref), { secret: "re_live_key" });
  // The same namespace a second store instance reads, and nothing else's.
  assert.deepEqual(
    await new EncryptedSecretStore({ dataDir: root, keyFile }).get("email", ref),
    { secret: "re_live_key" },
  );
  assert.equal(await encryptedStore.get("connections", ref), null);

  await store.delete(ref);
  assert.equal(await store.get(ref), null);
});
