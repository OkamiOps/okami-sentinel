import type {
  ArtifactRepositoryLocator,
  ChangeSet,
  DecisionGraph,
  EffectiveScanLineage,
  GateArtifact,
  GateArtifactV1,
  GateArtifactV2,
  GateCoverageEnvelope,
  GateDecision,
  GateExecutorKind,
  GateFindingDelta,
  GateOutcome,
  GatePublicationEligibility,
  GateSource,
  GateTarget,
  GitHubConclusion,
  GuardrailException,
  GuardrailPolicy,
  ResolvedGateTarget,
  ScanCost,
  Severity,
} from "@csb/shared";
import type { EvaluateGateResult } from "./evaluate.js";
import { buildDecisionGraph } from "./decision-graph.js";
import { buildScanLineage } from "./lineage.js";

export interface PublicRepositoryIdentity {
  key: string;
  owner: string | null;
  name: string;
  defaultBranch: string;
}

interface PublicArtifactEnvelope {
  gateId: string;
  repository: PublicRepositoryIdentity;
  source: GateSource;
  changeSet: ChangeSet;
  policy: GuardrailPolicy;
  scan: GateArtifactV1["scan"];
  baselineCommit: string | null;
  versions: GateArtifactV1["versions"];
  createdAt: string;
}

export interface BuildGateArtifactInput extends PublicArtifactEnvelope {
  evaluation: EvaluateGateResult;
}

export interface BuildOperationalErrorArtifactInput extends PublicArtifactEnvelope {
  operationalSummary: string;
}

export interface PublicRepositoryIdentityV2 extends PublicRepositoryIdentity {
  id: string;
  locator: ArtifactRepositoryLocator;
}

export interface BuildGateArtifactV2Input extends Omit<PublicArtifactEnvelope, "repository"> {
  repository: PublicRepositoryIdentityV2;
  executor: GateExecutorKind;
  target: GateTarget;
  resolvedTarget: ResolvedGateTarget;
  policySource: GateArtifactV2["policySource"];
  evaluation: EvaluateGateResult;
  lineage: EffectiveScanLineage;
  coverage: GateCoverageEnvelope;
  snapshot: GateArtifactV2["snapshot"];
  workflowRun: GateArtifactV2["workflowRun"];
}

export interface BuildOperationalErrorArtifactV2Input extends Omit<BuildGateArtifactV2Input, "evaluation"> {
  operationalSummary: string;
}

const severities: readonly Severity[] = ["critical", "high", "medium", "low", "info", "unknown"];
const outcomes: readonly GateOutcome[] = ["no_changes", "bootstrap", "pass", "warning", "blocked", "error"];
const conclusions: readonly GitHubConclusion[] = ["success", "neutral", "failure", "action_required"];
const nodeKinds = ["changeset", "surface", "signal", "rule", "verdict"] as const;
const nodeIds = ["changeset", "surface", "signal", "rule", "verdict"] as const;

export function buildGateArtifact(input: BuildGateArtifactInput): GateArtifactV1 {
  const envelope = buildEnvelope(input);
  const findings = input.evaluation.deltas.map(copyFinding);
  const decisionWithoutGraph = copyEvaluatedDecision(input.evaluation.decision);
  const decision: GateDecision = {
    outcome: decisionWithoutGraph.outcome,
    summary: decisionWithoutGraph.summary,
    violations: decisionWithoutGraph.violations,
    warnings: decisionWithoutGraph.warnings,
    exceptionsApplied: decisionWithoutGraph.exceptionsApplied,
    githubConclusion: decisionWithoutGraph.githubConclusion,
    decisionGraph: copyDecisionGraph(buildDecisionGraph(envelope.changeSet, findings, decisionWithoutGraph)),
  };

  return validatedArtifact({
    schemaVersion: 1,
    gateId: envelope.gateId,
    repository: envelope.repository,
    source: envelope.source,
    changeSet: envelope.changeSet,
    policy: envelope.policy,
    scan: envelope.scan,
    baselineCommit: envelope.baselineCommit,
    findings,
    decision,
    versions: envelope.versions,
    createdAt: envelope.createdAt,
  });
}

export function buildOperationalErrorArtifact(input: BuildOperationalErrorArtifactInput): GateArtifactV1 {
  const envelope = buildEnvelope(input);
  const summary = sanitizeOperationalSummary(input.operationalSummary);
  const decisionWithoutGraph: Omit<GateDecision, "decisionGraph"> = {
    outcome: "error",
    summary,
    violations: [],
    warnings: [],
    exceptionsApplied: [],
    githubConclusion: "action_required",
  };

  return validatedArtifact({
    schemaVersion: 1,
    gateId: envelope.gateId,
    repository: envelope.repository,
    source: envelope.source,
    changeSet: envelope.changeSet,
    policy: envelope.policy,
    scan: envelope.scan,
    baselineCommit: envelope.baselineCommit,
    findings: [],
    decision: {
      outcome: decisionWithoutGraph.outcome,
      summary: decisionWithoutGraph.summary,
      violations: decisionWithoutGraph.violations,
      warnings: decisionWithoutGraph.warnings,
      exceptionsApplied: decisionWithoutGraph.exceptionsApplied,
      githubConclusion: decisionWithoutGraph.githubConclusion,
      decisionGraph: copyDecisionGraph(buildDecisionGraph(envelope.changeSet, [], decisionWithoutGraph)),
    },
    versions: envelope.versions,
    createdAt: envelope.createdAt,
  });
}

export function buildGateArtifactV2(input: BuildGateArtifactV2Input): GateArtifactV2 {
  const findings = input.evaluation.deltas.map(copyFinding);
  const decisionWithoutGraph = copyEvaluatedDecision(input.evaluation.decision);
  const changeSet = copyChangeSet(input.changeSet);
  const decision: GateDecision = {
    ...decisionWithoutGraph,
    decisionGraph: copyDecisionGraph(buildDecisionGraph(changeSet, findings, decisionWithoutGraph)),
  };
  const lineage = copyVerifiedLineage(input.lineage);
  const artifact: GateArtifactV2 = {
    schemaVersion: 2,
    gateId: input.gateId,
    repository: copyRepositoryV2(input.repository),
    source: input.source,
    executor: input.executor,
    target: copyGateTarget(input.target),
    resolvedTarget: copyResolvedTarget(input.resolvedTarget),
    policySource: input.policySource,
    publication: gatePublicationEligibility(input.policy, input.target, input.resolvedTarget),
    changeSet,
    policy: copyPolicy(input.policy),
    scan: copyScan(input.scan),
    baselineCommit: input.baselineCommit,
    findings,
    decision,
    lineage,
    coverage: copyCoverage(input.coverage),
    snapshot: {
      identity: input.snapshot.identity,
      materializerVersion: input.snapshot.materializerVersion,
    },
    workflowRun: input.workflowRun ? {
      id: input.workflowRun.id,
      attempt: input.workflowRun.attempt,
    } : null,
    versions: {
      gateCore: input.versions.gateCore,
      scanner: input.versions.scanner,
    },
    createdAt: input.createdAt,
  };
  validateGateArtifactV2(artifact);
  return artifact;
}

export function buildOperationalErrorArtifactV2(
  input: BuildOperationalErrorArtifactV2Input,
): GateArtifactV2 {
  const { operationalSummary, ...envelope } = input;
  return buildGateArtifactV2({
    ...envelope,
    evaluation: {
      deltas: [],
      decision: {
        outcome: "error",
        summary: sanitizeOperationalSummary(operationalSummary),
        violations: [],
        warnings: [],
        exceptionsApplied: [],
        githubConclusion: "action_required",
      },
    },
  });
}

