import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Hono } from "hono";
import type { GuardrailRepository } from "@csb/shared";

import { runtimeMode, repositoryRoots } from "./deployment-settings.js";
import { acquireEngineMaintenance } from "./engine-updates-api.js";
import { EngineUpdateError } from "./scanners/engine-updates.js";
import { assertRepositoryAccess } from "./repository-access.js";

const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_LIMIT = 64 * 1024;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SHA = /^[0-9a-f]{40}$/;

export type GitCheckoutMode = "local" | "server";
export type CheckoutAction = "fetch" | "pull";

export type CheckoutErrorCode =
  | "repository_not_found"
  | "checkout_unavailable"
  | "checkout_write_unsupported"
  | "checkout_invalid_request"
  | "checkout_remote_not_found"
  | "checkout_remote_unsupported"
  | "checkout_dirty"
  | "checkout_detached"
  | "checkout_no_upstream"
  | "checkout_tracking_remote_mismatch"
  | "checkout_diverged"
  | "checkout_git_failed"
  | "checkout_timeout"
  | "scan_active"
  | "update_in_progress";

/** Public errors are closed codes: neither Git stderr nor remote URLs escape the API. */
export class CheckoutError extends Error {
  constructor(readonly code: CheckoutErrorCode) {
    super(code);
    this.name = "CheckoutError";
  }
}

/** Allows a test or alternate admission layer to expose the same closed reasons. */
export class CheckoutMaintenanceError extends Error {
  constructor(readonly code: "scan_active" | "update_in_progress") {
    super(code);
    this.name = "CheckoutMaintenanceError";
  }
}

export interface GitCheckoutCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export type GitCheckoutRunner = (args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}) => Promise<GitCheckoutCommandResult>;

export interface GitCheckoutStatus {
  repositoryKey: string;
  branch: string | null;
  upstream: string | null;
  trackingRemote: string | null;
  head: string | null;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  remotes: string[];
  remote: string | null;
  writable: boolean;
  canFetch: boolean;
  canPull: boolean;
  reason: CheckoutErrorCode | null;
  checkedAt: string;
}

export interface GitHubCheckoutsDependencies {
  /** Only a pre-enrolled repository may reach a checkout. URL and path input are never accepted. */
  getRepository(repositoryKey: string): GuardrailRepository | null;
  mode?: () => GitCheckoutMode;
  repositoryRoots?: () => string[];
  /** Uses the same SQLite-backed lease as engine updates and scan admission by default. */
  acquireMaintenance?: () => () => void;
  runner?: GitCheckoutRunner;
  /** Production permits authenticated HTTPS and SSH transports only. */
  remoteUrlAllowed?: (url: string) => boolean;
  /** Test seam for self-contained Git fixtures. Production leaves file transport disabled. */
  allowFileProtocol?: boolean;
  now?: () => Date;
}

/**
 * Read and safely update an enrolled checkout. This route deliberately does
 * not clone, configure remotes, reset, rebase, stash, switch branches, or
 * accept an arbitrary filesystem path/URL.
 */
export function createGitHubCheckoutsApp(supplied: GitHubCheckoutsDependencies): Hono {
  const service = new GitCheckoutService(supplied);
  const app = new Hono();

  // The query form keeps keys such as "github.com/org/repository" unambiguous.
  app.get("/github-checkouts", async (c) => response(c, () => service.status(requiredRepositoryKey(c.req.query("repositoryKey")))));
  // Kept for clients that encode the key as one URL segment.
  app.get("/github-checkouts/:repositoryKey", async (c) => response(c, () => service.status(requiredRepositoryKey(c.req.param("repositoryKey")))));

  for (const action of ["fetch", "pull"] as const) {
    app.post(`/github-checkouts/:repositoryKey/${action}`, async (c) => response(c, async () => {
      const body = await checkoutRequest(c.req.raw);
      return service.execute(requiredRepositoryKey(c.req.param("repositoryKey")), action, body.remote);
    }));
  }

  return app;
}

