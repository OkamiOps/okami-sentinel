import assert from "node:assert/strict";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";
import type {
  GateExecutorKind,
  GateTarget,
  GuardrailRepository,
  ResolvedGateTarget,
} from "@csb/shared";

import type { ProtectedPolicyBundle } from "./protected-policy-loader.js";
import {
  TargetPreviewError,
  TargetPreviewService,
  parseStartGateRequest,
  parseTargetPreviewRequest,
} from "./target-preview.js";

const BASE_SHA = "a".repeat(40);
const FIRST_HEAD_SHA = "b".repeat(40);
const SECOND_HEAD_SHA = "c".repeat(40);

test("returns frozen target, policy, executor, scan, cost and publication facts without starting work", async () => {
  let resolved = 0;
  let loaded = 0;
  const service = new TargetPreviewService({
    resolveTarget: async (_repository, target) => {
      resolved += 1;
      assert.deepEqual(target, { kind: "pull_request", number: 42 });
      return resolvedTarget(FIRST_HEAD_SHA);
    },
    loadPolicy: async () => {
      loaded += 1;
      return policyBundle();
    },
    executorCapability: (_repository, executor) => ({
      ready: executor === "sentinel-managed",
      code: executor === "sentinel-managed" ? "ready" : "github_actions_unavailable",
    }),
    createIdentity: () => "preview-1",
    now: () => new Date("2026-08-12T12:00:00.000Z"),
  });

  const preview = await service.create(repository(), {
    target: { kind: "pull_request", number: 42 },
    executor: "sentinel-managed",
  });

  assert.equal(resolved, 1);
  assert.equal(loaded, 1);
  assert.equal(preview.previewIdentity, "preview-1");
  assert.equal(preview.expiresAt, "2026-08-12T12:10:00.000Z");
  assert.equal(preview.resolvedTarget.headSha, FIRST_HEAD_SHA);
  assert.equal(preview.policySource, "base");
  assert.equal(preview.policySha, BASE_SHA);
  assert.deepEqual(preview.executorCapability, { ready: true, code: "ready" });
  assert.deepEqual(preview.scanPlan, {
    scopeMode: "changed",
    maxChangedPaths: 50,
    fallback: "repository",
    model: "gpt-5.6-sol",
    effort: "high",
    mode: "standard",
  });
  assert.deepEqual(preview.costBudget, {
    maxCostUsd: 18,
    kind: "estimated_ceiling",
    requestInFlightMayExceed: true,
  });
  assert.deepEqual(preview.publication, {
    eligible: true,
    protectedBranch: "main",
    reason: "protected_branch",
  });
  assert.equal(preview.exceptionsCount, 0);
});

test("a branch move creates a new preview while accepted identity keeps the original frozen SHAs", async () => {
  let nextHead = FIRST_HEAD_SHA;
  let identity = 0;
  const service = previewService({
    resolveTarget: async () => resolvedTarget(nextHead),
    createIdentity: () => `preview-${++identity}`,
  });
  const target: GateTarget = {
    kind: "compare",
    baseRef: "main",
    headRef: "feature/security",
  };

  const first = await service.create(repository(), { target, executor: "sentinel-managed" });
  nextHead = SECOND_HEAD_SHA;
  const second = await service.create(repository(), { target, executor: "sentinel-managed" });
  const accepted = service.accept(repository(), {
    previewIdentity: first.previewIdentity,
    target,
    executor: "sentinel-managed",
  });

  assert.equal(first.resolvedTarget.headSha, FIRST_HEAD_SHA);
  assert.equal(second.resolvedTarget.headSha, SECOND_HEAD_SHA);
  assert.notEqual(first.previewIdentity, second.previewIdentity);
  assert.equal(accepted.resolvedTarget.headSha, FIRST_HEAD_SHA);
  assert.deepEqual(accepted.policy, defaultGuardrailPolicy());
});

