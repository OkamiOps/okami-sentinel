import { selectGateBaseline } from "@csb/gate-core";
import type { GateArtifact, GateArtifactV2 } from "@csb/shared";

import { parseActionsArtifactArchive } from "./guardrails/actions-artifact-importer.js";
import {
  ACTIONS_ARTIFACT_NAME,
  ACTIONS_CALLER_WORKFLOW_PATH,
} from "./guardrails/github-actions-executor.js";

const RUN_LIMIT = 20;

export interface BaselineContext {
  repositoryKey: string;
  owner: string;
  name: string;
  defaultBranch: string;
  connectionId: string;
  installationId: string;
  repositoryId: string;
}

export interface BaselineProvider {
  getBaseline(context: BaselineContext): Promise<GateArtifact | null>;
}

export interface GitHubBaselineAuthority {
  readAuthorizedRepositoryJson(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    permissions: { actions: "read" },
  ): Promise<unknown>;
  downloadAuthorizedRepositoryBytes(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    permissions: { actions: "read" },
  ): Promise<Uint8Array>;
}

interface GitHubBaselineRun {
  id: string;
  attempt: number;
  headSha: string;
  createdAt: string;
}

interface GitHubBaselineArtifact {
  id: string;
  digest: string;
}

export class BaselineUnavailableError extends Error {
  constructor(detail: string | null = null) {
    super(detail === null
      ? "histórico encontrado, mas o artifact de baseline não está disponível"
      : `histórico encontrado, mas o artifact de baseline não está disponível: ${detail}`);
    this.name = "BaselineUnavailableError";
  }
}

export class GitHubBaselineProvider implements BaselineProvider {
  constructor(private readonly authority: GitHubBaselineAuthority) {}

  async getBaseline(context: BaselineContext): Promise<GateArtifactV2 | null> {
    const identity = baselineIdentity(context);
    let runs: GitHubBaselineRun[];
    try {
      runs = parseRuns(await this.authority.readAuthorizedRepositoryJson(
        context.connectionId,
        context.installationId,
        context.repositoryId,
        `/repos/${identity.owner}/${identity.name}/actions/workflows/${encodeURIComponent(ACTIONS_CALLER_WORKFLOW_PATH)}/runs?branch=${encodeURIComponent(context.defaultBranch)}&event=push&status=completed&per_page=${RUN_LIMIT}`,
        { actions: "read" },
      ), context.defaultBranch);
    } catch (error) {
      if (error instanceof BaselineUnavailableError) throw error;
      throw new BaselineUnavailableError("não foi possível consultar o histórico remoto");
    }
    if (runs.length === 0) return null;

    let lastReason = "artifact_v2_ausente";
    for (const run of runs) {
      try {
        const candidates = parseArtifacts(await this.authority.readAuthorizedRepositoryJson(
          context.connectionId,
          context.installationId,
          context.repositoryId,
          `/repos/${identity.owner}/${identity.name}/actions/runs/${run.id}/artifacts?per_page=100`,
          { actions: "read" },
        ));
        if (candidates.length > 1) {
          throw new BaselineUnavailableError("artifact v2 ambíguo");
        }
        const candidate = candidates[0];
        if (candidate === undefined) continue;
        const archive = await this.authority.downloadAuthorizedRepositoryBytes(
          context.connectionId,
          context.installationId,
          context.repositoryId,
          `/repos/${identity.owner}/${identity.name}/actions/artifacts/${candidate.id}/zip`,
          { actions: "read" },
        );
        const bundle = parseActionsArtifactArchive(archive, candidate.digest);
        const artifact = bundle.artifact;
        assertBaselineIdentity(artifact, context, run);
        const selection = selectGateBaseline({
          repositoryId: `github:${context.repositoryId}`,
          protectedBranch: context.defaultBranch,
          lineage: artifact.lineage,
          policySchemaVersion: artifact.policy.schemaVersion,
          coverage: artifact.coverage,
        }, { kind: "artifact", artifact });
        if (selection.kind === "comparable") return selection.artifact;
        lastReason = selection.kind === "unavailable"
          ? selection.reason
          : selection.kind === "incompatible" ? selection.reason : "artifact_v2_ausente";
      } catch (error) {
        if (error instanceof BaselineUnavailableError && /ambíguo/.test(error.message)) throw error;
        lastReason = safeBaselineReason(error);
      }
    }
    throw new BaselineUnavailableError(lastReason);
  }
}

