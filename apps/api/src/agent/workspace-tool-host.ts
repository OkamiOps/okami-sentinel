import { constants, type Dirent, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  AgentSessionError,
  type AgentSessionErrorCode,
  type WorkspaceToolBudget,
  type WorkspaceToolHost,
  type WorkspaceToolHostOptions,
  type WorkspaceToolName,
  type WorkspaceToolResult,
} from "./session-types.js";
import { collectBounded } from "./bounded-directory.js";

const DEFAULT_MAX_READ_BYTES = 4_194_304;
const DEFAULT_MAX_WRITE_BYTES = 16_777_216;
const DEFAULT_MAX_LIST_ENTRIES = 1_000;
const DEFAULT_MAX_SEARCH_RESULTS = 200;
const DEFAULT_MAX_SEARCH_BYTES = 4_194_304;
const DEFAULT_MAX_RECURSION_DEPTH = 6;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const DIRECTORY_ONLY = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
const READ_FLAGS = constants.O_RDONLY | NO_FOLLOW;
const DIRECTORY_READ_FLAGS = constants.O_RDONLY | NO_FOLLOW | DIRECTORY_ONLY;
const CREATE_EXCLUSIVE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;

type ToolDenialCode = Extract<AgentSessionErrorCode, "tool_path_denied" | "tool_write_denied">;

interface ToolHostLimits {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxListEntries: number;
  maxSearchResults: number;
  maxSearchBytes: number;
  maxRecursionDepth: number;
}

interface RootRef {
  path: string;
  identity: FileIdentity;
  denialCode: ToolDenialCode;
}

