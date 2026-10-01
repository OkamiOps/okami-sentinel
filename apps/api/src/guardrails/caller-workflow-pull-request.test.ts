import assert from "node:assert/strict";
import test from "node:test";

import type { GuardrailRepository } from "@csb/shared";

import {
  CALLER_WORKFLOW_BRANCH,
  openCallerWorkflowPullRequest,
  type CallerWorkflowPullRequestDependencies,
} from "./caller-workflow-pull-request.js";

const SHA = "a".repeat(40);
const RELEASE = "b".repeat(40);

class ClientError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function repository(overrides: Partial<GuardrailRepository> = {}): GuardrailRepository {
  return {
    repositoryKey: "github:991122",
    source: "github",
    repositoryPath: null,
    displayName: "okami",
    defaultBranch: "main",
    defaultExecutor: "github-actions",
    enabled: true,
    remoteOwner: "OkamiOps",
    remoteName: "okami",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "991122",
    ...overrides,
  } as GuardrailRepository;
}

interface HarnessOptions {
  /** Branch names whose `POST /git/refs` answers 422, as GitHub does when it exists. */
  refConflict?: readonly string[];
  /** Branch names that really exist, mapped to their head SHA. */
  existingBranches?: Record<string, string>;
  /** Files the existing branch carries on top of the default head. */
  compareFiles?: readonly string[];
  fileExists?: boolean;
  pullRequestConflict?: boolean;
  openPullRequests?: unknown;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const conflicts = new Set(options.refConflict ?? []);
  const existing = options.existingBranches ?? {};
  const deps: CallerWorkflowPullRequestDependencies = {
    readJson: async (_authority, resourcePath) => {
      calls.push(`GET ${resourcePath}`);
      const ref = /\/git\/ref\/heads\/(.+)$/.exec(resourcePath);
      if (ref !== null) {
        const branch = ref[1]!;
        if (branch === "main") return { object: { sha: SHA } };
        const head = existing[branch];
        if (head === undefined) throw new ClientError("github_not_found");
        return { object: { sha: head } };
      }
      if (resourcePath.includes("/compare/")) {
        return { files: (options.compareFiles ?? []).map((filename) => ({ filename })) };
      }
      if (resourcePath.includes("/contents/")) {
        if (options.fileExists !== true) throw new ClientError("github_not_found");
        return { sha: "c".repeat(40) };
      }
      if (resourcePath.includes("/pulls?")) {
        return options.openPullRequests
          ?? [{ number: 41, html_url: "https://github.com/OkamiOps/okami/pull/41" }];
      }
      throw new ClientError("github_not_found");
    },
    writeJson: async (_authority, resourcePath, method, body) => {
      calls.push(`${method} ${resourcePath}`);
      bodies.push(body);
      if (resourcePath.endsWith("/git/refs")) {
        const branch = String((body as { ref: string }).ref).replace("refs/heads/", "");
        if (conflicts.has(branch)) throw new ClientError("github_request_rejected");
        return { ref: `refs/heads/${branch}` };
      }
      if (resourcePath.endsWith("/pulls")) {
        if (options.pullRequestConflict === true) throw new ClientError("github_request_rejected");
        return { number: 42, html_url: "https://github.com/OkamiOps/okami/pull/42" };
      }
      return { content: { sha: "d".repeat(40) } };
    },
  };
  return { calls, bodies, deps };
}

const WORKFLOW_PATH = "/repos/OkamiOps/okami/contents/.github/workflows/csb-security-change-gate.yml";

