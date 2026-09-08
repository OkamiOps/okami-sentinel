import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { VaultError } from "./credential-vault.js";
import { EncryptedSecretStore } from "./encrypted-secret-store.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "csb-encrypted-store-"));
  const dataDir = path.join(root, "data");
  const keyFile = path.join(root, "vault-key");
  await writeFile(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  return {
    root,
    dataDir,
    keyFile,
    store: new EncryptedSecretStore({ dataDir, keyFile }),
  };
}

function encryptedFile(dataDir: string, namespace: string, ref: string): string {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  return path.join(dataDir, "vault", digest(namespace), `${digest(ref)}.secret`);
}

test("persists an authenticated secret without disclosing its ref or payload in the filesystem", async () => {
  const { root, dataDir, keyFile, store } = await fixture();
  const secret = "api-private-value";
  try {
    await store.put("connections", "connection/production-a", {
      apiKey: secret,
      endpoint: "https://private.example/v1",
    });

    const restarted = new EncryptedSecretStore({ dataDir, keyFile });
    assert.deepEqual(
      await restarted.get("connections", "connection/production-a"),
      { apiKey: secret, endpoint: "https://private.example/v1" },
    );

    const file = encryptedFile(dataDir, "connections", "connection/production-a");
    const body = await readFile(file, "utf8");
    assert.equal(body.includes(secret), false);
    assert.equal(body.includes("production-a"), false);
    assert.equal((await stat(file)).mode & 0o077, 0);
    assert.equal((await stat(path.dirname(file))).mode & 0o077, 0);

    await restarted.delete("connections", "connection/production-a");
    assert.equal(await restarted.get("connections", "connection/production-a"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a wrong key, modified ciphertext, and AAD-swapped records without exposing secret bytes", async () => {
  const { root, dataDir, keyFile, store } = await fixture();
  const secret = "never-in-an-error";
  try {
    await store.put("connections", "connection/a", { apiKey: secret });
    const source = encryptedFile(dataDir, "connections", "connection/a");
    const copied = await readFile(source);

    const wrongKeyFile = path.join(root, "wrong-vault-key");
    await writeFile(wrongKeyFile, Buffer.alloc(32, 9), { mode: 0o600 });
    await assert.rejects(
      new EncryptedSecretStore({ dataDir, keyFile: wrongKeyFile }).get("connections", "connection/a"),
      safeStorageError(secret),
    );
    assert.equal(
      await new EncryptedSecretStore({ dataDir, keyFile: wrongKeyFile }).available(),
      false,
    );
    await assert.rejects(
      new EncryptedSecretStore({ dataDir, keyFile: wrongKeyFile }).delete("connections", "connection/a"),
      safeStorageError(secret),
    );
    assert.deepEqual(await store.get("connections", "connection/a"), { apiKey: secret });

    await store.put("connections", "connection/b", { apiKey: "other-value" });
    const target = encryptedFile(dataDir, "connections", "connection/b");
    await writeFile(target, copied, { mode: 0o600 });
    await assert.rejects(store.get("connections", "connection/b"), safeStorageError(secret));

    const tampered = Buffer.from(copied);
    tampered[tampered.length - 1] ^= 0x01;
    await writeFile(source, tampered, { mode: 0o600 });
    await assert.rejects(store.get("connections", "connection/a"), safeStorageError(secret));

    await store.put("a:b", "c", { value: "delimiter-secret" });
    await store.put("a", "b:c", { value: "placeholder" });
    await writeFile(
      encryptedFile(dataDir, "a", "b:c"),
      await readFile(encryptedFile(dataDir, "a:b", "c")),
      { mode: 0o600 },
    );
    await assert.rejects(store.get("a", "b:c"), safeStorageError("delimiter-secret"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts Docker-friendly hexadecimal and Base64 encodings for exactly 32 key bytes", async () => {
  const { root, dataDir, keyFile } = await fixture();
  try {
    const material = Buffer.alloc(32, 0x8a);
    await writeFile(keyFile, material.toString("hex"));
    const hexStore = new EncryptedSecretStore({ dataDir, keyFile });
    await hexStore.put("hex", "one", { value: "hex-secret" });
    assert.deepEqual(await hexStore.get("hex", "one"), { value: "hex-secret" });

    const base64Key = path.join(root, "base64-vault-key");
    await writeFile(base64Key, `${material.toString("base64")}\n`);
    const base64Store = new EncryptedSecretStore({ dataDir, keyFile: base64Key });
    await base64Store.put("base64", "one", { value: "base64-secret" });
    assert.deepEqual(await base64Store.get("base64", "one"), { value: "base64-secret" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function safeStorageError(secret: string) {
  return (error: unknown) => {
    assert.ok(error instanceof VaultError);
    assert.equal(error.code, "secure_storage_unavailable");
    assert.equal(error.message.includes(secret), false);
    return true;
  };
}
