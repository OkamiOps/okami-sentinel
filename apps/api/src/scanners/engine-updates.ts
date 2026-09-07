import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  EngineUpdateErrorCode,
  EngineUpdateId,
  EngineUpdateItem,
  EngineUpdatesResponse,
  ManagedRuntimeId,
} from "@csb/shared";
import {
  engineUpdatesDirectory,
  isManagedRuntimeId,
  isStableVersion,
  managedRuntimeDirectory,
  managedRuntimeEntryPath,
  packageName,
  readManagedRuntimeManifest,
  runtimeRecord,
  type EngineUpdateCheckRecord,
  type EngineUpdateLastOperation,
  type ManagedRuntimeManifest,
  type ManagedRuntimeRecord,
  ManagedRuntimeStoreError,
  validateInstalledRuntime,
  writeManagedRuntimeManifest,
} from "./managed-runtime-store.js";

export const ENGINE_UPDATE_CHECK_TTL_MS = 5 * 60_000;
export const ENGINE_UPDATE_REQUEST_TIMEOUT_MS = 10_000;

const INSTALL_TIMEOUT_MS = 120_000;
const EXEC_OUTPUT_MAX_BYTES = 256 * 1024;
const FETCH_JSON_MAX_BYTES = 32 * 1024;
const EXEC_TERM_GRACE_MS = 250;
const EXEC_FINAL_GRACE_MS = 250;
const NPM_REGISTRY = "https://registry.npmjs.org";
const MANTIS_HEAD_URL = "https://api.github.com/repos/google/mantis/commits?per_page=1";
const VULNHUNTER_HEAD_URL = "https://api.github.com/repos/capitalone/vulnhunter/commits?per_page=1";

interface EngineSpec {
  id: EngineUpdateId;
  name: string;
  kind: EngineUpdateItem["kind"];
  sourceUrl: string;
  pin?: string | null;
  pinTrusted?: boolean;
  packageId?: ManagedRuntimeId;
  checkUrl: string;
}

const ENGINES: readonly EngineSpec[] = [
  {
    id: "codex-security",
    name: "OpenAI Codex Security",
    kind: "cli",
    sourceUrl: "https://github.com/openai/codex-security",
    packageId: "codex-security",
    checkUrl: `${NPM_REGISTRY}/-/package/@openai%2Fcodex-security/dist-tags`,
  },
  {
    id: "codex-cli",
    name: "OpenAI Codex CLI",
    kind: "cli",
    sourceUrl: "https://github.com/openai/codex",
    packageId: "codex-cli",
    checkUrl: `${NPM_REGISTRY}/-/package/@openai%2Fcodex/dist-tags`,
  },
  {
    id: "mantis",
    name: "Google Mantis methodology",
    kind: "methodology",
    sourceUrl: "https://github.com/google/mantis",
    pin: "876a0c8c6b92c92f34e0041b7dbbc0e4cccddc52",
    pinTrusted: true,
    checkUrl: MANTIS_HEAD_URL,
  },
  {
    id: "vulnhunter",
    name: "Capital One VulnHunter methodology",
    kind: "methodology",
    sourceUrl: "https://github.com/capitalone/vulnhunter",
    pin: "8f9eadd772f66160df445b65730e2fbd6ea50d73",
    pinTrusted: true,
    checkUrl: VULNHUNTER_HEAD_URL,
  },
];

function engineSpecs(
  pins: EngineUpdatesDependencies["methodologyPins"],
): readonly EngineSpec[] {
  return ENGINES.map((engine) => {
    if ((engine.id !== "mantis" && engine.id !== "vulnhunter") || engine.pin === undefined) return engine;
    const configured = pins?.[engine.id];
    if (typeof configured !== "string") return engine;
    if (!safeDisplayReference(configured)) return { ...engine, pin: null, pinTrusted: false };
    return { ...engine, pin: configured, pinTrusted: isCommitSha(configured) };
  });
}

export interface CurrentEngineRuntime {
  command: string | null;
  source: "external" | "on-demand";
  version: string | null;
  /** An explicit environment override owns command selection and is never replaced. */
  explicitOverride: boolean;
}

export interface EngineUpdateFetchResponse {
  ok: boolean;
  /** Native callers provide text so the service can bound JSON before parsing. */
  text?(): Promise<string>;
  /** Kept as a small test seam; production always uses bounded text parsing. */
  json?(): Promise<unknown>;
}

