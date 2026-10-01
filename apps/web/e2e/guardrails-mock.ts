import type { Page } from "@playwright/test";
import type {
  GateRun,
  GuardrailBaseline,
  GuardrailEnrollmentSkip,
  GuardrailPolicy,
  GuardrailPrCommentState,
  GuardrailRepositoryListRow,
} from "@csb/shared";
import { guardrailPolicyPresetRules } from "@csb/shared";

import { githubRepository, githubSecondRepository, mockApi } from "./fixtures";

/**
 * Every `/guardrails/*` route the tab reads, in one place. An unmocked one throws, so
 * a call to a route that was removed shows up as a failure rather than a blank panel.
 */
export const SHA = "a".repeat(40);

export function policyOf(preset: "block-critical-high" | "block-critical" | "warn-only"): GuardrailPolicy {
  return {
    schemaVersion: 1,
    protectedBranches: ["main"],
    scope: { mode: "changed", maxChangedPaths: 50, fallback: "repository" },
    scan: { model: "gpt-5.6-sol", effort: "low", mode: "standard", maxCostUsd: 18 },
    rules: guardrailPolicyPresetRules(preset),
  };
}

export function baselineOf(overrides: Partial<GuardrailBaseline> = {}): GuardrailBaseline {
  return {
    repositoryKey: "github:1",
    state: "absent",
    gateId: null,
    commitSha: null,
    protectedBranch: null,
    scanLineageHash: null,
    builtAt: null,
    staleReason: null,
    requestedAt: null,
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

export function gateOf(overrides: Partial<GateRun> = {}): GateRun {
  return {
    id: "gate-1",
    repositoryKey: "github:1",
    repositoryPath: null,
    source: "github",
    executor: "sentinel-managed",
    baseRef: "main",
    headRef: "feature/login",
    resolvedBaseSha: SHA,
    resolvedHeadSha: "b".repeat(40),
    policySha: SHA,
    policySource: "sentinel",
    pullRequestNumber: 7,
    workflowRunId: null,
    materializationState: "released",
    scanLineageHash: "sha256:1",
    artifactSchemaVersion: 2,
    scanId: null,
    status: "completed",
    outcome: "bootstrap",
    policyVersion: 1,
    baselineCommit: null,
    artifactPath: "gate-1/csb-gate-result.json",
    publishStatus: "not_configured",
    publishError: null,
    publishedAt: null,
    error: null,
    startedAt: "2026-10-01T09:00:00.000Z",
    completedAt: "2026-10-01T09:05:00.000Z",
    costCeilingUsd: 2,
    estimatedUsd: 0.42,
    ...overrides,
  };
}

interface GuardrailsScenario {
  locale?: string;
  session?: { isAdmin: boolean; grants: Array<{ repositoryKey: string; role: "viewer" | "analyst" | "operator" | "maintainer" }> };
  repositories?: GuardrailRepositoryListRow[];
  gates?: GateRun[];
  /** What `GET .../policy` answers: the level in force and whether the file is broken. */
  policyResponse?: {
    policy: GuardrailPolicy;
    policySource: "repository_file" | "sentinel" | "default";
    policySha: string | null;
    readOnly: boolean;
    preset: "block-critical-high" | "block-critical" | "warn-only" | "custom";
    fileInvalidReason: string | null;
    sentinel: { preset: "block-critical-high" | "block-critical" | "warn-only" | "custom"; updatedAt: string; updatedBy: string | null } | null;
  };
  baseline?: GuardrailBaseline;
  hasProtectedBranchAction?: boolean;
  /** Candidates the App installation offers the multi-select. */
  candidates?: Array<{ repositoryId: string; owner: string; name: string; defaultBranch: string; private: boolean; archived: boolean; updatedAt: string }>;
  enrollResponse?: { enrolled: GuardrailRepositoryListRow[]; skipped: GuardrailEnrollmentSkip[] };
  /** `DELETE` refuses because a gate is still running. */
  deleteConflict?: boolean;
  /** `GET .../policy` fails the way a GitHub outage makes it fail. */
  policyOutage?: boolean;
  artifact?: unknown;
  /** The sticky comments Sentinel already owns in this repository. */
  prComments?: GuardrailPrCommentState[];
  /** `POST .../comment` answers the way a revoked permission makes it answer. */
  commentRepublishFails?: boolean;
}

/** Every `/guardrails/*` route the tab reads, so an unmocked one fails loudly. */
export async function mockGuardrails(page: Page, scenario: GuardrailsScenario = {}) {
  const state = {
    requests: [] as string[],
    repositories: structuredClone(scenario.repositories ?? [githubRepository, githubSecondRepository]),
    gates: structuredClone(scenario.gates ?? []),
    baseline: structuredClone(scenario.baseline ?? baselineOf()),
    policy: structuredClone(scenario.policyResponse ?? {
      policy: policyOf("block-critical-high"),
      policySource: "sentinel" as const,
      policySha: SHA,
      readOnly: false,
      preset: "block-critical-high" as const,
      fileInvalidReason: null,
      sentinel: { preset: "block-critical-high" as const, updatedAt: "2026-10-01T08:00:00.000Z", updatedBy: "marcos" },
    }),
    policyWrites: [] as unknown[],
    patches: [] as Array<{ repositoryKey: string; body: unknown }>,
    deletes: [] as string[],
    enrolments: [] as unknown[],
    baselineBuilds: 0,
    prComments: structuredClone(scenario.prComments ?? []),
    commentRepublishes: 0,
  };

  const base = await mockApi(page, scenario.locale ?? "pt-BR", { session: scenario.session });

  await page.route("**/api/guardrails/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    state.requests.push(`${request.method()} ${path}`);
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/guardrails/repositories" && request.method() === "GET") {
      return json({ repositories: state.repositories });
    }
    if (path === "/guardrails/repositories" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.enrolments.push(body);
      const answer = scenario.enrollResponse ?? { enrolled: [], skipped: [] };
      state.repositories = [...state.repositories, ...answer.enrolled];
      return json(answer);
    }
    const repositoryMatch = path.match(/^\/guardrails\/repositories\/([^/]+)(?:\/(policy|policy\/simulate|baseline|pr-comments))?$/);
    if (repositoryMatch) {
      const repositoryKey = decodeURIComponent(repositoryMatch[1]!);
      const sub = repositoryMatch[2];
      if (sub === undefined && request.method() === "PATCH") {
        const body = request.postDataJSON() as Record<string, unknown>;
        state.patches.push({ repositoryKey, body });
        const index = state.repositories.findIndex((row) => row.repositoryKey === repositoryKey);
        if (index === -1) return json({ error: "not_found" }, 404);
        const next = { ...state.repositories[index]!, ...(body as Partial<GuardrailRepositoryListRow>) };
        state.repositories[index] = next;
        return json({ repository: next });
      }
      if (sub === undefined && request.method() === "DELETE") {
        if (scenario.deleteConflict) return json({ error: "repository_has_active_gate" }, 409);
        state.deletes.push(repositoryKey);
        state.repositories = state.repositories.filter((row) => row.repositoryKey !== repositoryKey);
        return route.fulfill({ status: 204 });
      }
      if (sub === "policy" && request.method() === "GET") {
        if (scenario.policyOutage) return json({ error: "github_unavailable" }, 502);
        return json(state.policy);
      }
      if (sub === "policy" && request.method() === "PUT") {
        const body = request.postDataJSON() as { policy: GuardrailPolicy };
        state.policyWrites.push(body);
        if (state.policy.readOnly) {
          return json({ error: "policy_controlled_by_repository" }, 409);
        }
        state.policy = { ...state.policy, policy: body.policy, policySource: "sentinel", readOnly: false };
        return json(state.policy);
      }
      if (sub === "policy/simulate" && request.method() === "POST") {
        return json({
          gateId: state.gates[0]?.id ?? "gate-1",
          decision: {
            outcome: "warning",
            summary: "1 finding would ask for review.",
            violations: [],
            warnings: [],
            exceptionsApplied: [],
            githubConclusion: "neutral",
            decisionGraph: { nodes: [], selection: [] },
          },
          configurationErrors: [],
        });
      }
      if (sub === "pr-comments" && request.method() === "GET") {
        return json({ comments: state.prComments.filter((row) => row.repositoryKey === repositoryKey) });
      }
      if (sub === "baseline" && request.method() === "GET") {
        return json({
          baseline: state.baseline,
          hasProtectedBranchAction: scenario.hasProtectedBranchAction ?? true,
        });
      }
      if (sub === "baseline" && request.method() === "POST") {
        state.baselineBuilds += 1;
        state.baseline = { ...state.baseline, state: "building", requestedAt: "2026-10-01T12:30:00.000Z" };
        return json({ gateId: "baseline-gate-1", baseline: state.baseline }, 202);
      }
    }
    if (path === "/guardrails/github-app/connections" && request.method() === "GET") {
      return json({
        connections: [{
          id: "github-connection", appId: "4242", appSlug: "okami-sentinel", clientId: "Iv1.abc",
          status: "ready", installationUrl: "https://github.com/apps/okami-sentinel/installations/new",
          createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
        }],
      });
    }
    const installationsMatch = path.match(/^\/guardrails\/github-app\/connections\/([^/]+)\/installations$/);
    if (installationsMatch && request.method() === "GET") {
      return json({
        installations: [{
          id: "77", connectionId: "github-connection", accountLogin: "okamiops",
          accountType: "Organization", status: "ready",
          createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
        }],
      });
    }
    const candidatesMatch = path.match(/^\/guardrails\/github-app\/installations\/([^/]+)\/repositories$/);
    if (candidatesMatch && request.method() === "GET") {
      return json({
        repositories: scenario.candidates ?? [
          { repositoryId: "9001", owner: "okamiops", name: "luna-core", defaultBranch: "main", private: true, archived: false, updatedAt: "2026-10-01T00:00:00.000Z" },
          { repositoryId: "9003", owner: "okamiops", name: "atlas-web", defaultBranch: "main", private: true, archived: false, updatedAt: "2026-10-01T00:00:00.000Z" },
          { repositoryId: "9004", owner: "okamiops", name: "atlas-api", defaultBranch: "main", private: true, archived: false, updatedAt: "2026-10-01T00:00:00.000Z" },
          { repositoryId: "9005", owner: "okamiops", name: "atlas-cli", defaultBranch: "main", private: true, archived: false, updatedAt: "2026-10-01T00:00:00.000Z" },
        ],
      });
    }
    if (path === "/guardrails/gates" && request.method() === "GET") {
      const repositoryKey = url.searchParams.get("repositoryKey");
      return json({ gates: state.gates.filter((row) => !repositoryKey || row.repositoryKey === repositoryKey) });
    }
    const gateMatch = path.match(/^\/guardrails\/gates\/([^/]+)$/);
    if (gateMatch && request.method() === "GET") {
      const found = state.gates.find((row) => row.id === gateMatch[1]) ?? null;
      const comment = found?.pullRequestNumber == null ? null : state.prComments.find(
        (row) => row.repositoryKey === found.repositoryKey
          && row.pullRequestNumber === found.pullRequestNumber,
      ) ?? null;
      return json({ gate: found, artifact: scenario.artifact ?? null, comment });
    }
    const commentMatch = path.match(/^\/guardrails\/gates\/([^/]+)\/comment$/);
    if (commentMatch && request.method() === "POST") {
      state.commentRepublishes += 1;
      const gate = state.gates.find((row) => row.id === commentMatch[1]);
      if (!gate || gate.pullRequestNumber === null) return json({ error: "not_a_pull_request" }, 409);
      if (scenario.commentRepublishFails) {
        return json({ error: "github_permission_missing", result: { status: "failed", reason: "github_permission_missing" }, comment: null }, 502);
      }
      const comment: GuardrailPrCommentState = {
        repositoryKey: gate.repositoryKey,
        pullRequestNumber: gate.pullRequestNumber,
        commentId: "101",
        status: "published",
        reason: null,
        bodyHash: "hash-1",
        gateId: gate.id,
        updatedAt: "2026-10-01T12:00:00.000Z",
      };
      state.prComments = [
        ...state.prComments.filter((row) => row.pullRequestNumber !== comment.pullRequestNumber),
        comment,
      ];
      return json({ result: { status: "created", commentId: "101" }, comment });
    }
    throw new Error(`Unmocked guardrails request: ${request.method()} ${path}`);
  });

  return { ...base, guardrails: state };
}

