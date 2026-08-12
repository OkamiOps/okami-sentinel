import assert from "node:assert/strict";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";
import type {
  GateArtifact,
  GateRun,
  GateTarget,
  GuardrailGitHubStatus,
  GuardrailException,
  GuardrailPolicy,
  GuardrailRepository,
} from "@csb/shared";

import {
  createGuardrailsApp,
  type GuardrailsApiDependencies,
} from "./app.js";
import type {
  GatePublicationAttempt,
  GateRunUpdate,
} from "./gate-store.js";
import {
  TargetPreviewError,
  type AcceptedGateTargetPreview,
  type GateTargetPreview,
  type StartGateRequest,
} from "./guardrails/target-preview.js";

function testPreview(
  value: GuardrailRepository,
  target: GateTarget,
  executor: "sentinel-managed" | "github-actions",
): GateTargetPreview {
  const baseRef = target.kind === "pull_request"
    ? "main"
    : target.kind === "compare" ? target.baseRef : target.ref;
  const headRef = target.kind === "pull_request"
    ? "feature/security"
    : target.kind === "compare" ? target.headRef : target.ref;
  const baseSha = "a".repeat(40);
  const headSha = target.kind === "protected_branch" ? baseSha : "b".repeat(40);
  return {
    previewIdentity: "preview-1",
    expiresAt: "2026-08-12T12:10:00.000Z",
    repositoryKey: value.repositoryKey,
    executor,
    target,
    resolvedTarget: {
      baseRef,
      headRef,
      baseSha,
      headSha,
      policySha: baseSha,
      pullRequestNumber: target.kind === "pull_request" ? target.number : null,
    },
    policySource: target.kind === "protected_branch" ? "protected_branch" : "base",
    policySha: baseSha,
    policyPath: ".csb/guardrails.json",
    protectedBranches: ["main"],
    exceptionsCount: 0,
    executorCapability: { ready: true, code: "ready" },
    scanPlan: {
      scopeMode: "changed",
      maxChangedPaths: 50,
      fallback: "repository",
      model: "gpt-5.6-sol",
      effort: "high",
      mode: "standard",
    },
    costBudget: {
      maxCostUsd: 18,
      kind: "estimated_ceiling",
      requestInFlightMayExceed: true,
    },
    publication: {
      eligible: baseRef === "main",
      protectedBranch: baseRef === "main" ? "main" : null,
      reason: baseRef === "main" ? "protected_branch" : "off_policy_preflight",
    },
  };
}

function remoteRepository(): GuardrailRepository {
  return {
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    displayName: "OkamiOps/private-sentinel",
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: "OkamiOps",
    remoteName: "private-sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "991122",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
  };
}

const repository: GuardrailRepository = {
  repositoryKey: "github.com/okami/csb",
  repositoryPath: "/workspace/csb",
  source: "local",
  displayName: "CSB",
  defaultBranch: "main",
  defaultExecutor: "sentinel-managed",
  remoteOwner: "okami",
  remoteName: "csb",
  githubConnectionId: null,
  githubInstallationId: null,
  githubRepositoryId: null,
  enabled: true,
  policyPath: ".csb/guardrails.json",
  lastGateId: null,
  githubStatus: "not_checked",
};

const gate: GateRun = {
  id: "gate-1",
  repositoryKey: repository.repositoryKey,
  repositoryPath: repository.repositoryPath,
  source: "local",
  executor: "sentinel-managed",
  baseRef: "main",
  headRef: "HEAD",
  resolvedBaseSha: null,
  resolvedHeadSha: null,
  policySha: null,
  pullRequestNumber: null,
  workflowRunId: null,
  materializationState: "not_required",
  scanLineageHash: null,
  artifactSchemaVersion: 1,
  scanId: null,
  status: "queued",
  outcome: null,
  policyVersion: 1,
  baselineCommit: null,
  artifactPath: null,
  publishStatus: "not_configured",
  publishError: null,
  publishedAt: null,
  error: null,
  startedAt: "2026-08-07T00:00:00.000Z",
  completedAt: null,
  estimatedUsd: 0,
};

