import type Database from "better-sqlite3";

import { getDb } from "../db.js";
import {
  type GitHubAppConnectionMetadata,
  type GitHubAppInstallationMetadata,
  type GitHubInstallationRepositoryMetadata,
  listGitHubAppConnections,
  listGitHubAppInstallations,
  listGitHubInstallationRepositories,
  upsertGitHubAppConnection,
  upsertGitHubAppInstallation,
  upsertGitHubInstallationRepository,
} from "../gate-store.js";
import { migrateGuardrailsSchema } from "../guardrails-migrations.js";

export class GitHubAppStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database = getDb()) {
    this.#database = database;
    migrateGuardrailsSchema(database);
  }

  saveConnection(connection: GitHubAppConnectionMetadata): void {
    upsertGitHubAppConnection(connection, this.#database);
  }

  getConnection(connectionId: string): GitHubAppConnectionMetadata | null {
    return this.listConnections().find((connection) => connection.id === connectionId) ?? null;
  }

  listConnections(): GitHubAppConnectionMetadata[] {
    return listGitHubAppConnections(this.#database);
  }

  revokeConnection(connectionId: string, updatedAt: string): boolean {
    const revoke = this.#database.transaction(() => {
      const connection = this.#database.prepare(`
        UPDATE github_app_connections
        SET status = 'revoked', updated_at = ?
        WHERE id = ? AND status != 'revoked'
      `).run(updatedAt, connectionId);
      if (connection.changes === 0 && this.getConnection(connectionId) === null) return false;
      this.#database.prepare(`
        UPDATE github_app_installations
        SET status = 'revoked', updated_at = ?
        WHERE connection_id = ?
      `).run(updatedAt, connectionId);
      return true;
    });
    return revoke.immediate();
  }

  replaceInstallations(
    connectionId: string,
    installations: readonly GitHubAppInstallationMetadata[],
  ): void {
    if (installations.some((installation) => installation.connectionId !== connectionId)) {
      throw new Error("github_installation_connection_mismatch");
    }
    const replace = this.#database.transaction(() => {
      const activeIds = new Set(installations.map((installation) => installation.id));
      for (const existing of this.listInstallations(connectionId)) {
        if (activeIds.has(existing.id)) continue;
        upsertGitHubAppInstallation({
          ...existing,
          status: "revoked",
          updatedAt: installations[0]?.updatedAt ?? new Date().toISOString(),
        }, this.#database);
      }
      for (const installation of installations) {
        upsertGitHubAppInstallation(installation, this.#database);
      }
    });
    replace.immediate();
  }

  getInstallation(installationId: string): GitHubAppInstallationMetadata | null {
    const row = this.#database.prepare(`
      SELECT id, connection_id, account_login, account_type, status, created_at, updated_at
      FROM github_app_installations
      WHERE id = ?
    `).get(installationId) as Record<string, string> | undefined;
    if (!row) return null;
    return {
      id: row.id!,
      connectionId: row.connection_id!,
      accountLogin: row.account_login!,
      accountType: row.account_type as GitHubAppInstallationMetadata["accountType"],
      status: row.status as GitHubAppInstallationMetadata["status"],
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
    };
  }

  listInstallations(connectionId: string): GitHubAppInstallationMetadata[] {
    return listGitHubAppInstallations(connectionId, this.#database);
  }

  replaceRepositories(
    installationId: string,
    repositories: readonly GitHubInstallationRepositoryMetadata[],
  ): void {
    if (repositories.some((repository) => repository.installationId !== installationId)) {
      throw new Error("github_repository_installation_mismatch");
    }
    const replace = this.#database.transaction(() => {
      this.#database.prepare(
        "DELETE FROM github_installation_repositories WHERE installation_id = ?",
      ).run(installationId);
      for (const repository of repositories) {
        upsertGitHubInstallationRepository(repository, this.#database);
      }
    });
    replace.immediate();
  }

  getRepository(repositoryId: string): GitHubInstallationRepositoryMetadata | null {
    const row = this.#database.prepare(`
      SELECT repository_id, installation_id, owner, name, default_branch,
             is_private, archived, updated_at
      FROM github_installation_repositories
      WHERE repository_id = ?
    `).get(repositoryId) as Record<string, string | number> | undefined;
    if (!row) return null;
    return {
      repositoryId: String(row.repository_id),
      installationId: String(row.installation_id),
      owner: String(row.owner),
      name: String(row.name),
      defaultBranch: String(row.default_branch),
      private: row.is_private === 1,
      archived: row.archived === 1,
      updatedAt: String(row.updated_at),
    };
  }

  listRepositories(installationId: string): GitHubInstallationRepositoryMetadata[] {
    return listGitHubInstallationRepositories(installationId, this.#database);
  }
}
