import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import type {
  GitHubAppCredentialStore,
  GitHubAppCredentials,
} from "../credentials/system-github-app-credential-store.js";
import type {
  GitHubAppConnectionMetadata,
  GitHubAppInstallationMetadata,
  GitHubInstallationRepositoryMetadata,
} from "../gate-store.js";
import type { ManifestAppExchange } from "./github-app-client.js";
import { GitHubAppService, GitHubAppServiceError } from "./github-app-service.js";
import { GitHubAppManifestFlow } from "./manifest-flow.js";

class MemoryCredentials implements GitHubAppCredentialStore {
  readonly values = new Map<string, GitHubAppCredentials>();
  async put(id: string, value: GitHubAppCredentials) { this.values.set(id, value); }
  async get(id: string) { return this.values.get(id) ?? null; }
  async delete(id: string) { this.values.delete(id); }
}

class MemoryStore {
  readonly connections = new Map<string, GitHubAppConnectionMetadata>();
  readonly installations = new Map<string, GitHubAppInstallationMetadata>();
  readonly repositories = new Map<string, GitHubInstallationRepositoryMetadata>();

  saveConnection(value: GitHubAppConnectionMetadata) { this.connections.set(value.id, value); }
  getConnection(id: string) { return this.connections.get(id) ?? null; }
  listConnections() { return [...this.connections.values()]; }
  revokeConnection(id: string, updatedAt: string) {
    const current = this.connections.get(id);
    if (!current) return false;
    this.connections.set(id, { ...current, status: "revoked", updatedAt });
    for (const [installationId, installation] of this.installations) {
      if (installation.connectionId === id) {
        this.installations.set(installationId, { ...installation, status: "revoked", updatedAt });
      }
    }
    return true;
  }
  replaceInstallations(connectionId: string, values: readonly GitHubAppInstallationMetadata[]) {
    for (const [id, value] of this.installations) {
      if (value.connectionId === connectionId) this.installations.delete(id);
    }
    for (const value of values) this.installations.set(value.id, value);
  }
  getInstallation(id: string) { return this.installations.get(id) ?? null; }
  listInstallations(connectionId: string) {
    return [...this.installations.values()].filter((value) => value.connectionId === connectionId);
  }
  replaceRepositories(installationId: string, values: readonly GitHubInstallationRepositoryMetadata[]) {
    for (const [id, value] of this.repositories) {
      if (value.installationId === installationId) this.repositories.delete(id);
    }
    for (const value of values) this.repositories.set(value.repositoryId, value);
  }
  listRepositories(installationId: string) {
    return [...this.repositories.values()].filter((value) => value.installationId === installationId);
  }
  getRepository(repositoryId: string) { return this.repositories.get(repositoryId) ?? null; }
}