class GitCheckoutService {
  readonly #mode: () => GitCheckoutMode;
  readonly #roots: () => string[];
  readonly #acquireMaintenance: () => () => void;
  readonly #runner: GitCheckoutRunner;
  readonly #remoteUrlAllowed: (url: string) => boolean;
  readonly #allowFileProtocol: boolean;
  readonly #now: () => Date;

  constructor(private readonly dependencies: GitHubCheckoutsDependencies) {
    this.#mode = dependencies.mode ?? runtimeMode;
    this.#roots = dependencies.repositoryRoots ?? repositoryRoots;
    this.#acquireMaintenance = dependencies.acquireMaintenance ?? acquireEngineMaintenance;
    this.#runner = dependencies.runner ?? nativeGitRunner;
    this.#remoteUrlAllowed = dependencies.remoteUrlAllowed ?? safeRemoteUrl;
    this.#allowFileProtocol = dependencies.allowFileProtocol === true;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async status(repositoryKey: string): Promise<{ checkout: GitCheckoutStatus }> {
    const checkout = await this.#checkout(repositoryKey);
    return { checkout: await this.#status(checkout) };
  }

  async execute(repositoryKey: string, action: CheckoutAction, requestedRemote?: string): Promise<{ checkout: GitCheckoutStatus }> {
    const checkout = await this.#checkout(repositoryKey);
    if (checkout.mode === "server") throw new CheckoutError("checkout_write_unsupported");

    let release: (() => void) | undefined;
    try {
      release = this.#maintenanceLease();
      if (action === "pull") {
        const beforeFetch = await this.#status(checkout);
        if (beforeFetch.dirty) throw new CheckoutError("checkout_dirty");
        if (beforeFetch.branch === null) throw new CheckoutError("checkout_detached");
        if (beforeFetch.upstream === null || beforeFetch.trackingRemote === null) {
          throw new CheckoutError("checkout_no_upstream");
        }
        const remote = await this.#remote(checkout, requestedRemote ?? beforeFetch.trackingRemote);
        if (remote.name !== beforeFetch.trackingRemote) {
          throw new CheckoutError("checkout_tracking_remote_mismatch");
        }
        await this.#fetch(checkout, remote.name);
        const afterFetch = await this.#status(checkout);
        if (afterFetch.dirty) throw new CheckoutError("checkout_dirty");
        if (afterFetch.branch === null) throw new CheckoutError("checkout_detached");
        if (afterFetch.upstream === null || afterFetch.trackingRemote === null) {
          throw new CheckoutError("checkout_no_upstream");
        }
        if (afterFetch.ahead !== null && afterFetch.behind !== null && afterFetch.ahead > 0 && afterFetch.behind > 0) {
          throw new CheckoutError("checkout_diverged");
        }
        if (afterFetch.behind !== null && afterFetch.behind > 0) {
          await this.#runRequired(checkout.path, ["merge", "--ff-only", "--no-edit", afterFetch.upstream]);
        }
      } else {
        const remote = await this.#remote(checkout, requestedRemote ?? "origin");
        await this.#fetch(checkout, remote.name);
      }
      return { checkout: await this.#status(checkout) };
    } finally {
      release?.();
    }
  }

  async #checkout(repositoryKey: string): Promise<{ repository: GuardrailRepository; path: string; mode: GitCheckoutMode }> {
    const repository = this.dependencies.getRepository(repositoryKey);
    if (repository === null) throw new CheckoutError("repository_not_found");
    if (repository.source !== "local" || repository.repositoryPath === null || !repository.enabled) {
      throw new CheckoutError("checkout_unavailable");
    }

    const mode = this.#mode();
    let authorized: string;
    let canonical: string;
    try {
      authorized = assertRepositoryAccess(repository.repositoryPath, {
        mode,
        ...(mode === "server" ? { roots: this.#roots() } : {}),
      });
      canonical = fs.realpathSync(authorized);
    } catch {
      throw new CheckoutError("checkout_unavailable");
    }
    const reportedRoot = await this.#optional(canonical, ["rev-parse", "--show-toplevel"]);
    if (reportedRoot === null) throw new CheckoutError("checkout_unavailable");
    let gitRoot: string;
    try { gitRoot = fs.realpathSync(path.resolve(canonical, reportedRoot)); }
    catch { throw new CheckoutError("checkout_unavailable"); }
    if (gitRoot !== canonical) throw new CheckoutError("checkout_unavailable");
    return { repository, path: canonical, mode };
  }

  async #status(checkout: { repository: GuardrailRepository; path: string; mode: GitCheckoutMode }): Promise<GitCheckoutStatus> {
    const [branch, upstream, head, porcelain, remotes] = await Promise.all([
      this.#optional(checkout.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.#optional(checkout.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
      this.#optional(checkout.path, ["rev-parse", "--verify", "HEAD"]),
      this.#optional(checkout.path, ["status", "--porcelain=v1", "--untracked-files=all"]),
      this.#optional(checkout.path, ["remote"]),
    ]);
    const knownRemotes = lines(remotes).filter((remote) => REMOTE_NAME.test(remote));
    const trackingRemote = branch === null ? null : await this.#trackingRemote(checkout.path, branch, knownRemotes);
    const counts = upstream === null ? null : await this.#aheadBehind(checkout.path, upstream);
    const defaultRemote = knownRemotes.includes("origin") ? "origin" : knownRemotes[0] ?? null;
    const remote = defaultRemote === null ? null : await this.#remoteIfSafe(checkout.path, defaultRemote);
    const writable = checkout.mode === "local";
    const canFetch = writable && remote !== null;
    const canPull = writable && !porcelain && branch !== null && upstream !== null && trackingRemote !== null
      && (await this.#remoteIfSafe(checkout.path, trackingRemote)) !== null;

    return {
      repositoryKey: checkout.repository.repositoryKey,
      branch,
      upstream,
      trackingRemote,
      head: head !== null && SHA.test(head) ? head : null,
      dirty: Boolean(porcelain),
      ahead: counts?.ahead ?? null,
      behind: counts?.behind ?? null,
      remotes: knownRemotes,
      remote,
      writable,
      canFetch,
      canPull,
      reason: writable ? null : "checkout_write_unsupported",
      checkedAt: this.#now().toISOString(),
    };
  }

  async #trackingRemote(cwd: string, branch: string, remotes: readonly string[]): Promise<string | null> {
    const remote = await this.#optional(cwd, ["config", "--get", `branch.${branch}.remote`]);
    return remote !== null && remotes.includes(remote) && REMOTE_NAME.test(remote) ? remote : null;
  }

  async #aheadBehind(cwd: string, upstream: string): Promise<{ ahead: number; behind: number } | null> {
    const value = await this.#optional(cwd, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    const match = value === null ? null : /^(\d+)\s+(\d+)$/.exec(value);
    if (match === null) return null;
    const behind = Number(match[1]);
    const ahead = Number(match[2]);
    return Number.isSafeInteger(ahead) && Number.isSafeInteger(behind) ? { ahead, behind } : null;
  }

  async #remote(checkout: { path: string }, value: string): Promise<{ name: string }> {
    if (!REMOTE_NAME.test(value)) throw new CheckoutError("checkout_invalid_request");
    const remotes = lines(await this.#runRequired(checkout.path, ["remote"]));
    if (!remotes.includes(value)) throw new CheckoutError("checkout_remote_not_found");
    if (await this.#remoteIfSafe(checkout.path, value) === null) throw new CheckoutError("checkout_remote_unsupported");
    return { name: value };
  }

  async #remoteIfSafe(cwd: string, remote: string): Promise<string | null> {
    if (!REMOTE_NAME.test(remote)) return null;
    const urls = lines(await this.#optional(cwd, ["remote", "get-url", "--all", remote]));
    return urls.length > 0 && urls.every(this.#remoteUrlAllowed) ? remote : null;
  }

  #fetch(checkout: { path: string }, remote: string): Promise<string> {
    // `--upload-pack` overrides a repository-local remote.<name>.uploadpack value.
    return this.#runRequired(checkout.path, ["fetch", "--prune", "--no-tags", "--upload-pack=git-upload-pack", remote]);
  }

  #maintenanceLease(): () => void {
    try {
      return this.#acquireMaintenance();
    } catch (error) {
      if (error instanceof CheckoutMaintenanceError) throw new CheckoutError(error.code);
      if (error instanceof EngineUpdateError && (error.code === "scan_active" || error.code === "update_in_progress")) {
        throw new CheckoutError(error.code);
      }
      throw new CheckoutError("update_in_progress");
    }
  }

  async #runRequired(cwd: string, args: string[]): Promise<string> {
    const result = await this.#runner(gitArguments(args, this.#allowFileProtocol), { cwd, env: gitEnvironment(), timeoutMs: GIT_TIMEOUT_MS });
    if (result.timedOut) throw new CheckoutError("checkout_timeout");
    if (result.exitCode !== 0 || Buffer.byteLength(result.stdout, "utf8") > GIT_OUTPUT_LIMIT || Buffer.byteLength(result.stderr, "utf8") > GIT_OUTPUT_LIMIT) {
      throw new CheckoutError("checkout_git_failed");
    }
    return result.stdout.trim();
  }

