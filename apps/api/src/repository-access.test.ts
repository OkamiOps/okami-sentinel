import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertRepositoryAccess } from "./repository-access.js";

test("server roots reject traversal, symlink escapes and sibling prefixes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-repository-access-"));
  const repos = path.join(root, "repos");
  const repo = path.join(repos, "project");
  const privateDir = path.join(root, "repos-private");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(privateDir);
  fs.symlinkSync(privateDir, path.join(repo, "escape"));
  const options = { mode: "server" as const, roots: [repos] };
  try {
    assert.equal(assertRepositoryAccess(repo, options), fs.realpathSync(repo));
    for (const denied of [path.join(repos, ".."), privateDir, path.join(repo, "escape"), "/"]) {
      assert.throws(() => assertRepositoryAccess(denied, options), /repository_path_denied/);
    }
    assert.throws(() => assertRepositoryAccess(privateDir, { ...options, managedRoot: repo }), /repository_path_denied/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
