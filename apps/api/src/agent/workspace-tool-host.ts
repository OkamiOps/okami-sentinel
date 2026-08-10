import { open, lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  AgentSessionError,
  type WorkspaceToolHost,
  type WorkspaceToolHostOptions,
  type WorkspaceToolName,
  type WorkspaceToolResult,
} from "./session-types.js";

const DEFAULT_MAX_READ_BYTES = 1_048_576;
const DEFAULT_MAX_WRITE_BYTES = 16_777_216;
const DEFAULT_MAX_LIST_ENTRIES = 1_000;
const DEFAULT_MAX_SEARCH_RESULTS = 200;
const DEFAULT_MAX_SEARCH_BYTES = 4_194_304;
const DEFAULT_MAX_RECURSION_DEPTH = 6;

interface ToolHostLimits {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxListEntries: number;
  maxSearchResults: number;
  maxSearchBytes: number;
  maxRecursionDepth: number;
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

/**
 * The host is the complete local capability surface for an agent session.
 * It deliberately has no process, browser, edit, or network escape hatch.
 */
export async function createWorkspaceToolHost(
  options: WorkspaceToolHostOptions,
): Promise<WorkspaceToolHost> {
  const limits = limitsFor(options);
  const snapshotRoot = await existingDirectory(options.snapshotRoot, "tool_path_denied");
  const artifactRoot = await writableDirectory(options.artifactRoot);
  if (rootsOverlap(snapshotRoot, artifactRoot)) throw new AgentSessionError("tool_path_denied");

  return {
    async call(name, input) {
      switch (name) {
        case "workspace.list":
          return listWorkspace(snapshotRoot, input, limits);
        case "workspace.read":
          return readWorkspace(snapshotRoot, input, limits);
        case "workspace.search":
          return searchWorkspace(snapshotRoot, input, limits);
        case "results.write":
          return writeArtifact(artifactRoot, input, limits);
        default:
          return Promise.reject(new AgentSessionError("tool_name_denied"));
      }
    },
  };
}

async function listWorkspace(
  snapshotRoot: string,
  input: unknown,
  limits: ToolHostLimits,
): Promise<WorkspaceToolResult> {
  const value = objectInput(input);
  const requestedPath = optionalPath(value.path, true);
  const maxEntries = boundedPositive(value.maxEntries, limits.maxListEntries, "tool_argument_invalid");
  const maxDepth = boundedPositive(value.maxDepth, limits.maxRecursionDepth, "tool_argument_invalid");
  const directory = await snapshotTarget(snapshotRoot, requestedPath);
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new AgentSessionError("tool_path_denied");

  const entries: ListEntry[] = [];
  await walkDirectory(snapshotRoot, directory, requestedPath, 0, maxDepth, async (entry, path) => {
    if (entries.length >= maxEntries) return false;
    entries.push({ path, kind: entry.isDirectory() ? "directory" : "file" });
    return true;
  });
  return textResult({ entries, truncated: entries.length >= maxEntries });
}

async function readWorkspace(
  snapshotRoot: string,
  input: unknown,
  limits: ToolHostLimits,
): Promise<WorkspaceToolResult> {
  const value = objectInput(input);
  const requestedPath = requiredPath(value.path);
  const maxBytes = boundedPositive(value.maxBytes, limits.maxReadBytes, "tool_argument_invalid");
  const target = await snapshotTarget(snapshotRoot, requestedPath);
  const info = await lstat(target);
  if (!info.isFile()) throw new AgentSessionError("tool_path_denied");
  if (info.size > maxBytes) throw new AgentSessionError("tool_read_limit");
  const content = await readFile(target, "utf8");
  if (Buffer.byteLength(content, "utf8") > maxBytes) throw new AgentSessionError("tool_read_limit");
  return textResult({ path: requestedPath, content });
}

async function searchWorkspace(
  snapshotRoot: string,
  input: unknown,
  limits: ToolHostLimits,
): Promise<WorkspaceToolResult> {
  const value = objectInput(input);
  const query = nonEmptyString(value.query);
  const requestedPath = optionalPath(value.path, true);
  const maxResults = boundedPositive(value.maxResults, limits.maxSearchResults, "tool_argument_invalid");
  const maxBytes = boundedPositive(value.maxBytes, limits.maxSearchBytes, "tool_argument_invalid");
  const root = await snapshotTarget(snapshotRoot, requestedPath);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() && !rootInfo.isFile()) throw new AgentSessionError("tool_path_denied");

  const matches: SearchMatch[] = [];
  let bytesRead = 0;
  const inspectFile = async (file: string, relativePath: string): Promise<boolean> => {
    const info = await lstat(file);
    if (!info.isFile()) return true;
    if (bytesRead + info.size > maxBytes) return false;
    bytesRead += info.size;
    const content = await readFile(file, "utf8");
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!line.includes(query)) continue;
      matches.push({ path: relativePath, line: index + 1, text: line });
      if (matches.length >= maxResults) return false;
    }
    return true;
  };

  if (rootInfo.isFile()) {
    await inspectFile(root, requestedPath);
  } else {
    await walkDirectory(snapshotRoot, root, requestedPath, 0, limits.maxRecursionDepth, async (entry, path, file) => {
      if (matches.length >= maxResults || bytesRead >= maxBytes) return false;
      return entry.isDirectory() || await inspectFile(file, path);
    });
  }
  return textResult({ matches, truncated: matches.length >= maxResults || bytesRead >= maxBytes });
}

