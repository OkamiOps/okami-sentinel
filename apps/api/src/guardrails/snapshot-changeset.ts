import type {
  ChangeSet,
  ChangeSetFile,
  GuardrailPolicy,
  ResolvedGateTarget,
} from "@csb/shared";

import type {
  MaterializedSnapshot,
  SnapshotEntryMetadata,
} from "./snapshot-materializer.js";

export type SnapshotChangeSetErrorCode = "snapshot_change_limit_exceeded";

export class SnapshotChangeSetError extends Error {
  constructor(readonly code: SnapshotChangeSetErrorCode) {
    super(code);
    this.name = "SnapshotChangeSetError";
  }
}

export interface ResolveSnapshotChangeSetInput {
  base: MaterializedSnapshot;
  head: MaterializedSnapshot;
  target: ResolvedGateTarget;
  policy: GuardrailPolicy;
}

export function resolveSnapshotChangeSet(
  input: ResolveSnapshotChangeSetInput,
): ChangeSet {
  const baseEntries = sourceEntries(input.base);
  const headEntries = sourceEntries(input.head);
  const paths = [...new Set([...baseEntries.keys(), ...headEntries.keys()])].sort();
  const files: ChangeSetFile[] = [];

  for (const entryPath of paths) {
    const base = baseEntries.get(entryPath);
    const head = headEntries.get(entryPath);
    if (base === undefined && head !== undefined) {
      files.push(change("added", entryPath));
    } else if (base !== undefined && head === undefined) {
      files.push(change("deleted", entryPath));
    } else if (base !== undefined && head !== undefined && !sameEntry(base, head)) {
      files.push(change("modified", entryPath));
    }
  }

  const scanPaths = files
    .filter((file) => file.status !== "deleted" && headEntries.get(file.path)?.type === "file")
    .map((file) => file.path);
  if (input.policy.scope.mode === "repository") {
    return result(input, files, [], "repository", null);
  }
  const ceiling = input.policy.scope.maxChangedPaths;
  if (files.length > ceiling) {
    if (input.policy.scope.fallback === "error") {
      throw new SnapshotChangeSetError("snapshot_change_limit_exceeded");
    }
    return result(input, files, [], "repository", `${files.length} changed paths exceed the configured ceiling of ${ceiling}`);
  }
  return result(input, files, scanPaths, "changed", null);
}

function sourceEntries(snapshot: MaterializedSnapshot): Map<string, SnapshotEntryMetadata> {
  return new Map(snapshot.entries
    .filter((entry) => entry.type !== "directory")
    .map((entry) => [entry.path, entry]));
}

function sameEntry(left: SnapshotEntryMetadata, right: SnapshotEntryMetadata): boolean {
  return left.type === right.type
    && left.mode === right.mode
    && left.size === right.size
    && left.digest === right.digest;
}

function change(status: ChangeSetFile["status"], entryPath: string): ChangeSetFile {
  return {
    status,
    path: entryPath,
    previousPath: null,
    additions: null,
    deletions: null,
  };
}

function result(
  input: ResolveSnapshotChangeSetInput,
  files: ChangeSetFile[],
  scanPaths: string[],
  scopeMode: ChangeSet["scopeMode"],
  fallbackReason: string | null,
): ChangeSet {
  return {
    baseRef: input.target.baseRef,
    headRef: input.target.headRef,
    baseSha: input.target.baseSha,
    headSha: input.target.headSha,
    files,
    scanPaths,
    scopeMode,
    fallbackReason,
  };
}
