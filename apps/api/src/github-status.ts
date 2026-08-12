import fs from "node:fs";
import path from "node:path";

import type {
  GitHubCapabilityStatus,
  GuardrailGitHubStatus,
  GuardrailRepository,
} from "@csb/shared";

import {
  createGhRunner,
  defaultGhRunner,
  type GhResult,
  type GhRunner,
} from "./github-cli.js";
import { githubAppServiceErrorCode } from "./github-app/github-app-service.js";

const SECRET_NAME = "OPENAI_API_KEY";
const defaultCodexRunner = createGhRunner("codex");
const WORKFLOW_PATH = path.join(
  ".github",
  "workflows",
  "csb-security-change-gate.yml",
);
const WORKFLOW_V2_MARKER = "# csb-guardrail-contract: 2";

interface RepositoryView {
  nameWithOwner?: unknown;
  defaultBranchRef?: { name?: unknown } | null;
}

interface RepositoryPermissions {
  admin?: unknown;
  push?: unknown;
}

function capability(
  ready: boolean,
  message: string,
  action: string | null,
): GitHubCapabilityStatus {
  return { ready, message, action };
}

export interface RemoteGitHubStatusAuthority {
  refreshRepositories(installationId: string): Promise<unknown>;
  requireAuthorizedRepository(
    connectionId: string,
    installationId: string,
    repositoryId: string,
  ): { owner: string; name: string };
}

export async function getRemoteGitHubStatus(
  repository: GuardrailRepository,
  authority: RemoteGitHubStatusAuthority,
): Promise<GuardrailGitHubStatus> {
  if (
    repository.source !== "github"
    || repository.repositoryPath !== null
    || repository.githubConnectionId === null
    || repository.githubInstallationId === null
    || repository.githubRepositoryId === null
  ) {
    return unavailableRemoteStatus("github_repository_not_configured");
  }
  try {
    await authority.refreshRepositories(repository.githubInstallationId);
    const authorized = authority.requireAuthorizedRepository(
      repository.githubConnectionId,
      repository.githubInstallationId,
      repository.githubRepositoryId,
    );
    const noCli = {
      ...capability(true, "GitHub CLI não é necessário para este repositório remoto.", null),
      available: false,
    };
    const managed = repository.defaultExecutor === "sentinel-managed";
    const status: GuardrailGitHubStatus = {
      subscription: capability(
        true,
        "A conexão de inferência será validada no preview do gate.",
        null,
      ),
      cli: noCli,
      remote: capability(
        true,
        `Repositório GitHub ${authorized.owner}/${authorized.name} autorizado pela instalação.`,
        null,
      ),
      auth: capability(true, "GitHub App autenticada e instalação ativa.", null),
      permissions: capability(true, "Permissões da instalação aceitam o catálogo autorizado.", null),
      secret: capability(
        managed,
        managed
          ? "Execução Sentinel-managed não exige secret no repositório."
          : "Secrets do executor Actions ainda precisam de preflight.",
        managed ? null : "Conclua o preflight do GitHub Actions.",
      ),
      workflow: capability(
        managed,
        managed
          ? "Execução Sentinel-managed não exige caller workflow."
          : "Caller workflow ainda precisa de preflight.",
        managed ? null : "Valide o caller workflow v2.",
      ),
      baseline: capability(true, "A instalação pode resolver a baseline por identidade GitHub.", null),
      ready: managed,
    };
    return status;
  } catch (error) {
    return unavailableRemoteStatus(remoteStatusCode(error));
  }
}

function unavailableRemoteStatus(code: string): GuardrailGitHubStatus {
  const blocked = capability(
    false,
    `Conexão GitHub App indisponível (${code}).`,
    "Reconecte o GitHub App e confirme o acesso ao repositório.",
  );
  return {
    subscription: capability(true, "A conexão de inferência será validada no preview do gate.", null),
    cli: { ...capability(true, "GitHub CLI não é necessário para este repositório remoto.", null), available: false },
    remote: blocked,
    auth: blocked,
    permissions: blocked,
    secret: blocked,
    workflow: blocked,
    baseline: blocked,
    ready: false,
  };
}

function remoteStatusCode(error: unknown): string {
  return githubAppServiceErrorCode(error);
}

