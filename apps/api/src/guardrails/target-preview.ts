import { randomUUID } from "node:crypto";

import { gatePublicationEligibility } from "@csb/gate-core";
import type {
  GateExecutorKind,
  GatePublicationEligibility,
  GateTarget,
  GuardrailException,
  GuardrailPolicy,
  GuardrailRepository,
  ResolvedGateTarget,
} from "@csb/shared";

import { parseGateTarget } from "./github-ref-resolver.js";
import type { ProtectedPolicyBundle } from "./protected-policy-loader.js";

const PREVIEW_TTL_MS = 10 * 60 * 1_000;

export type TargetPreviewCapabilityCode =
  | "ready"
  | "managed_executor_unavailable"
  | "github_actions_unavailable";

export type TargetPreviewErrorCode =
  | "target_preview_invalid"
  | "target_preview_stale"
  | "target_preview_executor_unavailable";

export class TargetPreviewError extends Error {
  constructor(readonly code: TargetPreviewErrorCode) {
    super(code);
    this.name = "TargetPreviewError";
  }
}

export interface TargetPreviewRequest {
  target: GateTarget;
  executor?: GateExecutorKind;
}

export interface StartGateRequest {
  repositoryKey: string;
  target: GateTarget;
  executor?: GateExecutorKind;
  previewIdentity?: string;
}

export interface AcceptTargetPreviewRequest {
  previewIdentity: string;
  target: GateTarget;
  executor: GateExecutorKind;
}

export interface GateTargetPreview {
  previewIdentity: string;
  expiresAt: string;
  repositoryKey: string;
  executor: GateExecutorKind;
  target: GateTarget;
  resolvedTarget: ResolvedGateTarget;
  policySource: ProtectedPolicyBundle["policySource"];
  policySha: string;
  policyPath: ".csb/guardrails.json";
  protectedBranches: string[];
  exceptionsCount: number;
  executorCapability: {
    ready: boolean;
    code: TargetPreviewCapabilityCode;
  };
  scanPlan: {
    scopeMode: "changed" | "repository";
    maxChangedPaths: number;
    fallback: "repository" | "error";
    model: string;
    effort: string;
    mode: "standard" | "deep";
  };
  costBudget: {
    maxCostUsd: number;
    kind: "estimated_ceiling";
    requestInFlightMayExceed: true;
  };
  publication: GatePublicationEligibility;
}

export interface AcceptedGateTargetPreview extends GateTargetPreview {
  policy: GuardrailPolicy;
  exceptions: GuardrailException[];
  repositoryAuthority: {
    connectionId: string;
    installationId: string;
    repositoryId: string;
  };
}

export interface TargetPreviewDependencies {
  resolveTarget(
    repository: GuardrailRepository,
    target: GateTarget,
  ): Promise<ResolvedGateTarget>;
  loadPolicy(
    repository: GuardrailRepository,
    target: GateTarget,
    resolved: ResolvedGateTarget,
  ): Promise<ProtectedPolicyBundle>;
  executorCapability(
    repository: GuardrailRepository,
    executor: GateExecutorKind,
  ): GateTargetPreview["executorCapability"] | Promise<GateTargetPreview["executorCapability"]>;
  createIdentity?(): string;
  now?(): Date;
}

export class TargetPreviewService {
  readonly #previews = new Map<string, AcceptedGateTargetPreview>();
  readonly #createIdentity: () => string;
  readonly #now: () => Date;

