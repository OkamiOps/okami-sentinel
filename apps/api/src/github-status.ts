import fs from "node:fs";
import path from "node:path";

import type {
  GitHubCapabilityStatus,
  GuardrailGitHubStatus,
} from "@csb/shared";

import {
  defaultGhRunner,
  type GhResult,
  type GhRunner,
} from "./github-cli.js";

const SECRET_NAME = "OPENAI_API_KEY";
const WORKFLOW_PATH = path.join(
  ".github",
  "workflows",
  "csb-security-change-gate.yml",
);

interface RepositoryView {
  nameWithOwner?: unknown;
  defaultBranchRef?: { name?: unknown } | null;
}

interface RepositoryPermissions {
  admin?: unknown;
  push?: unknown;
}

function capability(
  ready: boolean,
  message: string,
  action: string | null,
): GitHubCapabilityStatus {
  return { ready, message, action };
}

async function run(
  runner: GhRunner,
  args: string[],
  cwd: string,
): Promise<GhResult> {
  try {
    return await runner(args, { cwd });
  } catch {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function getGitHubStatus(
  repositoryPath: string,
  runner: GhRunner = defaultGhRunner,
): Promise<GuardrailGitHubStatus> {
  const cwd = path.resolve(repositoryPath);
  const workflowInstalled = fs.existsSync(path.join(cwd, WORKFLOW_PATH));
  const cliResult = await run(runner, ["--version"], cwd);
  const cliReady = cliResult.exitCode === 0;
  const cli = {
    ...capability(
      cliReady,
      cliReady ? "GitHub CLI is available." : "GitHub CLI is not available.",
      cliReady ? null : "Install GitHub CLI (gh).",
    ),
    available: cliReady,
  };

  if (!cliReady) {
    const unavailable = capability(
      false,
      "GitHub CLI is required for this diagnostic.",
      "Install GitHub CLI (gh).",
    );
    return {
      cli,
      remote: unavailable,
      auth: unavailable,
      permissions: unavailable,
      secret: unavailable,
      workflow: workflowCapability(workflowInstalled),
      baseline: unavailable,
      ready: false,
    };
  }

  const authResult = await run(runner, ["auth", "status"], cwd);
  const auth = capability(
    authResult.exitCode === 0,
    authResult.exitCode === 0
      ? "GitHub CLI authentication is ready."
      : "GitHub CLI is not authenticated.",
    authResult.exitCode === 0 ? null : "Run gh auth login.",
  );

  const remoteResult = await run(
    runner,
    ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
    cwd,
  );
  const repositoryView = parseJson(remoteResult.stdout) as RepositoryView | null;
  const repositorySlug =
    remoteResult.exitCode === 0 &&
    repositoryView &&
    typeof repositoryView.nameWithOwner === "string"
      ? repositoryView.nameWithOwner
      : null;
  const remote = capability(
    repositorySlug !== null,
    repositorySlug
      ? `GitHub remote ${repositorySlug} is available.`
      : "No GitHub repository remote could be resolved.",
    repositorySlug ? null : "Configure a GitHub remote for this repository.",
  );

  const permissions = repositorySlug
    ? await permissionsCapability(runner, cwd, repositorySlug)
    : capability(
        false,
        "Repository permissions cannot be checked without a GitHub remote.",
        "Configure a GitHub remote for this repository.",
      );

  const secretResult = await run(
    runner,
    ["secret", "list", "--json", "name"],
    cwd,
  );
  const secretNames = parseJson(secretResult.stdout);
  const secretReady =
    secretResult.exitCode === 0 &&
    Array.isArray(secretNames) &&
    secretNames.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        "name" in entry &&
        entry.name === SECRET_NAME,
    );
  const secret = capability(
    secretReady,
    secretReady
      ? `${SECRET_NAME} is configured.`
      : `${SECRET_NAME} is not configured.`,
    secretReady ? null : `Create the repository secret ${SECRET_NAME}.`,
  );

  const workflow = workflowCapability(workflowInstalled);
  const baselineReady = repositorySlug !== null && permissions.ready;
  const baseline = capability(
    baselineReady,
    baselineReady
      ? "Default-branch baselines can be resolved by the gate."
      : "Baseline resolution requires a readable GitHub Actions repository.",
    baselineReady ? null : "Resolve the GitHub remote and Actions permissions.",
  );
  const ready = [
    cli,
    remote,
    auth,
    permissions,
    secret,
    workflow,
    baseline,
  ].every((item) => item.ready);

  return {
    cli,
    remote,
    auth,
    permissions,
    secret,
    workflow,
    baseline,
    ready,
  };
}

async function permissionsCapability(
  runner: GhRunner,
  cwd: string,
  repositorySlug: string,
): Promise<GitHubCapabilityStatus> {
  const repositoryResult = await run(
    runner,
    ["api", `repos/${repositorySlug}`, "--jq", ".permissions"],
    cwd,
  );
  const actionsResult = await run(
    runner,
    ["api", `repos/${repositorySlug}/actions/permissions/workflow`],
    cwd,
  );
  const value = parseJson(repositoryResult.stdout) as RepositoryPermissions | null;
  const canPublish = value?.admin === true || value?.push === true;
  const actionsReadable = actionsResult.exitCode === 0;

  if (repositoryResult.exitCode !== 0 || !actionsReadable) {
    return capability(
      false,
      "Repository or Actions permissions could not be verified.",
      "Grant repository and Actions access to the authenticated GitHub account.",
    );
  }
  if (!canPublish) {
    return capability(
      false,
      "Repository access is read-only; local Check publication needs write or admin access.",
      "Grant write or admin access for local Check publication.",
    );
  }
  return capability(
    true,
    "Repository and GitHub Actions permissions are ready.",
    null,
  );
}

function workflowCapability(installed: boolean): GitHubCapabilityStatus {
  return capability(
    installed,
    installed
      ? "CSB caller workflow is installed."
      : "CSB caller workflow is not installed.",
    installed ? null : "Install the CSB caller workflow.",
  );
}
