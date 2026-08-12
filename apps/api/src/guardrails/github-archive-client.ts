import { Readable } from "node:stream";

import type { GuardrailRepository } from "@csb/shared";
import { request as undiciRequest } from "undici";

const DEFAULT_MAX_COMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const APPROVED_ARCHIVE_HOSTS = new Set(["api.github.com", "codeload.github.com"]);

export type GitHubArchiveClientErrorCode =
  | "archive_download_failed"
  | "archive_not_found"
  | "archive_protocol_error"
  | "archive_redirect_rejected"
  | "archive_too_large";

export class GitHubArchiveClientError extends Error {
  constructor(readonly code: GitHubArchiveClientErrorCode) {
    super(code);
    this.name = "GitHubArchiveClientError";
  }
}

export interface GitHubArchiveAuthorization {
  owner: string;
  name: string;
  token: string;
}

export interface ArchiveHttpRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface ArchiveHttpResponse {
  status: number;
  headers: {
    location?: string;
    contentLength?: string;
  };
  body: AsyncIterable<Uint8Array> | null;
}

export type ArchiveHttpTransport = (
  request: ArchiveHttpRequest,
) => Promise<ArchiveHttpResponse>;

export interface GitHubArchiveClientDependencies {
  authorize(repository: GuardrailRepository): Promise<GitHubArchiveAuthorization>;
  transport?: ArchiveHttpTransport;
  maxCompressedBytes?: number;
}

export class GitHubArchiveClient {
  readonly #transport: ArchiveHttpTransport;
  readonly #maxCompressedBytes: number;

  constructor(readonly dependencies: GitHubArchiveClientDependencies) {
    this.#transport = dependencies.transport ?? transportArchiveRequest;
    this.#maxCompressedBytes = positiveLimit(
      dependencies.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES,
    );
  }

  async download(
    repository: GuardrailRepository,
    commitSha: string,
    signal?: AbortSignal,
  ): Promise<Readable> {
    const sha = fullSha(commitSha);
    const authorization = await this.dependencies.authorize(repository);
    const owner = pathSegment(authorization.owner);
    const name = pathSegment(authorization.name);
    const token = secret(authorization.token);
    let url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tarball/${sha}`;
    let includeAuthorization = true;

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      let response: ArchiveHttpResponse;
      try {
        response = await this.#transport({
          url,
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            ...(includeAuthorization ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        throw new GitHubArchiveClientError("archive_download_failed");
      }

      if (isRedirect(response.status)) {
        closeBody(response.body);
        if (redirect === MAX_REDIRECTS || response.headers.location === undefined) {
          throw new GitHubArchiveClientError("archive_redirect_rejected");
        }
        const next = approvedRedirect(response.headers.location, url);
        url = next.toString();
        includeAuthorization = next.hostname === "api.github.com";
        continue;
      }
      if (response.status === 404) {
        closeBody(response.body);
        throw new GitHubArchiveClientError("archive_not_found");
      }
      if (response.status !== 200 || response.body === null) {
        closeBody(response.body);
        throw new GitHubArchiveClientError("archive_download_failed");
      }
      const declaredLength = contentLength(response.headers.contentLength);
      if (declaredLength !== null && declaredLength > this.#maxCompressedBytes) {
        closeBody(response.body);
        throw new GitHubArchiveClientError("archive_too_large");
      }
      return boundedReadable(response.body, this.#maxCompressedBytes);
    }
    throw new GitHubArchiveClientError("archive_redirect_rejected");
  }
}

function boundedReadable(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Readable {
  return Readable.from((async function* () {
    let bytes = 0;
    try {
      for await (const value of body) {
        const chunk = Buffer.from(value);
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          throw new GitHubArchiveClientError("archive_too_large");
        }
        yield chunk;
      }
    } catch (error) {
      if (error instanceof GitHubArchiveClientError) throw error;
      throw new GitHubArchiveClientError("archive_download_failed");
    }
  })());
}

async function transportArchiveRequest(
  request: ArchiveHttpRequest,
): Promise<ArchiveHttpResponse> {
  const response = await undiciRequest(request.url, {
    method: "GET",
    headers: request.headers,
    headersTimeout: 0,
    bodyTimeout: 0,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  return {
    status: response.statusCode,
    headers: {
      location: headerValue(response.headers.location),
      contentLength: headerValue(response.headers["content-length"]),
    },
    body: response.body,
  };
}

function approvedRedirect(value: string, current: string): URL {
  let candidate: URL;
  try {
    candidate = new URL(value, current);
  } catch {
    throw new GitHubArchiveClientError("archive_redirect_rejected");
  }
  if (
    candidate.protocol !== "https:"
    || candidate.port !== ""
    || candidate.username !== ""
    || candidate.password !== ""
    || candidate.hash !== ""
    || !APPROVED_ARCHIVE_HOSTS.has(candidate.hostname)
  ) {
    throw new GitHubArchiveClientError("archive_redirect_rejected");
  }
  return candidate;
}

function closeBody(body: AsyncIterable<Uint8Array> | null): void {
  if (body === null) return;
  const destroy = (body as { destroy?: () => void }).destroy;
  if (typeof destroy === "function") destroy.call(body);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 307 || status === 308;
}

function contentLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new GitHubArchiveClientError("archive_protocol_error");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new GitHubArchiveClientError("archive_protocol_error");
  }
  return parsed;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function fullSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new GitHubArchiveClientError("archive_protocol_error");
  }
  return value;
}

function pathSegment(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 255
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new GitHubArchiveClientError("archive_protocol_error");
  }
  return value;
}

function secret(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 16_384 || value.includes("\0")) {
    throw new GitHubArchiveClientError("archive_protocol_error");
  }
  return value;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubArchiveClientError("archive_protocol_error");
  }
  return value;
}
