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

/**
 * How long a refusal silences an installation before the publisher tries once
 * more. The Integração screen lifts it the moment it sees the grant; this is the
 * floor for everyone who never opens that screen, so a 403 Sentinel misread heals
 * itself within the hour instead of waiting for an administrator.
 */
const PERMISSION_RECHECK_MS = 60 * 60_000;

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
  /**
   * The App's own identity on this connection. A comment may only be adopted when
   * the App wrote it: the marker is public — it is in plain text at the top of
   * every comment Sentinel writes, and "Quote reply" copies it — so anyone who can
   * comment on the pull request can plant one.
   */
  appIdentity(connectionId: string): { appId: string | null; appSlug: string | null };
  /** When this installation's refusal was recorded, or `null` if there is none. */
  permissionBlockedAt(installationId: string): string | null;
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
  // request to be refused and raises nothing new — but a latch nobody can lift is
  // worse than the noise, so once an hour the publisher tries anyway. A failure
  // refreshes the row silently; a success clears it.
  const blockedAt = deps.permissionBlockedAt(input.authority.installationId);
  if (
    blockedAt !== null
    && Date.parse(deps.now()) - Date.parse(blockedAt) < PERMISSION_RECHECK_MS
  ) {
    return { status: "skipped", reason: "permission_pending" };
  }
  if (!SAFE_SLUG.test(input.owner) || !SAFE_SLUG.test(input.name)) {
    return record(deps, input, pullRequestNumber, null, null, {
      reason: "github_repository_invalid",
      latch: false,
    });
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
    return record(deps, input, pullRequestNumber, stored?.commentId ?? null, null, classify(error));
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
  const identity = deps.appIdentity(input.authority.connectionId);
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
      if (isSentinelComment(row.body, input.repositoryKey) && writtenByApp(row, identity)) {
        marked.push(row.id);
      }
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
  failure: CommentFailure | null,
  reason: string | null = null,
): { status: "failed"; reason: string; alert: boolean } {
  deps.upsertComment({
    repositoryKey: input.repositoryKey,
    pullRequestNumber,
    commentId,
    status: failure === null ? "published" : "failed",
    reason: failure?.reason ?? reason,
    bodyHash,
    gateId: input.artifact.gateId,
    updatedAt: deps.now(),
  });
  if (failure === null) {
    // A comment that went through proves the permission is there.
    deps.clearPermissionBlock(input.authority.installationId);
    return { status: "failed", reason: "unreachable", alert: false };
  }
  // Only a refusal GitHub explained as a missing scope silences the installation,
  // and only the first one is announced: re-recording an existing latch refreshes
  // its clock and returns false, so the hourly probe is silent.
  const alert = failure.latch
    ? deps.recordPermissionBlock(input.authority.installationId, failure.reason)
    : true;
  return { status: "failed", reason: failure.reason, alert };
}

interface CommentRow {
  id: string;
  body: string;
  authorLogin: string;
  authorType: string;
  viaAppId: string | null;
}

/**
 * The marker says "this is a Sentinel comment"; the author says "this is *ours*".
 * Only the second can be trusted, so both are required before the publisher edits
 * anything — an adopted comment the App does not own is a `PATCH` GitHub refuses
 * with the very 403 that used to be read as a missing permission.
 */
function writtenByApp(
  row: CommentRow,
  identity: { appId: string | null; appSlug: string | null },
): boolean {
  if (identity.appId !== null && row.viaAppId === identity.appId) return true;
  return identity.appSlug !== null
    && row.authorType === "Bot"
    && row.authorLogin === `${identity.appSlug}[bot]`;
}

function commentRows(value: unknown): CommentRow[] {
  if (!Array.isArray(value)) throw new Error("github_comment_response_invalid");
  return value.map((entry) => {
    const row = objectOf(entry);
    const user = objectOf(row.user ?? {});
    const viaApp = row.performed_via_github_app;
    return {
      id: numericId(row.id),
      body: typeof row.body === "string" ? row.body : "",
      authorLogin: typeof user.login === "string" ? user.login : "",
      authorType: typeof user.type === "string" ? user.type : "",
      viaAppId: viaApp === null || viaApp === undefined
        ? null
        : String(objectOf(viaApp).id ?? ""),
    };
  });
}

function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("github_comment_response_invalid");
  }
  return value as Record<string, unknown>;
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

interface CommentFailure {
  reason: string;
  /** Whether this refusal is the installation's, and not this pull request's. */
  latch: boolean;
}

/**
 * Why the write failed, and whether it says anything about the installation.
 *
 * GitHub answers 403 for a missing scope, a locked conversation, an archived
 * repository, a block, and a secondary rate limit. Only the first is a review an
 * administrator has to approve; the others are this pull request's problem or
 * this minute's, and silencing every repository of the installation for them —
 * which is what the latch does — turns a rate limit into an outage.
 *
 * So the latch asks for GitHub's own words. Anything it did not explain is a
 * failure to report and retry, never a reason to stop asking.
 */
function classify(error: unknown): CommentFailure {
  const code = errorCode(error);
  if (code === "github_not_found") {
    return { reason: "github_pull_request_not_found", latch: false };
  }
  if (code === "github_connection_revoked" || code === "github_credential_unavailable") {
    return { reason: "github_credential_unavailable", latch: false };
  }
  if (code === "github_comment_response_invalid") {
    return { reason: "github_comment_response_invalid", latch: false };
  }
  if (code !== "github_credential_rejected") {
    return { reason: "github_comment_failed", latch: false };
  }

  const detail = errorString(error, "detail");
  // 401 is a token that is wrong or expired, which the next gate mints again.
  if (errorNumber(error, "status") === 401) {
    return { reason: "github_credential_rejected", latch: false };
  }
  if (errorString(error, "retryAfter") !== "" || /rate limit|abuse detection/i.test(detail)) {
    return { reason: "github_rate_limited", latch: false };
  }
  if (/\block(ed|)\b|conversation is locked/i.test(detail)) {
    return { reason: "github_conversation_locked", latch: false };
  }
  if (/archived/i.test(detail)) {
    return { reason: "github_repository_archived", latch: false };
  }
  if (/resource not accessible by integration/i.test(detail)) {
    return { reason: "github_permission_missing", latch: true };
  }
  return { reason: "github_comment_rejected", latch: false };
}

function errorString(error: unknown, key: "detail" | "retryAfter"): string {
  if (typeof error === "object" && error !== null && key in error) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function errorNumber(error: unknown, key: "status"): number | null {
  if (typeof error === "object" && error !== null && key in error) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number") return value;
  }
  return null;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.message : "";
}

export { prCommentMarker };
