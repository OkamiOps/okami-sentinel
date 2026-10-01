import type { GuardrailRepository } from "@csb/shared";

import { callerWorkflowDocument } from "../github-workflow.js";

/**
 * The branch the button writes to. Fixed, not generated: a second press has to find
 * the first press's branch, and an operator who closed the pull request without
 * merging must be able to recognise it on GitHub.
 */
export const CALLER_WORKFLOW_BRANCH = "okami-sentinel/caller-workflow";

/**
 * The caller Sentinel installs through a pull request has **no** automatic
 * triggers. The Actions executor is driven by `workflow_dispatch` from here, and a
 * caller that also fired on `push` or `pull_request` would scan every commit twice
 * — once on the repository's own minutes, outside every ceiling this product
 * enforces. `monitor_actions_duplicate_triggers` refuses exactly that at dispatch;
 * writing the triggers off is how the pull request we open is usable on merge.
 */
const DISPATCH_ONLY_TRIGGERS = Object.freeze({
  push: false,
  pullRequest: false,
  merge: false,
});

const PULL_REQUEST_TITLE = "chore(security): install the Okami Sentinel guardrail caller";

const PULL_REQUEST_BODY = [
  "This pull request installs the pinned Okami Sentinel caller workflow.",
  "",
  "The caller only answers `workflow_dispatch`: Okami Sentinel starts every gate,",
  "with the per-scan and per-day ceilings the console holds. Before merging, add an",
  "`OPENAI_API_KEY` secret to this repository and remove any other automatic",
  "security-gate triggers, so one change is never scanned twice.",
].join("\n");

export type CallerWorkflowPullRequestErrorCode =
  | "caller_workflow_authority_invalid"
  | "caller_workflow_release_unavailable"
  | "caller_workflow_pull_request_failed";

export class CallerWorkflowPullRequestError extends Error {
  constructor(readonly code: CallerWorkflowPullRequestErrorCode) {
    super(code);
    this.name = "CallerWorkflowPullRequestError";
  }
}

export interface CallerWorkflowAuthority {
  connectionId: string;
  installationId: string;
  repositoryId: string;
  owner: string;
  name: string;
}

export interface CallerWorkflowPullRequestDependencies {
  readJson(
    authority: CallerWorkflowAuthority,
    resourcePath: string,
    permissions: { contents?: "read" | "write"; pull_requests?: "read" | "write" },
  ): Promise<unknown>;
  writeJson(
    authority: CallerWorkflowAuthority,
    resourcePath: string,
    method: "POST" | "PUT",
    body: unknown,
    permissions: { contents?: "write"; pull_requests?: "write"; workflows?: "write" },
  ): Promise<unknown>;
}

export interface OpenCallerWorkflowPullRequestResult {
  status: "created" | "exists";
  pullRequestNumber: number;
  pullRequestUrl: string;
  branch: string;
}

/**
 * One button, four calls: branch the default head, write the pinned caller on it,
 * and open the pull request. Every step tolerates its own "already done" answer,
 * because the operator who presses twice — or who pressed once and let the branch
 * sit — must get the pull request's number back, not a conflict.
 *
 * Sentinel never writes to the default branch here. The review flow the repository
 * already has is what installs the workflow.
 */
