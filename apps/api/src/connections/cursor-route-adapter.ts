import { randomUUID } from "node:crypto";

import type {
  CapabilityReport,
  ModelCapabilities,
  ProviderModel,
  SafeProviderErrorCode,
  ScanConnectionSelection,
} from "@csb/shared";
import type { StoredProviderConnection } from "../connections-store.js";
import { VaultError, type CredentialVault } from "../credentials/credential-vault.js";
import {
  CursorBackgroundAgentsError,
  type CursorBackgroundAgentsAdapter,
} from "./cursor-background-agents-adapter.js";
import type { DiscoveryResult, RouteAdapter, RouteInspection } from "./route-adapter.js";

export type CursorCatalogClient = Pick<CursorBackgroundAgentsAdapter, "listModels">;

export interface CursorRouteAdapterDependencies {
  vault: CredentialVault;
  client: CursorCatalogClient;
  now?: () => Date;
}

export function createCursorRouteAdapter(
  deps: CursorRouteAdapterDependencies,
): RouteAdapter {
  const now = deps.now ?? (() => new Date());
  return {
    routeKind: "cursor-background-agents",
    transport: "remote-agent-api",
    protocol: "cursor-background-agents",
    async inspect(connection): Promise<RouteInspection> {
      try {
        assertCursorConnection(connection);
        await readApiKey(connection, deps.vault);
        return { available: true, reason: null, supportsRuntimeDefault: false };
      } catch (error) {
        return {
          available: false,
          reason: safeErrorCode(error),
          supportsRuntimeDefault: false,
        };
      }
    },
    async discoverModels(connection): Promise<DiscoveryResult> {
      try {
        assertCursorConnection(connection);
        const apiKey = await readApiKey(connection, deps.vault);
        const discoveredAt = now().toISOString();
        const models = await deps.client.listModels({ apiKey });
        return {
          models: models.map((model): ProviderModel => ({
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
            discoveredAt,
            source: "provider-api",
          })),
          supportsRuntimeDefault: false,
        };
      } catch (error) {
        return {
          models: [],
          supportsRuntimeDefault: false,
          safeError: { code: safeErrorCode(error) },
        };
      }
    },
    async probe(
      connection: StoredProviderConnection,
      selection: ScanConnectionSelection,
    ): Promise<CapabilityReport> {
      const checkedAt = now().toISOString();
      const modelId = selection.modelId;
      try {
        assertCursorConnection(connection);
        if (
          selection.connectionId !== connection.id ||
          selection.modelSelectionMode !== "catalog" ||
          modelId === null
        ) throw new CursorBackgroundAgentsError("protocol_unsupported");
        const apiKey = await readApiKey(connection, deps.vault);
        const models = await deps.client.listModels({ apiKey });
        if (!models.some((model) => model.id === modelId)) {
          return report(connection, modelId, checkedAt, "failed", "model_access_denied");
        }
        return report(connection, modelId, checkedAt, "passed", null);
      } catch (error) {
        return report(connection, modelId, checkedAt, "failed", safeErrorCode(error));
      }
    },
  };
}

function report(
  connection: StoredProviderConnection,
  modelId: string | null,
  checkedAt: string,
  status: "passed" | "failed",
  errorCode: SafeProviderErrorCode | null,
): CapabilityReport {
  return {
    id: randomUUID(),
    connectionId: connection.id,
    modelId,
    protocol: "cursor-background-agents",
    status,
    capabilities: unknownCapabilities(),
    errorCode,
    checkedAt,
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

function assertCursorConnection(connection: StoredProviderConnection): void {
  if (
    connection.providerKind !== "cursor" ||
    connection.routeKind !== "cursor-background-agents" ||
    connection.transport !== "remote-agent-api" ||
    connection.authKind !== "api-key" ||
    connection.protocol !== "cursor-background-agents"
  ) throw new CursorBackgroundAgentsError("protocol_unsupported");
}

async function readApiKey(
  connection: StoredProviderConnection,
  vault: CredentialVault,
): Promise<string> {
  if (connection.credentialRef === null) throw new VaultError("credential_not_found");
  const bundle = await vault.get(connection.credentialRef);
  if (typeof bundle.apiKey !== "string" || bundle.apiKey.length === 0) {
    throw new VaultError("credential_not_found");
  }
  return bundle.apiKey;
}

function safeErrorCode(error: unknown): SafeProviderErrorCode {
  if (error instanceof CursorBackgroundAgentsError) {
    if (error.code === "run_not_cancellable") return "protocol_unsupported";
    return error.code;
  }
  if (error instanceof VaultError) {
    return error.code === "credential_not_found"
      ? "credential_rejected"
      : "secure_storage_unavailable";
  }
  return "provider_unreachable";
}
