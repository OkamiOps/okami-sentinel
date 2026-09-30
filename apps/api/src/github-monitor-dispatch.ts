import type { GateRun, GateTarget, GitHubAction, GitHubActionEvent, GuardrailRepository } from "@csb/shared";
import type { AcceptedGateTargetPreview, GateTargetPreview, TargetPreviewRequest } from "./guardrails/target-preview.js";

export interface AutomaticGitHubScanInput {
  action: GitHubAction;
  event: GitHubActionEvent;
  target: GateTarget;
}

/**
 * The paid half of a dispatch: revalidate the authority triple, freeze a preview
 * of *this* head, check the policy's own ceiling against the action's, re-read the
 * revision after the preview and only then start the gate.
 *
 * Every refusal here happens **before** anything is launched, which is what lets
 * `dispatchGitHubActionEvent` record it as `skipped` rather than `failed`. The
 * caller owns the UTC-day reservation and the event's status; this function owns
 * the guarantee that nothing is started for a head that moved, a budget that does
 * not fit, or an action that changed while the preview was being built.
 */
export function automaticGitHubScanDispatcher(deps: {
  getRepository(key: string): GuardrailRepository | null;
  getAction?(id: string): GitHubAction | null;
  validateActions?(repository: GuardrailRepository): Promise<void>;
  preview(repository: GuardrailRepository, request: TargetPreviewRequest): Promise<GateTargetPreview>;
  accept(repository: GuardrailRepository, preview: GateTargetPreview): Promise<AcceptedGateTargetPreview>;
  startManaged(preview: AcceptedGateTargetPreview): Promise<GateRun>;
  startActions(preview: AcceptedGateTargetPreview, idempotencyKey: string): Promise<GateRun>;
}) {
  return async ({ action, event, target }: AutomaticGitHubScanInput): Promise<{ gateId: string; headSha: string }> => {
    const repository = deps.getRepository(action.repositoryKey);
    if (!repository || repository.source !== "github" || !repository.enabled
      || repository.githubConnectionId !== action.connectionId
      || repository.githubInstallationId !== action.installationId
      || repository.githubRepositoryId !== action.repositoryId
      || event.repositoryKey !== action.repositoryKey || event.actionId !== action.id
      || event.actionRevision !== action.revision || !action.enabled) {
      throw new Error("github_action_authority_invalid");
    }
    if (!Number.isFinite(action.costCeilingUsd) || action.costCeilingUsd <= 0) throw new Error("github_action_budget_required");
    if (action.executor === "sentinel-managed" && (!action.scanner || action.scanner.engine !== "codex-security")) throw new Error("github_action_scanner_required");
    if (action.executor === "github-actions" && action.scanner !== null) throw new Error("github_action_actions_policy_required");
    if (action.executor === "github-actions") await deps.validateActions?.(repository);
    const preview = await deps.preview(repository, {
      target, executor: action.executor,
      ...(action.scanner ? { scanSelection: { ...action.scanner, costLimit: { kind: "manual" as const, maxCostUsd: action.costCeilingUsd } } } : {}),
    });
    // Validate before dispatch: a ref may have moved since the event was recorded.
    if (preview.resolvedTarget.headSha !== event.headSha) throw new Error("head_superseded");
    const ceiling = preview.costBudget.maxCostUsd;
    if (ceiling === null || !Number.isFinite(ceiling) || ceiling <= 0 || ceiling > action.costCeilingUsd) throw new Error("github_action_policy_budget_exceeded");
    if (!preview.executorCapability.ready) throw new Error("target_preview_executor_unavailable");
    const accepted = await deps.accept(repository, preview);
    if (accepted.resolvedTarget.headSha !== event.headSha || accepted.costBudget.maxCostUsd !== ceiling) throw new Error("target_preview_stale");
    const current = deps.getAction ? deps.getAction(action.id) : action;
    if (!current?.enabled || current.revision !== action.revision) throw new Error("action_revision_changed");
    const gate = action.executor === "github-actions"
      ? await deps.startActions(accepted, event.id)
      : await deps.startManaged(accepted);
    return { gateId: gate.id, headSha: accepted.resolvedTarget.headSha };
  };
}
