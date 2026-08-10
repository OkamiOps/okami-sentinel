import { randomUUID } from "node:crypto";

import type {
  CapabilityReport,
  ModelCapabilities,
  ProviderModel,
  SafeProviderErrorCode,
  ScanConnectionSelection,
} from "@csb/shared";
import type { StoredProviderConnection } from "../connections-store.js";
import {
  type DiscoveryResult,
  type RouteAdapter,
  type RouteInspection,
  type SafeAuthFlow,
} from "./route-adapter.js";
import {
  createRuntimeCommand,
  type RuntimeCommand,
  RuntimeCommandError,
  type RuntimeCommandOutput,
} from "./runtime-command.js";

export interface RuntimeExecResult {
  stdout: string;
  stderr: string;
}

export interface LocalRuntimeAdapterDependencies {
  /** Test seam; production callers use the argv-only RuntimeCommand boundary. */
  execFile?: (binary: string, args: string[]) => Promise<RuntimeExecResult>;
  command?: RuntimeCommand;
  cwd?: string;
  now?: () => Date;
}

export interface LocalRuntimeAdapter {
  inspect(connection: StoredProviderConnection): Promise<RouteInspection>;
  startAuth(
    connection: StoredProviderConnection,
    mode: "browser-oauth" | "device-code",
  ): Promise<SafeAuthFlow>;
  discoverModels(connection: StoredProviderConnection): Promise<DiscoveryResult>;
  probe(
    connection: StoredProviderConnection,
    selection: ScanConnectionSelection,
  ): Promise<CapabilityReport>;
}

type LocalRouteKind = "xai-grok-build-local" | "claude-code-local" | "cursor-agent-local";

interface RuntimeRouteSpec {
  routeKind: LocalRouteKind;
  binary: "grok" | "claude" | "cursor-agent";
  protocol: RouteAdapter["protocol"];
  statusArgs: string[];
  loginArgs: string[];
  supportsRuntimeDefault: boolean;
}

const ROUTES: Record<LocalRouteKind, RuntimeRouteSpec> = {
  "xai-grok-build-local": {
    routeKind: "xai-grok-build-local",
    binary: "grok",
    protocol: "grok-build-cli",
    statusArgs: ["status"],
    loginArgs: ["login"],
    supportsRuntimeDefault: false,
  },
  "claude-code-local": {
    routeKind: "claude-code-local",
    binary: "claude",
    protocol: "claude-code-cli",
    statusArgs: ["auth", "status"],
    loginArgs: ["auth", "login"],
    supportsRuntimeDefault: true,
  },
  "cursor-agent-local": {
    routeKind: "cursor-agent-local",
    binary: "cursor-agent",
    protocol: "cursor-agent-cli",
    statusArgs: ["status"],
    loginArgs: ["login"],
    supportsRuntimeDefault: false,
  },
};

/**
 * Local runtime behavior shared by the three real local routes. It neither
 * reads runtime credential files nor exposes a child environment or output.
 */
export function createLocalRuntimeAdapter(
  dependencies: LocalRuntimeAdapterDependencies = {},
): LocalRuntimeAdapter {
  const cwd = dependencies.cwd ?? process.cwd();
  const now = dependencies.now ?? (() => new Date());
  const execute = runtimeExecutor(dependencies, cwd);

  return {
    async inspect(connection) {
      const route = routeFor(connection.routeKind);
      if (route === undefined) return unavailable("protocol_unsupported", false);
      try {
        const version = await execute(route.binary, ["--version"]);
        if (unsupportedRuntime(version)) return unavailable("runtime_version_unsupported", route.supportsRuntimeDefault);
        await execute(route.binary, route.statusArgs);
        return { available: true, reason: null, supportsRuntimeDefault: route.supportsRuntimeDefault };
      } catch (error) {
        return unavailable(safeErrorCode(error), route.supportsRuntimeDefault);
      }
    },

    async startAuth(connection, _mode) {
      const route = routeFor(connection.routeKind);
      if (route === undefined) throw new RuntimeCommandError("protocol_unsupported", "unknown local route");
      await execute(route.binary, route.loginArgs);
      return {
        flowId: connection.id,
        status: "pending",
        verificationUrl: null,
        userCode: null,
        expiresAt: null,
      };
    },

    async discoverModels(connection) {
      const route = routeFor(connection.routeKind);
      if (route === undefined) return discoveryError("protocol_unsupported", false);
      try {
        const help = await execute(route.binary, ["models", "--help"]);
        if (advertisesJson(help.stdout, help.stderr)) {
          const output = await execute(route.binary, ["models", "--json"]);
          const models = parseRuntimeModels(output.stdout, connection, now);
          if (models === undefined) return discoveryError("model_discovery_unsupported", route.supportsRuntimeDefault);
          return { models, supportsRuntimeDefault: route.supportsRuntimeDefault };
        }
        if (route.routeKind === "xai-grok-build-local") {
          // The human table is an availability check only and is deliberately not parsed.
          await execute(route.binary, ["models"]);
          return discoveryError("model_discovery_unsupported", false);
        }
        if (route.routeKind === "claude-code-local") {
          return { models: [], supportsRuntimeDefault: true };
        }
        return discoveryError("model_discovery_unsupported", false);
      } catch (error) {
        return discoveryError(safeErrorCode(error), route.supportsRuntimeDefault);
      }
    },

    async probe(connection, selection) {
      return {
        id: randomUUID(),
        connectionId: connection.id,
        modelId: selection.modelId,
        protocol: connection.protocol,
        status: "failed",
        capabilities: unknownCapabilities(),
        errorCode: "protocol_unsupported",
        checkedAt: now().toISOString(),
      };
    },
  };
}

