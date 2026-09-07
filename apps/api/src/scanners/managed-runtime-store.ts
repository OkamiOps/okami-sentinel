import fs from "node:fs";
import path from "node:path";

import type {
  EngineUpdateErrorCode,
  EngineUpdateId,
  ManagedRuntimeId,
} from "@csb/shared";

const MANIFEST_FILE = "state.json";
const MANIFEST_MAX_BYTES = 64 * 1024;
const PACKAGE_JSON_MAX_BYTES = 64 * 1024;
const MANAGED_IDS: readonly ManagedRuntimeId[] = ["codex-security", "codex-cli"];
const ENGINE_IDS: readonly EngineUpdateId[] = ["codex-security", "codex-cli", "mantis", "vulnhunter"];
const ERROR_CODES: readonly EngineUpdateErrorCode[] = [
  "scan_active", "update_in_progress", "check_required", "version_changed",
  "external_runtime", "bundled_engine", "registry_unavailable",
  "install_failed", "verification_failed", "rollback_unavailable", "state_invalid",
];

export interface ManagedRuntimeRecord {
  version: string;
  /** Always the exact path below `engine-updates`; it is never caller-controlled. */
  relativePath: string;
}

export interface EngineUpdateCheckRecord {
  latestVersion: string | null;
  checkedAt: string;
  error: EngineUpdateErrorCode | null;
}

export interface EngineUpdateLastOperation {
  id: ManagedRuntimeId;
  action: "update" | "rollback";
  status: "succeeded" | "failed";
  version: string | null;
  at: string;
  error: EngineUpdateErrorCode | null;
}

export interface ManagedRuntimeManifest {
  schemaVersion: 1;
  runtimes: Partial<Record<ManagedRuntimeId, {
    active: ManagedRuntimeRecord | null;
    previous: ManagedRuntimeRecord | null;
  }>>;
  checks: Partial<Record<EngineUpdateId, EngineUpdateCheckRecord>>;
  lastOperation: EngineUpdateLastOperation | null;
}

export class ManagedRuntimeStoreError extends Error {
  constructor(readonly code: "state_invalid") {
    super(code);
    this.name = "ManagedRuntimeStoreError";
  }
}

export function engineUpdatesDirectory(dataDir: string): string {
  if (typeof dataDir !== "string" || dataDir.length === 0 || dataDir.includes("\0")) {
    throw new ManagedRuntimeStoreError("state_invalid");
  }
  return path.resolve(dataDir, "engine-updates");
}

export function managedRuntimeDirectory(
  dataDir: string,
  id: ManagedRuntimeId,
  version: string,
): string {
  if (!isManagedRuntimeId(id) || !isStableVersion(version)) {
    throw new ManagedRuntimeStoreError("state_invalid");
  }
  return path.join(engineUpdatesDirectory(dataDir), "versions", id, version);
}

export function managedRuntimeEntryPath(
  dataDir: string,
  id: ManagedRuntimeId,
  version: string,
): string {
  return path.join(managedRuntimeDirectory(dataDir, id, version), ...runtimeEntryParts(id));
}

/**
 * Only a fully validated active record can influence command resolution.
 * Invalid or manually tampered state is deliberately treated as unavailable.
 */
export function getManagedRuntimeCommand(
  dataDir: string,
  id: ManagedRuntimeId,
): { command: string; version: string } | null {
  try {
    const manifest = readManagedRuntimeManifest(dataDir);
    const active = manifest.runtimes[id]?.active ?? null;
    if (active === null || !validateInstalledRuntime(dataDir, id, active)) return null;
    return { command: managedRuntimeEntryPath(dataDir, id, active.version), version: active.version };
  } catch {
    return null;
  }
}

