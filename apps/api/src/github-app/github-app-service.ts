import { randomUUID } from "node:crypto";

import type { GitHubAppCredentialStore } from "../credentials/system-github-app-credential-store.js";
import type {
  GitHubAppConnectionMetadata,
  GitHubAppInstallationMetadata,
  GitHubInstallationRepositoryMetadata,
} from "../gate-store.js";
import type {
  GitHubInstallationToken,
  ManifestAppExchange,
} from "./github-app-client.js";
import {
  GitHubAppClientError,
  type GitHubInstallationPermissions,
} from "./github-app-client.js";
import type { GitHubAppStore } from "./github-app-store.js";
import type {
  GitHubAppManifestFlow,
  PublicManifestFlowState,
} from "./manifest-flow.js";
import { ManifestFlowError } from "./manifest-flow.js";

export type GitHubAppServiceErrorCode =
  | "github_connection_not_found"
  | "github_connection_revoked"
  | "github_credential_cleanup_failed"
  | "github_installation_not_found"
  | "github_installation_revoked"
  | "github_manifest_failed"
  | "github_repository_not_found"
  | "github_repository_revoked";

export class GitHubAppServiceError extends Error {
  constructor(readonly code: GitHubAppServiceErrorCode) {
    super(code);
    this.name = "GitHubAppServiceError";
  }
}

export interface GitHubAppServiceStore {
  saveConnection(connection: GitHubAppConnectionMetadata): void;
  getConnection(connectionId: string): GitHubAppConnectionMetadata | null;
  listConnections(): GitHubAppConnectionMetadata[];
  revokeConnection(connectionId: string, updatedAt: string): boolean;
  replaceInstallations(
    connectionId: string,
    installations: readonly GitHubAppInstallationMetadata[],
  ): void;
  getInstallation(installationId: string): GitHubAppInstallationMetadata | null;
  listInstallations(connectionId: string): GitHubAppInstallationMetadata[];
  replaceRepositories(
    installationId: string,
    repositories: readonly GitHubInstallationRepositoryMetadata[],
  ): void;
  listRepositories(installationId: string): GitHubInstallationRepositoryMetadata[];
  getRepository(repositoryId: string): GitHubInstallationRepositoryMetadata | null;
}

export interface GitHubAppServiceClient {
  exchangeManifestCode<T>(
    code: string,
    consume: (app: ManifestAppExchange) => Promise<T> | T,
  ): Promise<T>;
  listInstallations(
    connection: GitHubAppConnectionMetadata,
  ): Promise<GitHubAppInstallationMetadata[]>;
  listInstallationRepositories(
    connection: GitHubAppConnectionMetadata,
    installationId: string,
  ): Promise<GitHubInstallationRepositoryMetadata[]>;
  readRepositoryJson(
    connection: GitHubAppConnectionMetadata,
    installationId: string,
    repositoryId: string,
    path: string,
    permissions: GitHubInstallationPermissions,
  ): Promise<unknown>;
  writeRepositoryJson(
    connection: GitHubAppConnectionMetadata,
    installationId: string,
    repositoryId: string,
    path: string,
    method: "PATCH" | "POST",
    body: unknown,
    permissions: GitHubInstallationPermissions,
  ): Promise<unknown>;
  createRepositoryToken(
    connection: GitHubAppConnectionMetadata,
    installationId: string,
    repositoryId: string,
    permissions: GitHubInstallationPermissions,
  ): Promise<GitHubInstallationToken>;
  clearConnection(connectionId: string): void;
}

export interface GitHubAppServiceDependencies {
  flow: GitHubAppManifestFlow;
  credentials: GitHubAppCredentialStore;
  store: GitHubAppServiceStore | GitHubAppStore;
  client: GitHubAppServiceClient;
  now?: () => Date;
  createConnectionId?: () => string;
}

export interface CompleteManifestCallbackInput {
  flowId: string;
  state: string;
  code: string | null;
  error: string | null;
}

export interface AuthorizedGitHubRepositorySelection extends GitHubInstallationRepositoryMetadata {
  connectionId: string;
}