  async #optional(cwd: string, args: string[]): Promise<string | null> {
    const result = await this.#runner(gitArguments(args, this.#allowFileProtocol), { cwd, env: gitEnvironment(), timeoutMs: GIT_TIMEOUT_MS });
    if (result.timedOut || result.exitCode !== 0 || Buffer.byteLength(result.stdout, "utf8") > GIT_OUTPUT_LIMIT || Buffer.byteLength(result.stderr, "utf8") > GIT_OUTPUT_LIMIT) return null;
    return result.stdout.trim();
  }
}

function gitArguments(args: string[], allowFileProtocol: boolean): string[] {
  return [
    "-c", `core.hooksPath=${os.devNull}`,
    "-c", "core.fsmonitor=false",
    "-c", "protocol.ext.allow=never",
    "-c", `protocol.file.allow=${allowFileProtocol ? "always" : "never"}`,
    "-c", "protocol.git.allow=never",
    "-c", "protocol.http.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.ssh.allow=always",
    ...args,
  ];
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
}

function nativeGitRunner(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<GitCheckoutCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
    }, options.timeoutMs);
    timer.unref();
    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > GIT_OUTPUT_LIMIT + 1) {
        child.kill("SIGTERM");
        return next.slice(0, GIT_OUTPUT_LIMIT + 1);
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: 1, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
    });
  });
}

