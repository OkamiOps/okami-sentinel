import assert from "node:assert/strict";
import test from "node:test";

import {
  GitChangeSetError,
  parseNameStatusZ,
  resolveChangeSet,
  type GitRunner,
} from "./git-change-set.js";

function fakeGit(status: string, root = "/repo"): GitRunner {
  return async (args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return `${root}\n`;
    if (command === "rev-parse --verify main^{commit}") return "base-sha\n";
    if (command === "rev-parse --verify HEAD^{commit}") return "head-sha\n";
    if (command === "diff --name-status --find-renames -z base-sha...head-sha") return status;
    throw new Error(`unexpected git call: ${command}`);
  };
}

test("parses modified, deleted and renamed paths from nul-separated git output", () => {
  assert.deepEqual(parseNameStatusZ("M\0src/a.ts\0D\0src/old.ts\0R100\0src/from.ts\0src/to.ts\0"), [
    { status: "modified", path: "src/a.ts", previousPath: null },
    { status: "deleted", path: "src/old.ts", previousPath: null },
    { status: "renamed", path: "src/to.ts", previousPath: "src/from.ts" },
  ]);
});

test("parses added paths and rejects incomplete or unsupported records", () => {
  assert.deepEqual(parseNameStatusZ("A\0src/new.ts\0"), [
    { status: "added", path: "src/new.ts", previousPath: null },
  ]);
  assert.throws(() => parseNameStatusZ("R100\0src/from.ts\0"), /rename/i);
  assert.throws(() => parseNameStatusZ("X\0src/a.ts\0"), /status/i);
});

test("resolves git root and immutable revisions without a shell", async () => {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
    if (args.at(-1) === "main^{commit}") return "base-sha\n";
    if (args.at(-1) === "feature^{commit}") return "head-sha\n";
    return "M\0src/a.ts\0D\0src/old.ts\0R087\0src/from.ts\0src/to.ts\0";
  };

  const result = await resolveChangeSet({
    repositoryPath: "/repo/subdir",
    baseRef: "main",
    headRef: "feature",
    maxChangedPaths: 10,
    fallback: "repository",
  }, runner);

  assert.deepEqual(calls, [
    { args: ["rev-parse", "--show-toplevel"], cwd: "/repo/subdir" },
    { args: ["rev-parse", "--verify", "main^{commit}"], cwd: "/repo/subdir" },
    { args: ["rev-parse", "--verify", "feature^{commit}"], cwd: "/repo/subdir" },
    { args: ["diff", "--name-status", "--find-renames", "-z", "base-sha...head-sha"], cwd: "/repo/subdir" },
  ]);
  assert.equal(result.baseSha, "base-sha");
  assert.equal(result.headSha, "head-sha");
  assert.deepEqual(result.scanPaths, ["src/a.ts", "src/to.ts"]);
  assert.deepEqual(result.files[1], {
    status: "deleted",
    path: "src/old.ts",
    previousPath: null,
    additions: null,
    deletions: null,
  });
});

test("falls back to repository scope above the path ceiling", async () => {
  const result = await resolveChangeSet({
    repositoryPath: "/repo",
    baseRef: "main",
    headRef: "HEAD",
    maxChangedPaths: 2,
    fallback: "repository",
  }, fakeGit("M\0a.ts\0M\0b.ts\0M\0c.ts\0"));

  assert.equal(result.scopeMode, "repository");
  assert.deepEqual(result.scanPaths, []);
  assert.match(result.fallbackReason ?? "", /3 changed paths/);
});

test("raises a typed error above the ceiling when fallback is error", async () => {
  await assert.rejects(
    resolveChangeSet({
      repositoryPath: "/repo",
      baseRef: "main",
      headRef: "HEAD",
      maxChangedPaths: 1,
      fallback: "error",
    }, fakeGit("M\0a.ts\0M\0b.ts\0")),
    (error: unknown) => error instanceof GitChangeSetError && /2 changed paths/.test(error.message),
  );
});

test("rejects absolute and repository-escaping paths returned by git", async () => {
  for (const unsafePath of ["/etc/passwd", "../secret.ts", "src/../../secret.ts"]) {
    await assert.rejects(
      resolveChangeSet({
        repositoryPath: "/repo",
        baseRef: "main",
        headRef: "HEAD",
        maxChangedPaths: 10,
        fallback: "repository",
      }, fakeGit(`M\0${unsafePath}\0`)),
      (error: unknown) => error instanceof GitChangeSetError && error.path === "files[0].path",
      unsafePath,
    );
  }
});

test("rejects a renamed previous path that escapes the repository", async () => {
  await assert.rejects(
    resolveChangeSet({
      repositoryPath: "/repo",
      baseRef: "main",
      headRef: "HEAD",
      maxChangedPaths: 10,
      fallback: "repository",
    }, fakeGit("R100\0../old.ts\0src/new.ts\0")),
    (error: unknown) => error instanceof GitChangeSetError && error.path === "files[0].previousPath",
  );
});
