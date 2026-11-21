import fs from "node:fs";
import path from "node:path";

import type {
  PortableCandidate,
  PortableCodexSecurityDossier,
  PortableCoverageAnchor,
} from "./portable-codex-security-dossier.js";

export const PORTABLE_CANDIDATE_GROUPS_FILE = "portable-codex-security-candidate-groups.json" as const;
export const PORTABLE_CANDIDATE_GROUPING_RULE = "same-category-attacker-primary-anchor-v1" as const;

const MAX_GROUP_ANCHORS = 20;
const MAX_GROUPS_FILE_BYTES = 4 * 1024 * 1024;

export interface PortableCandidateGroup {
  /** Candidate the AI reviews; its verdict applies to every member. */
  representativeId: string;
  /** Every candidate in the group, representative first, in discovery order. */
  memberIds: string[];
  /** Members as discovery wrote them, before anchors were merged into the representative. */
  members: PortableCandidate[];
}

export interface PortableCandidateGrouping {
  schemaVersion: 1;
  rule: typeof PORTABLE_CANDIDATE_GROUPING_RULE;
  /** Only groups with two or more members; every other candidate is reviewed alone. */
  groups: PortableCandidateGroup[];
}

/**
 * Deterministic, code-only duplicate grouping run before AI review. Two
 * candidates share a group only when they describe the same broken control in
 * the same code: equal normalized category and attacker, a primary anchor
 * (control, else sink, else the first anchor) with the same role and file and
 * overlapping lines as the group's representative, and, when both name sinks,
 * at least one overlapping sink. Free-text hypotheses are never compared, so
 * reworded duplicates still group, while a different category, attacker,
 * file, range or sink keeps candidates apart. Historical candidates without a
 * recorded hypothesis are never grouped.
 */
export function groupPortableCandidates(candidates: readonly PortableCandidate[]): {
  candidates: PortableCandidate[];
  grouping: PortableCandidateGrouping;
} {
  const groups: Array<{ representative: PortableCandidate; members: PortableCandidate[] }> = [];
  for (const candidate of candidates) {
    const group = groups.find(({ representative }) => sameIssue(representative, candidate) &&
      mergeAnchors(representative.anchors, candidate.anchors).length <= MAX_GROUP_ANCHORS);
    if (group === undefined) {
      groups.push({ representative: copyCandidate(candidate), members: [copyCandidate(candidate)] });
      continue;
    }
    group.representative.anchors = mergeAnchors(group.representative.anchors, candidate.anchors);
    group.members.push(copyCandidate(candidate));
  }
  return {
    candidates: groups.map(({ representative }) => representative),
    grouping: {
      schemaVersion: 1,
      rule: PORTABLE_CANDIDATE_GROUPING_RULE,
      groups: groups.filter(({ members }) => members.length > 1).map(({ representative, members }) => ({
        representativeId: representative.id,
        memberIds: members.map((member) => member.id),
        members,
      })),
    },
  };
}

/** Collapses a discovery dossier so later AI stages see one representative per group. */
export function applyPortableCandidateGrouping(dossier: PortableCodexSecurityDossier): {
  dossier: PortableCodexSecurityDossier;
  grouping: PortableCandidateGrouping;
} {
  if (dossier.assessments.length > 0) throw new Error("candidate_grouping_after_assessment");
  const { candidates, grouping } = groupPortableCandidates(dossier.candidates);
  return { dossier: { ...dossier, candidates }, grouping };
}

/** Reapplies a recorded grouping, failing closed if discovery no longer matches it. */
export function reapplyPortableCandidateGrouping(
  dossier: PortableCodexSecurityDossier,
  recorded: PortableCandidateGrouping,
): PortableCodexSecurityDossier {
  const recomputed = applyPortableCandidateGrouping(dossier);
  if (JSON.stringify(recomputed.grouping) !== JSON.stringify(recorded)) throw new Error("candidate_grouping_mismatch");
  return recomputed.dossier;
}

export function writePortableCandidateGrouping(directory: string, grouping: PortableCandidateGrouping): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, PORTABLE_CANDIDATE_GROUPS_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(grouping)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
}

/** Missing, symlinked, oversized or malformed files read as "not recorded" (scans that predate grouping). */
export function readPortableCandidateGrouping(directory: string): PortableCandidateGrouping | null {
  const target = path.join(directory, PORTABLE_CANDIDATE_GROUPS_FILE);
  try {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > MAX_GROUPS_FILE_BYTES) return null;
    return parseGrouping(JSON.parse(fs.readFileSync(target, "utf8")));
  } catch {
    return null;
  }
}

