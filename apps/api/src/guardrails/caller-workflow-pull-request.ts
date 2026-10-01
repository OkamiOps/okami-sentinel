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
  | "caller_workflow_branch_unavailable"
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

  const headSha = await refHead(deps, authority, repo, defaultBranch);
  if (headSha === null) {
    throw new CallerWorkflowPullRequestError("caller_workflow_pull_request_failed");
  }

  const branch = await usableBranch(deps, authority, repo, headSha, workflow.path);

  let blobSha: string | undefined;
  try {
    const current = record(await deps.readJson(
      authority,
      `${repo}/contents/${workflow.path}?ref=${encodeURIComponent(branch)}`,
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
      branch,
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
        head: branch,
        base: defaultBranch,
        body: PULL_REQUEST_BODY,
      },
      { pull_requests: "write" },
    ));
    return { status: "created", ...pullRequestIdentity(created), branch };
  } catch (error) {
    if (!rejected(error)) throw error;
    // "A pull request already exists for …" is the one 422 worth resolving: the
    // operator gets the number that is already open instead of a refusal.
    const open = await deps.readJson(
      authority,
      `${repo}/pulls?state=open&head=${encodeURIComponent(`${authority.owner}:${branch}`)}`,
      { pull_requests: "read" },
    );
    if (!Array.isArray(open) || open.length === 0) {
      throw new CallerWorkflowPullRequestError("caller_workflow_pull_request_failed");
    }
    return { status: "exists", ...pullRequestIdentity(record(open[0])), branch };
  }
}

/**
 * The branch this press will write on.
 *
 * `POST /git/refs` answering 422 is **not** proof that the branch exists: GitHub
 * answers the same way when the installation has not granted a permission the
 * token asks for. So the reference is read back. A 404 there means the 422 was
 * something else — a missing grant, most likely — and the button refuses with its
 * own code instead of writing on top of a branch it never created.
 *
 * A branch that does exist is only reused when a pull request from it would carry
 * nothing but our own workflow file. Anyone with push access can pre-create
 * `okami-sentinel/caller-workflow` with unrelated commits, and an administrator
 * pressing a button labelled "install the guardrail caller" must not open a pull
 * request that smuggles them in. When it carries anything else, the commit goes on
 * a uniquely suffixed branch of its own.
 */
async function usableBranch(
  deps: CallerWorkflowPullRequestDependencies,
  authority: CallerWorkflowAuthority,
  repo: string,
  headSha: string,
  workflowPath: string,
): Promise<string> {
  const candidates = [CALLER_WORKFLOW_BRANCH, `${CALLER_WORKFLOW_BRANCH}-${headSha.slice(0, 7)}`];
  for (const branch of candidates) {
    try {
      await deps.writeJson(
        authority,
        `${repo}/git/refs`,
        "POST",
        { ref: `refs/heads/${branch}`, sha: headSha },
        { contents: "write" },
      );
      return branch;
    } catch (error) {
      if (!rejected(error)) throw error;
    }
    const existing = await refHead(deps, authority, repo, branch);
    if (existing === null) {
      throw new CallerWorkflowPullRequestError("caller_workflow_branch_unavailable");
    }
    if (existing === headSha) return branch;
    if (await carriesOnly(deps, authority, repo, headSha, branch, workflowPath)) return branch;
  }
  throw new CallerWorkflowPullRequestError("caller_workflow_branch_unavailable");
}

/** The head SHA of a ref, or `null` when GitHub says it does not exist. */
async function refHead(
  deps: CallerWorkflowPullRequestDependencies,
  authority: CallerWorkflowAuthority,
  repo: string,
  branch: string,
): Promise<string | null> {
  let answer: unknown;
  try {
    answer = await deps.readJson(
      authority,
      `${repo}/git/ref/heads/${refPath(branch)}`,
      { contents: "read" },
    );
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
  const sha = record(record(answer).object).sha;
  return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Whether a pull request from `branch` would change nothing but `workflowPath`. */
async function carriesOnly(
  deps: CallerWorkflowPullRequestDependencies,
  authority: CallerWorkflowAuthority,
  repo: string,
  headSha: string,
  branch: string,
  workflowPath: string,
): Promise<boolean> {
  let comparison: unknown;
  try {
    comparison = await deps.readJson(
      authority,
      `${repo}/compare/${headSha}...${refPath(branch)}`,
      { contents: "read" },
    );
  } catch {
    return false;
  }
  const files = record(comparison).files;
  if (!Array.isArray(files)) return false;
  return files.every((file) =>
    typeof file === "object" && file !== null
    && (file as { filename?: unknown }).filename === workflowPath);
}

/**
 * A branch name is one or more **path segments**, not one. `encodeURIComponent` on
 * the whole name turns `release/main` into `release%2Fmain`, which resolves to
 * nothing — so every repository whose default branch has a slash would get a
 * refusal from a button that should work.
 */
function refPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
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