const artifact: GateArtifact = {
  schemaVersion: 1,
  gateId: gate.id,
  repository: {
    key: repository.repositoryKey,
    owner: repository.remoteOwner,
    name: repository.remoteName!,
    defaultBranch: repository.defaultBranch,
  },
  source: "local",
  changeSet: {
    baseRef: "main",
    headRef: "HEAD",
    baseSha: "base",
    headSha: "head",
    files: [{
      status: "modified",
      path: "src/app.ts",
      previousPath: null,
      additions: null,
      deletions: null,
    }],
    scanPaths: ["src/app.ts"],
    scopeMode: "changed",
    fallbackReason: null,
  },
  policy: defaultGuardrailPolicy(),
  scan: { id: "scan-1", cost: null, status: "completed" },
  baselineCommit: "base",
  findings: [],
  decision: {
    outcome: "pass",
    summary: "No policy violations.",
    violations: [],
    warnings: [],
    exceptionsApplied: [],
    githubConclusion: "success",
    decisionGraph: { nodes: [], selectedNodeId: "signal" },
  },
  versions: { gateCore: "0.1.0", scanner: null },
  createdAt: "2026-08-07T00:00:00.000Z",
};

function dependencies(options: {
  exceptions?: GuardrailException[];
  artifact?: GateArtifact | null;
  gate?: Partial<GateRun>;
  remote?: boolean;
  repository?: GuardrailRepository;
  acceptPreviewError?: boolean;
  publishError?: string;
} = {}): GuardrailsApiDependencies & {
  enrolled: GuardrailRepository[];
  writes: Array<{ repositoryPath: string; policy: GuardrailPolicy }>;
  callerWorkflowRequests: string[];
  baselineSyncs: string[];
  publicationInputs: Array<Parameters<GuardrailsApiDependencies["publishCheck"]>[0]>;
  started: Array<{
    request: StartGateRequest;
    acceptedPreview: AcceptedGateTargetPreview | null;
  }>;
  store: {
    getGateRun(gateId: string): GateRun | null;
    listGatePublicationAttempts(gateId: string): GatePublicationAttempt[];
  };
} {
  const enrolled: GuardrailRepository[] = [];
  const writes: Array<{ repositoryPath: string; policy: GuardrailPolicy }> = [];
  const callerWorkflowRequests: string[] = [];
  const baselineSyncs: string[] = [];
  const publicationInputs: Array<Parameters<GuardrailsApiDependencies["publishCheck"]>[0]> = [];
  const started: Array<{
    request: StartGateRequest;
    acceptedPreview: AcceptedGateTargetPreview | null;
  }> = [];
  const currentRepository: GuardrailRepository = options.repository ?? (options.remote === false
    ? { ...repository, remoteOwner: null, remoteName: null, githubStatus: "not_configured" }
    : { ...repository });
  const currentGate: GateRun = { ...gate, ...options.gate };
  const currentArtifact = Object.prototype.hasOwnProperty.call(options, "artifact")
    ? options.artifact ?? null
    : artifact;
  const attempts = new Map<string, GatePublicationAttempt>();
  const githubStatus: GuardrailGitHubStatus = {
    subscription: { ready: true, message: "ready", action: null },
    cli: { available: true, ready: true, message: "ready", action: null },
    remote: { ready: true, message: "ready", action: null },
    auth: { ready: true, message: "ready", action: null },
    permissions: { ready: true, message: "ready", action: null },
    secret: { ready: true, message: "ready", action: null },
    workflow: { ready: true, message: "ready", action: null },
    baseline: { ready: true, message: "ready", action: null },
    ready: true,
  };
  return {
    enrolled,
    writes,
    callerWorkflowRequests,
    baselineSyncs,
    publicationInputs,
    started,
    store: {
      getGateRun: (id) => id === currentGate.id ? currentGate : null,
      listGatePublicationAttempts: (id) =>
        [...attempts.values()].filter((attempt) => attempt.gateId === id),
    },
    listRepositories: () => [currentRepository],
    enrollRepository: async () => currentRepository,
    upsertRepository: (value) => enrolled.push(value),
    getRepository: (key) => key === currentRepository.repositoryKey ? currentRepository : null,
    readPolicy: () => defaultGuardrailPolicy(),
    parsePolicy: (value) => value as GuardrailPolicy,
    writePolicy: (repositoryPath, policy) => writes.push({ repositoryPath, policy }),
    readExceptions: () => options.exceptions ?? [],
    listGates: () => [currentGate],
    getGate: (id) => id === currentGate.id ? currentGate : null,
    getArtifact: (id) => id === currentGate.id ? currentArtifact : null,
    previewTarget: async (_repository, request) => testPreview(
      currentRepository,
      request.target,
      request.executor ?? currentRepository.defaultExecutor,
    ),
    acceptTargetPreview: (_repository, request) => {
      if (options.acceptPreviewError) throw new TargetPreviewError("target_preview_stale");
      const preview = testPreview(currentRepository, request.target, request.executor);
      if (request.previewIdentity !== preview.previewIdentity) {
        throw new TargetPreviewError("target_preview_stale");
      }
      return {
        ...preview,
        policy: defaultGuardrailPolicy(),
        exceptions: [],
        repositoryAuthority: {
          connectionId: currentRepository.githubConnectionId ?? "connection-1",
          installationId: currentRepository.githubInstallationId ?? "77",
          repositoryId: currentRepository.githubRepositoryId ?? "991122",
        },
      };
    },
    startGate: async (request, acceptedPreview) => {
      started.push({ request, acceptedPreview });
      return currentGate;
    },
    cancelGate: () => true,
    subscribeGate: () => () => undefined,
    getGitHubStatus: async () => githubStatus,
    getCallerWorkflow: async (value) => {
      callerWorkflowRequests.push(value.repositoryKey);
      return {
        path: ".github/workflows/csb-security-change-gate.yml",
        filename: "csb-security-change-gate.yml",
        mediaType: "application/yaml",
        content: "name: CSB Security Change Gate\n",
      };
    },
    syncBaseline: async (value) => {
      baselineSyncs.push(value.repositoryKey);
      return artifact;
    },
    publishCheck: async (input) => {
      publicationInputs.push(input);
      if (options.publishError) throw new Error(options.publishError);
    },
    updateGate: (id: string, updates: GateRunUpdate) => {
      if (id === currentGate.id) Object.assign(currentGate, updates);
    },
    recordPublicationAttempt: (attempt) => {
      attempts.set(attempt.id, attempt);
    },
    listPublicationAttempts: (gateId) =>
      [...attempts.values()].filter((attempt) => attempt.gateId === gateId),
  };
}

