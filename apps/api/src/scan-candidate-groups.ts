import fs from "node:fs";
import path from "node:path";
import type { ScanCandidateGroup, ScanCandidateGroups, ScanCandidateGroupVerdictStatus, ScanRun } from "@csb/shared";
import { readPortableCandidateGrouping } from "./scanners/portable-codex-security-candidate-groups.js";
import { readPortableCodexSecurityDossier, type PortableCodexSecurityDossier } from "./scanners/portable-codex-security-dossier.js";

/** Deterministic duplicate groups for a Portable scan and the verdict each group shares. */
export function scanCandidateGroups(scan: ScanRun): ScanCandidateGroups {
  const empty: ScanCandidateGroups = { scanId: scan.id, recorded: false, rule: null, candidates: null, reviewed: null, groups: [] };
  if (scan.engine !== "codex-security" || scan.execution?.executionProfile !== "portable") return empty;
  let root: string;
  try {
    root = fs.realpathSync(scan.scanDir);
  } catch {
    return empty;
  }
  const resultsDir = path.join(root, "portable-codex-security-results");
  const artifactsDir = path.join(root, "portable-codex-security-artifacts");
  const grouping = readPortableCandidateGrouping(resultsDir) ?? readPortableCandidateGrouping(artifactsDir);
  if (grouping === null) return empty;
  const dossier = readPortableCodexSecurityDossier(resultsDir);
  const grouped = grouping.groups.reduce((total, group) => total + group.memberIds.length - 1, 0);
  const reviewed = dossier === null ? null : dossier.candidates.length;
  return {
    scanId: scan.id,
    recorded: true,
    rule: grouping.rule,
    candidates: reviewed === null ? null : reviewed + grouped,
    reviewed,
    groups: grouping.groups.map((group): ScanCandidateGroup => ({
      representativeId: group.representativeId,
      memberIds: [...group.memberIds],
      members: group.members.map((member) => ({
        id: member.id,
        category: member.category,
        hypothesis: member.hypothesis ?? "",
        anchors: member.anchors.map(({ path: file, startLine, endLine, role }) => ({ path: file, startLine, endLine, role })),
      })),
      verdict: groupVerdict(dossier, group.representativeId),
    })),
  };
}

function groupVerdict(dossier: PortableCodexSecurityDossier | null, representativeId: string): ScanCandidateGroup["verdict"] {
  const assessments = dossier?.assessments.filter((assessment) => assessment.candidateId === representativeId) ?? [];
  const decisive = assessments.find((assessment) => assessment.stage === "validation") ??
    assessments.find((assessment) => assessment.stage === "dataflow");
  if (decisive === undefined) return { status: "pending" satisfies ScanCandidateGroupVerdictStatus };
  return { status: decisive.status, stage: decisive.stage, reason: decisive.reason };
}
