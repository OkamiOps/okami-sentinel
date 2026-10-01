import assert from "node:assert/strict";
import test from "node:test";

import type { GateArtifactV2, GuardrailPrCommentState } from "@csb/shared";

import { prCommentMarker } from "./pr-comment-render.js";
import {
  publishPrComment,
  type PrCommentPublisherDependencies,
  type PublishPrCommentInput,
} from "./pr-comment-publisher.js";

const REPOSITORY_KEY = "github:1";

class FakeGitHubError extends Error {
  readonly status: number | null;
  readonly detail: string;
  readonly retryAfter: string | null;
  constructor(
    readonly code: string,
    options: { status?: number; detail?: string; retryAfter?: string } = {},
  ) {
    super(code);
    this.status = options.status ?? null;
    this.detail = options.detail ?? "";
    this.retryAfter = options.retryAfter ?? null;
  }
}

/** What GitHub says when the App has no `pull_requests: write`. */
const NO_SCOPE = { status: 403, detail: "Resource not accessible by integration" };

/** A comment written by the App itself, which is the only one it may adopt. */
function ourComment(id: string, body: string) {
  return { id, body, user: { login: "okami-sentinel[bot]", type: "Bot" }, performed_via_github_app: { id: 4242 } };
}

/** A comment by a human who pasted — or quoted — the marker. */
function strangerComment(id: string, body: string) {
  return { id, body, user: { login: "attacker", type: "User" }, performed_via_github_app: null };
}

/**
 * The renderer has its own suite against a validated artifact. What the publisher
 * needs is only the shape the renderer reads, so the HTTP dance is what this file
 * is about.
 */
function artifact(overrides: Partial<GateArtifactV2> = {}): GateArtifactV2 {
  return {
    schemaVersion: 2,
    gateId: "gate-1",
    repository: {
      id: "github:1",
      key: REPOSITORY_KEY,
      owner: "OkamiOps",
      name: "sentinel",
      defaultBranch: "main",
      locator: { kind: "github", repositoryId: "1", owner: "OkamiOps", name: "sentinel" },
    },
    source: "github",
    executor: "sentinel-managed",
    target: { kind: "pull_request", number: 7 },
    baselineNotice: null,
    baselineCommit: "a".repeat(40),
    changeSet: { headSha: "b".repeat(40) },
    scan: { id: "scan-1", cost: { estimatedUsd: 0.42 }, status: "completed" },
    findings: [],
    decision: { outcome: "pass", summary: "Nothing new." },
    lineage: { model: "MiniMax-M3" },
    ...overrides,
  } as unknown as GateArtifactV2;
}

interface Call { method: string; path: string; body?: unknown }

interface FakeOptions {
  patchStatus?: number;
  existingComments?: unknown[];
  commentPages?: number;
  postError?: string;
  commentsEnabled?: boolean;
  stored?: GuardrailPrCommentState | null;
  blockedInstallations?: Set<string>;
  blockedAt?: string;
  patchError?: FakeGitHubError;
  postFailure?: FakeGitHubError;
}

