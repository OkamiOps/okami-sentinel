import assert from "node:assert/strict";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";
import type {
  GateArtifact,
  GateRun,
  GuardrailException,
  GuardrailPolicy,
  GuardrailRepository,
} from "@csb/shared";

import {
  createGuardrailsApp,
  type GuardrailsApiDependencies,
} from "./app.js";

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
} = {}): GuardrailsApiDependencies & {
  enrolled: GuardrailRepository[];
  writes: Array<{ repositoryPath: string; policy: GuardrailPolicy }>;
} {
  const enrolled: GuardrailRepository[] = [];
  const writes: Array<{ repositoryPath: string; policy: GuardrailPolicy }> = [];
  return {
    enrolled,
    writes,
    listRepositories: () => [repository],
    resolveRepository: async () => repository,
    upsertRepository: (value) => enrolled.push(value),
    getRepository: (key) => key === repository.repositoryKey ? repository : null,
    readPolicy: () => defaultGuardrailPolicy(),
    parsePolicy: (value) => value as GuardrailPolicy,
    writePolicy: (repositoryPath, policy) => writes.push({ repositoryPath, policy }),
    readExceptions: () => options.exceptions ?? [],
    listGates: () => [gate],
    getGate: (id) => id === gate.id ? gate : null,
    getArtifact: (id) => id === gate.id ? artifact : null,
    startGate: async () => gate,
    cancelGate: () => true,
    subscribeGate: () => () => undefined,
  };
}

test("exposes the ten local guardrail routes", () => {
  const testApp = createGuardrailsApp(dependencies());
  const routes = testApp.routes.map(({ method, path }) => `${method} ${path}`);
  assert.deepEqual(routes, [
    "GET /guardrails/repositories",
    "POST /guardrails/repositories",
    "GET /guardrails/repositories/:repositoryKey/policy",
    "PUT /guardrails/repositories/:repositoryKey/policy",
    "POST /guardrails/repositories/:repositoryKey/policy/simulate",
    "GET /guardrails/gates",
    "POST /guardrails/gates",
    "GET /guardrails/gates/:gateId",
    "GET /guardrails/gates/:gateId/events",
    "POST /guardrails/gates/:gateId/cancel",
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
