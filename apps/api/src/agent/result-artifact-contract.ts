import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";

import { parseStructuredResult, type StructuredResultRejection } from "./structured-result.js";
import { validateVulnHunterReportEvidence } from "./result-artifact-evidence.js";
import {
  applyPortableCodexSecurityStageArtifact,
  COVERAGE_REASONS,
  normalizePortableCodexSecurityStageArtifact,
  validatePortableCodexSecurityDiscoveryCandidateContext,
  validatePortableCodexSecurityReportCoverage,
  type PortableArtifactValidationIssue,
  type PortableArtifactRepairDetail,
  type PortableCodexSecurityDossier,
  type PortableReportCoverageValidationIssue,
  PortableCodexSecurityDossierError,
} from "../scanners/portable-codex-security-dossier.js";
import {
  materializePortableCodexSecurityReportShard,
  type PortableCodexSecurityReportShard,
} from "../scanners/portable-codex-security-report-shards.js";
import {
  MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT,
  MANTIS_REPORT_RESULT_PATH,
  normalizeMantisReport,
  type MantisReportRepairDetail,
} from "../scanners/mantis-report-contract.js";

export const VULNHUNTER_RESULT_ARTIFACT_PATH = "sentinel-findings.json";
export const MAX_VULNHUNTER_RESULT_REPORT_BYTES = 2 * 1024 * 1024;
export const PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT = "portable-stage-json-v1" as const;

export const VULNHUNTER_RESULT_ARTIFACT_NAMES = [
  "reconnaissance.md",
  "trace-review.md",
  "verification.md",
  "validation-notes.md",
  "coverage-sweep.md",
  "README.md",
  "sentinel-findings.json",
] as const;

export type AgentResultArtifactContract =
  | typeof PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT
  | typeof MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT
  | "vulnhunter-report-v1";

export const PORTABLE_ARTIFACT_STAGES = {
  "01-inventory.json": "inventory",
  "02-threat-model.json": "threat-model",
  "03-discovery.json": "discovery",
  "04-dataflow.json": "dataflow",
  "05-validation.json": "validation",
  "sentinel-findings.json": "report",
} as const;
export type PortableArtifactPath = keyof typeof PORTABLE_ARTIFACT_STAGES;

/** Server-owned Portable state used only to validate a terminal artifact before host I/O. */
export interface PortableResultArtifactValidationContext {
  dossier: PortableCodexSecurityDossier;
  /** Fixed destination of the current server-owned stage. */
  expectedArtifactPath?: PortableArtifactPath;
  /** Report-page membership; causes the model-facing artifact to be findings-only. */
  reportShard?: PortableCodexSecurityReportShard;
  /** Deep discovery partition whose files must be read before artifact I/O. */
  deepCoverage?: {
    index: number;
    total: number;
    requiredPaths: readonly string[];
    requiredBytes: Readonly<Record<string, number>>;
    observedReadPaths: Set<string>;
  };
  /** New live discovery writes preserve the claim required by later validation. */
  requireDiscoveryCandidateContext?: boolean;
  /** Successful source reads made available to the live discovery session. */
  discoveryCoverage?: { observedReadPaths: Set<string> };
  /** High/critical live reports must explain source-backed impact and likelihood. */
  requireCalibratedSeverityRationale?: boolean;
}

export type ResultArtifactValidationIssue = PortableArtifactValidationIssue
  | PortableReportCoverageValidationIssue
  | "json-invalid"
  | "mantis-report-invalid"
  | "vulnhunter-report-invalid"
  | "dossier-semantics-invalid"
  | "deep-coverage-incomplete";
export type VulnHunterReportRepairDetail = {
  kind: "vulnhunter-report";
  reason: "envelope" | "finding" | "evidence";
};
export type DeepCoverageRepairDetail = {
  kind: "deep-coverage";
  /** Server-owned paths that were assigned to this partition but not fully observed yet. */
  missingPaths: readonly string[];
};
export interface DiscoveryScopeIssue {
  /** Structural field only; never echo provider content into diagnostics. */
  field: string;
  code: "object-required" | "unexpected-fields" | "array-required" | "entry-limit" |
    "empty-inspected" | "invalid-path" | "not-regular-file" | "path-unavailable" |
    "unobserved-read" | "overlap" | "invalid-reason" | "invalid-scope";
  allowedReasons?: readonly string[];
}
export type DiscoveryReviewRepairDetail = {
  kind: "discovery-review";
} & ({
  reason: "summary";
} | {
  reason: "scope";
  /** Server-observed successful reads the model can safely reuse in scope.inspected. */
  successfulReadPaths: readonly string[];
  pathsTruncated: boolean;
  scopeIssue: DiscoveryScopeIssue;
});
export type JsonRepairDetail = { kind: "json"; reason: StructuredResultRejection };
export type ResultArtifactRepairDetail = JsonRepairDetail | PortableArtifactRepairDetail | MantisReportRepairDetail |
  VulnHunterReportRepairDetail | DeepCoverageRepairDetail | DiscoveryReviewRepairDetail;

