import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import type { GuardrailRepository } from "@csb/shared";
import tar, { type Headers } from "tar-stream";

import type { MaterializationLeaseMetadata } from "../gate-store.js";

const DEFAULT_LIMITS: SnapshotExtractionLimits = Object.freeze({
  maxEntries: 500_000,
  maxExtractedBytes: 2 * 1024 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxPathBytes: 4_096,
});
const LEASE_TTL_MS = 2 * 60 * 60 * 1_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize [0-9]+(?:\n|$)/;

export type SnapshotMaterializationErrorCode =
  | "snapshot_archive_invalid"
  | "snapshot_cancelled"
  | "snapshot_cleanup_failed"
  | "snapshot_limit_exceeded"
  | "snapshot_materialization_failed";

export class SnapshotMaterializationError extends Error {
  constructor(readonly code: SnapshotMaterializationErrorCode) {
    super(code);
    this.name = "SnapshotMaterializationError";
  }
}

export interface SnapshotExtractionLimits {
  maxEntries: number;
  maxExtractedBytes: number;
  maxFileBytes: number;
  maxPathBytes: number;
}

export interface SnapshotArchiveEntry {
  name: string;
  type?: Headers["type"];
  content?: string | Buffer;
  mode?: number;
  linkname?: string;
}

export interface SnapshotEntryMetadata {
  path: string;
  type: "directory" | "file" | "symlink";
  mode: number;
  size: number;
  digest: string;
}

export interface MaterializedSnapshot {
  path: string;
  identity: string;
  entries: SnapshotEntryMetadata[];
  fileCount: number;
  submodules: string[];
  lfsPointers: string[];
}

export interface MaterializationLeaseStore {
  save(lease: MaterializationLeaseMetadata): void;
}

export interface SnapshotMaterializerDependencies {
  root: string;
  leases: MaterializationLeaseStore;
  downloadArchive(
    repository: GuardrailRepository,
    commitSha: string,
    signal?: AbortSignal,
  ): Promise<Readable>;
  limits?: SnapshotExtractionLimits;
  createLeaseId?(): string;
  now?(): Date;
}

export interface MaterializeSnapshotsInput {
  gateId: string;
  repository: GuardrailRepository;
  baseSha: string;
  headSha: string;
  signal?: AbortSignal;
}

export interface MaterializationHandle {
  leaseId: string;
  identity: string;
  base: MaterializedSnapshot;
  head: MaterializedSnapshot;
  release(): Promise<void>;
}

export class SnapshotMaterializer {
  readonly #root: string;
  readonly #limits: SnapshotExtractionLimits;
  readonly #createLeaseId: () => string;
  readonly #now: () => Date;

