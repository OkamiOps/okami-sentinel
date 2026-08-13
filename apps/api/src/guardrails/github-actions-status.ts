import type { GuardrailRepository } from "@csb/shared";

import { callerWorkflowDocument, parseCallerAutomation, type GuardrailAutomationTriggers } from "../github-workflow.js";
import { ACTIONS_CALLER_WORKFLOW_PATH } from "./github-actions-executor.js";

export type GitHubActionsStatusCode =
  | "ready"
  | "actions_release_unavailable"
  | "caller_workflow_inactive"
  | "caller_workflow_missing"
  | "caller_workflow_outdated"
  | "github_actions_unavailable";

export interface GitHubActionsStatus {
  ready: boolean;
  code: GitHubActionsStatusCode;
  workflowPath: typeof ACTIONS_CALLER_WORKFLOW_PATH;
  releaseSha: string | null;
  triggers?: GuardrailAutomationTriggers | null;
}

export interface GitHubActionsStatusAuthority {
  readAuthorizedRepositoryJson(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    permissions: { actions?: "read"; contents?: "read" },
  ): Promise<unknown>;
}

export async function getGitHubActionsStatus(
  repository: GuardrailRepository,
  authority: GitHubActionsStatusAuthority,
  releaseSha: string | null,
): Promise<GitHubActionsStatus> {
  const unavailable = (code: GitHubActionsStatusCode): GitHubActionsStatus => ({
    ready: false,
    code,
    workflowPath: ACTIONS_CALLER_WORKFLOW_PATH,
    releaseSha,
    triggers: null,
  });
  if (releaseSha === null || !/^[0-9a-f]{40}$/.test(releaseSha)) {
    return unavailable("actions_release_unavailable");
  }
  if (
    repository.source !== "github"
    || repository.repositoryPath !== null
    || repository.remoteOwner === null
    || repository.remoteName === null
    || repository.githubConnectionId === null
    || repository.githubInstallationId === null
    || repository.githubRepositoryId === null
  ) return unavailable("github_actions_unavailable");

  const owner = slug(repository.remoteOwner);
  const name = slug(repository.remoteName);
  const authorityInput = [
    repository.githubConnectionId,
    repository.githubInstallationId,
    repository.githubRepositoryId,
  ] as const;
  try {
    const contents = record(await authority.readAuthorizedRepositoryJson(
      ...authorityInput,
      `/repos/${owner}/${name}/contents/${ACTIONS_CALLER_WORKFLOW_PATH}?ref=${encodeURIComponent(repository.defaultBranch)}`,
      { contents: "read" },
    ));
    if (contents.type !== "file" || contents.encoding !== "base64" || typeof contents.content !== "string") {
      return unavailable("caller_workflow_missing");
    }
    let decoded: string;
    try {
      decoded = Buffer.from(contents.content.replaceAll("\n", ""), "base64").toString("utf8");
    } catch {
      return unavailable("caller_workflow_outdated");
    }
    const triggers = parseCallerAutomation(decoded);
    if (triggers === null) return unavailable("caller_workflow_outdated");
    const expected = callerWorkflowDocument({
      defaultBranch: repository.defaultBranch,
      secretName: "OPENAI_API_KEY",
      workflowSha: releaseSha,
      triggers,
    }).content;
    if (normalize(decoded) !== normalize(expected)) {
      return unavailable("caller_workflow_outdated");
    }
    const workflow = record(await authority.readAuthorizedRepositoryJson(
      ...authorityInput,
      `/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(ACTIONS_CALLER_WORKFLOW_PATH)}`,
      { actions: "read" },
    ));
    if (workflow.state !== "active" || workflow.path !== ACTIONS_CALLER_WORKFLOW_PATH) {
      return unavailable("caller_workflow_inactive");
    }
    return {
      ready: true,
      code: "ready",
      workflowPath: ACTIONS_CALLER_WORKFLOW_PATH,
      releaseSha,
      triggers,
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as Error & { code: unknown }).code)
      : "";
    return unavailable(code === "github_not_found"
      ? "caller_workflow_missing"
      : "github_actions_unavailable");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("github_actions_unavailable");
  }
  return value as Record<string, unknown>;
}

function slug(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error("github_actions_unavailable");
  return value;
}

function normalize(value: string): string {
  return value.replaceAll("\r\n", "\n").trimEnd();
}
