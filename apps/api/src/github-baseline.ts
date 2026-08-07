import fs from "node:fs";
import path from "node:path";

import { parseGateArtifact } from "@csb/gate-core";
import type { GateArtifact } from "@csb/shared";
import type Database from "better-sqlite3";

import { DATA_DIR } from "./config.js";
import { defaultGhRunner, type GhRunner } from "./github-cli.js";
import {
  getCachedGitHubBaseline,
  upsertCachedGitHubBaseline,
} from "./gate-store.js";

const WORKFLOW_NAME = "csb-security-change-gate.yml";
const ARTIFACT_NAME = "csb-gate-artifact";

export interface BaselineContext {
  repositoryKey: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface BaselineProvider {
  getBaseline(context: BaselineContext): Promise<GateArtifact | null>;
}

interface GitHubWorkflowRun {
  workflowRunId: string;
  headSha: string;
  createdAt: string;
  conclusion: string | null;
}

export class BaselineUnavailableError extends Error {
  constructor(detail: string | null = null) {
    super(
      detail === null
        ? "histórico encontrado, mas o artifact de baseline não está disponível"
        : `histórico encontrado, mas o artifact de baseline não está disponível: ${detail}`,
    );
    this.name = "BaselineUnavailableError";
  }
}

export class GitHubBaselineProvider implements BaselineProvider {
  constructor(
    private readonly runner: GhRunner = defaultGhRunner,
    private readonly cacheRoot: string = path.join(DATA_DIR, "github-cache"),
    private readonly database?: Database.Database,
  ) {}

  async getBaseline(context: BaselineContext): Promise<GateArtifact | null> {
    const repository = `${context.owner}/${context.name}`;
    const listResult = await this.runner(
      [
        "run",
        "list",
        "--repo",
        repository,
        "--branch",
        context.defaultBranch,
        "--workflow",
        WORKFLOW_NAME,
        "--limit",
        "20",
        "--json",
        "databaseId,headSha,createdAt,conclusion",
      ],
      { cwd: process.cwd() },
    );
    if (listResult.exitCode !== 0) {
      throw new BaselineUnavailableError("não foi possível consultar o histórico remoto");
    }

    const runs = parseWorkflowRuns(listResult.stdout);
    if (runs.length === 0) return null;

    let lastError: Error | null = null;
    for (const run of runs) {
      if (run.conclusion === "cancelled") continue;
      try {
        const cached = this.readCachedArtifact(context, run);
        if (cached !== null && eligibleArtifact(cached, context, run)) {
          return cached;
        }

        const downloaded = await this.downloadArtifacts(context, run);
        for (const candidate of downloaded) {
          if (!eligibleArtifact(candidate.artifact, context, run)) continue;
          upsertCachedGitHubBaseline(
            {
              repositoryKey: context.repositoryKey,
              workflowRunId: run.workflowRunId,
              headSha: run.headSha,
              artifactPath: candidate.artifactPath,
              fetchedAt: new Date().toISOString(),
            },
            this.database,
          );
          return candidate.artifact;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("artifact remoto inválido");
      }
    }

    throw new BaselineUnavailableError(lastError?.message ?? null);
  }

  private readCachedArtifact(
    context: BaselineContext,
    run: GitHubWorkflowRun,
  ): GateArtifact | null {
    const cached = getCachedGitHubBaseline(context.repositoryKey, this.database);
    if (
      cached === null ||
      cached.workflowRunId !== run.workflowRunId ||
      cached.headSha !== run.headSha ||
      !fs.existsSync(cached.artifactPath)
    ) {
      return null;
    }
    return parseArtifactFile(cached.artifactPath);
  }

  private async downloadArtifacts(
    context: BaselineContext,
    run: GitHubWorkflowRun,
  ): Promise<Array<{ artifact: GateArtifact; artifactPath: string }>> {
    const repository = `${context.owner}/${context.name}`;
    const runDirectory = path.join(
      this.cacheRoot,
      safeRepositoryKey(context.repositoryKey),
      run.workflowRunId,
    );
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const result = await this.runner(
      [
        "run",
        "download",
        run.workflowRunId,
        "--repo",
        repository,
        "--name",
        ARTIFACT_NAME,
        "--dir",
        runDirectory,
      ],
      { cwd: process.cwd() },
    );
    if (result.exitCode !== 0) {
      throw new Error("download do artifact remoto falhou ou expirou");
    }

    const artifactPaths = listJsonFiles(runDirectory);
    if (artifactPaths.length === 0) {
      throw new Error("artifact remoto não contém JSON");
    }
    return artifactPaths.map((artifactPath) => ({
      artifact: parseArtifactFile(artifactPath),
      artifactPath,
    }));
  }
}

function parseWorkflowRuns(stdout: string): GitHubWorkflowRun[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new BaselineUnavailableError("histórico remoto retornou JSON inválido");
  }
  if (!Array.isArray(value)) {
    throw new BaselineUnavailableError("histórico remoto retornou formato inválido");
  }

  const runs = value
    .flatMap((candidate): GitHubWorkflowRun[] => {
      if (candidate === null || typeof candidate !== "object") return [];
      const row = candidate as Record<string, unknown>;
      const workflowRunId =
        typeof row.databaseId === "number" && Number.isSafeInteger(row.databaseId)
          ? String(row.databaseId)
          : typeof row.databaseId === "string" && row.databaseId.length > 0
            ? row.databaseId
            : null;
      if (
        workflowRunId === null ||
        typeof row.headSha !== "string" ||
        row.headSha.length === 0 ||
        typeof row.createdAt !== "string" ||
        !Number.isFinite(Date.parse(row.createdAt))
      ) {
        return [];
      }
      return [
        {
          workflowRunId,
          headSha: row.headSha,
          createdAt: row.createdAt,
          conclusion: typeof row.conclusion === "string" ? row.conclusion : null,
        },
      ];
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  if (value.length > 0 && runs.length === 0) {
    throw new BaselineUnavailableError("histórico remoto não contém runs válidos");
  }
  return runs;
}

function parseArtifactFile(artifactPath: string): GateArtifact {
  return parseGateArtifact(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
}

function eligibleArtifact(
  artifact: GateArtifact,
  context: BaselineContext,
  run: GitHubWorkflowRun,
): boolean {
  if (artifact.decision.outcome === "error") return false;
  if (artifact.changeSet.headSha !== run.headSha) return false;
  if (artifact.repository.owner?.toLowerCase() !== context.owner.toLowerCase()) {
    return false;
  }
  if (artifact.repository.name.toLowerCase() !== context.name.toLowerCase()) {
    return false;
  }
  if (artifact.repository.defaultBranch !== context.defaultBranch) return false;
  return artifact.decision.outcome !== "bootstrap" || artifact.scan.status === "completed";
}

function safeRepositoryKey(repositoryKey: string): string {
  const safe = repositoryKey.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe === "." || safe === ".." || safe.length === 0 ? "repository" : safe;
}

function listJsonFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry): string[] => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listJsonFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".json") ? [entryPath] : [];
    })
    .sort();
}
