import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  countInspectableSnapshotFiles,
  createVulnHunterSnapshot,
  minimumSourceReadsForSnapshot,
  openVulnHunterSnapshot,
  vulnhunterGitArgs,
} from "./vulnhunter-worker-support.js";

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

test("empty snapshots are not inspectable and scale required reads with source size", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vulnhunter-empty-"));
  const filled = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vulnhunter-filled-"));
  try {
    assert.equal(countInspectableSnapshotFiles(empty), 0);
    assert.equal(minimumSourceReadsForSnapshot(0, 24), 0);
    fs.writeFileSync(path.join(filled, "app.ts"), "export const ok = true;\n");
    assert.equal(countInspectableSnapshotFiles(filled), 1);
    assert.equal(minimumSourceReadsForSnapshot(1, 24), 1);
    assert.equal(minimumSourceReadsForSnapshot(8, 24), 8);
    assert.equal(minimumSourceReadsForSnapshot(20, 24), 8);
    assert.equal(minimumSourceReadsForSnapshot(508, 24), 24);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(filled, { recursive: true, force: true });
  }
});

test("VulnHunter recovery reopens an existing snapshot instead of overwriting it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-vulnhunter-snapshot-"));
  const repositoryPath = path.join(root, "repository");
  const outputDir = path.join(root, "output");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(repositoryPath, "app.ts"), "export const ok = true;\n");
  try {
    const created = createVulnHunterSnapshot(repositoryPath, outputDir);
    fs.writeFileSync(path.join(created.snapshotRoot, "marker.txt"), "kept\n");
    const opened = openVulnHunterSnapshot(repositoryPath, outputDir);
    assert.equal(opened.snapshotRoot, created.snapshotRoot);
    assert.equal(fs.readFileSync(path.join(opened.snapshotRoot, "marker.txt"), "utf8"), "kept\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
