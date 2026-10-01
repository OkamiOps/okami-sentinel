import assert from "node:assert/strict";
import test from "node:test";

import type { GateRun, GuardrailPrCommentState } from "@csb/shared";

import {
  commentStateLabelKey,
  commentUrl,
  publicationStateLabelKey,
  pullRequestUrl,
} from "./gate-publication.js";

function gate(overrides: Partial<GateRun> = {}): GateRun {
  return {
    id: "gate-1",
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    executor: "sentinel-managed",
    baseRef: "main",
    headRef: "refs/pull/7/head",
    resolvedBaseSha: null,
    resolvedHeadSha: null,
    policySha: null,
    policySource: null,
    pullRequestNumber: 7,
    workflowRunId: null,
    materializationState: "not_required",
    scanLineageHash: null,
    artifactSchemaVersion: 2,
    scanId: null,
    status: "completed",
    outcome: "blocked",
    policyVersion: 1,
    baselineCommit: null,
    artifactPath: null,
    publishStatus: "published",
    publishError: null,
    publishedAt: null,
    error: null,
    startedAt: "2026-09-30T00:00:00.000Z",
    completedAt: "2026-09-30T00:05:00.000Z",
    costCeilingUsd: 18,
    estimatedUsd: 0,
    ...overrides,
  };
}

function comment(overrides: Partial<GuardrailPrCommentState> = {}): GuardrailPrCommentState {
  return {
    repositoryKey: "github:991122",
    pullRequestNumber: 7,
    commentId: "101",
    status: "published",
    reason: null,
    bodyHash: "hash",
    gateId: "gate-1",
    updatedAt: "2026-09-30T00:05:00.000Z",
    ...overrides,
  };
}

const LOCATOR = { owner: "OkamiOps", name: "private-sentinel" };

test("builds the pull request url from the gate's locator and number", () => {
  assert.equal(
    pullRequestUrl(gate(), LOCATOR),
    "https://github.com/OkamiOps/private-sentinel/pull/7",
  );
});

test("returns null for a gate with no pull request", () => {
  assert.equal(pullRequestUrl(gate({ pullRequestNumber: null }), LOCATOR), null);
  assert.equal(pullRequestUrl(gate(), null), null);
});

test("refuses an owner or name that is not a GitHub slug", () => {
  assert.equal(pullRequestUrl(gate(), { owner: "a/../b", name: "x" }), null);
  assert.equal(pullRequestUrl(gate(), { owner: "a", name: "x y" }), null);
});

test("builds the comment permalink as <prUrl>#issuecomment-<id>", () => {
  assert.equal(
    commentUrl(gate(), comment(), LOCATOR),
    "https://github.com/OkamiOps/private-sentinel/pull/7#issuecomment-101",
  );
});

test("has no comment permalink without a published comment id", () => {
  assert.equal(commentUrl(gate(), null, LOCATOR), null);
  assert.equal(commentUrl(gate(), comment({ commentId: null }), LOCATOR), null);
  assert.equal(commentUrl(gate(), comment({ commentId: "0x1" }), LOCATOR), null);
});

test("names a failed publication and a failed comment separately", () => {
  assert.equal(
    publicationStateLabelKey(gate({ publishStatus: "failed" })),
    "guardrails.publication.failed",
  );
  assert.equal(
    commentStateLabelKey(comment({ status: "failed" })),
    "guardrails.comment.failed",
  );
  assert.equal(publicationStateLabelKey(gate()), "guardrails.publication.published");
  assert.equal(commentStateLabelKey(comment()), "guardrails.comment.published");
});

test("a pull request nobody has commented on is not a failure", () => {
  assert.equal(commentStateLabelKey(null), "guardrails.comment.absent");
});