function publisherDeps(options: FakeOptions = {}): PrCommentPublisherDependencies & {
  calls: Call[];
  rows: Map<number, GuardrailPrCommentState>;
  blocked: Set<string>;
  blockRecords: number;
} {
  const calls: Call[] = [];
  const rows = new Map<number, GuardrailPrCommentState>();
  const blocked = new Set(options.blockedInstallations ?? []);
  let blockRecords = 0;
  if (options.stored) rows.set(options.stored.pullRequestNumber, options.stored);
  let nextId = 100;
  return {
    calls,
    rows,
    blocked,
    get blockRecords() { return blockRecords; },
    appIdentity: () => ({ appId: "4242", appSlug: "okami-sentinel" }),
    permissionBlockedAt: (installationId) =>
      blocked.has(installationId) ? options.blockedAt ?? "2026-09-30T11:59:00.000Z" : null,
    recordPermissionBlock: (installationId) => {
      blockRecords += 1;
      if (blocked.has(installationId)) return false;
      blocked.add(installationId);
      return true;
    },
    clearPermissionBlock: (installationId) => { blocked.delete(installationId); },
    readAuthorizedRepositoryJson: async (_c, _i, _r, path) => {
      calls.push({ method: "GET", path });
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
      if (options.commentPages !== undefined) {
        // Every page full, so the scan only stops because it is capped.
        return page <= options.commentPages
          ? Array.from({ length: 100 }, (_, index) => strangerComment(String(page * 1000 + index + 1), "chatter"))
          : [];
      }
      return page === 1 ? options.existingComments ?? [] : [];
    },
    writeAuthorizedRepositoryJson: async (_c, _i, _r, path, method, body) => {
      calls.push({ method, path, body });
      if (method === "PATCH" && options.patchStatus === 404) {
        throw new FakeGitHubError("github_not_found");
      }
      if (method === "PATCH" && options.patchStatus === 403) {
        throw options.patchError ?? new FakeGitHubError("github_credential_rejected", NO_SCOPE);
      }
      if (method === "POST" && options.postFailure !== undefined) throw options.postFailure;
      if (method === "POST" && options.postError !== undefined) {
        throw new FakeGitHubError(options.postError);
      }
      nextId += 1;
      return { id: String(nextId) };
    },
    getComment: (_key, pullRequestNumber) => rows.get(pullRequestNumber) ?? null,
    upsertComment: (row) => { rows.set(row.pullRequestNumber, row); },
    commentsEnabled: () => options.commentsEnabled ?? true,
    commentLocale: () => "pt-BR",
    publicOrigin: () => "https://sentinel.example",
    now: () => "2026-09-30T12:00:00.000Z",
  };
}

function input(overrides: Partial<PublishPrCommentInput> = {}): PublishPrCommentInput {
  return {
    artifact: artifact(),
    repositoryKey: REPOSITORY_KEY,
    authority: { connectionId: "connection-1", installationId: "77", repositoryId: "1" },
    owner: "OkamiOps",
    name: "sentinel",
    pullRequestNumber: 7,
    durationMs: 1_000,
    ...overrides,
  };
}

function storedRow(overrides: Partial<GuardrailPrCommentState> = {}): GuardrailPrCommentState {
  return {
    repositoryKey: REPOSITORY_KEY,
    pullRequestNumber: 7,
    commentId: "91",
    status: "published",
    reason: null,
    bodyHash: "stale",
    gateId: "gate-0",
    updatedAt: "2026-09-29T12:00:00.000Z",
    ...overrides,
  };
}

test("creates the comment on the first gate of a pull request", async () => {
  const deps = publisherDeps();
  const result = await publishPrComment(input(), deps);
  assert.equal(result.status, "created");
  const post = deps.calls.find((call) => call.method === "POST");
  assert.equal(post?.path, "/repos/OkamiOps/sentinel/issues/7/comments");
  assert.ok(String((post?.body as { body: string }).body).startsWith(prCommentMarker(REPOSITORY_KEY)));
  assert.equal(deps.rows.get(7)?.status, "published");
  assert.equal(deps.rows.get(7)?.commentId, "101");
});

test("edits the same comment on the next commit", async () => {
  const deps = publisherDeps({ stored: storedRow() });
  const result = await publishPrComment(input(), deps);
  assert.deepEqual(result, { status: "updated", commentId: "91" });
  assert.equal(deps.calls.filter((call) => call.method === "PATCH").length, 1);
  assert.equal(deps.calls[0]?.path, "/repos/OkamiOps/sentinel/issues/comments/91");
});

test("makes no call when the body is unchanged", async () => {
  const deps = publisherDeps();
  await publishPrComment(input(), deps);
  const before = deps.calls.length;
  const second = await publishPrComment(input(), deps);
  assert.equal(second.status, "unchanged");
  assert.equal(deps.calls.length, before);
});