  constructor(readonly dependencies: SnapshotMaterializerDependencies) {
    this.#root = managedRoot(dependencies.root);
    this.#limits = validatedLimits(dependencies.limits ?? DEFAULT_LIMITS);
    this.#createLeaseId = dependencies.createLeaseId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async materialize(input: MaterializeSnapshotsInput): Promise<MaterializationHandle> {
    const gateId = safeId(input.gateId);
    const leaseId = safeId(this.#createLeaseId());
    const baseSha = fullSha(input.baseSha);
    const headSha = fullSha(input.headSha);
    const createdAt = this.#now();
    const leaseRoot = path.join(this.#root, `${gateId}--${leaseId}`);
    let lease: MaterializationLeaseMetadata = {
      id: leaseId,
      gateId,
      repositoryKey: input.repository.repositoryKey,
      snapshotIdentity: "pending",
      state: "queued",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + LEASE_TTL_MS).toISOString(),
      releasedAt: null,
    };
    this.dependencies.leases.save(lease);

    try {
      fs.mkdirSync(leaseRoot, { recursive: false, mode: 0o700 });
      lease = { ...lease, state: "materializing" };
      this.dependencies.leases.save(lease);
      const basePath = path.join(leaseRoot, "base");
      const headPath = path.join(leaseRoot, "head");
      const baseArchive = await this.dependencies.downloadArchive(
        input.repository,
        baseSha,
        input.signal,
      );
      const base = await extractGitHubArchive(baseArchive, basePath, this.#limits, input.signal);
      const headArchive = await this.dependencies.downloadArchive(
        input.repository,
        headSha,
        input.signal,
      );
      const head = await extractGitHubArchive(headArchive, headPath, this.#limits, input.signal);
      const identity = digest(JSON.stringify({ base: base.identity, head: head.identity }));
      lease = { ...lease, snapshotIdentity: identity, state: "ready" };
      this.dependencies.leases.save(lease);
      let released = false;
      return {
        leaseId,
        identity,
        base,
        head,
        release: async () => {
          if (released) return;
          await this.#release(lease, leaseRoot, "released");
          released = true;
        },
      };
    } catch (error) {
      try {
        removePrivateLeaseRoot(this.#root, leaseRoot);
        this.dependencies.leases.save({
          ...lease,
          state: "failed",
          releasedAt: this.#now().toISOString(),
        });
      } catch {
        this.dependencies.leases.save({ ...lease, state: "failed", releasedAt: null });
        throw new SnapshotMaterializationError("snapshot_cleanup_failed");
      }
      if (error instanceof SnapshotMaterializationError) throw error;
      throw new SnapshotMaterializationError("snapshot_materialization_failed");
    }
  }

  async #release(
    lease: MaterializationLeaseMetadata,
    leaseRoot: string,
    state: "released",
  ): Promise<void> {
    try {
      removePrivateLeaseRoot(this.#root, leaseRoot);
      this.dependencies.leases.save({
        ...lease,
        state,
        releasedAt: this.#now().toISOString(),
      });
    } catch {
      this.dependencies.leases.save({ ...lease, state: "failed", releasedAt: null });
      throw new SnapshotMaterializationError("snapshot_cleanup_failed");
    }
  }
}

export async function extractGitHubArchive(
  compressed: Readable,
  destination: string,
  requestedLimits: SnapshotExtractionLimits = DEFAULT_LIMITS,
  signal?: AbortSignal,
): Promise<MaterializedSnapshot> {
  const limits = validatedLimits(requestedLimits);
  prepareDestination(destination);
  const extract = tar.extract();
  const entries = new Map<string, SnapshotEntryMetadata>();
  const materializedDirectories = new Set<string>();
  const specialContents = new Map<string, Buffer>();
  let archiveRoot: string | null = null;
  let entryCount = 0;
  let extractedBytes = 0;
  let failed: SnapshotMaterializationError | null = null;

  extract.on("entry", (header, stream, next) => {
    void (async () => {
      if (failed !== null) return;
      entryCount += 1;
      if (entryCount > limits.maxEntries) limit();
      const resolved = archivePath(header, archiveRoot, limits.maxPathBytes);
      archiveRoot = resolved.archiveRoot;
      if (resolved.path === null) {
        stream.resume();
        await streamFinished(stream);
        next();
        return;
      }
      const relativePath = resolved.path;
      const type = archiveEntryType(header.type);
      assertNoCollision(relativePath, type, entries, materializedDirectories);
      const mode = normalizedMode(header.mode, type);

      if (type === "directory") {
        stream.resume();
        await streamFinished(stream);
        ensureParents(destination, relativePath, materializedDirectories);
        const target = path.join(destination, ...relativePath.split("/"));
        if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
        materializedDirectories.add(relativePath);
        entries.set(relativePath, {
          path: relativePath,
          type,
          mode,
          size: 0,
          digest: digest(""),
        });
        next();
        return;
      }

      ensureParents(destination, relativePath, materializedDirectories);
      const target = path.join(destination, ...relativePath.split("/"));
      if (type === "symlink") {
        stream.resume();
        await streamFinished(stream);
        const linkname = safeSymlinkTarget(relativePath, header.linkname, limits.maxPathBytes);
        fs.symlinkSync(linkname, target);
        entries.set(relativePath, {
          path: relativePath,
          type,
          mode,
          size: Buffer.byteLength(linkname),
          digest: digest(linkname),
        });
        next();
        return;
      }

      const declaredSize = header.size ?? 0;
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) invalid();
      if (declaredSize > limits.maxFileBytes) limit();
      if (extractedBytes + declaredSize > limits.maxExtractedBytes) limit();
      const descriptor = fs.openSync(
        target,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      const hash = createHash("sha256");
      const prefix: Buffer[] = [];
      let prefixBytes = 0;
      let bytes = 0;
      try {
        for await (const value of stream) {
          const chunk = Buffer.from(value);
          bytes += chunk.byteLength;
          if (bytes > limits.maxFileBytes || extractedBytes + bytes > limits.maxExtractedBytes) limit();
          hash.update(chunk);
          fs.writeSync(descriptor, chunk);
          if (prefixBytes < 1024 * 1024) {
            const retained = chunk.subarray(0, Math.min(chunk.byteLength, 1024 * 1024 - prefixBytes));
            prefix.push(retained);
            prefixBytes += retained.byteLength;
          }
        }
        if (bytes !== declaredSize) invalid();
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      extractedBytes += bytes;
      fs.chmodSync(target, mode & 0o111 ? 0o500 : 0o400);
      const retained = Buffer.concat(prefix);
      if (relativePath === ".gitmodules" && bytes > 1024 * 1024) limit();
      if (relativePath === ".gitmodules" || LFS_POINTER.test(retained.toString("utf8"))) {
        specialContents.set(relativePath, retained);
      }
      entries.set(relativePath, {
        path: relativePath,
        type,
        mode,
        size: bytes,
        digest: `sha256:${hash.digest("hex")}`,
      });
      next();
    })().catch((error) => {
      failed = error instanceof SnapshotMaterializationError
        ? error
        : new SnapshotMaterializationError("snapshot_archive_invalid");
      extract.destroy(failed);
    });
  });

  try {
    await pipeline(compressed, createGunzip(), extract, { signal });
    if (failed !== null) throw failed;
    const sortedEntries = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
    for (const directory of [...materializedDirectories].sort((left, right) => right.length - left.length)) {
      fs.chmodSync(path.join(destination, ...directory.split("/")), 0o500);
    }
    fs.chmodSync(destination, 0o500);
    const gitmodules = specialContents.get(".gitmodules")?.toString("utf8") ?? "";
    const submodules = parseSubmodulePaths(gitmodules);
    const lfsPointers = [...specialContents.entries()]
      .filter(([entryPath, content]) => entryPath !== ".gitmodules" && LFS_POINTER.test(content.toString("utf8")))
      .map(([entryPath]) => entryPath)
      .sort();
    return {
      path: destination,
      identity: digest(JSON.stringify(sortedEntries)),
      entries: sortedEntries,
      fileCount: sortedEntries.filter((entry) => entry.type === "file").length,
      submodules,
      lfsPointers,
    };
  } catch (error) {
    safeRemoveExtraction(destination);
    if (signal?.aborted === true) {
      throw new SnapshotMaterializationError("snapshot_cancelled");
    }
    if (error instanceof SnapshotMaterializationError) throw error;
    throw new SnapshotMaterializationError("snapshot_archive_invalid");
  }
}

function archivePath(
  header: Headers,
  knownRoot: string | null,
  maxPathBytes: number,
): { archiveRoot: string; path: string | null } {
  const name = header.name;
  if (
    typeof name !== "string"
    || name.length === 0
    || Buffer.byteLength(name) > maxPathBytes
    || name.startsWith("/")
    || name.startsWith("\\")
    || name.includes("\\")
    || name.includes("\0")
  ) invalid();
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) invalid();
  const archiveRoot = knownRoot ?? parts[0]!;
  if (parts[0] !== archiveRoot) invalid();
  const relative = parts.slice(1);
  if (relative.length === 0) {
    if (archiveEntryType(header.type) !== "directory") invalid();
    return { archiveRoot, path: null };
  }
  return { archiveRoot, path: relative.join("/") };
}

function archiveEntryType(value: Headers["type"]): SnapshotEntryMetadata["type"] {
  if (value === "file" || value === undefined) return "file";
  if (value === "directory") return "directory";
  if (value === "symlink") return "symlink";
  invalid();
}

function assertNoCollision(
  relativePath: string,
  type: SnapshotEntryMetadata["type"],
  entries: ReadonlyMap<string, SnapshotEntryMetadata>,
  directories: ReadonlySet<string>,
): void {
  if (entries.has(relativePath)) invalid();
  const parts = relativePath.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const parent = parts.slice(0, index).join("/");
    const existing = entries.get(parent);
    if (existing !== undefined && existing.type !== "directory") invalid();
  }
  if (type !== "directory") {
    const prefix = `${relativePath}/`;
    if ([...entries.keys()].some((candidate) => candidate.startsWith(prefix))) invalid();
    if ([...directories].some((candidate) => candidate.startsWith(prefix))) invalid();
  }
}

function ensureParents(
  destination: string,
  relativePath: string,
  directories: Set<string>,
): void {
  const parts = relativePath.split("/").slice(0, -1);
  let current = destination;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    const relative = parts.slice(0, index + 1).join("/");
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    directories.add(relative);
  }
}

function safeSymlinkTarget(
  relativePath: string,
  value: string | null | undefined,
  maxPathBytes: number,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value) > maxPathBytes
    || value.startsWith("/")
    || value.startsWith("\\")
    || value.includes("\\")
    || value.includes("\0")
  ) invalid();
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), value));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) invalid();
  return value;
}

