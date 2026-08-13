import fs from "node:fs";
import path from "node:path";

export const PORTABLE_CODEX_SECURITY_DOSSIER_FILE =
  "portable-codex-security-dossier.json" as const;

const DOSSIER_SCHEMA_VERSION = 1 as const;
const MAX_DOSSIER_BYTES = 2 * 1024 * 1024;
const MAX_STAGE_SUMMARY_BYTES = 16_384;
const MAX_CANDIDATES = 100;
const MAX_ASSESSMENTS = 200;
const MAX_SCOPE_ENTRIES = 4_096;
const MAX_ANCHORS = 20;
const MAX_TEXT_BYTES = 1_024;
const MIN_SUBSTANTIVE_TEXT_BYTES = 24;
const MAX_SNAPSHOT_ANCHOR_FILE_BYTES = 1_048_576;
const MAX_SNAPSHOT_ANCHOR_FILES = 256;
const MAX_SNAPSHOT_ANCHOR_BYTES = 32 * 1_048_576;
const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;
const READ_NO_FOLLOW = fs.constants.O_RDONLY | NO_FOLLOW;

const STAGE_NAMES = new Set([
  "inventory", "threat-model", "discovery", "dataflow", "validation",
]);
const CANDIDATE_STAGES = new Set(["discovery"]);
const ASSESSMENT_STAGES = new Set(["dataflow", "validation"]);
const ASSESSMENT_STATUSES = new Set(["confirmed", "rejected", "inconclusive"]);
const COVERAGE_DISPOSITIONS = new Set(["reported", "rejected"]);
const COVERAGE_REASONS = new Set([
  "control-not-present",
  "untrusted-flow-reaches-sink",
  "no-untrusted-source",
  "not-reachable",
  "sanitized",
  "requires-privilege",
  "out-of-scope",
  "insufficient-evidence",
  "not-vulnerable",
]);
const ANCHOR_ROLES = new Set(["source", "entrypoint", "control", "sink", "evidence"]);
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);

export interface PortableCoverageAnchor {
  path: string;
  startLine: number;
  endLine: number;
  role: "source" | "entrypoint" | "control" | "sink" | "evidence";
  explanation?: string;
}

export interface PortableCandidate {
  id: string;
  category: string;
  anchors: PortableCoverageAnchor[];
}

export interface PortableCandidateAssessment {
  candidateId: string;
  stage: "dataflow" | "validation";
  status: "confirmed" | "rejected" | "inconclusive";
  reason: string;
  evidence: PortableCoverageAnchor[];
}

export interface PortableScope {
  inspected: string[];
  unexamined: Array<{ path: string; reason: string }>;
}

export interface PortableStageSummary {
  stage: "inventory" | "threat-model" | "discovery" | "dataflow" | "validation";
  summary: string;
}

export interface PortableCodexSecurityDossier {
  schemaVersion: typeof DOSSIER_SCHEMA_VERSION;
  /** Compact, server-owned context retained between the six fixed stages. */
  stageSummaries: PortableStageSummary[];
  candidates: PortableCandidate[];
  assessments: PortableCandidateAssessment[];
  scope: PortableScope;
}

type PortableStageName = "inventory" | "threat-model" | "discovery" | "dataflow" | "validation";

interface PortableStageArtifact {
  schemaVersion: 1;
  stage: PortableStageName;
  summary: string;
  observations: [];
  scope?: PortableScope;
  candidates?: PortableCandidate[];
  assessments?: Array<Omit<PortableCandidateAssessment, "stage">>;
}

export interface PortableReportFinding {
  id: string;
  candidateId: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  category: string;
  summary: string;
  rootCause: string;
  impact: string;
  remediation: string;
  anchors: PortableCoverageAnchor[];
  cwe?: string[];
  severityRationale?: string;
}

export interface PortableReportCoverageEntry {
  candidateId: string;
  disposition: "reported" | "rejected";
  reason: string;
  evidence: PortableCoverageAnchor[];
}

export interface PortableReportArtifact {
  schemaVersion: 1;
  stage?: "report";
  findings: PortableReportFinding[];
  coverage: PortableScope & { candidates: PortableReportCoverageEntry[] };
}

export class PortableCodexSecurityDossierError extends Error {
  constructor(
    readonly reason: string,
    readonly issue?: PortableReportCoverageValidationIssue,
  ) {
    super(reason);
    this.name = "PortableCodexSecurityDossierError";
  }
}

/** Closed, safe reasons returned when the terminal report disagrees with the dossier. */
export type PortableReportCoverageValidationIssue =
  | "report-coverage-scope-incomplete"
  | "report-coverage-candidate-invalid"
  | "report-coverage-candidate-missing"
  | "report-candidate-assessment-inconclusive"
  | "report-coverage-disposition-invalid"
  | "report-coverage-reason-invalid"
  | "report-finding-candidate-invalid"
  | "report-finding-candidate-duplicate"
  | "report-finding-coverage-missing"
  | "report-finding-missing"
  | "report-finding-rejected";

