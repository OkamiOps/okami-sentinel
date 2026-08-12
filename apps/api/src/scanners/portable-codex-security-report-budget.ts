import { MAX_AGENT_SESSION_COMPLETION_TOKENS } from "../agent/session-types.js";
import type { PortableCodexSecurityDossier } from "./portable-codex-security-dossier.js";

const PORTABLE_REPORT_BASE_COMPLETION_TOKENS = 8_192;
const PORTABLE_REPORT_COVERAGE_COMPLETION_TOKENS = 128;
const PORTABLE_REPORT_CONFIRMED_FINDING_COMPLETION_TOKENS = 512;

/**
 * Reserves enough response room for each coverage record and each finding the
 * server-owned dossier requires. It is independent of provider/model identity.
 */
export function portableCodexSecurityReportCompletionTokens(
  dossier: PortableCodexSecurityDossier,
): number {
  const decisiveAssessments = new Map<string, "confirmed" | "rejected" | "inconclusive">();
  for (const assessment of dossier.assessments) {
    if (!decisiveAssessments.has(assessment.candidateId) || assessment.stage === "validation") {
      decisiveAssessments.set(assessment.candidateId, assessment.status);
    }
  }
  const confirmedFindings = dossier.candidates.reduce(
    (total, candidate) => total + (decisiveAssessments.get(candidate.id) === "confirmed" ? 1 : 0),
    0,
  );
  const lowerBound = PORTABLE_REPORT_BASE_COMPLETION_TOKENS +
    dossier.candidates.length * PORTABLE_REPORT_COVERAGE_COMPLETION_TOKENS +
    confirmedFindings * PORTABLE_REPORT_CONFIRMED_FINDING_COMPLETION_TOKENS;
  return Math.min(MAX_AGENT_SESSION_COMPLETION_TOKENS, lowerBound);
}
