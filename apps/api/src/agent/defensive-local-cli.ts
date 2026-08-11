import { execFile as nativeExecFile } from "node:child_process";
import { lstat as nativeLstat, realpath as nativeRealpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_CLI_OUTPUT_CAP_BYTES = 512 * 1024;
export const LOCAL_CLI_TIMEOUT_MS = 60_000;
export const LOCAL_CLI_KILL_GRACE_MS = 250;
/** Final close wait after SIGKILL; no local result is terminal before this expires. */
export const LOCAL_CLI_CLOSE_TIMEOUT_MS = 3_000;
/** Exact public MCP names derived from server `sentinel_snapshot` plus its three tools. */
export const SENTINEL_SNAPSHOT_MCP_ALLOWED_TOOLS =
  "mcp__sentinel_snapshot__list,mcp__sentinel_snapshot__read,mcp__sentinel_snapshot__search";

export type DefensiveLocalCliRoute = "claude-code-local" | "xai-grok-build-local";

export type DefensiveLocalCliErrorCode =
  | "agent_cancelled"
  | "agent_output_byte_limit"
  | "agent_protocol_error"
  | "agent_termination_unconfirmed"
  | "agent_time_limit"
  | "local_cli_isolation_unavailable"
  | "model_access_denied"
  | "protocol_unsupported"
  | "provider_unreachable"
  | "runtime_missing";

/** Closed error values only; the child process output is never attached. */
export class DefensiveLocalCliError extends Error {
  constructor(readonly code: DefensiveLocalCliErrorCode) {
    super(code);
    this.name = "DefensiveLocalCliError";
  }
}

export interface DefensiveLocalCliExecOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  shell: false;
  windowsHide: true;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export interface DefensiveLocalCliDependencies {
  /** Private directories that the caller has already provisioned for a session. */
  approvedCwds: readonly string[];
  /** Injectable only for tests. Production uses execFile with no shell. */
  execFile?: (
    binary: "claude",
    argv: string[],
    options: DefensiveLocalCliExecOptions,
  ) => DefensiveLocalCliChild;
  /** Existing-session environment; API-key variables are stripped before spawn. */
  environment?: NodeJS.ProcessEnv;
  /** Injectable filesystem boundary used to pin and revalidate the private cwd. */
  cwdInspector?: DefensiveLocalCwdInspector;
  /** Test seam for bounded escalation from SIGTERM to this exact child process. */
  killGraceMs?: number;
  /** Test seam for the bounded close confirmation after SIGKILL. */
  closeTimeoutMs?: number;
}

export interface DefensiveLocalCliChild {
  result: Promise<{ stdout: string; stderr: string }>;
  /** Resolves only after the exact child process emits `close`. */
  closed: Promise<void>;
  /** Signals this exact process only. No process-tree guarantee is implied. */
  kill(signal: "SIGTERM" | "SIGKILL"): boolean;
}

export interface DefensiveLocalCwdStat {
  dev: number | bigint;
  ino: number | bigint;
  mode: number;
  uid: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface DefensiveLocalCwdInspector {
  getuid(): number | undefined;
  lstat(cwd: string): Promise<DefensiveLocalCwdStat>;
  realpath(cwd: string): Promise<string>;
}

const SYSTEM_CWD_INSPECTOR: DefensiveLocalCwdInspector = {
  getuid: () => typeof process.getuid === "function" ? process.getuid() : undefined,
  lstat: nativeLstat,
  realpath: nativeRealpath,
};

export type DefensiveLocalModel =
  | { kind: "catalog"; id: string }
  | { kind: "runtime-default" };

export interface DefensiveLocalCliInput {
  routeKind: DefensiveLocalCliRoute;
  /** Caller-provided private, pinned session directory. */
  cwd: string;
  prompt: string;
  model: DefensiveLocalModel;
  /** The caller's fresh provider catalog; the requested value must match exactly. */
  modelCatalog: readonly string[];
  jsonSchema: unknown;
  maxTurns: number;
  /** A bounded caller deadline; the process boundary always receives the same cap. */
  timeoutMs?: number;
  signal: AbortSignal;
}

export interface DefensiveLocalCliResult {
  final: unknown;
  /** Local CLIs do not provide a stable usage contract at this boundary. */
  usage: null;
}

export interface DefensiveLocalCli {
  run(input: DefensiveLocalCliInput): Promise<DefensiveLocalCliResult>;
}

/**
 * Executes only the two reviewed local CLIs with a hardcoded, read-only argv
 * surface. It has no credential-file API and never accepts a command string.
 */
export function createDefensiveLocalCli(
  dependencies: DefensiveLocalCliDependencies,
): DefensiveLocalCli {
  const approvedCwds = dependencies.approvedCwds.map(approvedPrivateCwd);
  if (approvedCwds.length === 0) invalid();
  const environment = sanitizeExistingSessionEnvironment(dependencies.environment ?? process.env);
  const execute = dependencies.execFile ?? executeNative;
  const cwdInspector = dependencies.cwdInspector ?? SYSTEM_CWD_INSPECTOR;
  const killGraceMs = dependencies.killGraceMs ?? LOCAL_CLI_KILL_GRACE_MS;
  const closeTimeoutMs = dependencies.closeTimeoutMs ?? LOCAL_CLI_CLOSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 5_000) invalid();
  if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 10_000) invalid();

  return {
    async run(input) {
      if (isPlainRecord(input) && input.routeKind === "xai-grok-build-local") {
        throw new DefensiveLocalCliError("local_cli_isolation_unavailable");
      }
      const request = validateInput(input, approvedCwds);
      const scope = createExecutionScope(request.signal, request.timeoutMs ?? LOCAL_CLI_TIMEOUT_MS);
      try {
        const pinnedCwd = await awaitWithin(pinPrivateCwd(request.cwd, approvedCwds, cwdInspector), scope);
        const schema = serializeSchema(request.jsonSchema);
        const argv = claudeArgv(request, schema);
        await awaitWithin(revalidatePrivateCwd(pinnedCwd, cwdInspector), scope);
        const child = execute("claude", argv, {
          cwd: request.cwd,
          timeout: request.timeoutMs ?? LOCAL_CLI_TIMEOUT_MS,
          maxBuffer: LOCAL_CLI_OUTPUT_CAP_BYTES,
          shell: false,
          windowsHide: true,
          env: { ...environment },
          signal: scope.signal,
        });
        const output = await awaitChildWithin(child, scope, killGraceMs, closeTimeoutMs);
        const stdout = boundedStdout(output.stdout);
        const final = parseFinalJson(stdout);
        if (!matchesJsonSchema(final, request.jsonSchema)) {
          throw new DefensiveLocalCliError("agent_protocol_error");
        }
        return { final, usage: null };
      } catch (error) {
        throw normalizeError(error, scope.stopError());
      } finally {
        scope.dispose();
      }
    },
  };
}