test("exposes local and github guardrail routes", () => {
  const testApp = createGuardrailsApp(dependencies());
  const routes = testApp.routes.map(({ method, path }) => `${method} ${path}`);
  assert.deepEqual(routes, [
    "GET /guardrails/repositories",
    "POST /guardrails/repositories",
    "POST /guardrails/repositories/:repositoryKey/target-preview",
    "GET /guardrails/repositories/:repositoryKey/policy",
    "PUT /guardrails/repositories/:repositoryKey/policy",
    "POST /guardrails/repositories/:repositoryKey/policy/simulate",
    "GET /guardrails/repositories/:repositoryKey/github-status",
    "GET /guardrails/repositories/:repositoryKey/caller-workflow",
    "POST /guardrails/repositories/:repositoryKey/baseline/sync",
    "GET /guardrails/gates",
    "POST /guardrails/gates",
    "GET /guardrails/gates/:gateId",
    "GET /guardrails/gates/:gateId/events",
    "POST /guardrails/gates/:gateId/cancel",
    "POST /guardrails/gates/:gateId/publish",
  ]);
});
test("POST /guardrails/gates returns 202 with a queued gate", async () => {
  const testApp = createGuardrailsApp(dependencies());
  const response = await testApp.request("/guardrails/gates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repositoryKey: repository.repositoryKey,
      target: { kind: "compare", baseRef: "main", headRef: "feature/security" },
    }),
  });

  assert.equal(response.status, 202);
  assert.equal((await response.json()).gate.status, "queued");
});