test("creates the branch, the file and the pull request", async () => {
  const h = harness();
  const result = await openCallerWorkflowPullRequest(
    { repository: repository(), workflowSha: RELEASE },
    h.deps,
  );
  assert.deepEqual(result, {
    status: "created",
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/OkamiOps/okami/pull/42",
    branch: "okami-sentinel/caller-workflow",
  });
  assert.deepEqual(h.calls, [
    "GET /repos/OkamiOps/okami/git/ref/heads/main",
    "POST /repos/OkamiOps/okami/git/refs",
    `GET ${WORKFLOW_PATH}?ref=okami-sentinel%2Fcaller-workflow`,
    `PUT ${WORKFLOW_PATH}`,
    "POST /repos/OkamiOps/okami/pulls",
  ]);
  assert.deepEqual(h.bodies[0], {
    ref: "refs/heads/okami-sentinel/caller-workflow",
    sha: SHA,
  });
});

test("reuses an existing branch", async () => {
  const h = harness({ refConflict: [CALLER_WORKFLOW_BRANCH], existingBranches: { [CALLER_WORKFLOW_BRANCH]: SHA } });
  const result = await openCallerWorkflowPullRequest(
    { repository: repository(), workflowSha: RELEASE },
    h.deps,
  );
  assert.equal(result.status, "created");
  // The 422 on the reference is not a failure, and the file is still written.
  assert.ok(h.calls.includes(`PUT ${WORKFLOW_PATH}`));
});

test("reports an existing pull request instead of failing", async () => {
  const h = harness({ pullRequestConflict: true });
  const result = await openCallerWorkflowPullRequest(
    { repository: repository(), workflowSha: RELEASE },
    h.deps,
  );
  assert.deepEqual(result, {
    status: "exists",
    pullRequestNumber: 41,
    pullRequestUrl: "https://github.com/OkamiOps/okami/pull/41",
    branch: "okami-sentinel/caller-workflow",
  });
  assert.ok(h.calls.some((call) => call.startsWith("GET /repos/OkamiOps/okami/pulls?state=open&head=OkamiOps%3Aokami-sentinel%2Fcaller-workflow")));
});

test("a rejected pull request with nothing open is still a refusal", async () => {
  const h = harness({ pullRequestConflict: true, openPullRequests: [] });
  await assert.rejects(
    openCallerWorkflowPullRequest({ repository: repository(), workflowSha: RELEASE }, h.deps),
    /caller_workflow_pull_request_failed/,
  );
});

test("updates the file when it already exists on the branch", async () => {
  const h = harness({ refConflict: [CALLER_WORKFLOW_BRANCH], existingBranches: { [CALLER_WORKFLOW_BRANCH]: SHA }, fileExists: true });
  await openCallerWorkflowPullRequest(
    { repository: repository(), workflowSha: RELEASE },
    h.deps,
  );
  const put = h.bodies[1] as Record<string, unknown>;
  assert.equal(put.sha, "c".repeat(40));
  assert.equal(put.branch, "okami-sentinel/caller-workflow");
});

test("pins the workflow to the configured sha and leaves no automatic trigger", async () => {
  const h = harness();
  await openCallerWorkflowPullRequest(
    { repository: repository(), workflowSha: RELEASE },
    h.deps,
  );
  const put = h.bodies[1] as Record<string, unknown>;
  const content = Buffer.from(String(put.content), "base64").toString("utf8");
  assert.ok(content.includes(`security-change-gate.yml@${RELEASE}`));
  assert.ok(content.includes(`csb_ref: ${RELEASE}`));
  assert.equal(content.includes("@main"), false);
  // No `push:` and no `pull_request:` block: Sentinel dispatches, so a trigger here
  // would scan every change twice and outside every ceiling.
  assert.equal(content.includes("# csb-automation: push=0,pr=0,merge=0"), true);
  assert.equal(/^\s{2}push:/m.test(content), false);
  assert.equal(/^\s{2}pull_request:/m.test(content), false);
  assert.ok(content.includes("  workflow_dispatch:"));
});

test("refuses a release sha that is not immutable", async () => {
  const h = harness();
  await assert.rejects(
    openCallerWorkflowPullRequest({ repository: repository(), workflowSha: "main" }, h.deps),
    /caller_workflow_release_unavailable/,
  );
  assert.deepEqual(h.calls, []);
});