interface PinnedPrivateCwd {
  realpath: string;
  dev: string;
  ino: string;
  uid: number;
  mode: number;
}

async function pinPrivateCwd(
  cwd: string,
  approvedCwds: readonly string[],
  inspector: DefensiveLocalCwdInspector,
): Promise<PinnedPrivateCwd> {
  const pinned = await inspectPrivateCwd(cwd, inspector);
  if (!approvedCwds.includes(pinned.realpath)) isolationUnavailable();
  return pinned;
}

async function revalidatePrivateCwd(
  pinned: PinnedPrivateCwd,
  inspector: DefensiveLocalCwdInspector,
): Promise<void> {
  const current = await inspectPrivateCwd(pinned.realpath, inspector);
  if (
    current.realpath !== pinned.realpath ||
    current.dev !== pinned.dev ||
    current.ino !== pinned.ino ||
    current.uid !== pinned.uid ||
    current.mode !== pinned.mode
  ) isolationUnavailable();
}

async function inspectPrivateCwd(
  cwd: string,
  inspector: DefensiveLocalCwdInspector,
): Promise<PinnedPrivateCwd> {
  try {
    const currentUid = inspector.getuid();
    if (!Number.isSafeInteger(currentUid) || currentUid! < 0) isolationUnavailable();
    const metadata = await inspector.lstat(cwd);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== currentUid ||
      !Number.isSafeInteger(metadata.mode) ||
      (metadata.mode & 0o077) !== 0
    ) isolationUnavailable();
    const canonical = path.resolve(await inspector.realpath(cwd));
    if (canonical !== cwd) isolationUnavailable();
    return {
      realpath: canonical,
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      uid: metadata.uid,
      mode: metadata.mode & 0o777,
    };
  } catch (error) {
    if (error instanceof DefensiveLocalCliError) throw error;
    isolationUnavailable();
  }
}