export function readManagedRuntimeManifest(dataDir: string): ManagedRuntimeManifest {
  const root = engineUpdatesDirectory(dataDir);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (isNotFound(error)) return emptyManifest();
    throw new ManagedRuntimeStoreError("state_invalid");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new ManagedRuntimeStoreError("state_invalid");
  const manifestPath = path.join(root, MANIFEST_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(manifestPath);
  } catch (error) {
    if (isNotFound(error)) return emptyManifest();
    throw new ManagedRuntimeStoreError("state_invalid");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MANIFEST_MAX_BYTES) {
    throw new ManagedRuntimeStoreError("state_invalid");
  }
  try {
    return parseManifest(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    if (error instanceof ManagedRuntimeStoreError) throw error;
    throw new ManagedRuntimeStoreError("state_invalid");
  }
}

export function writeManagedRuntimeManifest(
  dataDir: string,
  manifest: ManagedRuntimeManifest,
): void {
  const checked = parseManifest(JSON.stringify(manifest));
  const root = engineUpdatesDirectory(dataDir);
  ensurePrivateDirectory(root);
  const target = path.join(root, MANIFEST_FILE);
  const temporary = path.join(root, `.${MANIFEST_FILE}.${process.pid}.${randomSuffix()}.tmp`);
  const payload = `${JSON.stringify(checked)}\n`;
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, payload, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, target);
    fsyncDirectory(root);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* only task-owned temporary state */ }
    if (error instanceof ManagedRuntimeStoreError) throw error;
    throw new ManagedRuntimeStoreError("state_invalid");
  }
}

export function updateManagedRuntimeManifest(
  dataDir: string,
  update: (manifest: ManagedRuntimeManifest) => ManagedRuntimeManifest,
): ManagedRuntimeManifest {
  const next = update(readManagedRuntimeManifest(dataDir));
  writeManagedRuntimeManifest(dataDir, next);
  return next;
}

/** Validates a final installed runtime without invoking any installed code. */
export function validateInstalledRuntime(
  dataDir: string,
  id: ManagedRuntimeId,
  record: ManagedRuntimeRecord,
): boolean {
  try {
    if (!validRuntimeRecord(record, id)) return false;
    const runtimeRoot = managedRuntimeDirectory(dataDir, id, record.version);
    if (!isPrivateDirectoryTree(engineUpdatesDirectory(dataDir), ["versions", id, record.version])) return false;
    const packagePath = path.join(runtimeRoot, "node_modules", packageName(id), "package.json");
    if (!isRegularFileWithin(runtimeRoot, ["node_modules", ...packageName(id).split("/"), "package.json"]) ||
        !isRegularFileWithin(runtimeRoot, runtimeEntryParts(id))) return false;
    const packageStat = fs.lstatSync(packagePath);
    if (packageStat.size > PACKAGE_JSON_MAX_BYTES) return false;
    const packageInfo = JSON.parse(fs.readFileSync(packagePath, "utf8")) as unknown;
    return isPlainRecord(packageInfo) &&
      packageInfo.name === packageName(id) &&
      packageInfo.version === record.version;
  } catch {
    return false;
  }
}

export function runtimeRecord(id: ManagedRuntimeId, version: string): ManagedRuntimeRecord {
  if (!isManagedRuntimeId(id) || !isStableVersion(version)) {
    throw new ManagedRuntimeStoreError("state_invalid");
  }
  return { version, relativePath: expectedRelativePath(id, version) };
}

export function isStableVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = /^(0|[1-9]\d{0,9})\.(0|[1-9]\d{0,9})\.(0|[1-9]\d{0,9})$/.exec(value);
  if (match === null) return false;
  return match.slice(1).every((part) => Number.isSafeInteger(Number(part)));
}

export function isManagedRuntimeId(value: unknown): value is ManagedRuntimeId {
  return typeof value === "string" && (MANAGED_IDS as readonly string[]).includes(value);
}

export function packageName(id: ManagedRuntimeId): "@openai/codex-security" | "@openai/codex" {
  return id === "codex-security" ? "@openai/codex-security" : "@openai/codex";
}

function emptyManifest(): ManagedRuntimeManifest {
  return { schemaVersion: 1, runtimes: {}, checks: {}, lastOperation: null };
}

