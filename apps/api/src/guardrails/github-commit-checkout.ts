import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GuardrailRepository } from "@csb/shared";

import type { GitHubArchiveAuthorization } from "./github-archive-client.js";

const COMMAND_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 10 * 60 * 1_000;
const GIT_OUTPUT_LIMIT = 64 * 1024;
const GITHUB_HTTPS_REMOTE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/;

export type GitHubCommitCheckoutErrorCode =
  | "checkout_cancelled"
  | "checkout_git_failed"
  | "checkout_protocol_error"
  | "checkout_timeout";

export class GitHubCommitCheckoutError extends Error {
  constructor(readonly code: GitHubCommitCheckoutErrorCode) {
    super(code);
    this.name = "GitHubCommitCheckoutError";
  }
}

export interface GitCommitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export type GitCommitRunner = (
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
  },
) => Promise<GitCommitCommandResult>;

export interface GitHubCommitCheckoutDependencies {
  authorize(repository: GuardrailRepository): Promise<GitHubArchiveAuthorization>;
  runner?: GitCommitRunner;
  allowFileProtocol?: boolean;
  remoteUrl?(owner: string, name: string): string;
  timeoutMs?: number;
}

export class GitHubCommitCheckout {
  readonly #runner: GitCommitRunner;
  readonly #allowFileProtocol: boolean;
  readonly #remoteUrl: (owner: string, name: string) => string;
  readonly #fetchTimeoutMs: number;

  constructor(readonly dependencies: GitHubCommitCheckoutDependencies) {
    this.#runner = dependencies.runner ?? nativeGitRunner;
    this.#allowFileProtocol = dependencies.allowFileProtocol === true;
    this.#remoteUrl = dependencies.remoteUrl ?? githubHttpsRemote;
    this.#fetchTimeoutMs = positiveTimeout(dependencies.timeoutMs ?? FETCH_TIMEOUT_MS);
  }

  async checkout(
    repository: GuardrailRepository,
    commitSha: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const sha = fullSha(commitSha);
    const dest = emptyDirectory(destination);
    const authorization = await this.dependencies.authorize(repository);
    const owner = pathSegment(authorization.owner);
    const name = pathSegment(authorization.name);
    const token = secret(authorization.token);
    const remote = this.#remoteUrl(owner, name);
    assertRemote(remote, this.#allowFileProtocol);
    const extraHeader = usesAuthorizationHeader(remote)
      ? `AUTHORIZATION: bearer ${token}`
      : null;

    try {
      await this.#run(dest, ["init", "--quiet"], COMMAND_TIMEOUT_MS, signal);
      await this.#run(dest, ["remote", "add", "origin", remote], COMMAND_TIMEOUT_MS, signal);
      await this.#run(
        dest,
        ["fetch", "--quiet", "--no-tags", "--depth", "1", "--upload-pack=git-upload-pack", "origin", sha],
        this.#fetchTimeoutMs,
        signal,
        extraHeader,
      );
      await this.#run(dest, ["checkout", "--force", "--detach", sha], COMMAND_TIMEOUT_MS, signal);
      const head = await this.#run(dest, ["rev-parse", "--verify", "HEAD"], COMMAND_TIMEOUT_MS, signal);
      if (head !== sha) throw new GitHubCommitCheckoutError("checkout_git_failed");
    } catch (error) {
      if (signal?.aborted === true) throw new GitHubCommitCheckoutError("checkout_cancelled");
      if (error instanceof GitHubCommitCheckoutError) throw error;
      throw new GitHubCommitCheckoutError("checkout_git_failed");
    }
    removeGitMetadata(dest);
  }

  async #run(
    cwd: string,
    args: string[],
    timeoutMs: number,
    signal: AbortSignal | undefined,
    extraHeader: string | null = null,
  ): Promise<string> {
    throwIfAborted(signal);
    const result = await this.#runner(gitArguments(args, this.#allowFileProtocol, extraHeader), {
      cwd,
      env: gitEnvironment(),
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    if (signal?.aborted === true) throw new GitHubCommitCheckoutError("checkout_cancelled");
    if (result.timedOut) throw new GitHubCommitCheckoutError("checkout_timeout");
    if (result.exitCode !== 0) throw new GitHubCommitCheckoutError("checkout_git_failed");
    return result.stdout.trim();
  }
}

