import fs from "node:fs";
import path from "node:path";
import type {
  AiVerdict, AiVerdictCitation, AiVerdictMissingEvidence, AiVerdictStatus, ScanAiVerdicts, ScanRun,
} from "@csb/shared";

import { globalSecretRedactor, type SecretRedactor } from "../redaction.js";
import {
  portableConfirmationGap,
  readPortableCodexSecurityDossier,
  type PortableCandidate,
  type PortableCandidateAssessment,
  type PortableCodexSecurityDossier,
  type PortableCoverageAnchor,
} from "./portable-codex-security-dossier.js";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_EXCERPT_LINES = 12;
const MAX_EXCERPT_LINE_CHARS = 240;
const READ_NO_FOLLOW = fs.constants.O_RDONLY | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0);

export const PORTABLE_CODEX_SECURITY_RESULTS_DIR = "portable-codex-security-results";
export const PORTABLE_CODEX_SECURITY_SNAPSHOT_DIR = "portable-codex-security-snapshot";

const CONFIRMATION_GAPS: Record<string, AiVerdictMissingEvidence["code"][]> = {
  "confirmation-reason": ["confirmation-reason"],
  "candidate-path-missing": ["candidate-path-missing"],
  "control-roles-missing": ["control-missing"],
};

type SnapshotReader = (relativePath: string) => { lines: string[] } | { problem: AiVerdictCitation["problem"] };

