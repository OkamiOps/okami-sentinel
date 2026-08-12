import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChangeSet,
  GateArtifact,
  GateArtifactV2,
  GateFindingDelta,
} from "@csb/shared";
import {
  buildDecisionGraph,
  buildGateArtifact,
  buildGateArtifactV2,
  buildOperationalErrorArtifact,
  buildOperationalErrorArtifactV2,
  buildScanLineage,
  defaultGuardrailPolicy,
  gatePublicationEligibility,
  parseGateArtifact,
  type BuildGateArtifactInput,
  type BuildGateArtifactV2Input,
} from "./index.js";

const FULL_BASE_SHA = "1".repeat(40);
const FULL_HEAD_SHA = "2".repeat(40);

function changeSet(): ChangeSet {
  return {
    baseRef: "main",
    headRef: "HEAD",
    baseSha: "base-sha",
    headSha: "head-sha",
    files: [{
      status: "modified",
      path: "src/report.ts",
      previousPath: null,
      additions: 1,
      deletions: 0,
    }],
    scanPaths: ["src/report.ts"],
    scopeMode: "changed",
    fallbackReason: null,
  };
}

function finding(): GateFindingDelta {
  return {
    findingId: "finding-1",
    occurrenceId: null,
    title: "Stored XSS",
    severity: "high",
    confidence: "high",
    ruleId: "CWE-79",
    summary: null,
    primaryPath: "src/report.ts:88",
    fingerprints: ["sha256:stable-xss"],
    category: "Stored cross-site scripting",
    cwe: ["CWE-79"],
    identity: "fp:sha256:stable-xss",
    lifecycle: "reopened",
    triage: { status: "unreviewed", note: null, updatedAt: null },
    exception: null,
    sourceScanId: "scan-current",
  };
}

function artifactInput(): BuildGateArtifactInput {
  const findingDelta = finding();
  return {
    gateId: "gate-1",
    repository: {
      key: "github.com/okami/security-benchmark",
      owner: "okami",
      name: "security-benchmark",
      defaultBranch: "main",
    },
    source: "local",
    changeSet: changeSet(),
    policy: defaultGuardrailPolicy(),
    scan: {
      id: "scan-current",
      cost: {
        estimatedUsd: 1.25,
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 0,
        outputTokens: 50,
        model: "gpt-5.6-sol",
      },
      status: "completed",
    },
    baselineCommit: "base-sha",
    evaluation: {
      deltas: [findingDelta],
      decision: {
        outcome: "blocked",
        summary: "1 blocking policy violation(s).",
        violations: [{
          findingIdentity: findingDelta.identity,
          ruleIndex: 1,
          decision: "block",
          reason: "high/reopened",
        }],
        warnings: [],
        exceptionsApplied: [],
        githubConclusion: "failure",
      },
    },
    versions: { gateCore: "0.1.0", scanner: "1.2.3" },
    createdAt: "2026-08-07T12:00:00.000Z",
  };
}

function artifactV2Input(): BuildGateArtifactV2Input {
  const legacy = artifactInput();
  legacy.changeSet = {
    ...legacy.changeSet,
    baseRef: "main",
    headRef: "refs/pull/7/head",
    baseSha: FULL_BASE_SHA,
    headSha: FULL_HEAD_SHA,
  };
  legacy.baselineCommit = FULL_BASE_SHA;
  return {
    ...legacy,
    repository: {
      ...legacy.repository,
      id: "github:4242",
      key: "github:4242",
      locator: {
        kind: "github",
        repositoryId: "4242",
        owner: "okami",
        name: "security-benchmark",
      },
    },
    source: "github",
    executor: "sentinel-managed",
    target: { kind: "pull_request", number: 7 },
    resolvedTarget: {
      baseRef: "main",
      headRef: "refs/pull/7/head",
      baseSha: FULL_BASE_SHA,
      headSha: FULL_HEAD_SHA,
      policySha: FULL_BASE_SHA,
      pullRequestNumber: 7,
    },
    policySource: "base",
    lineage: buildScanLineage({
      engine: "codex-security",
      engineVersion: "1.2.3",
      route: "minimax-token-plan",
      protocol: "anthropic-messages",
      provider: "minimax",
      model: "MiniMax-M3",
      reasoningEffort: "provider-default",
      methodology: "portable-codex-security",
      profile: "deep",
      recipeHash: `sha256:${"a".repeat(64)}`,
      sourceRevision: `sha256:${"b".repeat(64)}`,
    }),
    coverage: {
      status: "complete",
      repositoryFileCount: 20,
      inspectedFileCount: 20,
      unexaminedFileCount: 0,
      submodules: [],
      lfsPointers: [],
    },
    snapshot: {
      identity: `sha256:${"c".repeat(64)}`,
      materializerVersion: "snapshot-v1",
    },
    workflowRun: {
      id: "987654321",
      attempt: 1,
    },
  };
}

function cloneArtifact(): Record<string, unknown> {
  return structuredClone(buildGateArtifact(artifactInput())) as unknown as Record<string, unknown>;
}

