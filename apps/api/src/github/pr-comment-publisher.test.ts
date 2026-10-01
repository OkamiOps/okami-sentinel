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
  constructor(readonly code: string) {
    super(code);
  }
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
  existingComments?: Array<{ id: string; body: string }>;
  commentPages?: number;
  postError?: string;
  commentsEnabled?: boolean;
  stored?: GuardrailPrCommentState | null;
  blockedInstallations?: Set<string>;
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
    isPermissionBlocked: (installationId) => blocked.has(installationId),
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
          ? Array.from({ length: 100 }, (_, index) => ({ id: String(page * 1000 + index + 1), body: "chatter" }))
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
        throw new FakeGitHubError("github_credential_rejected");
      }
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
    existingComments: [{ id: "77", body: `${prCommentMarker(REPOSITORY_KEY)}\nold` }],
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
      { id: "88", body: `${prCommentMarker(REPOSITORY_KEY)}\nnewer` },
      { id: "77", body: `${prCommentMarker(REPOSITORY_KEY)}\nolder` },
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