function isolationUnavailable(): never {
  throw new DefensiveLocalCliError("local_cli_isolation_unavailable");
}

function validateInput(
  input: DefensiveLocalCliInput,
  approvedCwds: readonly string[],
): DefensiveLocalCliInput & { cwd: string } {
  if (!isPlainRecord(input) || !isRouteKind(input.routeKind)) invalid();
  if (typeof input.cwd !== "string" || input.cwd.includes("\0")) invalid();
  const cwd = path.resolve(input.cwd);
  if (!approvedCwds.includes(cwd)) invalid();
  if (typeof input.prompt !== "string" || input.prompt.length === 0 || input.prompt.length > 131_072) invalid();
  if (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 16) invalid();
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > LOCAL_CLI_TIMEOUT_MS)) invalid();
  if (!(input.signal instanceof AbortSignal)) invalid();
  if (!Array.isArray(input.modelCatalog) || input.modelCatalog.some((id) => !isModelId(id))) invalid();
  if (!isModelSelection(input.model)) invalid();
  if (input.routeKind !== "claude-code-local" && input.model.kind === "runtime-default") invalid();
  if (input.model.kind === "catalog" && !input.modelCatalog.includes(input.model.id)) {
    throw new DefensiveLocalCliError("model_access_denied");
  }
  return { ...input, cwd };
}

function isRouteKind(value: unknown): value is DefensiveLocalCliRoute {
  return value === "claude-code-local" || value === "xai-grok-build-local";
}

function isModelSelection(value: unknown): value is DefensiveLocalModel {
  if (!isPlainRecord(value)) return false;
  return (value.kind === "catalog" && isModelId(value.id)) ||
    (value.kind === "runtime-default" && Object.keys(value).length === 1);
}

function isModelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
}

function claudeArgv(input: DefensiveLocalCliInput, schema: string): string[] {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      sentinel_snapshot: {
        command: process.execPath,
        args: [fileURLToPath(new URL("./sentinel-snapshot-mcp.mjs", import.meta.url)), input.cwd],
        // The MCP process receives no child environment. Claude itself retains
        // its existing OAuth/keychain login because this is intentionally not --bare.
        env: {},
      },
    },
  });
  return [
    "--print",
    "--safe-mode",
    "--strict-mcp-config",
    // Inline config closes the MCP set to the process we own; it contains no secrets.
    "--mcp-config",
    mcpConfig,
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-mode",
    "plan",
    "--tools",
    "",
    "--allowedTools",
    SENTINEL_SNAPSHOT_MCP_ALLOWED_TOOLS,
    "--max-turns",
    String(input.maxTurns),
    "--output-format",
    "json",
    "--json-schema",
    schema,
    ...(input.model.kind === "catalog" ? ["--model", input.model.id] : []),
    input.prompt,
  ];
}

function serializeSchema(value: unknown): string {
  try {
    if (!isClosedJsonSchema(value)) invalid();
    const schema = JSON.stringify(value);
    if (schema === undefined || Buffer.byteLength(schema, "utf8") > 64 * 1024) invalid();
    return schema;
  } catch {
    invalid();
  }
}

const CLOSED_SCHEMA_KEYS = new Set([
  "type",
  "const",
  "enum",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
]);
const CLOSED_SCHEMA_TYPES = new Set([
  "null",
  "boolean",
  "string",
  "number",
  "integer",
  "array",
  "object",
]);

function isClosedJsonSchema(schema: unknown, depth = 0): boolean {
  if (schema === true || schema === false) return true;
  if (depth > 32 || !isPlainRecord(schema)) return false;
  if (Object.keys(schema).some((key) => !CLOSED_SCHEMA_KEYS.has(key))) return false;
  if (!isClosedSchemaType(schema.type)) return false;
  if ("const" in schema && !isJsonValue(schema.const, depth + 1)) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 ||
    !schema.enum.every((item) => isJsonValue(item, depth + 1)))) return false;
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branch = schema[keyword];
    if (branch !== undefined && (!Array.isArray(branch) ||
      !branch.every((item) => isClosedJsonSchema(item, depth + 1)))) return false;
  }
  if (schema.not !== undefined && !isClosedJsonSchema(schema.not, depth + 1)) return false;
  if (schema.properties !== undefined && (!isPlainRecord(schema.properties) ||
    !Object.values(schema.properties).every((item) => isClosedJsonSchema(item, depth + 1)))) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) ||
    !schema.required.every((key) => typeof key === "string") ||
    new Set(schema.required).size !== schema.required.length)) return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return false;
  if (schema.items !== undefined && !isClosedJsonSchema(schema.items, depth + 1)) return false;
  for (const keyword of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    const boundary = schema[keyword];
    if (boundary !== undefined && (!Number.isSafeInteger(boundary) || (boundary as number) < 0)) return false;
  }
  for (const keyword of ["minimum", "maximum"] as const) {
    const boundary = schema[keyword];
    if (boundary !== undefined && (typeof boundary !== "number" || !Number.isFinite(boundary))) return false;
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string" || schema.pattern.length > 256) return false;
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      return false;
    }
  }
  return true;
}

