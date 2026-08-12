import type {
  GateTarget,
  GuardrailRepository,
  ResolvedGateTarget,
} from "@csb/shared";

import type { GitHubRepositoryReader } from "./repository-source-adapter.js";

export type GitHubTargetResolutionErrorCode = "github_target_invalid";

export class GitHubTargetResolutionError extends Error {
  constructor(readonly code: GitHubTargetResolutionErrorCode) {
    super(code);
    this.name = "GitHubTargetResolutionError";
  }
}

export class GitHubRefResolver {
  constructor(readonly reader: GitHubRepositoryReader) {}

  async resolve(
    repository: GuardrailRepository,
    target: GateTarget,
  ): Promise<ResolvedGateTarget> {
    if (target.kind === "pull_request") {
      const value = record(await this.reader.readPullRequest(repository, target.number));
      const base = record(value.base);
      const head = record(value.head);
      if (value.number !== target.number) fail();
      const baseSha = fullSha(base.sha);
      return {
        baseRef: humanRef(base.ref),
        headRef: humanRef(head.ref),
        baseSha,
        headSha: fullSha(head.sha),
        policySha: baseSha,
        pullRequestNumber: target.number,
      };
    }

    if (target.kind === "compare") {
      const [base, head] = await Promise.all([
        this.reader.readCommit(repository, target.baseRef),
        this.reader.readCommit(repository, target.headRef),
      ]);
      const baseSha = commitSha(base);
      return {
        baseRef: target.baseRef,
        headRef: target.headRef,
        baseSha,
        headSha: commitSha(head),
        policySha: baseSha,
        pullRequestNumber: null,
      };
    }

    const sha = commitSha(await this.reader.readCommit(repository, target.ref));
    return {
      baseRef: target.ref,
      headRef: target.ref,
      baseSha: sha,
      headSha: sha,
      policySha: sha,
      pullRequestNumber: null,
    };
  }
}

export function parseGateTarget(value: unknown): GateTarget {
  const target = record(value);
  if (target.kind === "pull_request") {
    exactKeys(target, new Set(["kind", "number"]));
    if (!Number.isSafeInteger(target.number) || (target.number as number) <= 0) fail();
    return { kind: "pull_request", number: target.number as number };
  }
  if (target.kind === "compare") {
    exactKeys(target, new Set(["kind", "baseRef", "headRef"]));
    return {
      kind: "compare",
      baseRef: humanRef(target.baseRef),
      headRef: humanRef(target.headRef),
    };
  }
  if (target.kind === "protected_branch") {
    exactKeys(target, new Set(["kind", "ref"]));
    return { kind: "protected_branch", ref: humanRef(target.ref) };
  }
  fail();
}

function commitSha(value: unknown): string {
  return fullSha(record(value).sha);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || [...allowed].some((key) => !(key in value))
  ) fail();
}

function humanRef(value: unknown): string {
  if (typeof value !== "string") fail();
  const ref = value.trim();
  if (
    ref.length === 0
    || ref.length > 255
    || ref.includes("\0")
    || ref.toUpperCase() === "HEAD"
  ) fail();
  return ref;
}

function fullSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) fail();
  return value;
}

function fail(): never {
  throw new GitHubTargetResolutionError("github_target_invalid");
}
