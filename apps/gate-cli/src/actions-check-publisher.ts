import fs from "node:fs";

import { parseGateArtifact } from "@csb/gate-core";
import type { GateArtifactV2 } from "@csb/shared";

export interface ActionsGitHubTransport {
  request(
    method: "GET" | "PATCH" | "POST",
    resourcePath: string,
    body?: unknown,
  ): Promise<unknown>;
}

export interface PublishActionsGateCheckInput {
  artifact: unknown;
  expectedRepository: string;
  detailsUrl: string | null;
}

export interface ActionsCheckEnvironment {
  GITHUB_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_SERVER_URL?: string;
  GITHUB_RUN_ID?: string;
  GITHUB_RUN_ATTEMPT?: string;
}

const CHECK_NAME = "CSB Security Change Gate";
const SAFE_SLUG = /^[A-Za-z0-9_.-]+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export async function publishActionsGateCheck(
  input: PublishActionsGateCheckInput,
  transport: ActionsGitHubTransport,
): Promise<"created" | "updated"> {
  const parsed = parseGateArtifact(input.artifact);
  if (parsed.schemaVersion !== 2) {
    throw new Error("Actions GitHub Check requires GateArtifact v2");
  }
  const artifact = parsed;
  if (
    artifact.source !== "github"
    || artifact.executor !== "github-actions"
    || !artifact.publication.eligible
    || artifact.repository.locator.kind !== "github"
  ) {
    throw new Error("Actions GitHub Check is not eligible");
  }
  const owner = githubSlug(artifact.repository.locator.owner);
  const repository = githubSlug(artifact.repository.locator.name);
  if (`${owner}/${repository}`.toLowerCase() !== input.expectedRepository.toLowerCase()) {
    throw new Error("Actions GitHub Check repository identity mismatch");
  }
  const headSha = fullSha(artifact.resolvedTarget.headSha);
  if (artifact.changeSet.headSha !== headSha) {
    throw new Error("Actions GitHub Check head identity mismatch");
  }

  const listed = checkRuns(await transport.request(
    "GET",
    `/repos/${owner}/${repository}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100`,
  ));
  const matches = listed.filter((check) => check.externalId === artifact.gateId);
  if (matches.length > 1) {
    throw new Error("Actions GitHub Check identity is ambiguous");
  }

  const payload = checkPayload(artifact, validatedDetailsUrl(input.detailsUrl, owner, repository));
  if (matches.length === 1) {
    await transport.request(
      "PATCH",
      `/repos/${owner}/${repository}/check-runs/${matches[0]!.id}`,
      payload,
    );
    return "updated";
  }
  await transport.request("POST", `/repos/${owner}/${repository}/check-runs`, payload);
  return "created";
}