function isClosedSchemaType(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === "string") return CLOSED_SCHEMA_TYPES.has(value);
  return Array.isArray(value) && value.length > 0 &&
    value.every((item) => typeof item === "string" && CLOSED_SCHEMA_TYPES.has(item)) &&
    new Set(value).size === value.length;
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isPlainRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function boundedStdout(stdout: unknown): string {
  if (typeof stdout !== "string") throw new DefensiveLocalCliError("agent_protocol_error");
  if (Buffer.byteLength(stdout, "utf8") > LOCAL_CLI_OUTPUT_CAP_BYTES) {
    throw new DefensiveLocalCliError("agent_output_byte_limit");
  }
  return stdout;
}

function parseFinalJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new DefensiveLocalCliError("agent_protocol_error");
  }
}

/** Deliberately small, side-effect-free validator for the response-schema subset we permit. */
function matchesJsonSchema(value: unknown, schema: unknown): boolean {
  if (schema === true) return true;
  if (schema === false || !isPlainRecord(schema)) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every((item) => matchesJsonSchema(value, item))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((item) => matchesJsonSchema(value, item))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((item) => matchesJsonSchema(value, item)).length !== 1) return false;
  if ("not" in schema && matchesJsonSchema(value, schema.not)) return false;
  if ("const" in schema && !jsonEquals(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => jsonEquals(value, item))) return false;

  const types = schemaTypes(schema.type);
  if (types === undefined || !types.some((type) => matchesType(value, type))) return false;
  if (isPlainRecord(value) && !matchesObjectSchema(value, schema)) return false;
  if (Array.isArray(value) && !matchesArraySchema(value, schema)) return false;
  if (typeof value === "string" && !matchesStringSchema(value, schema)) return false;
  if (typeof value === "number" && !matchesNumberSchema(value, schema)) return false;
  return true;
}

function schemaTypes(value: unknown): readonly string[] | undefined {
  if (value === undefined) return ["any"];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return undefined;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "any": return true;
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "array": return Array.isArray(value);
    case "object": return isPlainRecord(value);
    default: return false;
  }
}

function matchesObjectSchema(value: Record<string, unknown>, schema: Record<string, unknown>): boolean {
  if (schema.required !== undefined && (!Array.isArray(schema.required) ||
    !schema.required.every((key) => typeof key === "string" && Object.hasOwn(value, key)))) return false;
  if (schema.properties !== undefined && !isPlainRecord(schema.properties)) return false;
  const properties = isPlainRecord(schema.properties) ? schema.properties : {};
  if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
  return Object.entries(properties).every(([key, propertySchema]) =>
    !Object.hasOwn(value, key) || matchesJsonSchema(value[key], propertySchema));
}

function matchesArraySchema(value: unknown[], schema: Record<string, unknown>): boolean {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
  if (schema.items !== undefined && !value.every((item) => matchesJsonSchema(item, schema.items))) return false;
  return true;
}