export type EngineUpdateFetch = (
  url: string,
  init: { headers: Record<string, string>; redirect: "error"; signal: AbortSignal },
) => Promise<EngineUpdateFetchResponse>;

export interface EngineUpdateExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  shell: false;
  windowsHide: true;
}

export interface EngineUpdateExecResult {
  stdout: string;
  stderr: string;
  /** Omitted test-seam results model execFile's successful default of zero. */
  exitCode?: number;
}

/** argv-only execution seam. Neither npm output nor child environment is exposed to callers. */
export type EngineUpdateExec = (
  binary: string,
  args: string[],
  options: EngineUpdateExecOptions,
) => Promise<EngineUpdateExecResult>;

export interface EngineUpdatesDependencies {
  /** Base CSB DATA_DIR; all mutable state lives below `${dataDir}/engine-updates`. */
  dataDir: string;
  currentRuntime(id: ManagedRuntimeId): Promise<CurrentEngineRuntime>;
  /** Acquires the database-backed no-scan lease and returns its release callback. */
  acquireMaintenance(): () => void;
  blockingReason(): "scan_active" | "update_in_progress" | null;
  /** Refreshes live command selection after a verified state switch. */
  onActivated(): void;
  /** Effective methodology pins from configuration; unsafe values are shown as unavailable. */
  methodologyPins?: Partial<Record<"mantis" | "vulnhunter", string>>;
  fetch?: EngineUpdateFetch;
  exec?: EngineUpdateExec;
  now?: () => Date;
}

export interface EngineUpdatesService {
  status(): Promise<EngineUpdatesResponse>;
  check(): Promise<EngineUpdatesResponse>;
  update(id: ManagedRuntimeId, expectedVersion: string): Promise<EngineUpdatesResponse>;
  rollback(id: ManagedRuntimeId): Promise<EngineUpdatesResponse>;
}

/** API-safe error: its public message is always its closed error code. */
export class EngineUpdateError extends Error {
  constructor(readonly code: EngineUpdateErrorCode) {
    super(code);
    this.name = "EngineUpdateError";
  }
}

export function createEngineUpdatesService(dependencies: EngineUpdatesDependencies): EngineUpdatesService {
  return new EngineUpdatesServiceImpl(dependencies);
}

class EngineUpdatesServiceImpl implements EngineUpdatesService {
  private busy: { id: ManagedRuntimeId; action: "update" | "rollback" } | null = null;
  private checkInFlight: Promise<EngineUpdatesResponse> | null = null;
  private readonly fetch: EngineUpdateFetch;
  private readonly exec: EngineUpdateExec;
  private readonly now: () => Date;
  private readonly engines: readonly EngineSpec[];

  constructor(private readonly dependencies: EngineUpdatesDependencies) {
    this.fetch = dependencies.fetch ?? nativeFetch;
    this.exec = dependencies.exec ?? executeEngineUpdateCommand;
    this.now = dependencies.now ?? (() => new Date());
    this.engines = engineSpecs(dependencies.methodologyPins);
  }

  async status(): Promise<EngineUpdatesResponse> {
    const state = this.readState();
    const [securityRuntime, codexRuntime] = await Promise.all([
      this.currentRuntime("codex-security"),
      this.currentRuntime("codex-cli"),
    ]);
    const items = this.engines.map((engine) => this.itemFor(engine, state.manifest, state.invalid, {
      "codex-security": securityRuntime,
      "codex-cli": codexRuntime,
    }));
    return {
      items,
      busy: this.busy === null ? null : { ...this.busy },
      blockedReason: this.blockedReason(),
      lastOperation: state.manifest?.lastOperation ?? null,
    };
  }

  check(): Promise<EngineUpdatesResponse> {
    if (this.checkInFlight !== null) return this.checkInFlight;
    const pending = this.checkOnce();
    this.checkInFlight = pending;
    void pending.finally(() => {
      if (this.checkInFlight === pending) this.checkInFlight = null;
    }).catch(() => undefined);
    return pending;
  }