export function gatePublicationEligibility(
  policy: GuardrailPolicy,
  target: GateTarget,
  resolvedTarget: ResolvedGateTarget,
): GatePublicationEligibility {
  const candidate = target.kind === "protected_branch" ? target.ref : resolvedTarget.baseRef;
  if (policy.protectedBranches.includes(candidate)) {
    return {
      eligible: true,
      protectedBranch: candidate,
      reason: "protected_branch",
    };
  }
  return {
    eligible: false,
    protectedBranch: null,
    reason: "off_policy_preflight",
  };
}

export function parseGateArtifact(value: unknown): GateArtifact {
  const schemaVersion = record(value, "GateArtifact").schemaVersion;
  if (schemaVersion === 1) {
    validateGateArtifactV1(value);
    return copyGateArtifactV1(value);
  }
  if (schemaVersion === 2) {
    validateGateArtifactV2(value);
    return structuredClone(value);
  }
  throw new Error(`GateArtifact schema ${String(schemaVersion)} não suportado`);
}

function validatedArtifact(artifact: GateArtifactV1): GateArtifactV1 {
  validateGateArtifactV1(artifact);
  return artifact;
}

function validateGateArtifactV1(value: unknown): asserts value is GateArtifactV1 {
  const artifact = record(value, "GateArtifact");
  const schemaVersion = artifact.schemaVersion;
  exactKeys(artifact, [
    "schemaVersion",
    "gateId",
    "repository",
    "source",
    "changeSet",
    "policy",
    "scan",
    "baselineCommit",
    "findings",
    "decision",
    "versions",
    "createdAt",
  ], "GateArtifact");
  equal(schemaVersion, 1, "GateArtifact.schemaVersion");
  nonEmptyString(artifact.gateId, "GateArtifact.gateId");
  validateRepository(artifact.repository);
  enumValue(artifact.source, ["local", "github"] as const, "GateArtifact.source");
  validateChangeSet(artifact.changeSet);
  validatePolicy(artifact.policy);
  validateScan(artifact.scan);
  nullableNonEmptyString(artifact.baselineCommit, "GateArtifact.baselineCommit");
  const findings = array(artifact.findings, "GateArtifact.findings");
  findings.forEach((finding, index) => validateFinding(finding, `GateArtifact.findings[${index}]`));
  validateDecision(artifact.decision, findings);
  validateVersions(artifact.versions);
  isoTimestamp(artifact.createdAt, "GateArtifact.createdAt");
  validateDecisionInvariants(value as GateArtifactV1);
  validateCanonicalDecisionGraph(value as GateArtifactV1);
}

function validateGateArtifactV2(value: unknown): asserts value is GateArtifactV2 {
  const artifact = record(value, "GateArtifact");
  exactKeys(artifact, [
    "schemaVersion",
    "gateId",
    "repository",
    "source",
    "executor",
    "target",
    "resolvedTarget",
    "policySource",
    "publication",
    "changeSet",
    "policy",
    "scan",
    "baselineCommit",
    "findings",
    "decision",
    "lineage",
    "coverage",
    "snapshot",
    "workflowRun",
    "versions",
    "createdAt",
  ], "GateArtifact");
  equal(artifact.schemaVersion, 2, "GateArtifact.schemaVersion");
  nonEmptyString(artifact.gateId, "GateArtifact.gateId");
  const source = enumValue(artifact.source, ["local", "github"] as const, "GateArtifact.source");
  validateRepositoryV2(artifact.repository, source);
  const executor = enumValue(
    artifact.executor,
    ["sentinel-managed", "github-actions"] as const,
    "GateArtifact.executor",
  );
  if (source === "local" && executor === "github-actions") {
    fail("GateArtifact.executor", "local não aceita github-actions sem origem GitHub");
  }
  const target = validateGateTarget(artifact.target);
  const resolvedTarget = validateResolvedTarget(artifact.resolvedTarget);
  const policySource = enumValue(
    artifact.policySource,
    ["base", "protected_branch"] as const,
    "GateArtifact.policySource",
  );
  validateTargetResolution(target, resolvedTarget, policySource);
  validatePolicy(artifact.policy);
  validatePublication(artifact.publication, artifact.policy as GuardrailPolicy, target, resolvedTarget);
  validateChangeSet(artifact.changeSet);
  validateChangeSetResolution(artifact.changeSet as ChangeSet, resolvedTarget);
  validateScan(artifact.scan);
  if (artifact.baselineCommit !== null) fullCommitSha(artifact.baselineCommit, "GateArtifact.baselineCommit");
  const findings = array(artifact.findings, "GateArtifact.findings");
  findings.forEach((finding, index) => validateFinding(finding, `GateArtifact.findings[${index}]`));
  validateDecision(artifact.decision, findings);
  validateLineage(artifact.lineage);
  const coverage = validateCoverage(artifact.coverage);
  validateSnapshot(artifact.snapshot);
  validateWorkflowRun(artifact.workflowRun);
  validateVersions(artifact.versions);
  isoTimestamp(artifact.createdAt, "GateArtifact.createdAt");
  validateDecisionInvariants(value as GateArtifactV2);
  validateCanonicalDecisionGraph(value as GateArtifactV2);
  const decision = (value as GateArtifactV2).decision;
  if (!coverageIsComplete(coverage) && decision.githubConclusion === "success") {
    fail("GateArtifact.coverage", `incompleta não pode publicar outcome ${decision.outcome} como success`);
  }
}

function validateRepositoryV2(value: unknown, source: GateSource): void {
  const repository = record(value, "GateArtifact.repository");
  exactKeys(repository, ["id", "key", "owner", "name", "defaultBranch", "locator"], "GateArtifact.repository");
  const id = nonEmptyString(repository.id, "GateArtifact.repository.id");
  const key = nonEmptyString(repository.key, "GateArtifact.repository.key");
  if (id !== key) fail("GateArtifact.repository.key", "deve usar a identidade estável do repositório");
  const owner = nullableString(repository.owner, "GateArtifact.repository.owner");
  const name = nonEmptyString(repository.name, "GateArtifact.repository.name");
  nonEmptyString(repository.defaultBranch, "GateArtifact.repository.defaultBranch");
  const locator = record(repository.locator, "GateArtifact.repository.locator");
  const kind = enumValue(locator.kind, ["local", "github"] as const, "GateArtifact.repository.locator.kind");
  if (kind !== source) fail("GateArtifact.repository.locator.kind", "não corresponde ao source");
  if (kind === "local") {
    exactKeys(locator, ["kind", "repositoryKey"], "GateArtifact.repository.locator");
    const repositoryKey = nonEmptyString(locator.repositoryKey, "GateArtifact.repository.locator.repositoryKey");
    if (repositoryKey !== key) fail("GateArtifact.repository.locator.repositoryKey", "não corresponde ao repository key");
    return;
  }
  exactKeys(locator, ["kind", "repositoryId", "owner", "name"], "GateArtifact.repository.locator");
  const repositoryId = nonEmptyString(locator.repositoryId, "GateArtifact.repository.locator.repositoryId");
  const locatorOwner = nonEmptyString(locator.owner, "GateArtifact.repository.locator.owner");
  const locatorName = nonEmptyString(locator.name, "GateArtifact.repository.locator.name");
  if (id !== `github:${repositoryId}`) fail("GateArtifact.repository.id", "não corresponde ao GitHub repositoryId");
  if (owner !== locatorOwner) fail("GateArtifact.repository.locator.owner", "não corresponde ao repository owner");
  if (name !== locatorName) fail("GateArtifact.repository.locator.name", "não corresponde ao repository name");
}

