import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  MANTIS_HTTP_WORKER_ENTRY,
  MANTIS_LOCAL_WORKER_ENTRY,
  MANTIS_WORKER_ENTRY,
  PORTABLE_CODEX_SECURITY_WORKER_ENTRY,
  RUNS_DIR,
  VULNHUNTER_WORKER_ENTRY,
} from "./config.js";

const PROCESS_IDENTITY_VERSION = 1;
const PROCESS_IDENTITY_PREFIX = "process-identity-";
const COMMAND_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const KNOWN_WORKER_CONFIGS = [
  [MANTIS_WORKER_ENTRY, "mantis-run.json"],
  [MANTIS_HTTP_WORKER_ENTRY, "mantis-http-run.json"],
  [MANTIS_LOCAL_WORKER_ENTRY, "mantis-local-run.json"],
  [PORTABLE_CODEX_SECURITY_WORKER_ENTRY, "portable-codex-security-run.json"],
  [VULNHUNTER_WORKER_ENTRY, "vulnhunter-run.json"],
] as const;

export type ProcessSignal = "SIGTERM" | "SIGKILL";

/**
 * A process identity survives an API restart without storing its command line,
 * which can contain credentials. The command is hashed and re-read before use.
 */
export interface ProcessIdentity {
  version: typeof PROCESS_IDENTITY_VERSION;
  pid: number;
  startTime: string;
  commandFingerprint: string;
}

export interface ProcessSnapshot {
  pid: number;
  startTime: string;
  command: string;
}

export interface ProcessIdentityRuntime {
  currentPid: number;
  findPidsByPattern(pattern: string): number[];
  inspect(pid: number): ProcessSnapshot | null;
  signal(pid: number, signal: ProcessSignal): void;
}

export interface ProcessIdentityService {
  captureProcessIdentity(pid: number, scanDir: string): ProcessIdentity | null;
  findProcessIdentitiesForScanDir(scanDir: string): ProcessIdentity[];
  isProcessIdentityCurrent(identity: ProcessIdentity, scanDir: string): boolean;
  signalVerifiedProcess(
    identity: ProcessIdentity,
    scanDir: string,
    signal: ProcessSignal,
  ): boolean;
}

/**
 * Escape an absolute path for pgrep's POSIX extended regular expression.
 * This is intentionally not shell escaping: execFileSync receives an argv.
 */
export function escapePosixExtendedRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

export function processIdentityPath(scanDir: string): string {
  const key = createHash("sha256").update(path.resolve(scanDir)).digest("hex");
  return path.join(RUNS_DIR, `${PROCESS_IDENTITY_PREFIX}${key}.json`);
}

/** Persisted separately from the run row to avoid accepting a bare PID after restart. */
export function persistProcessIdentity(scanDir: string, identity: ProcessIdentity): boolean {
  if (!isProcessIdentity(identity)) return false;

  const target = processIdentityPath(scanDir);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify(identity)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // best effort cleanup only
    }
    return false;
  }
}

