import type {
  ChangeSet,
  GateArtifact,
  GateDecision,
  GateFindingDelta,
  GateOutcome,
  GateSource,
  GitHubConclusion,
  GuardrailPolicy,
  Severity,
} from "@csb/shared";
import type { EvaluateGateResult } from "./evaluate.js";
import { buildDecisionGraph } from "./decision-graph.js";

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
  scan: GateArtifact["scan"];
  baselineCommit: string | null;
  versions: GateArtifact["versions"];
  createdAt: string;
}

export interface BuildGateArtifactInput extends PublicArtifactEnvelope {
  evaluation: EvaluateGateResult;
}

export interface BuildOperationalErrorArtifactInput extends PublicArtifactEnvelope {
  operationalSummary: string;
}

const severities: readonly Severity[] = ["critical", "high", "medium", "low", "info", "unknown"];
const outcomes: readonly GateOutcome[] = ["no_changes", "bootstrap", "pass", "warning", "blocked", "error"];
const conclusions: readonly GitHubConclusion[] = ["success", "neutral", "failure", "action_required"];
const nodeKinds = ["changeset", "surface", "signal", "rule", "verdict"] as const;
const nodeIds = ["changeset", "surface", "signal", "rule", "verdict"] as const;

export function buildGateArtifact(input: BuildGateArtifactInput): GateArtifact {
  const envelope = buildEnvelope(input);
  const findings = input.evaluation.deltas.map(copyFinding);
  assertPublicFindingPaths(findings);
  const decisionWithoutGraph = copyEvaluatedDecision(input.evaluation.decision);
  const decision: GateDecision = {
    ...decisionWithoutGraph,
    decisionGraph: buildDecisionGraph(envelope.changeSet, findings, decisionWithoutGraph),
  };

  return {
    schemaVersion: 1,
    ...envelope,
    findings,
    decision,
  };
}

export function buildOperationalErrorArtifact(input: BuildOperationalErrorArtifactInput): GateArtifact {
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

  return {
    schemaVersion: 1,
    ...envelope,
    findings: [],
    decision: {
      ...decisionWithoutGraph,
      decisionGraph: buildDecisionGraph(envelope.changeSet, [], decisionWithoutGraph),
    },
  };
}

export function parseGateArtifact(value: unknown): GateArtifact {
  const artifact = record(value, "GateArtifact");
  const schemaVersion = artifact.schemaVersion;
  if (typeof schemaVersion === "number" && schemaVersion > 1) {
    throw new Error(`GateArtifact schema ${schemaVersion} não suportado`);
  }
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
  nullableString(artifact.baselineCommit, "GateArtifact.baselineCommit");
  const findings = array(artifact.findings, "GateArtifact.findings");
  findings.forEach((finding, index) => validateFinding(finding, `GateArtifact.findings[${index}]`));
  validateDecision(artifact.decision, findings);
  validateVersions(artifact.versions);
  isoTimestamp(artifact.createdAt, "GateArtifact.createdAt");
  return value as GateArtifact;
}

function buildEnvelope(input: PublicArtifactEnvelope): Omit<GateArtifact, "schemaVersion" | "findings" | "decision"> {
  requireNonEmpty(input.gateId, "gateId");
  requireNonEmpty(input.repository.key, "repository.key");
  requireNonEmpty(input.repository.name, "repository.name");
  requireNonEmpty(input.changeSet.baseSha, "changeSet.baseSha");
  requireNonEmpty(input.changeSet.headSha, "changeSet.headSha");
  assertIsoTimestamp(input.createdAt, "createdAt");

  const changeSet = copyChangeSet(input.changeSet);
  assertPublicPaths(changeSet);

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

function copyPolicy(policy: GuardrailPolicy): GuardrailPolicy {
  return {
    schemaVersion: 1,
    protectedBranches: [...policy.protectedBranches],
    scope: { ...policy.scope },
    scan: { ...policy.scan },
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
    cost: scan.cost ? { ...scan.cost } : null,
    status: scan.status,
  };
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
    triage: { ...finding.triage },
    exception: finding.exception ? {
      ...finding.exception,
      branches: [...finding.exception.branches],
      ruleIndexes: [...finding.exception.ruleIndexes],
    } : null,
    sourceScanId: finding.sourceScanId,
  };
}

function copyEvaluatedDecision(decision: EvaluateGateResult["decision"]): EvaluateGateResult["decision"] {
  return {
    outcome: decision.outcome,
    summary: decision.summary,
    violations: decision.violations.map((violation) => ({ ...violation })),
    warnings: decision.warnings.map((warning) => ({ ...warning })),
    exceptionsApplied: [...decision.exceptionsApplied],
    githubConclusion: decision.githubConclusion,
  };
}

function sanitizeOperationalSummary(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "[REDACTED]")
    .replace(/\b(?:api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/(?:file:\/\/)?(?:\/[\w.@%+~:-]+)+(?:\/[^\s,;]*)?/g, "[LOCAL_PATH]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\s,;]*/g, "[LOCAL_PATH]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return normalized || "Falha operacional.";
}

function assertPublicFindingPaths(findings: GateFindingDelta[]): void {
  for (const finding of findings) {
    if (finding.primaryPath !== null && isAbsoluteLocalPath(finding.primaryPath)) {
      throw new Error("GateArtifact não pode publicar caminho absoluto local");
    }
  }
}

function assertPublicPaths(changeSet: ChangeSet): void {
  const paths = [
    ...changeSet.files.flatMap((file) => [file.path, file.previousPath]),
    ...changeSet.scanPaths,
  ];
  for (const path of paths) {
    if (path !== null && isAbsoluteLocalPath(path)) {
      throw new Error("GateArtifact não pode publicar caminho absoluto local");
    }
  }
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("file://");
}

function requireNonEmpty(value: string, path: string): void {
  if (!value.trim()) throw new Error(`${path} não pode ser vazio`);
}

function assertIsoTimestamp(value: string, path: string): void {
  if (!isIsoTimestamp(value)) throw new Error(`${path} deve ser um timestamp ISO`);
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

function publicPath(value: unknown, path: string): string {
  const parsed = nonEmptyString(value, path);
  if (isAbsoluteLocalPath(parsed)) fail(path, "não pode ser um caminho absoluto local");
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
