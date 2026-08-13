import type {
  GateExecutorKind,
  GuardrailPullRequestSummary,
  GuardrailRepository,
} from "@csb/shared";

import { githubAppServiceErrorCode } from "../github-app/github-app-service.js";
import type { GitHubInstallationPermissions } from "../github-app/github-app-client.js";

export type EnrollGuardrailRepositoryRequest =
  | {
      source: "local";
      repositoryPath: string;
      displayName?: string;
    }
  | {
      source: "github";
      connectionId: string;
      installationId: string;
      repositoryId: string;
      defaultExecutor: GateExecutorKind;
      displayName?: string;
    };

export type RepositorySourceInputErrorCode = "repository_request_invalid";

export class RepositorySourceInputError extends Error {
  constructor(readonly code: RepositorySourceInputErrorCode) {
    super(code);
    this.name = "RepositorySourceInputError";
  }
}

export interface RemoteRepositoryFile {
  path: string;
  content: string;
  blobSha: string;
}

export interface GitHubRepositoryReader {
  readPullRequest(repository: GuardrailRepository, number: number): Promise<unknown>;
  readCommit(repository: GuardrailRepository, ref: string): Promise<unknown>;
  readFile(
    repository: GuardrailRepository,
    commitSha: string,
    repositoryPath: string,
  ): Promise<RemoteRepositoryFile | null>;
}

export interface GitHubRepositoryResourceAuthority {
  readAuthorizedRepositoryJson(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    permissions: GitHubInstallationPermissions,
  ): Promise<unknown>;
}

export class GitHubRepositorySourceAdapter implements GitHubRepositoryReader {
  constructor(readonly authority: GitHubRepositoryResourceAuthority) {}

  async listOpenPullRequests(repository: GuardrailRepository): Promise<GuardrailPullRequestSummary[]> {
    const value = await this.#read(
      repository,
      "/pulls?state=open&sort=updated&direction=desc&per_page=50",
      { pull_requests: "read" },
    );
    if (!Array.isArray(value) || value.length > 50) fail();
    return value.map((entry) => {
      const pullRequest = record(entry);
      const user = record(pullRequest.user);
      const base = record(pullRequest.base);
      const head = record(pullRequest.head);
      const number = pullRequest.number;
      if (!Number.isSafeInteger(number) || (number as number) <= 0 || typeof pullRequest.draft !== "boolean") fail();
      const updatedAt = boundedString(pullRequest.updated_at, 64);
      if (!Number.isFinite(Date.parse(updatedAt))) fail();
      return {
        number: number as number,
        title: boundedString(pullRequest.title, 512),
        draft: pullRequest.draft,
        author: identifier(user.login),
        baseRef: boundedString(base.ref, 255),
        headRef: boundedString(head.ref, 255),
        updatedAt,
      };
    }).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  readPullRequest(repository: GuardrailRepository, number: number): Promise<unknown> {
    if (!Number.isSafeInteger(number) || number <= 0) fail();
    return this.#read(
      repository,
      `/pulls/${number}`,
      { pull_requests: "read" },
    );
  }

  readCommit(repository: GuardrailRepository, ref: string): Promise<unknown> {
    const safeRef = boundedString(ref, 255);
    return this.#read(
      repository,
      `/commits/${encodeURIComponent(safeRef)}`,
      { contents: "read" },
    );
  }

  async readFile(
    repository: GuardrailRepository,
    commitSha: string,
    repositoryPath: string,
  ): Promise<RemoteRepositoryFile | null> {
    const sha = fullSha(commitSha);
    const safePath = relativeRepositoryPath(repositoryPath);
    let value: unknown;
    try {
      value = await this.#read(
        repository,
        `/contents/${safePath.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`,
        { contents: "read" },
      );
    } catch (error) {
      if (githubAppServiceErrorCode(error) === "github_not_found") return null;
      throw error;
    }
    const item = record(value);
    if (
      item.type !== "file"
      || item.encoding !== "base64"
      || item.path !== safePath
      || typeof item.content !== "string"
      || typeof item.size !== "number"
      || !Number.isSafeInteger(item.size)
      || item.size < 0
      || item.size > 1_048_576
    ) fail();
    const encoded = item.content.replaceAll(/\s/g, "");
    if (
      encoded.length % 4 !== 0
      || (encoded.length > 0 && !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    ) fail();
    const content = Buffer.from(encoded, "base64");
    if (
      content.byteLength !== item.size
      || content.byteLength > 1_048_576
      || content.toString("base64") !== encoded
    ) fail();
    return {
      path: safePath,
      content: content.toString("utf8"),
      blobSha: fullSha(item.sha),
    };
  }

  #read(
    repository: GuardrailRepository,
    suffix: string,
    permissions: GitHubInstallationPermissions,
  ): Promise<unknown> {
    const identity = remoteIdentity(repository);
    return this.authority.readAuthorizedRepositoryJson(
      identity.connectionId,
      identity.installationId,
      identity.repositoryId,
      `/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.name)}${suffix}`,
      permissions,
    );
  }
}

