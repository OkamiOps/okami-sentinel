import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { migrateGuardrailsSchema } from "../guardrails-migrations.js";
import { GitHubAppStore } from "./github-app-store.js";

function fixture() {
  const database = new Database(":memory:");
  migrateGuardrailsSchema(database);
  return { database, store: new GitHubAppStore(database) };
}

test("persists only GitHub App metadata and round-trips installations and repositories", () => {
  const { database, store } = fixture();
  const now = "2026-08-12T12:00:00.000Z";

  store.saveConnection({
    id: "connection-1",
    appId: "1234",
    appSlug: "okami-sentinel-local",
    clientId: "Iv1.example",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  });
  store.replaceInstallations("connection-1", [{
    id: "installation-7",
    connectionId: "connection-1",
    accountLogin: "OkamiOps",
    accountType: "Organization",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  }]);
  store.replaceRepositories("installation-7", [{
    repositoryId: "9001",
    installationId: "installation-7",
    owner: "OkamiOps",
    name: "sentinel-fixture",
    defaultBranch: "main",
    private: true,
    archived: false,
    updatedAt: now,
  }]);

  assert.equal(store.getConnection("connection-1")?.appSlug, "okami-sentinel-local");
  assert.equal(store.listInstallations("connection-1")[0]?.accountLogin, "OkamiOps");
  assert.equal(store.listRepositories("installation-7")[0]?.repositoryId, "9001");
  const columns = (database.prepare("PRAGMA table_info(github_app_connections)").all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
  assert.equal(columns.some((name) => /pem|token|secret|key/i.test(name)), false);
});

test("revokes a connection and all of its installations without deleting historical metadata", () => {
  const { store } = fixture();
  const now = "2026-08-12T12:00:00.000Z";
  store.saveConnection({
    id: "connection-2",
    appId: "222",
    appSlug: "audit-app",
    clientId: "Iv1.audit",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  });
  store.replaceInstallations("connection-2", [{
    id: "installation-8",
    connectionId: "connection-2",
    accountLogin: "audit-owner",
    accountType: "User",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  }]);

  assert.equal(store.revokeConnection("connection-2", "2026-08-12T12:01:00.000Z"), true);
  assert.equal(store.getConnection("connection-2")?.status, "revoked");
  assert.equal(store.getInstallation("installation-8")?.status, "revoked");
  assert.equal(store.listConnections().length, 1);
});

test("repository replacement removes stale authorization but never crosses installations", () => {
  const { store } = fixture();
  const now = "2026-08-12T12:00:00.000Z";
  for (const [connectionId, installationId] of [["connection-a", "installation-a"], ["connection-b", "installation-b"]]) {
    store.saveConnection({
      id: connectionId!, appId: connectionId!, appSlug: connectionId!, clientId: connectionId!,
      status: "ready", createdAt: now, updatedAt: now,
    });
    store.replaceInstallations(connectionId!, [{
      id: installationId!, connectionId: connectionId!, accountLogin: connectionId!,
      accountType: "Organization", status: "ready", createdAt: now, updatedAt: now,
    }]);
    store.replaceRepositories(installationId!, [{
      repositoryId: `repo-${installationId}`, installationId: installationId!, owner: "OkamiOps",
      name: installationId!, defaultBranch: "main", private: false, archived: false, updatedAt: now,
    }]);
  }

  store.replaceRepositories("installation-a", []);

  assert.deepEqual(store.listRepositories("installation-a"), []);
  assert.equal(store.listRepositories("installation-b").length, 1);
});
