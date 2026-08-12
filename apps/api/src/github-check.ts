import path from "node:path";

import type {
  GateArtifact,
  GateArtifactV2,
  GateFindingDelta,
  GateFindingLifecycle,
  Severity,
} from "@csb/shared";
import { parseGateArtifact } from "@csb/gate-core";

import { defaultGhRunner, type GhRunner } from "./github-cli.js";

export interface PublishGateCheckInput {
  artifact: GateArtifact;
  owner: string;
  repository: string;
  detailsUrl: string | null;
}

export interface ManagedGateCheckAuthority {
  connectionId: string;
  installationId: string;
  repositoryId: string;
}

export interface ManagedGitHubCheckClient {
  readAuthorizedRepositoryJson(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    permissions: { checks: "write" },
  ): Promise<unknown>;
  writeAuthorizedRepositoryJson(
    connectionId: string,
    installationId: string,
    repositoryId: string,
    path: string,
    method: "PATCH" | "POST",
    body: unknown,
    permissions: { checks: "write" },
  ): Promise<unknown>;
}

export interface PublishManagedGateCheckInput {
  artifact: GateArtifactV2;
  authority: ManagedGateCheckAuthority;
  detailsUrl: string | null;
}

interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  title: string;
  message: string;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  unknown: 5,
};

const LIFECYCLE_RANK: Record<GateFindingLifecycle, number> = {
  new: 0,
  reopened: 1,
  persistent: 2,
  fixed: 3,
};

