import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import type { SecretRedactorRegistry } from "../credentials/credential-vault.js";
import type {
  GitHubAppCredentialStore,
  GitHubAppCredentials,
} from "../credentials/system-github-app-credential-store.js";
import type { GitHubAppConnectionMetadata } from "../gate-store.js";
import {
  GitHubAppClient,
  GitHubAppClientError,
  createGitHubAppJwt,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
} from "./github-app-client.js";

class MemoryCredentialStore implements GitHubAppCredentialStore {
  constructor(readonly credentials: GitHubAppCredentials) {}
  put() { return Promise.resolve(); }
  get() { return Promise.resolve(this.credentials); }
  delete() { return Promise.resolve(); }
}

class RecordingRedactor implements SecretRedactorRegistry {
  readonly active = new Map<string, readonly string[]>();
  register(scope: string, values: readonly string[]) { this.active.set(scope, [...values]); }
  unregister(scope: string) { this.active.delete(scope); }
}

function keyPair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

function connection(): GitHubAppConnectionMetadata {
  return {
    id: "connection-1",
    appId: "12345",
    appSlug: "okami-sentinel-local",
    clientId: "Iv1.client-id",
    status: "ready",
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
  };
}

function decodePart(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

test("creates a time-bounded RS256 GitHub App JWT using the client ID", () => {
  const { privateKey, publicKey } = keyPair();
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const now = new Date("2026-08-12T12:00:00.000Z");

  const jwt = createGitHubAppJwt("Iv1.client-id", privateKeyPem, now);
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  assert.deepEqual(decodePart(headerPart!), { alg: "RS256", typ: "JWT" });
  const payload = decodePart(payloadPart!);
  assert.equal(payload.iss, "Iv1.client-id");
  assert.equal(payload.iat, Math.floor(now.getTime() / 1_000) - 60);
  assert.equal(payload.exp, Math.floor(now.getTime() / 1_000) + 540);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      publicKey,
      Buffer.from(signaturePart!, "base64url"),
    ),
    true,
  );
});

test("creates and caches a repository- and permission-scoped installation token", async () => {
  const { privateKey } = keyPair();
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const redactor = new RecordingRedactor();
  const requests: GitHubHttpRequest[] = [];
  let now = new Date("2026-08-12T12:00:00.000Z");
  let issued = 0;
  const client = new GitHubAppClient({
    credentials: new MemoryCredentialStore({ privateKeyPem: pem }),
    redactor,
    now: () => now,
    transport: async (request) => {
      requests.push(request);
      issued += 1;
      return {
        status: 201,
        body: {
          token: `ghs_private_${issued}`,
          expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
        },
      } satisfies GitHubHttpResponse;
    },
  });

  const first = await client.createRepositoryToken(connection(), "77", "9001", {
    contents: "read",
    pull_requests: "read",
    checks: "write",
  });
  const second = await client.createRepositoryToken(connection(), "77", "9001", {
    contents: "read",
    pull_requests: "read",
    checks: "write",
  });

  assert.equal(first.token, "ghs_private_1");
  assert.equal(second.token, first.token);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.github.com/app/installations/77/access_tokens");
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    repository_ids: [9001],
    permissions: {
      checks: "write",
      contents: "read",
      pull_requests: "read",
    },
  });
  assert.equal(requests[0]?.headers.Authorization?.startsWith("Bearer "), true);
  assert.deepEqual([...redactor.active.values()].flat(), ["ghs_private_1"]);

  now = new Date("2026-08-12T12:59:30.000Z");
  const renewed = await client.createRepositoryToken(connection(), "77", "9001", {
    contents: "read",
    pull_requests: "read",
    checks: "write",
  });
  assert.equal(renewed.token, "ghs_private_2");
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(requests).includes("ghs_private_1"), false);
});