test("recreates the comment a human deleted", async () => {
  const deps = publisherDeps({ patchStatus: 404, existingComments: [], stored: storedRow() });
  const result = await publishPrComment(input(), deps);
  assert.equal(result.status, "created");
  assert.ok(deps.calls.some((call) => call.method === "POST"));
  assert.equal(deps.rows.get(7)?.status, "published");
});

test("finds an existing comment by its marker when the row is missing", async () => {
  const deps = publisherDeps({
    existingComments: [ourComment("77", `${prCommentMarker(REPOSITORY_KEY)}\nold`)],
  });
  const result = await publishPrComment(input(), deps);
  assert.deepEqual(result, { status: "updated", commentId: "77" });
});

test("stops the marker scan at three pages", async () => {
  const deps = publisherDeps({ commentPages: 10 });
  await publishPrComment(input(), deps);
  assert.equal(deps.calls.filter((call) => call.method === "GET").length, 3);
});

test("uses the oldest of two marked comments and records the ambiguity", async () => {
  const deps = publisherDeps({
    existingComments: [
      ourComment("88", `${prCommentMarker(REPOSITORY_KEY)}\nnewer`),
      ourComment("77", `${prCommentMarker(REPOSITORY_KEY)}\nolder`),
    ],
  });
  const result = await publishPrComment(input(), deps);
  assert.deepEqual(result, { status: "updated", commentId: "77" });
  assert.equal(deps.rows.get(7)?.reason, "ambiguous_comment");
  assert.ok(!deps.calls.some((call) => call.method === "DELETE"));
});

test("skips a repository with comments disabled", async () => {
  const deps = publisherDeps({ commentsEnabled: false });
  assert.deepEqual(
    await publishPrComment(input(), deps),
    { status: "skipped", reason: "comments_disabled" },
  );
  assert.equal(deps.calls.length, 0);
});

test("skips a protected-branch gate", async () => {
  const deps = publisherDeps();
  const result = await publishPrComment(input({
    artifact: artifact({ target: { kind: "protected_branch", ref: "main" } }),
    pullRequestNumber: null,
  }), deps);
  assert.deepEqual(result, { status: "skipped", reason: "not_a_pull_request" });
  assert.equal(deps.calls.length, 0);
});

test("records a failure and its reason without throwing", async () => {
  const deps = publisherDeps({ patchStatus: 403, stored: storedRow() });
  const result = await publishPrComment(input(), deps);
  assert.deepEqual(result, {
    status: "failed",
    reason: "github_permission_missing",
    alert: true,
  });
  assert.equal(deps.rows.get(7)?.status, "failed");
  assert.equal(deps.rows.get(7)?.reason, "github_permission_missing");
});

test("a missing permission is announced once, then recorded against the installation", async () => {
  const deps = publisherDeps({ patchStatus: 403, stored: storedRow() });
  const first = await publishPrComment(input(), deps);
  assert.deepEqual(first, { status: "failed", reason: "github_permission_missing", alert: true });
  assert.ok(deps.blocked.has("77"));
  // The second pull request under the same installation is not a second alert.
  const second = await publishPrComment(input({ pullRequestNumber: 8 }), {
    ...deps,
    getComment: () => storedRow({ pullRequestNumber: 8 }),
  });
  assert.deepEqual(second, { status: "skipped", reason: "permission_pending" });
});

test("a blocked installation costs no GitHub call at all", async () => {
  const deps = publisherDeps({ blockedInstallations: new Set(["77"]) });
  const result = await publishPrComment(input(), deps);
  assert.deepEqual(result, { status: "skipped", reason: "permission_pending" });
  assert.equal(deps.calls.length, 0);
});

