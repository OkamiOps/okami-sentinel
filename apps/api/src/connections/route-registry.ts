import { randomUUID } from "node:crypto";

import type {
  CapabilityReport,
  ConnectionAuthKind,
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
import {
  HTTP_ROUTE_KINDS,
  registerHttpRouteAdapters,
  type HttpRouteAdapterDependencies,
  type HttpRouteKind,
} from "./http-route-adapters.js";
import { createCursorBackgroundAgentsAdapter } from "./cursor-background-agents-adapter.js";
import {
  createCursorRouteAdapter,
  type CursorCatalogClient,
} from "./cursor-route-adapter.js";
import type { XaiOAuthRouteAdapter } from "./xai-oauth-adapter.js";
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
  authKinds: readonly ConnectionAuthKind[];
}

function immutableRouteManifest(manifest: RouteManifest): RouteManifest {
  return Object.freeze({
    ...manifest,
    authKinds: Object.freeze([...manifest.authKinds]),
  });
}

/** The only manifests registered in this sprint; HTTP registration belongs to Task 3 integration. */
export const LOCAL_ROUTE_MANIFESTS: readonly RouteManifest[] = Object.freeze([
  immutableRouteManifest({
    routeKind: "openai-codex-local",
    providerKind: "openai",
    transport: "codex-app-server",
    protocol: "codex-app-server",
    authKinds: ["existing-session"],
  }),
  immutableRouteManifest({
    routeKind: "openai-chatgpt-app-server",
    providerKind: "openai",
    transport: "codex-app-server",
    protocol: "codex-app-server",
    authKinds: ["browser-oauth", "device-code"],
  }),
  immutableRouteManifest({
    routeKind: "xai-grok-build-local",
    providerKind: "xai",
    transport: "local-cli",
    protocol: "grok-build-cli",
    authKinds: ["existing-session"],
  }),
  immutableRouteManifest({
    routeKind: "claude-code-local",
    providerKind: "anthropic",
    transport: "local-cli",
    protocol: "claude-code-cli",
    authKinds: ["existing-session"],
  }),
  immutableRouteManifest({
    routeKind: "cursor-agent-local",
    providerKind: "cursor",
    transport: "local-cli",
    protocol: "cursor-agent-cli",
    authKinds: ["existing-session"],
  }),
]);

const HTTP_ROUTE_MANIFESTS: Readonly<Record<HttpRouteKind, RouteManifest>> = Object.freeze({
  "openai-api": immutableRouteManifest({
    routeKind: "openai-api", providerKind: "openai", transport: "http-inference",
    protocol: "openai-responses", authKinds: ["api-key"],
  }),
  "xai-api": immutableRouteManifest({
    routeKind: "xai-api", providerKind: "xai", transport: "http-inference",
    protocol: "openai-responses", authKinds: ["api-key"],
  }),
  "anthropic-api": immutableRouteManifest({
    routeKind: "anthropic-api", providerKind: "anthropic", transport: "http-inference",
    protocol: "anthropic-messages", authKinds: ["api-key"],
  }),
  "openrouter-api": immutableRouteManifest({
    routeKind: "openrouter-api", providerKind: "openrouter", transport: "http-inference",
    protocol: "openai-chat", authKinds: ["api-key"],
  }),
  "gemini-api": immutableRouteManifest({
    routeKind: "gemini-api", providerKind: "google", transport: "http-inference",
    protocol: "openai-chat", authKinds: ["api-key"],
  }),
  "deepseek-api": immutableRouteManifest({
    routeKind: "deepseek-api", providerKind: "deepseek", transport: "http-inference",
    protocol: "openai-chat", authKinds: ["api-key"],
  }),
  "minimax-token-plan": immutableRouteManifest({
    routeKind: "minimax-token-plan", providerKind: "minimax", transport: "http-inference",
    protocol: "anthropic-messages", authKinds: ["api-key"],
  }),
  "mimo-token-plan": immutableRouteManifest({
    routeKind: "mimo-token-plan", providerKind: "xiaomi", transport: "http-inference",
    protocol: "openai-chat", authKinds: ["api-key"],
  }),
  "custom-openai-compatible": immutableRouteManifest({
    routeKind: "custom-openai-compatible", providerKind: "custom", transport: "http-inference",
    protocol: "openai-chat", authKinds: ["api-key", "custom-headers"],
  }),
  "custom-anthropic-compatible": immutableRouteManifest({
    routeKind: "custom-anthropic-compatible", providerKind: "custom", transport: "http-inference",
    protocol: "anthropic-messages", authKinds: ["api-key", "custom-headers"],
  }),
});

const REMOTE_ROUTE_MANIFESTS: readonly RouteManifest[] = Object.freeze([
  immutableRouteManifest({
    routeKind: "cursor-background-agents",
    providerKind: "cursor",
    transport: "remote-agent-api",
    protocol: "cursor-background-agents",
    authKinds: ["api-key"],
  }),
]);