/** A caller must provide an already-private, per-session directory. */
interface ArtifactRootRef extends RootRef {
  parent: RootRef;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface PinnedPath {
  path: string;
  info: Stats;
}

interface ArtifactTarget {
  path: string;
  parent: PinnedPath;
}

interface ListEntry {
  path: string;
  kind: "file" | "directory";
}

interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

interface TraversalBudget {
  remainingEntries: number;
}


/**
 * The host is the complete local capability surface for an agent session.
 * It deliberately has no process, browser, edit, or network escape hatch.
 */
export async function createWorkspaceToolHost(
  options: WorkspaceToolHostOptions,
): Promise<WorkspaceToolHost> {
  const limits = limitsFor(options);
  const snapshotRoot = await existingDirectory(options.snapshotRoot, "tool_path_denied");
  const artifactRoot = await privateArtifactRoot(options.artifactRoot);
  if (rootsOverlap(snapshotRoot.path, artifactRoot.path)) {
    throw new AgentSessionError("tool_path_denied");
  }

  return {
    minimumOutputBytes(name, input) {
      return minimumToolOutputBytes(name, input, limits);
    },
    async call(name, input, budget) {
      const maxOutputBytes = outputBudget(budget);
      if (minimumToolOutputBytes(name, input, limits) > maxOutputBytes) {
        throw new AgentSessionError("agent_output_byte_limit");
      }
      switch (name) {
        case "workspace.list":
          return listWorkspace(snapshotRoot, input, limits, maxOutputBytes);
        case "workspace.read":
          return readWorkspace(snapshotRoot, input, limits, maxOutputBytes);
        case "workspace.search":
          return searchWorkspace(snapshotRoot, input, limits, maxOutputBytes);
        case "results.write":
          return writeArtifact(artifactRoot, input, limits, maxOutputBytes);
        default:
          return Promise.reject(new AgentSessionError("tool_name_denied"));
      }
    },
  };
}

function minimumToolOutputBytes(
  name: WorkspaceToolName,
  input: unknown,
  limits: ToolHostLimits,
): number {
  const value = objectInput(input);
  switch (name) {
    case "workspace.list":
      optionalPath(value.path, true);
      boundedPositive(value.maxEntries, limits.maxListEntries, "tool_argument_invalid");
      boundedPositive(value.maxDepth, limits.maxRecursionDepth, "tool_argument_invalid");
      return serializedBytes({ entries: [], truncated: false });
    case "workspace.read": {
      const path = requiredPath(value.path);
      boundedPositive(value.maxBytes, limits.maxReadBytes, "tool_argument_invalid");
      return serializedBytes({ path, content: "" });
    }
    case "workspace.search":
      nonEmptyString(value.query);
      optionalPath(value.path, true);
      boundedPositive(value.maxResults, limits.maxSearchResults, "tool_argument_invalid");
      boundedPositive(value.maxBytes, limits.maxSearchBytes, "tool_argument_invalid");
      return serializedBytes({ matches: [], truncated: false });
    case "results.write": {
      const path = requiredPath(value.path);
      const content = artifactContent(value.content);
      return serializedBytes({ path, bytes: Buffer.byteLength(content, "utf8") });
    }
    default:
      throw new AgentSessionError("tool_name_denied");
  }
}

async function listWorkspace(
  snapshotRoot: RootRef,
  input: unknown,
  limits: ToolHostLimits,
  maxOutputBytes: number,
): Promise<WorkspaceToolResult> {
  const value = objectInput(input);
  const requestedPath = optionalPath(value.path, true);
  const maxEntries = boundedPositive(value.maxEntries, limits.maxListEntries, "tool_argument_invalid");
  const maxDepth = boundedPositive(value.maxDepth, limits.maxRecursionDepth, "tool_argument_invalid");
  const directory = await snapshotTarget(snapshotRoot, requestedPath);
  if (!directory.info.isDirectory()) throw new AgentSessionError("tool_path_denied");

  const entries: ListEntry[] = [];
  let truncated = false;
  await walkDirectory(
    snapshotRoot,
    directory,
    requestedPath,
    0,
    maxDepth,
    { remainingEntries: maxEntries },
    () => { truncated = true; },
    async (entry, path) => {
    if (entries.length >= maxEntries) {
      truncated = true;
      return false;
    }
    const candidate: ListEntry = {
      path,
      kind: entry.info.isDirectory() ? "directory" : "file",
    };
    if (!bothTruncationStatesFit({ entries: [...entries, candidate] }, maxOutputBytes)) {
      truncated = true;
      return false;
    }
    entries.push(candidate);
    if (entries.length >= maxEntries) truncated = true;
    return !truncated;
    },
  );
  return textResult({ entries, truncated }, maxOutputBytes);
}

async function readWorkspace(
  snapshotRoot: RootRef,
  input: unknown,
  limits: ToolHostLimits,
  maxOutputBytes: number,
): Promise<WorkspaceToolResult> {
  const value = objectInput(input);
  const requestedPath = requiredPath(value.path);
  const maxBytes = boundedPositive(value.maxBytes, limits.maxReadBytes, "tool_argument_invalid");
  const target = await snapshotTarget(snapshotRoot, requestedPath);
  if (!target.info.isFile()) throw new AgentSessionError("tool_path_denied");
  if (target.info.size > maxBytes) throw new AgentSessionError("tool_read_limit");
  const content = (await readPinnedSnapshotFile(snapshotRoot, target, maxBytes)).toString("utf8");
  if (serializedBytes({ path: requestedPath, content }) > maxOutputBytes) {
    throw new AgentSessionError("agent_output_byte_limit");
  }
  return textResult({ path: requestedPath, content }, maxOutputBytes);
}

async function searchWorkspace(
  snapshotRoot: RootRef,
  input: unknown,
  limits: ToolHostLimits,
  maxOutputBytes: number,
): Promise<WorkspaceToolResult> {
  const value = objectInput(input);
  const query = nonEmptyString(value.query);
  const requestedPath = optionalPath(value.path, true);
  const maxResults = boundedPositive(value.maxResults, limits.maxSearchResults, "tool_argument_invalid");
  const requestedMaxBytes = boundedPositive(value.maxBytes, limits.maxSearchBytes, "tool_argument_invalid");
  const emptyBytes = serializedBytes({ matches: [], truncated: false });
  const maxBytes = Math.min(requestedMaxBytes, Math.max(0, maxOutputBytes - emptyBytes));
  const root = await snapshotTarget(snapshotRoot, requestedPath);
  if (!root.info.isDirectory() && !root.info.isFile()) throw new AgentSessionError("tool_path_denied");

  const matches: SearchMatch[] = [];
  let bytesRead = 0;
  let truncated = maxBytes === 0;
  const inspectFile = async (file: PinnedPath, relativePath: string): Promise<boolean> => {
    if (!file.info.isFile()) return true;
    if (bytesRead + file.info.size > maxBytes) {
      truncated = true;
      return false;
    }
    const content = (await readPinnedSnapshotFile(snapshotRoot, file, maxBytes - bytesRead)).toString("utf8");
    bytesRead += file.info.size;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!line.includes(query)) continue;
      const match = { path: relativePath, line: index + 1, text: line };
      if (matches.length >= maxResults ||
          !bothTruncationStatesFit({ matches: [...matches, match] }, maxOutputBytes)) {
        truncated = true;
        return false;
      }
      matches.push(match);
      if (matches.length >= maxResults) {
        truncated = true;
        return false;
      }
    }
    return true;
  };

  if (!truncated && root.info.isFile()) {
    await inspectFile(root, requestedPath);
  } else if (!truncated) {
    await walkDirectory(
      snapshotRoot,
      root,
      requestedPath,
      0,
      limits.maxRecursionDepth,
      { remainingEntries: limits.maxListEntries },
      () => { truncated = true; },
      async (entry, path) => entry.info.isDirectory() || inspectFile(entry, path),
    );
  }
  return textResult({ matches, truncated }, maxOutputBytes);
}