export function readProcessIdentity(scanDir: string): ProcessIdentity | null {
  try {
    const candidate: unknown = JSON.parse(fs.readFileSync(processIdentityPath(scanDir), "utf8"));
    return isProcessIdentity(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function removeProcessIdentity(scanDir: string): void {
  try {
    fs.rmSync(processIdentityPath(scanDir), { force: true });
  } catch {
    // A stale sidecar must never make artifact deletion fail.
  }
}

export function createProcessIdentityService(
  runtime: ProcessIdentityRuntime = systemRuntime,
): ProcessIdentityService {
  function captureProcessIdentity(pid: number, scanDir: string): ProcessIdentity | null {
    const absoluteScanDir = absoluteScanDirFor(scanDir);
    if (!absoluteScanDir || !isSafePid(pid)) return null;

    const snapshot = runtime.inspect(pid);
    if (!snapshot || snapshot.pid !== pid || !commandReferencesScanDir(snapshot.command, absoluteScanDir)) {
      return null;
    }

    return {
      version: PROCESS_IDENTITY_VERSION,
      pid,
      startTime: snapshot.startTime,
      commandFingerprint: commandFingerprint(snapshot.command),
    };
  }

  function isProcessIdentityCurrent(identity: ProcessIdentity, scanDir: string): boolean {
    const absoluteScanDir = absoluteScanDirFor(scanDir);
    if (!absoluteScanDir || !isProcessIdentity(identity)) return false;

    const snapshot = runtime.inspect(identity.pid);
    return Boolean(
      snapshot
      && snapshot.pid === identity.pid
      && snapshot.startTime === identity.startTime
      && commandFingerprint(snapshot.command) === identity.commandFingerprint
      && commandReferencesScanDir(snapshot.command, absoluteScanDir),
    );
  }

  function findProcessIdentitiesForScanDir(scanDir: string): ProcessIdentity[] {
    const absoluteScanDir = absoluteScanDirFor(scanDir);
    if (!absoluteScanDir) return [];

    let candidates: number[];
    try {
      candidates = runtime.findPidsByPattern(escapePosixExtendedRegex(absoluteScanDir));
    } catch {
      return [];
    }

    const identities = new Map<string, ProcessIdentity>();
    for (const pid of candidates) {
      if (!isSafePid(pid) || pid === runtime.currentPid) continue;
      const identity = captureProcessIdentity(pid, absoluteScanDir);
      const snapshot = runtime.inspect(pid);
      if (!identity || !snapshot || !isRecognizedScannerInvocation(snapshot.command, absoluteScanDir)) {
        continue;
      }
      identities.set(identityKey(identity), identity);
    }
    return [...identities.values()];
  }

  function signalVerifiedProcess(
    identity: ProcessIdentity,
    scanDir: string,
    signal: ProcessSignal,
  ): boolean {
    // This validation intentionally happens on every TERM and every delayed KILL.
    if (!isProcessIdentityCurrent(identity, scanDir)) return false;
    try {
      runtime.signal(identity.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  return {
    captureProcessIdentity,
    findProcessIdentitiesForScanDir,
    isProcessIdentityCurrent,
    signalVerifiedProcess,
  };
}

function absoluteScanDirFor(scanDir: string): string | null {
  if (!scanDir.trim() || !path.isAbsolute(scanDir)) return null;
  const absolute = path.resolve(scanDir);
  return absolute === path.parse(absolute).root ? null : absolute;
}

function commandReferencesScanDir(command: string, absoluteScanDir: string): boolean {
  return new RegExp(
    `(?:^|[\\0\\s="'])${escapePosixExtendedRegex(absoluteScanDir)}(?=$|[\\0\\s/"'])`,
  ).test(command);
}

function commandHasExactPathArgument(command: string, expectedPath: string): boolean {
  return new RegExp(
    `(?:^|[\\0\\s="'])${escapePosixExtendedRegex(expectedPath)}(?=$|[\\0\\s"'])`,
  ).test(command);
}

/**
 * Discovery has no launch authority. It therefore accepts only the local
 * worker entry plus its scan-private configuration, or the official Codex
 * Security CLI's `scan --output-dir <scanDir>` invocation. A direct child
 * captured at launch may be a short-lived wrapper and follows the narrower
 * PID/start-time/command identity path above instead.
 */
function isRecognizedScannerInvocation(command: string, absoluteScanDir: string): boolean {
  const invocation = parseProcessInvocation(command);
  if (!invocation || hasInlineProgram(invocation.arguments)) return false;

  const knownWorker = KNOWN_WORKER_CONFIGS.some(([entry, configName]) => {
    const workerEntry = path.resolve(entry);
    const configPath = path.join(absoluteScanDir, configName);
    return invocationRunsWorker(invocation.arguments, workerEntry)
      && invocationRunsWorkerConfig(invocation, workerEntry, configPath);
  });
  if (knownWorker) return true;

  return invocationRunsOfficialCodexSecurity(invocation.arguments)
    && invocationHasExactArgument(invocation, "scan")
    && hasFlagValue(invocation, "--output-dir", absoluteScanDir);
}

interface ProcessInvocation {
  arguments: readonly string[];
  /** Linux /proc cmdline gives the exact NUL-delimited argv. */
  exactArguments: boolean;
}

function parseProcessInvocation(command: string): ProcessInvocation | null {
  if (command.includes("\0")) {
    const arguments_ = command.split("\0");
    if (arguments_[arguments_.length - 1] === "") arguments_.pop();
    return arguments_.length > 0 && arguments_[0] ? { arguments: arguments_, exactArguments: true } : null;
  }

  const arguments_ = parsePsCommand(command);
  return arguments_ && arguments_.length > 0 && arguments_[0]
    ? { arguments: arguments_, exactArguments: false }
    : null;
}

/**
 * macOS exposes a display command through ps rather than argv. This is only a
 * conservative fallback; Linux discovery uses the exact NUL-delimited argv.
 */
function parsePsCommand(command: string): string[] | null {
  const arguments_: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) arguments_.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped || quote) return null;
  if (current) arguments_.push(current);
  return arguments_;
}

function invocationHasExactArgument(invocation: ProcessInvocation, expected: string): boolean {
  if (invocation.exactArguments) return invocation.arguments.includes(expected);
  return commandHasExactPathArgument(invocation.arguments.join(" "), expected);
}

function hasFlagValue(invocation: ProcessInvocation, flag: string, value: string): boolean {
  const flagIndex = invocation.arguments.indexOf(flag);
  return flagIndex >= 0 && invocation.arguments[flagIndex + 1] === value;
}

function invocationRunsWorkerConfig(
  invocation: ProcessInvocation,
  workerEntry: string,
  configPath: string,
): boolean {
  const entryIndex = invocation.arguments.indexOf(workerEntry);
  // On Linux these are exact argv elements from /proc/<pid>/cmdline. Keeping
  // the configuration immediately after the entry mirrors every local launch
  // and prevents a different script's free-form argument from qualifying.
  return entryIndex >= 1 && invocation.arguments[entryIndex + 1] === configPath;
}

function hasInlineProgram(arguments_: readonly string[]): boolean {
  return arguments_.some((argument) =>
    argument === "-e" || argument === "--eval" || argument.startsWith("--eval=") ||
    argument === "-p" || argument === "--print" || argument.startsWith("--print=") ||
    argument === "-c" || argument.startsWith("-c"),
  );
}

function invocationRunsWorker(arguments_: readonly string[], workerEntry: string): boolean {
  const executable = executableName(arguments_[0]!);
  const entryIndex = arguments_.indexOf(workerEntry);
  if (entryIndex < 1) return false;

  if (executable === "tsx") return entryIndex === 1;
  if (isPythonRuntime(executable) || executable === "bun") {
    return entryIndex === 1 || (arguments_[1] === "-u" && entryIndex === 2);
  }
  if (executable === "deno") return arguments_[1] === "run" && entryIndex === 2;
  if (!isNodeRuntime(executable)) return false;

  const prefix = arguments_.slice(1, entryIndex);
  return nodePrefixRunsWorker(prefix);
}

function nodePrefixRunsWorker(prefix: readonly string[]): boolean {
  if (prefix.length === 0) return true;
  // `tsx`'s shell shim execs Node with this CLI module. Node's supported
  // loader forms keep the worker entry as the first script operand.
  if (prefix.length === 1 && isTsxCliModule(prefix[0]!)) return true;
  if (prefix.length === 2 && (prefix[0] === "--import" || prefix[0] === "--loader") && prefix[1] === "tsx") {
    return true;
  }
  return false;
}

function invocationRunsOfficialCodexSecurity(arguments_: readonly string[]): boolean {
  const executable = executableName(arguments_[0]!);
  if (executable === "codex-security" || isCodexSecurityPackageEntry(arguments_[0]!)) return true;
  if (executable === "npx" || executable === "npm") {
    return arguments_.includes("@openai/codex-security");
  }
  return isNodeRuntime(executable)
    && (isCodexSecurityPackageEntry(arguments_[1] ?? "") ||
      (isNpxCliModule(arguments_[1] ?? "") && arguments_.includes("@openai/codex-security")));
}

// npm's executable entry uses a Node shebang. Both the private installer and
// npx can therefore appear as `node <package>/bin/codex-security.mjs` in ps.
function isCodexSecurityPackageEntry(value: string): boolean {
  return path.isAbsolute(value) && value.replace(/\\/g, "/")
    .endsWith("/node_modules/@openai/codex-security/bin/codex-security.mjs");
}

function executableName(value: string): string {
  return path.basename(value).toLowerCase().replace(/\.exe$/, "");
}

function isNodeRuntime(executable: string): boolean {
  return executable === "node" || executable === "nodejs";
}

function isPythonRuntime(executable: string): boolean {
  return executable === "mantispython" || /^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/.test(executable);
}

function isTsxCliModule(value: string): boolean {
  return /(?:^|\/)tsx(?:\/dist)?\/cli\.(?:m?js|cjs)$/.test(value.replace(/\\/g, "/"));
}

function isNpxCliModule(value: string): boolean {
  return /(?:^|\/)(?:npx|npm)-cli\.js$/.test(value.replace(/\\/g, "/"));
}

function commandFingerprint(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.startTime}:${identity.commandFingerprint}`;
}

function isSafePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function isProcessIdentity(candidate: unknown): candidate is ProcessIdentity {
  if (!candidate || typeof candidate !== "object") return false;
  const identity = candidate as Partial<ProcessIdentity>;
  return identity.version === PROCESS_IDENTITY_VERSION
    && isSafePid(identity.pid)
    && typeof identity.startTime === "string"
    && identity.startTime.length > 0
    && identity.startTime.length <= 512
    && typeof identity.commandFingerprint === "string"
    && COMMAND_FINGERPRINT_PATTERN.test(identity.commandFingerprint);
}

const systemRuntime: ProcessIdentityRuntime = {
  currentPid: process.pid,
  findPidsByPattern(pattern) {
    try {
      const output = execFileSync("pgrep", ["-f", pattern], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      });
      return String(output)
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter(isSafePid);
    } catch {
      return [];
    }
  },
  inspect(pid) {
    if (!isSafePid(pid)) return null;
    if (process.platform === "linux") {
      const linuxSnapshot = inspectLinuxProcess(pid);
      if (linuxSnapshot) return linuxSnapshot;
    }
    return inspectProcessWithPs(pid);
  },
  signal(pid, signal) {
    process.kill(pid, signal);
  },
};

function inspectLinuxProcess(pid: number): ProcessSnapshot | null {
  try {
    const statPath = `/proc/${pid}/stat`;
    const startTicks = linuxStartTicks(fs.readFileSync(statPath, "utf8"));
    if (!startTicks) return null;

    const command = fs.readFileSync(`/proc/${pid}/cmdline`)
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .join("\0");
    if (!command) return null;
    // Read the start marker again so `/proc/<pid>` cannot combine the old
    // process start time with a reused PID's command line.
    if (linuxStartTicks(fs.readFileSync(statPath, "utf8")) !== startTicks) return null;

    let bootId = "unknown-boot";
    try {
      bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || bootId;
    } catch {
      // The start tick remains useful when a restricted procfs hides boot_id.
    }
    return { pid, startTime: `linux:${bootId}:${startTicks}`, command };
  } catch {
    return null;
  }
}

function linuxStartTicks(stat: string): string | null {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  // Field 3 starts after the executable name; starttime is field 22.
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  const startTicks = fields[19];
  return startTicks && /^\d+$/.test(startTicks) ? startTicks : null;
}

function inspectProcessWithPs(pid: number): ProcessSnapshot | null {
  try {
    const options = {
      encoding: "utf8" as const,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      shell: false,
    };
    const startTime = String(execFileSync("ps", ["-p", String(pid), "-o", "lstart="], options)).trim();
    const command = String(execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], options)).trim();
    const confirmedStartTime = String(execFileSync("ps", ["-p", String(pid), "-o", "lstart="], options)).trim();
    return startTime && startTime === confirmedStartTime && command
      ? { pid, startTime: `ps:${startTime}`, command }
      : null;
  } catch {
    return null;
  }
}

const defaultService = createProcessIdentityService();

export const captureProcessIdentity = defaultService.captureProcessIdentity;
export const findProcessIdentitiesForScanDir = defaultService.findProcessIdentitiesForScanDir;
export const isProcessIdentityCurrent = defaultService.isProcessIdentityCurrent;
export const signalVerifiedProcess = defaultService.signalVerifiedProcess;
