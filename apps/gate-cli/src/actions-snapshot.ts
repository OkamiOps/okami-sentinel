import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type {
  ChangeSet,
  GateCoverageEnvelope,
  GuardrailPolicy,
} from "@csb/shared";

export interface ActionsSnapshotInspection {
  changeSet: ChangeSet;
  coverage: GateCoverageEnvelope;
  identity: string;
}

export interface ActionsSnapshotCommand {
  (args: readonly string[], cwd: string): Buffer;
}

interface GitEntry {
  mode: string;
  oid: string;
  path: string;
}

const defaultCommand: ActionsSnapshotCommand = (args, cwd) => execFileSync(
  "git",
  [...args],
  { cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
);

export function inspectActionsSnapshots(
  input: {
    baseRoot: string;
    headRoot: string;
    baseRef: string;
    headRef: string;
    baseSha: string;
    headSha: string;
    policy: GuardrailPolicy;
  },
  command: ActionsSnapshotCommand = defaultCommand,
): ActionsSnapshotInspection {
  const baseRoot = realDirectory(input.baseRoot);
  const headRoot = realDirectory(input.headRoot);
  if (baseRoot === headRoot) throw new Error("actions_checkout_roots_must_be_distinct");
  assertRevision(baseRoot, input.baseSha, command);
  assertRevision(headRoot, input.headSha, command);
  assertTrackedCheckoutClean(baseRoot, command);
  assertTrackedCheckoutClean(headRoot, command);

  const base = indexEntries(baseRoot, command);
  const head = indexEntries(headRoot, command);
  const files = changedFiles(base, head);
  const regularHeadPaths = [...head.values()]
    .filter((entry) => isRegularMode(entry.mode))
    .map((entry) => entry.path)
    .sort();
  let scopeMode = input.policy.scope.mode;
  let fallbackReason: string | null = null;
  let scanPaths: string[];
  if (scopeMode === "repository") {
    scanPaths = regularHeadPaths;
  } else if (files.length > input.policy.scope.maxChangedPaths) {
    if (input.policy.scope.fallback === "error") throw new Error("changed_path_limit_exceeded");
    scopeMode = "repository";
    fallbackReason = "changed_path_limit_exceeded";
    scanPaths = regularHeadPaths;
  } else {
    scanPaths = files
      .filter((entry) => entry.status !== "deleted")
      .map((entry) => head.get(entry.path))
      .filter((entry): entry is GitEntry => entry !== undefined && isRegularMode(entry.mode))
      .map((entry) => entry.path)
      .sort();
  }

  const submodules = [...head.values()]
    .filter((entry) => entry.mode === "160000")
    .map((entry) => entry.path)
    .sort();
  const lfsPointers = regularHeadPaths.filter((entry) => isLfsPointer(headRoot, entry));
  const partial = submodules.length > 0 || lfsPointers.length > 0;
  const canonicalHead = [...head.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.mode}\0${entry.oid}\0${entry.path}\0`)
    .join("");

  return {
    changeSet: {
      baseRef: input.baseRef,
      headRef: input.headRef,
      baseSha: input.baseSha,
      headSha: input.headSha,
      files,
      scanPaths,
      scopeMode,
      fallbackReason,
    },
    coverage: {
      status: partial ? "partial" : "complete",
      repositoryFileCount: regularHeadPaths.length,
      inspectedFileCount: regularHeadPaths.length,
      unexaminedFileCount: 0,
      submodules,
      lfsPointers,
    },
    identity: `sha256:${createHash("sha256").update(canonicalHead).digest("hex")}`,
  };
}

function indexEntries(root: string, command: ActionsSnapshotCommand): Map<string, GitEntry> {
  const output = command(["ls-files", "--stage", "-z"], root);
  if (output.byteLength > 256 * 1024 * 1024) throw new Error("github_snapshot_limit");
  const entries = new Map<string, GitEntry>();
  for (const raw of output.toString("utf8").split("\0")) {
    if (raw === "") continue;
    const match = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/.exec(raw);
    if (match === null || match[3] !== "0") throw new Error("github_snapshot_invalid");
    const entryPath = repositoryPath(match[4]!);
    if (entries.has(entryPath)) throw new Error("github_snapshot_invalid");
    entries.set(entryPath, { mode: match[1]!, oid: match[2]!, path: entryPath });
    if (entries.size > 500_000) throw new Error("github_snapshot_limit");
  }
  return entries;
}

function changedFiles(base: ReadonlyMap<string, GitEntry>, head: ReadonlyMap<string, GitEntry>): ChangeSet["files"] {
  const paths = new Set([...base.keys(), ...head.keys()]);
  const files: ChangeSet["files"] = [];
  for (const entryPath of [...paths].sort()) {
    const before = base.get(entryPath);
    const after = head.get(entryPath);
    if (before === undefined) {
      files.push({ status: "added", path: entryPath, previousPath: null, additions: null, deletions: null });
      continue;
    }
    if (after === undefined) {
      files.push({ status: "deleted", path: entryPath, previousPath: null, additions: null, deletions: null });
      continue;
    }
    if (before.mode !== after.mode || before.oid !== after.oid) {
      files.push({ status: "modified", path: entryPath, previousPath: null, additions: null, deletions: null });
    }
  }
  return files;
}

function assertRevision(root: string, expected: string, command: ActionsSnapshotCommand): void {
  const actual = command(["rev-parse", "HEAD"], root).toString("utf8").trim();
  if (actual !== expected) throw new Error("github_snapshot_revision_mismatch");
}

function assertTrackedCheckoutClean(root: string, command: ActionsSnapshotCommand): void {
  const status = command(["status", "--porcelain=v1", "--untracked-files=no"], root).toString("utf8");
  if (status !== "") throw new Error("github_snapshot_modified");
}

function realDirectory(value: string): string {
  const resolved = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(resolved).isDirectory()) throw new Error("github_snapshot_invalid");
  return resolved;
}

function repositoryPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.length === 0
    || normalized.length > 4_096
    || normalized.startsWith("/")
    || normalized.split("/").some((entry) => entry === "" || entry === "." || entry === "..")
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) throw new Error("github_snapshot_invalid");
  return normalized;
}

function isRegularMode(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}

function isLfsPointer(root: string, relativePath: string): boolean {
  const candidate = path.join(root, ...relativePath.split("/"));
  let descriptor: number | null = null;
  try {
    const before = fs.lstatSync(candidate);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("github_snapshot_invalid");
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("github_snapshot_invalid");
    }
    const bytes = Buffer.alloc(Math.min(opened.size, 256));
    const read = bytes.length === 0 ? 0 : fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, read).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1\n");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}