function validateGateTarget(value: unknown): GateTarget {
  const target = record(value, "GateArtifact.target");
  const kind = enumValue(
    target.kind,
    ["pull_request", "compare", "protected_branch"] as const,
    "GateArtifact.target.kind",
  );
  if (kind === "pull_request") {
    exactKeys(target, ["kind", "number"], "GateArtifact.target");
    return { kind, number: positiveInteger(target.number, "GateArtifact.target.number") };
  }
  if (kind === "protected_branch") {
    exactKeys(target, ["kind", "ref"], "GateArtifact.target");
    return { kind, ref: nonEmptyString(target.ref, "GateArtifact.target.ref") };
  }
  exactKeys(target, ["kind", "baseRef", "headRef"], "GateArtifact.target");
  return {
    kind,
    baseRef: nonEmptyString(target.baseRef, "GateArtifact.target.baseRef"),
    headRef: nonEmptyString(target.headRef, "GateArtifact.target.headRef"),
  };
}

function validateResolvedTarget(value: unknown): ResolvedGateTarget {
  const target = record(value, "GateArtifact.resolvedTarget");
  exactKeys(target, [
    "baseRef",
    "headRef",
    "baseSha",
    "headSha",
    "policySha",
    "pullRequestNumber",
  ], "GateArtifact.resolvedTarget");
  return {
    baseRef: nonEmptyString(target.baseRef, "GateArtifact.resolvedTarget.baseRef"),
    headRef: nonEmptyString(target.headRef, "GateArtifact.resolvedTarget.headRef"),
    baseSha: fullCommitSha(target.baseSha, "GateArtifact.resolvedTarget.baseSha"),
    headSha: fullCommitSha(target.headSha, "GateArtifact.resolvedTarget.headSha"),
    policySha: fullCommitSha(target.policySha, "GateArtifact.resolvedTarget.policySha"),
    pullRequestNumber: target.pullRequestNumber === null
      ? null
      : positiveInteger(target.pullRequestNumber, "GateArtifact.resolvedTarget.pullRequestNumber"),
  };
}

function validateTargetResolution(
  target: GateTarget,
  resolved: ResolvedGateTarget,
  policySource: GateArtifactV2["policySource"],
): void {
  if (target.kind === "pull_request") {
    if (resolved.pullRequestNumber !== target.number) {
      fail("GateArtifact.resolvedTarget.pullRequestNumber", "não corresponde ao pull request");
    }
  } else {
    if (resolved.pullRequestNumber !== null) {
      fail("GateArtifact.resolvedTarget.pullRequestNumber", "deve ser nulo fora de pull request");
    }
    if (target.kind === "compare" && (resolved.baseRef !== target.baseRef || resolved.headRef !== target.headRef)) {
      fail("GateArtifact.resolvedTarget", "não corresponde aos refs comparados");
    }
    if (target.kind === "protected_branch" && (resolved.baseRef !== target.ref || resolved.headRef !== target.ref)) {
      fail("GateArtifact.resolvedTarget", "não corresponde à branch protegida");
    }
  }
  if (policySource === "base" && resolved.policySha !== resolved.baseSha) {
    fail("GateArtifact.policySource", "base exige policySha igual ao baseSha");
  }
  if (
    policySource === "protected_branch"
    && (target.kind !== "protected_branch" || resolved.policySha !== resolved.headSha)
  ) {
    fail("GateArtifact.policySource", "protected_branch exige alvo e policySha protegidos");
  }
}

function validateChangeSetResolution(changeSet: ChangeSet, resolved: ResolvedGateTarget): void {
  if (
    changeSet.baseRef !== resolved.baseRef
    || changeSet.headRef !== resolved.headRef
    || changeSet.baseSha !== resolved.baseSha
    || changeSet.headSha !== resolved.headSha
  ) {
    fail("GateArtifact.changeSet", "não corresponde ao alvo resolvido");
  }
}

function validatePublication(
  value: unknown,
  policy: GuardrailPolicy,
  target: GateTarget,
  resolved: ResolvedGateTarget,
): void {
  const publication = record(value, "GateArtifact.publication");
  exactKeys(publication, ["eligible", "protectedBranch", "reason"], "GateArtifact.publication");
  const actual: GatePublicationEligibility = {
    eligible: booleanValue(publication.eligible, "GateArtifact.publication.eligible"),
    protectedBranch: nullableString(publication.protectedBranch, "GateArtifact.publication.protectedBranch"),
    reason: enumValue(
      publication.reason,
      ["protected_branch", "off_policy_preflight"] as const,
      "GateArtifact.publication.reason",
    ),
  };
  const expected = gatePublicationEligibility(policy, target, resolved);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("GateArtifact.publication", "não corresponde a protectedBranches");
  }
}

function validateLineage(value: unknown): void {
  const lineage = record(value, "GateArtifact.lineage");
  exactKeys(lineage, [
    "engine",
    "engineVersion",
    "route",
    "protocol",
    "provider",
    "model",
    "reasoningEffort",
    "methodology",
    "profile",
    "recipeHash",
    "sourceRevision",
    "scanLineageHash",
  ], "GateArtifact.lineage");
  const rebuilt = buildScanLineage({
    engine: nonEmptyString(lineage.engine, "GateArtifact.lineage.engine"),
    engineVersion: nonEmptyString(lineage.engineVersion, "GateArtifact.lineage.engineVersion"),
    route: nonEmptyString(lineage.route, "GateArtifact.lineage.route"),
    protocol: nonEmptyString(lineage.protocol, "GateArtifact.lineage.protocol"),
    provider: nonEmptyString(lineage.provider, "GateArtifact.lineage.provider"),
    model: nonEmptyString(lineage.model, "GateArtifact.lineage.model"),
    reasoningEffort: nonEmptyString(lineage.reasoningEffort, "GateArtifact.lineage.reasoningEffort"),
    methodology: nonEmptyString(lineage.methodology, "GateArtifact.lineage.methodology"),
    profile: nonEmptyString(lineage.profile, "GateArtifact.lineage.profile"),
    recipeHash: canonicalSha256(lineage.recipeHash, "GateArtifact.lineage.recipeHash"),
    sourceRevision: canonicalSha256(lineage.sourceRevision, "GateArtifact.lineage.sourceRevision"),
  });
  const actualHash = canonicalSha256(lineage.scanLineageHash, "GateArtifact.lineage.scanLineageHash");
  if (actualHash !== rebuilt.scanLineageHash) {
    fail("GateArtifact.lineage.scanLineageHash", "não corresponde à lineage efetiva");
  }
}