/** Fixed local route objects consumed by the registry; no route adds a model catalog. */
export function createLocalRouteAdapters(local: LocalRuntimeAdapter): RouteAdapter[] {
  return (Object.values(ROUTES) as RuntimeRouteSpec[]).map((route) => ({
    routeKind: route.routeKind,
    transport: "local-cli" as const,
    protocol: route.protocol,
    inspect: (connection) => local.inspect(connection),
    startAuth: (connection, mode) => local.startAuth(connection, mode),
    discoverModels: (connection) => local.discoverModels(connection),
    probe: (connection, selection) => local.probe(connection, selection),
  }));
}

function runtimeExecutor(
  dependencies: LocalRuntimeAdapterDependencies,
  cwd: string,
): (binary: string, argv: string[]) => Promise<RuntimeExecResult> {
  if (dependencies.execFile !== undefined) {
    return async (binary, argv) => {
      try {
        return await dependencies.execFile!(binary, argv);
      } catch (error) {
        throw asRuntimeCommandError(error);
      }
    };
  }
  const command = dependencies.command ?? createRuntimeCommand({ approvedCwds: [cwd] });
  return async (binary, argv) => {
    const output = await command.execute({ binary, argv, cwd });
    return { stdout: output.stdout, stderr: output.stderr };
  };
}

function asRuntimeCommandError(error: unknown): RuntimeCommandError {
  if (error instanceof RuntimeCommandError) return error;
  if (isErrno(error, "ENOENT")) return new RuntimeCommandError("runtime_missing", "runtime not found");
  return new RuntimeCommandError("provider_unreachable", "runtime command failed");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function routeFor(routeKind: string): RuntimeRouteSpec | undefined {
  return (Object.values(ROUTES) as RuntimeRouteSpec[]).find((route) => route.routeKind === routeKind);
}

function unavailable(reason: SafeProviderErrorCode, supportsRuntimeDefault: boolean): RouteInspection {
  return { available: false, reason, supportsRuntimeDefault };
}

function unsupportedRuntime(result: RuntimeExecResult): boolean {
  return /\b(?:unsupported|incompatible|requires)\b.{0,80}\b(?:version|runtime|node)\b/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

function discoveryError(
  code: SafeProviderErrorCode,
  supportsRuntimeDefault: boolean,
): DiscoveryResult {
  return { models: [], supportsRuntimeDefault, safeError: { code } };
}

function advertisesJson(stdout: string, stderr: string): boolean {
  return /(?:^|[^a-z0-9_-])--json(?:$|[^a-z0-9_-])/i.test(`${stdout}\n${stderr}`);
}

function parseRuntimeModels(
  stdout: string,
  connection: StoredProviderConnection,
  now: () => Date,
): ProviderModel[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const rows = Array.isArray(value)
    ? value
    : isPlainRecord(value) && Array.isArray(value.models)
      ? value.models
      : isPlainRecord(value) && Array.isArray(value.data)
        ? value.data
        : undefined;
  if (rows === undefined) return undefined;
  const discoveredAt = now().toISOString();
  const models: ProviderModel[] = [];
  for (const row of rows) {
    if (!isPlainRecord(row)) continue;
    const id = safeModelId(row.id);
    if (id === undefined) continue;
    models.push({
      connectionId: connection.id,
      id,
      displayName: safeDisplayName(row.displayName ?? row.name) ?? id,
      contextWindow: safeContextWindow(row.contextWindow ?? row.context_window),
      capabilities: unknownCapabilities(),
      pricing: null,
      discoveredAt,
      source: "runtime",
    });
  }
  return models;
}

function safeModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id.length > 0 && id.length <= 200 && !/[\u0000-\u001F\u007F]/.test(id) ? id : undefined;
}

function safeDisplayName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200
    ? value.trim()
    : undefined;
}

function safeContextWindow(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function unknownCapabilities(): ModelCapabilities {
  return {
    tools: "unknown",
    artifactOutput: "unknown",
    structuredOutput: "unknown",
    boundedExecution: "unknown",
    osIsolation: "unknown",
    streaming: "unknown",
    usage: "unknown",
    cancellation: "unknown",
  };
}

function safeErrorCode(error: unknown): SafeProviderErrorCode {
  return error instanceof RuntimeCommandError ? error.code : "provider_unreachable";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