const REPORT_KEYS = new Set(["schemaVersion", "findings"]);
const FINDING_KEYS = new Set([
  "id", "title", "severity", "confidence", "cwe", "summary", "rootCause", "entryPoint",
  "dataFlow", "impact", "remediation", "severityRationale", "validation", "evidence",
]);
const VALIDATION_KEYS = new Set(["summary", "limitations"]);
const EVIDENCE_KEYS = new Set(["path", "startLine", "endLine", "role", "explanation"]);
const VALID_EVIDENCE_ROLES = new Set(["source", "entrypoint", "control", "sink", "evidence"]);
const MAX_FINDINGS = 1_000;

export function resultArtifactPathSchema(
  contract: AgentResultArtifactContract | undefined,
  context?: PortableResultArtifactValidationContext,
): Record<string, unknown> {
  if (contract === PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT) {
    return { type: "string", enum: context?.expectedArtifactPath === undefined
      ? Object.keys(PORTABLE_ARTIFACT_STAGES) : [context.expectedArtifactPath] };
  }
  return { type: "string", minLength: 1 };
}

/**
 * Portable artifacts travel as tool argument objects, avoiding a second JSON
 * serialization layer for source excerpts. Stage semantics remain validated
 * locally before I/O. Other consumers retain their existing string contract.
 */
export function resultArtifactContentSchema(
  contract: AgentResultArtifactContract | undefined,
  context?: PortableResultArtifactValidationContext,
): Record<string, unknown> {
  if (contract === PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT) {
    return portableStageContentSchema(context);
  }
  return { type: "string", minLength: 1 };
}

/** Explicit properties are necessary for providers that project tool arguments
 * through their declared schema. An unconstrained object can lose every field. */