function fixture() {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    format: "pem", type: "pkcs8",
  }).toString();
  let now = new Date("2026-08-12T12:00:00.000Z");
  let nextId = 0;
  const flow = new GitHubAppManifestFlow({
    callbackUrl: "http://127.0.0.1:8787/guardrails/github-app/manifest/callback",
    localOrigin: "http://127.0.0.1:8787",
    now: () => now,
  });
  const credentials = new MemoryCredentials();
  const store = new MemoryStore();
  const calls = {
    exchanges: [] as string[],
    installations: 0,
    repositories: 0,
    resources: [] as string[],
    cleared: [] as string[],
  };
  const client = {
    async exchangeManifestCode<T>(code: string, consume: (app: ManifestAppExchange) => Promise<T> | T) {
      calls.exchanges.push(code);
      return consume({
        appId: "123",
        appSlug: "okami-sentinel-local",
        clientId: "Iv1.client",
        privateKeyPem: pem,
      });
    },
    async listInstallations(connection: GitHubAppConnectionMetadata) {
      calls.installations += 1;
      return [{
        id: "77", connectionId: connection.id, accountLogin: "OkamiOps",
        accountType: "Organization" as const, status: "ready" as const,
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
      }];
    },
    async listInstallationRepositories(_connection: GitHubAppConnectionMetadata, installationId: string) {
      calls.repositories += 1;
      return [{
        repositoryId: "9001", installationId, owner: "OkamiOps", name: "sentinel",
        defaultBranch: "main", private: true, archived: false, updatedAt: now.toISOString(),
      }];
    },
    async readRepositoryJson(
      _connection: GitHubAppConnectionMetadata,
      _installationId: string,
      _repositoryId: string,
      path: string,
    ) {
      calls.resources.push(path);
      return { sha: "a".repeat(40) };
    },
    async writeRepositoryJson() { return { id: 1 }; },
    async createRepositoryToken() {
      return { token: "installation-token", expiresAt: "2026-08-12T13:00:00.000Z" };
    },
    clearConnection(connectionId: string) { calls.cleared.push(connectionId); },
  };
  const service = new GitHubAppService({
    flow,
    credentials,
    store,
    client,
    now: () => now,
    createConnectionId: () => `connection-${++nextId}`,
  });
  return { service, flow, credentials, store, calls, advance(ms: number) { now = new Date(now.getTime() + ms); } };
}

test("completes manifest exchange, stores PEM only in native credentials and discovers installations", async () => {
  const { service, flow, credentials, store, calls } = fixture();
  const started = service.startManifest();
  const state = flow.authorization(started.flowId).state;

  const result = await service.completeManifestCallback({
    flowId: started.flowId,
    state,
    code: "temporary-code",
    error: null,
  });

  assert.deepEqual(result, { status: "completed", connectionId: "connection-1" });
  assert.deepEqual(calls.exchanges, ["temporary-code"]);
  assert.equal(calls.installations, 1);
  assert.equal(credentials.values.get("connection-1")?.privateKeyPem.includes("PRIVATE KEY"), true);
  assert.deepEqual(store.connections.get("connection-1"), {
    id: "connection-1",
    appId: "123",
    appSlug: "okami-sentinel-local",
    clientId: "Iv1.client",
    status: "ready",
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
  });
  assert.equal(JSON.stringify([...store.connections.values()]).includes("PRIVATE KEY"), false);
  assert.equal(store.installations.get("77")?.accountLogin, "OkamiOps");
});

test("does not accept a redirect installation id as authority", async () => {
  const { service, flow, store } = fixture();
  const started = service.startManifest();
  const state = flow.authorization(started.flowId).state;

  await service.completeManifestCallback({
    flowId: started.flowId,
    state,
    code: "temporary-code",
    error: null,
  });

  assert.equal(store.installations.has("attacker-supplied-installation"), false);
  assert.deepEqual(service.listInstallations("connection-1").map((item) => item.id), ["77"]);
});

test("refreshes repositories only through a ready authenticated installation", async () => {
  const { service, flow, store, calls } = fixture();
  const started = service.startManifest();
  const state = flow.authorization(started.flowId).state;
  await service.completeManifestCallback({ flowId: started.flowId, state, code: "temporary-code", error: null });

  assert.deepEqual(await service.refreshRepositories("77"), [{
    repositoryId: "9001", installationId: "77", owner: "OkamiOps", name: "sentinel",
    defaultBranch: "main", private: true, archived: false, updatedAt: "2026-08-12T12:00:00.000Z",
  }]);
  assert.equal(calls.repositories, 1);

  store.revokeConnection("connection-1", "2026-08-12T12:01:00.000Z");
  await assert.rejects(
    () => service.refreshRepositories("77"),
    (error: unknown) => error instanceof GitHubAppServiceError && error.code === "github_connection_revoked",
  );
  assert.equal(calls.repositories, 1);
});

