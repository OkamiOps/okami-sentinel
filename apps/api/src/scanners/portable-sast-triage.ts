import fs from "node:fs";
import path from "node:path";
import type { FindingDetail, Severity } from "@csb/shared";
import {
  createPortableCodexSecurityDossier,
  isPortableSastCandidateId,
  portableCodexSecurityDossierBase64,
  type PortableCandidate,
  type PortableCodexSecurityDossier,
} from "./portable-codex-security-dossier.js";
import {
  assertPortableCodexSecurityDossierAnchors,
  createPortableCodexSecurityAnchorValidationCache,
  PortableCodexSecurityStageError,
} from "./portable-codex-security-worker-support.js";

export const PORTABLE_SAST_TRIAGE_FILE = "portable-sast-triage.json";
// One validation page's worth of additional work, independent of alert volume.
export const PORTABLE_SAST_REVIEW_LIMIT = 8;
const PRIORITY = { critical: 0, high: 1, medium: 2, low: 3, info: 4, unknown: 5 } satisfies Record<Severity, number>;
const SUPPORTING_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|examples?|docs?|mocks?)(?:\/|$)|\.(?:spec|test)\.[^/]+$/i;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

interface ReviewEntry {
  findingId: string;
  ruleId: string;
  severity: Severity;
  scope: "runtime" | "supporting";
  path: string;
  startLine: number;
  endLine: number;
}

interface PortableSastTriage {
  version: 1;
  total: number;
  queued: ReviewEntry[];
}

export function planPortableSastTriage(
  findings: readonly FindingDetail[],
  snapshotRoot: string,
  remainingMs?: () => number,
): PortableSastTriage {
  const ranked = findings.flatMap((finding): ReviewEntry[] => {
    const location = Array.isArray(finding.locations) ? finding.locations[0] : undefined;
    const entry = location && {
      findingId: finding.findingId, ruleId: finding.ruleId,
      severity: finding.severity, scope: SUPPORTING_PATH.test(location.path) ? "supporting" : "runtime",
      path: location.path, startLine: location.startLine, endLine: location.endLine,
    };
    return isReviewEntry(entry) ? [entry] : [];
  }).sort((a, b) => PRIORITY[a.severity] - PRIORITY[b.severity] ||
    (a.scope === b.scope ? 0 : a.scope === "runtime" ? -1 : 1) ||
    compare(a.path, b.path) || a.startLine - b.startLine || compare(a.findingId, b.findingId));
  const queued: ReviewEntry[] = [];
  const seen = new Set<string>();
  const cache = createPortableCodexSecurityAnchorValidationCache();
  const empty = createPortableCodexSecurityDossier();
  for (const entry of ranked) {
    if (seen.has(entry.findingId)) continue;
    seen.add(entry.findingId);
    try {
      assertPortableCodexSecurityDossierAnchors(snapshotRoot, { ...empty, candidates: [toCandidate(entry)] }, remainingMs, cache);
    } catch (error) {
      if (error instanceof PortableCodexSecurityStageError && error.code === "stage_evidence_incomplete") continue;
      throw error;
    }
    queued.push(entry);
    if (queued.length === PORTABLE_SAST_REVIEW_LIMIT) break;
  }
  return { version: 1, total: findings.length, queued };
}

function isReviewEntry(value: unknown): value is ReviewEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as ReviewEntry;
  return typeof entry.findingId === "string" && isPortableSastCandidateId(entry.findingId) &&
    typeof entry.ruleId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(entry.ruleId) &&
    typeof entry.severity === "string" && Object.hasOwn(PRIORITY, entry.severity) &&
    (entry.scope === "runtime" || entry.scope === "supporting") &&
    typeof entry.path === "string" && Buffer.byteLength(entry.path) <= 1024 &&
    entry.path.trim() === entry.path && !/[:\\\x00-\x1f]/.test(entry.path) &&
    entry.path.split("/").every(part => part !== "" && part !== "." && part !== "..") &&
    Number.isSafeInteger(entry.startLine) && entry.startLine > 0 &&
    Number.isSafeInteger(entry.endLine) && entry.endLine >= entry.startLine;
}

function toCandidate(entry: ReviewEntry): PortableCandidate {
  return {
    id: entry.findingId, category: `sast/${entry.ruleId}`,
    anchors: [{ path: entry.path, startLine: entry.startLine, endLine: entry.endLine, role: "evidence" }],
    hypothesis: `The OpenGrep rule ${entry.ruleId} matched these lines; investigate whether the match is a security weakness.`,
    attacker: "unknown",
    prerequisites: "Establish the real caller, exposure, and execution conditions from source.",
    expectedImpact: "Determine whether this match can affect security in the actual execution context.",
    controlHypothesis: "Verify whether an effective control or a safe context refutes the scanner match.",
  };
}

export function readPortableSastTriage(scanDir: string): PortableSastTriage | null {
  const file = path.join(scanDir, PORTABLE_SAST_TRIAGE_FILE);
  if (!fs.existsSync(file)) return null;
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.size > 16_384) throw new Error("invalid_sast_triage");
  const plan: PortableSastTriage = JSON.parse(fs.readFileSync(file, "utf8"));
  if (plan?.version !== 1 || !Array.isArray(plan.queued) || plan.queued.length > PORTABLE_SAST_REVIEW_LIMIT ||
      !Number.isSafeInteger(plan.total) || plan.total < plan.queued.length || !plan.queued.every(isReviewEntry) ||
      new Set(plan.queued.map(entry => entry.findingId)).size !== plan.queued.length) throw new Error("invalid_sast_triage");
  return plan;
}

export function writePortableSastTriage(scanDir: string, plan: PortableSastTriage): void {
  const file = path.join(scanDir, PORTABLE_SAST_TRIAGE_FILE);
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(plan), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function addPortableSastCandidates(
  dossier: PortableCodexSecurityDossier,
  plan: PortableSastTriage | null,
): PortableCodexSecurityDossier {
  if (!plan?.queued.length) return dossier;
  const occupied = new Set(dossier.candidates.map(candidate => candidate.id));
  const candidates = plan.queued.filter(entry => !occupied.has(entry.findingId)).map(toCandidate);
  while (candidates.length > 0) {
    const augmented = { ...dossier, candidates: [...candidates, ...dossier.candidates] };
    try {
      portableCodexSecurityDossierBase64(augmented);
      return augmented;
    } catch {
      // Existing discovery leads have first claim on the dossier limits.
      candidates.pop();
    }
  }
  return dossier;
}