  constructor(readonly dependencies: TargetPreviewDependencies) {
    this.#createIdentity = dependencies.createIdentity ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async create(
    repository: GuardrailRepository,
    request: TargetPreviewRequest,
  ): Promise<GateTargetPreview> {
    if (repository.source !== "github" || repository.repositoryPath !== null) invalid();
    this.#prune();
    const executor = request.executor ?? repository.defaultExecutor;
    const target = structuredClone(request.target);
    const resolvedTarget = await this.dependencies.resolveTarget(repository, target);
    const protectedPolicy = await this.dependencies.loadPolicy(repository, target, resolvedTarget);
    const capability = await this.dependencies.executorCapability(repository, executor);
    const now = this.#now();
    const preview: GateTargetPreview = {
      previewIdentity: boundedString(this.#createIdentity(), 255),
      expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS).toISOString(),
      repositoryKey: repository.repositoryKey,
      executor,
      target,
      resolvedTarget: structuredClone(resolvedTarget),
      policySource: protectedPolicy.policySource,
      policySha: protectedPolicy.policySha,
      policyPath: ".csb/guardrails.json",
      protectedBranches: [...protectedPolicy.policy.protectedBranches],
      exceptionsCount: protectedPolicy.exceptions.length,
      executorCapability: { ...capability },
      scanPlan: {
        scopeMode: protectedPolicy.policy.scope.mode,
        maxChangedPaths: protectedPolicy.policy.scope.maxChangedPaths,
        fallback: protectedPolicy.policy.scope.fallback,
        model: protectedPolicy.policy.scan.model,
        effort: protectedPolicy.policy.scan.effort,
        mode: protectedPolicy.policy.scan.mode,
      },
      costBudget: {
        maxCostUsd: protectedPolicy.policy.scan.maxCostUsd,
        kind: "estimated_ceiling",
        requestInFlightMayExceed: true,
      },
      publication: gatePublicationEligibility(
        protectedPolicy.policy,
        target,
        resolvedTarget,
      ),
    };
    this.#previews.set(preview.previewIdentity, {
      ...structuredClone(preview),
      policy: structuredClone(protectedPolicy.policy),
      exceptions: structuredClone(protectedPolicy.exceptions),
      repositoryAuthority: remoteAuthority(repository),
    });
    return structuredClone(preview);
  }

  async accept(
    repository: GuardrailRepository,
    request: AcceptTargetPreviewRequest,
  ): Promise<AcceptedGateTargetPreview> {
    this.#prune();
    const preview = this.#previews.get(request.previewIdentity);
    const authority = remoteAuthority(repository);
    if (
      preview === undefined
      || preview.repositoryKey !== repository.repositoryKey
      || preview.executor !== request.executor
      || JSON.stringify(preview.target) !== JSON.stringify(request.target)
      || JSON.stringify(preview.repositoryAuthority) !== JSON.stringify(authority)
    ) {
      throw new TargetPreviewError("target_preview_stale");
    }
    const currentCapability = await this.dependencies.executorCapability(
      repository,
      request.executor,
    );
    if (!preview.executorCapability.ready || !currentCapability.ready) {
      throw new TargetPreviewError("target_preview_executor_unavailable");
    }
    return structuredClone(preview);
  }

  #prune(): void {
    const now = this.#now().getTime();
    for (const [identity, preview] of this.#previews) {
      if (Date.parse(preview.expiresAt) <= now) this.#previews.delete(identity);
    }
  }
}

export function parseTargetPreviewRequest(value: unknown): TargetPreviewRequest {
  const input = record(value);
  exactKeys(input, new Set(["target", "executor"]), new Set(["executor"]));
  const executor = optionalExecutor(input.executor);
  return executor === undefined
    ? { target: parsedTarget(input.target) }
    : { target: parsedTarget(input.target), executor };
}

export function parseStartGateRequest(value: unknown): StartGateRequest {
  const input = record(value);
  exactKeys(
    input,
    new Set(["repositoryKey", "target", "executor", "previewIdentity"]),
    new Set(["executor", "previewIdentity"]),
  );
  const repositoryKey = boundedString(input.repositoryKey, 255);
  const target = parsedTarget(input.target);
  const executor = optionalExecutor(input.executor);
  const previewIdentity = input.previewIdentity === undefined
    ? undefined
    : boundedString(input.previewIdentity, 255);
  return {
    repositoryKey,
    target,
    ...(executor === undefined ? {} : { executor }),
    ...(previewIdentity === undefined ? {} : { previewIdentity }),
  };
}

function optionalExecutor(value: unknown): GateExecutorKind | undefined {
  if (value === undefined) return undefined;
  if (value !== "sentinel-managed" && value !== "github-actions") invalid();
  return value;
}

function remoteAuthority(repository: GuardrailRepository): AcceptedGateTargetPreview["repositoryAuthority"] {
  if (
    repository.source !== "github"
    || repository.repositoryPath !== null
    || repository.githubConnectionId === null
    || repository.githubInstallationId === null
    || repository.githubRepositoryId === null
  ) invalid();
  return {
    connectionId: boundedString(repository.githubConnectionId, 255),
    installationId: boundedString(repository.githubInstallationId, 20),
    repositoryId: boundedString(repository.githubRepositoryId, 20),
  };
}

function parsedTarget(value: unknown): GateTarget {
  try {
    return parseGateTarget(value);
  } catch {
    invalid();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  optional: ReadonlySet<string>,
): void {
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || [...allowed].some((key) => !optional.has(key) && !(key in value))
  ) invalid();
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || normalized.includes("\0")) invalid();
  return normalized;
}

function invalid(): never {
  throw new TargetPreviewError("target_preview_invalid");
}