function normalizedMode(
  mode: number | undefined,
  type: SnapshotEntryMetadata["type"],
): number {
  if (mode !== undefined && (!Number.isSafeInteger(mode) || mode < 0)) invalid();
  const permissions = (mode ?? (type === "directory" ? 0o755 : 0o644)) & 0o777;
  return type === "directory" ? (permissions | 0o500) : permissions;
}

function parseSubmodulePaths(content: string): string[] {
  if (Buffer.byteLength(content) > 1024 * 1024) limit();
  const paths = new Set<string>();
  for (const match of content.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
    const candidate = match[1];
    if (candidate === undefined) continue;
    const normalized = safeMetadataPath(candidate);
    paths.add(normalized);
  }
  return [...paths].sort();
}

function safeMetadataPath(value: string): string {
  if (
    Buffer.byteLength(value) > 4_096
    || value.length === 0
    || value.startsWith("/")
    || value.startsWith("\\")
    || value.includes("\\")
    || value.includes("\0")
  ) invalid();
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) invalid();
  return parts.join("/");
}

function prepareDestination(destination: string): void {
  if (fs.existsSync(destination)) invalid();
  const parent = path.dirname(destination);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
}

function managedRoot(value: string): string {
  const root = path.resolve(value);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SnapshotMaterializationError("snapshot_materialization_failed");
  }
  return fs.realpathSync(root);
}

