import type {
  ScanConnectionSelection,
  StartScanRequest,
} from "@csb/shared";

import type {
  LaunchPlanResolver,
  ScanLaunchPlan,
} from "../connections/launch-plan.js";

const SCOPED_CODEX_SECURITY_SESSION_ROUTES = new Set([
  "openai-codex-local",
  "openai-chatgpt-app-server",
]);

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

  if (plan.runnerKind === "agent-session" || plan.runnerKind === "remote-agent-job") {
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
