import { execFile as nativeExecFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const LOCAL_CLI_OUTPUT_CAP_BYTES = 512 * 1024;
export const LOCAL_CLI_TIMEOUT_MS = 60_000;
const GROK_DEFENSIVE_SYSTEM_PROMPT = "You are a defensive, read-only security analyst. Inspect only the caller-provided pinned workspace. Do not execute commands, edit files, access network, invoke plugins, MCP tools, web, subagents, or memory. Use only Read and Grep. Return only JSON matching the supplied schema.";

export type DefensiveLocalCliRoute = "claude-code-local" | "xai-grok-build-local";

export type DefensiveLocalCliErrorCode =
  | "agent_cancelled"
  | "agent_output_byte_limit"
  | "agent_protocol_error"
  | "agent_time_limit"
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
    binary: "claude" | "grok",
    argv: string[],
    options: DefensiveLocalCliExecOptions,
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Existing-session environment; API-key variables are stripped before spawn. */
  environment?: NodeJS.ProcessEnv;
}

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

  return {
    async run(input) {
      const request = validateInput(input, approvedCwds);
      const schema = serializeSchema(request.jsonSchema);
      const binary = request.routeKind === "claude-code-local" ? "claude" : "grok";
      const argv = binary === "claude" ? claudeArgv(request, schema) : grokArgv(request, schema);
      const scope = createExecutionScope(request.signal, request.timeoutMs ?? LOCAL_CLI_TIMEOUT_MS);
      try {
        if (scope.signal.aborted) throw scope.stopError();
        const pending = execute(binary, argv, {
          cwd: request.cwd,
          timeout: request.timeoutMs ?? LOCAL_CLI_TIMEOUT_MS,
          maxBuffer: LOCAL_CLI_OUTPUT_CAP_BYTES,
          shell: false,
          windowsHide: true,
          env: { ...environment },
          signal: scope.signal,
        });
        const output = await awaitWithin(pending, scope);
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
  return [
    "--print",
    "--safe-mode",
    "--strict-mcp-config",
    // Inline empty config avoids reading a file and closes the MCP set.
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-mode",
    "plan",
    "--tools",
    "Read,Glob,Grep",
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

function grokArgv(input: DefensiveLocalCliInput, schema: string): string[] {
  if (input.model.kind !== "catalog") invalid();
  return [
    "--single",
    "--permission-mode",
    "dontAsk",
    "--allow",
    "Read",
    "--allow",
    "Grep",
    "--deny",
    "Bash",
    "--deny",
    "Edit",
    "--deny",
    "WebFetch",
    "--deny",
    "WebSearch",
    "--deny",
    "MCPTool",
    "--sandbox",
    "strict",
    "--disable-web-search",
    "--no-subagents",
    "--no-memory",
    "--system-prompt-override",
    GROK_DEFENSIVE_SYSTEM_PROMPT,
    "--max-turns",
    String(input.maxTurns),
    "--output-format",
    "json",
    "--json-schema",
    schema,
    "--model",
    input.model.id,
    input.prompt,
  ];
}

function serializeSchema(value: unknown): string {
  try {
    const schema = JSON.stringify(value);
    if (schema === undefined || Buffer.byteLength(schema, "utf8") > 64 * 1024) invalid();
    return schema;
  } catch {
    invalid();
  }
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
  return !(typeof schema.minLength === "number" && value.length < schema.minLength) &&
    !(typeof schema.maxLength === "number" && value.length > schema.maxLength);
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

async function executeNative(
  binary: "claude" | "grok",
  argv: string[],
  options: DefensiveLocalCliExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  const execFile = promisify(nativeExecFile);
  const output = await execFile(binary, argv, options);
  return { stdout: String(output.stdout), stderr: String(output.stderr) };
}

function normalizeError(
  error: unknown,
  stopped: DefensiveLocalCliError | null,
): DefensiveLocalCliError {
  if (error instanceof DefensiveLocalCliError) return error;
  if (stopped !== null) return stopped;
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
