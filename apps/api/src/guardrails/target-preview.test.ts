import assert from "node:assert/strict";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";
import type {
  ConnectionCompatibility,
  GateExecutorKind,
  GateTarget,
  GuardrailRepository,
  ResolvedGateTarget,
} from "@csb/shared";

import type { ProtectedPolicyBundle } from "./protected-policy-loader.js";
import {
  TargetPreviewError,
  TargetPreviewService,
  nativeScanCostCeilingSupported,
  parseStartGateRequest,
  parseTargetPreviewRequest,
} from "./target-preview.js";

const BASE_SHA = "a".repeat(40);
const FIRST_HEAD_SHA = "b".repeat(40);
const SECOND_HEAD_SHA = "c".repeat(40);

test("a native cost ceiling accepts only priced models while no ceiling remains available", () => {
  const selection = {
    engine: "codex-security" as const,
    connection: { connectionId: "openai", modelSelectionMode: "catalog" as const, modelId: "gpt-5.3-codex-spark" },
    effort: "xhigh",
    mode: "standard" as const,
  };

  assert.equal(nativeScanCostCeilingSupported(selection, { selectedProfile: "native" }, ["gpt-5.6-sol", "gpt-5.6-terra"]), false);
  assert.equal(nativeScanCostCeilingSupported({
    ...selection,
    connection: { ...selection.connection, modelId: "gpt-5.6-sol" },
  }, { selectedProfile: "native" }, ["gpt-5.6-sol", "gpt-5.6-terra"]), true);
  assert.equal(nativeScanCostCeilingSupported(selection, { selectedProfile: "portable" }, []), true);
  assert.equal(nativeScanCostCeilingSupported({
    ...selection,
    costLimit: { kind: "manual", maxCostUsd: 7 },
  }, { selectedProfile: "native" }, []), false);
  assert.equal(nativeScanCostCeilingSupported({
    ...selection,
    costLimit: { kind: "none" },
  }, { selectedProfile: "native" }, []), true);
});

test("parses policy, manual and no-ceiling scan controls and rejects invalid manual values", () => {
  const base = {
    target: { kind: "pull_request", number: 42 },
    executor: "sentinel-managed",
    scanSelection: {
      engine: "codex-security",
      connection: { connectionId: "openai", modelSelectionMode: "catalog", modelId: "gpt-5.3-codex-spark" },
      mode: "standard",
    },
  };
  for (const costLimit of [{ kind: "policy" }, { kind: "manual", maxCostUsd: 7.5 }, { kind: "none" }]) {
    const parsed = parseTargetPreviewRequest({ ...base, scanSelection: { ...base.scanSelection, costLimit } });
    assert.deepEqual(parsed.scanSelection?.costLimit, costLimit);
  }
  assert.throws(() => parseTargetPreviewRequest({
    ...base,
    scanSelection: { ...base.scanSelection, costLimit: { kind: "manual", maxCostUsd: 0 } },
  }), (error: unknown) => error instanceof TargetPreviewError && error.code === "target_preview_invalid");
});

