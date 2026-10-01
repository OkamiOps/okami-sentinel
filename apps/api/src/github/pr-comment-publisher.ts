import { createHash } from "node:crypto";

import type {
  GateArtifactV2,
  GuardrailPrCommentLocale,
  GuardrailPrCommentState,
} from "@csb/shared";

import { isSentinelComment, prCommentMarker, renderPrComment } from "./pr-comment-render.js";

/**
 * The permission the comment needs, and the only one it asks for. `issues: write`
 * would also work — GitHub serves pull-request comments from the issues API — and
 * it is deliberately never requested: it would also hand Sentinel every issue in
 * the repository, which nothing here reads.
 */
const COMMENT_PERMISSIONS = { pull_requests: "write" } as const;

/**
 * How far back the marker scan goes when the stored row is missing. A pull request
 * with more than three hundred comments is rare; an unbounded scan on every gate is
 * a cost that grows with the noisiest pull request in the account.
 */
const MAX_COMMENT_PAGES = 3;
const COMMENTS_PER_PAGE = 100;

const SAFE_SLUG = /^[A-Za-z0-9_.-]+$/;

export interface PublishPrCommentInput {
  artifact: GateArtifactV2;
  repositoryKey: string;
  authority: { connectionId: string; installationId: string; repositoryId: string };
  owner: string;
  name: string;
  pullRequestNumber: number | null;
  durationMs: number | null;
}

export type PublishPrCommentResult =
  | { status: "created" | "updated"; commentId: string }
  | { status: "unchanged"; commentId: string }
  | {
    status: "skipped";
    reason: "comments_disabled" | "not_a_pull_request" | "permission_pending";
  }
  /**
   * `alert` is whether this failure is worth telling an administrator about. A
   * missing permission is told once per installation, not once per gate: the
   * Integration screen already names the installation whose review is pending,
   * and one alert per pull request would be the thing that gets muted.
   */
  | { status: "failed"; reason: string; alert: boolean };

export interface PrCommentPublisherDependencies {
  readAuthorizedRepositoryJson(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    permissions: typeof COMMENT_PERMISSIONS,
  ): Promise<unknown>;
  writeAuthorizedRepositoryJson(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    method: "PATCH" | "POST",
    body: unknown,
    permissions: typeof COMMENT_PERMISSIONS,
  ): Promise<unknown>;
  getComment(repositoryKey: string, pullRequestNumber: number): GuardrailPrCommentState | null;
  upsertComment(record: GuardrailPrCommentState): void;
  commentsEnabled(repositoryKey: string): boolean;
  /** Whether this installation has already refused for want of the permission. */
  isPermissionBlocked(installationId: string): boolean;
  /** Records the refusal; `true` only the first time, which is the one alert. */
  recordPermissionBlock(installationId: string, reason: string): boolean;
  clearPermissionBlock(installationId: string): void;
  /** The language the repository's pull-request comments are written in. */
  commentLocale(repositoryKey: string): GuardrailPrCommentLocale;
  /** `null` in local mode: the comment then carries neither banner nor links. */
  publicOrigin(): string | null;
  now(): string;
}

export async function publishPrComment(
  input: PublishPrCommentInput,
  deps: PrCommentPublisherDependencies,
): Promise<PublishPrCommentResult> {
  const pullRequestNumber = input.pullRequestNumber;
  if (
    pullRequestNumber === null
    || !Number.isInteger(pullRequestNumber)
    || pullRequestNumber <= 0
    || input.artifact.target.kind !== "pull_request"
  ) {
    return { status: "skipped", reason: "not_a_pull_request" };
  }
  if (!deps.commentsEnabled(input.repositoryKey)) {
    return { status: "skipped", reason: "comments_disabled" };
  }
  // The installation has already said no. Asking again on every gate spends a
  // request to be refused and raises nothing new; the block is lifted by the
  // Integration refresh that sees the grant.
  if (deps.isPermissionBlocked(input.authority.installationId)) {
    return { status: "skipped", reason: "permission_pending" };
  }
  if (!SAFE_SLUG.test(input.owner) || !SAFE_SLUG.test(input.name)) {
    return record(deps, input, pullRequestNumber, null, null, "github_repository_invalid");
  }

  const origin = deps.publicOrigin();
  const { body } = renderPrComment({
    artifact: input.artifact,
    repositoryKey: input.repositoryKey,
    locale: deps.commentLocale(input.repositoryKey),
    gateUrl: origin === null ? null : `${origin}/guardrails/${encodeURIComponent(input.artifact.gateId)}`,
    assetUrl: (fileName) => origin === null ? null : `${origin}/brand/${fileName}`,
    findingUrl: (identity) => origin === null
      ? null
      : `${origin}/guardrails/${encodeURIComponent(input.artifact.gateId)}?node=${encodeURIComponent(identity)}`,
    durationMs: input.durationMs,
  });
  const bodyHash = createHash("sha256").update(body).digest("hex");

  const stored = deps.getComment(input.repositoryKey, pullRequestNumber);
  if (
    stored !== null
    && stored.status === "published"
    && stored.commentId !== null
    && stored.bodyHash === bodyHash
  ) {
    // The same verdict on the same commit. Editing the comment to its own text
    // would still send everyone watching the pull request a notification.
    return { status: "unchanged", commentId: stored.commentId };
  }

  const issuesPath = `/repos/${input.owner}/${input.name}/issues/${pullRequestNumber}/comments`;
  try {
    let commentId = stored?.commentId ?? null;
    let reason: string | null = null;
    if (commentId === null) {
      const found = await findMarkedComment(input, deps, issuesPath);
      commentId = found.commentId;
      reason = found.reason;
    }

    if (commentId !== null) {
      try {
        await deps.writeAuthorizedRepositoryJson(
          input.authority.connectionId,
          input.authority.installationId,
          input.authority.repositoryId,
          `/repos/${input.owner}/${input.name}/issues/comments/${commentId}`,
          "PATCH",
          { body },
          COMMENT_PERMISSIONS,
        );
        record(deps, input, pullRequestNumber, commentId, bodyHash, null, reason);
        return { status: "updated", commentId };
      } catch (error) {
        // A human deleted it. The pull request still deserves the verdict, so the
        // comment is written again rather than reported as a failure.
        if (!isNotFound(error)) throw error;
        commentId = null;
      }
    }

    const created = await deps.writeAuthorizedRepositoryJson(
      input.authority.connectionId,
      input.authority.installationId,
      input.authority.repositoryId,
      issuesPath,
      "POST",
      { body },
      COMMENT_PERMISSIONS,
    );
    const createdId = commentIdOf(created);
    record(deps, input, pullRequestNumber, createdId, bodyHash, null, reason);
    return { status: "created", commentId: createdId };
  } catch (error) {
    return record(deps, input, pullRequestNumber, stored?.commentId ?? null, null, failureReason(error));
  }
}

