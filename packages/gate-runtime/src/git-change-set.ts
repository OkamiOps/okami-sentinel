import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { ChangeSet, ChangeSetFile } from "@csb/shared";

const execFileAsync = promisify(execFile);

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export interface ResolveChangeSetInput {
  repositoryPath: string;
  baseRef: string;
  headRef: string;
  maxChangedPaths: number;
  fallback: "repository" | "error";
}

export class GitChangeSetError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "GitChangeSetError";
  }
}

export const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
};

type ParsedChangeSetFile = Pick<ChangeSetFile, "status" | "path" | "previousPath">;

export function parseNameStatusZ(output: string): ParsedChangeSetFile[] {
  if (output.length === 0) return [];

  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: ParsedChangeSetFile[] = [];

  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++];
    if (!rawStatus) throw new GitChangeSetError("missing status", `records[${files.length}].status`);

    if (rawStatus.startsWith("R")) {
      const previousPath = fields[index++];
      const currentPath = fields[index++];
      if (!previousPath || !currentPath) {
        throw new GitChangeSetError("incomplete rename record", `records[${files.length}]`);
      }
      files.push({ status: "renamed", path: currentPath, previousPath });
      continue;
    }

    const currentPath = fields[index++];
    if (!currentPath) throw new GitChangeSetError("missing path", `records[${files.length}].path`);

    const status = rawStatus === "A"
      ? "added"
      : rawStatus === "M"
        ? "modified"
        : rawStatus === "D"
          ? "deleted"
          : null;
    if (status === null) {
      throw new GitChangeSetError(`unsupported status ${rawStatus}`, `records[${files.length}].status`);
    }
    files.push({ status, path: currentPath, previousPath: null });
  }

  return files;
}

export async function resolveChangeSet(
  input: ResolveChangeSetInput,
  runner: GitRunner = defaultGitRunner,
): Promise<ChangeSet> {
  validateInput(input);

  const gitRoot = (await runner(["rev-parse", "--show-toplevel"], input.repositoryPath)).trim();
  if (!path.isAbsolute(gitRoot)) throw new GitChangeSetError("git root must be absolute", "repositoryPath");

  const baseSha = (await runner(
    ["rev-parse", "--verify", `${input.baseRef}^{commit}`],
    input.repositoryPath,
  )).trim();
  const headSha = (await runner(
    ["rev-parse", "--verify", `${input.headRef}^{commit}`],
    input.repositoryPath,
  )).trim();
  if (!baseSha) throw new GitChangeSetError("git returned an empty base SHA", "baseRef");
  if (!headSha) throw new GitChangeSetError("git returned an empty head SHA", "headRef");

  const output = await runner(
    ["diff", "--name-status", "--find-renames", "-z", `${baseSha}...${headSha}`],
    input.repositoryPath,
  );
  const parsedFiles = parseNameStatusZ(output);
  parsedFiles.forEach((file, index) => {
    assertRepositoryPath(gitRoot, file.path, `files[${index}].path`);
    if (file.previousPath !== null) {
      assertRepositoryPath(gitRoot, file.previousPath, `files[${index}].previousPath`);
    }
  });

  const files: ChangeSetFile[] = parsedFiles.map((file) => ({
    ...file,
    additions: null,
    deletions: null,
  }));
  const scanPaths = [...new Set(files
    .filter((file) => file.status !== "deleted")
    .map((file) => file.path))];

  if (files.length > input.maxChangedPaths) {
    const reason = `${files.length} changed paths exceed the configured ceiling of ${input.maxChangedPaths}`;
    if (input.fallback === "error") throw new GitChangeSetError(reason, "maxChangedPaths");
    return {
      baseRef: input.baseRef,
      headRef: input.headRef,
      baseSha,
      headSha,
      files,
      scanPaths: [],
      scopeMode: "repository",
      fallbackReason: reason,
    };
  }

  return {
    baseRef: input.baseRef,
    headRef: input.headRef,
    baseSha,
    headSha,
    files,
    scanPaths,
    scopeMode: "changed",
    fallbackReason: null,
  };
}

function validateInput(input: ResolveChangeSetInput): void {
  if (!input.repositoryPath.trim()) throw new GitChangeSetError("must be non-empty", "repositoryPath");
  if (!input.baseRef.trim()) throw new GitChangeSetError("must be non-empty", "baseRef");
  if (!input.headRef.trim()) throw new GitChangeSetError("must be non-empty", "headRef");
  if (!Number.isInteger(input.maxChangedPaths) || input.maxChangedPaths <= 0) {
    throw new GitChangeSetError("must be a positive integer", "maxChangedPaths");
  }
  if (input.fallback !== "repository" && input.fallback !== "error") {
    throw new GitChangeSetError("must be repository or error", "fallback");
  }
}

function assertRepositoryPath(gitRoot: string, candidate: string, fieldPath: string): void {
  if (path.isAbsolute(candidate)) {
    throw new GitChangeSetError("absolute paths are not allowed", fieldPath);
  }
  const resolved = path.resolve(gitRoot, candidate);
  const relative = path.relative(gitRoot, resolved);
  if (relative === "" || relative === "." || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new GitChangeSetError("path must resolve inside the git root", fieldPath);
  }
}