async function writeArtifact(
  artifactRoot: ArtifactRootRef,
  input: unknown,
  limits: ToolHostLimits,
  maxOutputBytes: number,
): Promise<WorkspaceToolResult> {
  const value = objectInput(input);
  const artifactPath = requiredPath(value.path);
  const content = artifactContent(value.content);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > limits.maxWriteBytes) throw new AgentSessionError("tool_output_limit");
  const result = textResult({ path: artifactPath, bytes }, maxOutputBytes);

  const target = await artifactTarget(artifactRoot, artifactPath);
  let handle: FileHandle | undefined;
  try {
    handle = await open(target.path, CREATE_EXCLUSIVE_FLAGS, 0o600);
    const opened = await handle.stat();
    const linked = await secureLstat(target.path, "tool_write_denied");
    assertRegularPinnedFile(opened, linked, "tool_write_denied");
    await assertPinnedDirectory(target.parent, "tool_write_denied");
    await assertPinnedArtifactRoot(artifactRoot);

    await handle.writeFile(content, "utf8");

    const written = await handle.stat();
    const linkedAfterWrite = await secureLstat(target.path, "tool_write_denied");
    if (!sameObject(opened, written) || !sameObject(opened, linkedAfterWrite) ||
        !written.isFile() || written.size !== bytes) {
      throw new AgentSessionError("tool_write_denied");
    }
    await assertPinnedDirectory(target.parent, "tool_write_denied");
    await assertPinnedArtifactRoot(artifactRoot);
  } catch (error) {
    if (error instanceof AgentSessionError) throw error;
    if (isFileSystemError(error, "EEXIST") || isFileSystemError(error, "ELOOP") ||
        isFileSystemError(error, "ENOTDIR") || isFileSystemError(error, "ENOENT")) {
      throw new AgentSessionError("tool_write_denied");
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return { ...result, artifact: { path: artifactPath, bytes } };
}

async function existingDirectory(path: string, code: ToolDenialCode): Promise<RootRef> {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new AgentSessionError(code);
  }
  const absolute = resolve(path);
  try {
    const lexical = await lstat(absolute);
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new AgentSessionError(code);
    const canonical = await realpath(absolute);
    const canonicalInfo = await lstat(canonical);
    if (!canonicalInfo.isDirectory() || !sameObject(lexical, canonicalInfo)) {
      throw new AgentSessionError(code);
    }
    return { path: canonical, identity: identityOf(canonicalInfo), denialCode: code };
  } catch (error) {
    if (error instanceof AgentSessionError) throw error;
    throw new AgentSessionError(code);
  }
}