function validateCoverage(value: unknown): GateCoverageEnvelope {
  const coverage = record(value, "GateArtifact.coverage");
  exactKeys(coverage, [
    "status",
    "repositoryFileCount",
    "inspectedFileCount",
    "unexaminedFileCount",
    "submodules",
    "lfsPointers",
  ], "GateArtifact.coverage");
  const parsed: GateCoverageEnvelope = {
    status: enumValue(coverage.status, ["complete", "partial"] as const, "GateArtifact.coverage.status"),
    repositoryFileCount: nonNegativeInteger(coverage.repositoryFileCount, "GateArtifact.coverage.repositoryFileCount"),
    inspectedFileCount: nonNegativeInteger(coverage.inspectedFileCount, "GateArtifact.coverage.inspectedFileCount"),
    unexaminedFileCount: nonNegativeInteger(coverage.unexaminedFileCount, "GateArtifact.coverage.unexaminedFileCount"),
    submodules: stringArray(coverage.submodules, "GateArtifact.coverage.submodules"),
    lfsPointers: stringArray(coverage.lfsPointers, "GateArtifact.coverage.lfsPointers"),
  };
  parsed.submodules.forEach((entry, index) => publicPath(entry, `GateArtifact.coverage.submodules[${index}]`));
  parsed.lfsPointers.forEach((entry, index) => publicPath(entry, `GateArtifact.coverage.lfsPointers[${index}]`));
  if (parsed.inspectedFileCount + parsed.unexaminedFileCount !== parsed.repositoryFileCount) {
    fail("GateArtifact.coverage", "contagens não fecham o repositório");
  }
  if (parsed.status === "complete" && !coverageIsComplete(parsed)) {
    fail("GateArtifact.coverage", "status complete exige cobertura integral");
  }
  return parsed;
}

function coverageIsComplete(coverage: GateCoverageEnvelope): boolean {
  return coverage.status === "complete"
    && coverage.inspectedFileCount === coverage.repositoryFileCount
    && coverage.unexaminedFileCount === 0
    && coverage.submodules.length === 0
    && coverage.lfsPointers.length === 0;
}

function validateSnapshot(value: unknown): void {
  const snapshot = record(value, "GateArtifact.snapshot");
  exactKeys(snapshot, ["identity", "materializerVersion"], "GateArtifact.snapshot");
  canonicalSha256(snapshot.identity, "GateArtifact.snapshot.identity");
  nonEmptyString(snapshot.materializerVersion, "GateArtifact.snapshot.materializerVersion");
}

function validateWorkflowRun(value: unknown): void {
  if (value === null) return;
  const workflowRun = record(value, "GateArtifact.workflowRun");
  exactKeys(workflowRun, ["id", "attempt"], "GateArtifact.workflowRun");
  nonEmptyString(workflowRun.id, "GateArtifact.workflowRun.id");
  positiveInteger(workflowRun.attempt, "GateArtifact.workflowRun.attempt");
}

function buildEnvelope(input: PublicArtifactEnvelope): Omit<GateArtifactV1, "schemaVersion" | "findings" | "decision"> {
  const changeSet = copyChangeSet(input.changeSet);

  return {
    gateId: input.gateId,
    repository: {
      key: input.repository.key,
      owner: input.repository.owner,
      name: input.repository.name,
      defaultBranch: input.repository.defaultBranch,
    },
    source: input.source,
    changeSet,
    policy: copyPolicy(input.policy),
    scan: copyScan(input.scan),
    baselineCommit: input.baselineCommit,
    versions: {
      gateCore: input.versions.gateCore,
      scanner: input.versions.scanner,
    },
    createdAt: input.createdAt,
  };
}

function copyChangeSet(changeSet: ChangeSet): ChangeSet {
  return {
    baseRef: changeSet.baseRef,
    headRef: changeSet.headRef,
    baseSha: changeSet.baseSha,
    headSha: changeSet.headSha,
    files: changeSet.files.map((file) => ({
      status: file.status,
      path: file.path,
      previousPath: file.previousPath,
      additions: file.additions,
      deletions: file.deletions,
    })),
    scanPaths: [...changeSet.scanPaths],
    scopeMode: changeSet.scopeMode,
    fallbackReason: changeSet.fallbackReason,
  };
}

function copyRepositoryV2(repository: PublicRepositoryIdentityV2): GateArtifactV2["repository"] {
  return {
    id: repository.id,
    key: repository.key,
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.defaultBranch,
    locator: repository.locator.kind === "local"
      ? { kind: "local", repositoryKey: repository.locator.repositoryKey }
      : {
          kind: "github",
          repositoryId: repository.locator.repositoryId,
          owner: repository.locator.owner,
          name: repository.locator.name,
        },
  };
}

function copyGateTarget(target: GateTarget): GateTarget {
  if (target.kind === "pull_request") return { kind: "pull_request", number: target.number };
  if (target.kind === "protected_branch") return { kind: "protected_branch", ref: target.ref };
  return { kind: "compare", baseRef: target.baseRef, headRef: target.headRef };
}

function copyResolvedTarget(target: ResolvedGateTarget): ResolvedGateTarget {
  return {
    baseRef: target.baseRef,
    headRef: target.headRef,
    baseSha: target.baseSha,
    headSha: target.headSha,
    policySha: target.policySha,
    pullRequestNumber: target.pullRequestNumber,
  };
}

function copyVerifiedLineage(lineage: EffectiveScanLineage): EffectiveScanLineage {
  const rebuilt = buildScanLineage({
    engine: lineage.engine,
    engineVersion: lineage.engineVersion,
    route: lineage.route,
    protocol: lineage.protocol,
    provider: lineage.provider,
    model: lineage.model,
    reasoningEffort: lineage.reasoningEffort,
    methodology: lineage.methodology,
    profile: lineage.profile,
    recipeHash: lineage.recipeHash,
    sourceRevision: lineage.sourceRevision,
  });
  if (rebuilt.scanLineageHash !== lineage.scanLineageHash) {
    fail("GateArtifact.lineage.scanLineageHash", "não corresponde à lineage efetiva");
  }
  return rebuilt;
}

function copyCoverage(coverage: GateCoverageEnvelope): GateCoverageEnvelope {
  return {
    status: coverage.status,
    repositoryFileCount: coverage.repositoryFileCount,
    inspectedFileCount: coverage.inspectedFileCount,
    unexaminedFileCount: coverage.unexaminedFileCount,
    submodules: [...coverage.submodules],
    lfsPointers: [...coverage.lfsPointers],
  };
}

function copyPolicy(policy: GuardrailPolicy): GuardrailPolicy {
  return {
    schemaVersion: 1,
    protectedBranches: [...policy.protectedBranches],
    scope: {
      mode: policy.scope.mode,
      maxChangedPaths: policy.scope.maxChangedPaths,
      fallback: policy.scope.fallback,
    },
    scan: {
      model: policy.scan.model,
      effort: policy.scan.effort,
      mode: policy.scan.mode,
      maxCostUsd: policy.scan.maxCostUsd,
    },
    rules: policy.rules.map((rule) => ({
      severity: [...rule.severity],
      lifecycle: [...rule.lifecycle],
      decision: rule.decision,
    })),
  };
}

function copyScan(scan: GateArtifact["scan"]): GateArtifact["scan"] {
  return {
    id: scan.id,
    cost: scan.cost ? copyScanCost(scan.cost) : null,
    status: scan.status,
  };
}

function copyScanCost(cost: ScanCost): ScanCost {
  const copied: ScanCost = {
    estimatedUsd: cost.estimatedUsd,
    inputTokens: cost.inputTokens,
    cachedInputTokens: cost.cachedInputTokens,
    cacheWriteInputTokens: cost.cacheWriteInputTokens,
    outputTokens: cost.outputTokens,
  };
  if (cost.model !== undefined) copied.model = cost.model;
  return copied;
}

function copyFinding(finding: GateFindingDelta): GateFindingDelta {
  return {
    findingId: finding.findingId,
    occurrenceId: finding.occurrenceId,
    title: finding.title,
    severity: finding.severity,
    confidence: finding.confidence,
    ruleId: finding.ruleId,
    summary: finding.summary,
    primaryPath: finding.primaryPath,
    fingerprints: [...finding.fingerprints],
    category: finding.category,
    cwe: [...finding.cwe],
    identity: finding.identity,
    lifecycle: finding.lifecycle,
    triage: {
      status: finding.triage.status,
      note: finding.triage.note,
      updatedAt: finding.triage.updatedAt,
    },
    exception: finding.exception ? copyException(finding.exception) : null,
    sourceScanId: finding.sourceScanId,
  };
}