test("remote target preview freezes the accepted identity used by gate start", async () => {
  const remote = remoteRepository();
  const deps = dependencies({ repository: remote, gate: { source: "github", repositoryPath: null } });
  const base = `/guardrails/repositories/${encodeURIComponent(remote.repositoryKey)}`;
  const target = { kind: "pull_request" as const, number: 42 };
  const previewResponse = await createGuardrailsApp(deps).request(`${base}/target-preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, executor: "sentinel-managed" }),
  });
  const previewBody = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  assert.equal(previewBody.preview.resolvedTarget.headSha, "b".repeat(40));

  const startResponse = await createGuardrailsApp(deps).request("/guardrails/gates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repositoryKey: remote.repositoryKey,
      target,
      executor: "sentinel-managed",
      previewIdentity: previewBody.preview.previewIdentity,
    }),
  });
  assert.equal(startResponse.status, 202);
  assert.equal(deps.started.length, 1);
  assert.equal(deps.started[0]?.acceptedPreview?.resolvedTarget.headSha, "b".repeat(40));
  assert.equal(deps.started[0]?.acceptedPreview?.policySha, "a".repeat(40));
});

test("remote gate start rejects a stale accepted preview before dispatch", async () => {
  const remote = remoteRepository();
  const deps = dependencies({ repository: remote, acceptPreviewError: true });
  const response = await createGuardrailsApp(deps).request("/guardrails/gates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repositoryKey: remote.repositoryKey,
      target: { kind: "pull_request", number: 42 },
      executor: "sentinel-managed",
      previewIdentity: "expired-preview",
    }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "target_preview_stale" });
  assert.equal(deps.started.length, 0);
});

test("enrollment persists only the server-resolved repository identity", async () => {
  const deps = dependencies();
  const response = await createGuardrailsApp(deps).request("/guardrails/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "local", repositoryPath: "/workspace/csb/nested" }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(deps.enrolled, [repository]);
  assert.equal((await response.json()).repository.policyPath, ".csb/guardrails.json");
});

test("policy PUT delegates the validated policy to the atomic adapter", async () => {
  const deps = dependencies();
  const policy = defaultGuardrailPolicy();
  const response = await createGuardrailsApp(deps).request(
    `/guardrails/repositories/${encodeURIComponent(repository.repositoryKey)}/policy`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(policy),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(deps.writes, [{ repositoryPath: repository.repositoryPath, policy }]);
});

test("policy simulation reports an expired exception and does not apply it", async () => {
  const expired: GuardrailException = {
    findingIdentity: "finding-1",
    reason: "temporary",
    owner: "security",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-06T00:00:00.000Z",
    branches: ["HEAD"],
    ruleIndexes: [],
  };
  const testApp = createGuardrailsApp(dependencies({ exceptions: [expired] }));
  const response = await testApp.request(
    `/guardrails/repositories/${encodeURIComponent(repository.repositoryKey)}/policy/simulate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gateId: "gate-1",
        policy: defaultGuardrailPolicy(),
        now: "2026-08-07T00:00:00.000Z",
      }),
    },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.decision.exceptionsApplied.length, 0);
  assert.equal(body.configurationErrors[0]?.field, "exceptions[0].expiresAt");
});

test("github status, read-only caller workflow and baseline sync use the enrolled repository", async () => {
  const deps = dependencies();
  const base = `/guardrails/repositories/${encodeURIComponent(repository.repositoryKey)}`;

  const statusResponse = await createGuardrailsApp(deps).request(`${base}/github-status`);
  const callerResponse = await createGuardrailsApp(deps).request(`${base}/caller-workflow`);
  const baselineResponse = await createGuardrailsApp(deps).request(`${base}/baseline/sync`, {
    method: "POST",
  });

  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).status.ready, true);
  assert.equal(callerResponse.status, 200);
  assert.equal((await callerResponse.json()).workflow.path, ".github/workflows/csb-security-change-gate.yml");
  assert.equal(baselineResponse.status, 200);
  assert.equal((await baselineResponse.json()).baseline.gateId, artifact.gateId);
  assert.deepEqual(deps.callerWorkflowRequests, [repository.repositoryKey]);
  assert.deepEqual(deps.baselineSyncs, [repository.repositoryKey]);
});

test("github actions reject a repository without a remote", async () => {
  const testApp = createGuardrailsApp(dependencies({ remote: false }));
  const base = `/guardrails/repositories/${encodeURIComponent(repository.repositoryKey)}`;

  assert.equal((await testApp.request(`${base}/caller-workflow`)).status, 400);
  assert.equal((await testApp.request(`${base}/baseline/sync`, { method: "POST" })).status, 400);
});

test("POST publish returns 409 when the gate has no artifact", async () => {
  const response = await createGuardrailsApp(dependencies({ artifact: null })).request(
    "/guardrails/gates/gate-1/publish",
    { method: "POST" },
  );
  assert.equal(response.status, 409);
});

test("POST publish keeps the local outcome when github fails", async () => {
  const deps = dependencies({
    gate: { status: "completed", outcome: "blocked" },
    publishError: "GitHub API unavailable",
  });
  const response = await createGuardrailsApp(deps).request(
    "/guardrails/gates/gate-1/publish",
    { method: "POST" },
  );

  assert.equal(response.status, 502);
  assert.equal(deps.store.getGateRun("gate-1")?.outcome, "blocked");
  assert.equal(deps.store.getGateRun("gate-1")?.publishStatus, "failed");
  assert.match(deps.store.getGateRun("gate-1")?.publishError ?? "", /github/i);
  assert.deepEqual(
    deps.store.listGatePublicationAttempts("gate-1").map((attempt) => attempt.status),
    ["failed"],
  );
});