/**
 * Results are allowed only in a pre-provisioned, per-session 0700 directory.
 * We never create or chmod a caller-controlled path: without portable openat,
 * that would leave a parent-swap gap. Pinning the private root and its parent
 * gives the runner an executable no-concurrent-writers contract.
 */
async function privateArtifactRoot(path: string): Promise<ArtifactRootRef> {
  const root = await existingDirectory(path, "tool_write_denied");
  const parentPath = dirname(root.path);
  if (parentPath === root.path) throw new AgentSessionError("tool_write_denied");
  const parent = await existingDirectory(parentPath, "tool_write_denied");
  await assertPrivatePinnedDirectory(parent);
  await assertPrivatePinnedDirectory(root);
  return { ...root, parent };
}

async function snapshotTarget(snapshotRoot: RootRef, requestedPath: string): Promise<PinnedPath> {
  await assertPinnedRoot(snapshotRoot);
  const normalized = normalizeRelativePath(requestedPath, true);
  const candidate = resolve(snapshotRoot.path, ...normalized.split("/"));
  if (candidate !== snapshotRoot.path && !isInside(snapshotRoot.path, candidate)) {
    throw new AgentSessionError("tool_path_denied");
  }
  await rejectSymlinkSegments(snapshotRoot.path, normalized, "tool_path_denied");
  try {
    const lexical = await lstat(candidate);
    if (lexical.isSymbolicLink()) throw new AgentSessionError("tool_path_denied");
    const canonical = await realpath(candidate);
    if (canonical !== snapshotRoot.path && !isInside(snapshotRoot.path, canonical)) {
      throw new AgentSessionError("tool_path_denied");
    }
    const canonicalInfo = await lstat(canonical);
    if (!sameObject(lexical, canonicalInfo)) throw new AgentSessionError("tool_path_denied");
    await assertPinnedRoot(snapshotRoot);
    return { path: canonical, info: canonicalInfo };
  } catch (error) {
    if (error instanceof AgentSessionError) throw error;
    throw new AgentSessionError("tool_path_denied");
  }
}

