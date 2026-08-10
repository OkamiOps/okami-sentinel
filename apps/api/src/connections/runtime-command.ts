import { execFile as nativeExecFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

import type { SafeProviderErrorCode } from "@csb/shared";
import { globalSecretRedactor, type SecretRedactor } from "../redaction.js";

export const RUNTIME_DISCOVERY_TIMEOUT_MS = 20_000;
export const RUNTIME_OUTPUT_CAP_BYTES = 2 * 1024 * 1024;

export interface RuntimeCommandInput {
  binary: string;
  argv: string[];
  cwd: string;
  /** Used only to supply an explicit child environment; never returned or retained. */
  env?: NodeJS.ProcessEnv;
}

export interface RuntimeCommandOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  shell: false;
  windowsHide: true;
  env?: NodeJS.ProcessEnv;
}

export interface RuntimeCommandOutput {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface RuntimeCommandDependencies {
  approvedCwds?: readonly string[];
  redactor?: Pick<SecretRedactor, "redactText">;
  execFile?: (
    binary: string,
    argv: string[],
    options: RuntimeCommandOptions,
  ) => Promise<{ stdout: string; stderr: string }>;
}

export class RuntimeCommandError extends Error {
  constructor(
    readonly code: SafeProviderErrorCode,
    readonly diagnostic: string,
  ) {
    super(code);
    this.name = "RuntimeCommandError";
  }
}

export interface RuntimeCommand {
  execute(input: RuntimeCommandInput): Promise<RuntimeCommandOutput>;
}

/**
 * The only local CLI execution boundary. It intentionally accepts argv, never
 * a command string, and leaves every child isolated to an approved directory.
 */
export function createRuntimeCommand(
  dependencies: RuntimeCommandDependencies = {},
): RuntimeCommand {
  const approvedCwds = (dependencies.approvedCwds ?? [process.cwd()]).map(approvedCwd);
  const redactor = dependencies.redactor ?? globalSecretRedactor;
  const execFile = dependencies.execFile ?? executeNative;

  return {
    async execute(input: RuntimeCommandInput): Promise<RuntimeCommandOutput> {
      const request = validateInput(input, approvedCwds);
      const options: RuntimeCommandOptions = {
        cwd: request.cwd,
        timeout: RUNTIME_DISCOVERY_TIMEOUT_MS,
        maxBuffer: RUNTIME_OUTPUT_CAP_BYTES,
        shell: false,
        windowsHide: true,
        ...(request.env === undefined ? {} : { env: request.env }),
      };
      try {
        const output = await execFile(request.binary, request.argv, options);
        return redactBoundedOutput(output, redactor);
      } catch (error) {
        if (error instanceof RuntimeCommandError) throw error;
        throw runtimeFailure(error, redactor);
      }
    },
  };
}

function validateInput(
  value: RuntimeCommandInput,
  approvedCwds: readonly string[],
): RuntimeCommandInput {
  if (!isPlainRecord(value)) invalidCommand("invalid runtime command");
  const keys = Object.getOwnPropertyNames(value);
  if (keys.some((key) => !["binary", "argv", "cwd", "env"].includes(key))) {
    invalidCommand("unsupported runtime command option");
  }
  if (typeof value.binary !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.binary)) {
    invalidCommand("invalid runtime binary");
  }
  if (
    !Array.isArray(value.argv) ||
    value.argv.some((argument) =>
      typeof argument !== "string" ||
      argument.includes("\0") ||
      argument === "--config" ||
      argument === "-c" ||
      argument.startsWith("--config="),
    )
  ) invalidCommand("invalid runtime argv");
  if (typeof value.cwd !== "string" || value.cwd.includes("\0")) invalidCommand("invalid runtime cwd");
  const cwd = canonicalPath(value.cwd);
  if (!approvedCwds.some((root) => isWithin(root, cwd))) invalidCommand("runtime cwd denied");
  if (value.env !== undefined && !isStringEnvironment(value.env)) invalidCommand("invalid runtime environment");
  return {
    binary: value.binary,
    argv: [...value.argv],
    cwd,
    ...(value.env === undefined ? {} : { env: { ...value.env } }),
  };
}

function approvedCwd(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("approved runtime cwd must be a non-empty path");
  }
  const resolved = canonicalPath(value);
  if (resolved === path.parse(resolved).root) {
    throw new Error("approved runtime cwd cannot be filesystem root");
  }
  return resolved;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    // A test seam or a just-created runtime directory may not exist yet. The
    // lexical boundary still rejects all parent/sibling escape attempts.
    return resolved;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isStringEnvironment(value: NodeJS.ProcessEnv): boolean {
  if (!isPlainRecord(value)) return false;
  return Object.values(value).every((entry) => entry === undefined || typeof entry === "string");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidCommand(diagnostic: string): never {
  throw new RuntimeCommandError("protocol_unsupported", diagnostic);
}

async function executeNative(
  binary: string,
  argv: string[],
  options: RuntimeCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
  const execute = promisify(nativeExecFile);
  const output = await execute(binary, argv, options);
  return { stdout: String(output.stdout), stderr: String(output.stderr) };
}

function runtimeFailure(
  error: unknown,
  redactor: Pick<SecretRedactor, "redactText">,
): RuntimeCommandError {
  const code = isErrno(error, "ENOENT")
    ? "runtime_missing"
    : "provider_unreachable";
  const details = error instanceof Error ? error.message : "runtime execution failed";
  const stdout = errorOutput(error, "stdout");
  const stderr = errorOutput(error, "stderr");
  return new RuntimeCommandError(code, redactBoundedText(`${details}\n${stdout}\n${stderr}`, redactor).text);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function errorOutput(error: unknown, key: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null) return "";
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" || Buffer.isBuffer(value) ? String(value) : "";
}

function redactBoundedOutput(
  output: { stdout: string; stderr: string },
  redactor: Pick<SecretRedactor, "redactText">,
): RuntimeCommandOutput {
  const stdout = redactBoundedText(output.stdout, redactor);
  const remaining = Math.max(0, RUNTIME_OUTPUT_CAP_BYTES - stdout.bytes);
  const stderr = redactBoundedText(output.stderr, redactor, remaining);
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
  };
}

function redactBoundedText(
  value: string,
  redactor: Pick<SecretRedactor, "redactText">,
  limit = RUNTIME_OUTPUT_CAP_BYTES,
): { text: string; bytes: number; truncated: boolean } {
  const source = Buffer.from(value, "utf8");
  const bounded = source.byteLength > limit ? source.subarray(0, limit) : source;
  const text = redactor.redactText(bounded.toString("utf8"));
  return { text, bytes: bounded.byteLength, truncated: source.byteLength > limit };
}