test("refuses a repository with no remote authority", async () => {
  const h = harness();
  await assert.rejects(
    openCallerWorkflowPullRequest(
      { repository: repository({ githubConnectionId: null }), workflowSha: RELEASE },
      h.deps,
    ),
    /caller_workflow_authority_invalid/,
  );
  await assert.rejects(
    openCallerWorkflowPullRequest(
      { repository: repository({ source: "local", repositoryPath: "/tmp/x" }), workflowSha: RELEASE },
      h.deps,
    ),
    /caller_workflow_authority_invalid/,
  );
  await assert.rejects(
    openCallerWorkflowPullRequest(
      { repository: repository({ remoteName: "../escape" }), workflowSha: RELEASE },
      h.deps,
    ),
    /caller_workflow_authority_invalid/,
  );
  assert.deepEqual(h.calls, []);
});

test("a default branch with a slash is encoded one segment at a time", async () => {
  const h = harness();
  const reads: string[] = [];
  await openCallerWorkflowPullRequest(
    { repository: repository({ defaultBranch: "release/main" }), workflowSha: RELEASE },
    {
      ...h.deps,
      readJson: async (authority, resourcePath, permissions) => {
        reads.push(resourcePath);
        if (resourcePath.endsWith("/git/ref/heads/release/main")) return { object: { sha: SHA } };
        return h.deps.readJson(authority, resourcePath, permissions);
      },
    },
  );
  // `encodeURIComponent` on the whole name would ask for `heads/release%2Fmain`,
  // which resolves to nothing.
  assert.ok(reads.includes("/repos/OkamiOps/okami/git/ref/heads/release/main"));
  assert.equal(reads.some((call) => call.includes("%2Fmain")), false);
});

test("a 422 that is not an existing branch is refused, never read as already done", async () => {
  // GitHub answers 422 both for "the reference exists" and for a token request the
  // installation has not granted. Only the first leaves a branch behind.
  const h = harness({ refConflict: [CALLER_WORKFLOW_BRANCH] });
  await assert.rejects(
    openCallerWorkflowPullRequest({ repository: repository(), workflowSha: RELEASE }, h.deps),
    /caller_workflow_branch_unavailable/,
  );
  assert.equal(h.calls.some((call) => call.startsWith("PUT ")), false);
});

test("refuses to reuse a branch carrying commits that are not ours", async () => {
  const h = harness({
    refConflict: [CALLER_WORKFLOW_BRANCH],
    existingBranches: { [CALLER_WORKFLOW_BRANCH]: "e".repeat(40) },
    compareFiles: ["src/payroll.ts"],
  });
  const result = await openCallerWorkflowPullRequest(
    { repository: repository(), workflowSha: RELEASE },
    h.deps,
  );
  // Anyone with push access could have pre-created that branch. The button must not
  // open a pull request titled "install the guardrail caller" that carries their work.
  assert.equal(result.branch, `okami-sentinel/caller-workflow-${SHA.slice(0, 7)}`);
  assert.ok(h.bodies.some((body) =>
    (body as { ref?: string }).ref === `refs/heads/okami-sentinel/caller-workflow-${SHA.slice(0, 7)}`));
  const put = h.bodies.find((body) => (body as { content?: unknown }).content !== undefined) as Record<string, unknown>;
  assert.equal(put.branch, `okami-sentinel/caller-workflow-${SHA.slice(0, 7)}`);
});

test("reuses a branch that carries only our own workflow file", async () => {
  const h = harness({
    refConflict: [CALLER_WORKFLOW_BRANCH],
    existingBranches: { [CALLER_WORKFLOW_BRANCH]: "e".repeat(40) },
    compareFiles: [".github/workflows/csb-security-change-gate.yml"],
  });
  const result = await openCallerWorkflowPullRequest(
    { repository: repository(), workflowSha: RELEASE },
    h.deps,
  );
  assert.equal(result.branch, CALLER_WORKFLOW_BRANCH);
});
