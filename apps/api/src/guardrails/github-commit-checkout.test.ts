import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { GuardrailRepository } from "@csb/shared";

import {
  GitHubCommitCheckout,
  GitHubCommitCheckoutError,
  type GitCommitCommandResult,
} from "./github-commit-checkout.js";

const TOKEN = "ghs_private_checkout";
const SHA = "a".repeat(40);

test("checks out the exact SHA from a file remote and strips Git metadata", async (t) => {
  const fixture = createFixture();
  t.after(() => removeFixture(fixture.root));
  const dest = path.join(fixture.root, "dest");
  fs.mkdirSync(dest, { mode: 0o700 });
  const checkout = new GitHubCommitCheckout({
    authorize: async () => ({ owner: "OkamiOps", name: "private-sentinel", token: TOKEN }),
    allowFileProtocol: true,
    remoteUrl: () => fileRemote(fixture.remote),
    timeoutMs: 5_000,
  });

  await checkout.checkout(repository(), fixture.sha, dest);

  assert.equal(fs.existsSync(path.join(dest, ".git")), false);
  assert.equal(fs.readFileSync(path.join(dest, "README.md"), "utf8"), "hello\n");
  assert.equal(fs.readFileSync(path.join(dest, "src", "app.ts"), "utf8"), "export const app = true;\n");
});

test("never puts the token in the remote URL or closed errors", async () => {
  const commands: string[][] = [];
  const dest = emptyDest();
  try {
    const checkout = new GitHubCommitCheckout({
      authorize: async () => ({ owner: "OkamiOps", name: "private-sentinel", token: TOKEN }),
      runner: async (args) => {
        commands.push([...args]);
        if (args.includes("fetch")) {
          return result(1, `fatal: Authentication failed for token ${TOKEN}\n`);
        }
        return result(0);
      },
    });

    await assert.rejects(
      checkout.checkout(repository(), SHA, dest),
      (error: unknown) => {
        assert.equal(error instanceof GitHubCommitCheckoutError, true);
        assert.equal((error as GitHubCommitCheckoutError).code, "checkout_git_failed");
        assert.equal(JSON.stringify(error).includes(TOKEN), false);
        assert.equal(String(error).includes(TOKEN), false);
        return true;
      },
    );

    const remoteAdd = commands.find((args) => args.includes("remote") && args.includes("add"));
    const fetch = commands.find((args) => args.includes("fetch"));
    assert.equal(remoteAdd?.includes("https://github.com/OkamiOps/private-sentinel.git"), true);
    assert.equal(JSON.stringify(remoteAdd).includes(TOKEN), false);
    assert.equal(fetch?.includes("http.extraHeader=AUTHORIZATION: bearer ghs_private_checkout"), true);
    assert.equal(fetch?.includes(`https://x-access-token:${TOKEN}@github.com`), false);
  } finally {
    fs.rmSync(path.dirname(dest), { recursive: true, force: true });
  }
});

test("rejects credentials in the remote URL without fetching", async () => {
  const dest = emptyDest();
  let ran = 0;
  try {
    const checkout = new GitHubCommitCheckout({
      authorize: async () => ({ owner: "OkamiOps", name: "private-sentinel", token: TOKEN }),
      remoteUrl: () => `https://x-access-token:${TOKEN}@github.com/OkamiOps/private-sentinel.git`,
      runner: async () => {
        ran += 1;
        return result(0);
      },
    });
    await assert.rejects(
      checkout.checkout(repository(), SHA, dest),
      (error: unknown) => error instanceof GitHubCommitCheckoutError
        && error.code === "checkout_protocol_error",
    );
    assert.equal(ran, 0);
  } finally {
    fs.rmSync(path.dirname(dest), { recursive: true, force: true });
  }
});

test("maps abort and timeout to closed codes without archive side effects", async () => {
  const dest = emptyDest();
  try {
    const aborted = new AbortController();
    aborted.abort();
    const checkout = new GitHubCommitCheckout({
      authorize: async () => ({ owner: "OkamiOps", name: "private-sentinel", token: TOKEN }),
      runner: async () => result(0),
    });
    await assert.rejects(
      checkout.checkout(repository(), SHA, dest, aborted.signal),
      (error: unknown) => error instanceof GitHubCommitCheckoutError
        && error.code === "checkout_cancelled",
    );

    const timed = new GitHubCommitCheckout({
      authorize: async () => ({ owner: "OkamiOps", name: "private-sentinel", token: TOKEN }),
      runner: async () => ({ stdout: "", stderr: "", exitCode: 1, timedOut: true }),
    });
    await assert.rejects(
      timed.checkout(repository(), SHA, dest),
      (error: unknown) => error instanceof GitHubCommitCheckoutError
        && error.code === "checkout_timeout",
    );
  } finally {
    fs.rmSync(path.dirname(dest), { recursive: true, force: true });
  }
});

function createFixture(): { root: string; remote: string; sha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-commit-checkout-"));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, ["init", "--bare", "--quiet", remote]);
  git(root, ["init", "--quiet", "--initial-branch=main", seed]);
  git(seed, ["config", "user.name", "Sentinel test"]);
  git(seed, ["config", "user.email", "sentinel@example.test"]);
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n");
  git(seed, ["add", "README.md"]);
  git(seed, ["commit", "--quiet", "-m", "initial"]);
  fs.mkdirSync(path.join(seed, "src"));
  fs.writeFileSync(path.join(seed, "src", "app.ts"), "export const app = true;\n");
  git(seed, ["add", "src/app.ts"]);
  git(seed, ["commit", "--quiet", "-m", "source"]);
  const sha = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "--quiet", "origin", "main"]);
  return { root, remote, sha };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fileRemote(directory: string): string {
  return new URL(`file://${path.resolve(directory)}`).href;
}

function emptyDest(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-commit-dest-"));
  const dest = path.join(root, "dest");
  fs.mkdirSync(dest, { mode: 0o700 });
  return dest;
}

function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function result(exitCode: number, stderr = ""): GitCommitCommandResult {
  return { stdout: "", stderr, exitCode, timedOut: false };
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
