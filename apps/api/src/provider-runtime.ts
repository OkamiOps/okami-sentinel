import type Database from "better-sqlite3";

import { ConnectionStore } from "./connections-store.js";
import {
  createConnectionsService,
  type ConnectionsService,
} from "./connections-service.js";
import {
  createAuthFlowService,
  type AuthFlowService,
} from "./connections/auth-flow-service.js";
import {
  createLaunchPlanResolver,
  type LaunchPlanResolver,
} from "./connections/launch-plan.js";
import {
  createRouteRegistry,
  type RouteRegistry,
  type RouteRegistryDependencies,
} from "./connections/route-registry.js";
import { createHttpProbeSession } from "./agent/http-agent-upstream.js";
import { createXaiOAuthAdapter } from "./connections/xai-oauth-adapter.js";
import {
  createXaiOAuthFlow,
  createXaiOAuthHttpTransport,
  type XaiOAuthFlow,
  type XaiOAuthCredentialStore,
  type XaiOAuthTransport,
} from "./connections/xai-oauth-flow.js";
import type { CredentialVault, SecretRedactorRegistry } from "./credentials/credential-vault.js";
import { createSystemCredentialVault } from "./credentials/system-credential-vault.js";
import { SystemXaiOAuthCredentialStore } from "./credentials/system-xai-oauth-credential-store.js";
import { globalSecretRedactor } from "./redaction.js";

export interface ProviderRuntime {
  vault: CredentialVault;
  store: ConnectionStore;
  routes: RouteRegistry;
  connections: ConnectionsService;
  authFlows: AuthFlowService;
  launchPlans: LaunchPlanResolver;
  /** Server-internal only: the worker uses it after immutable-plan validation. */
  xaiOAuthTokenResolver: Pick<XaiOAuthFlow, "getAccessToken">;
}

export interface ProviderRuntimeDependencies {
  database?: Database.Database;
  vault?: CredentialVault;
  xaiCredentialStore?: XaiOAuthCredentialStore;
  xaiTransport?: XaiOAuthTransport;
  oauthSleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  redactor?: SecretRedactorRegistry;
  now?: () => Date;
  routeDependencies?: Pick<RouteRegistryDependencies, "codex" | "local" | "http" | "cursor">;
}

/**
 * One composition root owns metadata, native credentials, auth flows, model
 * catalogs, capability reports, and immutable scan launch snapshots.
 */
export function createProviderRuntime(
  dependencies: ProviderRuntimeDependencies = {},
): ProviderRuntime {
  const redactor = dependencies.redactor ?? globalSecretRedactor;
  const vault = dependencies.vault ?? createSystemCredentialVault({ redactor });
  const store = new ConnectionStore(dependencies.database);
  const xaiCredentialStore = dependencies.xaiCredentialStore ??
    new SystemXaiOAuthCredentialStore({ redactor });
  const xaiFlow = createXaiOAuthFlow({
    transport: dependencies.xaiTransport ?? createXaiOAuthHttpTransport(),
    credentialStore: xaiCredentialStore,
    redactor,
    now: dependencies.now,
    sleep: dependencies.oauthSleep,
  });
  const configuredHttp = dependencies.routeDependencies?.http;
  const probeSession = configuredHttp?.probeSession ?? createHttpProbeSession({
    transport: configuredHttp?.transport,
  });
  const xaiOAuth = createXaiOAuthAdapter({
    flow: xaiFlow,
    redactor,
    now: dependencies.now,
    resolveModel: (connectionId, modelId) => store.getModel(connectionId, modelId),
    probeSession,
  });
  const routes = createRouteRegistry({
    ...dependencies.routeDependencies,
    vault,
    resolveModel: (connectionId, modelId) => store.getModel(connectionId, modelId),
    now: dependencies.now,
    xaiOAuth,
    http: {
      ...configuredHttp,
      redactor,
      probeSession,
    },
  });
  const connections = createConnectionsService({
    vault,
    store,
    catalog: store,
    routes,
  });
  const authFlows = createAuthFlowService({ connections: store, routes });
  const launchPlans = createLaunchPlanResolver({
    getConnection: (id) => store.get(id),
    getModel: (connectionId, modelId) => store.getModel(connectionId, modelId),
    getLatestCapabilityCheck: (connectionId, modelId, protocol) =>
      store.getLatestCapabilityCheck(connectionId, modelId, protocol),
    writeSnapshot: (snapshot) => store.writeSnapshot(snapshot),
    now: dependencies.now,
  });

  return {
    vault,
    store,
    routes,
    connections,
    authFlows,
    launchPlans,
    xaiOAuthTokenResolver: {
      getAccessToken: (connectionId, signal) => xaiFlow.getAccessToken(connectionId, signal),
    },
  };
}

let processRuntime: ProviderRuntime | undefined;

export function getProviderRuntime(): ProviderRuntime {
  processRuntime ??= createProviderRuntime();
  return processRuntime;
}