function gitArguments(
  args: string[],
  allowFileProtocol: boolean,
  extraHeader: string | null,
): string[] {
  return [
    "-c", `core.hooksPath=${os.devNull}`,
    "-c", "core.fsmonitor=false",
    "-c", "safe.directory=*",
    "-c", "credential.helper=",
    "-c", "filter.lfs.smudge=",
    "-c", "filter.lfs.process=",
    "-c", "filter.lfs.required=false",
    "-c", "protocol.ext.allow=never",
    "-c", `protocol.file.allow=${allowFileProtocol ? "always" : "never"}`,
    "-c", "protocol.git.allow=never",
    "-c", "protocol.http.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.ssh.allow=never",
    ...(extraHeader === null ? [] : ["-c", `http.extraHeader=${extraHeader}`]),
    ...args,
  ];
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
}

function nativeGitRunner(
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<GitCommitCommandResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted === true) {
      resolve({ stdout: "", stderr: "", exitCode: 1, timedOut: false });
      return;
    }
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
    }, options.timeoutMs);
    timer.unref();
    const abort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString("utf8");
      return Buffer.byteLength(next, "utf8") > GIT_OUTPUT_LIMIT + 1
        ? next.slice(0, GIT_OUTPUT_LIMIT + 1)
        : next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ stdout, stderr, exitCode, timedOut });
    };
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
  });
}

function emptyDirectory(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new GitHubCommitCheckoutError("checkout_protocol_error");
  }
  const destination = path.resolve(value);
  if (!fs.existsSync(destination)) {
    throw new GitHubCommitCheckoutError("checkout_protocol_error");
  }
  const stat = fs.lstatSync(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new GitHubCommitCheckoutError("checkout_protocol_error");
  }
  if (fs.readdirSync(destination).length > 0) {
    throw new GitHubCommitCheckoutError("checkout_protocol_error");
  }
  return destination;
}

function removeGitMetadata(destination: string): void {
  const gitDir = path.join(destination, ".git");
  if (!fs.existsSync(gitDir)) return;
  const relative = path.relative(destination, gitDir);
  if (relative !== ".git") throw new GitHubCommitCheckoutError("checkout_git_failed");
  const stat = fs.lstatSync(gitDir);
  if (stat.isSymbolicLink() || stat.isFile()) {
    fs.unlinkSync(gitDir);
  } else if (stat.isDirectory()) {
    fs.rmSync(gitDir, { recursive: true, force: false });
  } else {
    throw new GitHubCommitCheckoutError("checkout_git_failed");
  }
  if (fs.existsSync(gitDir)) throw new GitHubCommitCheckoutError("checkout_git_failed");
}

function githubHttpsRemote(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

function assertRemote(value: string, allowFileProtocol: boolean): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0") || /\s/.test(value)) {
    throw new GitHubCommitCheckoutError("checkout_protocol_error");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubCommitCheckoutError("checkout_protocol_error");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new GitHubCommitCheckoutError("checkout_protocol_error");
  }
  if (allowFileProtocol && url.protocol === "file:" && url.hostname === "" && url.pathname.length > 1) {
    return;
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "github.com"
    || url.port !== ""
    || GITHUB_HTTPS_REMOTE.exec(value) === null
  ) {
    throw new GitHubCommitCheckoutError("checkout_protocol_error");
  }
}

function usesAuthorizationHeader(remote: string): boolean {
  return remote.startsWith("https://");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new GitHubCommitCheckoutError("checkout_cancelled");
}

function fullSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new GitHubCommitCheckoutError("checkout_protocol_error");
  }
  return value;
}

function pathSegment(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 255
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new GitHubCommitCheckoutError("checkout_protocol_error");
  }
  return value;
}

function secret(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 16_384 || value.includes("\0")) {
    throw new GitHubCommitCheckoutError("checkout_protocol_error");
  }
  return value;
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubCommitCheckoutError("checkout_protocol_error");
  }
  return value;
}
