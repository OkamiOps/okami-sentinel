import {
  reasoningWireFieldForRoute,
  type ProviderConnection,
  type ProviderProtocol,
  type ScanRun,
} from "@csb/shared";

export type ReasoningDelivery =
  | { kind: "provider-default"; effort: null; wire: null }
  | { kind: "legacy-unverified"; effort: string; wire: null }
  | { kind: "sent"; effort: string; wire: string };

export function reasoningDeliveryCopy(delivery: ReasoningDelivery): {
  key: "reasoning.sent" | "reasoning.providerDefault" | "reasoning.legacyUnverified";
  variables?: Record<string, string>;
} {
  if (delivery.kind === "sent") {
    return { key: "reasoning.sent", variables: { effort: delivery.effort, wire: delivery.wire } };
  }
  return delivery.kind === "legacy-unverified"
    ? { key: "reasoning.legacyUnverified", variables: { effort: delivery.effort } }
    : { key: "reasoning.providerDefault" };
}

export function reasoningWireField(
  routeKind: string,
  protocol: ProviderProtocol,
): string | null {
  return reasoningWireFieldForRoute(routeKind, protocol);
}

export function connectionReasoningDelivery(
  connection: Pick<ProviderConnection, "routeKind" | "protocol"> | null,
  effort: string | null,
): ReasoningDelivery {
  if (effort === null || connection === null) {
    return { kind: "provider-default", effort: null, wire: null };
  }
  const wire = reasoningWireField(connection.routeKind, connection.protocol);
  return wire === null
    ? { kind: "legacy-unverified", effort, wire: null }
    : { kind: "sent", effort, wire };
}

export function scanReasoningDelivery(
  scan: Pick<ScanRun, "effort" | "connection" | "execution" | "launchSelection">,
): ReasoningDelivery {
  const frozen = scan.launchSelection?.reasoning;
  if (frozen !== undefined) return frozen;
  return scan.effort === null
    ? { kind: "provider-default", effort: null, wire: null }
    : { kind: "legacy-unverified", effort: scan.effort, wire: null };
}