test("reads a repository resource only with a repository-scoped installation token", async () => {
  const { privateKey } = keyPair();
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const requests: GitHubHttpRequest[] = [];
  const client = new GitHubAppClient({
    credentials: new MemoryCredentialStore({ privateKeyPem: pem }),
    redactor: new RecordingRedactor(),
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    transport: async (request) => {
      requests.push(request);
      if (request.url.endsWith("/access_tokens")) {
        return {
          status: 201,
          body: {
            token: "ghs_repository_read",
            expires_at: "2026-08-12T13:00:00.000Z",
          },
        };
      }
      return { status: 200, body: { sha: "a".repeat(40) } };
    },
  });

  assert.deepEqual(await client.readRepositoryJson(
    connection(),
    "77",
    "9001",
    "/repos/OkamiOps/sentinel/commits/main",
    { contents: "read" },
  ), { sha: "a".repeat(40) });
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    repository_ids: [9001],
    permissions: { contents: "read" },
  });
  assert.equal(requests[1]?.headers.Authorization, "Bearer ghs_repository_read");
  await assert.rejects(
    client.readRepositoryJson(
      connection(),
      "77",
      "9001",
      "https://evil.example/repos/OkamiOps/sentinel",
      { contents: "read" },
    ),
    /github_request_rejected/,
  );
});

test("downloads a bounded repository artifact as bytes with an actions token", async () => {
  const { privateKey } = keyPair();
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const requests: GitHubHttpRequest[] = [];
  const expected = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const client = new GitHubAppClient({
    credentials: new MemoryCredentialStore({ privateKeyPem: pem }),
    redactor: new RecordingRedactor(),
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    transport: async (request) => {
      requests.push(request);
      if (request.url.endsWith("/access_tokens")) {
        return {
          status: 201,
          body: {
            token: "ghs_repository_actions",
            expires_at: "2026-08-12T13:00:00.000Z",
          },
        };
      }
      return { status: 200, body: expected };
    },
  });

  assert.deepEqual(await client.downloadRepositoryBytes(
    connection(),
    "77",
    "9001",
    "/repos/OkamiOps/sentinel/actions/artifacts/9001/zip",
    { actions: "read" },
  ), expected);
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    repository_ids: [9001],
    permissions: { actions: "read" },
  });
  assert.equal(requests[1]?.responseType, "bytes");
  assert.equal(requests[1]?.headers.Authorization, "Bearer ghs_repository_actions");
});

test("writes a repository resource only with the requested repository-scoped permission", async () => {
  const { privateKey } = keyPair();
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const requests: GitHubHttpRequest[] = [];
  const client = new GitHubAppClient({
    credentials: new MemoryCredentialStore({ privateKeyPem: pem }),
    redactor: new RecordingRedactor(),
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    transport: async (request) => {
      requests.push(request);
      if (request.url.endsWith("/access_tokens")) {
        return {
          status: 201,
          body: {
            token: "ghs_repository_checks",
            expires_at: "2026-08-12T13:00:00.000Z",
          },
        };
      }
      return { status: 200, body: { id: 7788 } };
    },
  });

  assert.deepEqual(await client.writeRepositoryJson(
    connection(),
    "77",
    "9001",
    "/repos/OkamiOps/sentinel/check-runs/7788",
    "PATCH",
    { status: "completed" },
    { checks: "write" },
  ), { id: 7788 });
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    repository_ids: [9001],
    permissions: { checks: "write" },
  });
  assert.equal(requests[1]?.method, "PATCH");
  assert.equal(requests[1]?.url, "https://api.github.com/repos/OkamiOps/sentinel/check-runs/7788");
  assert.equal(requests[1]?.headers.Authorization, "Bearer ghs_repository_checks");
  assert.deepEqual(JSON.parse(requests[1]?.body ?? "{}"), { status: "completed" });
  await assert.rejects(
    client.writeRepositoryJson(
      connection(),
      "77",
      "9001",
      "https://evil.example/repos/OkamiOps/sentinel/check-runs",
      "POST",
      {},
      { checks: "write" },
    ),
    /github_request_rejected/,
  );
});

test("exchanges a manifest code without returning client or webhook secrets", async () => {
  const { privateKey } = keyPair();
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const redactor = new RecordingRedactor();
  const client = new GitHubAppClient({
    credentials: new MemoryCredentialStore({ privateKeyPem: pem }),
    redactor,
    transport: async () => ({
      status: 201,
      body: {
        id: 123,
        slug: "okami-sentinel-local",
        client_id: "Iv1.client-id",
        pem,
        client_secret: "client-secret-value",
        webhook_secret: "webhook-secret-value",
      },
    }),
  });

  const exchanged = await client.exchangeManifestCode("temporary-code", async (app) => ({
    appId: app.appId,
    appSlug: app.appSlug,
    clientId: app.clientId,
    pemLength: app.privateKeyPem.length,
  }));

  assert.deepEqual(exchanged, {
    appId: "123",
    appSlug: "okami-sentinel-local",
    clientId: "Iv1.client-id",
    pemLength: pem.length,
  });
  assert.equal(JSON.stringify(exchanged).includes("secret-value"), false);
  assert.equal(redactor.active.size, 0);
});