function portableStageContentSchema(context?: PortableResultArtifactValidationContext): Record<string, unknown> {
  const text = { type: "string", minLength: 1 };
  const candidateContextText = { type: "string", minLength: 24, maxLength: 512 };
  const enumeration = (values: readonly string[]) => ({ type: "string", enum: values });
  const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
    type: "object", additionalProperties: false, properties, required,
  });
  const array = (items: Record<string, unknown>) => ({ type: "array", items });
  const reason = enumeration(PORTABLE_COVERAGE_REASONS);
  const anchor = object({
    path: text,
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    role: enumeration(["source", "entrypoint", "control", "sink", "evidence"]),
    explanation: text,
  }, ["path", "startLine", "endLine", "role"]);
  const anchors = { ...array(anchor), minItems: 1 };
  const scopeProperties = {
    inspected: array(text),
    unexamined: array(object({ path: text, reason })),
  };
  const finding = object({
    id: text, candidateId: text, title: text,
    severity: enumeration(["critical", "high", "medium", "low"]),
    confidence: enumeration(["high", "medium", "low"]),
    category: text, summary: text, rootCause: text, impact: text,
    remediation: text, anchors, cwe: array(text), severityRationale: text,
  }, [
    "id", "candidateId", "title", "severity", "confidence", "category", "summary",
    "rootCause", "impact", "remediation", "anchors",
    ...(context?.requireCalibratedSeverityRationale === true ? ["severityRationale"] : []),
  ]);
  const candidate = object({
    id: text,
    category: text,
    hypothesis: candidateContextText,
    attacker: enumeration(["unauthenticated", "authenticated", "privileged", "local", "unknown"]),
    prerequisites: candidateContextText,
    expectedImpact: candidateContextText,
    controlHypothesis: candidateContextText,
    anchors,
  }, context?.requireDiscoveryCandidateContext === true
    ? ["id", "category", "hypothesis", "attacker", "prerequisites", "expectedImpact", "controlHypothesis", "anchors"]
    : ["id", "category", "anchors"]);
  const properties: Record<string, unknown> = {
      schemaVersion: { type: "integer", enum: [1] },
      stage: enumeration(["inventory", "threat-model", "discovery", "dataflow", "validation", "report"]),
      summary: text,
      observations: { ...array({ type: "string" }), maxItems: 0 },
      scope: object(scopeProperties),
      candidates: array(candidate),
      assessments: array(object({
        candidateId: text,
        status: enumeration(["confirmed", "rejected", "inconclusive"]),
        reason, evidence: anchors,
      })),
      findings: array(finding),
      coverage: object({
        ...scopeProperties,
        candidates: array(object({
          candidateId: text, disposition: enumeration(["reported", "rejected"]), reason, evidence: anchors,
        })),
      }),
    };
  const expectedStage = context?.expectedArtifactPath === undefined
    ? undefined : PORTABLE_ARTIFACT_STAGES[context.expectedArtifactPath];
  if (expectedStage !== undefined) {
    const fields = expectedStage === "report"
      ? ["schemaVersion", "stage", "findings", ...(context?.reportShard === undefined ? ["coverage"] : [])]
      : ["schemaVersion", "stage", "summary", "observations",
        ...(expectedStage === "inventory" || expectedStage === "threat-model" || expectedStage === "discovery" ? ["scope"] : []),
        ...(expectedStage === "discovery" ? ["candidates"] : []),
        ...(expectedStage === "dataflow" || expectedStage === "validation" ? ["assessments"] : [])];
    const selected = Object.fromEntries(fields.map((field) => [field, properties[field]]));
    selected.stage = enumeration([expectedStage]);
    if (expectedStage === "discovery" && context?.requireDiscoveryCandidateContext === true) {
      selected.summary = { type: "string", minLength: 40, maxLength: 32_768,
        description: "Summarize the source review, tested control hypotheses and result. Do not submit a placeholder or interpret incomplete review as clean." };
      if (context.deepCoverage === undefined) {
        selected.scope = object({
          inspected: { ...array(text), minItems: 1,
            description: "Exact repository-relative source file paths successfully read in this discovery session; directories, invented paths and merely listed files are not reviewed evidence." },
          unexamined: { ...scopeProperties.unexamined,
            description: "Known source file paths not reviewed, with the reason. Do not claim that unexamined code is clean." },
        });
      }
    }
    if (expectedStage === "validation") {
      selected.assessments = array(object({ candidateId: text,
        status: enumeration(["confirmed", "rejected"]), reason, evidence: anchors }));
    }
    return object(selected, fields.filter((field) => field !== "scope" ||
      (expectedStage === "discovery" && context?.requireDiscoveryCandidateContext === true && context.deepCoverage === undefined)));
  }
  return {
    ...object(properties, ["schemaVersion"]),
    description: "The complete stage artifact as a JSON object matching the supplied stage contract. Pass the object directly; do not stringify it or wrap it in Markdown. Include only fields required by the current stage: summary and observations for non-report stages; candidates for discovery; assessments for dataflow/validation; findings for report. Report pages omit coverage because the server derives it.",
  };
}

/**
 * Parses and validates the single canonical VulnHunter findings report. It is
 * deliberately monomorphic: providers never have to reproduce our seven-file
 * internal layout.
 */