function parseRuns(value: unknown, defaultBranch: string): GitHubBaselineRun[] {
  const root = record(value, "histórico remoto retornou formato inválido");
  if (!Array.isArray(root.workflow_runs)) {
    throw new BaselineUnavailableError("histórico remoto retornou formato inválido");
  }
  const valid = root.workflow_runs.flatMap((candidate): GitHubBaselineRun[] => {
    if (!isRecord(candidate)) return [];
    const id = integerId(candidate.id);
    const attempt = positiveInteger(candidate.run_attempt);
    if (
      id === null
      || attempt === null
      || candidate.event !== "push"
      || candidate.status !== "completed"
      || candidate.head_branch !== defaultBranch
      || candidate.path !== ACTIONS_CALLER_WORKFLOW_PATH
      || typeof candidate.head_sha !== "string"
      || !/^[0-9a-f]{40}$/.test(candidate.head_sha)
      || typeof candidate.created_at !== "string"
      || !Number.isFinite(Date.parse(candidate.created_at))
    ) return [];
    return [{ id, attempt, headSha: candidate.head_sha, createdAt: candidate.created_at }];
  }).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  if (root.workflow_runs.length > 0 && valid.length === 0) {
    throw new BaselineUnavailableError("histórico remoto não contém runs v2 válidos");
  }
  return valid;
}

function parseArtifacts(value: unknown): GitHubBaselineArtifact[] {
  const root = record(value, "lista de artifacts inválida");
  if (!Array.isArray(root.artifacts)) throw new BaselineUnavailableError("lista de artifacts inválida");
  return root.artifacts.flatMap((candidate): GitHubBaselineArtifact[] => {
    if (
      !isRecord(candidate)
      || candidate.name !== ACTIONS_ARTIFACT_NAME
      || candidate.expired !== false
      || typeof candidate.digest !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(candidate.digest)
    ) return [];
    const id = integerId(candidate.id);
    return id === null ? [] : [{ id, digest: candidate.digest }];
  });
}

function assertBaselineIdentity(
  artifact: GateArtifactV2,
  context: BaselineContext,
  run: GitHubBaselineRun,
): void {
  if (
    artifact.source !== "github"
    || artifact.executor !== "github-actions"
    || artifact.repository.id !== `github:${context.repositoryId}`
    || artifact.repository.key !== context.repositoryKey
    || artifact.repository.defaultBranch !== context.defaultBranch
    || artifact.repository.locator.kind !== "github"
    || artifact.repository.locator.repositoryId !== context.repositoryId
    || artifact.repository.locator.owner.toLowerCase() !== context.owner.toLowerCase()
    || artifact.repository.locator.name.toLowerCase() !== context.name.toLowerCase()
    || artifact.target.kind !== "protected_branch"
    || artifact.target.ref !== context.defaultBranch
    || artifact.resolvedTarget.baseRef !== context.defaultBranch
    || artifact.resolvedTarget.headRef !== context.defaultBranch
    || artifact.resolvedTarget.baseSha !== run.headSha
    || artifact.resolvedTarget.headSha !== run.headSha
    || artifact.resolvedTarget.policySha !== run.headSha
    || artifact.changeSet.headSha !== run.headSha
    || artifact.workflowRun?.id !== run.id
    || artifact.workflowRun.attempt !== run.attempt
  ) throw new BaselineUnavailableError("identidade v2 incompatível");
}

function baselineIdentity(context: BaselineContext): { owner: string; name: string } {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(context.owner)
    || !/^[A-Za-z0-9_.-]+$/.test(context.name)
    || !/^[A-Za-z0-9._/-]+$/.test(context.defaultBranch)
    || !/^[A-Za-z0-9_.:-]+$/.test(context.connectionId)
    || !/^[A-Za-z0-9_.:-]+$/.test(context.installationId)
    || !/^[A-Za-z0-9_.:-]+$/.test(context.repositoryId)
  ) throw new BaselineUnavailableError("autoridade do repositório inválida");
  return { owner: context.owner, name: context.name };
}

function safeBaselineReason(error: unknown): string {
  if (error instanceof BaselineUnavailableError) {
    const detail = error.message.split(": ").slice(1).join(": ");
    return detail || "artifact_indisponível";
  }
  if (error instanceof Error && /^[a-z0-9_-]{1,80}$/i.test(error.message)) return error.message;
  return "artifact_v2_inválido";
}

function record(value: unknown, detail: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BaselineUnavailableError(detail);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function integerId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) ? value : null;
}
