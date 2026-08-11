import type { ProviderProtocol } from "@csb/shared";

import { isHttpAgentRouteProtocolSupported } from "../agent/http-agent-upstream.js";

export const PORTABLE_CODEX_SECURITY_PROFILE_VERSION =
  "sentinel-codex-security-portable-v1" as const;

export const PORTABLE_CODEX_SECURITY_METHODOLOGY_REF =
  "sentinel/codex-security-methodology@v1" as const;

export interface SafePortableCodexSecurityProviderPlan {
  scanId: string;
  connectionId: string;
  routeKind: string;
  protocol: Extract<ProviderProtocol,
    | "openai-responses"
    | "openai-chat"
    | "anthropic-messages"
    | "xai-oauth-responses">;
  modelId: string;
  capabilityCheckId: string;
  profileVersion: typeof PORTABLE_CODEX_SECURITY_PROFILE_VERSION;
  methodologyRef: typeof PORTABLE_CODEX_SECURITY_METHODOLOGY_REF;
}

/**
 * Closed Portable contract. HTTP support alone does not authorize a route for
 * the Portable Codex Security methodology.
 */
export function isPortableCodexSecurityRoute(
  routeKind: string,
  protocol: ProviderProtocol,
): protocol is SafePortableCodexSecurityProviderPlan["protocol"] {
  if (!isHttpAgentRouteProtocolSupported(routeKind, protocol)) return false;
  switch (routeKind) {
    case "openrouter-api":
    case "gemini-api":
    case "deepseek-api":
    case "mimo-token-plan":
    case "custom-openai-compatible":
      return protocol === "openai-chat";
    case "anthropic-api":
    case "minimax-token-plan":
    case "custom-anthropic-compatible":
      return protocol === "anthropic-messages";
    case "xai-api":
      return protocol === "openai-responses";
    case "xai-oauth":
      return protocol === "xai-oauth-responses";
    default:
      return false;
  }
}

export class PortableCodexSecurityProviderPlanError extends Error {
  constructor() {
    super("portable_codex_security_provider_plan_invalid");
    this.name = "PortableCodexSecurityProviderPlanError";
  }
}

/**
 * Copies the immutable identifiers that a Portable worker may revalidate. It
 * deliberately drops every caller-controlled property outside this closed plan.
 */
export function createSafePortableCodexSecurityProviderPlan(
  value: unknown,
): SafePortableCodexSecurityProviderPlan {
  if (!isRecord(value)) throw new PortableCodexSecurityProviderPlanError();

  const {
    scanId,
    connectionId,
    routeKind,
    protocol,
    modelId,
    capabilityCheckId,
    profileVersion,
    methodologyRef,
  } = value;
  if (
    !isIdentifier(scanId) ||
    !isIdentifier(connectionId) ||
    !isIdentifier(routeKind) ||
    !isIdentifier(modelId) ||
    !isIdentifier(capabilityCheckId) ||
    !isPortableProtocol(protocol) ||
    !isPortableCodexSecurityRoute(routeKind, protocol) ||
    profileVersion !== PORTABLE_CODEX_SECURITY_PROFILE_VERSION ||
    methodologyRef !== PORTABLE_CODEX_SECURITY_METHODOLOGY_REF
  ) {
    throw new PortableCodexSecurityProviderPlanError();
  }

  return {
    scanId,
    connectionId,
    routeKind,
    protocol,
    modelId,
    capabilityCheckId,
    profileVersion: PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
    methodologyRef: PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPortableProtocol(
  value: unknown,
): value is SafePortableCodexSecurityProviderPlan["protocol"] {
  return value === "openai-responses" ||
    value === "openai-chat" ||
    value === "anthropic-messages" ||
    value === "xai-oauth-responses";
}