/**
 * The stored row is the fast path; the marker is the truth. A row lost to a
 * restored backup, or a repository re-enrolled under a new key, must not make
 * Sentinel open a second comment next to the one it already owns.
 */
async function findMarkedComment(
  input: PublishPrCommentInput,
  deps: PrCommentPublisherDependencies,
  issuesPath: string,
): Promise<{ commentId: string | null; reason: string | null }> {
  const marked: string[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const payload = await deps.readAuthorizedRepositoryJson(
      input.authority.connectionId,
      input.authority.installationId,
      input.authority.repositoryId,
      `${issuesPath}?per_page=${COMMENTS_PER_PAGE}&page=${page}`,
      COMMENT_PERMISSIONS,
    );
    const rows = commentRows(payload);
    for (const row of rows) {
      if (isSentinelComment(row.body, input.repositoryKey)) marked.push(row.id);
    }
    if (rows.length < COMMENTS_PER_PAGE) break;
  }
  if (marked.length === 0) return { commentId: null, reason: null };
  // Two comments carry the marker. Deleting one would destroy a conversation
  // thread Sentinel did not start; the oldest is kept and the ambiguity recorded.
  const oldest = marked.reduce((left, right) => (BigInt(left) <= BigInt(right) ? left : right));
  return { commentId: oldest, reason: marked.length > 1 ? "ambiguous_comment" : null };
}

function record(
  deps: PrCommentPublisherDependencies,
  input: PublishPrCommentInput,
  pullRequestNumber: number,
  commentId: string | null,
  bodyHash: string | null,
  failure: string | null,
  reason: string | null = null,
): { status: "failed"; reason: string; alert: boolean } {
  deps.upsertComment({
    repositoryKey: input.repositoryKey,
    pullRequestNumber,
    commentId,
    status: failure === null ? "published" : "failed",
    reason: failure ?? reason,
    bodyHash,
    gateId: input.artifact.gateId,
    updatedAt: deps.now(),
  });
  if (failure === null) {
    // A comment that went through proves the permission is there.
    deps.clearPermissionBlock(input.authority.installationId);
    return { status: "failed", reason: "unreachable", alert: false };
  }
  const alert = failure === "github_permission_missing"
    ? deps.recordPermissionBlock(input.authority.installationId, failure)
    : true;
  return { status: "failed", reason: failure, alert };
}

function commentRows(value: unknown): Array<{ id: string; body: string }> {
  if (!Array.isArray(value)) throw new Error("github_comment_response_invalid");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("github_comment_response_invalid");
    }
    const row = entry as Record<string, unknown>;
    return { id: numericId(row.id), body: typeof row.body === "string" ? row.body : "" };
  });
}

function commentIdOf(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("github_comment_response_invalid");
  }
  return numericId((value as Record<string, unknown>).id);
}

function numericId(value: unknown): string {
  const id = String(value ?? "");
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new Error("github_comment_response_invalid");
  return id;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "github_not_found";
}

function failureReason(error: unknown): string {
  const code = errorCode(error);
  if (code === "github_credential_rejected") return "github_permission_missing";
  if (code === "github_not_found") return "github_pull_request_not_found";
  if (code === "github_connection_revoked" || code === "github_credential_unavailable") {
    return "github_credential_unavailable";
  }
  if (code === "github_comment_response_invalid") return "github_comment_response_invalid";
  return "github_comment_failed";
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.message : "";
}

export { prCommentMarker };