test("freezes manual and no-ceiling budgets independently from repository policy", async () => {
  const service = previewService({ resolveScanSelection: async () => compatibility() });
  const selection = {
    engine: "codex-security" as const,
    connection: { connectionId: "openai", modelSelectionMode: "catalog" as const, modelId: "gpt-5.3-codex-spark" },
    mode: "standard" as const,
  };
  const manual = await service.create(repository(), {
    target: { kind: "pull_request", number: 42 }, executor: "sentinel-managed",
    scanSelection: { ...selection, costLimit: { kind: "manual", maxCostUsd: 7.5 } },
  });
  assert.deepEqual(manual.costBudget, {
    source: "manual", maxCostUsd: 7.5, kind: "estimated_ceiling", requestInFlightMayExceed: true,
  });
  const none = await service.create(repository(), {
    target: { kind: "pull_request", number: 42 }, executor: "sentinel-managed",
    scanSelection: { ...selection, costLimit: { kind: "none" } },
  });
  assert.deepEqual(none.costBudget, {
    source: "none", maxCostUsd: null, kind: "none", requestInFlightMayExceed: false,
  });
});

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
    source: "policy",
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
  const accepted = await service.accept(repository(), {
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

test("a protected branch freezes a full-repository scan even when policy defaults to changed paths", async () => {
  const service = previewService();

  const preview = await service.create(repository(), {
    target: { kind: "protected_branch", ref: "main" },
    executor: "sentinel-managed",
  });

  assert.equal(preview.scanPlan.scopeMode, "repository");
});

test("freezes only a server-approved managed scanner route into the preview", async () => {
  const service = new TargetPreviewService({
    resolveTarget: async () => resolvedTarget(FIRST_HEAD_SHA),
    loadPolicy: async () => policyBundle(),
    executorCapability: () => ({ ready: true, code: "ready" }),
    resolveScanSelection: (selection) => ({
      ...selection.connection,
      eligible: true,
      reasons: [],
      reasoningEffort: { options: ["high"], default: "high" },
    }),
  });
  const scanSelection = {
    engine: "mantis" as const,
    connection: { connectionId: "minimax", modelSelectionMode: "catalog" as const, modelId: "MiniMax-M3" },
    effort: "high",
    mode: "deep" as const,
  };
  const preview = await service.create(repository(), {
    target: { kind: "pull_request", number: 42 },
    executor: "sentinel-managed",
    scanSelection,
  });

  assert.deepEqual(preview.scanSelection, scanSelection);
  assert.equal(preview.scanPlan.engine, "mantis");
  assert.equal(preview.scanPlan.connectionId, "minimax");
  assert.equal(preview.scanPlan.model, "MiniMax-M3");
  assert.equal(preview.scanPlan.effort, "high");
  assert.equal(preview.scanPlan.mode, "deep");

  const providerManaged = await service.create(repository(), {
    target: { kind: "pull_request", number: 42 },
    executor: "sentinel-managed",
    scanSelection: {
      engine: "vulnhunter",
      connection: { connectionId: "mimo", modelSelectionMode: "runtime-default", modelId: null },
      mode: "standard",
    },
  });
  assert.equal(providerManaged.scanPlan.model, "provider-managed");
  assert.equal(providerManaged.scanPlan.effort, "provider-managed");

  await assert.rejects(
    service.create(repository(), {
      target: { kind: "pull_request", number: 42 },
      executor: "github-actions",
      scanSelection,
    }),
    (error: unknown) => error instanceof TargetPreviewError && error.code === "target_preview_invalid",
  );
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

  await assert.rejects(
    service.accept(repository(), {
      previewIdentity: preview.previewIdentity,
      target: { kind: "pull_request", number: 43 },
      executor: "sentinel-managed",
    }),
    (error: unknown) => error instanceof TargetPreviewError
      && error.code === "target_preview_stale",
  );

  now = new Date("2026-08-12T12:10:00.001Z");
  await assert.rejects(
    service.accept(repository(), {
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
  await assert.rejects(
    service.accept(repository(), {
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
  assert.deepEqual(parseTargetPreviewRequest({
    executor: "sentinel-managed",
    target: { kind: "pull_request", number: 42 },
    scanSelection: {
      engine: "vulnhunter",
      connection: { connectionId: "openrouter", modelSelectionMode: "catalog", modelId: "anthropic/opus" },
      mode: "deep",
    },
  }).scanSelection?.engine, "vulnhunter");
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
  resolveScanSelection(selection: import("@csb/shared").GuardrailScanSelection): Promise<ConnectionCompatibility>;
}> = {}): TargetPreviewService {
  return new TargetPreviewService({
    resolveTarget: overrides.resolveTarget ?? (async () => resolvedTarget(FIRST_HEAD_SHA)),
    loadPolicy: overrides.loadPolicy ?? (async () => policyBundle()),
    executorCapability: overrides.executorCapability ?? (() => ({ ready: true, code: "ready" })),
    createIdentity: overrides.createIdentity ?? (() => "preview-1"),
    now: overrides.now ?? (() => new Date("2026-08-12T12:00:00.000Z")),
    ...(overrides.resolveScanSelection === undefined ? {} : { resolveScanSelection: overrides.resolveScanSelection }),
  });
}

function compatibility(): ConnectionCompatibility {
  return {
    eligible: true,
    connectionId: "openai",
    modelSelectionMode: "catalog",
    modelId: "gpt-5.3-codex-spark",
    selectedProfile: "native",
    profileVersion: "native-v1",
    reasons: [],
  };
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