export async function openCallerWorkflowPullRequest(
  input: { repository: GuardrailRepository; workflowSha: string },
  deps: CallerWorkflowPullRequestDependencies,
): Promise<OpenCallerWorkflowPullRequestResult> {
  const authority = callerWorkflowAuthority(input.repository);
  const defaultBranch = input.repository.defaultBranch;
  let workflow;
  try {
    workflow = callerWorkflowDocument({
      defaultBranch,
      secretName: "OPENAI_API_KEY",
      workflowSha: input.workflowSha,
      triggers: { ...DISPATCH_ONLY_TRIGGERS },
    });
  } catch {
    throw new CallerWorkflowPullRequestError("caller_workflow_release_unavailable");
  }
  const repo = `/repos/${authority.owner}/${authority.name}`;

  const head = record(await deps.readJson(
    authority,
    `${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
    { contents: "read" },
  ));
  const headSha = record(head.object).sha;
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new CallerWorkflowPullRequestError("caller_workflow_pull_request_failed");
  }

  try {
    await deps.writeJson(
      authority,
      `${repo}/git/refs`,
      "POST",
      { ref: `refs/heads/${CALLER_WORKFLOW_BRANCH}`, sha: headSha },
      { contents: "write" },
    );
  } catch (error) {
    // A 422 here is GitHub saying the reference exists. The branch from the first
    // press is the branch this press writes to.
    if (!rejected(error)) throw error;
  }

  let blobSha: string | undefined;
  try {
    const current = record(await deps.readJson(
      authority,
      `${repo}/contents/${workflow.path}?ref=${encodeURIComponent(CALLER_WORKFLOW_BRANCH)}`,
      { contents: "read" },
    ));
    if (typeof current.sha === "string") blobSha = current.sha;
  } catch (error) {
    if (!notFound(error)) throw error;
  }

  await deps.writeJson(
    authority,
    `${repo}/contents/${workflow.path}`,
    "PUT",
    {
      message: PULL_REQUEST_TITLE,
      content: Buffer.from(workflow.content).toString("base64"),
      branch: CALLER_WORKFLOW_BRANCH,
      ...(blobSha === undefined ? {} : { sha: blobSha }),
    },
    { contents: "write", workflows: "write" },
  );

  try {
    const created = record(await deps.writeJson(
      authority,
      `${repo}/pulls`,
      "POST",
      {
        title: PULL_REQUEST_TITLE,
        head: CALLER_WORKFLOW_BRANCH,
        base: defaultBranch,
        body: PULL_REQUEST_BODY,
      },
      { pull_requests: "write" },
    ));
    return { status: "created", ...pullRequestIdentity(created), branch: CALLER_WORKFLOW_BRANCH };
  } catch (error) {
    if (!rejected(error)) throw error;
    // "A pull request already exists for …" is the one 422 worth resolving: the
    // operator gets the number that is already open instead of a refusal.
    const open = await deps.readJson(
      authority,
      `${repo}/pulls?state=open&head=${encodeURIComponent(`${authority.owner}:${CALLER_WORKFLOW_BRANCH}`)}`,
      { pull_requests: "read" },
    );
    if (!Array.isArray(open) || open.length === 0) {
      throw new CallerWorkflowPullRequestError("caller_workflow_pull_request_failed");
    }
    return { status: "exists", ...pullRequestIdentity(record(open[0])), branch: CALLER_WORKFLOW_BRANCH };
  }
}

function callerWorkflowAuthority(repository: GuardrailRepository): CallerWorkflowAuthority {
  if (
    repository.source !== "github"
    || repository.repositoryPath !== null
    || repository.githubConnectionId === null
    || repository.githubInstallationId === null
    || repository.githubRepositoryId === null
    || repository.remoteOwner === null
    || repository.remoteName === null
  ) {
    throw new CallerWorkflowPullRequestError("caller_workflow_authority_invalid");
  }
  return {
    connectionId: repository.githubConnectionId,
    installationId: repository.githubInstallationId,
    repositoryId: repository.githubRepositoryId,
    owner: slug(repository.remoteOwner),
    name: slug(repository.remoteName),
  };
}

function pullRequestIdentity(value: Record<string, unknown>): {
  pullRequestNumber: number;
  pullRequestUrl: string;
} {
  const number = value.number;
  const url = value.html_url;
  if (
    !Number.isSafeInteger(number) || (number as number) <= 0
    || typeof url !== "string" || !url.startsWith("https://")
  ) {
    throw new CallerWorkflowPullRequestError("caller_workflow_pull_request_failed");
  }
  return { pullRequestNumber: number as number, pullRequestUrl: url };
}

function slug(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new CallerWorkflowPullRequestError("caller_workflow_authority_invalid");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CallerWorkflowPullRequestError("caller_workflow_pull_request_failed");
  }
  return value as Record<string, unknown>;
}

/** GitHub's 409/422, which the App client reports as one code. */
function rejected(error: unknown): boolean {
  return errorCode(error) === "github_request_rejected";
}

function notFound(error: unknown): boolean {
  return errorCode(error) === "github_not_found";
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error
    && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";
}