async function artifactTarget(artifactRoot: ArtifactRootRef, requestedPath: string): Promise<ArtifactTarget> {
  await assertPinnedArtifactRoot(artifactRoot);
  const normalized = normalizeRelativePath(requestedPath, false);
  const segments = normalized.split("/");
  const filename = segments.pop();
  if (filename === undefined || filename.length === 0) {
    throw new AgentSessionError("tool_write_denied");
  }

  let parent: PinnedPath = {
    path: artifactRoot.path,
    info: await secureLstat(artifactRoot.path, "tool_write_denied"),
  };
  for (const segment of segments) {
    await assertPinnedDirectory(parent, "tool_write_denied");
    await assertPinnedArtifactRoot(artifactRoot);
    const next = join(parent.path, segment);
    let info: Stats;
    try {
      info = await lstat(next);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new AgentSessionError("tool_write_denied");
      }
    } catch (error) {
      if (error instanceof AgentSessionError) throw error;
      if (!isFileSystemError(error, "ENOENT")) throw new AgentSessionError("tool_write_denied");
      try {
        await mkdir(next, { mode: 0o700 });
        info = await lstat(next);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new AgentSessionError("tool_write_denied");
        }
      } catch (mkdirError) {
        if (mkdirError instanceof AgentSessionError) throw mkdirError;
        throw new AgentSessionError("tool_write_denied");
      }
    }
    await assertPinnedDirectory(parent, "tool_write_denied");
    await assertPinnedArtifactRoot(artifactRoot);
    parent = { path: next, info };
  }

  const canonicalParent = await realpath(parent.path);
  if (canonicalParent !== artifactRoot.path && !isInside(artifactRoot.path, canonicalParent)) {
    throw new AgentSessionError("tool_write_denied");
  }
  const canonicalInfo = await secureLstat(canonicalParent, "tool_write_denied");
  if (!sameObject(parent.info, canonicalInfo) || !canonicalInfo.isDirectory()) {
    throw new AgentSessionError("tool_write_denied");
  }
  parent = { path: canonicalParent, info: canonicalInfo };
  await assertPinnedDirectory(parent, "tool_write_denied");
  await assertPinnedArtifactRoot(artifactRoot);

  const target = join(parent.path, filename);
  if (!isInside(artifactRoot.path, target)) throw new AgentSessionError("tool_write_denied");
  try {
    await lstat(target);
    throw new AgentSessionError("tool_write_denied");
  } catch (error) {
    if (error instanceof AgentSessionError) throw error;
    if (!isFileSystemError(error, "ENOENT")) throw new AgentSessionError("tool_write_denied");
  }
  return { path: target, parent };
}

async function readPinnedSnapshotFile(
  snapshotRoot: RootRef,
  target: PinnedPath,
  maxBytes: number,
): Promise<Buffer> {
  if (!target.info.isFile() || target.info.size > maxBytes) {
    throw new AgentSessionError("tool_path_denied");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(target.path, READ_FLAGS);
    const opened = await handle.stat();
    assertRegularPinnedFile(target.info, opened, "tool_path_denied");
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const handleAfterRead = await handle.stat();
    const pathAfterRead = await secureLstat(target.path, "tool_path_denied");
    if (offset !== content.length || !sameVersion(opened, handleAfterRead) ||
        !sameVersion(opened, pathAfterRead)) {
      throw new AgentSessionError("tool_path_denied");
    }
    await assertPinnedRoot(snapshotRoot);
    return content;
  } catch (error) {
    if (error instanceof AgentSessionError) throw error;
    throw new AgentSessionError("tool_path_denied");
  } finally {
    await handle?.close();
  }
}

async function readPinnedDirectory(
  snapshotRoot: RootRef,
  directory: PinnedPath,
  maxEntries: number,
): Promise<{ entries: Dirent[]; truncated: boolean }> {
  if (!directory.info.isDirectory()) throw new AgentSessionError("tool_path_denied");
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory.path, DIRECTORY_READ_FLAGS);
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameObject(directory.info, opened)) {
      throw new AgentSessionError("tool_path_denied");
    }
    const stream = await opendir(directory.path, {
      bufferSize: Math.min(maxEntries + 1, 32),
    });
    const result = await collectBounded(stream, maxEntries);
    const handleAfterRead = await handle.stat();
    const pathAfterRead = await secureLstat(directory.path, "tool_path_denied");
    if (!sameVersion(opened, handleAfterRead) || !sameVersion(opened, pathAfterRead)) {
      throw new AgentSessionError("tool_path_denied");
    }
    await assertPinnedRoot(snapshotRoot);
    return result;
  } catch (error) {
    if (error instanceof AgentSessionError) throw error;
    throw new AgentSessionError("tool_path_denied");
  } finally {
    await handle?.close();
  }
}

async function rejectSymlinkSegments(
  root: string,
  normalizedPath: string,
  code: ToolDenialCode,
): Promise<void> {
  if (normalizedPath === ".") return;
  let cursor = root;
  for (const segment of normalizedPath.split("/")) {
    cursor = join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new AgentSessionError(code);
    } catch (error) {
      if (error instanceof AgentSessionError) throw error;
      throw new AgentSessionError(code);
    }
  }
}

