import type { GateRun, GateTarget, GitHubMonitorEvent, GitHubMonitorRule, GuardrailRepository } from "@csb/shared";
import type { AcceptedGateTargetPreview, GateTargetPreview, TargetPreviewRequest } from "./guardrails/target-preview.js";

export interface AutomaticGitHubScanInput {
  rule: GitHubMonitorRule;
  event: GitHubMonitorEvent;
  target: GateTarget;
}

export function automaticGitHubScanDispatcher(deps: {
  getRepository(key: string): GuardrailRepository | null;
  getRule?(id: string): GitHubMonitorRule | null;
  validateActions?(repository: GuardrailRepository): Promise<void>;
  preview(repository: GuardrailRepository, request: TargetPreviewRequest): Promise<GateTargetPreview>;
  accept(repository: GuardrailRepository, preview: GateTargetPreview): Promise<AcceptedGateTargetPreview>;
  startManaged(preview: AcceptedGateTargetPreview): Promise<GateRun>;
  startActions(preview: AcceptedGateTargetPreview, idempotencyKey: string): Promise<GateRun>;
}) {
  return async ({ rule, event, target }: AutomaticGitHubScanInput): Promise<{ gateId: string; headSha: string }> => {
    const repository = deps.getRepository(rule.repositoryKey);
    if (!repository || repository.source !== "github" || !repository.enabled
      || repository.githubConnectionId !== rule.connectionId
      || repository.githubInstallationId !== rule.installationId
      || repository.githubRepositoryId !== rule.repositoryId
      || event.repositoryKey !== rule.repositoryKey || event.ruleId !== rule.id
      || event.ruleRevision !== rule.revision || !rule.enabled) throw new Error("monitor_authority_invalid");
    if (!Number.isFinite(rule.costCeilingUsd) || rule.costCeilingUsd === null || rule.costCeilingUsd <= 0) throw new Error("monitor_budget_required");
    if (rule.executor === "sentinel-managed" && (!rule.scanner || rule.scanner.engine !== "codex-security")) throw new Error("monitor_scanner_required");
    if (rule.executor === "github-actions" && rule.scanner !== null) throw new Error("monitor_actions_policy_required");
    if (rule.executor === "github-actions") await deps.validateActions?.(repository);
    const preview = await deps.preview(repository, {
      target, executor: rule.executor,
      ...(rule.scanner ? { scanSelection: { ...rule.scanner, costLimit: { kind: "manual" as const, maxCostUsd: rule.costCeilingUsd } } } : {}),
    });
    // Validate before dispatch: a ref may have moved since the poll observed it.
    if (preview.resolvedTarget.headSha !== event.headSha) throw new Error("head_superseded");
    const ceiling = preview.costBudget.maxCostUsd;
    if (ceiling === null || !Number.isFinite(ceiling) || ceiling <= 0 || ceiling > rule.costCeilingUsd) throw new Error("monitor_policy_budget_exceeds_rule");
    if (!preview.executorCapability.ready) throw new Error("target_preview_executor_unavailable");
    const accepted = await deps.accept(repository, preview);
    if (accepted.resolvedTarget.headSha !== event.headSha || accepted.costBudget.maxCostUsd !== ceiling) throw new Error("target_preview_stale");
    const currentRule = deps.getRule ? deps.getRule(rule.id) : rule;
    if (!currentRule?.enabled || currentRule.revision !== rule.revision) throw new Error("monitor_rule_changed");
    const gate = rule.executor === "github-actions"
      ? await deps.startActions(accepted, event.id)
      : await deps.startManaged(accepted);
    return { gateId: gate.id, headSha: accepted.resolvedTarget.headSha };
  };
}