/**
 * Enough of a v2 artifact for the gate page to render: the decision graph is what the
 * evidence panels read, and `baselineNotice` is the field under test.
 */
export function bootstrapArtifact() {
  return {
    schemaVersion: 2,
    gateId: "gate-1",
    repository: {
      id: "github:9001", key: "github:1", owner: "okamiops", name: "luna-core",
      defaultBranch: "main",
      locator: { kind: "github", repositoryId: "9001", owner: "okamiops", name: "luna-core" },
    },
    source: "github",
    executor: "sentinel-managed",
    target: { kind: "pull_request", number: 7 },
    resolvedTarget: {
      baseRef: "main", headRef: "feature/login", baseSha: SHA, headSha: "b".repeat(40),
      policySha: SHA, pullRequestNumber: 7,
    },
    policySource: "sentinel",
    policyInvalidReason: null,
    baselineNotice: { kind: "absent", reason: null },
    publication: { eligible: true, protectedBranch: "main", reason: "protected_branch" },
    changeSet: {
      baseRef: "main", headRef: "feature/login", baseSha: SHA, headSha: "b".repeat(40),
      files: [{ status: "modified", path: "src/app.ts", previousPath: null, additions: 3, deletions: 1 }],
      scanPaths: ["src/app.ts"], scopeMode: "changed", fallbackReason: null,
    },
    policy: policyOf("block-critical-high"),
    scan: { id: null, cost: null, status: "completed" },
    baselineCommit: null,
    findings: [],
    decision: {
      outcome: "bootstrap",
      summary: "Baseline initialized with 0 finding(s).",
      violations: [], warnings: [], exceptionsApplied: [],
      githubConclusion: "neutral",
      decisionGraph: { nodes: [], selection: [] },
    },
    lineage: {
      engine: "codex-security", engineVersion: "1.0.0", route: "openai-api",
      model: "gpt-5.6-sol", effort: "low", mode: "standard",
      scanLineageHash: `sha256:${"2".repeat(64)}`,
    },
    coverage: { status: "complete" },
    snapshot: { identity: `sha256:${"1".repeat(64)}`, materializerVersion: "snapshot-v1" },
    workflowRun: null,
    versions: { gateCore: "gate-core-v1", scanner: null },
    createdAt: "2026-10-01T09:05:00.000Z",
  };
}


export function prCommentOf(
  overrides: Partial<GuardrailPrCommentState> = {},
): GuardrailPrCommentState {
  return {
    repositoryKey: "github:1",
    pullRequestNumber: 7,
    commentId: "101",
    status: "published",
    reason: null,
    bodyHash: "hash-1",
    gateId: "gate-1",
    updatedAt: "2026-10-01T09:06:00.000Z",
    ...overrides,
  };
}
