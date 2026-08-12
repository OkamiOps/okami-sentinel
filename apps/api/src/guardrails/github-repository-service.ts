import type { GuardrailRepository } from "@csb/shared";

import type { EnrollGuardrailRepositoryRequest } from "./repository-source-adapter.js";

export interface AuthorizedGitHubRepository {
  repositoryId: string;
  installationId: string;
  connectionId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  updatedAt: string;
}

export type GitHubRepositoryEnrollmentErrorCode =
  | "github_repository_authority_mismatch"
  | "github_repository_unavailable"
  | "local_repository_contract_invalid";

export class GitHubRepositoryEnrollmentError extends Error {
  constructor(readonly code: GitHubRepositoryEnrollmentErrorCode) {
    super(code);
    this.name = "GitHubRepositoryEnrollmentError";
  }
}

export interface GitHubRepositoryServiceDependencies {
  inspectLocal(repositoryPath: string, displayName?: string): Promise<GuardrailRepository>;
  requireAuthorizedRepository(
    connectionId: string,
    installationId: string,
    repositoryId: string,
  ): AuthorizedGitHubRepository;
}

export class GitHubRepositoryService {
  readonly #inspectLocal: GitHubRepositoryServiceDependencies["inspectLocal"];
  readonly #requireAuthorizedRepository: GitHubRepositoryServiceDependencies["requireAuthorizedRepository"];

  constructor(dependencies: GitHubRepositoryServiceDependencies) {
    this.#inspectLocal = dependencies.inspectLocal;
    this.#requireAuthorizedRepository = dependencies.requireAuthorizedRepository;
  }

  async enroll(input: EnrollGuardrailRepositoryRequest): Promise<GuardrailRepository> {
    if (input.source === "local") {
      const repository = await this.#inspectLocal(input.repositoryPath, input.displayName);
      if (repository.source !== "local" || repository.repositoryPath === null) {
        throw new GitHubRepositoryEnrollmentError("local_repository_contract_invalid");
      }
      return repository;
    }

    const authorized = this.#requireAuthorizedRepository(
      input.connectionId,
      input.installationId,
      input.repositoryId,
    );
    if (
      authorized.connectionId !== input.connectionId
      || authorized.installationId !== input.installationId
      || authorized.repositoryId !== input.repositoryId
    ) {
      throw new GitHubRepositoryEnrollmentError("github_repository_authority_mismatch");
    }
    if (authorized.archived) {
      throw new GitHubRepositoryEnrollmentError("github_repository_unavailable");
    }

    return {
      repositoryKey: `github:${authorized.repositoryId}`,
      repositoryPath: null,
      source: "github",
      displayName: input.displayName ?? `${authorized.owner}/${authorized.name}`,
      defaultBranch: authorized.defaultBranch,
      defaultExecutor: input.defaultExecutor,
      remoteOwner: authorized.owner,
      remoteName: authorized.name,
      githubConnectionId: authorized.connectionId,
      githubInstallationId: authorized.installationId,
      githubRepositoryId: authorized.repositoryId,
      enabled: true,
      policyPath: ".csb/guardrails.json",
      lastGateId: null,
      githubStatus: "not_checked",
    };
  }
}
