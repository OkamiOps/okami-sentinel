import { createHash } from "node:crypto";

import { parseStructuredResult } from "./structured-result.js";
import { validateVulnHunterReportEvidence } from "./result-artifact-evidence.js";
import {
  applyPortableCodexSecurityStageArtifact,
  normalizePortableCodexSecurityStageArtifact,
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

/** Server-owned Portable state used only to validate a terminal artifact before host I/O. */
export interface PortableResultArtifactValidationContext {
  dossier: PortableCodexSecurityDossier;
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
export type ResultArtifactRepairDetail = PortableArtifactRepairDetail | MantisReportRepairDetail |
  VulnHunterReportRepairDetail;

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
  _contract: AgentResultArtifactContract | undefined,
): Record<string, unknown> {
  return { type: "string", minLength: 1 };
}

/**
 * Keep the provider-facing contract on the same primitive string shape proven
 * by the capability probe. Scanner semantics are validated locally before I/O.
 */
export function resultArtifactContentSchema(
  _contract: AgentResultArtifactContract | undefined,
): Record<string, unknown> {
  return { type: "string", minLength: 1 };
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
  const parsed = typeof input.content === "string"
    ? parseStructuredResult(undefined, input.content)
    : parseStructuredResult(input.content, null);
  if (parsed === null) {
    onReject?.("json-invalid");
    return null;
  }
  if (contract === undefined) {
    return { ...input, content: JSON.stringify(parsed) };
  }
  if (contract === PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT) {
    return normalizePortableStageArtifact(input.path, parsed, snapshotRoot, portableContext, onReject);
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
  let repairDetail: ResultArtifactRepairDetail | undefined;
  let modelValue = value;
  if (path === VULNHUNTER_RESULT_ARTIFACT_PATH && context?.reportShard !== undefined) {
    try {
      modelValue = materializePortableCodexSecurityReportShard(context.reportShard, value);
    } catch (error) {
      const issue = error instanceof PortableCodexSecurityDossierError && error.issue !== undefined
        ? error.issue
        : "report-contract-invalid";
      onReject?.(issue);
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
    (issue) => onReject?.(issue, repairDetail),
    (detail) => { repairDetail = detail; },
  );
  if (artifact === null || typeof path !== "string") return null;
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

function canonicalDeepCandidate(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  const fingerprint = JSON.stringify({ category: candidate.category, anchors: candidate.anchors });
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
