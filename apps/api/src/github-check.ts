import path from "node:path";

import type {
  GateArtifact,
  GateFindingDelta,
  GateFindingLifecycle,
  Severity,
} from "@csb/shared";

import { defaultGhRunner, type GhRunner } from "./github-cli.js";

export interface PublishGateCheckInput {
  artifact: GateArtifact;
  owner: string;
  repository: string;
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

  const findings = [...input.artifact.findings].sort(compareFindings);
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
    title: `Security Change Gate: ${input.artifact.decision.outcome}`,
    summary: [
      redact(input.artifact.decision.summary),
      findingSummary,
    ].filter(Boolean).join("\n\n"),
    text: findings.length === 0
      ? "No security findings were attached to this gate."
      : findingSummary,
    annotations,
  };
  const payload: Record<string, unknown> = {
    name: "CSB Security Change Gate",
    head_sha: input.artifact.changeSet.headSha,
    status: "completed",
    conclusion: input.artifact.decision.githubConclusion,
    output,
  };
  if (input.detailsUrl !== null) payload.details_url = input.detailsUrl;

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