async function walkDirectory(
  snapshotRoot: RootRef,
  directory: PinnedPath,
  displayRoot: string,
  depth: number,
  maxDepth: number,
  budget: TraversalBudget,
  onTraversalLimit: () => void,
  visit: (entry: PinnedPath, path: string) => Promise<boolean>,
): Promise<boolean> {
  if (depth > maxDepth) return true;
  if (budget.remainingEntries <= 0) {
    onTraversalLimit();
    return false;
  }
  const directoryRead = await readPinnedDirectory(snapshotRoot, directory, budget.remainingEntries);
  const entries = directoryRead.entries;
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (budget.remainingEntries <= 0) {
      onTraversalLimit();
      return false;
    }
    budget.remainingEntries -= 1;
    if (entry.isSymbolicLink()) continue;
    const path = displayRoot === "." ? entry.name : `${displayRoot}/${entry.name}`;
    let pinned: PinnedPath;
    try {
      pinned = await snapshotTarget(snapshotRoot, path);
    } catch (error) {
      if (error instanceof AgentSessionError && error.code === "tool_path_denied") throw error;
      throw new AgentSessionError("tool_path_denied");
    }
    if (!pinned.info.isDirectory() && !pinned.info.isFile()) continue;
    const continueWalking = await visit(pinned, path);
    if (!continueWalking) return false;
    if (pinned.info.isDirectory() && depth < maxDepth) {
      const walked = await walkDirectory(
        snapshotRoot,
        pinned,
        path,
        depth + 1,
        maxDepth,
        budget,
        onTraversalLimit,
        visit,
      );
      if (!walked) return false;
    }
  }
  if (directoryRead.truncated) {
    onTraversalLimit();
    return false;
  }
  return true;
}

async function assertPinnedRoot(root: RootRef): Promise<void> {
  const current = await secureLstat(root.path, root.denialCode);
  if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(root.identity, current)) {
    throw new AgentSessionError(root.denialCode);
  }
}

async function assertPinnedArtifactRoot(root: ArtifactRootRef): Promise<void> {
  await assertPrivatePinnedDirectory(root.parent);
  await assertPrivatePinnedDirectory(root);
}

async function assertPrivatePinnedDirectory(root: RootRef): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(root.path, DIRECTORY_READ_FLAGS);
    const opened = await handle.stat();
    const linked = await secureLstat(root.path, root.denialCode);
    if (!opened.isDirectory() || opened.isSymbolicLink() || !sameIdentity(root.identity, opened) ||
        !linked.isDirectory() || linked.isSymbolicLink() || !sameIdentity(root.identity, linked) ||
        !isPrivateOwnerOnly(opened) || !isPrivateOwnerOnly(linked)) {
      throw new AgentSessionError(root.denialCode);
    }
  } catch (error) {
    if (error instanceof AgentSessionError) throw error;
    throw new AgentSessionError(root.denialCode);
  } finally {
    await handle?.close();
  }
}

async function assertPinnedDirectory(path: PinnedPath, code: ToolDenialCode): Promise<void> {
  const current = await secureLstat(path.path, code);
  if (current.isSymbolicLink() || !current.isDirectory() || !sameObject(path.info, current)) {
    throw new AgentSessionError(code);
  }
}

function assertRegularPinnedFile(first: Stats, second: Stats, code: ToolDenialCode): void {
  if (!first.isFile() || !second.isFile() || second.isSymbolicLink() || !sameObject(first, second)) {
    throw new AgentSessionError(code);
  }
}

async function secureLstat(path: string, code: ToolDenialCode): Promise<Stats> {
  try {
    return await lstat(path);
  } catch {
    throw new AgentSessionError(code);
  }
}

function sameObject(first: Pick<Stats, "dev" | "ino">, second: Pick<Stats, "dev" | "ino">): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function sameVersion(first: Stats, second: Stats): boolean {
  return sameObject(first, second) && first.size === second.size &&
    first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
}

