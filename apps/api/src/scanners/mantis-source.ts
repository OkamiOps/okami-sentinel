import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { MANTIS_STAGES } from "./mantis-http-runner.js";

const EXACT_GIT_REF = /^[a-f0-9]{40}$/i;
const MAX_GIT_OUTPUT_BYTES = 128 * 1024;
const MAX_SKILL_BYTES = 64 * 1024;
const GIT_KILL_GRACE_MS = 250;

export type MantisSourceErrorCode = "source_cancelled" | "source_invalid";

/** Closed source-preflight errors. Git diagnostics are never surfaced to a scan log. */
export class MantisSourceError extends Error {
  constructor(readonly code: MantisSourceErrorCode) {
    super(code);
    this.name = "MantisSourceError";
  }
}

export interface MantisSourceCommandOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  shell: false;
  windowsHide: true;
  signal: AbortSignal;
}

/** Test seam; production uses `execFile` with an argv array and no shell. */
export type MantisSourceCommand = (
  binary: "git",
  args: string[],
  options: MantisSourceCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface ResolveMantisLocalSourceInput {
  repositoryUrl: string;
  /** An immutable full Git object id, not a branch, tag, or abbreviated ref. */
  ref: string;
  cacheDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  command?: MantisSourceCommand;
}

export interface ResolvedMantisLocalSource {
  /** Private server-side cache root that the worker re-derives its checkout from. */
  sourceCacheDir: string;
  /** Private checkout that contains the nine verified Mantis stage skills. */
  skillsRoot: string;
  ref: string;
}

/**
 * Resolves the reviewed upstream Mantis skills before any scan output/config
 * or child worker exists. A cached checkout is usable only if `HEAD` is the
 * exact configured object id and every expected skill file is present.
 */
export async function resolveMantisLocalSource(
  input: ResolveMantisLocalSourceInput,
): Promise<ResolvedMantisLocalSource> {
  const signal = input.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  const ref = exactRef(input.ref);
  const repositoryUrl = validRepositoryUrl(input.repositoryUrl);
  const timeout = boundedTimeout(input.timeoutMs);
  const command = input.command ?? nativeGit;
  const cacheDir = path.resolve(input.cacheDir);
  ensurePrivateDirectory(cacheDir);

  const skillsRoot = path.join(cacheDir, ref.slice(0, 12));
  if (!fs.existsSync(skillsRoot)) {
    await git(command, [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      repositoryUrl,
      skillsRoot,
    ], cacheDir, timeout, signal);
    ensurePrivateDirectory(skillsRoot);
    await git(command, ["-C", skillsRoot, "checkout", "--detach", ref], cacheDir, timeout, signal);
  }

  ensurePrivateDirectory(skillsRoot);
  const head = (await git(command, ["-C", skillsRoot, "rev-parse", "HEAD"], cacheDir, timeout, signal))
    .stdout.trim();
  if (head.toLowerCase() !== ref.toLowerCase() || !hasRequiredSkills(skillsRoot)) {
    throw new MantisSourceError("source_invalid");
  }
  throwIfAborted(signal);
  return { sourceCacheDir: cacheDir, skillsRoot, ref };
}

async function nativeGit(
  binary: "git",
  args: string[],
  options: MantisSourceCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(binary, args, {
      cwd: options.cwd,
      shell: options.shell,
      windowsHide: options.windowsHide,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => terminate(new Error("git preflight timed out")), options.timeout);

    const abort = () => terminate(new Error("git preflight cancelled"));
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();

    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (failure !== null) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxBuffer) {
        terminate(new Error("git preflight output limit"));
        return;
      }
      if (stream === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      if (failure === null) failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", abort);
      if (failure !== null) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new Error("git preflight failed"));
        return;
      }
      resolve({ stdout, stderr });
    });

    function terminate(error: Error): void {
      if (failure !== null) return;
      failure = error;
      try {
        child.kill("SIGTERM");
      } catch {
        // The close listener remains authoritative even when the child already exited.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // close is still awaited; this is only a bounded escalation for this PID.
        }
      }, GIT_KILL_GRACE_MS);
    }
  });
}

async function git(
  command: MantisSourceCommand,
  args: string[],
  cwd: string,
  timeout: number,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(signal);
  try {
    const result = await command("git", args, {
      cwd,
      timeout,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
      signal,
    });
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (signal.aborted || (error as { name?: unknown })?.name === "AbortError") {
      throw new MantisSourceError("source_cancelled");
    }
    throw new MantisSourceError("source_invalid");
  }
}

function exactRef(value: string): string {
  const ref = value.trim();
  if (!EXACT_GIT_REF.test(ref)) throw new MantisSourceError("source_invalid");
  return ref;
}

function validRepositoryUrl(value: string): string {
  const url = value.trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname) throw new Error("invalid upstream");
  } catch {
    throw new MantisSourceError("source_invalid");
  }
  return url;
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? 20_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new MantisSourceError("source_invalid");
  }
  return timeout;
}

function ensurePrivateDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const info = fs.lstatSync(directory);
    const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (owner !== undefined && info.uid !== owner)
    ) throw new Error("cache is not private");
  } catch (error) {
    if (error instanceof MantisSourceError) throw error;
    throw new MantisSourceError("source_invalid");
  }
}

function hasRequiredSkills(skillsRoot: string): boolean {
  return MANTIS_STAGES.every((stage) => {
    try {
      const file = path.resolve(skillsRoot, stage.skill, "SKILL.md");
      if (!inside(skillsRoot, file)) return false;
      const info = fs.statSync(file);
      return info.isFile() && info.size > 0 && info.size <= MAX_SKILL_BYTES;
    } catch {
      return false;
    }
  });
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new MantisSourceError("source_cancelled");
}