export class GitHubAppService {
  readonly #flow: GitHubAppManifestFlow;
  readonly #credentials: GitHubAppCredentialStore;
  readonly #store: GitHubAppServiceStore;
  readonly #client: GitHubAppServiceClient;
  readonly #now: () => Date;
  readonly #createConnectionId: () => string;

  constructor(dependencies: GitHubAppServiceDependencies) {
    this.#flow = dependencies.flow;
    this.#credentials = dependencies.credentials;
    this.#store = dependencies.store;
    this.#client = dependencies.client;
    this.#now = dependencies.now ?? (() => new Date());
    this.#createConnectionId = dependencies.createConnectionId ?? randomUUID;
  }

  startManifest(): { flowId: string; authorizeUrl: string } {
    return this.#flow.start();
  }

  manifestAuthorization(flowId: string) {
    return this.#flow.authorization(flowId);
  }

  manifestState(flowId: string): PublicManifestFlowState {
    return this.#flow.publicState(flowId);
  }

  async completeManifestCallback(
    input: CompleteManifestCallbackInput,
  ): Promise<PublicManifestFlowState> {
    const begun = this.#flow.beginCallback(input.flowId, input.state, input.error);
    if (begun.status === "denied") return { status: "denied" };
    if (input.code === null) {
      this.#flow.fail(input.flowId);
      throw new GitHubAppServiceError("github_manifest_failed");
    }

    let persistedConnectionId: string | null = null;
    try {
      const connectionId = await this.#client.exchangeManifestCode(
        input.code,
        async (app) => this.#saveManifestApp(app),
      );
      persistedConnectionId = connectionId;
      const connection = this.#readyConnection(connectionId);
      const installations = await this.#client.listInstallations(connection);
      this.#store.replaceInstallations(connection.id, installations);
      this.#flow.complete(input.flowId, connection.id);
      return { status: "completed", connectionId: connection.id };
    } catch (error) {
      this.#flow.fail(input.flowId);
      if (persistedConnectionId !== null) {
        const connection = this.#store.getConnection(persistedConnectionId);
        if (connection?.status === "ready") {
          this.#store.saveConnection({
            ...connection,
            status: "error",
            updatedAt: this.#now().toISOString(),
          });
        }
      }
      if (error instanceof GitHubAppClientError || error instanceof GitHubAppServiceError) {
        throw error;
      }
      throw new GitHubAppServiceError("github_manifest_failed");
    }
  }

  listConnections(): GitHubAppConnectionMetadata[] {
    return this.#store.listConnections();
  }

  listInstallations(connectionId: string): GitHubAppInstallationMetadata[] {
    this.#connection(connectionId);
    return this.#store.listInstallations(connectionId);
  }

  async refreshInstallations(connectionId: string): Promise<GitHubAppInstallationMetadata[]> {
    const connection = this.#readyConnection(connectionId);
    const installations = await this.#client.listInstallations(connection);
    this.#store.replaceInstallations(connection.id, installations);
    return this.#store.listInstallations(connection.id);
  }

  async refreshRepositories(installationId: string): Promise<GitHubInstallationRepositoryMetadata[]> {
    const installation = this.#installation(installationId);
    const connection = this.#readyConnection(installation.connectionId);
    if (installation.status !== "ready") {
      throw new GitHubAppServiceError("github_installation_revoked");
    }
    const repositories = await this.#client.listInstallationRepositories(
      connection,
      installation.id,
    );
    this.#store.replaceRepositories(installation.id, repositories);
    return this.#store.listRepositories(installation.id);
  }

  requireReadyRepository(repositoryId: string): GitHubInstallationRepositoryMetadata {
    const repository = this.#store.getRepository(repositoryId);
    if (!repository) throw new GitHubAppServiceError("github_repository_not_found");
    const installation = this.#installation(repository.installationId);
    this.#readyConnection(installation.connectionId);
    if (installation.status !== "ready") {
      throw new GitHubAppServiceError("github_installation_revoked");
    }
    if (repository.archived) {
      throw new GitHubAppServiceError("github_repository_revoked");
    }
    return repository;
  }

  requireAuthorizedRepository(
    connectionId: string,
    installationId: string,
    repositoryId: string,
  ): AuthorizedGitHubRepositorySelection {
    const connection = this.#readyConnection(connectionId);
    const installation = this.#installation(installationId);
    if (installation.connectionId !== connection.id || installation.status !== "ready") {
      throw new GitHubAppServiceError("github_installation_revoked");
    }
    const repository = this.#store.getRepository(repositoryId);
    if (!repository || repository.installationId !== installation.id) {
      throw new GitHubAppServiceError("github_repository_not_found");
    }
    if (repository.archived) {
      throw new GitHubAppServiceError("github_repository_revoked");
    }
    return { ...repository, connectionId: connection.id };
  }

  async readAuthorizedRepositoryJson(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    permissions: GitHubInstallationPermissions,
  ): Promise<unknown> {
    this.requireAuthorizedRepository(connectionId, installationId, repositoryId);
    return this.#client.readRepositoryJson(
      this.#readyConnection(connectionId),
      installationId,
      repositoryId,
      path,
      permissions,
    );
  }

  async writeAuthorizedRepositoryJson(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    method: "PATCH" | "POST",
    body: unknown,
    permissions: GitHubInstallationPermissions,
  ): Promise<unknown> {
    this.requireAuthorizedRepository(connectionId, installationId, repositoryId);
    return this.#client.writeRepositoryJson(
      this.#readyConnection(connectionId),
      installationId,
      repositoryId,
      path,
      method,
      body,
      permissions,
    );
  }

  async createAuthorizedRepositoryToken(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    permissions: GitHubInstallationPermissions,
  ): Promise<GitHubInstallationToken> {
    this.requireAuthorizedRepository(connectionId, installationId, repositoryId);
    return this.#client.createRepositoryToken(
      this.#readyConnection(connectionId),
      installationId,
      repositoryId,
      permissions,
    );
  }

  async disconnect(connectionId: string): Promise<void> {
    const connection = this.#connection(connectionId);
    const revoked = this.#store.revokeConnection(connection.id, this.#now().toISOString());
    if (!revoked) throw new GitHubAppServiceError("github_connection_not_found");
    this.#client.clearConnection(connection.id);
    try {
      await this.#credentials.delete(connection.id);
    } catch {
      // Metadata is already revoked, so no new GitHub operation can use a
      // native secret whose deletion failed.
      throw new GitHubAppServiceError("github_credential_cleanup_failed");
    }
  }

  async #saveManifestApp(app: ManifestAppExchange): Promise<string> {
    const connectionId = this.#createConnectionId();
    const timestamp = this.#now().toISOString();
    await this.#credentials.put(connectionId, { privateKeyPem: app.privateKeyPem });
    try {
      this.#store.saveConnection({
        id: connectionId,
        appId: app.appId,
        appSlug: app.appSlug,
        clientId: app.clientId,
        status: "ready",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch {
      try {
        await this.#credentials.delete(connectionId);
      } catch {
        // The native secret remains redacted. No ready metadata was committed.
      }
      throw new GitHubAppServiceError("github_manifest_failed");
    }
    return connectionId;
  }

  #connection(connectionId: string): GitHubAppConnectionMetadata {
    const connection = this.#store.getConnection(connectionId);
    if (!connection) throw new GitHubAppServiceError("github_connection_not_found");
    return connection;
  }

  #readyConnection(connectionId: string): GitHubAppConnectionMetadata {
    const connection = this.#connection(connectionId);
    if (connection.status !== "ready") {
      throw new GitHubAppServiceError("github_connection_revoked");
    }
    return connection;
  }

  #installation(installationId: string): GitHubAppInstallationMetadata {
    const installation = this.#store.getInstallation(installationId);
    if (!installation) throw new GitHubAppServiceError("github_installation_not_found");
    return installation;
  }
}

export function githubAppServiceErrorCode(error: unknown): string {
  if (
    error instanceof GitHubAppServiceError ||
    error instanceof GitHubAppClientError ||
    error instanceof ManifestFlowError
  ) {
    return error.code;
  }
  return "github_app_operation_failed";
}