const LOCAL_KEYS = new Set(["source", "repositoryPath", "displayName"]);
const GITHUB_KEYS = new Set([
  "source",
  "connectionId",
  "installationId",
  "repositoryId",
  "defaultExecutor",
  "displayName",
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,19}$/;

export function parseEnrollGuardrailRepositoryRequest(
  value: unknown,
): EnrollGuardrailRepositoryRequest {
  const input = record(value);
  if (input.source === "local") {
    exactKeys(input, LOCAL_KEYS);
    return optionalDisplayName({
      source: "local",
      repositoryPath: boundedString(input.repositoryPath, 4_096),
    }, input.displayName);
  }
  if (input.source === "github") {
    exactKeys(input, GITHUB_KEYS);
    const defaultExecutor = input.defaultExecutor;
    if (defaultExecutor !== "sentinel-managed" && defaultExecutor !== "github-actions") fail();
    return optionalDisplayName({
      source: "github",
      connectionId: identifier(input.connectionId),
      installationId: positiveIdentifier(input.installationId),
      repositoryId: positiveIdentifier(input.repositoryId),
      defaultExecutor,
    }, input.displayName);
  }
  fail();
}

function optionalDisplayName<T extends object>(
  input: T,
  value: unknown,
): T & { displayName?: string } {
  if (value === undefined) return input;
  return { ...input, displayName: boundedString(value, 255) };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function remoteIdentity(repository: GuardrailRepository): {
  connectionId: string;
  installationId: string;
  repositoryId: string;
  owner: string;
  name: string;
} {
  if (
    repository.source !== "github"
    || repository.repositoryPath !== null
    || repository.githubConnectionId === null
    || repository.githubInstallationId === null
    || repository.githubRepositoryId === null
    || repository.remoteOwner === null
    || repository.remoteName === null
  ) fail();
  return {
    connectionId: identifier(repository.githubConnectionId),
    installationId: positiveIdentifier(repository.githubInstallationId),
    repositoryId: positiveIdentifier(repository.githubRepositoryId),
    owner: pathSegment(repository.remoteOwner),
    name: pathSegment(repository.remoteName),
  };
}

function pathSegment(value: unknown): string {
  const segment = boundedString(value, 255);
  if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) fail();
  return segment;
}

function relativeRepositoryPath(value: unknown): string {
  const normalized = boundedString(value, 1_024).replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (normalized.startsWith("/") || parts.some((part) => part === "" || part === "." || part === "..")) fail();
  return parts.join("/");
}

function fullSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) fail();
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) fail();
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") fail();
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || normalized.includes("\0")) fail();
  return normalized;
}

function identifier(value: unknown): string {
  const normalized = boundedString(value, 255);
  if (!IDENTIFIER.test(normalized)) fail();
  return normalized;
}

function positiveIdentifier(value: unknown): string {
  const normalized = boundedString(value, 20);
  if (!POSITIVE_INTEGER.test(normalized)) fail();
  return normalized;
}

function fail(): never {
  throw new RepositorySourceInputError("repository_request_invalid");
}