export type PortableArtifactValidationIssue =
  | "path-or-stage-invalid"
  | "stage-envelope-invalid"
  | "stage-fields-invalid"
  | "stage-summary-invalid"
  | "stage-scope-invalid"
  | "stage-candidates-invalid"
  | "stage-assessments-invalid"
  | "stage-anchor-invalid"
  | "report-contract-invalid";

export interface PortableAnchorRangeViolation {
  path: string;
  requestedStartLine: number;
  requestedEndLine: number;
  maxLine: number;
}

export interface PortableAnchorRepairDetail {
  kind: "anchor-ranges-out-of-bounds";
  violations: PortableAnchorRangeViolation[];
}

export interface PortableCandidateRepairDetail {
  kind: "candidate-contract";
  reason: "array-or-limit" | "entry-keys" | "id" | "category" | "anchors" | "duplicate-id";
  itemIndex?: number;
}

export type PortableArtifactRepairDetail =
  | PortableAnchorRepairDetail
  | PortableCandidateRepairDetail;

export function createPortableCodexSecurityDossier(): PortableCodexSecurityDossier {
  return {
    schemaVersion: DOSSIER_SCHEMA_VERSION,
    stageSummaries: [],
    candidates: [],
    assessments: [],
    scope: { inspected: [], unexamined: [] },
  };
}

/**
 * Validates and canonicalizes the only model-writable Portable artifact shape.
 * The dossier deliberately retains only candidate ids, classification, and
 * repository anchors; it never forwards a prior model's source snippets or
 * free-form observations into the next provider session.
 */
export function normalizePortableCodexSecurityStageArtifact(
  artifactPath: unknown,
  value: unknown,
  snapshotRoot?: string,
  onReject?: (issue: PortableArtifactValidationIssue) => void,
  onRepairDetail?: (detail: PortableArtifactRepairDetail) => void,
): Record<string, unknown> | null {
  const reject = (issue: PortableArtifactValidationIssue): null => {
    onReject?.(issue);
    return null;
  };
  if (typeof artifactPath !== "string") return reject("path-or-stage-invalid");
  if (artifactPath === "sentinel-findings.json") {
    const report = parsePortableReportArtifact(value);
    if (report === null) return reject("report-contract-invalid");
    const resolution = portableArtifactAnchorsResolve(snapshotRoot, report);
    if (!resolution.ok) {
      if (resolution.detail !== undefined) onRepairDetail?.(resolution.detail);
      return reject("stage-anchor-invalid");
    }
    return report as unknown as Record<string, unknown>;
  }
  const expectedStage = stageForArtifact(artifactPath);
  if (expectedStage === null) return reject("path-or-stage-invalid");
  const artifact = parsePortableStageArtifact(value, expectedStage, onReject, onRepairDetail);
  if (artifact === null) return null;
  const resolution = portableArtifactAnchorsResolve(snapshotRoot, artifact);
  if (!resolution.ok) {
    if (resolution.detail !== undefined) onRepairDetail?.(resolution.detail);
    return reject("stage-anchor-invalid");
  }
  return artifact as unknown as Record<string, unknown>;
}

/**
 * Rejects an unverifiable Portable anchor before `results.write` reaches the
 * artifact host. Terminal artifact sessions can then return a recoverable
 * tool error to the provider instead of accepting an artifact that the
 * observer must reject after the session has ended.
 */