const SAFE_SLUG = /^[A-Za-z0-9_.-]+$/;
const LOCAL_PATH = /(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp|var\/folders)\/)[^\s"'`)<>,;]*/g;

export async function publishGateCheck(
  input: PublishGateCheckInput,
  runner: GhRunner = defaultGhRunner,
): Promise<void> {
  if (!SAFE_SLUG.test(input.owner) || !SAFE_SLUG.test(input.repository)) {
    throw new Error("GitHub owner or repository is invalid");
  }

  const payload = checkPayload(input.artifact, input.detailsUrl);

  let result;
  try {
    result = await runner(
      [
        "api",
        "--method",
        "POST",
        `repos/${input.owner}/${input.repository}/check-runs`,
        "--input",
        "-",
      ],
      { cwd: process.cwd(), stdin: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`GitHub Check publication failed: ${errorMessage(error)}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `GitHub Check publication failed: ${redact(result.stderr.trim() || "gh exited with an error")}`,
    );
  }
}

export async function publishManagedGateCheck(
  input: PublishManagedGateCheckInput,
  client: ManagedGitHubCheckClient,
): Promise<"created" | "updated"> {
  const parsed = parseGateArtifact(input.artifact);
  if (parsed.schemaVersion !== 2) throw new Error("Managed GitHub Check requires GateArtifact v2");
  const artifact = parsed;
  if (
    artifact.source !== "github"
    || artifact.executor !== "sentinel-managed"
    || !artifact.publication.eligible
    || artifact.repository.locator.kind !== "github"
    || artifact.repository.locator.repositoryId !== input.authority.repositoryId
  ) {
    throw new Error("Managed GitHub Check is not eligible");
  }
  const owner = githubSlug(artifact.repository.locator.owner);
  const repository = githubSlug(artifact.repository.locator.name);
  const headSha = fullSha(artifact.resolvedTarget.headSha);
  if (artifact.changeSet.headSha !== headSha) {
    throw new Error("Managed GitHub Check head identity mismatch");
  }
  const name = "CSB Security Change Gate";
  const listPath = `/repos/${owner}/${repository}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`;
  const listed = checkRuns(await client.readAuthorizedRepositoryJson(
    input.authority.connectionId,
    input.authority.installationId,
    input.authority.repositoryId,
    listPath,
    { checks: "write" },
  ));
  const matches = listed.filter((check) => check.externalId === artifact.gateId);
  if (matches.length > 1) throw new Error("Managed GitHub Check identity is ambiguous");

  const payload = {
    ...checkPayload(artifact, input.detailsUrl),
    external_id: artifact.gateId,
  };
  if (matches.length === 1) {
    await client.writeAuthorizedRepositoryJson(
      input.authority.connectionId,
      input.authority.installationId,
      input.authority.repositoryId,
      `/repos/${owner}/${repository}/check-runs/${matches[0]!.id}`,
      "PATCH",
      payload,
      { checks: "write" },
    );
    return "updated";
  }
  await client.writeAuthorizedRepositoryJson(
    input.authority.connectionId,
    input.authority.installationId,
    input.authority.repositoryId,
    `/repos/${owner}/${repository}/check-runs`,
    "POST",
    payload,
    { checks: "write" },
  );
  return "created";
}

function checkPayload(artifact: GateArtifact, detailsUrl: string | null): Record<string, unknown> {
  const findings = [...artifact.findings].sort(compareFindings);
  const annotations = findings
    .map(toAnnotation)
    .filter((annotation): annotation is CheckAnnotation => annotation !== null)
    .slice(0, 20);
  const findingSummary = findings
    .slice(0, 20)
    .map((finding) =>
      `- ${finding.severity.toUpperCase()} · ${finding.lifecycle}: ${redact(finding.title)}`)
    .join("\n");
  const output = {
    title: `Security Change Gate: ${artifact.decision.outcome}`,
    summary: [
      redact(artifact.decision.summary),
      findingSummary,
    ].filter(Boolean).join("\n\n"),
    text: findings.length === 0
      ? "No security findings were attached to this gate."
      : findingSummary,
    annotations,
  };
  const payload: Record<string, unknown> = {
    name: "CSB Security Change Gate",
    head_sha: artifact.changeSet.headSha,
    status: "completed",
    conclusion: artifact.decision.githubConclusion,
    output,
  };
  if (detailsUrl !== null) payload.details_url = detailsUrl;
  return payload;
}

function checkRuns(value: unknown): Array<{ id: string; externalId: string | null }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Managed GitHub Check response is invalid");
  }
  const rows = (value as Record<string, unknown>).check_runs;
  if (!Array.isArray(rows) || rows.length > 100) {
    throw new Error("Managed GitHub Check response is invalid");
  }
  return rows.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Managed GitHub Check response is invalid");
    }
    const row = value as Record<string, unknown>;
    const id = String(row.id ?? "");
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error("Managed GitHub Check response is invalid");
    const externalId = row.external_id === null || row.external_id === undefined
      ? null
      : String(row.external_id);
    return { id, externalId };
  });
}

function githubSlug(value: string): string {
  if (!SAFE_SLUG.test(value)) throw new Error("GitHub owner or repository is invalid");
  return value;
}

function fullSha(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("GitHub head SHA is invalid");
  return value;
}

function compareFindings(left: GateFindingDelta, right: GateFindingDelta): number {
  return (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    LIFECYCLE_RANK[left.lifecycle] - LIFECYCLE_RANK[right.lifecycle] ||
    left.identity.localeCompare(right.identity)
  );
}

function toAnnotation(finding: GateFindingDelta): CheckAnnotation | null {
  const location = repositoryLocation(finding.primaryPath);
  if (location === null) return null;
  return {
    path: location.path,
    start_line: location.startLine,
    end_line: location.endLine,
    annotation_level: annotationLevel(finding.severity),
    title: redact(finding.title),
    message: redact(finding.summary ?? finding.title),
  };
}

function repositoryLocation(
  primaryPath: string | null,
): { path: string; startLine: number; endLine: number } | null {
  if (primaryPath === null || path.isAbsolute(primaryPath) || /^[A-Za-z]:[\\/]/.test(primaryPath)) {
    return null;
  }
  const match = /^(.*):(\d+)(?::(\d+))?$/.exec(primaryPath);
  const repositoryPath = (match?.[1] ?? primaryPath).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!repositoryPath || repositoryPath === ".." || repositoryPath.startsWith("../")) {
    return null;
  }
  const startLine = match ? Number(match[2]) : 1;
  const endLine = match?.[3] ? Number(match[3]) : startLine;
  return { path: repositoryPath, startLine, endLine };
}

function annotationLevel(severity: Severity): CheckAnnotation["annotation_level"] {
  if (severity === "critical" || severity === "high") return "failure";
  if (severity === "medium") return "warning";
  return "notice";
}

function redact(value: string): string {
  return value.replace(LOCAL_PATH, "[local path redacted]");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? redact(error.message) : "unknown error";
}