test("a comment that goes through lifts the installation's block", async () => {
  const deps = publisherDeps({ blockedInstallations: new Set(["99"]) });
  // Another installation's block is not this one's.
  const result = await publishPrComment(input(), deps);
  assert.equal(result.status, "created");
  assert.deepEqual([...deps.blocked], ["99"]);

  const recovered = publisherDeps({ blockedInstallations: new Set(["77"]) });
  recovered.blocked.delete("77");
  const second = await publishPrComment(input(), recovered);
  assert.equal(second.status, "created");
  assert.equal(recovered.blocked.size, 0);
});

test("a failure that is not the permission is always announced", async () => {
  const deps = publisherDeps({ postError: "github_unavailable" });
  const result = await publishPrComment(input(), deps);
  assert.deepEqual(result, { status: "failed", reason: "github_comment_failed", alert: true });
  assert.equal(deps.blocked.size, 0);
});

test("a failed row is retried instead of being read as unchanged", async () => {
  const deps = publisherDeps({ postError: "github_unavailable" });
  const first = await publishPrComment(input(), deps);
  assert.equal(first.status, "failed");
  const retried = publisherDeps({ stored: deps.rows.get(7) ?? null });
  const second = await publishPrComment(input(), retried);
  assert.equal(second.status, "created");
});

test("asks GitHub for pull_requests write and never for issues", async () => {
  const deps = publisherDeps();
  const permissions: unknown[] = [];
  await publishPrComment(input(), {
    ...deps,
    writeAuthorizedRepositoryJson: async (c, i, r, path, method, body, scope) => {
      permissions.push(scope);
      return deps.writeAuthorizedRepositoryJson(c, i, r, path, method, body, scope);
    },
  });
  assert.deepEqual(permissions, [{ pull_requests: "write" }]);
});

test("ignores a marker a stranger planted, and writes its own comment", async () => {
  // The marker is public: it sits in plain text at the top of every comment
  // Sentinel writes, and GitHub's "Quote reply" copies it verbatim. Adopting it
  // means a PATCH on someone else's comment, which GitHub refuses with the same
  // 403 a missing permission gives.
  const deps = publisherDeps({
    existingComments: [strangerComment("55", `${prCommentMarker(REPOSITORY_KEY)}\nplanted`)],
  });
  const result = await publishPrComment(input(), deps);
  assert.equal(result.status, "created");
  assert.ok(!deps.calls.some((call) => call.method === "PATCH"));
  assert.equal(deps.blocked.size, 0);
});

test("ignores a marker quoted by another App's bot", async () => {
  const deps = publisherDeps({
    existingComments: [{
      id: "56",
      body: `> ${prCommentMarker(REPOSITORY_KEY)}\nquoted`,
      user: { login: "dependabot[bot]", type: "Bot" },
      performed_via_github_app: { id: 9999 },
    }],
  });
  assert.equal((await publishPrComment(input(), deps)).status, "created");
});

test("adopts the comment the App itself wrote, by its own app id", async () => {
  const deps = publisherDeps({
    existingComments: [{
      id: "77",
      body: `${prCommentMarker(REPOSITORY_KEY)}\nold`,
      user: { login: "someone-else", type: "User" },
      performed_via_github_app: { id: 4242 },
    }],
  });
  assert.deepEqual(await publishPrComment(input(), deps), { status: "updated", commentId: "77" });
});

test("prefers the stored comment id and never searches", async () => {
  const deps = publisherDeps({ stored: storedRow() });
  await publishPrComment(input(), deps);
  assert.equal(deps.calls.filter((call) => call.method === "GET").length, 0);
});

test("a locked conversation does not latch the installation", async () => {
  const deps = publisherDeps({
    postFailure: new FakeGitHubError("github_credential_rejected", {
      status: 403,
      detail: "Unable to create comment because issue is locked.",
    }),
  });
  const result = await publishPrComment(input(), deps);
  assert.deepEqual(result, { status: "failed", reason: "github_conversation_locked", alert: true });
  assert.equal(deps.blocked.size, 0);
});

