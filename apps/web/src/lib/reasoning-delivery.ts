import type { ProviderConnection, ProviderProtocol, ScanRun } from "@csb/shared";

export type ReasoningDelivery =
  | { kind: "provider-default"; effort: null; wire: null }
  | { kind: "sent"; effort: string; wire: string };

export function reasoningDeliveryCopy(delivery: ReasoningDelivery): {
  key: "reasoning.sent" | "reasoning.providerDefault";
  variables?: Record<string, string>;
} {
  return delivery.kind === "sent"
    ? { key: "reasoning.sent", variables: { effort: delivery.effort, wire: delivery.wire } }
    : { key: "reasoning.providerDefault" };
}

export function reasoningWireField(
  routeKind: string,
  protocol: ProviderProtocol,
): string | null {
  if (protocol === "codex-cli") return "Codex CLI config";
  if (protocol === "codex-app-server") return "turn/start.effort";
  switch (routeKind) {
    case "openai-api":
      return protocol === "openai-responses" ? "reasoning.effort"
        : protocol === "openai-chat" ? "reasoning_effort" : null;
    case "xai-api":
    case "xai-oauth":
    case "openrouter-api":
      return protocol === "openai-responses" || protocol === "xai-oauth-responses" ||
          protocol === "openai-chat"
        ? "reasoning.effort"
        : null;
    case "anthropic-api":
      return protocol === "anthropic-messages" ? "output_config.effort" : null;
    case "gemini-api":
      return protocol === "openai-chat" ? "reasoning_effort" : null;
    default:
      return null;
  }
}

export function connectionReasoningDelivery(
  connection: Pick<ProviderConnection, "routeKind" | "protocol"> | null,
  effort: string | null,
): ReasoningDelivery {
  if (effort === null || connection === null) {
    return { kind: "provider-default", effort: null, wire: null };
  }
  return {
    kind: "sent",
    effort,
    wire: reasoningWireField(connection.routeKind, connection.protocol) ?? "launch adapter",
  };
}

export function scanReasoningDelivery(
  scan: Pick<ScanRun, "effort" | "connection" | "execution">,
): ReasoningDelivery {
  if (scan.effort === null) return { kind: "provider-default", effort: null, wire: null };
  const routeKind = scan.connection?.routeKind ?? scan.execution?.routeKind;
  const protocol = scan.connection?.protocol ?? scan.execution?.protocol;
  return {
    kind: "sent",
    effort: scan.effort,
    wire: routeKind !== null && routeKind !== undefined && protocol !== null && protocol !== undefined
      ? reasoningWireField(routeKind, protocol) ?? "launch adapter"
      : "launch adapter",
  };
}
