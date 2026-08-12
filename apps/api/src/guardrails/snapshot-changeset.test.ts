import assert from "node:assert/strict";
import test from "node:test";

import type {
  GuardrailPolicy,
  ResolvedGateTarget,
} from "@csb/shared";

import type {
  MaterializedSnapshot,
  SnapshotEntryMetadata,
} from "./snapshot-materializer.js";
import {
  SnapshotChangeSetError,
  resolveSnapshotChangeSet,
} from "./snapshot-changeset.js";

test("builds add, modify and delete from complete immutable snapshot trees", () => {
  const value = resolveSnapshotChangeSet({
    base: snapshot([
      entry("deleted.ts", "old"),
      entry("modified.ts", "old"),
      entry("unchanged.ts", "same"),
    ]),
    head: snapshot([
      entry("added.ts", "new"),
      entry("modified.ts", "new"),
      entry("unchanged.ts", "same"),
    ]),
    target: target(),
    policy: policy(10, "repository"),
  });

  assert.deepEqual(value.files.map(({ status, path }) => ({ status, path })), [
    { status: "added", path: "added.ts" },
    { status: "deleted", path: "deleted.ts" },
    { status: "modified", path: "modified.ts" },
  ]);
  assert.deepEqual(value.scanPaths, ["added.ts", "modified.ts"]);
  assert.equal(value.baseSha, "a".repeat(40));
  assert.equal(value.headSha, "b".repeat(40));
  assert.equal(value.scopeMode, "changed");
});

test("does not follow symlinks and reports their changes without scanning them", () => {
  const value = resolveSnapshotChangeSet({
    base: snapshot([]),
    head: snapshot([entry("internal-link", "src/app.ts", "symlink")]),
    target: target(),
    policy: policy(10, "repository"),
  });
  assert.equal(value.files[0]?.status, "added");
  assert.deepEqual(value.scanPaths, []);
});

test("applies the existing repository fallback above the changed-path ceiling", () => {
  const value = resolveSnapshotChangeSet({
    base: snapshot([]),
    head: snapshot([entry("a", "a"), entry("b", "b"), entry("c", "c")]),
    target: target(),
    policy: policy(2, "repository"),
  });
  assert.equal(value.scopeMode, "repository");
  assert.deepEqual(value.scanPaths, []);
  assert.match(value.fallbackReason ?? "", /3 changed paths/);
});

test("honors an explicit repository-wide policy without inventing scan paths", () => {
  const repositoryPolicy = policy(10, "repository");
  repositoryPolicy.scope.mode = "repository";
  const value = resolveSnapshotChangeSet({
    base: snapshot([]),
    head: snapshot([entry("src/app.ts", "new")]),
    target: target(),
    policy: repositoryPolicy,
  });
  assert.equal(value.scopeMode, "repository");
  assert.deepEqual(value.scanPaths, []);
  assert.equal(value.fallbackReason, null);
});

test("fails closed above the changed-path ceiling when policy forbids fallback", () => {
  assert.throws(
    () => resolveSnapshotChangeSet({
      base: snapshot([]),
      head: snapshot([entry("a", "a"), entry("b", "b")]),
      target: target(),
      policy: policy(1, "error"),
    }),
    (error: unknown) => error instanceof SnapshotChangeSetError
      && error.code === "snapshot_change_limit_exceeded",
  );
});

function entry(
  entryPath: string,
  digest: string,
  type: SnapshotEntryMetadata["type"] = "file",
): SnapshotEntryMetadata {
  return {
    path: entryPath,
    type,
    mode: type === "file" ? 0o644 : 0o777,
    size: digest.length,
    digest: `sha256:${digest}`,
  };
}

function snapshot(entries: SnapshotEntryMetadata[]): MaterializedSnapshot {
  return {
    path: "/private/materialization",
    identity: "sha256:snapshot",
    entries,
    fileCount: entries.filter((value) => value.type === "file").length,
    submodules: [],
    lfsPointers: [],
  };
}

function target(): ResolvedGateTarget {
  return {
    baseRef: "main",
    headRef: "feature",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    policySha: "a".repeat(40),
    pullRequestNumber: 42,
  };
}

function policy(
  maxChangedPaths: number,
  fallback: GuardrailPolicy["scope"]["fallback"],
): GuardrailPolicy {
  return {
    schemaVersion: 1,
    protectedBranches: ["main"],
    scope: { mode: "changed", maxChangedPaths, fallback },
    scan: { model: "gpt-5.6-sol", effort: "high", mode: "deep", maxCostUsd: 5 },
    rules: [],
  };
}
