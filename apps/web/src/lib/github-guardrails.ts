import { getIntlLocale, translate } from "../i18n";
import { localizeOperatorText } from "../i18n/operator-text";
import type {
  GateArtifact,
  GateOutcome,
  GatePublishStatus,
  GuardrailGitHubStatus,
  GuardrailRepository,
} from "@csb/shared";

export type GitHubSetupStepId =
  | "repository"
  | "scanner"
  | "remote"
  | "cli"
  | "auth"
  | "permissions"
  | "secret"
  | "workflow"
  | "baseline";

export type GitHubSetupActionKind = "copy" | "install" | "sync" | "none";
export type ScannerAccessMode = "subscription" | "api";

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
  accessMode: ScannerAccessMode = "api",
): GitHubSetupViewModel {
  const repositoryReady = repository ? Boolean(repository.repositoryPath) : true;
  const sharedSteps: GitHubSetupStep[] = [
    {
      id: "repository",
      title: text("Confirme o repositório Git"),
      ready: repositoryReady,
      message: repository?.repositoryPath ?? text("Repositório Git cadastrado localmente."),
      action: repositoryReady ? null : text("Cadastre um repositório Git local."),
      actionKind: "none",
      command: null,
    },
    ...(accessMode === "subscription"
      ? [capabilityStep("scanner", text("Use sua assinatura Codex"), status.subscription, "codex login")]
      : []),
    capabilityStep("remote", text("Configure o remote GitHub"), status.remote),
    capabilityStep("cli", text("Instale o gh CLI"), status.cli),
    capabilityStep("auth", text("Autentique o gh CLI"), status.auth, "gh auth login"),
    capabilityStep("permissions", text("Libere Actions e Checks"), status.permissions),
  ];
  const apiSteps: GitHubSetupStep[] = [
    capabilityStep("secret", text("Configure a API do scanner"), status.secret, "gh secret set OPENAI_API_KEY"),
    {
      ...capabilityStep("workflow", text("Instale o caller workflow"), status.workflow),
      actionKind: status.workflow.ready ? "none" : "install",
    },
  ];
  const steps: GitHubSetupStep[] = [
    ...sharedSteps,
    ...(accessMode === "api" ? apiSteps : []),
    {
      ...capabilityStep("baseline", text("Sincronize a baseline remota"), status.baseline),
      actionKind: status.baseline.ready ? "none" : "sync",
    },
  ];
  const ready = steps.every((step) => step.ready);
  const primary = steps.find((step) => !step.ready) ?? {
    id: "baseline",
    title: text("Integração GitHub pronta"),
    ready: true,
    message: text("Todas as capacidades exigidas foram verificadas."),
    action: null,
    actionKind: "none",
    command: null,
  };
  return { ready, steps, primary };
}

function text(value: string): string {
  return localizeOperatorText(value, getIntlLocale());
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
    message: text(capability.message),
    action: capability.action === null ? null : text(capability.action),
    actionKind: capability.ready ? "none" : "copy",
    command: capability.ready ? null : command ?? capability.action,
  };
}

export function prCheckLabel(input: {
  outcome: GateOutcome | null;
  publishStatus: GatePublishStatus;
}): string {
  return translate(getIntlLocale(), `guardrails.publication.${input.publishStatus}`).toLocaleUpperCase(getIntlLocale());
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