export function normalizeVulnHunterResultReport(
  value: unknown,
  snapshotRoot?: string,
  onReject?: (detail: VulnHunterReportRepairDetail) => void,
): Record<string, unknown> | null {
  const report = record(value);
  if (report === null || !hasOnlyKeys(report, REPORT_KEYS) || report.schemaVersion !== 1 ||
      !Array.isArray(report.findings) || report.findings.length > MAX_FINDINGS) {
    onReject?.({ kind: "vulnhunter-report", reason: "envelope" });
    return null;
  }

  const ids = new Set<string>();
  for (const candidate of report.findings) {
    const finding = record(candidate);
    if (finding === null || !hasOnlyKeys(finding, FINDING_KEYS)) {
      onReject?.({ kind: "vulnhunter-report", reason: "finding" });
      return null;
    }
    const id = boundedText(finding.id, 256);
    if (id === null || ids.has(id)) {
      onReject?.({ kind: "vulnhunter-report", reason: "finding" });
      return null;
    }
    ids.add(id);
    if (boundedText(finding.title, 4_096) === null || !isSeverity(finding.severity) ||
        !isConfidence(finding.confidence) || !stringArray(finding.cwe, 128, 128, /^CWE-\d+$/i) ||
        boundedText(finding.summary, 32_768) === null ||
        boundedText(finding.rootCause, 32_768) === null ||
        boundedText(finding.entryPoint, 16_384) === null ||
        boundedText(finding.dataFlow, 32_768) === null ||
        boundedText(finding.impact, 32_768) === null ||
        boundedText(finding.remediation, 32_768) === null ||
        boundedText(finding.severityRationale, 32_768) === null ||
        !validValidation(finding.validation) || !validEvidence(finding.evidence)) {
      onReject?.({ kind: "vulnhunter-report", reason: "finding" });
      return null;
    }
  }
  const canonical = { schemaVersion: 1, findings: report.findings };
  if (Buffer.byteLength(`${JSON.stringify(canonical)}\n`, "utf8") >
      MAX_VULNHUNTER_RESULT_REPORT_BYTES) {
    onReject?.({ kind: "vulnhunter-report", reason: "envelope" });
    return null;
  }
  if (!validateVulnHunterReportEvidence(canonical, snapshotRoot)) {
    onReject?.({ kind: "vulnhunter-report", reason: "evidence" });
    return null;
  }
  return canonical;
}

/**
 * Canonicalizes a provider result before the workspace host can create a file.
 * One exact JSON code fence is tolerated because several otherwise compatible
 * providers serialize JSON strings that way.
 */
export function normalizeResultArtifactInput(
  input: Record<string, unknown>,
  contract: AgentResultArtifactContract | undefined,
  snapshotRoot?: string,
  portableContext?: PortableResultArtifactValidationContext,
  onReject?: (issue: ResultArtifactValidationIssue, detail?: ResultArtifactRepairDetail) => void,
): Record<string, unknown> | null {
  let jsonReason: StructuredResultRejection = "syntax";
  const onJsonReject = (reason: StructuredResultRejection) => { jsonReason = reason; };
  const parsed = typeof input.content === "string"
    ? parseStructuredResult(undefined, input.content, onJsonReject)
    : parseStructuredResult(input.content, null, onJsonReject);
  if (parsed === null) {
    onReject?.("json-invalid", { kind: "json", reason: jsonReason });
    return null;
  }
  if (contract === undefined) {
    return { ...input, content: JSON.stringify(parsed) };
  }
  if (contract === PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT) {
    // Report shards have exactly one server-owned destination. An omitted
    // envelope path must not force regeneration of a complete findings page.
    // Supplied paths remain validated, and no finding/evidence is synthesized.
    const artifactPath = input.path === undefined && portableContext?.reportShard !== undefined
      ? VULNHUNTER_RESULT_ARTIFACT_PATH : input.path;
    return normalizePortableStageArtifact(artifactPath, parsed, snapshotRoot, portableContext, onReject);
  }
  if (contract === MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT) {
    let repairDetail: MantisReportRepairDetail | undefined;
    if (input.path !== MANTIS_REPORT_RESULT_PATH) {
      onReject?.("mantis-report-invalid", { kind: "mantis-report", reason: "envelope" });
      return null;
    }
    const report = normalizeMantisReport(parsed, snapshotRoot, (detail) => { repairDetail = detail; });
    if (report === null) {
      onReject?.("mantis-report-invalid", repairDetail);
      return null;
    }
    return { path: MANTIS_REPORT_RESULT_PATH, content: JSON.stringify(report) };
  }
  if (input.path !== VULNHUNTER_RESULT_ARTIFACT_PATH) {
    onReject?.("vulnhunter-report-invalid", { kind: "vulnhunter-report", reason: "envelope" });
    return null;
  }
  let repairDetail: VulnHunterReportRepairDetail | undefined;
  const report = normalizeVulnHunterResultReport(
    parsed,
    snapshotRoot,
    (detail) => { repairDetail = detail; },
  );
  if (report === null) onReject?.("vulnhunter-report-invalid", repairDetail);
  return report === null
    ? null
    : { path: VULNHUNTER_RESULT_ARTIFACT_PATH, content: JSON.stringify(report) };
}