function copyException(exception: GuardrailException): GuardrailException {
  return {
    findingIdentity: exception.findingIdentity,
    reason: exception.reason,
    owner: exception.owner,
    createdAt: exception.createdAt,
    expiresAt: exception.expiresAt,
    branches: [...exception.branches],
    ruleIndexes: [...exception.ruleIndexes],
  };
}

function copyEvaluatedDecision(decision: EvaluateGateResult["decision"]): EvaluateGateResult["decision"] {
  return {
    outcome: decision.outcome,
    summary: decision.summary,
    violations: decision.violations.map(copyViolation),
    warnings: decision.warnings.map(copyViolation),
    exceptionsApplied: [...decision.exceptionsApplied],
    githubConclusion: decision.githubConclusion,
  };
}

function copyViolation(violation: GateDecision["violations"][number]): GateDecision["violations"][number] {
  return {
    findingIdentity: violation.findingIdentity,
    ruleIndex: violation.ruleIndex,
    decision: violation.decision,
    reason: violation.reason,
  };
}

function copyDecisionGraph(graph: DecisionGraph): DecisionGraph {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      value: node.value,
      detail: node.detail,
      tone: node.tone,
      findingIdentity: node.findingIdentity,
    })),
    selectedNodeId: graph.selectedNodeId,
  };
}

function copyGateArtifactV1(artifact: GateArtifactV1): GateArtifactV1 {
  return {
    schemaVersion: 1,
    gateId: artifact.gateId,
    repository: {
      key: artifact.repository.key,
      owner: artifact.repository.owner,
      name: artifact.repository.name,
      defaultBranch: artifact.repository.defaultBranch,
    },
    source: artifact.source,
    changeSet: copyChangeSet(artifact.changeSet),
    policy: copyPolicy(artifact.policy),
    scan: copyScan(artifact.scan),
    baselineCommit: artifact.baselineCommit,
    findings: artifact.findings.map(copyFinding),
    decision: {
      outcome: artifact.decision.outcome,
      summary: artifact.decision.summary,
      violations: artifact.decision.violations.map(copyViolation),
      warnings: artifact.decision.warnings.map(copyViolation),
      exceptionsApplied: [...artifact.decision.exceptionsApplied],
      githubConclusion: artifact.decision.githubConclusion,
      decisionGraph: copyDecisionGraph(artifact.decision.decisionGraph),
    },
    versions: {
      gateCore: artifact.versions.gateCore,
      scanner: artifact.versions.scanner,
    },
    createdAt: artifact.createdAt,
  };
}

function sanitizeOperationalSummary(value: string): string {
  let normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ");
  normalized = redactSecretAssignments(normalized);
  normalized = redactBearerCredentials(normalized)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, "[REDACTED]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED]")
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gi, "[REDACTED]")
    .replace(/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/gi, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]");
  normalized = redactLocalHostPaths(normalized)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return normalized || "Falha operacional.";
}

function redactSecretAssignments(value: string): string {
  return value
    .replace(
      /(^|[^A-Za-z0-9_])(?:[A-Za-z0-9]+_)*(?:SECRET_ACCESS_KEY|API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;|]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:authorization|api[- ]?key|token|secret|password)\s*[:=]\s*(?:bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;|]+)/gi,
      "[REDACTED]",
    );
}

function redactBearerCredentials(value: string): string {
  return value.replace(/\bbearer\s+([^\s,;|]+)/gi, (match, candidate: string) => (
    isCredentialLikeBearerValue(candidate) ? "[REDACTED]" : match
  ));
}

function redactLocalHostPaths(value: string): string {
  return value
    .replace(/file:\/\/[^\s,;|\]})>`'"]*/gi, "[LOCAL_PATH]")
    .replace(/(^|[\s"'`\[({=,:])\\\\[^\\/\s,;|\]})>`'"]+[\\/][^\s,;|\]})>`'"]*/g, "$1[LOCAL_PATH]")
    .replace(/(^|[\s"'`\[({=,:])[A-Za-z]:[\\/][^\s,;|\]})>`'"]*/g, "$1[LOCAL_PATH]")
    .replace(
      /(^|[\s"'`\[({=,:])\/(?:Users|tmp|private|root|var\/folders|var\/tmp)(?=\/|[\s,;|\]})>`'"]|$)(?:\/[^\s,;|\]})>`'"]*)?/g,
      "$1[LOCAL_PATH]",
    )
    .replace(/(^|[\s"'`\[({=,:])\/home\/[^/\s,;|\]})>`'"]+(?:\/[^\s,;|\]})>`'"]*)?/g, "$1[LOCAL_PATH]");
}

function validateRepository(value: unknown): void {
  const repository = record(value, "GateArtifact.repository");
  exactKeys(repository, ["key", "owner", "name", "defaultBranch"], "GateArtifact.repository");
  nonEmptyString(repository.key, "GateArtifact.repository.key");
  nullableString(repository.owner, "GateArtifact.repository.owner");
  nonEmptyString(repository.name, "GateArtifact.repository.name");
  nonEmptyString(repository.defaultBranch, "GateArtifact.repository.defaultBranch");
}

function validateChangeSet(value: unknown): void {
  const changeSet = record(value, "GateArtifact.changeSet");
  exactKeys(changeSet, [
    "baseRef",
    "headRef",
    "baseSha",
    "headSha",
    "files",
    "scanPaths",
    "scopeMode",
    "fallbackReason",
  ], "GateArtifact.changeSet");
  string(changeSet.baseRef, "GateArtifact.changeSet.baseRef");
  string(changeSet.headRef, "GateArtifact.changeSet.headRef");
  nonEmptyString(changeSet.baseSha, "GateArtifact.changeSet.baseSha");
  nonEmptyString(changeSet.headSha, "GateArtifact.changeSet.headSha");
  const files = array(changeSet.files, "GateArtifact.changeSet.files");
  files.forEach((value, index) => {
    const file = record(value, `GateArtifact.changeSet.files[${index}]`);
    exactKeys(file, ["status", "path", "previousPath", "additions", "deletions"], `GateArtifact.changeSet.files[${index}]`);
    enumValue(file.status, ["added", "modified", "renamed", "deleted"] as const, `GateArtifact.changeSet.files[${index}].status`);
    publicPath(file.path, `GateArtifact.changeSet.files[${index}].path`);
    nullablePublicPath(file.previousPath, `GateArtifact.changeSet.files[${index}].previousPath`);
    nullableNonNegativeInteger(file.additions, `GateArtifact.changeSet.files[${index}].additions`);
    nullableNonNegativeInteger(file.deletions, `GateArtifact.changeSet.files[${index}].deletions`);
  });
  stringArray(changeSet.scanPaths, "GateArtifact.changeSet.scanPaths").forEach((path, index) => {
    publicPath(path, `GateArtifact.changeSet.scanPaths[${index}]`);
  });
  enumValue(changeSet.scopeMode, ["changed", "repository"] as const, "GateArtifact.changeSet.scopeMode");
  nullableString(changeSet.fallbackReason, "GateArtifact.changeSet.fallbackReason");
}

