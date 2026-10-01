import type { GateArtifact, GateRun, GuardrailPrCommentState } from "@csb/shared";

import type { TranslationKey } from "../i18n";

/** Owner and name of the GitHub repository a gate ran against. */
export interface GitHubRepositoryName {
  owner: string;
  name: string;
}

const SAFE_SLUG = /^[A-Za-z0-9_.-]+$/;
const COMMENT_ID = /^[1-9][0-9]{0,18}$/;

/** The gate's repository, read off its artifact; `null` when it is not on GitHub. */
export function gitHubRepositoryName(artifact: GateArtifact | null): GitHubRepositoryName | null {
  if (artifact === null || artifact.schemaVersion !== 2) return null;
  const locator = artifact.repository.locator;
  return locator.kind === "github" ? { owner: locator.owner, name: locator.name } : null;
}

/**
 * Where "Abrir PR" goes. Built from the owner, the name and the number rather than
 * from anything GitHub sent back, so a crafted field can never become the link an
 * operator is invited to click.
 */
export function pullRequestUrl(
  gate: GateRun,
  repository: GitHubRepositoryName | null,
): string | null {
  if (gate.pullRequestNumber === null || gate.pullRequestNumber <= 0) return null;
  if (repository === null) return null;
  if (!SAFE_SLUG.test(repository.owner) || !SAFE_SLUG.test(repository.name)) return null;
  return `https://github.com/${repository.owner}/${repository.name}/pull/${gate.pullRequestNumber}`;
}

/** The published comment's own anchor inside the pull request. */
export function commentUrl(
  gate: GateRun,
  comment: GuardrailPrCommentState | null,
  repository: GitHubRepositoryName | null,
): string | null {
  if (comment === null || comment.commentId === null || !COMMENT_ID.test(comment.commentId)) {
    return null;
  }
  const url = pullRequestUrl(gate, repository);
  return url === null ? null : `${url}#issuecomment-${comment.commentId}`;
}

export function publicationStateLabelKey(gate: GateRun): TranslationKey {
  return `guardrails.publication.${gate.publishStatus}` as TranslationKey;
}

/**
 * The comment's state is its own. A Check that published and a comment that did
 * not are two different facts, and one word for both would hide the one the
 * operator can still act on.
 */
export function commentStateLabelKey(comment: GuardrailPrCommentState | null): TranslationKey {
  if (comment === null) return "guardrails.comment.absent";
  return comment.status === "failed" ? "guardrails.comment.failed" : "guardrails.comment.published";
}
