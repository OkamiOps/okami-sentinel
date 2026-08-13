import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import type { GuardrailRepository } from "@csb/shared";

import {
  GitHubArchiveClient,
  GitHubArchiveClientError,
  type ArchiveHttpRequest,
  type ArchiveHttpResponse,
} from "./github-archive-client.js";

const SHA = "a".repeat(40);

test("downloads the exact commit archive and strips authorization on the approved redirect", async () => {
  const requests: ArchiveHttpRequest[] = [];
  const client = new GitHubArchiveClient({
    authorize: async () => ({
      owner: "OkamiOps",
      name: "private-sentinel",
      token: "ghs_private_archive",
    }),
    transport: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return response(302, [], {
          location: `https://codeload.github.com/OkamiOps/private-sentinel/legacy.tar.gz/${SHA}`,
        });
      }
      return response(200, [Buffer.from("archive-bytes")], {
        contentLength: String(Buffer.byteLength("archive-bytes")),
      });
    },
    maxCompressedBytes: 64,
  });

  assert.equal(await read(await client.download(repository(), SHA)), "archive-bytes");
  assert.equal(
    requests[0]?.url,
    `https://api.github.com/repos/OkamiOps/private-sentinel/tarball/${SHA}`,
  );
  assert.equal(requests[0]?.headers.Authorization, "Bearer ghs_private_archive");
  assert.equal(requests[0]?.headers["User-Agent"], "okami-sentinel");
  assert.equal(requests[1]?.headers.Authorization, undefined);
  assert.equal(requests[1]?.headers["User-Agent"], "okami-sentinel");
  assert.equal(requests[1]?.url.startsWith("https://codeload.github.com/"), true);
});

test("rejects redirects outside approved GitHub archive hosts without following them", async () => {
  const requests: ArchiveHttpRequest[] = [];
  const client = archiveClient(async (request) => {
    requests.push(request);
    return response(302, [], { location: "https://objects.evil.example/private.tar.gz?token=secret" });
  });

  await assert.rejects(
    client.download(repository(), SHA),
    (error: unknown) => error instanceof GitHubArchiveClientError
      && error.code === "archive_redirect_rejected",
  );
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(requests).includes("evil.example"), false);
});

test("consumes the abort emitted when closing a redirect response body", async () => {
  const redirectBody = new PassThrough();
  const client = archiveClient(async (request) => request.url.startsWith("https://api.github.com/")
    ? { status: 302, headers: { location: `https://codeload.github.com/OkamiOps/private-sentinel/legacy.tar.gz/${SHA}` }, body: redirectBody }
    : response(200, [Buffer.from("archive-bytes")]));

  assert.equal(await read(await client.download(repository(), SHA)), "archive-bytes");
  redirectBody.emit("error", new Error("redirect body aborted"));
});

test("enforces the compressed byte limit from headers and streamed bytes", async () => {
  const declared = archiveClient(async () => response(200, [], { contentLength: "65" }));
  await assert.rejects(
    declared.download(repository(), SHA),
    (error: unknown) => error instanceof GitHubArchiveClientError
      && error.code === "archive_too_large",
  );

  const streamed = archiveClient(async () => response(200, [Buffer.alloc(40), Buffer.alloc(40)]));
  await assert.rejects(
    read(await streamed.download(repository(), SHA)),
    (error: unknown) => error instanceof GitHubArchiveClientError
      && error.code === "archive_too_large",
  );
});

test("rejects non-canonical SHAs before authorization or transport", async () => {
  let authorized = 0;
  const client = new GitHubArchiveClient({
    authorize: async () => {
      authorized += 1;
      return { owner: "OkamiOps", name: "private-sentinel", token: "token" };
    },
    transport: async () => assert.fail("transport must not run"),
  });
  await assert.rejects(client.download(repository(), "main"), GitHubArchiveClientError);
  assert.equal(authorized, 0);
});

function archiveClient(
  transport: (request: ArchiveHttpRequest) => Promise<ArchiveHttpResponse>,
): GitHubArchiveClient {
  return new GitHubArchiveClient({
    authorize: async () => ({
      owner: "OkamiOps",
      name: "private-sentinel",
      token: "ghs_private_archive",
    }),
    transport,
    maxCompressedBytes: 64,
  });
}

function response(
  status: number,
  chunks: Buffer[],
  headers: ArchiveHttpResponse["headers"] = {},
): ArchiveHttpResponse {
  return { status, headers, body: Readable.from(chunks) };
}

async function read(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function repository(): GuardrailRepository {
  return {
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    displayName: "OkamiOps/private-sentinel",
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: "OkamiOps",
    remoteName: "private-sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "991122",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
  };
}