export async function publishActionsCheckFromEnvironment(
  artifactPath: string,
  environment: ActionsCheckEnvironment = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<"created" | "updated"> {
  const token = requiredEnvironment(environment.GITHUB_TOKEN, "GITHUB_TOKEN");
  const repository = requiredEnvironment(environment.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const [owner, name, extra] = repository.split("/");
  if (extra !== undefined || owner === undefined || name === undefined) {
    throw new Error("GITHUB_REPOSITORY is invalid");
  }
  githubSlug(owner);
  githubSlug(name);
  const serverUrl = environment.GITHUB_SERVER_URL ?? "https://github.com";
  if (serverUrl !== "https://github.com") {
    throw new Error("Unsupported GitHub server");
  }
  const runId = requiredDigits(environment.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  const attempt = requiredDigits(environment.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT");
  const artifact = readArtifact(artifactPath);
  const transport = createActionsGitHubTransport(token, fetchImpl);
  return publishActionsGateCheck({
    artifact,
    expectedRepository: repository,
    detailsUrl: `${serverUrl}/${owner}/${name}/actions/runs/${runId}/attempts/${attempt}`,
  }, transport);
}

export function createActionsGitHubTransport(
  token: string,
  fetchImpl: typeof fetch = fetch,
): ActionsGitHubTransport {
  if (token.length < 8 || token.includes("\0")) {
    throw new Error("GITHUB_TOKEN is invalid");
  }
  return {
    request: async (method, resourcePath, body) => {
      if (!resourcePath.startsWith("/repos/") || resourcePath.includes("..")) {
        throw new Error("GitHub Checks API path is invalid");
      }
      let response: Response;
      try {
        response = await fetchImpl(`https://api.github.com${resourcePath}`, {
          method,
          redirect: "error",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new Error("GitHub Checks API is unreachable");
      }
      if (!response.ok) {
        throw new Error(`GitHub Checks API request failed (${response.status})`);
      }
      try {
        return await response.json();
      } catch {
        throw new Error("GitHub Checks API response is invalid");
      }
    },
  };
}

function checkPayload(artifact: GateArtifactV2, detailsUrl: string | null): Record<string, unknown> {
  const summary = artifact.findings
    .slice(0, 20)
    .map((finding) => `- ${finding.severity.toUpperCase()} · ${finding.lifecycle}: ${finding.title}`)
    .join("\n");
  const payload: Record<string, unknown> = {
    name: CHECK_NAME,
    head_sha: artifact.resolvedTarget.headSha,
    external_id: artifact.gateId,
    status: "completed",
    conclusion: artifact.decision.githubConclusion,
    output: {
      title: `Security Change Gate: ${artifact.decision.outcome}`,
      summary: [artifact.decision.summary, summary].filter(Boolean).join("\n\n").slice(0, 65_535),
      text: artifact.findings.length === 0
        ? "No security findings were attached to this gate."
        : summary.slice(0, 65_535),
    },
  };
  if (detailsUrl !== null) payload.details_url = detailsUrl;
  return payload;
}

function checkRuns(value: unknown): Array<{ id: string; externalId: string | null }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub Checks API response is invalid");
  }
  const rows = (value as Record<string, unknown>).check_runs;
  if (!Array.isArray(rows) || rows.length > 100) {
    throw new Error("GitHub Checks API response is invalid");
  }
  return rows.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("GitHub Checks API response is invalid");
    }
    const row = value as Record<string, unknown>;
    const id = String(row.id ?? "");
    if (!/^[1-9][0-9]*$/.test(id)) {
      throw new Error("GitHub Checks API response is invalid");
    }
    const externalId = row.external_id === null || row.external_id === undefined
      ? null
      : String(row.external_id);
    return { id, externalId };
  });
}

function readArtifact(artifactPath: string): unknown {
  const before = fs.lstatSync(artifactPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_ARTIFACT_BYTES) {
    throw new Error("Gate artifact file is invalid");
  }
  const fd = fs.openSync(artifactPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Gate artifact file changed during read");
    }
    const bytes = fs.readFileSync(fd);
    if (bytes.byteLength !== opened.size || bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error("Gate artifact file changed during read");
    }
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Gate artifact JSON is invalid");
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function validatedDetailsUrl(value: string | null, owner: string, repository: string): string | null {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Actions Check details URL is invalid");
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "github.com"
    || !url.pathname.toLowerCase().startsWith(`/${owner}/${repository}/actions/runs/`.toLowerCase())
    || url.username
    || url.password
  ) {
    throw new Error("Actions Check details URL is invalid");
  }
  return url.toString();
}

function githubSlug(value: string): string {
  if (!SAFE_SLUG.test(value)) throw new Error("GitHub owner or repository is invalid");
  return value;
}

function fullSha(value: string): string {
  if (!FULL_SHA.test(value)) throw new Error("GitHub head SHA is invalid");
  return value;
}

function requiredEnvironment(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0 || value.includes("\0")) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredDigits(value: string | undefined, name: string): string {
  const present = requiredEnvironment(value, name);
  if (!/^[1-9][0-9]*$/.test(present)) throw new Error(`${name} is invalid`);
  return present;
}
