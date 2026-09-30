import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";
import type { GuardrailRepository } from "@csb/shared";

import { LOCAL_PRINCIPAL } from "../auth/principal.js";
import { createGitHubBranchesApp } from "./branches-api.js";

const remote = {
  repositoryKey: "github:1", source: "github", enabled: true, defaultBranch: "main",
  repositoryPath: null, remoteOwner: "okami", remoteName: "sentinel",
  githubConnectionId: "c1", githubInstallationId: "i1", githubRepositoryId: "1",
} as GuardrailRepository;

const local = {
  repositoryKey: "local:/repos/app", source: "local", enabled: true, defaultBranch: "main",
  repositoryPath: "/repos/app", remoteOwner: null, remoteName: null,
  githubConnectionId: null, githubInstallationId: null, githubRepositoryId: null,
} as GuardrailRepository;

function probe(options: {
  grants?: Map<string, string>;
  isAdmin?: boolean;
  branches?: () => Promise<string[]>;
} = {}) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, {
      ...LOCAL_PRINCIPAL,
      kind: "user",
      isAdmin: options.isAdmin ?? false,
      grants: options.grants ?? new Map([["github:1", "viewer"]]),
    } as never);
    await next();
  });
  app.route("/", createGitHubBranchesApp({
    getRepository: (key) => (key === remote.repositoryKey ? remote : key === local.repositoryKey ? local : null),
    listBranchNames: options.branches ?? (async () => ["release/1", "main"]),
  }));
  return app;
}

test("lists the branches of a repository the caller can see, sorted", async () => {
  const response = await probe().request("/github/branches?repositoryKey=github%3A1");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { branches: ["main", "release/1"] });
});

test("a repository outside the caller's grants is invisible, not forbidden", async () => {
  const response = await probe({ grants: new Map([["github:2", "viewer"]]) })
    .request("/github/branches?repositoryKey=github%3A1");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("an unknown repository answers exactly like an invisible one", async () => {
  const response = await probe({ isAdmin: true }).request("/github/branches?repositoryKey=github%3A404");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("a local repository has no branches to read from the App", async () => {
  const response = await probe({ isAdmin: true })
    .request(`/github/branches?repositoryKey=${encodeURIComponent(local.repositoryKey)}`);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "github_repository_unsupported" });
});

test("a missing key is refused before anything is read", async () => {
  const response = await probe({ isAdmin: true }).request("/github/branches");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "repository_key_required" });
});

test("an upstream failure never leaks its message", async () => {
  const response = await probe({
    branches: async () => { throw new Error("token for installation 42 was rejected"); },
  }).request("/github/branches?repositoryKey=github%3A1");
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "github_branches_failed" });
});