async function writeArtifact(
  artifactRoot: string,
  input: unknown,
  limits: ToolHostLimits,
): Promise<WorkspaceToolResult> {
  const value = objectInput(input);
  const artifactPath = requiredPath(value.path);
  const content = stringInput(value.content);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > limits.maxWriteBytes) throw new AgentSessionError("tool_output_limit");

  const target = await artifactTarget(artifactRoot, artifactPath);
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
    await handle.writeFile(content, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "EEXIST") || isFileSystemError(error, "ELOOP")) {
      throw new AgentSessionError("tool_write_denied");
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return {
    content: JSON.stringify({ path: artifactPath, bytes }),
    artifact: { path: artifactPath, bytes },
  };
}

async function existingDirectory(path: string, code: "tool_path_denied" | "tool_write_denied"): Promise<string> {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) throw new AgentSessionError(code);
  const absolute = resolve(path);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new AgentSessionError(code);
    return await realpath(absolute);
  } catch (error) {
    if (error instanceof AgentSessionError) throw error;
    throw new AgentSessionError(code);
  }
}

async function writableDirectory(path: string): Promise<string> {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new AgentSessionError("tool_write_denied");
  }
  try {
    await mkdir(resolve(path), { recursive: true, mode: 0o700 });
  } catch {
    throw new AgentSessionError("tool_write_denied");
  }
  return existingDirectory(path, "tool_write_denied");
}

async function snapshotTarget(snapshotRoot: string, requestedPath: string): Promise<string> {
  const normalized = normalizeRelativePath(requestedPath, true);
  const candidate = resolve(snapshotRoot, ...normalized.split("/"));
  if (candidate !== snapshotRoot && !isInside(snapshotRoot, candidate)) {
    throw new AgentSessionError("tool_path_denied");
  }
  await rejectSymlinkSegments(snapshotRoot, normalized, "tool_path_denied");
  try {
    const canonical = await realpath(candidate);
    if (canonical !== snapshotRoot && !isInside(snapshotRoot, canonical)) {
      throw new AgentSessionError("tool_path_denied");
    }
    return canonical;
  } catch (error) {
    if (error instanceof AgentSessionError) throw error;
    throw new AgentSessionError("tool_path_denied");
  }
}

async function artifactTarget(artifactRoot: string, requestedPath: string): Promise<string> {
  const normalized = normalizeRelativePath(requestedPath, false);
  const segments = normalized.split("/");
  const filename = segments.pop();
  if (filename === undefined || filename.length === 0) throw new AgentSessionError("tool_write_denied");
  let parent = artifactRoot;
  for (const segment of segments) {
    const next = join(parent, segment);
    try {
      const info = await lstat(next);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new AgentSessionError("tool_write_denied");
    } catch (error) {
      if (error instanceof AgentSessionError) throw error;
      try {
        await mkdir(next, { mode: 0o700 });
        const created = await lstat(next);
        if (created.isSymbolicLink() || !created.isDirectory()) throw new AgentSessionError("tool_write_denied");
      } catch (mkdirError) {
        if (mkdirError instanceof AgentSessionError) throw mkdirError;
        throw new AgentSessionError("tool_write_denied");
      }
    }
    parent = next;
  }
  const canonicalParent = await realpath(parent);
  if (!isInside(artifactRoot, canonicalParent) && canonicalParent !== artifactRoot) {
    throw new AgentSessionError("tool_write_denied");
  }
  const target = join(canonicalParent, filename);
  if (!isInside(artifactRoot, target)) throw new AgentSessionError("tool_write_denied");
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new AgentSessionError("tool_write_denied");
  } catch (error) {
    if (error instanceof AgentSessionError) throw error;
    if (!isFileSystemError(error, "ENOENT")) throw new AgentSessionError("tool_write_denied");
  }
  return target;
}

async function rejectSymlinkSegments(
  root: string,
  normalizedPath: string,
  code: "tool_path_denied" | "tool_write_denied",
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
  snapshotRoot: string,
  directory: string,
  displayRoot: string,
  depth: number,
  maxDepth: number,
  visit: (entry: { isDirectory(): boolean }, path: string, file: string) => Promise<boolean>,
): Promise<boolean> {
  if (depth > maxDepth) return true;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new AgentSessionError("tool_path_denied");
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const file = join(directory, entry.name);
    const path = displayRoot === "." ? entry.name : `${displayRoot}/${entry.name}`;
    if (!isInside(snapshotRoot, file)) throw new AgentSessionError("tool_path_denied");
    const continueWalking = await visit(entry, path, file);
    if (!continueWalking) return false;
    if (entry.isDirectory() && depth < maxDepth) {
      const walked = await walkDirectory(snapshotRoot, file, path, depth + 1, maxDepth, visit);
      if (!walked) return false;
    }
  }
  return true;
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
  return normalizeRelativePath(value, allowRoot);
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new AgentSessionError("tool_argument_invalid");
  return value;
}

function stringInput(value: unknown): string {
  if (typeof value !== "string") throw new AgentSessionError("tool_argument_invalid");
  return value;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new AgentSessionError("tool_argument_invalid");
  return value;
}

function boundedPositive(value: unknown, fallback: number, code: "tool_argument_invalid"): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > fallback) {
    throw new AgentSessionError(code);
  }
  return value;
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
  if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) throw new AgentSessionError("tool_argument_invalid");
  return value;
}

function textResult(value: unknown): WorkspaceToolResult {
  return { content: JSON.stringify(value) };
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