test("disconnect revokes metadata before deleting the PEM and preserves the audit row", async () => {
  const { service, flow, credentials, store, calls } = fixture();
  const started = service.startManifest();
  const state = flow.authorization(started.flowId).state;
  await service.completeManifestCallback({ flowId: started.flowId, state, code: "temporary-code", error: null });

  await service.disconnect("connection-1");

  assert.equal(store.connections.get("connection-1")?.status, "revoked");
  assert.equal(store.installations.get("77")?.status, "revoked");
  assert.equal(credentials.values.has("connection-1"), false);
  assert.deepEqual(calls.cleared, ["connection-1"]);
  assert.equal(service.listConnections().length, 1);
});

test("marks a persisted connection errored when authenticated installation discovery fails", async () => {
  const explicit = fixtureWithInstallationFailure();
  await assert.rejects(
    () => explicit.service.completeManifestCallback({
      flowId: explicit.started.flowId,
      state: explicit.state,
      code: "temporary-code",
      error: null,
    }),
    (error: unknown) => error instanceof Error && error.message === "github_manifest_failed",
  );
  assert.equal(explicit.store.connections.get("connection-1")?.status, "error");
  assert.deepEqual(explicit.service.manifestState(explicit.started.flowId), { status: "failed" });
});

test("checks repository authorization through connection and installation state before use", async () => {
  const { service, flow, store, calls } = fixture();
  const started = service.startManifest();
  const state = flow.authorization(started.flowId).state;
  await service.completeManifestCallback({ flowId: started.flowId, state, code: "temporary-code", error: null });
  await service.refreshRepositories("77");
  assert.equal(service.requireReadyRepository("9001").name, "sentinel");
  assert.deepEqual(service.requireAuthorizedRepository("connection-1", "77", "9001"), {
    ...store.repositories.get("9001")!,
    connectionId: "connection-1",
  });
  assert.deepEqual(await service.readAuthorizedRepositoryJson(
    "connection-1",
    "77",
    "9001",
    "/repos/OkamiOps/sentinel/commits/main",
    { contents: "read" },
  ), { sha: "a".repeat(40) });
  assert.deepEqual(calls.resources, ["/repos/OkamiOps/sentinel/commits/main"]);
  assert.throws(
    () => service.requireAuthorizedRepository("connection-1", "another-installation", "9001"),
    (error: unknown) => error instanceof GitHubAppServiceError
      && error.code === "github_installation_not_found",
  );

  store.repositories.set("9001", { ...store.repositories.get("9001")!, archived: true });
  assert.throws(
    () => service.requireReadyRepository("9001"),
    (error: unknown) => error instanceof GitHubAppServiceError && error.code === "github_repository_revoked",
  );
  store.repositories.delete("9001");
  assert.throws(
    () => service.requireReadyRepository("9001"),
    (error: unknown) => error instanceof GitHubAppServiceError && error.code === "github_repository_not_found",
  );
});

function fixtureWithInstallationFailure() {
  const base = fixture();
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    format: "pem", type: "pkcs8",
  }).toString();
  const started = base.flow.start();
  const state = base.flow.authorization(started.flowId).state;
  const service = new GitHubAppService({
    flow: base.flow,
    credentials: base.credentials,
    store: base.store,
    client: {
      exchangeManifestCode: async <T>(_code: string, consume: (app: ManifestAppExchange) => Promise<T> | T) => consume({
        appId: "123", appSlug: "okami-sentinel-local", clientId: "Iv1.client", privateKeyPem: pem,
      }),
      listInstallations: async () => { throw new Error("private upstream response"); },
      listInstallationRepositories: async () => [],
      readRepositoryJson: async () => ({}),
      writeRepositoryJson: async () => ({}),
      createRepositoryToken: async () => ({
        token: "installation-token",
        expiresAt: "2026-08-12T13:00:00.000Z",
      }),
      clearConnection: () => undefined,
    },
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    createConnectionId: () => "connection-1",
  });
  return { ...base, service, started, state };
}
