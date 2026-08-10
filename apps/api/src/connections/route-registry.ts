import { randomUUID } from "node:crypto";

import type {
  CapabilityReport,
  ModelCapabilities,
  ProviderModel,
  SafeProviderErrorCode,
} from "@csb/shared";
import {
  CodexAppServerStateStore,
  type StoredProviderConnection,
} from "../connections-store.js";
import {
  CodexAppServerBridge,
  CodexAppServerBridgeError,
  createCodexAppServerJsonRpc,
} from "./codex-app-server-bridge.js";
import {
  createLocalRouteAdapters,
  createLocalRuntimeAdapter,
  type LocalRuntimeAdapter,
} from "./local-runtime-adapters.js";
import type {
  DiscoveryResult,
  RouteAdapter,
  RouteInspection,
  SafeAuthFlow,
} from "./route-adapter.js";

/** Full public route vocabulary. Registration remains incremental by transport. */
export const ROUTE_KINDS = [
  "openai-codex-local", "openai-chatgpt-app-server", "openai-api",
  "xai-grok-build-local", "xai-oauth", "xai-api",
  "claude-code-local", "anthropic-api",
  "cursor-agent-local", "cursor-background-agents",
  "openrouter-api", "gemini-api", "deepseek-api",
  "minimax-token-plan", "mimo-token-plan",
  "custom-openai-compatible", "custom-anthropic-compatible",
] as const;

export type RouteKind = (typeof ROUTE_KINDS)[number];

export interface RouteManifest {
  routeKind: RouteKind;
  providerKind: string;
  transport: RouteAdapter["transport"];
  protocol: RouteAdapter["protocol"];
}

/** The only manifests registered in this sprint; HTTP registration belongs to Task 3 integration. */
export const LOCAL_ROUTE_MANIFESTS: readonly RouteManifest[] = Object.freeze([
  {
    routeKind: "openai-codex-local",
    providerKind: "openai",
    transport: "codex-app-server",
    protocol: "codex-app-server",
  },
  {
    routeKind: "openai-chatgpt-app-server",
    providerKind: "openai",
    transport: "codex-app-server",
    protocol: "codex-app-server",
  },
  {
    routeKind: "xai-grok-build-local",
    providerKind: "xai",
    transport: "local-cli",
    protocol: "grok-build-cli",
  },
  {
    routeKind: "claude-code-local",
    providerKind: "anthropic",
    transport: "local-cli",
    protocol: "claude-code-cli",
  },
  {
    routeKind: "cursor-agent-local",
    providerKind: "cursor",
    transport: "local-cli",
    protocol: "cursor-agent-cli",
  },
]);

export interface RouteRegistry {
  readonly manifests: readonly RouteManifest[];
  get(routeKind: string): RouteAdapter | undefined;
  list(): readonly RouteAdapter[];
  register(adapter: RouteAdapter): void;
}

export interface RouteRegistryDependencies {
  codex?: CodexAppServerBridge;
  local?: LocalRuntimeAdapter;
  now?: () => Date;
}

export function createRouteRegistry(
  dependencies: RouteRegistryDependencies = {},
): RouteRegistry {
  const adapters = new Map<string, RouteAdapter>();
  const now = dependencies.now ?? (() => new Date());
  const codex = dependencies.codex ?? new CodexAppServerBridge(
    createCodexAppServerJsonRpc(),
    { stateSink: new CodexAppServerStateStore() },
  );
  const local = dependencies.local ?? createLocalRuntimeAdapter();
  const registry: RouteRegistry = {
    manifests: LOCAL_ROUTE_MANIFESTS,
    get: (routeKind) => adapters.get(routeKind),
    list: () => [...adapters.values()],
    register(adapter) {
      if (adapters.has(adapter.routeKind)) throw new Error(`route already registered: ${adapter.routeKind}`);
      adapters.set(adapter.routeKind, adapter);
    },
  };
  registry.register(createCodexRouteAdapter("openai-codex-local", codex, now));
  registry.register(createCodexRouteAdapter("openai-chatgpt-app-server", codex, now));
  for (const adapter of createLocalRouteAdapters(local)) registry.register(adapter);
  return registry;
}

function createCodexRouteAdapter(
  routeKind: "openai-codex-local" | "openai-chatgpt-app-server",
  bridge: CodexAppServerBridge,
  now: () => Date,
): RouteAdapter {
  return {
    routeKind,
    transport: "codex-app-server",
    protocol: "codex-app-server",
    async inspect(): Promise<RouteInspection> {
      try {
        const account = await bridge.readAccount();
        return account.status === "ready"
          ? { available: true, reason: null, supportsRuntimeDefault: false }
          : {
            available: false,
            reason: account.status === "expired" ? "credential_expired" : "provider_unreachable",
            supportsRuntimeDefault: false,
          };
      } catch (error) {
        return {
          available: false,
          reason: safeBridgeCode(error),
          supportsRuntimeDefault: false,
        };
      }
    },
    ...(routeKind === "openai-chatgpt-app-server"
      ? {
        startAuth: async (
          _connection: StoredProviderConnection,
          mode: "browser-oauth" | "device-code",
        ): Promise<SafeAuthFlow> => {
          if (mode === "device-code") {
            const login = await bridge.startDeviceLogin();
            return {
              flowId: login.loginId,
              status: "pending",
              authUrl: null,
              verificationUrl: login.verificationUrl,
              userCode: login.userCode,
              expiresAt: null,
            };
          }
          const login = await bridge.startBrowserLogin();
          return {
            flowId: login.loginId,
            status: "pending",
            authUrl: login.authUrl,
            verificationUrl: null,
            userCode: null,
            expiresAt: null,
          };
        },
        cancelAuth: async (_connection: StoredProviderConnection, flowId: string) => {
          await bridge.cancelLogin(flowId);
        },
      }
      : {}),
    async discoverModels(connection): Promise<DiscoveryResult> {
      try {
        return {
          models: (await bridge.listModels()).map((model) => runtimeModel(connection, model, now)),
          supportsRuntimeDefault: false,
        };
      } catch (error) {
        return {
          models: [],
          supportsRuntimeDefault: false,
          safeError: { code: safeBridgeCode(error) },
        };
      }
    },
    async probe(connection, selection): Promise<CapabilityReport> {
      return {
        id: randomUUID(),
        connectionId: connection.id,
        modelId: selection.modelId,
        protocol: "codex-app-server",
        status: "failed",
        capabilities: unknownCapabilities(),
        errorCode: "protocol_unsupported",
        checkedAt: now().toISOString(),
      };
    },
  };
}

function runtimeModel(
  connection: StoredProviderConnection,
  model: { id: string; displayName: string },
  now: () => Date,
): ProviderModel {
  return {
    connectionId: connection.id,
    id: model.id,
    displayName: model.displayName,
    contextWindow: null,
    capabilities: unknownCapabilities(),
    pricing: null,
    discoveredAt: now().toISOString(),
    source: "runtime",
  };
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

function safeBridgeCode(error: unknown): SafeProviderErrorCode {
  return error instanceof CodexAppServerBridgeError ? error.code : "provider_unreachable";
}
