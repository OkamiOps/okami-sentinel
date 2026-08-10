import assert from "node:assert/strict";
import test from "node:test";

import {
  type ConnectionSecretBundle,
  type SecretRedactorRegistry,
} from "./credentials/credential-vault.js";
import {
  createSystemCredentialVault,
  VaultError,
} from "./credentials/system-credential-vault.js";

class FakeKeyring {
  readonly values = new Map<string, string>();

  readonly entry = (account: string) => ({
    setPassword: (password: string) => {
      this.values.set(account, password);
    },
    getPassword: () => this.values.get(account) ?? null,
    deletePassword: () => this.values.delete(account),
  });
}

class FakeRedactor implements SecretRedactorRegistry {
  readonly registered = new Map<string, readonly string[]>();

  register(scope: string, values: readonly string[]) {
    this.registered.set(scope, values);
  }

  unregister(scope: string) {
    this.registered.delete(scope);
  }

  redact(text: string) {
    return [...this.registered.values()]
      .flat()
      .reduce((result, value) => result.replaceAll(value, "[REDACTED]"), text);
  }
}

function secretBundle(): ConnectionSecretBundle {
  return {
    baseUrl: "https://token-plan.example/v1",
    discoveryUrl: "https://token-plan.example/v1/models",
    apiKey: "plan-secret",
    headers: { "X-Tenant": "tenant-secret" },
  };
}

test("stores a validated bundle and registers its values for redaction", async () => {
  const backend = new FakeKeyring();
  const redactor = new FakeRedactor();
  const vault = createSystemCredentialVault({ entry: backend.entry, redactor });

  await vault.put("connection/abc", secretBundle());

  assert.deepEqual(await vault.get("connection/abc"), secretBundle());
  assert.equal(
    redactor.redact("plan-secret tenant-secret https://token-plan.example/v1"),
    "[REDACTED] [REDACTED] [REDACTED]",
  );
  assert.deepEqual(redactor.registered.get("connection/abc"), [
    "https://token-plan.example/v1",
    "plan-secret",
    "https://token-plan.example/v1/models",
    "tenant-secret",
  ]);
});

test("rejects bundles with unknown, empty, or unsafe values before storage", async () => {
  const backend = new FakeKeyring();
  const vault = createSystemCredentialVault({ entry: backend.entry });

  await assert.rejects(
    vault.put("connection/unknown", { apiKey: "secret", extra: "value" } as never),
    /invalid connection secret bundle/i,
  );
  await assert.rejects(
    vault.put("connection/empty", { apiKey: "   " }),
    /invalid connection secret bundle/i,
  );
  await assert.rejects(
    vault.put("connection/url", { baseUrl: "ftp://token-plan.example" }),
    /invalid connection secret bundle/i,
  );
  await assert.rejects(
    vault.put("connection/header", { headers: { "X Tenant": "secret" } }),
    /invalid connection secret bundle/i,
  );
  await assert.rejects(
    vault.put("connection/control", { apiKey: "secret\nvalue" }),
    /invalid connection secret bundle/i,
  );
  assert.equal(backend.values.size, 0);
});

test("reports a missing credential without native error details", async () => {
  const vault = createSystemCredentialVault({ entry: new FakeKeyring().entry });

  await assert.rejects(vault.get("connection/missing"), (error: unknown) => {
    assert.ok(error instanceof VaultError);
    assert.equal(error.code, "credential_not_found");
    assert.equal(error.message, "credential_not_found");
    return true;
  });
});

test("never falls back when the native store is unavailable", async () => {
  const vault = createSystemCredentialVault({
    entry: () => {
      throw new Error("locked");
    },
  });

  await assert.rejects(vault.put("connection/abc", { apiKey: "secret-value" }), {
    code: "secure_storage_unavailable",
  });
});

test("reports a supported native backend when the probe entry is missing", async () => {
  const vault = createSystemCredentialVault({ entry: new FakeKeyring().entry });

  assert.deepEqual(await vault.available(), {
    available: true,
    backend: process.platform === "darwin" ? "keychain" : "secret-service",
  });
});

test("deletes a credential and removes its redaction registration", async () => {
  const backend = new FakeKeyring();
  const redactor = new FakeRedactor();
  const vault = createSystemCredentialVault({ entry: backend.entry, redactor });

  await vault.put("connection/abc", { apiKey: "secret-value" });
  await vault.delete("connection/abc");

  assert.equal(backend.values.has("connection/abc"), false);
  assert.equal(redactor.registered.has("connection/abc"), false);
  await assert.rejects(vault.get("connection/abc"), { code: "credential_not_found" });
});