  async update(id: ManagedRuntimeId, expectedVersion: string): Promise<EngineUpdatesResponse> {
    if (!isManagedRuntimeId(id)) throw new EngineUpdateError("state_invalid");
    if (!isStableVersion(expectedVersion)) throw new EngineUpdateError("version_changed");
    if (this.checkInFlight !== null) await this.checkInFlight;
    return this.mutate("update", id, expectedVersion, async () => {
      const manifest = this.requiredState();
      const runtime = await this.currentRuntime(id);
      if (runtime.explicitOverride) throw new EngineUpdateError("external_runtime");
      const active = manifest.runtimes[id]?.active ?? null;
      if (active !== null && !validateInstalledRuntime(this.dependencies.dataDir, id, active)) {
        throw new EngineUpdateError("state_invalid");
      }
      if (active?.version === expectedVersion) throw new EngineUpdateError("version_changed");
      const check = manifest.checks[id];
      if (!freshAvailableVersion(check, expectedVersion, this.now())) {
        throw new EngineUpdateError(check === undefined || !isFreshCheck(check, this.now())
          ? "check_required"
          : "version_changed");
      }

      const installed = await this.installExact(id, expectedVersion);
      const next = cloneManifest(manifest);
      next.runtimes[id] = {
        active: installed,
        previous: active,
      };
      next.lastOperation = operation(id, "update", "succeeded", expectedVersion, null, this.now());
      writeManagedRuntimeManifest(this.dependencies.dataDir, next);
      this.activate();
      return;
    });
  }

  async rollback(id: ManagedRuntimeId): Promise<EngineUpdatesResponse> {
    if (!isManagedRuntimeId(id)) throw new EngineUpdateError("state_invalid");
    if (this.checkInFlight !== null) await this.checkInFlight;
    return this.mutate("rollback", id, null, async () => {
      const manifest = this.requiredState();
      const runtime = await this.currentRuntime(id);
      if (runtime.explicitOverride) throw new EngineUpdateError("external_runtime");
      const runtimeState = manifest.runtimes[id];
      const active = runtimeState?.active ?? null;
      const previous = runtimeState?.previous ?? null;
      if (active === null || previous === null) throw new EngineUpdateError("rollback_unavailable");
      if (!await this.verifyManagedRuntime(id, active) || !await this.verifyManagedRuntime(id, previous)) {
        throw new EngineUpdateError("verification_failed");
      }
      const next = cloneManifest(manifest);
      next.runtimes[id] = { active: previous, previous: active };
      next.lastOperation = operation(id, "rollback", "succeeded", previous.version, null, this.now());
      writeManagedRuntimeManifest(this.dependencies.dataDir, next);
      this.activate();
      return;
    });
  }

  private async checkOnce(): Promise<EngineUpdatesResponse> {
    const initial = this.readState();
    if (initial.invalid) return this.status();
    const checkedAt = timestamp(this.now());
    const settled = await Promise.all(this.engines.map(async (engine) => {
      try {
        return [engine.id, {
          latestVersion: await this.latestVersion(engine),
          checkedAt,
          error: null,
        } satisfies EngineUpdateCheckRecord] as const;
      } catch {
        return [engine.id, {
          latestVersion: null,
          checkedAt,
          error: "registry_unavailable" as const,
        } satisfies EngineUpdateCheckRecord] as const;
      }
    }));
    this.commitChecks(settled);
    return this.status();
  }

  /**
   * Network reads intentionally happen outside the no-scan lease. The final
   * read/merge/write is synchronous and shares the database lease with runtime
   * activation, so another API process cannot erase a just-activated runtime.
   */
  private commitChecks(
    checks: readonly (readonly [EngineUpdateId, EngineUpdateCheckRecord])[],
  ): void {
    if (this.busy !== null) throw new EngineUpdateError("update_in_progress");
    const beforeLease = this.blockedReason();
    if (beforeLease !== null) throw new EngineUpdateError(beforeLease);
    let release: (() => void) | null = null;
    try {
      release = this.dependencies.acquireMaintenance();
      if (typeof release !== "function") throw new Error("invalid maintenance lease");
    } catch (error) {
      const code = errorCode(error, this.blockedReason() ?? "update_in_progress");
      throw new EngineUpdateError(code === "scan_active" ? "scan_active" : "update_in_progress");
    }
    try {
      if (this.busy !== null) throw new EngineUpdateError("update_in_progress");
      const current = this.requiredState();
      const next = cloneManifest(current);
      for (const [id, check] of checks) next.checks[id] = check;
      writeManagedRuntimeManifest(this.dependencies.dataDir, next);
    } finally {
      try { release(); } catch { /* DB cleanup failures do not expose local diagnostics */ }
    }
  }