function normalizePortableStageArtifact(
  path: unknown,
  value: unknown,
  snapshotRoot: string | undefined,
  context: PortableResultArtifactValidationContext | undefined,
  onReject?: (issue: ResultArtifactValidationIssue, detail?: ResultArtifactRepairDetail) => void,
): Record<string, unknown> | null {
  if (context?.expectedArtifactPath !== undefined && path !== context.expectedArtifactPath) {
    onReject?.("path-or-stage-invalid");
    return null;
  }
  let repairDetail: ResultArtifactRepairDetail | undefined;
  let modelValue = value;
  if (context?.requireDiscoveryCandidateContext === true && path === "03-discovery.json") {
    const record = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const detail = record === null
      ? { kind: "candidate-contract" as const, reason: "array-or-limit" as const }
      : validatePortableCodexSecurityDiscoveryCandidateContext(record.candidates);
    if (detail !== null) {
      onReject?.("stage-candidates-invalid", detail);
      return null;
    }
    // A syntactically valid empty candidate array is not evidence of a review.
    // Keep this live-only so historical artifacts remain readable.
    const summary = boundedText(record?.summary, 32_768)?.trim();
    if (summary === undefined || summary.length < 40 ||
        /^(?:placeholder|todo|tbd|pending|n[\/\.]?a)(?:\b|$)/i.test(summary)) {
      onReject?.("stage-summary-invalid", { kind: "discovery-review", reason: "summary" });
      return null;
    }
  }
  if (path === VULNHUNTER_RESULT_ARTIFACT_PATH && context?.reportShard !== undefined) {
    try {
      modelValue = materializePortableCodexSecurityReportShard(context.reportShard, value, detail => { repairDetail = detail; });
    } catch (error) {
      const issue = error instanceof PortableCodexSecurityDossierError && error.issue !== undefined
        ? error.issue
        : "report-contract-invalid";
      onReject?.(issue, repairDetail);
      return null;
    }
  }
  if (context?.deepCoverage !== undefined && path === "03-discovery.json") {
    const missing = context.deepCoverage.requiredPaths.some(
      (requiredPath) => !context.deepCoverage!.observedReadPaths.has(requiredPath),
    );
    if (missing) {
      onReject?.("deep-coverage-incomplete");
      return null;
    }
    const record = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    if (record === null || !Array.isArray(record.candidates)) {
      onReject?.("stage-candidates-invalid");
      return null;
    }
    modelValue = {
      ...record,
      scope: { inspected: [...context.deepCoverage.requiredPaths], unexamined: [] },
      candidates: record.candidates.map((candidate) => canonicalDeepCandidate(candidate)),
    };
  }
  const artifact = normalizePortableCodexSecurityStageArtifact(
    path,
    modelValue,
    snapshotRoot,
    (issue) => onReject?.(issue, repairDetail ??
      (context?.requireDiscoveryCandidateContext === true && path === "03-discovery.json" && issue === "stage-scope-invalid"
        ? discoveryScopeRepairDetail(context, modelValue, snapshotRoot) : undefined)),
    (detail) => { repairDetail = detail; },
  );
  if (artifact === null || typeof path !== "string") return null;
  if (context?.requireDiscoveryCandidateContext === true && path === "03-discovery.json" &&
      !hasLiveDiscoveryScope(artifact, snapshotRoot, context)) {
    onReject?.("stage-scope-invalid", discoveryScopeRepairDetail(context, artifact, snapshotRoot));
    return null;
  }
  if (context?.requireCalibratedSeverityRationale === true && path === VULNHUNTER_RESULT_ARTIFACT_PATH &&
      !hasCalibratedHighSeverityRationale(artifact)) {
    const findings = artifact.findings as Record<string, unknown>[];
    const index = findings.findIndex((finding) =>
      (finding.severity === "critical" || finding.severity === "high") &&
      (typeof finding.severityRationale !== "string" || finding.severityRationale.trim().length < 24));
    onReject?.("report-contract-invalid", {
      kind: "report-contract", field: `findings[${index}].severityRationale`, code: "text", minChars: 24,
    });
    return null;
  }
  if (context !== undefined) {
    try {
      if (path === VULNHUNTER_RESULT_ARTIFACT_PATH) {
        validatePortableCodexSecurityReportCoverage(artifact, context.dossier);
      } else {
        const nextDossier = applyPortableCodexSecurityStageArtifact(context.dossier, artifact);
        if (path === "05-validation.json") {
          const validationByCandidate = new Map(
            nextDossier.assessments
              .filter((assessment) => assessment.stage === "validation")
              .map((assessment) => [assessment.candidateId, assessment.status] as const),
          );
          if (nextDossier.candidates.some((candidate) => {
            const status = validationByCandidate.get(candidate.id);
            return status !== "confirmed" && status !== "rejected";
          })) {
            throw new PortableCodexSecurityDossierError(
              "validation must decide every carried candidate",
              "report-candidate-assessment-inconclusive",
            );
          }
        }
      }
    } catch (error) {
      const issue = error instanceof PortableCodexSecurityDossierError && error.issue !== undefined
        ? error.issue
        : path === VULNHUNTER_RESULT_ARTIFACT_PATH
          ? "report-contract-invalid"
          : "dossier-semantics-invalid";
      onReject?.(issue);
      return null;
    }
  }
  return { path, content: JSON.stringify(artifact) };
}

