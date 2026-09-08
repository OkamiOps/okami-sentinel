import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { vulnhunterGitArgs } from "./vulnhunter-worker-support.js";

test("VulnHunter scopes server Git ownership to the canonical repository", () => {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vulnhunter-git-"));
  const originalMode = process.env.CSB_RUNTIME_MODE;
  try {
    process.env.CSB_RUNTIME_MODE = "server";
    const canonicalRepositoryPath = fs.realpathSync.native(repositoryPath);
    assert.deepEqual(vulnhunterGitArgs(repositoryPath, ["remote", "get-url", "origin"]), [
      "-c", `safe.directory=${canonicalRepositoryPath}`,
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-C", canonicalRepositoryPath,
      "remote", "get-url", "origin",
    ]);

    process.env.CSB_RUNTIME_MODE = "local";
    assert.deepEqual(vulnhunterGitArgs(repositoryPath, ["remote", "get-url", "origin"]), [
      "-C", repositoryPath,
      "remote", "get-url", "origin",
    ]);
  } finally {
    if (originalMode === undefined) delete process.env.CSB_RUNTIME_MODE;
    else process.env.CSB_RUNTIME_MODE = originalMode;
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});