function passDecision(): BuildGateArtifactInput["evaluation"]["decision"] {
  return {
    outcome: "pass",
    summary: "No policy violations.",
    violations: [],
    warnings: [],
    exceptionsApplied: [],
    githubConclusion: "success",
  };
}

function passInput(): BuildGateArtifactInput {
  const input = artifactInput();
  input.evaluation.decision = passDecision();
  return input;
}

function bootstrapInput(): BuildGateArtifactInput {
  const input = artifactInput();
  input.baselineCommit = null;
  input.evaluation.deltas[0]!.lifecycle = "new";
  input.evaluation.decision = {
    outcome: "bootstrap",
    summary: "Baseline initialized.",
    violations: [],
    warnings: [],
    exceptionsApplied: [],
    githubConclusion: "neutral",
  };
  return input;
}

function warningInput(): BuildGateArtifactInput {
  const input = artifactInput();
  input.evaluation.deltas[0]!.lifecycle = "persistent";
  input.evaluation.decision = {
    outcome: "warning",
    summary: "1 policy warning(s).",
    violations: [],
    warnings: [{
      findingIdentity: input.evaluation.deltas[0]!.identity,
      ruleIndex: 2,
      decision: "review",
      reason: "high/persistent",
    }],
    exceptionsApplied: [],
    githubConclusion: "neutral",
  };
  return input;
}

function noChangesInput(baselineCommit: string | null = null): BuildGateArtifactInput {
  const input = artifactInput();
  input.changeSet = { ...changeSet(), files: [], scanPaths: [] };
  input.scan = { id: null, cost: null, status: "not_run" };
  input.baselineCommit = baselineCommit;
  input.evaluation = {
    deltas: [],
    decision: {
      outcome: "no_changes",
      summary: "No changed files to scan.",
      violations: [],
      warnings: [],
      exceptionsApplied: [],
      githubConclusion: "success",
    },
  };
  return input;
}

function replaceArtifactDecision(
  artifact: GateArtifact,
  decision: BuildGateArtifactInput["evaluation"]["decision"],
): void {
  artifact.decision = {
    ...decision,
    decisionGraph: buildDecisionGraph(artifact.changeSet, artifact.findings, decision),
  };
}

test("creates a schema v1 artifact without a local path", () => {
  const input = artifactInput() as BuildGateArtifactInput & {
    repositoryPath: string;
    artifactPath: string;
  };
  input.repositoryPath = "/Users/marcos/private-repository";
  input.artifactPath = "/Users/marcos/private-artifact.json";

  const artifact = buildGateArtifact(input);

  assert.equal(artifact.schemaVersion, 1);
  assert.equal(JSON.stringify(artifact).includes("/Users/"), false);
  assert.equal(artifact.decision.decisionGraph.nodes.length, 5);
  assert.deepEqual(Object.keys(artifact.repository), ["key", "owner", "name", "defaultBranch"]);
});

