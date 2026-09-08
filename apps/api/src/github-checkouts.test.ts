import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GuardrailRepository } from "@csb/shared";
import {
  CheckoutMaintenanceError,
  createGitHubCheckoutsApp,
} from "./github-checkouts.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeCommit(repository: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(repository, file), content);
  git(repository, ["add", file]);
  git(repository, ["commit", "--quiet", "-m", message]);
}

function localRepository(repositoryPath: string): GuardrailRepository {
  return {
    repositoryKey: "github.com/acme/sentinel",
    repositoryPath,
    source: "local",
    displayName: "Sentinel",
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: "acme",
    remoteName: "sentinel",
    githubConnectionId: null,
    githubInstallationId: null,
    githubRepositoryId: null,
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
  };
}

function createFixture(): { root: string; seed: string; checkout: string; repository: GuardrailRepository } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-github-checkouts-"));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const checkout = path.join(root, "checkout");
  git(root, ["init", "--bare", "--quiet", remote]);
  git(root, ["init", "--quiet", "--initial-branch=main", seed]);
  git(seed, ["config", "user.name", "Sentinel test"]);
  git(seed, ["config", "user.email", "sentinel@example.test"]);
  writeCommit(seed, "README.md", "one\n", "initial");
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "--quiet", "-u", "origin", "main"]);
  git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(root, ["clone", "--quiet", remote, checkout]);
  git(checkout, ["config", "user.name", "Sentinel test"]);
  git(checkout, ["config", "user.email", "sentinel@example.test"]);
  return { root, seed, checkout, repository: localRepository(checkout) };
}

function request(app: ReturnType<typeof createGitHubCheckoutsApp>, method: "GET" | "POST", suffix: string, body?: unknown): Promise<Response> {
  return Promise.resolve(app.request(`http://localhost${suffix}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  }));
}

test("fetches and fast-forwards only a clean enrolled local checkout", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const app = createGitHubCheckoutsApp({
    getRepository: (key) => key === fixture.repository.repositoryKey ? fixture.repository : null,
    mode: () => "local",
    acquireMaintenance: () => () => undefined,
    // A file remote makes this test self-contained. Production does not allow it.
    remoteUrlAllowed: () => true,
    allowFileProtocol: true,
  });
  const key = encodeURIComponent(fixture.repository.repositoryKey);
  const hookMarker = path.join(fixture.checkout, "post-fetch-hook-ran");
  const monitorMarker = path.join(fixture.root, "fsmonitor-ran");
  const hook = path.join(fixture.checkout, ".git", "hooks", "post-fetch");
  const monitor = path.join(fixture.root, "fsmonitor-test.sh");
  fs.writeFileSync(hook, `#!/bin/sh\necho hook > '${hookMarker}'\n`);
  fs.writeFileSync(monitor, `#!/bin/sh\necho monitor > '${monitorMarker}'\nprintf 'version 2\\n'\n`);
  fs.chmodSync(hook, 0o755);
  fs.chmodSync(monitor, 0o755);
  git(fixture.checkout, ["config", "core.fsmonitor", monitor]);

  writeCommit(fixture.seed, "README.md", "two\n", "remote update");
  git(fixture.seed, ["push", "--quiet"]);

  const fetched = await request(app, "POST", `/github-checkouts/${key}/fetch`, { remote: "origin" });
  assert.equal(fetched.status, 200);
  const fetchedBody = await fetched.json() as { checkout: { behind: number; dirty: boolean; canPull: boolean } };
  assert.equal(fetchedBody.checkout.behind, 1);
  assert.equal(fetchedBody.checkout.dirty, false);
  assert.equal(fetchedBody.checkout.canPull, true);
  assert.equal(fs.existsSync(hookMarker), false);
  assert.equal(fs.existsSync(monitorMarker), false);

  const pulled = await request(app, "POST", `/github-checkouts/${key}/pull`, { remote: "origin" });
  assert.equal(pulled.status, 200);
  assert.equal(fs.readFileSync(path.join(fixture.checkout, "README.md"), "utf8"), "two\n");
  assert.equal((await pulled.json() as { checkout: { behind: number; ahead: number } }).checkout.behind, 0);

  writeCommit(fixture.seed, "README.md", "three\n", "second remote update");
  git(fixture.seed, ["push", "--quiet"]);
  fs.writeFileSync(path.join(fixture.checkout, "untracked.txt"), "must survive\n");
  const dirty = await request(app, "POST", `/github-checkouts/${key}/pull`, { remote: "origin" });
  assert.equal(dirty.status, 409);
  assert.deepEqual(await dirty.json(), { error: "checkout_dirty" });
  assert.equal(fs.readFileSync(path.join(fixture.checkout, "untracked.txt"), "utf8"), "must survive\n");

  fs.rmSync(path.join(fixture.checkout, "untracked.txt"));
  writeCommit(fixture.checkout, "LOCAL.md", "local\n", "local change");
  const diverged = await request(app, "POST", `/github-checkouts/${key}/pull`, { remote: "origin" });
  assert.equal(diverged.status, 409);
  assert.deepEqual(await diverged.json(), { error: "checkout_diverged" });
  assert.equal(fs.existsSync(path.join(fixture.checkout, "LOCAL.md")), true);
});

test("returns checkout status but never writes a Docker/server checkout", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let maintenanceCalls = 0;
  const app = createGitHubCheckoutsApp({
    getRepository: () => fixture.repository,
    mode: () => "server",
    repositoryRoots: () => [fixture.root],
    acquireMaintenance: () => { maintenanceCalls += 1; return () => undefined; },
    remoteUrlAllowed: () => true,
    allowFileProtocol: true,
  });
  const key = encodeURIComponent(fixture.repository.repositoryKey);

  const status = await request(app, "GET", `/github-checkouts?repositoryKey=${key}`);
  assert.equal(status.status, 200);
  const statusBody = await status.json() as { checkout: { writable: boolean; canFetch: boolean; canPull: boolean; reason: string | null } };
  assert.equal(statusBody.checkout.writable, false);
  assert.equal(statusBody.checkout.canFetch, false);
  assert.equal(statusBody.checkout.canPull, false);
  assert.equal(statusBody.checkout.reason, "checkout_write_unsupported");
  const fetch = await request(app, "POST", `/github-checkouts/${key}/fetch`, { remote: "origin" });
  assert.equal(fetch.status, 409);
  assert.deepEqual(await fetch.json(), { error: "checkout_write_unsupported" });
  assert.equal(maintenanceCalls, 0);
});

