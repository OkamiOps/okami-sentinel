import type {
  CapabilityReport,
  ConnectionTransport,
  ProviderModel,
  ProviderProtocol,
  SafeProviderError,
  ScanConnectionSelection,
} from "@csb/shared";
import type { StoredProviderConnection } from "../connections-store.js";

/** Safe facts discovered without exposing route credentials or vault contents. */
export interface RouteInspection {
  available: boolean;
  reason: string | null;
  supportsRuntimeDefault: boolean;
}

/** Public state for an adapter-managed authentication journey. */
export interface SafeAuthFlow {
  flowId: string;
  status: "pending" | "completed" | "cancelled" | "expired" | "denied" | "failed";
  /** Ephemeral browser handoff URL. It is never persisted by an adapter. */
  authUrl?: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: string | null;
}

export interface DiscoveryResult {
  models: readonly ProviderModel[];
  supportsRuntimeDefault: boolean;
  /** Stable outcome code; never an upstream diagnostic or credential-bearing message. */
  safeError?: SafeProviderError;
}

/**
 * Protocol-only adapter boundary. Implementations access vault data internally;
 * this contract never carries endpoints, headers, credentials, or model manifests.
 */
export interface RouteAdapter {
  readonly routeKind: string;
  readonly transport: ConnectionTransport;
  readonly protocol: ProviderProtocol;
  inspect(connection: StoredProviderConnection): Promise<RouteInspection>;
  startAuth?(
    connection: StoredProviderConnection,
    mode: "browser-oauth" | "device-code",
  ): Promise<SafeAuthFlow>;
  cancelAuth?(connection: StoredProviderConnection, flowId: string): Promise<void>;
  discoverModels(connection: StoredProviderConnection): Promise<DiscoveryResult>;
  probe(
    connection: StoredProviderConnection,
    selection: ScanConnectionSelection,
  ): Promise<CapabilityReport>;
}