function portableArtifactAnchorsResolve(
  snapshotRoot: string | undefined,
  artifact: PortableStageArtifact | PortableReportArtifact,
): { ok: true } | { ok: false; detail?: PortableAnchorRepairDetail } {
  if (snapshotRoot === undefined) return { ok: true };
  const anchors = "findings" in artifact
    ? [
      ...artifact.findings.flatMap((finding) => finding.anchors),
      ...artifact.coverage.candidates.flatMap((coverage) => coverage.evidence),
    ]
    : [
      ...(artifact.candidates ?? []).flatMap((candidate) => candidate.anchors),
      ...(artifact.assessments ?? []).flatMap((assessment) => assessment.evidence),
    ];
  if (anchors.length === 0) return { ok: true };

  const root = path.resolve(snapshotRoot);
  const lineCounts = new Map<string, number>();
  const violations: PortableAnchorRangeViolation[] = [];
  let totalBytes = 0;
  try {
    const rootInfo = fs.lstatSync(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return { ok: false };
    for (const anchor of anchors) {
      const candidate = path.resolve(root, anchor.path);
      if (!isPathInside(root, candidate)) return { ok: false };
      let lines = lineCounts.get(candidate);
      if (lines === undefined) {
        if (lineCounts.size >= MAX_SNAPSHOT_ANCHOR_FILES) return { ok: false };
        const contents = readPinnedPortableAnchorFile(candidate, MAX_SNAPSHOT_ANCHOR_FILE_BYTES);
        if (contents === null) return { ok: false };
        totalBytes += contents.length;
        if (totalBytes > MAX_SNAPSHOT_ANCHOR_BYTES) return { ok: false };
        lines = countLines(contents);
        lineCounts.set(candidate, lines);
      }
      if (anchor.endLine > lines) {
        if (violations.length < 8) {
          violations.push({
            path: anchor.path,
            requestedStartLine: anchor.startLine,
            requestedEndLine: anchor.endLine,
            maxLine: lines,
          });
        }
      }
    }
    return violations.length === 0
      ? { ok: true }
      : { ok: false, detail: { kind: "anchor-ranges-out-of-bounds", violations } };
  } catch {
    return { ok: false };
  }
}

function readPinnedPortableAnchorFile(file: string, maxBytes: number): Buffer | null {
  let descriptor: number | undefined;
  try {
    const expected = fs.lstatSync(file);
    if (expected.isSymbolicLink() || !expected.isFile() || expected.size > maxBytes) return null;

    descriptor = fs.openSync(file, READ_NO_FOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!samePortableAnchorVersion(expected, opened) || !opened.isFile() ||
        opened.isSymbolicLink() || opened.size > maxBytes) return null;

    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    const afterOpen = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(file);
    if (offset !== contents.length || afterPath.isSymbolicLink() ||
        !samePortableAnchorVersion(opened, afterOpen) ||
        !samePortableAnchorVersion(opened, afterPath)) return null;
    return contents;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function samePortableAnchorVersion(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function countLines(contents: Buffer): number {
  if (contents.length === 0) return 0;
  let lines = 1;
  for (const value of contents) {
    if (value === 10) lines += 1;
  }
  return contents[contents.length - 1] === 10 ? lines - 1 : lines;
}

export function applyPortableCodexSecurityStageArtifact(
  dossier: PortableCodexSecurityDossier,
  value: unknown,
): PortableCodexSecurityDossier {
  const artifact = parsePortableStageArtifact(value);
  if (artifact === null) throw new PortableCodexSecurityDossierError("stage artifact is invalid");
  const next = cloneDossier(dossier);

  const priorSummary = next.stageSummaries.find((item) => item.stage === artifact.stage);
  if (priorSummary !== undefined && priorSummary.summary !== artifact.summary) {
    throw new PortableCodexSecurityDossierError("stage summary conflicts with existing dossier state");
  }
  if (priorSummary === undefined) next.stageSummaries.push({ stage: artifact.stage, summary: artifact.summary });

  if (artifact.scope !== undefined) {
    next.scope = mergeScope(next.scope, artifact.scope);
  }
  if (artifact.stage === "discovery") {
    for (const candidate of artifact.candidates ?? []) {
      const existing = next.candidates.find((item) => item.id === candidate.id);
      if (existing !== undefined) {
        if (!sameCandidate(existing, candidate)) {
          throw new PortableCodexSecurityDossierError("candidate id conflicts with existing dossier state");
        }
        continue;
      }
      if (next.candidates.length >= MAX_CANDIDATES) {
        throw new PortableCodexSecurityDossierError("candidate dossier limit exceeded");
      }
      next.candidates.push(copyCandidate(candidate));
    }
  }
  for (const assessment of artifact.assessments ?? []) {
    if (!next.candidates.some((candidate) => candidate.id === assessment.candidateId)) {
      throw new PortableCodexSecurityDossierError("assessment references an unknown candidate");
    }
    const existing = next.assessments.find((item) =>
      item.candidateId === assessment.candidateId && item.stage === artifact.stage
    );
    if (existing !== undefined) {
      if (!sameAssessment(existing, assessment)) {
        throw new PortableCodexSecurityDossierError("candidate assessment conflicts with existing dossier state");
      }
      continue;
    }
    if (next.assessments.length >= MAX_ASSESSMENTS) {
      throw new PortableCodexSecurityDossierError("assessment dossier limit exceeded");
    }
    next.assessments.push({ ...copyAssessment(assessment), stage: artifact.stage as "dataflow" | "validation" });
  }
  assertDossierBounds(next);
  return next;
}

/** Validates the final report against the server-owned cross-stage dossier. */
export function validatePortableCodexSecurityReportCoverage(
  value: unknown,
  dossier: PortableCodexSecurityDossier,
): PortableReportArtifact {
  const report = parsePortableReportArtifact(value);
  if (report === null) throw new PortableCodexSecurityDossierError("report artifact is invalid");
  assertDossierBounds(dossier);
  if (report.coverage.inspected.length === 0) {
    throw new PortableCodexSecurityDossierError("coverage must declare inspected scope");
  }

  const reportInspected = new Set(report.coverage.inspected);
  const reportUnexamined = new Set(report.coverage.unexamined.map(scopeKey));
  if (dossier.scope.inspected.some((entry) => !reportInspected.has(entry)) ||
      dossier.scope.unexamined.some((entry) => !reportUnexamined.has(scopeKey(entry)))) {
    throw new PortableCodexSecurityDossierError(
      "coverage scope is incomplete",
      "report-coverage-scope-incomplete",
    );
  }

  const carriedCandidateIds = new Set(dossier.candidates.map((candidate) => candidate.id));
  const coverageByCandidate = new Map<string, PortableReportCoverageEntry>();
  for (const coverage of report.coverage.candidates) {
    if (!carriedCandidateIds.has(coverage.candidateId) || coverageByCandidate.has(coverage.candidateId)) {
      throw new PortableCodexSecurityDossierError(
        "coverage references an unknown or duplicate candidate",
        "report-coverage-candidate-invalid",
      );
    }
    coverageByCandidate.set(coverage.candidateId, coverage);
  }
  if (coverageByCandidate.size !== carriedCandidateIds.size) {
    throw new PortableCodexSecurityDossierError(
      "candidate coverage is incomplete",
      "report-coverage-candidate-missing",
    );
  }

  const decisiveAssessments = new Map<string, PortableCandidateAssessment>();
  for (const assessment of dossier.assessments) {
    const current = decisiveAssessments.get(assessment.candidateId);
    if (current === undefined || assessment.stage === "validation") {
      decisiveAssessments.set(assessment.candidateId, assessment);
    }
  }
  for (const candidateId of carriedCandidateIds) {
    const assessment = decisiveAssessments.get(candidateId);
    if (assessment === undefined || assessment.status === "inconclusive") {
      throw new PortableCodexSecurityDossierError(
        "candidate has no conclusive assessment",
        "report-candidate-assessment-inconclusive",
      );
    }
    const coverage = coverageByCandidate.get(candidateId)!;
    if (assessment.status === "confirmed" && coverage.disposition !== "reported") {
      throw new PortableCodexSecurityDossierError(
        "confirmed candidate must be reported",
        "report-coverage-disposition-invalid",
      );
    }
    if (assessment.status === "rejected" && coverage.disposition !== "rejected") {
      throw new PortableCodexSecurityDossierError(
        "rejected candidate cannot be reported",
        "report-coverage-disposition-invalid",
      );
    }
    if (coverage.reason !== assessment.reason) {
      throw new PortableCodexSecurityDossierError(
        "candidate coverage must preserve the conclusive assessment reason",
        "report-coverage-reason-invalid",
      );
    }
  }

  const findingIds = new Set<string>();
  const reportedCandidates = new Set<string>();
  for (const finding of report.findings) {
    if (findingIds.has(finding.id) || !carriedCandidateIds.has(finding.candidateId)) {
      throw new PortableCodexSecurityDossierError(
        "finding is not backed by a unique carried candidate",
        "report-finding-candidate-invalid",
      );
    }
    findingIds.add(finding.id);
    if (reportedCandidates.has(finding.candidateId)) {
      throw new PortableCodexSecurityDossierError(
        "candidate may produce only one report finding",
        "report-finding-candidate-duplicate",
      );
    }
    reportedCandidates.add(finding.candidateId);
    if (coverageByCandidate.get(finding.candidateId)?.disposition !== "reported") {
      throw new PortableCodexSecurityDossierError(
        "reported finding is missing matching coverage",
        "report-finding-coverage-missing",
      );
    }
  }
  for (const [candidateId, coverage] of coverageByCandidate) {
    if (coverage.disposition === "reported" && !reportedCandidates.has(candidateId)) {
      throw new PortableCodexSecurityDossierError(
        "reported coverage is missing its finding",
        "report-finding-missing",
      );
    }
    if (coverage.disposition === "rejected" && reportedCandidates.has(candidateId)) {
      throw new PortableCodexSecurityDossierError(
        "rejected candidate cannot also be a finding",
        "report-finding-rejected",
      );
    }
  }
  return report;
}

export function writePortableCodexSecurityDossier(
  resultsDir: string,
  dossier: PortableCodexSecurityDossier,
): void {
  assertDossierBounds(dossier);
  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  const target = path.join(resultsDir, PORTABLE_CODEX_SECURITY_DOSSIER_FILE);
  const serialized = `${JSON.stringify(dossier)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_DOSSIER_BYTES) {
    throw new PortableCodexSecurityDossierError("dossier byte limit exceeded");
  }
  fs.writeFileSync(target, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

export function readPortableCodexSecurityDossier(resultsDir: string): PortableCodexSecurityDossier | null {
  const target = path.join(resultsDir, PORTABLE_CODEX_SECURITY_DOSSIER_FILE);
  let info: fs.Stats;
  try {
    info = fs.lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > MAX_DOSSIER_BYTES) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
    const dossier = parseDossier(parsed);
    if (dossier === null) return null;
    assertDossierBounds(dossier);
    return dossier;
  } catch {
    return null;
  }
}

export function portableCodexSecurityDossierBase64(
  dossier: PortableCodexSecurityDossier,
): string {
  assertDossierBounds(dossier);
  const serialized = JSON.stringify(dossier);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DOSSIER_BYTES) {
    throw new PortableCodexSecurityDossierError("dossier byte limit exceeded");
  }
  return Buffer.from(serialized, "utf8").toString("base64");
}

function parsePortableStageArtifact(
  value: unknown,
  expectedStage?: PortableStageName,
  onReject?: (issue: PortableArtifactValidationIssue) => void,
  onRepairDetail?: (detail: PortableArtifactRepairDetail) => void,
): PortableStageArtifact | null {
  const reject = (issue: PortableArtifactValidationIssue): null => {
    onReject?.(issue);
    return null;
  };
  const record = asRecord(value);
  if (record === null || record.schemaVersion !== 1 || !isStage(record.stage) ||
      (expectedStage !== undefined && record.stage !== expectedStage)) return reject("stage-envelope-invalid");
  const narrativeStage = record.stage === "inventory" || record.stage === "threat-model";
  if (!narrativeStage && !hasOnlyKeys(record, new Set([
    "schemaVersion", "stage", "summary", "observations", "scope", "candidates", "assessments",
  ]))) return reject("stage-fields-invalid");
  const summary = text(record.summary, MAX_STAGE_SUMMARY_BYTES);
  if (summary === null || !Array.isArray(record.observations) || record.observations.length > 128) {
    return reject("stage-summary-invalid");
  }
  const scope = record.scope === undefined ? undefined : parseScope(record.scope, narrativeStage);
  if (record.scope !== undefined && scope === null) return reject("stage-scope-invalid");
  const candidateProducingStage = record.stage === "discovery";
  const candidateResolution = !candidateProducingStage || record.candidates === undefined
    ? { value: undefined }
    : parseCandidatesWithRepair(record.candidates);
  const candidates = candidateResolution.value;
  if (candidateProducingStage && record.candidates !== undefined && candidates === null) {
    if (candidateResolution.detail !== undefined) onRepairDetail?.(candidateResolution.detail);
    return reject("stage-candidates-invalid");
  }
  const assessments = narrativeStage || record.assessments === undefined
    ? undefined
    : parseAssessments(record.assessments);
  if (!narrativeStage && record.assessments !== undefined && assessments === null) {
    return reject("stage-assessments-invalid");
  }
  if (!CANDIDATE_STAGES.has(record.stage) && (candidates?.length ?? 0) > 0) {
    return reject("stage-candidates-invalid");
  }
  if (!ASSESSMENT_STAGES.has(record.stage) && (assessments?.length ?? 0) > 0) {
    return reject("stage-assessments-invalid");
  }
  const normalizedScope = scope === null ? undefined : scope;
  const normalizedCandidates = candidates === null ? undefined : candidates;
  const normalizedAssessments = assessments === null ? undefined : assessments;
  return {
    schemaVersion: 1,
    stage: record.stage,
    summary,
    observations: [],
    ...(normalizedScope === undefined ? {} : { scope: normalizedScope }),
    ...(normalizedCandidates === undefined ? {} : { candidates: normalizedCandidates }),
    ...(normalizedAssessments === undefined ? {} : { assessments: normalizedAssessments }),
  };
}

function parsePortableReportArtifact(value: unknown): PortableReportArtifact | null {
  const record = asRecord(value);
  if (record === null || record.schemaVersion !== 1 ||
      (record.stage !== undefined && record.stage !== "report") ||
      !hasOnlyKeys(record, new Set(["schemaVersion", "stage", "findings", "coverage"]))) return null;
  const findings = parseFindings(record.findings);
  const coverageRecord = asRecord(record.coverage);
  if (findings === null || coverageRecord === null ||
      !hasOnlyKeys(coverageRecord, new Set(["inspected", "unexamined", "candidates"]))) return null;
  const scope = parseScope({
    inspected: coverageRecord.inspected,
    unexamined: coverageRecord.unexamined,
  });
  const candidates = parseCoverageEntries(coverageRecord.candidates);
  if (scope === null || candidates === null) return null;
  return {
    schemaVersion: 1,
    ...(record.stage === undefined ? {} : { stage: "report" as const }),
    findings,
    coverage: { ...scope, candidates },
  };
}

function parseDossier(value: unknown): PortableCodexSecurityDossier | null {
  const record = asRecord(value);
  if (record === null || record.schemaVersion !== DOSSIER_SCHEMA_VERSION ||
      !hasOnlyKeys(record, new Set(["schemaVersion", "stageSummaries", "candidates", "assessments", "scope"]))) return null;
  const stageSummaries = parseStageSummaries(record.stageSummaries);
  const candidates = parseCandidates(record.candidates);
  const assessments = parseStoredAssessments(record.assessments);
  const scope = parseScope(record.scope);
  if (stageSummaries === null || candidates === null || assessments === null || scope === null) return null;
  return { schemaVersion: DOSSIER_SCHEMA_VERSION, stageSummaries, candidates, assessments, scope };
}

function parseStageSummaries(value: unknown): PortableStageSummary[] | null {
  if (!Array.isArray(value) || value.length > STAGE_NAMES.size) return null;
  const stages = new Set<string>();
  const summaries: PortableStageSummary[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === null || !hasOnlyKeys(record, new Set(["stage", "summary"]))) return null;
    const stage = enumValue(record.stage, STAGE_NAMES);
    const summary = text(record.summary, MAX_STAGE_SUMMARY_BYTES);
    if (stage === null || summary === null || stages.has(stage)) return null;
    stages.add(stage);
    summaries.push({ stage: stage as PortableStageSummary["stage"], summary });
  }
  return summaries;
}

function parseCandidates(value: unknown): PortableCandidate[] | null {
  return parseCandidatesWithRepair(value).value;
}

function parseCandidatesWithRepair(
  value: unknown,
): { value: PortableCandidate[] | null; detail?: PortableCandidateRepairDetail } {
  if (!Array.isArray(value) || value.length > MAX_CANDIDATES) {
    return { value: null, detail: { kind: "candidate-contract", reason: "array-or-limit" } };
  }
  const ids = new Set<string>();
  const candidates: PortableCandidate[] = [];
  for (const [itemIndex, item] of value.entries()) {
    const record = asRecord(item);
    if (record === null || !hasOnlyKeys(record, new Set(["id", "category", "anchors"]))) {
      return { value: null, detail: { kind: "candidate-contract", reason: "entry-keys", itemIndex } };
    }
    const id = identifier(record.id);
    const category = text(record.category, MAX_TEXT_BYTES);
    const anchors = parseAnchors(record.anchors, false);
    if (id === null) return { value: null, detail: { kind: "candidate-contract", reason: "id", itemIndex } };
    if (category === null) return { value: null, detail: { kind: "candidate-contract", reason: "category", itemIndex } };
    if (anchors === null) return { value: null, detail: { kind: "candidate-contract", reason: "anchors", itemIndex } };
    if (ids.has(id)) return { value: null, detail: { kind: "candidate-contract", reason: "duplicate-id", itemIndex } };
    ids.add(id);
    candidates.push({ id, category, anchors });
  }
  return { value: candidates };
}

function parseAssessments(
  value: unknown,
): Array<Omit<PortableCandidateAssessment, "stage">> | null {
  if (!Array.isArray(value) || value.length > MAX_ASSESSMENTS) return null;
  const assessments: Array<Omit<PortableCandidateAssessment, "stage">> = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === null || !hasOnlyKeys(record, new Set(["candidateId", "status", "reason", "evidence"]))) return null;
    const candidateId = identifier(record.candidateId);
    const status = enumValue(record.status, ASSESSMENT_STATUSES);
    const reason = enumValue(record.reason, COVERAGE_REASONS);
    const evidence = parseAnchors(record.evidence, false);
    if (candidateId === null || status === null || reason === null || evidence === null || evidence.length === 0) return null;
    assessments.push({ candidateId, status: status as PortableCandidateAssessment["status"], reason, evidence });
  }
  return assessments;
}

function parseStoredAssessments(value: unknown): PortableCandidateAssessment[] | null {
  if (!Array.isArray(value) || value.length > MAX_ASSESSMENTS) return null;
  const assessments: PortableCandidateAssessment[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === null || !hasOnlyKeys(record, new Set(["candidateId", "stage", "status", "reason", "evidence"]))) return null;
    const candidateId = identifier(record.candidateId);
    const stage = enumValue(record.stage, ASSESSMENT_STAGES);
    const status = enumValue(record.status, ASSESSMENT_STATUSES);
    const reason = enumValue(record.reason, COVERAGE_REASONS);
    const evidence = parseAnchors(record.evidence, false);
    if (candidateId === null || stage === null || status === null || reason === null || evidence === null || evidence.length === 0) return null;
    assessments.push({
      candidateId,
      stage: stage as PortableCandidateAssessment["stage"],
      status: status as PortableCandidateAssessment["status"],
      reason,
      evidence,
    });
  }
  return assessments;
}

function parseScope(value: unknown, narrative = false): PortableScope | null {
  const record = asRecord(value);
  if (record === null || (!narrative && !hasOnlyKeys(record, new Set(["inspected", "unexamined"])))) return null;
  if (!Array.isArray(record.inspected) || record.inspected.length > MAX_SCOPE_ENTRIES ||
      !Array.isArray(record.unexamined) || record.unexamined.length > MAX_SCOPE_ENTRIES) return null;
  const inspected: string[] = [];
  const inspectedSet = new Set<string>();
  for (const item of record.inspected) {
    const target = scopePath(item);
    if (target === null) return null;
    if (inspectedSet.has(target)) continue;
    inspectedSet.add(target);
    inspected.push(target);
  }
  const unexamined: Array<{ path: string; reason: string }> = [];
  const unexaminedSet = new Set<string>();
  for (const item of record.unexamined) {
    const entry = asRecord(item);
    if (!narrative && (entry === null || !hasOnlyKeys(entry, new Set(["path", "reason"])))) return null;
    const target = scopePath(typeof item === "string" && narrative ? item : entry?.path);
    const declaredReason = entry === null ? null : enumValue(entry.reason, COVERAGE_REASONS);
    const reason = declaredReason ?? (narrative ? "insufficient-evidence" : null);
    const key = target === null || reason === null ? null : `${target}\u0000${reason}`;
    if (target === null || reason === null || key === null) return null;
    if (unexaminedSet.has(key)) continue;
    unexaminedSet.add(key);
    unexamined.push({ path: target, reason });
  }
  return { inspected, unexamined };
}

function parseCoverageEntries(value: unknown): PortableReportCoverageEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_CANDIDATES) return null;
  const entries: PortableReportCoverageEntry[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === null || !hasOnlyKeys(record, new Set(["candidateId", "disposition", "reason", "evidence"]))) return null;
    const candidateId = identifier(record.candidateId);
    const disposition = enumValue(record.disposition, COVERAGE_DISPOSITIONS);
    const reason = enumValue(record.reason, COVERAGE_REASONS);
    const evidence = parseAnchors(record.evidence, false);
    if (candidateId === null || disposition === null || reason === null || evidence === null || evidence.length === 0) return null;
    entries.push({
      candidateId,
      disposition: disposition as PortableReportCoverageEntry["disposition"],
      reason,
      evidence,
    });
  }
  return entries;
}

function parseFindings(value: unknown): PortableReportFinding[] | null {
  if (!Array.isArray(value) || value.length > MAX_CANDIDATES) return null;
  const findings: PortableReportFinding[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === null || !hasOnlyKeys(record, new Set([
      "id", "candidateId", "title", "severity", "confidence", "category", "summary", "rootCause",
      "impact", "remediation", "anchors", "cwe", "severityRationale",
    ]))) return null;
    const id = identifier(record.id);
    const candidateId = identifier(record.candidateId);
    const title = substantiveText(record.title, MAX_STAGE_SUMMARY_BYTES * 2);
    const severity = enumValue(record.severity, SEVERITIES);
    const confidence = enumValue(record.confidence, CONFIDENCES);
    const category = text(record.category, MAX_TEXT_BYTES);
    const summary = substantiveText(record.summary, MAX_STAGE_SUMMARY_BYTES);
    const rootCause = substantiveText(record.rootCause, MAX_STAGE_SUMMARY_BYTES);
    const impact = substantiveText(record.impact, MAX_STAGE_SUMMARY_BYTES);
    const remediation = substantiveText(record.remediation, MAX_STAGE_SUMMARY_BYTES);
    const anchors = parseAnchors(record.anchors, true);
    const cwe = record.cwe === undefined ? undefined : parseCwe(record.cwe);
    const severityRationale = record.severityRationale === undefined
      ? undefined
      : text(record.severityRationale, MAX_STAGE_SUMMARY_BYTES);
    if (id === null || candidateId === null || title === null || severity === null || confidence === null ||
        category === null || summary === null || rootCause === null || impact === null || remediation === null ||
        anchors === null || anchors.length === 0 || cwe === null ||
        (record.severityRationale !== undefined && severityRationale === null)) return null;
    const normalizedSeverityRationale = severityRationale === null ? undefined : severityRationale;
    findings.push({
      id,
      candidateId,
      title,
      severity: severity as PortableReportFinding["severity"],
      confidence: confidence as PortableReportFinding["confidence"],
      category,
      summary,
      rootCause,
      impact,
      remediation,
      anchors,
      ...(cwe === undefined ? {} : { cwe }),
      ...(normalizedSeverityRationale === undefined ? {} : { severityRationale: normalizedSeverityRationale }),
    });
  }
  return findings;
}

function parseCwe(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const entries: string[] = [];
  for (const item of value) {
    const candidate = text(item, 64);
    if (candidate === null || !/^CWE-\d+$/i.test(candidate)) return null;
    entries.push(candidate);
  }
  return entries;
}

function parseAnchors(value: unknown, requireExplanation: boolean): PortableCoverageAnchor[] | null {
  if (!Array.isArray(value) || value.length > MAX_ANCHORS) return null;
  const anchors: PortableCoverageAnchor[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === null || !hasOnlyKeys(record, new Set(["path", "startLine", "endLine", "role", "explanation"]))) return null;
    const anchorPath = repositoryPath(record.path);
    const startLine = positiveInteger(record.startLine);
    const endLine = positiveInteger(record.endLine);
    const role = enumValue(record.role, ANCHOR_ROLES);
    const explanation = record.explanation === undefined
      ? undefined
      : requireExplanation
        ? substantiveText(record.explanation, MAX_TEXT_BYTES)
        : text(record.explanation, MAX_TEXT_BYTES);
    if (anchorPath === null || startLine === null || endLine === null || endLine < startLine || role === null ||
        (requireExplanation && explanation === undefined) ||
        (record.explanation !== undefined && explanation === null)) return null;
    const normalizedExplanation = explanation === null ? undefined : explanation;
    anchors.push({
      path: anchorPath,
      startLine,
      endLine,
      role: role as PortableCoverageAnchor["role"],
      ...(normalizedExplanation === undefined ? {} : { explanation: normalizedExplanation }),
    });
  }
  return anchors;
}

function cloneDossier(dossier: PortableCodexSecurityDossier): PortableCodexSecurityDossier {
  const parsed = parseDossier(dossier);
  if (parsed === null) throw new PortableCodexSecurityDossierError("dossier is invalid");
  return {
    schemaVersion: DOSSIER_SCHEMA_VERSION,
    stageSummaries: parsed.stageSummaries.map((item) => ({ ...item })),
    candidates: parsed.candidates.map(copyCandidate),
    assessments: parsed.assessments.map(copyAssessment),
    scope: {
      inspected: [...parsed.scope.inspected],
      unexamined: parsed.scope.unexamined.map((item) => ({ ...item })),
    },
  };
}

function mergeScope(current: PortableScope, incoming: PortableScope): PortableScope {
  const inspected = [...current.inspected];
  const inspectedSet = new Set(inspected);
  for (const target of incoming.inspected) {
    if (!inspectedSet.has(target)) {
      if (inspected.length >= MAX_SCOPE_ENTRIES) throw new PortableCodexSecurityDossierError("inspected scope limit exceeded");
      inspectedSet.add(target);
      inspected.push(target);
    }
  }
  const unexamined = current.unexamined.map((item) => ({ ...item }));
  const unexaminedSet = new Set(unexamined.map(scopeKey));
  for (const item of incoming.unexamined) {
    const key = scopeKey(item);
    if (!unexaminedSet.has(key)) {
      if (unexamined.length >= MAX_SCOPE_ENTRIES) throw new PortableCodexSecurityDossierError("unexamined scope limit exceeded");
      unexaminedSet.add(key);
      unexamined.push({ ...item });
    }
  }
  return { inspected, unexamined };
}

function assertDossierBounds(dossier: PortableCodexSecurityDossier): void {
  const parsed = parseDossier(dossier);
  if (parsed === null) throw new PortableCodexSecurityDossierError("dossier is invalid");
  const candidateIds = new Set(parsed.candidates.map((candidate) => candidate.id));
  if (parsed.assessments.some((assessment) => !candidateIds.has(assessment.candidateId))) {
    throw new PortableCodexSecurityDossierError("assessment references an unknown candidate");
  }
  const serialized = JSON.stringify(parsed);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DOSSIER_BYTES) {
    throw new PortableCodexSecurityDossierError("dossier byte limit exceeded");
  }
}

function copyCandidate(candidate: PortableCandidate): PortableCandidate {
  return { ...candidate, anchors: candidate.anchors.map(copyAnchor) };
}

function sameCandidate(left: PortableCandidate, right: PortableCandidate): boolean {
  return left.category === right.category && JSON.stringify(left.anchors) === JSON.stringify(right.anchors);
}

function sameAssessment(
  left: PortableCandidateAssessment,
  right: Omit<PortableCandidateAssessment, "stage">,
): boolean {
  return left.status === right.status && left.reason === right.reason &&
    JSON.stringify(left.evidence) === JSON.stringify(right.evidence);
}

function copyAssessment(assessment: Omit<PortableCandidateAssessment, "stage">): Omit<PortableCandidateAssessment, "stage">;
function copyAssessment(assessment: PortableCandidateAssessment): PortableCandidateAssessment;
function copyAssessment(
  assessment: PortableCandidateAssessment | Omit<PortableCandidateAssessment, "stage">,
): PortableCandidateAssessment | Omit<PortableCandidateAssessment, "stage"> {
  return { ...assessment, evidence: assessment.evidence.map(copyAnchor) };
}

function copyAnchor(anchor: PortableCoverageAnchor): PortableCoverageAnchor {
  return { ...anchor };
}

function stageForArtifact(pathname: string): PortableStageName | null {
  if (pathname === "01-inventory.json") return "inventory";
  if (pathname === "02-threat-model.json") return "threat-model";
  if (pathname === "03-discovery.json") return "discovery";
  if (pathname === "04-dataflow.json") return "dataflow";
  if (pathname === "05-validation.json") return "validation";
  return null;
}

function isStage(value: unknown): value is PortableStageName {
  return typeof value === "string" && STAGE_NAMES.has(value);
}

function scopeKey(value: { path: string; reason: string }): string {
  return `${value.path}\u0000${value.reason}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown, maxBytes: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\u0000") &&
    Buffer.byteLength(value, "utf8") <= maxBytes
    ? value.trim()
    : null;
}

function substantiveText(value: unknown, maxBytes: number): string | null {
  const normalized = text(value, maxBytes);
  return normalized !== null && Buffer.byteLength(normalized, "utf8") >= MIN_SUBSTANTIVE_TEXT_BYTES
    ? normalized
    : null;
}

function identifier(value: unknown): string | null {
  const normalized = text(value, 256);
  return normalized !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
    ? normalized
    : null;
}

function repositoryPath(value: unknown): string | null {
  const normalized = text(value, MAX_TEXT_BYTES)?.replaceAll("\\", "/");
  if (normalized === undefined || normalized === null || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  return normalized.split("/").some((part) => part === "" || part === "." || part === "..")
    ? null
    : normalized;
}

function scopePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let normalized = value.trim().replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized === "." || normalized === "" ? (normalized === "." ? "." : null) : repositoryPath(normalized);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function enumValue(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}