function parseManifest(value: string): ManagedRuntimeManifest {
  if (Buffer.byteLength(value, "utf8") > MANIFEST_MAX_BYTES) throw new ManagedRuntimeStoreError("state_invalid");
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new ManagedRuntimeStoreError("state_invalid");
  }
  if (!isPlainRecord(raw) || raw.schemaVersion !== 1 ||
      !isPlainRecord(raw.runtimes) || !isPlainRecord(raw.checks) ||
      !(raw.lastOperation === null || validLastOperation(raw.lastOperation))) {
    throw new ManagedRuntimeStoreError("state_invalid");
  }
  if (Object.keys(raw).some((key) => !["schemaVersion", "runtimes", "checks", "lastOperation"].includes(key))) {
    throw new ManagedRuntimeStoreError("state_invalid");
  }
  const runtimes: ManagedRuntimeManifest["runtimes"] = {};
  for (const [id, runtime] of Object.entries(raw.runtimes)) {
    if (!isManagedRuntimeId(id) || !isPlainRecord(runtime) || Object.keys(runtime).length !== 2 ||
        Object.keys(runtime).some((key) => key !== "active" && key !== "previous") ||
        !validOptionalRuntimeRecord(runtime.active, id) ||
        !validOptionalRuntimeRecord(runtime.previous, id)) {
      throw new ManagedRuntimeStoreError("state_invalid");
    }
    runtimes[id] = {
      active: runtime.active === null || runtime.active === undefined ? null : copyRuntimeRecord(runtime.active),
      previous: runtime.previous === null || runtime.previous === undefined ? null : copyRuntimeRecord(runtime.previous),
    };
  }
  const checks: ManagedRuntimeManifest["checks"] = {};
  for (const [id, check] of Object.entries(raw.checks)) {
    if (!isEngineId(id) || !validCheck(check, id)) throw new ManagedRuntimeStoreError("state_invalid");
    checks[id] = { ...check };
  }
  return {
    schemaVersion: 1,
    runtimes,
    checks,
    lastOperation: raw.lastOperation === null ? null : { ...raw.lastOperation },
  };
}

function validOptionalRuntimeRecord(value: unknown, id: ManagedRuntimeId): boolean {
  return value === null || value === undefined || validRuntimeRecord(value, id);
}

function validRuntimeRecord(value: unknown, id: ManagedRuntimeId): value is ManagedRuntimeRecord {
  return isPlainRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.version === "string" &&
    typeof value.relativePath === "string" &&
    isStableVersion(value.version) &&
    value.relativePath === expectedRelativePath(id, value.version);
}

function copyRuntimeRecord(value: ManagedRuntimeRecord): ManagedRuntimeRecord {
  return { version: value.version, relativePath: value.relativePath };
}

function validCheck(value: unknown, id: EngineUpdateId): value is EngineUpdateCheckRecord {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !["latestVersion", "checkedAt", "error"].includes(key))) {
    return false;
  }
  const latestVersion = value.latestVersion;
  const versionValid = latestVersion === null ||
    (id === "mantis" || id === "vulnhunter" ? isCommitSha(latestVersion) : isStableVersion(latestVersion));
  return versionValid && isIsoDate(value.checkedAt) && validError(value.error);
}

function validLastOperation(value: unknown): value is EngineUpdateLastOperation {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !["id", "action", "status", "version", "at", "error"].includes(key))) {
    return false;
  }
  return isManagedRuntimeId(value.id) &&
    (value.action === "update" || value.action === "rollback") &&
    (value.status === "succeeded" || value.status === "failed") &&
    (value.version === null || isStableVersion(value.version)) &&
    isIsoDate(value.at) && validError(value.error);
}

function validError(value: unknown): value is EngineUpdateErrorCode | null {
  return value === null || (typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value));
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

function isEngineId(value: unknown): value is EngineUpdateId {
  return typeof value === "string" && (ENGINE_IDS as readonly string[]).includes(value);
}

function expectedRelativePath(id: ManagedRuntimeId, version: string): string {
  return path.posix.join("versions", id, version);
}

function runtimeEntryParts(id: ManagedRuntimeId): string[] {
  return id === "codex-security"
    ? ["node_modules", "@openai", "codex-security", "bin", "codex-security.mjs"]
    : ["node_modules", "@openai", "codex", "bin", "codex.js"];
}

function ensurePrivateDirectory(directory: string): void {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ManagedRuntimeStoreError("state_invalid");
    return;
  } catch (error) {
    if (error instanceof ManagedRuntimeStoreError) throw error;
    if (!isNotFound(error)) throw new ManagedRuntimeStoreError("state_invalid");
  }
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!isPrivateDirectory(directory)) throw new ManagedRuntimeStoreError("state_invalid");
  } catch (error) {
    if (error instanceof ManagedRuntimeStoreError) throw error;
    throw new ManagedRuntimeStoreError("state_invalid");
  }
}

function isPrivateDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isPrivateDirectoryTree(root: string, parts: readonly string[]): boolean {
  if (!isPrivateDirectory(root)) return false;
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!isPrivateDirectory(current)) return false;
  }
  return true;
}

function isRegularFileWithin(root: string, parts: readonly string[]): boolean {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      if (part !== parts.at(-1) && !stat.isDirectory()) return false;
      if (part === parts.at(-1) && !stat.isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 14);
}

function fsyncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch {
    // Some filesystems do not support directory fsync; rename already keeps the old manifest intact.
  }
}