function snapshotReader(snapshotRoot: string | undefined): { available: boolean; read: SnapshotReader } {
  let root: string | undefined;
  try {
    if (snapshotRoot !== undefined && fs.lstatSync(snapshotRoot).isDirectory()) root = fs.realpathSync(snapshotRoot);
  } catch { root = undefined; }
  const cache = new Map<string, ReturnType<SnapshotReader>>();
  const read: SnapshotReader = (relativePath) => {
    if (root === undefined) return { problem: "snapshot-unavailable" };
    const cached = cache.get(relativePath);
    if (cached !== undefined) return cached;
    let result: ReturnType<SnapshotReader>;
    const target = path.resolve(root, relativePath);
    const relative = path.relative(root, target);
    if (path.isAbsolute(relativePath) || relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      result = { problem: "unsafe-path" };
    } else {
      let fd: number | undefined;
      try {
        // Reject symlinked files or parents: a citation must name the snapshot file itself.
        if (fs.realpathSync(target) !== target) throw new Error("indirect");
        fd = fs.openSync(target, READ_NO_FOLLOW);
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.size > MAX_SOURCE_BYTES) throw new Error("not a bounded file");
        const text = fs.readFileSync(fd, "utf8");
        const lines = text.split(/\r?\n/);
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        result = { lines };
      } catch { result = { problem: "file-missing" }; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    cache.set(relativePath, result);
    return result;
  };
  return { available: root !== undefined, read };
}

function checkCitation(anchor: PortableCoverageAnchor, read: SnapshotReader, redactor: SecretRedactor): AiVerdictCitation {
  const base: AiVerdictCitation = {
    path: anchor.path, startLine: anchor.startLine, endLine: anchor.endLine, role: anchor.role,
    ...(anchor.explanation === undefined ? {} : { explanation: anchor.explanation }), valid: false,
  };
  const source = read(anchor.path);
  if ("problem" in source) return { ...base, problem: source.problem };
  if (!Number.isInteger(anchor.startLine) || !Number.isInteger(anchor.endLine) || anchor.startLine < 1 ||
      anchor.endLine < anchor.startLine || anchor.endLine > source.lines.length) {
    return { ...base, problem: "lines-out-of-range" };
  }
  const excerpt = source.lines
    .slice(anchor.startLine - 1, Math.min(anchor.endLine, anchor.startLine - 1 + MAX_EXCERPT_LINES))
    .map((line) => line.length > MAX_EXCERPT_LINE_CHARS ? `${line.slice(0, MAX_EXCERPT_LINE_CHARS)}…` : line)
    .join("\n");
  return { ...base, valid: true, excerpt: redactor.redactText(excerpt) };
}

function decisiveAssessments(dossier: PortableCodexSecurityDossier): Map<string, PortableCandidateAssessment> {
  const decisive = new Map<string, PortableCandidateAssessment>();
  for (const assessment of dossier.assessments) {
    if (!decisive.has(assessment.candidateId) || assessment.stage === "validation") decisive.set(assessment.candidateId, assessment);
  }
  return decisive;
}

/**
 * Mechanical (not semantic) verdict gate: a TP or FP stands only with a claim and
 * citations that resolve to existing snapshot lines; a TP must also cite how
 * untrusted input reaches the sink or missing control. Anything else is inconclusive.
 */
export function gatePortableCodexSecurityVerdict(
  candidate: PortableCandidate,
  assessment: PortableCandidateAssessment | undefined,
  read: SnapshotReader,
  redactor: SecretRedactor = globalSecretRedactor,
): AiVerdict {
  const base = { candidateId: candidate.id, category: candidate.category, hypothesis: candidate.hypothesis ?? "" };
  if (assessment === undefined) {
    return { ...base, status: "inconclusive", proposedStatus: null, downgraded: false, legacy: false, reason: null, claim: null,
      citations: [], missingEvidence: [{ code: "assessment-missing" }] };
  }
  const citations = assessment.evidence.map((anchor) => checkCitation(anchor, read, redactor));
  const legacy = assessment.claim === undefined && assessment.missingEvidence === undefined;
  const missing: AiVerdictMissingEvidence[] = [];
  if (assessment.status === "inconclusive") {
    for (const detail of assessment.missingEvidence ?? []) missing.push({ code: "ai-declared", detail });
    if (missing.length === 0) missing.push({ code: "ai-undeclared" });
  } else {
    if (assessment.claim === undefined) missing.push({ code: "claim-missing" });
    if (citations.some((citation) => citation.problem === "snapshot-unavailable")) missing.push({ code: "snapshot-unavailable" });
    for (const citation of citations) {
      if (!citation.valid && citation.problem !== "snapshot-unavailable") {
        missing.push({ code: "citation-invalid", detail: `${citation.path}:${citation.startLine}-${citation.endLine}` });
      }
    }
    const valid = assessment.evidence.filter((_, index) => citations[index]!.valid);
    if (valid.length === 0 && !missing.some((item) => item.code === "snapshot-unavailable")) missing.push({ code: "citation-missing" });
    if (assessment.status === "confirmed" && valid.length > 0) {
      const gap = portableConfirmationGap(candidate, { ...assessment, evidence: valid });
      if (gap === "flow-roles-missing") {
        const roles = new Set(valid.map((anchor) => anchor.role));
        if (!roles.has("source") && !roles.has("entrypoint")) missing.push({ code: "entry-missing" });
        if (!roles.has("sink")) missing.push({ code: "sink-missing" });
      } else if (gap !== undefined) {
        for (const code of CONFIRMATION_GAPS[gap] ?? []) missing.push({ code });
      }
    }
  }
  const status: AiVerdictStatus = missing.length === 0 ? assessment.status : "inconclusive";
  return {
    ...base, status, proposedStatus: assessment.status, downgraded: status !== assessment.status, legacy,
    reason: assessment.reason, claim: assessment.claim ?? null, citations, missingEvidence: status === "inconclusive" ? missing : [],
  };
}

export function gatePortableCodexSecurityVerdicts(
  dossier: PortableCodexSecurityDossier,
  snapshotRoot: string | undefined,
  redactor: SecretRedactor = globalSecretRedactor,
): { snapshotAvailable: boolean; verdicts: AiVerdict[] } {
  const reader = snapshotReader(snapshotRoot);
  const assessments = decisiveAssessments(dossier);
  return {
    snapshotAvailable: reader.available,
    verdicts: dossier.candidates.map((candidate) =>
      gatePortableCodexSecurityVerdict(candidate, assessments.get(candidate.id), reader.read, redactor)),
  };
}

/** Recomputed from the retained dossier and snapshot, so scans that predate this gate are covered too. */
export function scanAiVerdicts(scan: ScanRun): ScanAiVerdicts {
  const result: ScanAiVerdicts = {
    scanId: scan.id, available: false, snapshotAvailable: false,
    counts: { confirmed: 0, rejected: 0, inconclusive: 0, downgraded: 0, legacy: 0 }, verdicts: [],
  };
  if (scan.engine !== "codex-security" || scan.execution?.executionProfile !== "portable") return result;
  let dossier: PortableCodexSecurityDossier | null = null;
  try { dossier = readPortableCodexSecurityDossier(path.join(scan.scanDir, PORTABLE_CODEX_SECURITY_RESULTS_DIR)); }
  catch { dossier = null; }
  if (dossier === null) return result;
  const gated = gatePortableCodexSecurityVerdicts(dossier, path.join(scan.scanDir, PORTABLE_CODEX_SECURITY_SNAPSHOT_DIR));
  result.available = true;
  result.snapshotAvailable = gated.snapshotAvailable;
  result.verdicts = gated.verdicts;
  for (const verdict of gated.verdicts) {
    result.counts[verdict.status] += 1;
    if (verdict.downgraded) result.counts.downgraded += 1;
    if (verdict.legacy) result.counts.legacy += 1;
  }
  return result;
}