test("rejects expired, mismatched and unavailable accepted previews", async () => {
  let now = new Date("2026-08-12T12:00:00.000Z");
  const service = previewService({
    now: () => now,
    executorCapability: (_repository, executor) => ({
      ready: executor === "sentinel-managed",
      code: executor === "sentinel-managed" ? "ready" : "github_actions_unavailable",
    }),
  });
  const target: GateTarget = { kind: "pull_request", number: 42 };
  const preview = await service.create(repository(), { target, executor: "sentinel-managed" });

  assert.throws(
    () => service.accept(repository(), {
      previewIdentity: preview.previewIdentity,
      target: { kind: "pull_request", number: 43 },
      executor: "sentinel-managed",
    }),
    (error: unknown) => error instanceof TargetPreviewError
      && error.code === "target_preview_stale",
  );

  now = new Date("2026-08-12T12:10:00.001Z");
  assert.throws(
    () => service.accept(repository(), {
      previewIdentity: preview.previewIdentity,
      target,
      executor: "sentinel-managed",
    }),
    (error: unknown) => error instanceof TargetPreviewError
      && error.code === "target_preview_stale",
  );

  const unavailable = await service.create(repository(), {
    target,
    executor: "github-actions",
  });
  assert.throws(
    () => service.accept(repository(), {
      previewIdentity: unavailable.previewIdentity,
      target,
      executor: "github-actions",
    }),
    (error: unknown) => error instanceof TargetPreviewError
      && error.code === "target_preview_executor_unavailable",
  );
});

test("strict request parsers reject implicit refs and client-supplied SHAs", () => {
  assert.deepEqual(parseTargetPreviewRequest({
    executor: "sentinel-managed",
    target: { kind: "protected_branch", ref: "main" },
  }), {
    executor: "sentinel-managed",
    target: { kind: "protected_branch", ref: "main" },
  });
  assert.deepEqual(parseStartGateRequest({
    repositoryKey: "github:991122",
    executor: "sentinel-managed",
    target: { kind: "pull_request", number: 42 },
    previewIdentity: "preview-1",
  }), {
    repositoryKey: "github:991122",
    executor: "sentinel-managed",
    target: { kind: "pull_request", number: 42 },
    previewIdentity: "preview-1",
  });
  for (const input of [
    { repositoryKey: "github:991122", target: { kind: "compare", baseRef: "main", headRef: "HEAD" } },
    { repositoryKey: "github:991122", target: { kind: "pull_request", number: 42 }, headSha: FIRST_HEAD_SHA },
  ]) {
    assert.throws(() => parseStartGateRequest(input), TargetPreviewError);
  }
});

function previewService(overrides: Partial<{
  resolveTarget(repository: GuardrailRepository, target: GateTarget): Promise<ResolvedGateTarget>;
  loadPolicy(
    repository: GuardrailRepository,
    target: GateTarget,
    resolved: ResolvedGateTarget,
  ): Promise<ProtectedPolicyBundle>;
  executorCapability(
    repository: GuardrailRepository,
    executor: GateExecutorKind,
  ): { ready: boolean; code: "ready" | "managed_executor_unavailable" | "github_actions_unavailable" };
  createIdentity(): string;
  now(): Date;
}> = {}): TargetPreviewService {
  return new TargetPreviewService({
    resolveTarget: overrides.resolveTarget ?? (async () => resolvedTarget(FIRST_HEAD_SHA)),
    loadPolicy: overrides.loadPolicy ?? (async () => policyBundle()),
    executorCapability: overrides.executorCapability ?? (() => ({ ready: true, code: "ready" })),
    createIdentity: overrides.createIdentity ?? (() => "preview-1"),
    now: overrides.now ?? (() => new Date("2026-08-12T12:00:00.000Z")),
  });
}

function policyBundle(): ProtectedPolicyBundle {
  return {
    policy: defaultGuardrailPolicy(),
    exceptions: [],
    policySource: "base",
    policySha: BASE_SHA,
  };
}

function resolvedTarget(headSha: string): ResolvedGateTarget {
  return {
    baseRef: "main",
    headRef: "feature/security",
    baseSha: BASE_SHA,
    headSha,
    policySha: BASE_SHA,
    pullRequestNumber: null,
  };
}

function repository(): GuardrailRepository {
  return {
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    displayName: "OkamiOps/private-sentinel",
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: "OkamiOps",
    remoteName: "private-sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "991122",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
  };
}