function validatePolicy(value: unknown): void {
  const policy = record(value, "GateArtifact.policy");
  exactKeys(policy, ["schemaVersion", "protectedBranches", "scope", "scan", "rules"], "GateArtifact.policy");
  equal(policy.schemaVersion, 1, "GateArtifact.policy.schemaVersion");
  stringArray(policy.protectedBranches, "GateArtifact.policy.protectedBranches");

  const scope = record(policy.scope, "GateArtifact.policy.scope");
  exactKeys(scope, ["mode", "maxChangedPaths", "fallback"], "GateArtifact.policy.scope");
  enumValue(scope.mode, ["changed", "repository"] as const, "GateArtifact.policy.scope.mode");
  nonNegativeInteger(scope.maxChangedPaths, "GateArtifact.policy.scope.maxChangedPaths");
  enumValue(scope.fallback, ["repository", "error"] as const, "GateArtifact.policy.scope.fallback");

  const scan = record(policy.scan, "GateArtifact.policy.scan");
  exactKeys(scan, ["model", "effort", "mode", "maxCostUsd"], "GateArtifact.policy.scan");
  nonEmptyString(scan.model, "GateArtifact.policy.scan.model");
  nonEmptyString(scan.effort, "GateArtifact.policy.scan.effort");
  enumValue(scan.mode, ["standard", "deep"] as const, "GateArtifact.policy.scan.mode");
  nonNegativeNumber(scan.maxCostUsd, "GateArtifact.policy.scan.maxCostUsd");

  const rules = array(policy.rules, "GateArtifact.policy.rules");
  rules.forEach((value, index) => {
    const rule = record(value, `GateArtifact.policy.rules[${index}]`);
    exactKeys(rule, ["severity", "lifecycle", "decision"], `GateArtifact.policy.rules[${index}]`);
    const severity = array(rule.severity, `GateArtifact.policy.rules[${index}].severity`);
    severity.forEach((entry, entryIndex) => enumValue(entry, severities, `GateArtifact.policy.rules[${index}].severity[${entryIndex}]`));
    const lifecycle = array(rule.lifecycle, `GateArtifact.policy.rules[${index}].lifecycle`);
    lifecycle.forEach((entry, entryIndex) => enumValue(entry, ["new", "reopened", "persistent", "fixed"] as const, `GateArtifact.policy.rules[${index}].lifecycle[${entryIndex}]`));
    enumValue(rule.decision, ["block", "review"] as const, `GateArtifact.policy.rules[${index}].decision`);
  });
}

function validateScan(value: unknown): void {
  const scan = record(value, "GateArtifact.scan");
  exactKeys(scan, ["id", "cost", "status"], "GateArtifact.scan");
  nullableString(scan.id, "GateArtifact.scan.id");
  nonEmptyString(scan.status, "GateArtifact.scan.status");
  if (scan.cost === null) return;
  const cost = record(scan.cost, "GateArtifact.scan.cost");
  exactKeys(cost, [
    "estimatedUsd",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
  ], "GateArtifact.scan.cost", ["model"]);
  nonNegativeNumber(cost.estimatedUsd, "GateArtifact.scan.cost.estimatedUsd");
  nonNegativeInteger(cost.inputTokens, "GateArtifact.scan.cost.inputTokens");
  nonNegativeInteger(cost.cachedInputTokens, "GateArtifact.scan.cost.cachedInputTokens");
  nonNegativeInteger(cost.cacheWriteInputTokens, "GateArtifact.scan.cost.cacheWriteInputTokens");
  nonNegativeInteger(cost.outputTokens, "GateArtifact.scan.cost.outputTokens");
  if ("model" in cost) nonEmptyString(cost.model, "GateArtifact.scan.cost.model");
}

function validateFinding(value: unknown, path: string): void {
  const finding = record(value, path);
  exactKeys(finding, [
    "findingId",
    "occurrenceId",
    "title",
    "severity",
    "confidence",
    "ruleId",
    "summary",
    "primaryPath",
    "fingerprints",
    "category",
    "cwe",
    "identity",
    "lifecycle",
    "triage",
    "exception",
    "sourceScanId",
  ], path);
  nonEmptyString(finding.findingId, `${path}.findingId`);
  nullableString(finding.occurrenceId, `${path}.occurrenceId`);
  nonEmptyString(finding.title, `${path}.title`);
  enumValue(finding.severity, severities, `${path}.severity`);
  nullableString(finding.confidence, `${path}.confidence`);
  nullableString(finding.ruleId, `${path}.ruleId`);
  nullableString(finding.summary, `${path}.summary`);
  nullablePublicPath(finding.primaryPath, `${path}.primaryPath`);
  stringArray(finding.fingerprints, `${path}.fingerprints`);
  nullableString(finding.category, `${path}.category`);
  stringArray(finding.cwe, `${path}.cwe`);
  nonEmptyString(finding.identity, `${path}.identity`);
  enumValue(finding.lifecycle, ["new", "reopened", "persistent", "fixed"] as const, `${path}.lifecycle`);
  validateTriage(finding.triage, `${path}.triage`);
  if (finding.exception !== null) validateException(finding.exception, `${path}.exception`);
  nonEmptyString(finding.sourceScanId, `${path}.sourceScanId`);
}

function validateTriage(value: unknown, path: string): void {
  const triage = record(value, path);
  exactKeys(triage, ["status", "note", "updatedAt"], path);
  enumValue(triage.status, ["unreviewed", "confirmed", "accepted", "false_positive"] as const, `${path}.status`);
  nullableString(triage.note, `${path}.note`);
  nullableIsoTimestamp(triage.updatedAt, `${path}.updatedAt`);
}

function validateException(value: unknown, path: string): void {
  const exception = record(value, path);
  exactKeys(exception, [
    "findingIdentity",
    "reason",
    "owner",
    "createdAt",
    "expiresAt",
    "branches",
    "ruleIndexes",
  ], path);
  nonEmptyString(exception.findingIdentity, `${path}.findingIdentity`);
  nonEmptyString(exception.reason, `${path}.reason`);
  nonEmptyString(exception.owner, `${path}.owner`);
  isoTimestamp(exception.createdAt, `${path}.createdAt`);
  isoTimestamp(exception.expiresAt, `${path}.expiresAt`);
  stringArray(exception.branches, `${path}.branches`);
  const ruleIndexes = array(exception.ruleIndexes, `${path}.ruleIndexes`);
  ruleIndexes.forEach((index, position) => nonNegativeInteger(index, `${path}.ruleIndexes[${position}]`));
}

function validateDecision(value: unknown, findings: unknown[]): void {
  const decision = record(value, "GateArtifact.decision");
  exactKeys(decision, [
    "outcome",
    "summary",
    "violations",
    "warnings",
    "exceptionsApplied",
    "githubConclusion",
    "decisionGraph",
  ], "GateArtifact.decision");
  const outcome = enumValue(decision.outcome, outcomes, "GateArtifact.decision.outcome");
  nonEmptyString(decision.summary, "GateArtifact.decision.summary");
  const findingIdentities = new Set(findings.map((value) => (value as Record<string, unknown>).identity as string));
  validateViolations(decision.violations, "GateArtifact.decision.violations", findingIdentities);
  validateViolations(decision.warnings, "GateArtifact.decision.warnings", findingIdentities);
  stringArray(decision.exceptionsApplied, "GateArtifact.decision.exceptionsApplied");
  const conclusion = enumValue(decision.githubConclusion, conclusions, "GateArtifact.decision.githubConclusion");
  if (conclusion !== expectedConclusion(outcome)) {
    fail("GateArtifact.decision.githubConclusion", "não corresponde ao outcome");
  }
  validateDecisionGraph(decision.decisionGraph, findingIdentities, outcome);
}

