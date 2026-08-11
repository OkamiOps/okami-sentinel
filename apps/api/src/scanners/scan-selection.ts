import type {
  ScanConnectionSelection,
  StartScanRequest,
} from "@csb/shared";

import type {
  LaunchPlanResolver,
  ScanLaunchPlan,
} from "../connections/launch-plan.js";
import { isHttpAgentRouteProtocolSupported } from "../agent/http-agent-upstream.js";
import { isCodexSecurityApiPlan } from "./codex-security-api-bridge.js";
import {
  createSafePortableCodexSecurityProviderPlan,
  PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
  PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
} from "./portable-codex-security-profile.js";

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
    ...(input.request.executionProfilePreference === undefined
      ? {}
      : { executionProfilePreference: input.request.executionProfilePreference }),
  });
  const request = normalizeReasoningEffort(input.request, plan.model);

  if (plan.runnerKind === "agent-session") {
    if (isMantisHttpAgentPlan(plan)) {
      return {
        request: {
          ...request,
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
    if (isVulnHunterHttpPlan(request, plan)) {
      const { authMode: _untrustedAuthMode, ...safeRequest } = request;
      return {
        request: {
          ...safeRequest,
          provider: plan.providerKind,
          model: plan.model!.id,
        },
        model: plan.model!.id,
        plan,
        connectionAware: true,
      };
    }
    if (isPortableCodexSecurityPlan(request, plan)) {
      const {
        authMode: _untrustedAuthMode,
        provider: _untrustedProvider,
        model: _untrustedModel,
        ...safeRequest
      } = request;
      return {
        request: {
          ...safeRequest,
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
  if (plan.runnerKind === "local-agent-session") {
    return selectClaudeCodeLocalMantis(request, plan);
  }
  if (plan.runnerKind === "remote-agent-job") {
    throw new ScanSelectionError("provider_runner_unavailable");
  }
  if (
    plan.runnerKind === "codex-security-contract" &&
    !SCOPED_CODEX_SECURITY_SESSION_ROUTES.has(plan.routeKind) &&
    !isCodexSecurityApiPlan(plan)
  ) {
    throw new ScanSelectionError("provider_runner_unavailable");
  }
  if (plan.model === null || plan.scannerAuthMode === undefined) {
    throw new ScanSelectionError("provider_model_unavailable");
  }

  return {
    request: {
      ...request,
      provider: plan.providerKind,
      model: plan.model.id,
      authMode: plan.scannerAuthMode,
    },
    model: plan.model.id,
    plan,
    connectionAware: true,
  };
}

/**
 * This is intentionally narrower than generic HTTP compatibility: a Portable
 * worker is available only for its fully pinned Codex Security execution
 * contract. The child repeats this check before it reads vault/network state.
 */
function isPortableCodexSecurityPlan(
  request: StartScanRequest,
  plan: ScanLaunchPlan,
): boolean {
  if (
    (request.engine ?? "codex-security") !== "codex-security" ||
    plan.engine !== "codex-security" ||
    plan.runnerKind !== "agent-session" ||
    plan.model === null ||
    plan.capabilityCheckId === null ||
    plan.execution?.executionProfile !== "portable" ||
    plan.execution.profileVersion !== PORTABLE_CODEX_SECURITY_PROFILE_VERSION ||
    plan.execution.methodologyRef !== PORTABLE_CODEX_SECURITY_METHODOLOGY_REF ||
    plan.execution.capabilityCheckId !== plan.capabilityCheckId ||
    plan.execution.connectionId !== plan.connectionId ||
    plan.execution.routeKind !== plan.routeKind ||
    plan.execution.protocol !== plan.protocol ||
    plan.snapshot.scanId.length === 0 ||
    plan.snapshot.connectionId !== plan.connectionId ||
    plan.snapshot.routeKind !== plan.routeKind ||
    plan.snapshot.modelSelectionMode !== "catalog" ||
    plan.snapshot.modelId !== plan.model.id ||
    plan.snapshot.capabilityCheckId !== plan.capabilityCheckId ||
    plan.snapshot.executionProfile !== "portable" ||
    plan.snapshot.profileVersion !== PORTABLE_CODEX_SECURITY_PROFILE_VERSION ||
    plan.snapshot.methodologyRef !== PORTABLE_CODEX_SECURITY_METHODOLOGY_REF ||
    plan.snapshot.protocol !== plan.protocol ||
    plan.snapshot.authKind !== plan.execution.authKind
  ) return false;
  try {
    const safe = createSafePortableCodexSecurityProviderPlan({
      scanId: plan.snapshot.scanId,
      connectionId: plan.connectionId,
      routeKind: plan.routeKind,
      protocol: plan.protocol,
      modelId: plan.model.id,
      capabilityCheckId: plan.capabilityCheckId,
      profileVersion: plan.execution.profileVersion,
      methodologyRef: plan.execution.methodologyRef,
    });
    return safe.scanId === plan.snapshot.scanId &&
      safe.connectionId === plan.execution.connectionId &&
      safe.routeKind === plan.execution.routeKind &&
      safe.protocol === plan.execution.protocol &&
      safe.modelId === plan.snapshot.modelId &&
      safe.capabilityCheckId === plan.execution.capabilityCheckId;
  } catch {
    return false;
  }
}

/**
 * A connection plan is the trust boundary for model capabilities. Browser
 * effort is accepted only when the exact resolved catalog model exposed it;
 * stale/missing values use the provider-published default, while absent model
 * metadata leaves effort omitted for provider-managed behavior.
 */
function normalizeReasoningEffort(
  request: StartScanRequest,
  model: ScanLaunchPlan["model"],
): StartScanRequest {
  const metadata = model?.reasoningEffort;
  if (metadata === undefined || metadata.options.length === 0) {
    const { effort: _untrustedEffort, ...withoutEffort } = request;
    return withoutEffort;
  }
  if (request.effort !== undefined && metadata.options.includes(request.effort)) {
    return { ...request, effort: request.effort };
  }
  if (metadata.default !== null && metadata.options.includes(metadata.default)) {
    return { ...request, effort: metadata.default };
  }
  const { effort: _untrustedEffort, ...withoutEffort } = request;
  return withoutEffort;
}

/**
 * The browser never chooses local-session metadata. A runtime-default plan
 * intentionally omits `model`, preserving the CLI's own selected default.
 */
function selectClaudeCodeLocalMantis(
  request: StartScanRequest,
  plan: ScanLaunchPlan,
): ResolvedScanLaunchSelection {
  if (!isClaudeCodeLocalMantisPlan(plan)) {
    throw new ScanSelectionError("provider_runner_unavailable");
  }
  const { provider: _provider, model: _model, authMode: _authMode, ...safeRequest } = request;
  if (plan.snapshot.modelSelectionMode === "runtime-default") {
    if (plan.model !== null || plan.snapshot.modelId !== null || plan.capabilityCheckId !== null) {
      throw new ScanSelectionError("provider_model_unavailable");
    }
    return {
      request: {
        ...safeRequest,
        provider: "anthropic",
        authMode: "existing-session",
      },
      model: null,
      plan,
      connectionAware: true,
    };
  }
  if (
    plan.model === null ||
    plan.snapshot.modelId !== plan.model.id ||
    plan.capabilityCheckId !== null
  ) {
    throw new ScanSelectionError("provider_model_unavailable");
  }
  return {
    request: {
      ...safeRequest,
      provider: "anthropic",
      model: plan.model.id,
      authMode: "existing-session",
    },
    model: plan.model.id,
    plan,
    connectionAware: true,
  };
}

function isClaudeCodeLocalMantisPlan(plan: ScanLaunchPlan): boolean {
  return plan.engine === "mantis" &&
    plan.providerKind === "anthropic" &&
    plan.routeKind === "claude-code-local" &&
    plan.protocol === "claude-code-cli" &&
    plan.scannerAuthMode === "existing-session";
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
