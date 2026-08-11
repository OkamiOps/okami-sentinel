import { parseStructuredResult } from "./structured-result.js";
import { validateVulnHunterReportEvidence } from "./result-artifact-evidence.js";

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
  | "vulnhunter-report-v1";

const PORTABLE_STAGE_BY_ARTIFACT = new Map<string, string>([
  ["01-inventory.json", "inventory"],
  ["02-threat-model.json", "threat-model"],
  ["03-discovery.json", "discovery"],
  ["04-dataflow.json", "dataflow"],
  ["05-validation.json", "validation"],
  ["sentinel-findings.json", "report"],
]);
const MAX_PORTABLE_STAGE_SUMMARY_BYTES = 16_384;

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
): Record<string, unknown> | null {
  const report = record(value);
  if (report === null || !hasOnlyKeys(report, REPORT_KEYS) || report.schemaVersion !== 1 ||
      !Array.isArray(report.findings) || report.findings.length > MAX_FINDINGS) return null;

  const ids = new Set<string>();
  for (const candidate of report.findings) {
    const finding = record(candidate);
    if (finding === null || !hasOnlyKeys(finding, FINDING_KEYS)) return null;
    const id = boundedText(finding.id, 256);
    if (id === null || ids.has(id)) return null;
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
        !validValidation(finding.validation) || !validEvidence(finding.evidence)) return null;
  }
  const canonical = { schemaVersion: 1, findings: report.findings };
  return Buffer.byteLength(`${JSON.stringify(canonical)}\n`, "utf8") <=
    MAX_VULNHUNTER_RESULT_REPORT_BYTES &&
    validateVulnHunterReportEvidence(canonical, snapshotRoot)
    ? canonical
    : null;
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
): Record<string, unknown> | null {
  const parsed = typeof input.content === "string"
    ? parseStructuredResult(undefined, input.content)
    : parseStructuredResult(input.content, null);
  if (parsed === null) return null;
  if (contract === undefined) {
    return { ...input, content: JSON.stringify(parsed) };
  }
  if (contract === PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT) {
    return normalizePortableStageArtifact(input.path, parsed);
  }
  if (input.path !== VULNHUNTER_RESULT_ARTIFACT_PATH) return null;
  const report = normalizeVulnHunterResultReport(parsed, snapshotRoot);
  return report === null
    ? null
    : { path: VULNHUNTER_RESULT_ARTIFACT_PATH, content: JSON.stringify(report) };
}

function normalizePortableStageArtifact(path: unknown, value: unknown): Record<string, unknown> | null {
  if (typeof path !== "string") return null;
  const expectedStage = PORTABLE_STAGE_BY_ARTIFACT.get(path);
  const artifact = record(value);
  if (expectedStage === undefined || artifact === null || artifact.schemaVersion !== 1) return null;
  if (expectedStage === "report") {
    if ((artifact.stage !== undefined && artifact.stage !== "report") ||
        !Array.isArray(artifact.findings)) return null;
  } else if (artifact.stage !== expectedStage || !Array.isArray(artifact.observations) ||
      boundedText(artifact.summary, MAX_PORTABLE_STAGE_SUMMARY_BYTES) === null) {
    return null;
  }
  return { path, content: JSON.stringify(artifact) };
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
