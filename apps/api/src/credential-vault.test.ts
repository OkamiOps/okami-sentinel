import assert from "node:assert/strict";
import test from "node:test";

import {
  type ConnectionSecretBundle,
  type SecretRedactorRegistry,
} from "./credentials/credential-vault.js";
import {
  createSystemCredentialVault,
  type NativeCredentialBackend,
  VaultError,
} from "./credentials/system-credential-vault.js";

const SERVICE = "com.okamiops.sentinel.connections";

class FakeCredentialBackend implements NativeCredentialBackend {
  readonly values = new Map<string, string>();
  readError: Error | undefined;
  writeError: Error | undefined;
  deleteError: Error | undefined;

  constructor(private readonly events: string[] = []) {}

  async getPassword(service: string, account: string) {
    assert.equal(service, SERVICE);
    this.events.push(`backend:get:${account}`);
    if (this.readError) throw this.readError;
    return this.values.get(account) ?? null;
  }

  async setPassword(service: string, account: string, password: string) {
    assert.equal(service, SERVICE);
    this.events.push(`backend:set:${account}`);
    if (this.writeError) throw this.writeError;
    this.values.set(account, password);
  }

  async deletePassword(service: string, account: string) {
    assert.equal(service, SERVICE);
    this.events.push(`backend:delete:${account}`);
    if (this.deleteError) throw this.deleteError;
    return this.values.delete(account);
  }
}

class FakeRedactor implements SecretRedactorRegistry {
  readonly registered = new Map<string, readonly string[]>();
  failNextRegister = false;

  constructor(private readonly events: string[] = []) {}

  register(scope: string, values: readonly string[]) {
    this.events.push(`redactor:register:${scope}`);
    this.registered.set(scope, values);
    if (this.failNextRegister) {
      this.failNextRegister = false;
      throw new Error("raw redactor failure");
    }
  }

