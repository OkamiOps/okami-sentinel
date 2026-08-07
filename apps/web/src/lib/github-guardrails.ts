import type {
  GateArtifact,
  GateOutcome,
  GatePublishStatus,
  GuardrailGitHubStatus,
  GuardrailRepository,
} from "@csb/shared";

export type GitHubSetupStepId =
  | "repository"
  | "remote"
  | "cli"
  | "auth"
  | "permissions"
  | "secret"
  | "workflow"
  | "baseline";

export type GitHubSetupActionKind = "copy" | "install" | "sync" | "none";

export interface GitHubSetupStep {
  id: GitHubSetupStepId;
  title: string;
  ready: boolean;
  message: string;
  action: string | null;
  actionKind: GitHubSetupActionKind;
  command: string | null;
}

export interface GitHubSetupViewModel {
  ready: boolean;
  steps: GitHubSetupStep[];
  primary: GitHubSetupStep;
}

export function githubSetupModel(
  status: GuardrailGitHubStatus,
  repository?: GuardrailRepository,
): GitHubSetupViewModel {
  const repositoryReady = repository ? Boolean(repository.repositoryPath) : true;
  const steps: GitHubSetupStep[] = [
    {
      id: "repository",
      title: "Confirme o repositório Git",
      ready: repositoryReady,
      message: repository?.repositoryPath ?? "Repositório Git cadastrado localmente.",
      action: repositoryReady ? null : "Cadastre um repositório Git local.",
      actionKind: "none",
      command: null,
    },
    capabilityStep("remote", "Configure o remote GitHub", status.remote),
    capabilityStep("cli", "Instale o gh CLI", status.cli),
    capabilityStep("auth", "Autentique o gh CLI", status.auth, "gh auth login"),
    capabilityStep("permissions", "Libere Actions e Checks", status.permissions),
    capabilityStep("secret", "Configure o secret do scanner", status.secret, "gh secret set OPENAI_API_KEY"),
    {
      ...capabilityStep("workflow", "Instale o caller workflow", status.workflow),
      actionKind: status.workflow.ready ? "none" : "install",
    },
    {
      ...capabilityStep("baseline", "Sincronize a baseline remota", status.baseline),
      actionKind: status.baseline.ready ? "none" : "sync",
    },
  ];
  const ready = status.ready && steps.every((step) => step.ready);
  const primary = steps.find((step) => !step.ready) ?? {
    id: "baseline",
    title: "Integração GitHub pronta",
    ready: true,
    message: "Todas as capacidades exigidas foram verificadas.",
    action: null,
    actionKind: "none",
    command: null,
  };
  return { ready, steps, primary };
}

function capabilityStep(
  id: Exclude<GitHubSetupStepId, "repository">,
  title: string,
  capability: { ready: boolean; message: string; action: string | null },
  command?: string,
): GitHubSetupStep {
  return {
    id,
    title,
    ready: capability.ready,
    message: capability.message,
    action: capability.action,
    actionKind: capability.ready ? "none" : "copy",
    command: capability.ready ? null : command ?? capability.action,
  };
}

export function prCheckLabel(input: {
  outcome: GateOutcome | null;
  publishStatus: GatePublishStatus;
}): string {
  const labels: Record<GatePublishStatus, string> = {
    not_configured: "NOT CONFIGURED",
    waiting: "WAITING",
    publishing: "PUBLISHING",
    published: "PUBLISHED",
    failed: "PUBLICAÇÃO FALHOU",
  };
  return labels[input.publishStatus];
}

export function publicationTarget(artifact: GateArtifact): {
  repository: string;
  headSha: string;
} {
  return {
    repository: artifact.repository.owner
      ? `${artifact.repository.owner}/${artifact.repository.name}`
      : artifact.repository.name,
    headSha: artifact.changeSet.headSha,
  };
}