  private async latestVersion(engine: EngineSpec): Promise<string> {
    const value = await this.fetchJson(engine.checkUrl);
    if (engine.packageId !== undefined) {
      if (!isPlainRecord(value) || !isStableVersion(value.latest)) throw new Error("invalid registry metadata");
      return value.latest;
    }
    if (!Array.isArray(value) || value.length < 1 || !isPlainRecord(value[0]) || !isCommitSha(value[0].sha)) {
      throw new Error("invalid GitHub metadata");
    }
    return value[0].sha.toLowerCase();
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new Error("request timed out"));
        }, ENGINE_UPDATE_REQUEST_TIMEOUT_MS);
      });
      const response = await Promise.race([
        this.fetch(url, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (!response.ok) throw new Error("non-success response");
      if (typeof response.text === "function") {
        const text = await Promise.race([response.text(), deadline]);
        if (Buffer.byteLength(text, "utf8") > FETCH_JSON_MAX_BYTES) throw new Error("response too large");
        return JSON.parse(text) as unknown;
      }
      if (typeof response.json === "function") {
        const value = await Promise.race([response.json(), deadline]);
        if (Buffer.byteLength(JSON.stringify(value), "utf8") > FETCH_JSON_MAX_BYTES) throw new Error("response too large");
        return value;
      }
      throw new Error("response body unavailable");
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  private async mutate(
    action: "update" | "rollback",
    id: ManagedRuntimeId,
    expectedVersion: string | null,
    operationBody: () => Promise<void>,
  ): Promise<EngineUpdatesResponse> {
    if (this.busy !== null) throw new EngineUpdateError("update_in_progress");
    const blocked = this.dependencies.blockingReason();
    if (blocked !== null) throw new EngineUpdateError(blocked);

    let release: (() => void) | null = null;
    try {
      release = this.dependencies.acquireMaintenance();
      if (typeof release !== "function") throw new Error("invalid maintenance lease");
    } catch {
      throw new EngineUpdateError("update_in_progress");
    }
    this.busy = { id, action };
    try {
      await operationBody();
    } catch (error) {
      const code = errorCode(error, action === "update" ? "install_failed" : "rollback_unavailable");
      this.recordFailure(id, action, expectedVersion, code);
      throw new EngineUpdateError(code);
    } finally {
      this.busy = null;
      try { release(); } catch { /* a failed release cannot expose the child operation */ }
    }
    return this.status();
  }

  private async installExact(id: ManagedRuntimeId, version: string): Promise<ManagedRuntimeRecord> {
    const destination = managedRuntimeDirectory(this.dependencies.dataDir, id, version);
    if (fs.existsSync(destination)) {
      const existing = runtimeRecord(id, version);
      if (!await this.verifyManagedRuntime(id, existing)) {
        throw new EngineUpdateError("verification_failed");
      }
      return existing;
    }

    const root = engineUpdatesDirectory(this.dependencies.dataDir);
    const stagingParent = path.join(root, ".staging");
    ensureDirectory(root);
    ensureDirectory(stagingParent);
    ensureDirectory(path.dirname(destination));
    const staging = fs.mkdtempSync(path.join(stagingParent, `${id}-${version}-`));
    try {
      const result = await this.exec("npm", [
        "--prefix", staging,
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        `--registry=${NPM_REGISTRY}`,
        `${packageName(id)}@${version}`,
      ], executionOptions(staging));
      if (exitCode(result) !== 0) throw new EngineUpdateError("install_failed");
      if (!validStagedPackage(staging, id, version)) throw new EngineUpdateError("verification_failed");

      const entry = path.join(staging, ...entryParts(id));
      const versionProbe = await this.exec(entry, ["--version"], executionOptions(staging));
      const contracts = await this.verifyCliContracts(id, entry, staging);
      if (exitCode(versionProbe) !== 0 || !hasVersion(versionProbe.stdout, version) || !contracts) {
        throw new EngineUpdateError("verification_failed");
      }
      if (fs.existsSync(destination)) {
        // Do not replace a path that appeared concurrently; it must validate independently.
        const existing = runtimeRecord(id, version);
        if (!await this.verifyManagedRuntime(id, existing)) {
          throw new EngineUpdateError("verification_failed");
        }
        return existing;
      }
      // Each installation has its own npm cache. It is never reused by the
      // selected executable or a future staging directory, so do not retain
      // a second copy of all downloaded packages with every engine version.
      safeRemoveTaskStaging(path.join(staging, ".npm-cache"), staging);
      fs.renameSync(staging, destination);
      return runtimeRecord(id, version);
    } catch (error) {
      if (error instanceof EngineUpdateError) throw error;
      throw new EngineUpdateError("install_failed");
    } finally {
      safeRemoveTaskStaging(staging, stagingParent);
    }
  }

  private async verifyCliContracts(id: ManagedRuntimeId, entry: string, cwd: string): Promise<boolean> {
    if (id === "codex-security") {
      const scanHelp = await this.exec(entry, ["scan", "--help"], executionOptions(cwd));
      if (exitCode(scanHelp) !== 0 || !hasAllOptions(scanHelp, [
        "--auth", "--model", "--mode", "--output-dir",
      ])) return false;
      return this.verifyCodexSecurityJsonContract(entry, cwd);
    }
    const [appServerHelp, execHelp] = await Promise.all([
      this.exec(entry, ["app-server", "--help"], executionOptions(cwd)),
      this.exec(entry, ["exec", "--help"], executionOptions(cwd)),
    ]);
    return exitCode(appServerHelp) === 0 && hasAllOptions(appServerHelp, ["--stdio"]) &&
      exitCode(execHelp) === 0 && hasAllOptions(execHelp, [
        "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      ]);
  }

  private async verifyManagedRuntime(id: ManagedRuntimeId, record: ManagedRuntimeRecord): Promise<boolean> {
    if (!validateInstalledRuntime(this.dependencies.dataDir, id, record)) return false;
    const runtimeRoot = managedRuntimeDirectory(this.dependencies.dataDir, id, record.version);
    const entry = managedRuntimeEntryPath(this.dependencies.dataDir, id, record.version);
    try {
      const versionProbe = await this.exec(entry, ["--version"], executionOptions(runtimeRoot));
      return exitCode(versionProbe) === 0 && hasVersion(versionProbe.stdout, record.version) &&
        await this.verifyCliContracts(id, entry, runtimeRoot);
    } catch {
      return false;
    }
  }

  /**
   * The current official CLI accepts `--json` as an inherited global option but
   * does not print it in `scan --help`. A local dry run validates the real argv
   * contract without loading host credentials or starting a model request.
   */
  private async verifyCodexSecurityJsonContract(entry: string, cwd: string): Promise<boolean> {
    // DATA_DIR normally lives inside Sentinel's Git checkout. Upstream rejects
    // outputs anywhere inside a worktree, including siblings of this fixture.
    const probeParent = os.tmpdir();
    const probeRoot = fs.mkdtempSync(path.join(probeParent, ".sentinel-contract-probe-"));
    const repository = path.join(probeRoot, "repository");
    const outputDir = path.join(probeRoot, "output");
    try {
      fs.mkdirSync(repository, { recursive: true, mode: 0o700 });
      const result = await this.exec(entry, [
        "scan", repository,
        "--auth", "auto",
        "--model", "gpt-5.6-sol",
        "--mode", "standard",
        "--output-dir", outputDir,
        "--json",
        "--dry-run",
      ], executionOptions(cwd));
      return exitCode(result) === 0;
    } catch {
      return false;
    } finally {
      safeRemoveContractProbe(probeRoot, probeParent);
    }
  }

  private itemFor(
    engine: EngineSpec,
    manifest: ManagedRuntimeManifest | null,
    stateInvalid: boolean,
    fallbacks: Record<ManagedRuntimeId, CurrentEngineRuntime>,
  ): EngineUpdateItem {
    const check = manifest?.checks[engine.id];
    if (engine.packageId === undefined) {
      const current = engine.pin ?? null;
      const fresh = check !== undefined && isFreshCheck(check, this.now());
      const unavailable = check?.error !== null && check?.error !== undefined;
      const pinInvalid = engine.pinTrusted === false;
      return {
        id: engine.id,
        name: engine.name,
        kind: engine.kind,
        source: "bundled",
        currentVersion: current,
        latestVersion: check?.latestVersion ?? null,
        previousVersion: null,
        status: unavailable || pinInvalid ? "unavailable" : !fresh ? "unchecked" : check!.latestVersion === current ? "current" : "review_required",
        checkedAt: check?.checkedAt ?? null,
        error: unavailable ? check!.error : pinInvalid ? "state_invalid" : "bundled_engine",
        canUpdate: false,
        canRollback: false,
        sourceUrl: engine.sourceUrl,
      };
    }

    const id = engine.packageId;
    const fallback = fallbacks[id];
    const state = manifest?.runtimes[id];
    const active = state?.active ?? null;
    const managedValid = active !== null && validateInstalledRuntime(this.dependencies.dataDir, id, active);
    const selectedManaged = !fallback.explicitOverride && managedValid ? active : null;
    const source = selectedManaged !== null ? "managed" : fallback.source;
    const currentVersion = selectedManaged?.version ?? fallback.version;
    const previous = state?.previous ?? null;
    const previousValid = previous !== null && validateInstalledRuntime(this.dependencies.dataDir, id, previous);
    const fresh = check !== undefined && isFreshCheck(check, this.now());
    const unavailable = check?.error !== null && check?.error !== undefined;
    const hasBrokenStoredState = stateInvalid || (active !== null && !managedValid && !fallback.explicitOverride);
    const error: EngineUpdateErrorCode | null = hasBrokenStoredState
      ? "state_invalid"
      : fallback.explicitOverride
        ? "external_runtime"
        : unavailable
          ? check!.error
          : null;
    return {
      id,
      name: engine.name,
      kind: engine.kind,
      source,
      currentVersion,
      latestVersion: check?.latestVersion ?? null,
      previousVersion: selectedManaged !== null && previousValid ? previous!.version : null,
      status: unavailable ? "unavailable" : !fresh ? "unchecked" : check!.latestVersion === currentVersion ? "current" : "available",
      checkedAt: check?.checkedAt ?? null,
      error,
      canUpdate: !hasBrokenStoredState && !fallback.explicitOverride && fresh && !unavailable &&
        isStableVersion(check?.latestVersion) && (check!.latestVersion !== currentVersion || source !== "managed"),
      canRollback: selectedManaged !== null && previousValid && !fallback.explicitOverride,
      sourceUrl: engine.sourceUrl,
    };
  }

  private readState(): { manifest: ManagedRuntimeManifest | null; invalid: boolean } {
    try {
      return { manifest: readManagedRuntimeManifest(this.dependencies.dataDir), invalid: false };
    } catch {
      return { manifest: null, invalid: true };
    }
  }

  private requiredState(): ManagedRuntimeManifest {
    try {
      return readManagedRuntimeManifest(this.dependencies.dataDir);
    } catch {
      throw new EngineUpdateError("state_invalid");
    }
  }

  private async currentRuntime(id: ManagedRuntimeId): Promise<CurrentEngineRuntime> {
    try {
      const runtime = await this.dependencies.currentRuntime(id);
      if ((runtime.source !== "external" && runtime.source !== "on-demand") ||
          typeof runtime.command !== "string" && runtime.command !== null ||
          typeof runtime.version !== "string" && runtime.version !== null ||
          typeof runtime.explicitOverride !== "boolean") {
        throw new Error("invalid runtime");
      }
      return runtime;
    } catch {
      return { command: null, source: "on-demand", version: null, explicitOverride: false };
    }
  }

  private blockedReason(): "scan_active" | "update_in_progress" | null {
    if (this.busy !== null) return "update_in_progress";
    try { return this.dependencies.blockingReason(); } catch { return "update_in_progress"; }
  }

  private recordFailure(
    id: ManagedRuntimeId,
    action: "update" | "rollback",
    version: string | null,
    error: EngineUpdateErrorCode,
  ): void {
    try {
      const manifest = this.requiredState();
      manifest.lastOperation = operation(id, action, "failed", isStableVersion(version) ? version : null, error, this.now());
      writeManagedRuntimeManifest(this.dependencies.dataDir, manifest);
    } catch {
      // Do not replace a malformed manifest just to preserve diagnostics.
    }
  }

  private activate(): void {
    try { this.dependencies.onActivated(); } catch { /* persisted selection remains authoritative */ }
  }
}

function freshAvailableVersion(
  check: EngineUpdateCheckRecord | undefined,
  expectedVersion: string,
  now: Date,
): boolean {
  return check !== undefined && check.error === null && check.latestVersion === expectedVersion &&
    isStableVersion(check.latestVersion) && isFreshCheck(check, now);
}

function isFreshCheck(check: EngineUpdateCheckRecord, now: Date): boolean {
  const checkedAt = Date.parse(check.checkedAt);
  if (!Number.isFinite(checkedAt)) return false;
  const age = now.getTime() - checkedAt;
  return age >= 0 && age <= ENGINE_UPDATE_CHECK_TTL_MS;
}

function operation(
  id: ManagedRuntimeId,
  action: "update" | "rollback",
  status: "succeeded" | "failed",
  version: string | null,
  error: EngineUpdateErrorCode | null,
  now: Date,
): EngineUpdateLastOperation {
  return { id, action, status, version: isStableVersion(version) ? version : null, error, at: timestamp(now) };
}

function timestamp(value: Date): string {
  const time = value.getTime();
  return Number.isFinite(time) ? value.toISOString() : new Date(0).toISOString();
}

function errorCode(error: unknown, fallback: EngineUpdateErrorCode): EngineUpdateErrorCode {
  if (error instanceof EngineUpdateError) return error.code;
  if (error instanceof ManagedRuntimeStoreError) return "state_invalid";
  return fallback;
}

function cloneManifest(manifest: ManagedRuntimeManifest): ManagedRuntimeManifest {
  return {
    schemaVersion: 1,
    runtimes: Object.fromEntries(Object.entries(manifest.runtimes).map(([id, value]) => [id, value === undefined ? undefined : {
      active: value.active === null ? null : { ...value.active },
      previous: value.previous === null ? null : { ...value.previous },
    }])) as ManagedRuntimeManifest["runtimes"],
    checks: Object.fromEntries(Object.entries(manifest.checks).map(([id, value]) => [id, value === undefined ? undefined : { ...value }])) as ManagedRuntimeManifest["checks"],
    lastOperation: manifest.lastOperation === null ? null : { ...manifest.lastOperation },
  };
}

function executionOptions(cwd: string): EngineUpdateExecOptions {
  const home = path.join(cwd, ".home");
  ensureDirectory(home);
  const userConfig = path.join(home, "npmrc");
  const globalConfig = path.join(home, "global-npmrc");
  writeEmptyPrivateFile(userConfig);
  writeEmptyPrivateFile(globalConfig);
  return {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_cache: path.join(cwd, ".npm-cache"),
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      NPM_CONFIG_REGISTRY: NPM_REGISTRY,
      CI: "1",
      NO_UPDATE_NOTIFIER: "1",
    },
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: EXEC_OUTPUT_MAX_BYTES,
    shell: false,
    windowsHide: true,
  };
}

function validStagedPackage(root: string, id: ManagedRuntimeId, version: string): boolean {
  try {
    const packagePath = path.join(root, "node_modules", packageName(id), "package.json");
    const entry = path.join(root, ...entryParts(id));
    if (!regularFileWithin(root, ["node_modules", ...packageName(id).split("/"), "package.json"]) ||
        !regularFileWithin(root, entryParts(id)) || fs.lstatSync(packagePath).size > 64 * 1024) return false;
    const packageInfo = JSON.parse(fs.readFileSync(packagePath, "utf8")) as unknown;
    return isPlainRecord(packageInfo) && packageInfo.name === packageName(id) && packageInfo.version === version;
  } catch {
    return false;
  }
}

function entryParts(id: ManagedRuntimeId): string[] {
  return id === "codex-security"
    ? ["node_modules", "@openai", "codex-security", "bin", "codex-security.mjs"]
    : ["node_modules", "@openai", "codex", "bin", "codex.js"];
}

function hasVersion(output: string, expected: string): boolean {
  const source = output.slice(0, 4_096);
  const at = source.indexOf(expected);
  if (at < 0) return false;
  const before = source[at - 1] ?? "";
  const after = source[at + expected.length] ?? "";
  return !/\d/.test(before) && !/\d/.test(after);
}

function hasAllOptions(result: EngineUpdateExecResult, options: readonly string[]): boolean {
  const output = `${result.stdout}\n${result.stderr}`.slice(0, 32 * 1024);
  return options.every((option) => output.includes(option));
}

function exitCode(result: EngineUpdateExecResult): number {
  return typeof result.exitCode === "number" ? result.exitCode : 0;
}

function ensureDirectory(directory: string): void {
  const existing = tryLstat(directory);
  if (existing !== null) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new EngineUpdateError("state_invalid");
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const made = tryLstat(directory);
  if (made === null || !made.isDirectory() || made.isSymbolicLink()) throw new EngineUpdateError("state_invalid");
}

function writeEmptyPrivateFile(file: string): void {
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function safeRemoveTaskStaging(staging: string, stagingParent: string): void {
  try {
    const relative = path.relative(stagingParent, staging);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return;
    const stat = fs.lstatSync(staging);
    if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(staging, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // A failed cleanup never touches an unknown target and does not affect activation.
  }
}

function safeRemoveContractProbe(probe: string, probeParent: string): void {
  try {
    const relative = path.relative(probeParent, probe);
    if (!relative.startsWith(".sentinel-contract-probe-") || relative.includes(path.sep) || path.isAbsolute(relative)) return;
    const stat = fs.lstatSync(probe);
    if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(probe, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // A failed cleanup never follows a symlink or reaches outside the managed version root.
  }
}

function regularFileWithin(root: string, parts: readonly string[]): boolean {
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    const stat = tryLstat(current);
    if (stat === null || stat.isSymbolicLink()) return false;
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false;
  }
  return true;
}

function tryLstat(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); } catch { return null; }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

function safeDisplayReference(value: string): boolean {
  return value.length > 0 && value.length <= 100 && /^[\x21-\x7e]+$/.test(value);
}

async function nativeFetch(
  url: string,
  init: { headers: Record<string, string>; redirect: "error"; signal: AbortSignal },
): Promise<EngineUpdateFetchResponse> {
  return fetch(url, init);
}

/**
 * Runs a fixed local argv command with a bounded termination path. On POSIX,
 * detached mode gives the installer its own process group so a hung wrapper
 * cannot leave a child holding stdout/stderr and the maintenance lease open.
 */
export async function executeEngineUpdateCommand(
  binary: string,
  args: string[],
  options: EngineUpdateExecOptions,
): Promise<EngineUpdateExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const next = String(chunk);
      if (target === "stdout") stdout = boundedAppend(stdout, next, options.maxBuffer);
      else stderr = boundedAppend(stderr, next, options.maxBuffer);
    };
    const onStdout = (chunk: Buffer | string) => append("stdout", chunk);
    const onStderr = (chunk: Buffer | string) => append("stderr", chunk);
    const onChildError = (error: Error) => finish(error);
    const onChildClose = (code: number | null) => finish(timedOut ? timedOutError() : { exitCode: code ?? 1 });
    const cleanUp = () => {
      if (termTimer !== undefined) clearTimeout(termTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (finalTimer !== undefined) clearTimeout(finalTimer);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("error", onChildError);
      child.removeListener("close", onChildClose);
    };
    const finish = (result: { exitCode: number } | Error) => {
      if (settled) return;
      settled = true;
      cleanUp();
      if (result instanceof Error) reject(result);
      else resolve({ stdout, stderr, exitCode: result.exitCode });
    };
    const terminateGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* process may have exited between checks */ }
      }
    };
    const timedOutError = () => Object.assign(new Error("engine update command timed out"), {
      code: "engine_update_timeout",
    });
    const beginTimeout = () => {
      if (settled) return;
      timedOut = true;
      terminateGroup("SIGTERM");
      killTimer = setTimeout(() => {
        if (settled) return;
        terminateGroup("SIGKILL");
        finalTimer = setTimeout(() => {
          if (settled) return;
          // A descendant can retain a stdio pipe after its parent exits. Do
          // not wait indefinitely for `close` once its process group was killed.
          try { child.stdout.destroy(); } catch { /* already closed */ }
          try { child.stderr.destroy(); } catch { /* already closed */ }
          finish(timedOutError());
        }, EXEC_FINAL_GRACE_MS);
      }, EXEC_TERM_GRACE_MS);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    termTimer = setTimeout(beginTimeout, options.timeout);
    child.once("error", onChildError);
    child.once("close", onChildClose);
  });
}

function boundedAppend(current: string, next: string, limit: number): string {
  const remaining = Math.max(0, limit - Buffer.byteLength(current, "utf8"));
  if (remaining === 0) return current;
  const bytes = Buffer.from(next, "utf8");
  return `${current}${bytes.subarray(0, remaining).toString("utf8")}`;
}