  unregister(scope: string) {
    this.events.push(`redactor:unregister:${scope}`);
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

function createFixture() {
  const events: string[] = [];
  const backend = new FakeCredentialBackend(events);
  const redactor = new FakeRedactor(events);
  const vault = createSystemCredentialVault({
    redactor,
    loadBackend: async () => backend,
  });
  return { backend, events, redactor, vault };
}

async function withPlatform(
  platform: NodeJS.Platform,
  operation: () => Promise<void>,
) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(descriptor);
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    await operation();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

test("registers a validated bundle before writing it to the native backend", async () => {
  const { backend, events, redactor, vault } = createFixture();

  await vault.put("connection/abc", secretBundle());

  const pendingRegistration = events.findIndex((event) =>
    event.startsWith("redactor:register:connection/abc:pending:"),
  );
  const backendWrite = events.indexOf("backend:set:connection/abc");
  assert.ok(pendingRegistration >= 0);
  assert.ok(pendingRegistration < backendWrite);
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
  assert.equal(
    [...redactor.registered.keys()].some((scope) => scope.includes(":pending:")),
    false,
  );
  assert.equal(backend.values.has("connection/abc"), true);
});

test("rejects bundles with unknown, empty, or unsafe values before storage", async () => {
  const { backend, vault } = createFixture();

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
  const { vault } = createFixture();

  await assert.rejects(vault.get("connection/missing"), (error: unknown) => {
    assert.ok(error instanceof VaultError);
    assert.equal(error.code, "credential_not_found");
    assert.equal(error.message, "credential_not_found");
    return true;
  });
});

test("rejects all credential operations on unsupported platforms", async () => {
  const { backend, redactor, vault } = createFixture();

  await withPlatform("win32", async () => {
    assert.deepEqual(await vault.available(), {
      available: false,
      backend: "unsupported",
    });
    await assert.rejects(vault.put("connection/abc", secretBundle()), {
      code: "secure_storage_unavailable",
    });
    await assert.rejects(vault.get("connection/abc"), {
      code: "secure_storage_unavailable",
    });
    await assert.rejects(vault.delete("connection/abc"), {
      code: "secure_storage_unavailable",
    });
  });

  assert.equal(backend.values.size, 0);
  assert.equal(redactor.registered.size, 0);
});

test("maps a rejected lazy backend load to secure storage unavailable", async () => {
  const redactor = new FakeRedactor();
  const vault = createSystemCredentialVault({
    redactor,
    loadBackend: async () => {
      throw new Error("native binding unavailable");
    },
  });

  await assert.rejects(vault.put("connection/abc", secretBundle()), {
    code: "secure_storage_unavailable",
    message: "secure_storage_unavailable",
  });
});

test("marks the backend unavailable when its probe read rejects", async () => {
  const { backend, vault } = createFixture();
  backend.readError = new Error("locked backend");

  assert.deepEqual(await vault.available(), {
    available: false,
    backend: process.platform === "darwin" ? "keychain" : "secret-service",
  });
});

test("maps a backend read rejection without exposing its raw error", async () => {
  const { backend, vault } = createFixture();
  backend.readError = new Error("raw read failure");

  await assert.rejects(vault.get("connection/abc"), {
    code: "secure_storage_unavailable",
    message: "secure_storage_unavailable",
  });
});

test("keeps redaction registered when backend deletion rejects", async () => {
  const { backend, redactor, vault } = createFixture();
  backend.values.set("connection/abc", JSON.stringify(secretBundle()));
  redactor.registered.set("connection/abc", ["plan-secret"]);
  backend.deleteError = new Error("raw delete failure");

  await assert.rejects(vault.delete("connection/abc"), {
    code: "secure_storage_unavailable",
    message: "secure_storage_unavailable",
  });
  assert.equal(backend.values.has("connection/abc"), true);
  assert.deepEqual(redactor.registered.get("connection/abc"), ["plan-secret"]);
});

test("treats a confirmed missing delete as idempotent", async () => {
  const { redactor, vault } = createFixture();
  redactor.registered.set("connection/missing", ["stale-value"]);

  await vault.delete("connection/missing");

  assert.equal(redactor.registered.has("connection/missing"), false);
});

test("requires a redactor at the production factory boundary", () => {
  assert.throws(
    () =>
      createSystemCredentialVault({
        loadBackend: async () => new FakeCredentialBackend(),
      } as never),
    { code: "secure_storage_unavailable" },
  );
});

function compileTimeFactoryContract() {
  // @ts-expect-error A production vault must never be created without a redactor.
  createSystemCredentialVault({
    loadBackend: async () => new FakeCredentialBackend(),
  });
}
void compileTimeFactoryContract;

test("does not create a credential when pending redactor registration throws", async () => {
  const { backend, redactor, vault } = createFixture();
  redactor.failNextRegister = true;

  await assert.rejects(vault.put("connection/abc", secretBundle()), {
    code: "credential_write_failed",
    message: "credential_write_failed",
  });
  assert.equal(backend.values.has("connection/abc"), false);
  assert.equal(redactor.registered.size, 0);
});

test("preserves the old credential when replacement redaction throws", async () => {
  const { backend, redactor, vault } = createFixture();
  const oldBundle = { apiKey: "old-secret" };
  backend.values.set("connection/abc", JSON.stringify(oldBundle));
  redactor.registered.set("connection/abc", ["old-secret"]);
  redactor.failNextRegister = true;

  await assert.rejects(
    vault.put("connection/abc", { apiKey: "replacement-secret" }),
    { code: "credential_write_failed", message: "credential_write_failed" },
  );
  assert.deepEqual(
    JSON.parse(backend.values.get("connection/abc") ?? "null"),
    oldBundle,
  );
  assert.deepEqual(redactor.registered.get("connection/abc"), ["old-secret"]);
  assert.equal(
    [...redactor.registered.keys()].some((scope) => scope.includes(":pending:")),
    false,
  );
});

test("deletes a credential and removes its redaction registration", async () => {
  const { backend, redactor, vault } = createFixture();

  await vault.put("connection/abc", { apiKey: "secret-value" });
  await vault.delete("connection/abc");

  assert.equal(backend.values.has("connection/abc"), false);
  assert.equal(redactor.registered.has("connection/abc"), false);
  await assert.rejects(vault.get("connection/abc"), { code: "credential_not_found" });
});