test("rejects remote-only and unknown repositories, unsafe remotes, and active scans", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const remoteRepository = { ...fixture.repository, source: "github" as const, repositoryPath: null };
  const key = encodeURIComponent(fixture.repository.repositoryKey);
  const remoteOnly = createGitHubCheckoutsApp({
    getRepository: () => remoteRepository,
    mode: () => "local",
    acquireMaintenance: () => () => undefined,
  });
  assert.equal((await request(remoteOnly, "GET", `/github-checkouts?repositoryKey=${key}`)).status, 409);

  const missing = createGitHubCheckoutsApp({
    getRepository: () => null,
    mode: () => "local",
    acquireMaintenance: () => () => undefined,
  });
  assert.deepEqual(await (await request(missing, "GET", `/github-checkouts?repositoryKey=${key}`)).json(), { error: "repository_not_found" });

  const unsafeRemote = createGitHubCheckoutsApp({
    getRepository: () => fixture.repository,
    mode: () => "local",
    acquireMaintenance: () => () => undefined,
  });
  const unsafe = await request(unsafeRemote, "POST", `/github-checkouts/${key}/fetch`, { remote: "origin" });
  assert.equal(unsafe.status, 409);
  assert.deepEqual(await unsafe.json(), { error: "checkout_remote_unsupported" });

  const blocked = createGitHubCheckoutsApp({
    getRepository: () => fixture.repository,
    mode: () => "local",
    acquireMaintenance: () => { throw new CheckoutMaintenanceError("scan_active"); },
    remoteUrlAllowed: () => true,
  });
  const blockedResponse = await request(blocked, "POST", `/github-checkouts/${key}/fetch`, { remote: "origin" });
  assert.equal(blockedResponse.status, 409);
  assert.deepEqual(await blockedResponse.json(), { error: "scan_active" });
});