function safeRemoteUrl(value: string): boolean {
  if (value.length === 0 || value.length > 4_096 || value.includes("\0") || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "ssh:")
      && url.hostname.length > 0
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    // SCP syntax is the normal GitHub SSH remote form: git@github.com:owner/repo.git.
    return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^:\s]+$/.test(value);
  }
}

function requiredRepositoryKey(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.length > 512 || value.includes("\0")) {
    throw new CheckoutError("checkout_invalid_request");
  }
  return value;
}

async function checkoutRequest(request: Request): Promise<{ remote?: string }> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new CheckoutError("checkout_invalid_request");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 4_096) throw new CheckoutError("checkout_invalid_request");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new CheckoutError("checkout_invalid_request"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CheckoutError("checkout_invalid_request");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "remote")) throw new CheckoutError("checkout_invalid_request");
  if (record.remote === undefined) return {};
  if (typeof record.remote !== "string" || !REMOTE_NAME.test(record.remote)) throw new CheckoutError("checkout_invalid_request");
  return { remote: record.remote };
}

function lines(value: string | null): string[] {
  return value === null ? [] : value.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function response(c: import("hono").Context, operation: () => Promise<{ checkout: GitCheckoutStatus }>): Promise<Response> {
  try {
    return c.json(await operation());
  } catch (error) {
    const code = error instanceof CheckoutError ? error.code : "checkout_git_failed";
    const status = code === "repository_not_found" ? 404
      : code === "checkout_invalid_request" ? 400
      : 409;
    return c.json({ error: code }, status);
  }
}