function identityOf(info: Stats): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(identity: FileIdentity, info: Stats): boolean {
  return identity.dev === info.dev && identity.ino === info.ino;
}

function isPrivateOwnerOnly(info: Stats): boolean {
  if ((info.mode & 0o077) !== 0) return false;
  return typeof process.getuid !== "function" || info.uid === process.getuid();
}

function normalizeRelativePath(value: string, allowRoot: boolean): string {
  if (value.includes("\0") || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new AgentSessionError("tool_path_denied");
  }
  const normalized = value.replaceAll("\\", "/");
  if (allowRoot && normalized === ".") return normalized;
  if (normalized.length === 0 || normalized.startsWith("/") || normalized.endsWith("/") ||
      normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new AgentSessionError("tool_path_denied");
  }
  return normalized;
}

function requiredPath(value: unknown): string {
  if (typeof value !== "string") throw new AgentSessionError("tool_argument_invalid");
  return normalizeRelativePath(value, false);
}

function optionalPath(value: unknown, allowRoot: boolean): string {
  if (value === undefined) return ".";
  if (typeof value !== "string") throw new AgentSessionError("tool_argument_invalid");
  if (value === "" || (allowRoot && value === "/")) return ".";
  return normalizeRelativePath(value, allowRoot);
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new AgentSessionError("tool_argument_invalid");
  return value;
}

function artifactContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) && !isRecord(value)) {
    throw new AgentSessionError("tool_argument_invalid");
  }
  try {
    const content = JSON.stringify(value);
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed) && !isRecord(parsed)) throw new Error("not a JSON container");
    return content;
  } catch {
    throw new AgentSessionError("tool_argument_invalid");
  }
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentSessionError("tool_argument_invalid");
  }
  return value;
}

function boundedPositive(value: unknown, fallback: number, code: "tool_argument_invalid"): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new AgentSessionError(code);
  }
  return Math.min(value, fallback);
}

function limitsFor(options: WorkspaceToolHostOptions): ToolHostLimits {
  return {
    maxReadBytes: boundedOption(options.maxReadBytes, DEFAULT_MAX_READ_BYTES),
    maxWriteBytes: boundedOption(options.maxWriteBytes, DEFAULT_MAX_WRITE_BYTES),
    maxListEntries: boundedOption(options.maxListEntries, DEFAULT_MAX_LIST_ENTRIES),
    maxSearchResults: boundedOption(options.maxSearchResults, DEFAULT_MAX_SEARCH_RESULTS),
    maxSearchBytes: boundedOption(options.maxSearchBytes, DEFAULT_MAX_SEARCH_BYTES),
    maxRecursionDepth: boundedOption(options.maxRecursionDepth, DEFAULT_MAX_RECURSION_DEPTH),
  };
}

function boundedOption(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) {
    throw new AgentSessionError("tool_argument_invalid");
  }
  return value;
}

function outputBudget(budget: WorkspaceToolBudget | undefined): number {
  if (budget === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(budget.maxOutputBytes) || budget.maxOutputBytes <= 0) {
    throw new AgentSessionError("agent_output_byte_limit");
  }
  return budget.maxOutputBytes;
}

function textResult(value: unknown, maxOutputBytes: number): WorkspaceToolResult {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content, "utf8") > maxOutputBytes) {
    throw new AgentSessionError("agent_output_byte_limit");
  }
  return { content };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function bothTruncationStatesFit(
  value: { entries: ListEntry[] } | { matches: SearchMatch[] },
  maxOutputBytes: number,
): boolean {
  return serializedBytes({ ...value, truncated: false }) <= maxOutputBytes &&
    serializedBytes({ ...value, truncated: true }) <= maxOutputBytes;
}

function rootsOverlap(first: string, second: string): boolean {
  return first === second || isInside(first, second) || isInside(second, first);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