function removePrivateLeaseRoot(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SnapshotMaterializationError("snapshot_cleanup_failed");
  }
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SnapshotMaterializationError("snapshot_cleanup_failed");
  }
  makeTreeRemovable(target);
  fs.rmSync(target, { recursive: true, force: false });
}

export function cleanupMaterializationLeaseRoot(
  configuredRoot: string,
  gateId: string,
  leaseId: string,
): void {
  const root = managedRoot(configuredRoot);
  removePrivateLeaseRoot(root, path.join(root, `${safeId(gateId)}--${safeId(leaseId)}`));
}

function safeRemoveExtraction(destination: string): void {
  try {
    if (fs.existsSync(destination) && fs.lstatSync(destination).isDirectory()) {
      makeTreeRemovable(destination);
      fs.rmSync(destination, { recursive: true, force: true });
    }
  } catch {
    // The lease cleanup remains authoritative and reports a retryable failure.
  }
}

function makeTreeRemovable(root: string): void {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new SnapshotMaterializationError("snapshot_cleanup_failed");
  }
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) makeTreeRemovable(target);
  }
}

function streamFinished(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
}

function validatedLimits(value: SnapshotExtractionLimits): SnapshotExtractionLimits {
  for (const candidate of [
    value.maxEntries,
    value.maxExtractedBytes,
    value.maxFileBytes,
    value.maxPathBytes,
  ]) {
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      throw new SnapshotMaterializationError("snapshot_materialization_failed");
    }
  }
  return { ...value };
}

function safeId(value: string): string {
  if (!SAFE_ID.test(value)) {
    throw new SnapshotMaterializationError("snapshot_materialization_failed");
  }
  return value;
}

function fullSha(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new SnapshotMaterializationError("snapshot_materialization_failed");
  }
  return value;
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function invalid(): never {
  throw new SnapshotMaterializationError("snapshot_archive_invalid");
}

function limit(): never {
  throw new SnapshotMaterializationError("snapshot_limit_exceeded");
}