function validateViolations(value: unknown, path: string, findingIdentities: Set<string>): void {
  const violations = array(value, path);
  violations.forEach((value, index) => {
    const violation = record(value, `${path}[${index}]`);
    exactKeys(violation, ["findingIdentity", "ruleIndex", "decision", "reason"], `${path}[${index}]`);
    const identity = nonEmptyString(violation.findingIdentity, `${path}[${index}].findingIdentity`);
    if (!findingIdentities.has(identity)) fail(`${path}[${index}].findingIdentity`, "não referencia um finding");
    nonNegativeInteger(violation.ruleIndex, `${path}[${index}].ruleIndex`);
    enumValue(violation.decision, ["block", "review"] as const, `${path}[${index}].decision`);
    nonEmptyString(violation.reason, `${path}[${index}].reason`);
  });
}

function validateDecisionGraph(value: unknown, findingIdentities: Set<string>, outcome: GateOutcome): void {
  const graph = record(value, "GateArtifact.decision.decisionGraph");
  exactKeys(graph, ["nodes", "selectedNodeId"], "GateArtifact.decision.decisionGraph");
  const nodes = array(graph.nodes, "GateArtifact.decision.decisionGraph.nodes");
  if (nodes.length !== 5) fail("GateArtifact.decision.decisionGraph.nodes", "deve conter exatamente cinco nós");
  nodes.forEach((value, index) => {
    const path = `GateArtifact.decision.decisionGraph.nodes[${index}]`;
    const node = record(value, path);
    exactKeys(node, ["id", "kind", "label", "value", "detail", "tone", "findingIdentity"], path);
    equal(node.id, nodeIds[index], `${path}.id`);
    equal(node.kind, nodeKinds[index], `${path}.kind`);
    nonEmptyString(node.label, `${path}.label`);
    nonEmptyString(node.value, `${path}.value`);
    nullableString(node.detail, `${path}.detail`);
    enumValue(node.tone, ["neutral", "good", "warning", "risk"] as const, `${path}.tone`);
    const identity = nullableString(node.findingIdentity, `${path}.findingIdentity`);
    if (identity !== null && !findingIdentities.has(identity)) fail(`${path}.findingIdentity`, "não referencia um finding");
  });
  const selectedNodeId = nonEmptyString(graph.selectedNodeId, "GateArtifact.decision.decisionGraph.selectedNodeId");
  if (!nodeIds.includes(selectedNodeId as typeof nodeIds[number])) {
    fail("GateArtifact.decision.decisionGraph.selectedNodeId", "não referencia um nó");
  }
  const verdict = nodes[4] as Record<string, unknown>;
  equal(verdict.value, outcome.toUpperCase(), "GateArtifact.decision.decisionGraph.nodes[4].value");
}

function validateDecisionInvariants(artifact: GateArtifact): void {
  const { decision } = artifact;

  decision.violations.forEach((row, index) => {
    if (row.decision !== "block") {
      fail(`GateArtifact.decision.violations[${index}].decision`, "deve ser block");
    }
  });
  decision.warnings.forEach((row, index) => {
    if (row.decision !== "review") {
      fail(`GateArtifact.decision.warnings[${index}].decision`, "deve ser review");
    }
  });
  validateDecisionRuleReferences(artifact, decision.violations, "violations", "block");
  validateDecisionRuleReferences(artifact, decision.warnings, "warnings", "review");

  if (decision.violations.length > 0 && decision.outcome !== "blocked") {
    fail("GateArtifact.decision.violations", "exige outcome blocked");
  }
  if (decision.violations.length === 0 && decision.warnings.length > 0 && decision.outcome !== "warning") {
    fail("GateArtifact.decision.warnings", "exige outcome warning quando não há blockers");
  }

  if (decision.outcome === "blocked" && decision.violations.length === 0) {
    fail("GateArtifact.decision.outcome", "blocked exige violations");
  }
  if (decision.outcome === "warning" && (decision.violations.length > 0 || decision.warnings.length === 0)) {
    fail("GateArtifact.decision.outcome", "warning exige apenas warning rows");
  }
  if (decision.outcome === "pass" && (decision.violations.length > 0 || decision.warnings.length > 0)) {
    fail("GateArtifact.decision.outcome", "pass não aceita violations ou warnings");
  }
  if (
    (decision.outcome === "no_changes" || decision.outcome === "bootstrap" || decision.outcome === "error")
    && (decision.violations.length > 0 || decision.warnings.length > 0)
  ) {
    fail("GateArtifact.decision.outcome", `${decision.outcome} não aceita violations ou warnings`);
  }

  if (decision.outcome === "bootstrap" && artifact.baselineCommit !== null) {
    fail("GateArtifact.decision.outcome", "bootstrap exige baselineCommit nulo");
  }
  if (
    (decision.outcome === "pass" || decision.outcome === "warning" || decision.outcome === "blocked")
    && artifact.baselineCommit === null
  ) {
    fail("GateArtifact.baselineCommit", `é obrigatório para outcome ${decision.outcome}`);
  }
  if (
    artifact.changeSet.files.length === 0
    && decision.outcome !== "no_changes"
    && decision.outcome !== "error"
  ) {
    fail("GateArtifact.decision.outcome", "empty diff exige no_changes");
  }

  if (decision.outcome === "no_changes") {
    if (artifact.changeSet.files.length > 0) {
      fail("GateArtifact.decision.outcome", "no_changes exige changeset vazio");
    }
    if (artifact.findings.length > 0) {
      fail("GateArtifact.decision.outcome", "no_changes não aceita findings");
    }
  }
  if (decision.outcome === "error" && artifact.findings.length > 0) {
    fail("GateArtifact.decision.outcome", "error não aceita findings");
  }

  if (decision.outcome === "bootstrap") {
    artifact.findings.forEach((finding, index) => {
      if (finding.lifecycle !== "new") {
        fail(`GateArtifact.findings[${index}].lifecycle`, "bootstrap aceita apenas lifecycle new");
      }
    });
  }

  if (
    decision.outcome === "bootstrap"
    || decision.outcome === "pass"
    || decision.outcome === "warning"
    || decision.outcome === "blocked"
  ) {
    if (artifact.scan.id === null) {
      fail("GateArtifact.scan.id", `${decision.outcome} exige scan identificado`);
    }
    if (artifact.scan.status !== "completed") {
      if (/^(?:failed|error)$/i.test(artifact.scan.status.trim())) {
        fail("GateArtifact.scan.status", "failed/error exige outcome error/action_required");
      }
      fail("GateArtifact.scan.status", `${decision.outcome} exige status completed`);
    }
  }

  if (decision.outcome === "no_changes") {
    if (artifact.scan.id !== null) {
      fail("GateArtifact.scan.id", "no_changes não aceita scan id");
    }
    if (artifact.scan.cost !== null) {
      fail("GateArtifact.scan.cost", "no_changes não aceita custo de scan");
    }
    if (artifact.scan.status !== "not_run") {
      fail("GateArtifact.scan.status", "no_changes exige status not_run");
    }
  }
}

function validateDecisionRuleReferences(
  artifact: GateArtifact,
  rows: GateDecision["violations"],
  rowKind: "violations" | "warnings",
  expectedDecision: "block" | "review",
): void {
  rows.forEach((row, index) => {
    const path = `GateArtifact.decision.${rowKind}[${index}]`;
    const rule = artifact.policy.rules[row.ruleIndex];
    if (!rule) {
      fail(`${path}.ruleIndex`, "não referencia policy.rules");
    }
    if (rule.decision !== expectedDecision) {
      fail(path, `deve referenciar regra ${expectedDecision}`);
    }
    const finding = artifact.findings.find((candidate) => candidate.identity === row.findingIdentity)!;
    if (!rule.severity.includes(finding.severity)) {
      fail(path, "regra não cobre severity do finding");
    }
    if (!rule.lifecycle.includes(finding.lifecycle)) {
      fail(path, "regra não cobre lifecycle do finding");
    }
  });
}