test("an archived repository does not latch the installation", async () => {
  const deps = publisherDeps({
    postFailure: new FakeGitHubError("github_credential_rejected", {
      status: 403,
      detail: "Repository was archived so is read-only.",
    }),
  });
  const result = await publishPrComment(input(), deps);
  assert.deepEqual(result, { status: "failed", reason: "github_repository_archived", alert: true });
  assert.equal(deps.blocked.size, 0);
});

test("a secondary rate limit does not latch the installation", async () => {
  const byMessage = publisherDeps({
    postFailure: new FakeGitHubError("github_credential_rejected", {
      status: 403,
      detail: "You have exceeded a secondary rate limit. Please wait a few minutes.",
    }),
  });
  assert.deepEqual(
    await publishPrComment(input(), byMessage),
    { status: "failed", reason: "github_rate_limited", alert: true },
  );
  assert.equal(byMessage.blocked.size, 0);

  const byHeader = publisherDeps({
    postFailure: new FakeGitHubError("github_credential_rejected", { status: 403, retryAfter: "60" }),
  });
  const rateLimited = await publishPrComment(input(), byHeader);
  assert.equal(rateLimited.status === "failed" && rateLimited.reason, "github_rate_limited");
  assert.equal(byHeader.blocked.size, 0);
});

test("a token problem does not latch the installation", async () => {
  const deps = publisherDeps({
    postFailure: new FakeGitHubError("github_credential_rejected", { status: 401, detail: "Bad credentials" }),
  });
  const result = await publishPrComment(input(), deps);
  assert.deepEqual(result, { status: "failed", reason: "github_credential_rejected", alert: true });
  assert.equal(deps.blocked.size, 0);
});

test("only GitHub's own words about the scope latch the installation", async () => {
  const deps = publisherDeps({
    postFailure: new FakeGitHubError("github_credential_rejected", {
      status: 403,
      detail: "Resource not accessible by integration",
    }),
  });
  const result = await publishPrComment(input(), deps);
  assert.deepEqual(result, { status: "failed", reason: "github_permission_missing", alert: true });
  assert.deepEqual([...deps.blocked], ["77"]);
});

test("a 403 GitHub does not explain is a failure, not a latch", async () => {
  const deps = publisherDeps({
    postFailure: new FakeGitHubError("github_credential_rejected", { status: 403, detail: "" }),
  });
  const result = await publishPrComment(input(), deps);
  assert.equal(result.status, "failed");
  assert.equal(deps.blocked.size, 0);
});

test("the latch is probed again after an hour, and the probe is not a second alert", async () => {
  const fresh = publisherDeps({
    blockedInstallations: new Set(["77"]),
    blockedAt: "2026-09-30T11:59:00.000Z",
  });
  assert.deepEqual(
    await publishPrComment(input(), fresh),
    { status: "skipped", reason: "permission_pending" },
  );
  assert.equal(fresh.calls.length, 0);

  // An hour later the publisher tries once. It still fails, and the operator is
  // not told again: the row is refreshed, not inserted.
  const stale = publisherDeps({
    blockedInstallations: new Set(["77"]),
    blockedAt: "2026-09-30T10:00:00.000Z",
    postFailure: new FakeGitHubError("github_credential_rejected", NO_SCOPE),
  });
  const probed = await publishPrComment(input(), stale);
  assert.deepEqual(probed, { status: "failed", reason: "github_permission_missing", alert: false });
  assert.ok(stale.calls.some((call) => call.method === "POST"));
});

test("an hourly probe that goes through lifts the latch", async () => {
  const deps = publisherDeps({
    blockedInstallations: new Set(["77"]),
    blockedAt: "2026-09-30T10:00:00.000Z",
  });
  assert.equal((await publishPrComment(input(), deps)).status, "created");
  assert.equal(deps.blocked.size, 0);
});