test("rejects unexpected API hosts before invoking the transport", () => {
  const { privateKey } = keyPair();
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  let calls = 0;
  assert.throws(() => new GitHubAppClient({
    credentials: new MemoryCredentialStore({ privateKeyPem: pem }),
    redactor: new RecordingRedactor(),
    apiBaseUrl: "https://github-api.attacker.example",
    transport: async () => {
      calls += 1;
      return { status: 200, body: {} };
    },
  }), (error: unknown) => error instanceof GitHubAppClientError && error.code === "github_host_not_allowed");
  assert.equal(calls, 0);
});

test("returns only a closed provider code when GitHub rejects a request", async () => {
  const { privateKey } = keyPair();
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const client = new GitHubAppClient({
    credentials: new MemoryCredentialStore({ privateKeyPem: pem }),
    redactor: new RecordingRedactor(),
    transport: async () => ({
      status: 401,
      body: { message: "request contained ghs_should_never_escape" },
    }),
  });

  await assert.rejects(
    () => client.listInstallations(connection()),
    (error: unknown) => error instanceof GitHubAppClientError &&
      error.code === "github_credential_rejected" &&
      error.message === "github_credential_rejected",
  );
});

test("uses a one-shot metadata token to catalog repositories and revokes it immediately", async () => {
  const { privateKey } = keyPair();
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const redactor = new RecordingRedactor();
  const requests: GitHubHttpRequest[] = [];
  const client = new GitHubAppClient({
    credentials: new MemoryCredentialStore({ privateKeyPem: pem }),
    redactor,
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    transport: async (request) => {
      requests.push(request);
      if (request.method === "POST") {
        return {
          status: 201,
          body: { token: "ghs_catalog_private", expires_at: "2026-08-12T13:00:00.000Z" },
        };
      }
      if (request.method === "GET") {
        return {
          status: 200,
          body: {
            total_count: 1,
            repositories: [{
              id: 9001,
              name: "sentinel",
              default_branch: "main",
              private: true,
              archived: false,
              updated_at: "2026-08-12T11:00:00.000Z",
              owner: { login: "OkamiOps" },
            }],
          },
        };
      }
      return { status: 204, body: null };
    },
  });

  assert.equal((await client.listInstallationRepositories(connection(), "77"))[0]?.repositoryId, "9001");
  assert.deepEqual(requests.map((request) => [request.method, request.url]), [
    ["POST", "https://api.github.com/app/installations/77/access_tokens"],
    ["GET", "https://api.github.com/installation/repositories?per_page=100"],
    ["DELETE", "https://api.github.com/installation/token"],
  ]);
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    permissions: { metadata: "read" },
  });
  assert.equal(requests[1]?.headers.Authorization, "Bearer ghs_catalog_private");
  assert.equal(requests[2]?.headers.Authorization, "Bearer ghs_catalog_private");
  assert.equal(redactor.active.size, 0);
});

test("paginates authenticated App installations without following provider URLs", async () => {
  const { privateKey } = keyPair();
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const requests: GitHubHttpRequest[] = [];
  const installation = (id: number) => ({
    id,
    account: { login: `owner-${id}`, type: "Organization" },
    suspended_at: null,
    created_at: "2026-08-12T11:00:00.000Z",
    updated_at: "2026-08-12T11:00:00.000Z",
  });
  const client = new GitHubAppClient({
    credentials: new MemoryCredentialStore({ privateKeyPem: pem }),
    redactor: new RecordingRedactor(),
    transport: async (request) => {
      requests.push(request);
      return request.url.endsWith("page=2")
        ? { status: 200, body: [installation(101)] }
        : { status: 200, body: Array.from({ length: 100 }, (_, index) => installation(index + 1)) };
    },
  });

  const installations = await client.listInstallations(connection());
  assert.equal(installations.length, 101);
  assert.deepEqual(requests.map((request) => request.url), [
    "https://api.github.com/app/installations?per_page=100",
    "https://api.github.com/app/installations?per_page=100&page=2",
  ]);
});