test("round-trips a complete GateArtifact v2 without host paths", () => {
  const artifact = buildGateArtifactV2(artifactV2Input());
  const parsed = parseGateArtifact(JSON.parse(JSON.stringify(artifact)));

  assert.equal(parsed.schemaVersion, 2);
  const v2 = parsed as GateArtifactV2;
  assert.equal(v2.repository.id, "github:4242");
  assert.deepEqual(v2.repository.locator, {
    kind: "github",
    repositoryId: "4242",
    owner: "okami",
    name: "security-benchmark",
  });
  assert.equal(v2.executor, "sentinel-managed");
  assert.equal(v2.resolvedTarget.policySha, FULL_BASE_SHA);
  assert.equal(v2.policySource, "base");
  assert.match(v2.lineage.scanLineageHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(v2.coverage.status, "complete");
  assert.match(v2.snapshot.identity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(v2.snapshot.materializerVersion, "snapshot-v1");
  assert.deepEqual(v2.workflowRun, { id: "987654321", attempt: 1 });
  assert.deepEqual(v2.publication, {
    eligible: true,
    protectedBranch: "main",
    reason: "protected_branch",
  });
  assert.equal(JSON.stringify(v2).includes("/Users/"), false);
});

test("keeps local and GitHub artifact locators discriminated", () => {
  const local = artifactV2Input();
  local.source = "local";
  local.repository = {
    id: "local:security-benchmark",
    key: "local:security-benchmark",
    owner: null,
    name: "security-benchmark",
    defaultBranch: "main",
    locator: { kind: "local", repositoryKey: "local:security-benchmark" },
  };
  local.target = { kind: "compare", baseRef: "main", headRef: "feature" };
  local.resolvedTarget = {
    ...local.resolvedTarget,
    baseRef: "main",
    headRef: "feature",
    pullRequestNumber: null,
  };
  local.changeSet = {
    ...local.changeSet,
    baseRef: "main",
    headRef: "feature",
  };

  const artifact = buildGateArtifactV2(local);
  assert.deepEqual(artifact.repository.locator, {
    kind: "local",
    repositoryKey: "local:security-benchmark",
  });
  assert.equal(JSON.stringify(artifact).includes("repositoryPath"), false);

  local.executor = "github-actions";
  assert.throws(() => buildGateArtifactV2(local), /executor.*local/);

  const mismatched = artifactV2Input();
  mismatched.repository.locator = {
    kind: "local",
    repositoryKey: mismatched.repository.key,
  };
  assert.throws(() => buildGateArtifactV2(mismatched), /locator\.kind.*source/);
});

test("keeps schema v1 parseable as history", () => {
  const legacy = buildGateArtifact(artifactInput());
  assert.equal(parseGateArtifact(legacy).schemaVersion, 1);
});

test("rejects malformed or over-trusting GateArtifact v2 envelopes", () => {
  const shortSha = artifactV2Input();
  shortSha.resolvedTarget.headSha = "short";
  assert.throws(() => buildGateArtifactV2(shortSha), /resolvedTarget\.headSha/);

  const impossiblePolicySource = artifactV2Input();
  impossiblePolicySource.policySource = "protected_branch";
  assert.throws(() => buildGateArtifactV2(impossiblePolicySource), /policySource/);

  const missingProtectedPolicy = artifactV2Input();
  missingProtectedPolicy.policySource = "default";
  assert.equal(buildGateArtifactV2(missingProtectedPolicy).policySource, "default");

  const hostPath = artifactV2Input();
  hostPath.repository.locator = {
    kind: "github",
    repositoryId: "4242",
    owner: "/Users/marcos/private",
    name: "security-benchmark",
  };
  assert.throws(() => buildGateArtifactV2(hostPath), /repository\.locator\.owner/);

  const unknown = structuredClone(buildGateArtifactV2(artifactV2Input())) as unknown as Record<string, unknown>;
  unknown.runtimePath = "/Users/marcos/private";
  assert.throws(() => parseGateArtifact(unknown), /campo desconhecido runtimePath/);
});

test("rejects a successful v2 decision with incomplete coverage", () => {
  const input = artifactV2Input();
  input.evaluation.decision = passDecision();
  input.evaluation.deltas = [];
  input.coverage = {
    ...input.coverage,
    status: "partial",
    inspectedFileCount: 19,
    unexaminedFileCount: 1,
  };

  assert.throws(() => buildGateArtifactV2(input), /coverage.*pass/);
});

test("keeps v2 operational failures action_required without findings", () => {
  const input = artifactV2Input();
  const { evaluation: _evaluation, ...envelope } = input;
  envelope.scan = { id: "scan-current", cost: null, status: "failed" };
  envelope.coverage = {
    ...envelope.coverage,
    status: "partial",
    inspectedFileCount: 19,
    unexaminedFileCount: 1,
  };
  const artifact = buildOperationalErrorArtifactV2({
    ...envelope,
    operationalSummary: "scanner failed at /Users/marcos/private",
  });

  assert.equal(artifact.decision.outcome, "error");
  assert.equal(artifact.decision.githubConclusion, "action_required");
  assert.deepEqual(artifact.findings, []);
  assert.equal(JSON.stringify(artifact).includes("/Users/"), false);
});

test("allows an explicit protected-branch scan to establish a neutral baseline on an unchanged commit", () => {
  const input = artifactV2Input();
  input.target = { kind: "protected_branch", ref: "main" };
  input.resolvedTarget = {
    baseRef: "main",
    headRef: "main",
    baseSha: FULL_HEAD_SHA,
    headSha: FULL_HEAD_SHA,
    policySha: FULL_HEAD_SHA,
    pullRequestNumber: null,
  };
  input.policySource = "protected_branch";
  input.changeSet = {
    ...input.changeSet,
    baseRef: "main",
    headRef: "main",
    baseSha: FULL_HEAD_SHA,
    headSha: FULL_HEAD_SHA,
    files: [],
    scanPaths: [],
  };
  input.baselineCommit = null;
  input.evaluation.deltas[0]!.lifecycle = "new";
  input.evaluation.decision = {
    outcome: "bootstrap",
    summary: "Protected baseline initialized.",
    violations: [],
    warnings: [],
    exceptionsApplied: [],
    githubConclusion: "neutral",
  };

  const artifact = buildGateArtifactV2(input);
  assert.equal(artifact.target.kind, "protected_branch");
  assert.equal(artifact.decision.outcome, "bootstrap");
  assert.equal(artifact.decision.githubConclusion, "neutral");
  assert.equal(artifact.scan.status, "completed");
});

test("makes protectedBranches authoritative for Check publication", () => {
  const protectedInput = artifactV2Input();
  assert.deepEqual(
    gatePublicationEligibility(
      protectedInput.policy,
      protectedInput.target,
      protectedInput.resolvedTarget,
    ),
    { eligible: true, protectedBranch: "main", reason: "protected_branch" },
  );

  const offPolicy = artifactV2Input();
  offPolicy.target = { kind: "compare", baseRef: "feature/a", headRef: "feature/b" };
  offPolicy.resolvedTarget = {
    ...offPolicy.resolvedTarget,
    baseRef: "feature/a",
    headRef: "feature/b",
    policySha: FULL_BASE_SHA,
    pullRequestNumber: null,
  };
  assert.deepEqual(
    gatePublicationEligibility(offPolicy.policy, offPolicy.target, offPolicy.resolvedTarget),
    { eligible: false, protectedBranch: null, reason: "off_policy_preflight" },
  );
});

test("rejects an absolute local path in finding evidence", () => {
  const input = artifactInput();
  input.evaluation.deltas[0]!.primaryPath = "/Users/marcos/private-repository/src/report.ts:88";

  assert.throws(() => buildGateArtifact(input), /caminho absoluto local/);
});

test("whitelists nested runtime fields before serialization", () => {
  const input = artifactInput();
  const markers = [
    "scope-extra",
    "policy-scan-extra",
    "cost-extra",
    "finding-extra",
    "triage-extra",
    "exception-extra",
    "violation-extra",
    "warning-extra",
  ];

  Object.assign(input.policy.scope, { runtimeExtra: markers[0] });
  Object.assign(input.policy.scan, { runtimeExtra: markers[1] });
  Object.assign(input.scan.cost!, { runtimeExtra: markers[2] });
  Object.assign(input.evaluation.deltas[0]!, { runtimeExtra: markers[3] });
  Object.assign(input.evaluation.deltas[0]!.triage, { runtimeExtra: markers[4] });
  input.evaluation.deltas[0]!.exception = {
    findingIdentity: input.evaluation.deltas[0]!.identity,
    reason: "Temporary exception",
    owner: "security",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-30T00:00:00.000Z",
    branches: ["main"],
    ruleIndexes: [1],
  };
  Object.assign(input.evaluation.deltas[0]!.exception, { runtimeExtra: markers[5] });
  Object.assign(input.evaluation.decision.violations[0]!, { runtimeExtra: markers[6] });
  input.policy.rules.push({ severity: ["high"], lifecycle: ["reopened"], decision: "review" });
  input.evaluation.decision.warnings = [{
    findingIdentity: input.evaluation.deltas[0]!.identity,
    ruleIndex: 3,
    decision: "review",
    reason: "high/reopened",
  }];
  Object.assign(input.evaluation.decision.warnings[0]!, { runtimeExtra: markers[7] });

  const serialized = JSON.stringify(buildGateArtifact(input));

  for (const marker of markers) assert.equal(serialized.includes(marker), false, marker);
  assert.equal(serialized.includes("runtimeExtra"), false);
});

test("rejects every unsafe public-string bypass with its field path", () => {
  const githubPat = `ghp_${"a".repeat(36)}`;
  const cases: Array<{
    name: string;
    path: string;
    mutate: (input: BuildGateArtifactInput) => void;
  }> = [
    {
      name: "leading whitespace path",
      path: "repository.owner",
      mutate: (input) => { input.repository.owner = "   /Users/marcos/private"; },
    },
    {
      name: "case-insensitive file URL",
      path: "findings[0].summary",
      mutate: (input) => { input.evaluation.deltas[0]!.summary = "See FiLe:///Users/marcos/private"; },
    },
    {
      name: "Windows drive path",
      path: "policy.protectedBranches[0]",
      mutate: (input) => { input.policy.protectedBranches[0] = " C:\\Users\\marcos\\private"; },
    },
    {
      name: "UNC path",
      path: "findings[0].category",
      mutate: (input) => { input.evaluation.deltas[0]!.category = "\\\\server\\share\\private"; },
    },
    {
      name: "loose Bearer token",
      path: "findings[0].summary",
      mutate: (input) => { input.evaluation.deltas[0]!.summary = "Bearer aB3dE5fG7hJ9kL2m"; },
    },
    {
      name: "named secret assignment",
      path: "findings[0].summary",
      mutate: (input) => { input.evaluation.deltas[0]!.summary = "password = hunter2"; },
    },
    {
      name: "GitHub PAT",
      path: "findings[0].summary",
      mutate: (input) => { input.evaluation.deltas[0]!.summary = githubPat; },
    },
    {
      name: "OpenAI API token",
      path: "findings[0].summary",
      mutate: (input) => { input.evaluation.deltas[0]!.summary = `sk-proj-${"b".repeat(32)}`; },
    },
  ];

  for (const fixture of cases) {
    const input = artifactInput();
    fixture.mutate(input);
    assert.throws(
      () => buildGateArtifact(input),
      (error: unknown) => error instanceof Error
        && error.message.includes(fixture.path)
        && /(caminho absoluto local|possível segredo)/.test(error.message),
      fixture.name,
    );
  }
});

test("rejects prefixed secret assignments without underscore boundary gaps", () => {
  for (const assignment of [
    "OPENAI_API_KEY = ordinary-value",
    "GITHUB_TOKEN=ordinary-value",
    "AWS_SECRET_ACCESS_KEY: ordinary-value",
    "DATABASE_PASSWORD = ordinary-value",
    "INTERNAL_WEBHOOK_SECRET=ordinary-value",
  ]) {
    const input = artifactInput();
    input.evaluation.deltas[0]!.summary = assignment;

    assert.throws(
      () => buildGateArtifact(input),
      /findings\[0\]\.summary.*possível segredo/,
      assignment,
    );
  }
});

test("rejects known local roots inside narrative delimiters", () => {
  for (const leakedPath of [
    "leaked [`/Users/marcos/private/repo`]",
    "read from '/home/marcos/private/repo'",
    "stored at [/tmp/private-report.json]",
    "temporary root [/tmp]",
    "opened from \"/private/var/folders/data\"",
    "opened from `/root/private/data`",
    "opened from `/var/tmp/private/data`",
    "opened from `C:\\Users\\marcos\\private`",
    "opened from [\\\\server\\share\\private]",
    "opened from FiLe:///Users/marcos/private",
  ]) {
    const input = artifactInput();
    input.evaluation.deltas[0]!.summary = leakedPath;

    assert.throws(
      () => buildGateArtifact(input),
      /findings\[0\]\.summary.*caminho absoluto local/,
      leakedPath,
    );
  }
});

test("allows normal routes and conceptual security evidence", () => {
  const input = artifactInput();
  input.evaluation.deltas[0]!.summary = [
    "Unauthenticated GET /api/users",
    "conceptual /etc/passwd evidence",
    "normal GET /tmpfiles/list route",
    "Bearer token authentication bypass",
  ].join("; ");

  const artifact = buildGateArtifact(input);

  assert.equal(artifact.findings[0]?.summary, input.evaluation.deltas[0]!.summary);
});

test("distinguishes short Bearer secrets from conceptual Bearer evidence", () => {
  const leaked = artifactInput();
  leaked.evaluation.deltas[0]!.summary = "Authorization failed with Bearer s3crt";
  assert.throws(
    () => buildGateArtifact(leaked),
    /findings\[0\]\.summary.*possível segredo/,
  );

  for (const conceptual of [
    "Bearer token-based authentication",
    "Bearer authentication-header bypass",
  ]) {
    const allowed = artifactInput();
    allowed.evaluation.deltas[0]!.summary = conceptual;
    assert.equal(buildGateArtifact(allowed).findings[0]?.summary, conceptual);
  }

  const { evaluation: _evaluation, ...envelope } = artifactInput();
  const operational = buildOperationalErrorArtifact({
    ...envelope,
    operationalSummary: "Bearer s3crt; Bearer token-based authentication; Bearer authentication-header bypass",
  });
  assert.equal(operational.decision.summary.includes("s3crt"), false);
  assert.equal(operational.decision.summary.includes("Bearer token-based authentication"), true);
  assert.equal(operational.decision.summary.includes("Bearer authentication-header bypass"), true);
});

test("rejects and fully redacts quoted multiword secret assignments", () => {
  const leaked = artifactInput();
  leaked.evaluation.deltas[0]!.summary = 'DATABASE_PASSWORD="correct horse battery staple"';
  assert.throws(
    () => buildGateArtifact(leaked),
    /findings\[0\]\.summary.*possível segredo/,
  );

  const { evaluation: _evaluation, ...envelope } = artifactInput();
  const operational = buildOperationalErrorArtifact({
    ...envelope,
    operationalSummary: 'scanner failed with DATABASE_PASSWORD="correct horse battery staple" after startup',
  });
  for (const fragment of ["correct", "horse", "battery", "staple"]) {
    assert.equal(operational.decision.summary.includes(fragment), false);
  }
  assert.equal(operational.decision.summary.includes("after startup"), true);
});

test("rejects and redacts an exact Linux home directory", () => {
  const leaked = artifactInput();
  leaked.evaluation.deltas[0]!.summary = "opened from /home/marcos";
  assert.throws(
    () => buildGateArtifact(leaked),
    /findings\[0\]\.summary.*caminho absoluto local/,
  );

  const { evaluation: _evaluation, ...envelope } = artifactInput();
  const operational = buildOperationalErrorArtifact({
    ...envelope,
    operationalSummary: "opened from /home/marcos",
  });
  assert.equal(operational.decision.summary.includes("/home/marcos"), false);
});

test("keeps path-typed fields strictly repository-relative", () => {
  const absoluteRoute = artifactInput();
  absoluteRoute.evaluation.deltas[0]!.primaryPath = "/api/users";
  assert.throws(() => buildGateArtifact(absoluteRoute), /primaryPath.*relativo ao repositório/);

  const traversal = artifactInput();
  traversal.changeSet.files[0]!.path = "../outside.ts";
  assert.throws(() => buildGateArtifact(traversal), /files\[0\]\.path.*relativo ao repositório/);

  const homeRelative = artifactInput();
  homeRelative.changeSet.scanPaths[0] = "~/.ssh/id_ed25519";
  assert.throws(() => buildGateArtifact(homeRelative), /scanPaths\[0\].*relativo ao repositório/);

  const remoteUrl = artifactInput();
  remoteUrl.changeSet.files[0]!.path = "https://example.com/source.ts";
  assert.throws(() => buildGateArtifact(remoteUrl), /files\[0\]\.path.*relativo ao repositório/);
});

test("requires publishable repository and commit identities", () => {
  assert.throws(
    () => buildGateArtifact({ ...artifactInput(), repository: { ...artifactInput().repository, key: " " } }),
    /repository\.key/,
  );
  assert.throws(
    () => buildGateArtifact({ ...artifactInput(), repository: { ...artifactInput().repository, name: "" } }),
    /repository\.name/,
  );
  assert.throws(
    () => buildGateArtifact({ ...artifactInput(), changeSet: { ...changeSet(), baseSha: "" } }),
    /changeSet\.baseSha/,
  );
  assert.throws(
    () => buildGateArtifact({ ...artifactInput(), changeSet: { ...changeSet(), headSha: " " } }),
    /changeSet\.headSha/,
  );
});

test("creates an action_required artifact for an operational failure", () => {
  const { evaluation: _evaluation, ...envelope } = artifactInput();
  const artifact = buildOperationalErrorArtifact({
    ...envelope,
    operationalSummary: "scanner unavailable",
  });

  assert.equal(artifact.decision.outcome, "error");
  assert.equal(artifact.decision.githubConclusion, "action_required");
  assert.equal(artifact.decision.decisionGraph.nodes.at(-1)?.value, "ERROR");
  assert.deepEqual(artifact.findings, []);
});

test("sanitizes operational details before publication", () => {
  const { evaluation: _evaluation, ...envelope } = artifactInput();
  const artifact = buildOperationalErrorArtifact({
    ...envelope,
    operationalSummary: " scanner\nfailed at /Users/marcos/private/repo and /tmp token=top-secret-value Authorization=Bearer bearer-secret ",
  });
  const serialized = JSON.stringify(artifact);

  assert.equal(serialized.includes("/Users/"), false);
  assert.equal(serialized.includes("/tmp"), false);
  assert.equal(serialized.includes("top-secret-value"), false);
  assert.equal(serialized.includes("bearer-secret"), false);
  assert.equal(artifact.decision.summary.includes("\n"), false);
});

test("sanitizes operational bypass forms without publishing evidence", () => {
  const { evaluation: _evaluation, ...envelope } = artifactInput();
  const secrets = [
    "aB3dE5fG7hJ9kL2m",
    `ghp_${"a".repeat(36)}`,
    `sk-proj-${"b".repeat(32)}`,
    "named-secret",
    "env-secret-value",
  ];
  const artifact = buildOperationalErrorArtifact({
    ...envelope,
    operationalSummary: [
      "Bearer aB3dE5fG7hJ9kL2m",
      secrets[1],
      secrets[2],
      "token = named-secret",
      "OPENAI_API_KEY = env-secret-value",
      " FiLe:///Users/marcos/private",
      " C:\\Users\\marcos\\private",
      " \\\\server\\share\\private",
      " leaked [`/Users/marcos/bracketed`]",
    ].join(" | "),
  });
  const serialized = JSON.stringify(artifact);

  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.toLowerCase().includes("file://"), false);
  assert.equal(serialized.includes("C:\\Users"), false);
  assert.equal(serialized.includes("\\\\server\\share"), false);
});

test("preserves conceptual routes and Bearer evidence in operational summaries", () => {
  const { evaluation: _evaluation, ...envelope } = artifactInput();
  const summary = "Unauthenticated GET /api/users; conceptual /etc/passwd; GET /tmpfiles/list; Bearer token authentication bypass";

  const artifact = buildOperationalErrorArtifact({ ...envelope, operationalSummary: summary });

  assert.equal(artifact.decision.summary, summary);
});

test("rejects pass without a baseline for a changed diff", () => {
  const input = passInput();
  input.baselineCommit = null;

  assert.throws(() => buildGateArtifact(input), /baselineCommit/);
});

test("rejects pass with blocking rows", () => {
  const input = artifactInput();
  input.evaluation.decision.outcome = "pass";
  input.evaluation.decision.githubConclusion = "success";

  assert.throws(() => buildGateArtifact(input), /violations/);
});

test("rejects a non-block decision in violations", () => {
  const input = artifactInput();
  input.evaluation.decision.violations[0]!.decision = "review";

  assert.throws(() => buildGateArtifact(input), /violations\[0\].decision.*block/);
});

test("rejects a failed scan with a pass decision", () => {
  const input = passInput();
  input.scan.status = "failed";

  assert.throws(() => buildGateArtifact(input), /scan\.status.*error/);
});

test("preserves bootstrap and no_changes baseline semantics", () => {
  const bootstrap = bootstrapInput();
  bootstrap.baselineCommit = "unexpected-baseline";
  assert.throws(() => buildGateArtifact(bootstrap), /bootstrap.*baselineCommit/);
  bootstrap.baselineCommit = null;
  assert.equal(buildGateArtifact(bootstrap).decision.outcome, "bootstrap");

  assert.equal(buildGateArtifact(noChangesInput()).decision.outcome, "no_changes");
  assert.equal(buildGateArtifact(noChangesInput("previous-baseline")).baselineCommit, "previous-baseline");
});

test("requires a completed identified scan for every conclusive security outcome", () => {
  const factories: Array<() => BuildGateArtifactInput> = [
    bootstrapInput,
    passInput,
    warningInput,
    artifactInput,
  ];
  const invalidScans: Array<{ id: string | null; status: string }> = [
    { id: null, status: "completed" },
    { id: "scan-current", status: "running" },
    { id: "scan-current", status: "cancelled" },
    { id: "scan-current", status: "incomplete" },
    { id: "scan-current", status: "failed" },
    { id: "scan-current", status: "error" },
    { id: "scan-current", status: "not_run" },
  ];

  for (const factory of factories) {
    for (const invalidScan of invalidScans) {
      const input = factory();
      input.scan.id = invalidScan.id;
      input.scan.status = invalidScan.status;
      assert.throws(
        () => buildGateArtifact(input),
        /GateArtifact\.scan\.(?:id|status)/,
        `${input.evaluation.decision.outcome}/${invalidScan.id}/${invalidScan.status}`,
      );
    }
  }
});

test("requires canonical not_run scan evidence for no_changes", () => {
  const withScanId = noChangesInput();
  withScanId.scan.id = "scan-unexpected";
  assert.throws(() => buildGateArtifact(withScanId), /scan\.id/);

  const withCost = noChangesInput();
  withCost.scan.cost = artifactInput().scan.cost;
  assert.throws(() => buildGateArtifact(withCost), /scan\.cost/);

  const completed = noChangesInput();
  completed.scan.status = "completed";
  assert.throws(() => buildGateArtifact(completed), /scan\.status.*not_run/);
});

test("allows operational errors with failed or incomplete scan state", () => {
  for (const status of ["failed", "incomplete"]) {
    const { evaluation: _evaluation, ...envelope } = artifactInput();
    envelope.scan.status = status;
    const artifact = buildOperationalErrorArtifact({
      ...envelope,
      operationalSummary: "scanner unavailable",
    });
    assert.equal(artifact.decision.outcome, "error");
    assert.equal(artifact.scan.status, status);
  }
});

test("enforces evaluator-canonical outcomes for empty and non-empty diffs", () => {
  const emptyPass = passInput();
  emptyPass.changeSet = { ...changeSet(), files: [], scanPaths: [] };
  assert.throws(() => buildGateArtifact(emptyPass), /empty diff.*no_changes/);

  const emptyBootstrap = bootstrapInput();
  emptyBootstrap.changeSet = { ...changeSet(), files: [], scanPaths: [] };
  assert.throws(() => buildGateArtifact(emptyBootstrap), /empty diff.*no_changes/);

  const changedNoChanges = noChangesInput();
  changedNoChanges.changeSet = changeSet();
  assert.throws(() => buildGateArtifact(changedNoChanges), /no_changes.*changeset vazio/);
});

test("requires every bootstrap finding lifecycle to be new", () => {
  for (const lifecycle of ["persistent", "reopened", "fixed"] as const) {
    const input = bootstrapInput();
    input.evaluation.deltas[0]!.lifecycle = lifecycle;
    assert.throws(
      () => buildGateArtifact(input),
      /findings\[0\]\.lifecycle.*bootstrap.*new/,
      lifecycle,
    );
  }
});

test("validates decision row rule indexes, decisions and finding coverage", () => {
  const outOfRange = artifactInput();
  outOfRange.evaluation.decision.violations[0]!.ruleIndex = 99;
  assert.throws(() => buildGateArtifact(outOfRange), /ruleIndex.*policy\.rules/);

  const violationOnReviewRule = artifactInput();
  violationOnReviewRule.evaluation.decision.violations[0]!.ruleIndex = 2;
  assert.throws(() => buildGateArtifact(violationOnReviewRule), /violations\[0\].*regra block/);

  const warningOnBlockRule = warningInput();
  warningOnBlockRule.evaluation.decision.warnings[0]!.ruleIndex = 1;
  assert.throws(() => buildGateArtifact(warningOnBlockRule), /warnings\[0\].*regra review/);

  const severityMismatch = artifactInput();
  severityMismatch.evaluation.decision.violations[0]!.ruleIndex = 0;
  assert.throws(() => buildGateArtifact(severityMismatch), /violations\[0\].*severity/);

  const lifecycleMismatch = warningInput();
  lifecycleMismatch.policy.rules[2]!.lifecycle = ["new"];
  assert.throws(() => buildGateArtifact(lifecycleMismatch), /warnings\[0\].*lifecycle/);
});

test("parser enforces decision row policy references", () => {
  const artifact = structuredClone(buildGateArtifact(artifactInput()));
  artifact.decision.violations[0]!.ruleIndex = 2;
  const decision = {
    outcome: artifact.decision.outcome,
    summary: artifact.decision.summary,
    violations: artifact.decision.violations,
    warnings: artifact.decision.warnings,
    exceptionsApplied: artifact.decision.exceptionsApplied,
    githubConclusion: artifact.decision.githubConclusion,
  };
  artifact.decision.decisionGraph = buildDecisionGraph(artifact.changeSet, artifact.findings, decision);

  assert.throws(() => parseGateArtifact(artifact), /violations\[0\].*regra block/);
});

test("parses a complete schema v1 artifact", () => {
  const artifact = buildGateArtifact(artifactInput());

  assert.deepEqual(parseGateArtifact(structuredClone(artifact)), artifact);
});

test("rejects an artifact from a future schema", () => {
  assert.throws(
    () => parseGateArtifact({ ...buildGateArtifact(artifactInput()), schemaVersion: 3 }),
    /GateArtifact schema 3 não suportado/,
  );
});

test("rejects malformed graph nodes and selections", () => {
  const malformedKind = cloneArtifact();
  const kindDecision = malformedKind.decision as Record<string, unknown>;
  const kindGraph = kindDecision.decisionGraph as Record<string, unknown>;
  const kindNodes = kindGraph.nodes as Array<Record<string, unknown>>;
  kindNodes[1]!.kind = "dependency";
  assert.throws(() => parseGateArtifact(malformedKind), /decisionGraph/);

  const malformedSelection = cloneArtifact();
  const selectionDecision = malformedSelection.decision as Record<string, unknown>;
  const selectionGraph = selectionDecision.decisionGraph as Record<string, unknown>;
  selectionGraph.selectedNodeId = "missing";
  assert.throws(() => parseGateArtifact(malformedSelection), /selectedNodeId/);
});

test("rejects a fabricated surface in an otherwise valid graph", () => {
  const artifact = structuredClone(buildGateArtifact(artifactInput()));
  artifact.decision.decisionGraph.nodes[1]!.value = "Invented dependency surface";

  assert.throws(() => parseGateArtifact(artifact), /decisionGraph.*canônico/);
});

test("rejects a graph node pointing at the wrong existing finding", () => {
  const artifact = structuredClone(buildGateArtifact(artifactInput()));
  const second = structuredClone(artifact.findings[0]!);
  second.findingId = "finding-2";
  second.identity = "fp:sha256:second";
  second.fingerprints = ["sha256:second"];
  artifact.findings.push(second);
  artifact.decision.decisionGraph.nodes[2]!.findingIdentity = second.identity;

  assert.throws(() => parseGateArtifact(artifact), /decisionGraph.*canônico/);
});

test("rejects a graph built for a different selected rule", () => {
  const artifact = structuredClone(buildGateArtifact(artifactInput()));
  artifact.policy.rules.push({ severity: ["high"], lifecycle: ["reopened"], decision: "block" });
  artifact.decision.violations[0]!.ruleIndex = 3;

  assert.throws(() => parseGateArtifact(artifact), /decisionGraph.*canônico/);
});

test("parser enforces the same decision invariants as builders", () => {
  const passWithoutBaseline = buildGateArtifact(passInput());
  passWithoutBaseline.baselineCommit = null;
  assert.throws(() => parseGateArtifact(passWithoutBaseline), /baselineCommit/);

  const passWithBlockers = structuredClone(buildGateArtifact(artifactInput()));
  const invalidPass = {
    ...passDecision(),
    violations: passWithBlockers.decision.violations,
  };
  replaceArtifactDecision(passWithBlockers, invalidPass);
  assert.throws(() => parseGateArtifact(passWithBlockers), /violations/);

  const wrongRow = structuredClone(buildGateArtifact(artifactInput()));
  wrongRow.decision.violations[0]!.decision = "review";
  assert.throws(() => parseGateArtifact(wrongRow), /violations\[0\].decision.*block/);

  const failedPass = buildGateArtifact(passInput());
  failedPass.scan.status = "error";
  assert.throws(() => parseGateArtifact(failedPass), /scan\.status.*error/);
});

test("parser rejects unsafe strings outside path fields", () => {
  const artifact = structuredClone(buildGateArtifact(artifactInput()));
  artifact.repository.owner = " FiLe:///Users/marcos/private";

  assert.throws(() => parseGateArtifact(artifact), /repository\.owner.*caminho absoluto local/);
});

test("rejects malformed nested schema v1 fields", () => {
  const malformedChangeSet = cloneArtifact();
  const parsedChangeSet = malformedChangeSet.changeSet as Record<string, unknown>;
  const files = parsedChangeSet.files as Array<Record<string, unknown>>;
  files[0]!.status = "copied";
  assert.throws(() => parseGateArtifact(malformedChangeSet), /changeSet/);

  const malformedFinding = cloneArtifact();
  const findings = malformedFinding.findings as Array<Record<string, unknown>>;
  findings[0]!.severity = "urgent";
  assert.throws(() => parseGateArtifact(malformedFinding), /findings/);

  const malformedPolicy = cloneArtifact();
  const policy = malformedPolicy.policy as Record<string, unknown>;
  const rules = policy.rules as Array<Record<string, unknown>>;
  rules[0]!.decision = "ignore";
  assert.throws(() => parseGateArtifact(malformedPolicy), /policy/);

  const malformedCost = cloneArtifact();
  const scan = malformedCost.scan as Record<string, unknown>;
  const cost = scan.cost as Record<string, unknown>;
  cost.estimatedUsd = "free";
  assert.throws(() => parseGateArtifact(malformedCost), /scan/);
});

test("rejects unknown publishable fields and invalid timestamps", () => {
  const artifactWithPath = cloneArtifact();
  artifactWithPath.repositoryPath = "/Users/marcos/private-repository";
  assert.throws(() => parseGateArtifact(artifactWithPath), /GateArtifact/);

  const invalidTimestamp = cloneArtifact();
  invalidTimestamp.createdAt = "today";
  assert.throws(() => parseGateArtifact(invalidTimestamp), /createdAt/);
});

test("returns a GateArtifact type after runtime validation", () => {
  const parsed: GateArtifact = parseGateArtifact(buildGateArtifact(artifactInput()));
  assert.equal(parsed.gateId, "gate-1");
});