const MAX_DISCOVERY_REPAIR_PATHS = 64;
const PORTABLE_COVERAGE_REASONS = [...COVERAGE_REASONS];

/** Diagnose a rejected scope without altering the artifact or its candidates. */
function discoveryScopeIssue(value: unknown, snapshotRoot: string | undefined,
  context: PortableResultArtifactValidationContext): DiscoveryScopeIssue {
  const scope = record(record(value)?.scope);
  if (scope === null) return { field: "scope", code: "object-required" };
  if (Object.keys(scope).some(key => key !== "inspected" && key !== "unexamined")) {
    return { field: "scope", code: "unexpected-fields" };
  }
  for (const field of ["inspected", "unexamined"] as const) {
    if (!Array.isArray(scope[field])) return { field: `scope.${field}`, code: "array-required" };
    if (scope[field].length > 4_096) return { field: `scope.${field}`, code: "entry-limit" };
  }
  const inspected = scope.inspected as unknown[];
  const unexamined = scope.unexamined as unknown[];
  if (inspected.length === 0) return { field: "scope.inspected", code: "empty-inspected" };
  const normalized = (value: unknown) => typeof value === "string"
    ? value.trim().replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "") : value;
  const checkPath = (value: unknown, field: string): DiscoveryScopeIssue | undefined => {
    if (typeof value !== "string" || !repositoryRelativePath(value)) return { field, code: "invalid-path" };
    if (snapshotRoot !== undefined) {
      try {
        const root = fs.realpathSync(snapshotRoot);
        const lexical = nodePath.resolve(root, value);
        if (!fs.lstatSync(lexical).isFile()) return { field, code: "not-regular-file" };
        const relative = nodePath.relative(root, fs.realpathSync(lexical));
        if (!relative || relative === ".." || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) {
          return { field, code: "invalid-path" };
        }
      } catch { return { field, code: "path-unavailable" }; }
    }
    return undefined;
  };
  const observed = context.discoveryCoverage?.observedReadPaths ?? context.deepCoverage?.observedReadPaths;
  const inspectedSet = new Set(inspected.map(normalized));
  for (const [index, value] of inspected.entries()) {
    const field = `scope.inspected[${index}]`;
    const file = normalized(value);
    const issue = checkPath(file, field);
    if (issue) return issue;
    if (observed !== undefined && !observed.has(file as string)) return { field, code: "unobserved-read" };
  }
  for (const [index, value] of unexamined.entries()) {
    const field = `scope.unexamined[${index}]`;
    const entry = record(value);
    if (entry === null) return { field, code: "object-required" };
    if (Object.keys(entry).some(key => key !== "path" && key !== "reason")) return { field, code: "unexpected-fields" };
    const file = normalized(entry.path);
    const issue = checkPath(file, `${field}.path`);
    if (issue) return issue;
    if (!PORTABLE_COVERAGE_REASONS.includes(entry.reason as typeof PORTABLE_COVERAGE_REASONS[number])) {
      return { field: `${field}.reason`, code: "invalid-reason", allowedReasons: PORTABLE_COVERAGE_REASONS };
    }
    if (inspectedSet.has(file)) return { field: `${field}.path`, code: "overlap" };
  }
  return { field: "scope", code: "invalid-scope" };
}

function discoveryScopeRepairDetail(
  context: PortableResultArtifactValidationContext,
  value: unknown,
  snapshotRoot: string | undefined,
): DiscoveryReviewRepairDetail {
  const successfulReadPaths = [...(context.discoveryCoverage?.observedReadPaths ?? [])]
    .map((candidate) => nodePath.posix.normalize(candidate.replaceAll("\\", "/")))
    .filter((candidate) => candidate !== "." && !candidate.startsWith("../") && !nodePath.posix.isAbsolute(candidate))
    .sort();
  return {
    kind: "discovery-review",
    reason: "scope",
    successfulReadPaths: successfulReadPaths.slice(0, MAX_DISCOVERY_REPAIR_PATHS),
    pathsTruncated: successfulReadPaths.length > MAX_DISCOVERY_REPAIR_PATHS,
    scopeIssue: discoveryScopeIssue(value, snapshotRoot, context),
  };
}