function validateCanonicalDecisionGraph(artifact: GateArtifact): void {
  const decision = copyEvaluatedDecision(artifact.decision);
  const canonical = buildDecisionGraph(artifact.changeSet, artifact.findings, decision);
  if (!decisionGraphsEqual(artifact.decision.decisionGraph, canonical)) {
    fail("GateArtifact.decision.decisionGraph", "não corresponde ao grafo canônico");
  }
}

function decisionGraphsEqual(actual: DecisionGraph, expected: DecisionGraph): boolean {
  if (actual.selectedNodeId !== expected.selectedNodeId || actual.nodes.length !== expected.nodes.length) {
    return false;
  }
  for (let index = 0; index < actual.nodes.length; index += 1) {
    const left = actual.nodes[index]!;
    const right = expected.nodes[index]!;
    if (
      left.id !== right.id
      || left.kind !== right.kind
      || left.label !== right.label
      || left.value !== right.value
      || left.detail !== right.detail
      || left.tone !== right.tone
      || left.findingIdentity !== right.findingIdentity
    ) {
      return false;
    }
  }
  return true;
}

function validateVersions(value: unknown): void {
  const versions = record(value, "GateArtifact.versions");
  exactKeys(versions, ["gateCore", "scanner"], "GateArtifact.versions");
  nonEmptyString(versions.gateCore, "GateArtifact.versions.gateCore");
  nullableString(versions.scanner, "GateArtifact.versions.scanner");
}

function expectedConclusion(outcome: GateOutcome): GitHubConclusion {
  if (outcome === "pass" || outcome === "no_changes") return "success";
  if (outcome === "warning" || outcome === "bootstrap") return "neutral";
  if (outcome === "blocked") return "failure";
  return "action_required";
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "deve ser um objeto");
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "deve ser uma lista");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "deve ser texto");
  assertPublicString(value, path);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!parsed.trim()) fail(path, "não pode ser vazio");
  return parsed;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return string(value, path);
}

function nullableNonEmptyString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, path);
}

function publicPath(value: unknown, path: string): string {
  const parsed = nonEmptyString(value, path);
  if (!isRepositoryRelativePath(parsed)) {
    fail(path, "deve ser relativo ao repositório");
  }
  return parsed;
}

function nullablePublicPath(value: unknown, path: string): string | null {
  if (value === null) return null;
  return publicPath(value, path);
}

function stringArray(value: unknown, path: string): string[] {
  const parsed = array(value, path);
  return parsed.map((entry, index) => string(entry, `${path}[${index}]`));
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(path, "deve ser um número não negativo");
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const parsed = nonNegativeNumber(value, path);
  if (!Number.isInteger(parsed)) fail(path, "deve ser inteiro");
  return parsed;
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = nonNegativeInteger(value, path);
  if (parsed === 0) fail(path, "deve ser maior que zero");
  return parsed;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "deve ser booleano");
  return value;
}

function fullCommitSha(value: unknown, path: string): string {
  const parsed = nonEmptyString(value, path);
  if (!/^[0-9a-f]{40}$/.test(parsed)) fail(path, "deve ser um commit SHA completo");
  return parsed;
}

function canonicalSha256(value: unknown, path: string): string {
  const parsed = nonEmptyString(value, path);
  if (!/^sha256:[0-9a-f]{64}$/.test(parsed)) fail(path, "deve ser sha256 canônico");
  return parsed;
}

function nullableNonNegativeInteger(value: unknown, path: string): number | null {
  if (value === null) return null;
  return nonNegativeInteger(value, path);
}

function isoTimestamp(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!isIsoTimestamp(parsed)) fail(path, "deve ser um timestamp ISO");
  return parsed;
}

function nullableIsoTimestamp(value: unknown, path: string): string | null {
  if (value === null) return null;
  return isoTimestamp(value, path);
}

function assertPublicString(value: string, path: string): void {
  if (containsLocalHostPath(value)) {
    fail(path, "contém caminho absoluto local");
  }
  if (containsSecret(value)) {
    fail(path, "contém possível segredo");
  }
}

function containsLocalHostPath(value: string): boolean {
  return /file:\/\//i.test(value)
    || /(?:^|[\s"'`\[({=,:])\\\\[^\\/\s,;|\]})>`'"]+[\\/][^\s,;|\]})>`'"]*/.test(value)
    || /(?:^|[\s"'`\[({=,:])[A-Za-z]:[\\/][^\s,;|\]})>`'"]*/.test(value)
    || /(?:^|[\s"'`\[({=,:])\/(?:Users|tmp|private|root|var\/folders|var\/tmp)(?=\/|[\s,;|\]})>`'"]|$)/.test(value)
    || /(?:^|[\s"'`\[({=,:])\/home\/[^/\s,;|\]})>`'"]+(?:\/[^\s,;|\]})>`'"]*)?/.test(value);
}

function containsSecret(value: string): boolean {
  return containsSecretAssignment(value)
    || containsBearerCredential(value)
    || containsCommonToken(value);
}

function containsSecretAssignment(value: string): boolean {
  return /(?:^|[^A-Za-z0-9_])(?:[A-Za-z0-9]+_)*(?:SECRET_ACCESS_KEY|API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;|]+)/i.test(value)
    || /\b(?:authorization|api[- ]?key|token|secret|password)\s*[:=]\s*(?:bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;|]+)/i.test(value);
}

function containsBearerCredential(value: string): boolean {
  const matches = value.matchAll(/\bbearer\s+([^\s,;|]+)/gi);
  for (const match of matches) {
    if (isCredentialLikeBearerValue(match[1] ?? "")) return true;
  }
  return false;
}

function isCredentialLikeBearerValue(value: string): boolean {
  const candidate = value.replace(/^[`'"\[({]+|[`'"\])}]+$/g, "");
  if (!candidate) return false;
  if (/^(?:token|credential|authentication|authorization|header|scheme)(?:-[a-z]+)*$/i.test(candidate)) {
    return false;
  }
  return true;
}

function containsCommonToken(value: string): boolean {
  return /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i.test(value)
    || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/i.test(value)
    || /\bglpat-[A-Za-z0-9_-]{20,}\b/i.test(value)
    || /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i.test(value)
    || /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/i.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\bAIza[0-9A-Za-z_-]{30,}\b/.test(value)
    || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value);
}

function isRepositoryRelativePath(value: string): boolean {
  if (value !== value.trim()) return false;
  const location = value.replace(/:\d+(?::\d+)?(?:-\d+)?$/, "").replaceAll("\\", "/");
  if (
    /^~(?:\/|$)/.test(location)
    || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(location)
    || /^[A-Za-z]:/.test(location)
    || /^\//.test(location)
  ) {
    return false;
  }
  return !location.split("/").includes("..");
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function enumValue<const T extends readonly (string | number)[]>(value: unknown, allowed: T, path: string): T[number] {
  if (!allowed.includes(value as T[number])) fail(path, "possui valor inválido");
  return value as T[number];
}

function equal(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) fail(path, `deve ser ${String(expected)}`);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "é obrigatório");
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(path, `contém campo desconhecido ${key}`);
  }
}

function fail(path: string, message: string): never {
  throw new Error(`${path} ${message}`);
}
