import assert from "node:assert/strict";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";
import type {
  GateArtifact,
  GateRun,
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

const repository: GuardrailRepository = {
  repositoryKey: "github.com/okami/csb",
  repositoryPath: "/workspace/csb",
  displayName: "CSB",
  defaultBranch: "main",
  remoteOwner: "okami",
  remoteName: "csb",
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
  baseRef: "main",
  headRef: "HEAD",
  pullRequestNumber: null,
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
  publishError?: string;
} = {}): GuardrailsApiDependencies & {
  enrolled: GuardrailRepository[];
  writes: Array<{ repositoryPath: string; policy: GuardrailPolicy }>;
  installed: string[];
  baselineSyncs: string[];
  publicationInputs: Array<Parameters<GuardrailsApiDependencies["publishCheck"]>[0]>;
  store: {
    getGateRun(gateId: string): GateRun | null;
    listGatePublicationAttempts(gateId: string): GatePublicationAttempt[];
  };
} {
  const enrolled: GuardrailRepository[] = [];
  const writes: Array<{ repositoryPath: string; policy: GuardrailPolicy }> = [];
  const installed: string[] = [];
  const baselineSyncs: string[] = [];
  const publicationInputs: Array<Parameters<GuardrailsApiDependencies["publishCheck"]>[0]> = [];
  const currentRepository: GuardrailRepository = options.remote === false
    ? { ...repository, remoteOwner: null, remoteName: null, githubStatus: "not_configured" }
    : { ...repository };
  const currentGate: GateRun = { ...gate, ...options.gate };
  const currentArtifact = Object.prototype.hasOwnProperty.call(options, "artifact")
    ? options.artifact ?? null
    : artifact;
  const attempts = new Map<string, GatePublicationAttempt>();
  const githubStatus: GuardrailGitHubStatus = {
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
    installed,
    baselineSyncs,
    publicationInputs,
    store: {
      getGateRun: (id) => id === currentGate.id ? currentGate : null,
      listGatePublicationAttempts: (id) =>
        [...attempts.values()].filter((attempt) => attempt.gateId === id),
    },
    listRepositories: () => [currentRepository],
    resolveRepository: async () => currentRepository,
    upsertRepository: (value) => enrolled.push(value),
    getRepository: (key) => key === currentRepository.repositoryKey ? currentRepository : null,
    readPolicy: () => defaultGuardrailPolicy(),
    parsePolicy: (value) => value as GuardrailPolicy,
    writePolicy: (repositoryPath, policy) => writes.push({ repositoryPath, policy }),
    readExceptions: () => options.exceptions ?? [],
    listGates: () => [currentGate],
    getGate: (id) => id === currentGate.id ? currentGate : null,
    getArtifact: (id) => id === currentGate.id ? currentArtifact : null,
    startGate: async () => currentGate,
    cancelGate: () => true,
    subscribeGate: () => () => undefined,
    getGitHubStatus: async () => githubStatus,
    installWorkflow: async (repositoryPath) => {
      installed.push(repositoryPath);
      return {
        path: `${repositoryPath}/.github/workflows/csb-security-change-gate.yml`,
        committed: false,
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
    "GET /guardrails/repositories/:repositoryKey/policy",
    "PUT /guardrails/repositories/:repositoryKey/policy",
    "POST /guardrails/repositories/:repositoryKey/policy/simulate",
    "GET /guardrails/repositories/:repositoryKey/github-status",
    "POST /guardrails/repositories/:repositoryKey/install-workflow",
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
      baseRef: "main",
      headRef: "HEAD",
    }),
  });

  assert.equal(response.status, 202);
  assert.equal((await response.json()).gate.status, "queued");
});

test("enrollment persists only the server-resolved repository identity", async () => {
  const deps = dependencies();
  const response = await createGuardrailsApp(deps).request("/guardrails/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repositoryPath: "/workspace/csb/nested" }),
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

test("github status, workflow installation and baseline sync use the enrolled repository", async () => {
  const deps = dependencies();
  const base = `/guardrails/repositories/${encodeURIComponent(repository.repositoryKey)}`;

  const statusResponse = await createGuardrailsApp(deps).request(`${base}/github-status`);
  const installResponse = await createGuardrailsApp(deps).request(`${base}/install-workflow`, {
    method: "POST",
  });
  const baselineResponse = await createGuardrailsApp(deps).request(`${base}/baseline/sync`, {
    method: "POST",
  });

  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).status.ready, true);
  assert.equal(installResponse.status, 201);
  assert.equal((await installResponse.json()).workflow.committed, false);
  assert.equal(baselineResponse.status, 200);
  assert.equal((await baselineResponse.json()).baseline.gateId, artifact.gateId);
  assert.deepEqual(deps.installed, [repository.repositoryPath]);
  assert.deepEqual(deps.baselineSyncs, [repository.repositoryKey]);
});

test("github actions reject a repository without a remote", async () => {
  const testApp = createGuardrailsApp(dependencies({ remote: false }));
  const base = `/guardrails/repositories/${encodeURIComponent(repository.repositoryKey)}`;

  assert.equal((await testApp.request(`${base}/install-workflow`, { method: "POST" })).status, 400);
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