const XAI_OAUTH_ROUTE_MANIFEST = immutableRouteManifest({
  routeKind: "xai-oauth",
  providerKind: "xai",
  transport: "http-inference",
  protocol: "xai-oauth-responses",
  authKinds: ["device-code"],
});

export interface RouteRegistry {
  readonly manifests: readonly RouteManifest[];
  get(routeKind: string): RouteAdapter | undefined;
  getManifest(routeKind: string): RouteManifest | undefined;
  list(): readonly RouteAdapter[];
  register(adapter: RouteAdapter): void;
}

export interface RouteRegistryDependencies {
  codex?: CodexAppServerBridge;
  local?: LocalRuntimeAdapter;
  now?: () => Date;
  vault?: HttpRouteAdapterDependencies["vault"];
  resolveModel?: HttpRouteAdapterDependencies["resolveModel"];
  http?: Omit<HttpRouteAdapterDependencies, "vault" | "resolveModel" | "now">;
  cursor?: CursorCatalogClient;
  /** Sentinel-orchestrated device flow. This route never falls back to Grok Build. */
  xaiOAuth?: XaiOAuthRouteAdapter;
}

export function createRouteRegistry(
  dependencies: RouteRegistryDependencies = {},
): RouteRegistry {
  const adapters = new Map<string, RouteAdapter>();
  const availableManifests = Object.freeze([
      ...LOCAL_ROUTE_MANIFESTS,
      ...(dependencies.vault === undefined
        ? []
        : [
          ...HTTP_ROUTE_KINDS.map((routeKind) => HTTP_ROUTE_MANIFESTS[routeKind]),
          ...REMOTE_ROUTE_MANIFESTS,
        ]),
      ...(dependencies.xaiOAuth === undefined ? [] : [XAI_OAUTH_ROUTE_MANIFEST]),
    ]);
  const manifests = new Map<string, RouteManifest>(
    availableManifests.map((manifest) => [manifest.routeKind, manifest]),
  );
  const now = dependencies.now ?? (() => new Date());
  const codex = dependencies.codex ?? new CodexAppServerBridge(
    createCodexAppServerJsonRpc(),
    { stateSink: new CodexAppServerStateStore() },
  );
  const local = dependencies.local ?? createLocalRuntimeAdapter();
  const registry: RouteRegistry = {
    manifests: availableManifests,
    get: (routeKind) => adapters.get(routeKind),
    getManifest: (routeKind) => manifests.get(routeKind),
    list: () => [...adapters.values()],
    register(adapter) {
      const manifest = manifests.get(adapter.routeKind);
      if (
        manifest === undefined ||
        manifest.transport !== adapter.transport ||
        manifest.protocol !== adapter.protocol
      ) throw new Error(`route manifest mismatch: ${adapter.routeKind}`);
      if (adapters.has(adapter.routeKind)) throw new Error(`route already registered: ${adapter.routeKind}`);
      adapters.set(adapter.routeKind, adapter);
    },
  };
  registry.register(createCodexRouteAdapter("openai-codex-local", codex, now));
  registry.register(createCodexRouteAdapter("openai-chatgpt-app-server", codex, now));
  for (const adapter of createLocalRouteAdapters(local)) registry.register(adapter);
  if (dependencies.vault !== undefined) {
    registerHttpRouteAdapters(registry.register, {
      ...dependencies.http,
      vault: dependencies.vault,
      resolveModel: dependencies.resolveModel,
      now,
    });
    registry.register(createCursorRouteAdapter({
      vault: dependencies.vault,
      client: dependencies.cursor ?? createCursorBackgroundAgentsAdapter(),
      now,
    }));
  }
  if (dependencies.xaiOAuth !== undefined) registry.register(dependencies.xaiOAuth);
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
            reason: account.status === "expired"
              ? "credential_expired"
              : account.status === "authentication-required"
                ? "credential_rejected"
                : "provider_unreachable",
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
        getAuth: async (_connection: StoredProviderConnection, flowId: string): Promise<SafeAuthFlow | null> => {
          const flow = bridge.getLoginFlow(flowId);
          return flow === null ? null : {
            flowId: flow.flowId,
            status: flow.status,
            authUrl: null,
            verificationUrl: null,
            userCode: null,
            expiresAt: null,
          };
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
  model: { id: string; displayName: string; reasoningEffort?: ProviderModel["reasoningEffort"] },
  now: () => Date,
): ProviderModel {
  return {
    connectionId: connection.id,
    id: model.id,
    displayName: model.displayName,
    contextWindow: null,
    capabilities: unknownCapabilities(),
    pricing: null,
    ...(model.reasoningEffort === undefined ? {} : {
      reasoningEffort: {
        options: [...model.reasoningEffort.options],
        default: model.reasoningEffort.default,
      },
    }),
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
