import type {
  ScanConnectionSelection,
  StartScanRequest,
} from "@csb/shared";

import type {
  LaunchPlanResolver,
  ScanLaunchPlan,
} from "../connections/launch-plan.js";
import { isHttpAgentRouteProtocolSupported } from "../agent/http-agent-upstream.js";

const SCOPED_CODEX_SECURITY_SESSION_ROUTES = new Set([
  "openai-codex-local",
  "openai-chatgpt-app-server",
]);

const VULNHUNTER_HTTP_PROTOCOLS = new Set([
  "openai-responses",
  "openai-chat",
  "anthropic-messages",
]);

const VULNHUNTER_XAI_OAUTH_PROTOCOL = "xai-oauth-responses";

/** Safe, stable launch boundary errors. They intentionally reveal no route or credential details. */
export type ScanSelectionErrorCode =
  | "provider_runner_unavailable"
  | "provider_model_unavailable";

export class ScanSelectionError extends Error {
  constructor(readonly code: ScanSelectionErrorCode) {
    super(code);
    this.name = "ScanSelectionError";
  }
}

export interface ResolveScanLaunchSelectionInput {
  request: StartScanRequest;
  scanId: string;
  launchPlans: LaunchPlanResolver;
}

export interface ResolvedScanLaunchSelection {
  /** Request normalized from immutable server-side connection metadata. */
  request: StartScanRequest;
  /** Null preserves the legacy scanner catalog's model fallback behavior. */
  model: string | null;
  plan: ScanLaunchPlan | null;
  connectionAware: boolean;
}

export interface ResolveBeforeLaunchInput<T> extends ResolveScanLaunchSelectionInput {
  /**
   * The only place allowed to create output/configuration or spawn a scanner.
   * It is intentionally invoked after connection resolution succeeds.
   */
  prepareLaunch: (selection: ResolvedScanLaunchSelection) => T;
}

export interface ResolvedBeforeLaunch<T> {
  selection: ResolvedScanLaunchSelection;
  launch: T;
}

/**
 * Converts an untrusted connection selection into a launchable request. It
 * deliberately does not read credentials, write a worker config, or start a
 * process. The launch-plan resolver owns exactly one immutable snapshot write.
 */
export function resolveScanLaunchSelection(
  input: ResolveScanLaunchSelectionInput,
): ResolvedScanLaunchSelection {
  const selection = input.request.connection;
  if (selection === undefined) {
    return {
      request: input.request,
      model: null,
      plan: null,
      connectionAware: false,
    };
  }

  const plan = input.launchPlans.resolve({
    scanId: input.scanId,
    engine: input.request.engine ?? "codex-security",
    selection: selectionForResolver(selection),
    remoteRepositoryConfirmed: input.request.remoteRepositoryConfirmed,
  });

  if (plan.runnerKind === "agent-session") {
    if (isMantisHttpAgentPlan(plan)) {
      return {
        request: {
          ...input.request,
          provider: plan.providerKind,
          model: plan.model!.id,
          // Accounting metadata only. The selected worker reads the native
          // vault after revalidating the immutable server plan.
          authMode: "api-key",
        },
        model: plan.model!.id,
        plan,
        connectionAware: true,
      };
    }
    if (isVulnHunterHttpPlan(input.request, plan)) {
      const { authMode: _untrustedAuthMode, ...request } = input.request;
      return {
        request: {
          ...request,
          provider: plan.providerKind,
          model: plan.model!.id,
        },
        model: plan.model!.id,
        plan,
        connectionAware: true,
      };
    }
    throw new ScanSelectionError("provider_runner_unavailable");
  }
  if (plan.runnerKind === "remote-agent-job") {
    throw new ScanSelectionError("provider_runner_unavailable");
  }
  if (
    plan.runnerKind === "codex-security-contract" &&
    !SCOPED_CODEX_SECURITY_SESSION_ROUTES.has(plan.routeKind)
  ) {
    throw new ScanSelectionError("provider_runner_unavailable");
  }
  if (plan.model === null || plan.scannerAuthMode === undefined) {
    throw new ScanSelectionError("provider_model_unavailable");
  }

  return {
    request: {
      ...input.request,
      provider: plan.providerKind,
      model: plan.model.id,
      authMode: plan.scannerAuthMode,
    },
    model: plan.model.id,
    plan,
    connectionAware: true,
  };
}

function isMantisHttpAgentPlan(plan: ScanLaunchPlan): boolean {
  const directXaiOAuth = plan.providerKind === "xai" &&
    plan.routeKind === "xai-oauth" &&
    plan.protocol === "xai-oauth-responses";
  return plan.engine === "mantis" &&
    plan.model !== null &&
    typeof plan.capabilityCheckId === "string" &&
    plan.capabilityCheckId.length > 0 &&
    isHttpAgentRouteProtocolSupported(plan.routeKind, plan.protocol) &&
    (directXaiOAuth || (plan.routeKind !== "xai-oauth" && plan.protocol !== "xai-oauth-responses"));
}

/**
 * The child runner re-validates this immutable reference before it reads the
 * vault. This gate only decides whether a corresponding worker may be spawned.
 */
function isVulnHunterHttpPlan(
  request: StartScanRequest,
  plan: ScanLaunchPlan,
): boolean {
  return (request.engine ?? "codex-security") === "vulnhunter" &&
    plan.model !== null &&
    plan.capabilityCheckId !== null &&
    plan.snapshot.modelSelectionMode === "catalog" &&
    plan.snapshot.modelId === plan.model.id &&
    plan.snapshot.capabilityCheckId === plan.capabilityCheckId &&
    plan.snapshot.connectionId === plan.connectionId &&
    plan.snapshot.routeKind === plan.routeKind &&
    (VULNHUNTER_HTTP_PROTOCOLS.has(plan.protocol) ||
      (plan.protocol === VULNHUNTER_XAI_OAUTH_PROTOCOL &&
        plan.providerKind === "xai" &&
        plan.routeKind === "xai-oauth"));
}

/**
 * Enforces the ordering boundary used by the runner: provider runner failures
 * cannot leave an output directory, generated worker configuration, or child
 * process behind because the callback is reached only after resolution.
 */
export function resolveBeforeLaunch<T>(
  input: ResolveBeforeLaunchInput<T>,
): ResolvedBeforeLaunch<T> {
  const selection = resolveScanLaunchSelection(input);
  return { selection, launch: input.prepareLaunch(selection) };
}

/** Isolates the exact DTO copied from the request before it crosses into persistence. */
function selectionForResolver(selection: ScanConnectionSelection): ScanConnectionSelection {
  return {
    connectionId: selection.connectionId,
    modelSelectionMode: selection.modelSelectionMode,
    modelId: selection.modelId,
  };
}