async function run(
  runner: GhRunner,
  args: string[],
  cwd: string,
): Promise<GhResult> {
  try {
    return await runner(args, { cwd });
  } catch {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function getGitHubStatus(
  repositoryPath: string,
  runner: GhRunner = defaultGhRunner,
  codexRunner: GhRunner = defaultCodexRunner,
): Promise<GuardrailGitHubStatus> {
  const cwd = path.resolve(repositoryPath);
  const workflowSource = readCallerWorkflow(cwd);
  const codexAuthResult = await run(codexRunner, ["login", "status"], cwd);
  const codexAuthOutput = `${codexAuthResult.stdout}\n${codexAuthResult.stderr}`;
  const subscriptionReady =
    codexAuthResult.exitCode === 0 && /logged in using chatgpt/i.test(codexAuthOutput);
  const subscription = capability(
    subscriptionReady,
    subscriptionReady
      ? "Assinatura Codex local detectada neste Mac."
      : "Nenhuma sessão Codex por assinatura foi detectada.",
    subscriptionReady ? null : "Entre com sua conta ChatGPT usando codex login.",
  );
  const cliResult = await run(runner, ["--version"], cwd);
  const cliReady = cliResult.exitCode === 0;
  const cli = {
    ...capability(
      cliReady,
      cliReady ? "GitHub CLI disponível." : "GitHub CLI não encontrado.",
      cliReady ? null : "Instale o GitHub CLI (gh).",
    ),
    available: cliReady,
  };

  if (!cliReady) {
    const unavailable = capability(
      false,
      "O GitHub CLI é necessário para este diagnóstico.",
      "Instale o GitHub CLI (gh).",
    );
    return {
      subscription,
      cli,
      remote: unavailable,
      auth: unavailable,
      permissions: unavailable,
      secret: unavailable,
      workflow: workflowCapability(workflowSource),
      baseline: unavailable,
      ready: false,
    };
  }

  const authResult = await run(runner, ["auth", "status"], cwd);
  const auth = capability(
    authResult.exitCode === 0,
    authResult.exitCode === 0
      ? "GitHub CLI autenticado."
      : "GitHub CLI sem autenticação.",
    authResult.exitCode === 0 ? null : "Execute gh auth login.",
  );

  const remoteResult = await run(
    runner,
    ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
    cwd,
  );
  const repositoryView = parseJson(remoteResult.stdout) as RepositoryView | null;
  const repositorySlug =
    remoteResult.exitCode === 0 &&
    repositoryView &&
    typeof repositoryView.nameWithOwner === "string"
      ? repositoryView.nameWithOwner
      : null;
  const remote = capability(
    repositorySlug !== null,
    repositorySlug
      ? `Remote GitHub ${repositorySlug} disponível.`
      : "Nenhum remote GitHub foi encontrado.",
    repositorySlug ? null : "Configure um remote GitHub para este repositório.",
  );

  const permissions = repositorySlug
    ? await permissionsCapability(runner, cwd, repositorySlug)
    : capability(
        false,
        "As permissões não podem ser verificadas sem um remote GitHub.",
        "Configure um remote GitHub para este repositório.",
      );

  const secretResult = await run(
    runner,
    ["secret", "list", "--json", "name"],
    cwd,
  );
  const secretNames = parseJson(secretResult.stdout);
  const secretReady =
    secretResult.exitCode === 0 &&
    Array.isArray(secretNames) &&
    secretNames.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        "name" in entry &&
        entry.name === SECRET_NAME,
    );
  const secret = capability(
    secretReady,
    secretReady
      ? `${SECRET_NAME} configurada no repositório.`
      : `${SECRET_NAME} não configurada no repositório.`,
    secretReady ? null : `Crie o secret ${SECRET_NAME} no repositório.`,
  );

  const workflow = workflowCapability(workflowSource);
  const baselineReady = repositorySlug !== null && permissions.ready;
  const baseline = capability(
    baselineReady,
    baselineReady
      ? "O gate pode resolver baselines da branch principal."
      : "A baseline remota exige acesso de leitura ao GitHub Actions.",
    baselineReady ? null : "Resolva o remote GitHub e as permissões do Actions.",
  );
  const ready = [
    cli,
    remote,
    auth,
    permissions,
    secret,
    workflow,
    baseline,
  ].every((item) => item.ready);

  return {
    subscription,
    cli,
    remote,
    auth,
    permissions,
    secret,
    workflow,
    baseline,
    ready,
  };
}

async function permissionsCapability(
  runner: GhRunner,
  cwd: string,
  repositorySlug: string,
): Promise<GitHubCapabilityStatus> {
  const repositoryResult = await run(
    runner,
    ["api", `repos/${repositorySlug}`, "--jq", ".permissions"],
    cwd,
  );
  const actionsResult = await run(
    runner,
    ["api", `repos/${repositorySlug}/actions/permissions/workflow`],
    cwd,
  );
  const value = parseJson(repositoryResult.stdout) as RepositoryPermissions | null;
  const canPublish = value?.admin === true || value?.push === true;
  const actionsReadable = actionsResult.exitCode === 0;

  if (repositoryResult.exitCode !== 0 || !actionsReadable) {
    return capability(
      false,
      "Não foi possível verificar as permissões do repositório ou Actions.",
      "Conceda acesso ao repositório e ao Actions para a conta autenticada.",
    );
  }
  if (!canPublish) {
    return capability(
      false,
      "O acesso ao repositório é somente leitura; publicar um Check local exige escrita ou admin.",
      "Conceda acesso de escrita ou admin para publicar o Check local.",
    );
  }
  return capability(
    true,
    "Permissões do repositório e GitHub Actions prontas.",
    null,
  );
}

function readCallerWorkflow(cwd: string): string | null {
  try {
    return fs.readFileSync(path.join(cwd, WORKFLOW_PATH), "utf8");
  } catch {
    return null;
  }
}

function workflowCapability(source: string | null): GitHubCapabilityStatus {
  if (source === null) {
    return capability(
      false,
      "Caller workflow do CSB não instalado.",
      "Instale o caller workflow do CSB.",
    );
  }
  if (!source.includes(WORKFLOW_V2_MARKER)) {
    return capability(
      false,
      "Caller workflow legado detectado; publicação de Check desabilitada.",
      "Atualize o caller para o contrato v2 antes de usar o Actions.",
    );
  }
  return capability(true, "Caller workflow v2 do CSB instalado.", null);
}