function parseGrouping(value: unknown): PortableCandidateGrouping | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.rule !== PORTABLE_CANDIDATE_GROUPING_RULE || !Array.isArray(record.groups)) return null;
  const seen = new Set<string>();
  const groups: PortableCandidateGroup[] = [];
  for (const entry of record.groups) {
    if (typeof entry !== "object" || entry === null) return null;
    const group = entry as Record<string, unknown>;
    if (typeof group.representativeId !== "string" || !Array.isArray(group.memberIds) || !Array.isArray(group.members)) return null;
    const memberIds = group.memberIds;
    if (memberIds.length < 2 || memberIds[0] !== group.representativeId ||
        memberIds.some((id) => typeof id !== "string" || seen.has(id)) || group.members.length !== memberIds.length) return null;
    const members = group.members as PortableCandidate[];
    if (members.some((member, index) => typeof member !== "object" || member === null || member.id !== memberIds[index] ||
        typeof member.category !== "string" || !Array.isArray(member.anchors))) return null;
    for (const id of memberIds as string[]) seen.add(id);
    groups.push({ representativeId: group.representativeId, memberIds: [...memberIds as string[]], members });
  }
  return { schemaVersion: 1, rule: PORTABLE_CANDIDATE_GROUPING_RULE, groups };
}

function sameIssue(left: PortableCandidate, right: PortableCandidate): boolean {
  if (!hasRecordedClaim(left) || !hasRecordedClaim(right)) return false;
  if (normalizeCategory(left.category) !== normalizeCategory(right.category)) return false;
  if ((left.attacker ?? "unknown") !== (right.attacker ?? "unknown")) return false;
  const leftPrimary = primaryAnchor(left);
  const rightPrimary = primaryAnchor(right);
  if (leftPrimary === undefined || rightPrimary === undefined ||
      leftPrimary.role !== rightPrimary.role || !overlaps(leftPrimary, rightPrimary)) return false;
  const leftSinks = left.anchors.filter((anchor) => anchor.role === "sink");
  const rightSinks = right.anchors.filter((anchor) => anchor.role === "sink");
  if (leftSinks.length > 0 && rightSinks.length > 0 &&
      !leftSinks.some((sink) => rightSinks.some((other) => overlaps(sink, other)))) return false;
  return true;
}

function hasRecordedClaim(candidate: PortableCandidate): boolean {
  return candidate.hypothesis !== undefined && candidate.controlHypothesis !== undefined;
}

function primaryAnchor(candidate: PortableCandidate): PortableCoverageAnchor | undefined {
  return candidate.anchors.find((anchor) => anchor.role === "control") ??
    candidate.anchors.find((anchor) => anchor.role === "sink") ??
    candidate.anchors[0];
}

function overlaps(left: PortableCoverageAnchor, right: PortableCoverageAnchor): boolean {
  return left.path === right.path && left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function normalizeCategory(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function mergeAnchors(
  left: readonly PortableCoverageAnchor[],
  right: readonly PortableCoverageAnchor[],
): PortableCoverageAnchor[] {
  const merged: PortableCoverageAnchor[] = [];
  const keys = new Set<string>();
  for (const anchor of [...left, ...right]) {
    const key = `${anchor.path}\u0000${anchor.startLine}\u0000${anchor.endLine}\u0000${anchor.role}`;
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push({ ...anchor });
  }
  return merged;
}

function copyCandidate(candidate: PortableCandidate): PortableCandidate {
  return { ...candidate, anchors: candidate.anchors.map((anchor) => ({ ...anchor })) };
}

/**
 * Collapses duplicate candidates once, before the first AI assessment stage,
 * so dataflow and validation review each group's representative only. A
 * resumed run reuses the recorded grouping; a run whose assessments started
 * before grouping existed keeps reviewing every candidate unchanged.
 */
export function groupPortableCandidatesBeforeReview(
  dossier: PortableCodexSecurityDossier,
  artifactsRoot: string,
  options: { resume: boolean; persist: boolean },
): PortableCodexSecurityDossier {
  const recorded = readPortableCandidateGrouping(artifactsRoot);
  if (recorded !== null) return reapplyPortableCandidateGrouping(dossier, recorded);
  if (fs.existsSync(path.join(artifactsRoot, PORTABLE_CANDIDATE_GROUPS_FILE))) throw new Error("candidate_grouping_invalid");
  if (options.resume && hasAssessmentCheckpoints(artifactsRoot)) return dossier;
  const grouped = applyPortableCandidateGrouping(dossier);
  if (options.persist) writePortableCandidateGrouping(artifactsRoot, grouped.grouping);
  return grouped.dossier;
}

function hasAssessmentCheckpoints(artifactsRoot: string): boolean {
  if (!fs.existsSync(artifactsRoot)) return false;
  return fs.readdirSync(artifactsRoot).some((entry) => /^(dataflow|validation|report)(-|$)/.test(entry));
}