function hasCalibratedHighSeverityRationale(artifact: Record<string, unknown>): boolean {
  const findings = artifact.findings;
  if (!Array.isArray(findings)) return false;
  return findings.every((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const finding = value as Record<string, unknown>;
    if (finding.severity !== "critical" && finding.severity !== "high") return true;
    return typeof finding.severityRationale === "string" && finding.severityRationale.trim().length >= 24;
  });
}

function hasLiveDiscoveryScope(
  artifact: Record<string, unknown>,
  snapshotRoot: string | undefined,
  context: PortableResultArtifactValidationContext,
): boolean {
  const scope = record(artifact.scope);
  if (scope === null || !Array.isArray(scope.inspected) || scope.inspected.length === 0 ||
      !Array.isArray(scope.unexamined)) return false;
  const inspected = scope.inspected;
  const unexamined = scope.unexamined.map((entry) => record(entry)?.path);
  const observed = context.discoveryCoverage?.observedReadPaths ?? context.deepCoverage?.observedReadPaths;
  if (inspected.some((file) => typeof file !== "string" || (observed !== undefined && !observed.has(file)))) {
    return false;
  }
  const inspectedSet = new Set(inspected);
  if (unexamined.some((file) => inspectedSet.has(file))) return false;
  return [...inspected, ...unexamined].every((file) => {
    if (!repositoryRelativePath(file) || typeof file !== "string") return false;
    if (snapshotRoot === undefined) return true;
    try {
      const root = fs.realpathSync(snapshotRoot);
      const lexicalTarget = nodePath.resolve(root, file);
      if (!fs.lstatSync(lexicalTarget).isFile()) return false;
      const target = fs.realpathSync(lexicalTarget);
      const relative = nodePath.relative(root, target);
      return relative !== "" && relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) &&
        !nodePath.isAbsolute(relative) && fs.statSync(target).isFile();
    } catch {
      return false;
    }
  });
}

function canonicalDeepCandidate(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  const fingerprint = JSON.stringify({
    category: candidate.category,
    hypothesis: candidate.hypothesis,
    attacker: candidate.attacker,
    prerequisites: candidate.prerequisites,
    expectedImpact: candidate.expectedImpact,
    controlHypothesis: candidate.controlHypothesis,
    anchors: candidate.anchors,
  });
  return {
    ...candidate,
    id: `deep-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}`,
  };
}

function validValidation(value: unknown): boolean {
  const validation = record(value);
  return validation !== null && hasOnlyKeys(validation, VALIDATION_KEYS) &&
    boundedText(validation.summary, 32_768) !== null &&
    stringArray(validation.limitations, 128, 8_192);
}

function validEvidence(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) return false;
  return value.every((candidate) => {
    const evidence = record(candidate);
    return evidence !== null && hasOnlyKeys(evidence, EVIDENCE_KEYS) &&
      repositoryRelativePath(evidence.path) && positiveInteger(evidence.startLine) &&
      positiveInteger(evidence.endLine) && evidence.endLine >= evidence.startLine &&
      typeof evidence.role === "string" && VALID_EVIDENCE_ROLES.has(evidence.role) &&
      boundedText(evidence.explanation, 32_768) !== null;
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedText(value: unknown, maxBytes: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\u0000") &&
    Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : null;
}

function stringArray(
  value: unknown,
  maxItems: number,
  maxTextBytes: number,
  pattern?: RegExp,
): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => {
    const text = boundedText(item, maxTextBytes);
    return text !== null && (pattern === undefined || pattern.test(text));
  });
}

function isSeverity(value: unknown): boolean {
  return typeof value === "string" && /^(?:critical|high|medium|low)$/i.test(value);
}

function isConfidence(value: unknown): boolean {
  return typeof value === "string" && /^(?:high|medium|low)$/i.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function repositoryRelativePath(value: unknown): boolean {
  const text = boundedText(value, 4_096);
  if (text === null) return false;
  const normalized = text.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split("/").some((part) => part === "" || part === "." || part === "..");
}
