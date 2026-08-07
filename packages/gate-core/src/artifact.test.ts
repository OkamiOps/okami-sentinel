import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChangeSet,
  GateArtifact,
  GateFindingDelta,
} from "@csb/shared";
import {
  buildDecisionGraph,
  buildGateArtifact,
  buildOperationalErrorArtifact,
  defaultGuardrailPolicy,
  parseGateArtifact,
  type BuildGateArtifactInput,
} from "./index.js";

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
  input.evaluation.decision.warnings = [{
    findingIdentity: input.evaluation.deltas[0]!.identity,
    ruleIndex: 2,
    decision: "review",
    reason: "high/persistent",
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
      mutate: (input) => { input.evaluation.deltas[0]!.summary = "Bearer s3crt"; },
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
    "s3crt",
    `ghp_${"a".repeat(36)}`,
    `sk-proj-${"b".repeat(32)}`,
    "named-secret",
  ];
  const artifact = buildOperationalErrorArtifact({
    ...envelope,
    operationalSummary: [
      "Bearer s3crt",
      secrets[1],
      secrets[2],
      "token = named-secret",
      " FiLe:///Users/marcos/private",
      " C:\\Users\\marcos\\private",
      " \\\\server\\share\\private",
    ].join(" | "),
  });
  const serialized = JSON.stringify(artifact);

  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.toLowerCase().includes("file://"), false);
  assert.equal(serialized.includes("C:\\Users"), false);
  assert.equal(serialized.includes("\\\\server\\share"), false);
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
  const bootstrap = artifactInput();
  bootstrap.evaluation.decision = {
    outcome: "bootstrap",
    summary: "Baseline initialized.",
    violations: [],
    warnings: [],
    exceptionsApplied: [],
    githubConclusion: "neutral",
  };
  assert.throws(() => buildGateArtifact(bootstrap), /bootstrap.*baselineCommit/);
  bootstrap.baselineCommit = null;
  assert.equal(buildGateArtifact(bootstrap).decision.outcome, "bootstrap");

  const noChanges = passInput();
  noChanges.changeSet = { ...changeSet(), files: [], scanPaths: [] };
  noChanges.baselineCommit = null;
  noChanges.evaluation = {
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
  assert.equal(buildGateArtifact(noChanges).decision.outcome, "no_changes");
});

test("parses a complete schema v1 artifact", () => {
  const artifact = buildGateArtifact(artifactInput());

  assert.deepEqual(parseGateArtifact(structuredClone(artifact)), artifact);
});

test("rejects an artifact from a future schema", () => {
  assert.throws(
    () => parseGateArtifact({ ...buildGateArtifact(artifactInput()), schemaVersion: 2 }),
    /GateArtifact schema 2 não suportado/,
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
  artifact.decision.violations[0]!.ruleIndex = 0;

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
