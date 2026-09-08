import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { XaiOAuthCredentials } from "../connections/xai-oauth-flow.js";
import type { ConnectionSecretBundle, SecretRedactorRegistry } from "./credential-vault.js";
import { VaultError } from "./credential-vault.js";
import { createSystemCredentialVault } from "./system-credential-vault.js";
import { SystemGitHubAppCredentialStore } from "./system-github-app-credential-store.js";
import { SystemXaiOAuthCredentialStore } from "./system-xai-oauth-credential-store.js";

class RecordingRedactor implements SecretRedactorRegistry {
  readonly values = new Map<string, readonly string[]>();

  register(scope: string, values: readonly string[]) {
    this.values.set(scope, [...values]);
  }

  unregister(scope: string) {
    this.values.delete(scope);
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "csb-server-vault-"));
  const dataDir = path.join(root, "data");
  const keyFile = path.join(root, "vault-key");
  await writeFile(keyFile, Buffer.alloc(32, 0x31), { mode: 0o600 });
  return { root, dataDir, keyFile };
}

function pem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  }).toString();
}

test("server adapters persist connection, xAI, and GitHub secrets in isolated encrypted namespaces", async () => {
  const { root, dataDir, keyFile } = await fixture();
  const connectionSecret: ConnectionSecretBundle = { apiKey: "connection-secret" };
  const oauthSecret: XaiOAuthCredentials = {
    accessToken: "oauth-access-secret",
    refreshToken: "oauth-refresh-secret",
    expiresAt: "2026-12-01T00:00:00.000Z",
  };
  const githubSecret = { privateKeyPem: pem() };
  try {
    const redactor = new RecordingRedactor();
    const vault = createSystemCredentialVault({
      redactor,
      runtimeMode: "server",
      dataDir,
      vaultKeyFile: keyFile,
    });
    const oauth = new SystemXaiOAuthCredentialStore({
      redactor,
      runtimeMode: "server",
      dataDir,
      vaultKeyFile: keyFile,
    });
    const github = new SystemGitHubAppCredentialStore({
      redactor,
      runtimeMode: "server",
      dataDir,
      vaultKeyFile: keyFile,
    });

    await vault.put("connection/http-provider", connectionSecret);
    await oauth.put("xai-connection", oauthSecret);
    await github.put("github-connection", githubSecret);

    assert.deepEqual(await vault.available(), { available: true, backend: "encrypted-file" });
    assert.deepEqual(redactor.values.get("connection/http-provider"), ["connection-secret"]);
    assert.deepEqual(redactor.values.get("oauth/xai/xai-connection"), [
      "oauth-access-secret",
      "oauth-refresh-secret",
    ]);
    assert.deepEqual(redactor.values.get("scm/github-app/github-connection"), [githubSecret.privateKeyPem]);

    const afterRestart = new RecordingRedactor();
    assert.deepEqual(
      await createSystemCredentialVault({
        redactor: afterRestart,
        runtimeMode: "server",
        dataDir,
        vaultKeyFile: keyFile,
      }).get("connection/http-provider"),
      connectionSecret,
    );
    assert.deepEqual(
      await new SystemXaiOAuthCredentialStore({
        redactor: afterRestart,
        runtimeMode: "server",
        dataDir,
        vaultKeyFile: keyFile,
      }).get("xai-connection"),
      oauthSecret,
    );
    assert.deepEqual(
      await new SystemGitHubAppCredentialStore({
        redactor: afterRestart,
        runtimeMode: "server",
        dataDir,
        vaultKeyFile: keyFile,
      }).get("github-connection"),
      githubSecret,
    );

    const ciphertext = await encryptedFiles(dataDir);
    const combined = Buffer.concat(await Promise.all(ciphertext.map((file) => readFile(file)))).toString("utf8");
    assert.equal(combined.includes("connection-secret"), false);
    assert.equal(combined.includes("oauth-access-secret"), false);
    assert.equal(combined.includes(githubSecret.privateKeyPem), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("server adapters fail closed when their external vault key is wrong", async () => {
  const { root, dataDir, keyFile } = await fixture();
  const correct = new RecordingRedactor();
  const githubPrivateKey = pem();
  try {
    await createSystemCredentialVault({ redactor: correct, runtimeMode: "server", dataDir, vaultKeyFile: keyFile })
      .put("connection/a", { apiKey: "api-secret" });
    await new SystemXaiOAuthCredentialStore({ redactor: correct, runtimeMode: "server", dataDir, vaultKeyFile: keyFile })
      .put("xai-a", { accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: null });
    await new SystemGitHubAppCredentialStore({ redactor: correct, runtimeMode: "server", dataDir, vaultKeyFile: keyFile })
      .put("github-a", { privateKeyPem: githubPrivateKey });

    const wrongKeyFile = path.join(root, "wrong-vault-key");
    await writeFile(wrongKeyFile, Buffer.alloc(32, 0x55), { mode: 0o600 });
    const redactor = new RecordingRedactor();
    await assert.rejects(
      createSystemCredentialVault({ redactor, runtimeMode: "server", dataDir, vaultKeyFile: wrongKeyFile }).get("connection/a"),
      safeVaultError("api-secret"),
    );
    await assert.rejects(
      new SystemXaiOAuthCredentialStore({ redactor, runtimeMode: "server", dataDir, vaultKeyFile: wrongKeyFile }).get("xai-a"),
      safeVaultError("access-secret"),
    );
    await assert.rejects(
      new SystemGitHubAppCredentialStore({ redactor, runtimeMode: "server", dataDir, vaultKeyFile: wrongKeyFile }).get("github-a"),
      safeVaultError(githubPrivateKey),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CSB_RUNTIME_MODE=server selects the encrypted backend without loading keytar", async () => {
  const { root, dataDir, keyFile } = await fixture();
  const previous = process.env.CSB_RUNTIME_MODE;
  process.env.CSB_RUNTIME_MODE = "server";
  try {
    const redactor = new RecordingRedactor();
    const vault = createSystemCredentialVault({ redactor, dataDir, vaultKeyFile: keyFile });
    assert.deepEqual(await vault.available(), { available: true, backend: "encrypted-file" });
    await vault.put("connection/runtime-mode", { apiKey: "runtime-secret" });
    assert.deepEqual(await vault.get("connection/runtime-mode"), { apiKey: "runtime-secret" });

    const oauth = new SystemXaiOAuthCredentialStore({ redactor, dataDir, vaultKeyFile: keyFile });
    await oauth.put("runtime-xai", {
      accessToken: "runtime-access",
      refreshToken: "runtime-refresh",
      expiresAt: null,
    });
    assert.equal((await oauth.get("runtime-xai"))?.accessToken, "runtime-access");

    const github = new SystemGitHubAppCredentialStore({ redactor, dataDir, vaultKeyFile: keyFile });
    await github.put("runtime-github", { privateKeyPem: pem() });
    assert.ok((await github.get("runtime-github"))?.privateKeyPem.includes("PRIVATE KEY"));
  } finally {
    if (previous === undefined) delete process.env.CSB_RUNTIME_MODE;
    else process.env.CSB_RUNTIME_MODE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

async function encryptedFiles(dataDir: string): Promise<string[]> {
  const root = path.join(dataDir, "vault");
  const namespaces = await readdir(root);
  const files = await Promise.all(namespaces.map(async (namespace) => {
    const directory = path.join(root, namespace);
    return (await readdir(directory)).map((file) => path.join(directory, file));
  }));
  return files.flat();
}

function safeVaultError(secret: string) {
  return (error: unknown) => {
    assert.ok(error instanceof VaultError);
    assert.equal(error.code, "secure_storage_unavailable");
    assert.equal(error.message.includes(secret), false);
    return true;
  };
}