function matchesStringSchema(value: string, schema: Record<string, unknown>): boolean {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string" || schema.pattern.length > 256) return false;
    try {
      if (!new RegExp(schema.pattern, "u").test(value)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function matchesNumberSchema(value: number, schema: Record<string, unknown>): boolean {
  return !(typeof schema.minimum === "number" && value < schema.minimum) &&
    !(typeof schema.maximum === "number" && value > schema.maximum);
}

function jsonEquals(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function sanitizeExistingSessionEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!/^(OPENAI|CODEX|ANTHROPIC|XAI|CURSOR)(?:_[A-Z0-9]+)*_(?:API_)?KEY$/i.test(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function approvedPrivateCwd(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) invalid();
  const cwd = path.resolve(value);
  if (cwd === path.parse(cwd).root) invalid();
  return cwd;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(): never {
  throw new DefensiveLocalCliError("protocol_unsupported");
}

function executeNative(
  binary: "claude",
  argv: string[],
  options: DefensiveLocalCliExecOptions,
): DefensiveLocalCliChild {
  let child!: ReturnType<typeof nativeExecFile>;
  let markClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const result = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    try {
      child = nativeExecFile(binary, argv, options, (error, stdout, stderr) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
      child.once("close", () => markClosed?.());
    } catch (error) {
      markClosed?.();
      reject(error);
    }
  });
  return {
    result,
    closed,
    kill(signal) {
      return child.kill(signal);
    },
  };
}

function normalizeError(
  error: unknown,
  stopped: DefensiveLocalCliError | null,
): DefensiveLocalCliError {
  if (error instanceof DefensiveLocalCliError) return error;
  if (stopped !== null) return stopped;
  if (isErrno(error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
    return new DefensiveLocalCliError("agent_output_byte_limit");
  }
  if (isErrno(error, "ENOENT")) return new DefensiveLocalCliError("runtime_missing");
  return new DefensiveLocalCliError("provider_unreachable");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

interface ExecutionScope {
  signal: AbortSignal;
  stopError(): DefensiveLocalCliError | null;
  dispose(): void;
}

function createExecutionScope(parentSignal: AbortSignal, timeoutMs: number): ExecutionScope {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  const abort = () => controller.abort();
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    stopError: () => !controller.signal.aborted
      ? null
      : new DefensiveLocalCliError(timedOut ? "agent_time_limit" : "agent_cancelled"),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", abort);
    },
  };
}

function awaitWithin<T>(operation: Promise<T>, scope: ExecutionScope): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      scope.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      // `then` below is deliberately kept attached after this local result
      // wins, so an uncooperative child cannot create an unhandled rejection.
      void operation.catch(() => undefined);
      finish(() => reject(scope.stopError() ?? new DefensiveLocalCliError("agent_cancelled")));
    };
    if (scope.signal.aborted) {
      onAbort();
      return;
    }
    scope.signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function awaitChildWithin<T extends { stdout: string; stderr: string }>(
  child: DefensiveLocalCliChild,
  scope: ExecutionScope,
  killGraceMs: number,
  closeTimeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let locallySettled = false;
    let childClosed = false;
    let terminationStarted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let closeBudgetTimer: NodeJS.Timeout | undefined;
    const finishLocally = (callback: () => void): void => {
      if (locallySettled) return;
      locallySettled = true;
      scope.signal.removeEventListener("abort", onAbort);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (closeBudgetTimer !== undefined) clearTimeout(closeBudgetTimer);
      callback();
    };
    const markChildClosed = (): void => {
      childClosed = true;
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (closeBudgetTimer !== undefined) clearTimeout(closeBudgetTimer);
      if (terminationStarted) {
        finishLocally(() => reject(scope.stopError() ?? new DefensiveLocalCliError("agent_cancelled")));
      }
    };
    const signalChild = (signal: "SIGTERM" | "SIGKILL"): void => {
      try {
        child.kill(signal);
      } catch {
        // Local cancellation remains authoritative. The closed result does not
        // claim that this exact child, let alone a process tree, has exited.
      }
    };
    const onAbort = (): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      signalChild("SIGTERM");
      if (!childClosed && forceKillTimer === undefined) {
        forceKillTimer = setTimeout(() => {
          if (childClosed) return;
          signalChild("SIGKILL");
          closeBudgetTimer = setTimeout(() => {
            if (!childClosed) {
              finishLocally(() => reject(new DefensiveLocalCliError("agent_termination_unconfirmed")));
            }
          }, closeTimeoutMs);
        }, killGraceMs);
      }
    };
    void child.closed.then(
      markChildClosed,
      () => {
        if (terminationStarted) {
          finishLocally(() => reject(new DefensiveLocalCliError("agent_termination_unconfirmed")));
        }
      },
    );
    if (scope.signal.aborted) onAbort();
    else scope.signal.addEventListener("abort", onAbort, { once: true });
    void child.result.then(
      (value) => {
        if (!terminationStarted) finishLocally(() => resolve(value as T));
      },
      (error: unknown) => {
        if (!terminationStarted) finishLocally(() => reject(error));
      },
    );
  });
}
