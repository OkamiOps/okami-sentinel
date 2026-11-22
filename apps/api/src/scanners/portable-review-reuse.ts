import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ScanRun, ScanReviewReuseSummary } from "@csb/shared";
import { getDb, getRun } from "../db.js";
import { repositoryKeyFor } from "../regression.js";
import { gatePortableCodexSecurityVerdicts, snapshotReader, type SnapshotReader } from "./portable-codex-security-verdicts.js";
import { readPortableCodexSecurityDossier, applyPortableCodexSecurityStageArtifact, type PortableCandidate, type PortableCandidateAssessment, type PortableCodexSecurityDossier, type PortableCoverageAnchor } from "./portable-codex-security-dossier.js";
import { readPortableCodexSecurityRuntime } from "./portable-codex-security-runtime.js";

export const REVIEW_REUSE_FILE = "portable-codex-security-review-reuse.json";
const MAX_BYTES = 2 * 1024 * 1024;
type ReviewStage = PortableCandidateAssessment["stage"];
export interface ReusedReview {
  candidateId: string;
  sourceScanId: string;
  sourceCandidateId: string;
  status: "confirmed" | "rejected";
  stages: ReviewStage[];
  candidateKey: string;
  evidence: Array<{ anchor: PortableCoverageAnchor; hash: string }>;
  assessments: PortableCandidateAssessment[];
}
export interface PortableReviewReuse {
  version: 1;
  candidates: ReusedReview[];
  totals: ScanReviewReuseSummary;
}

export function reviewReuseSources(scanId: string, repositoryPath: string, scanDir: string, mode: string, before: string): ScanRun[] {
  const rows = getDb().prepare(`SELECT id FROM runs WHERE id != ? AND created_at <
    COALESCE((SELECT created_at FROM runs WHERE id = ?), ?) ORDER BY created_at DESC LIMIT 200`).all(scanId, scanId, before) as Array<{ id: string }>;
  const key = repositoryKeyFor({ repositoryPath, scanDir });
  const sources: ScanRun[] = [];
  for (const row of rows) {
    const run = getRun(row.id);
    if (run !== null &&
    run.engine === "codex-security" && run.execution?.executionProfile === "portable" &&
    (run.status === "completed" || (run.status === "incomplete" && readPortableCodexSecurityRuntime(run.scanDir)?.budgetPartial !== undefined)) &&
    repositoryKeyFor(run) === key && (mode !== "deep" || run.mode === "deep") && retainedReviewReadable(run)) sources.push(run);
    if (sources.length === 5) break;
  }
  return sources;
}

function retainedReviewReadable(run: ScanRun): boolean {
  try {
    return readPortableCodexSecurityDossier(path.join(run.scanDir, "portable-codex-security-results")) !== null &&
      snapshotReader(path.join(run.scanDir, "portable-codex-security-snapshot")).available;
  } catch { return false; }
}

function anchorKey(anchor: PortableCoverageAnchor): string {
  return JSON.stringify([anchor.path, anchor.startLine, anchor.endLine, anchor.role]);
}
export function candidateReviewKey(candidate: PortableCandidate): string {
  return JSON.stringify([candidate.category, [...new Set(candidate.anchors.map(anchorKey))].sort()]);
}

export function evidenceRangeHash(read: SnapshotReader, anchor: PortableCoverageAnchor): string | null {
  const source = read(anchor.path);
  if ("problem" in source || !Number.isInteger(anchor.startLine) || !Number.isInteger(anchor.endLine) ||
      anchor.startLine < 1 || anchor.endLine < anchor.startLine || anchor.endLine > source.lines.length) return null;
  let line = 1;
  let start = 0;
  let end = source.bytes.length;
  for (let offset = 0; offset < source.bytes.length; offset++) {
    if (source.bytes[offset] !== 10) continue;
    if (line === anchor.endLine) { end = offset + 1; break; }
    line++;
    if (line === anchor.startLine) start = offset + 1;
  }
  return createHash("sha256").update(source.bytes.subarray(start, end)).digest("hex");
}

export function sourceReviewCost(source: ScanRun, dossier: PortableCodexSecurityDossier): { cost: number | null; upperBound: boolean } {
  const stages = readPortableCodexSecurityRuntime(source.scanDir)?.reviewStages;
  if (stages?.dataflow && stages.validation) {
    let reusedIds: Set<string>;
    try { reusedIds = new Set(readPortableReviewReuse(source.scanDir)?.candidates.map(c => c.candidateId) ?? []); }
    catch { return { cost: null, upperBound: false }; }
    const count = new Set(dossier.assessments.filter(a => !reusedIds.has(a.candidateId)).map(a => a.candidateId)).size;
    const costs = [stages.dataflow, stages.validation];
    const total = costs.every(s => s.estimatedCostUsd !== null) ? costs.reduce((sum, s) => sum + s.estimatedCostUsd!, 0) : null;
    return { cost: total === null ? null : count > 0 ? total / count : total === 0 ? 0 : null,
    upperBound: costs.some(s => s.upperBound) };
  }
  return { cost: source.cost?.estimatedUsd != null && dossier.candidates.length > 0
    ? source.cost.estimatedUsd / dossier.candidates.length : null, upperBound: true };
}

export function planPortableReviewReuse(dossier: PortableCodexSecurityDossier, snapshotRoot: string, sources: ScanRun[]): PortableReviewReuse {
  const record: PortableReviewReuse = { version: 1, candidates: [], totals: {
    reusedCount: 0, reviewedCount: dossier.candidates.length, estimatedCostAvoidedUsd: 0, upperBound: false,
  } };
  const current = snapshotReader(snapshotRoot).read;
  const remaining = new Set(dossier.candidates.map(c => c.id));
  for (const source of sources.slice(0, 5)) {
    let prior: PortableCodexSecurityDossier | null;
    try { prior = readPortableCodexSecurityDossier(path.join(source.scanDir, "portable-codex-security-results")); }
    catch { continue; }
    if (!prior) continue;
    const root = path.join(source.scanDir, "portable-codex-security-snapshot");
    const reader = snapshotReader(root);
    if (!reader.available) continue;
    const verdicts = gatePortableCodexSecurityVerdicts(prior, root).verdicts;
    const cost = sourceReviewCost(source, prior);
    for (const candidate of dossier.candidates) {
      if (!remaining.has(candidate.id)) continue;
      for (const previous of prior.candidates) {
        if (candidateReviewKey(candidate) !== candidateReviewKey(previous)) continue;
        const verdict = verdicts.find(v => v.candidateId === previous.id)!;
        const assessments = prior.assessments.filter(a => a.candidateId === previous.id);
        if (verdict.status === "inconclusive" || verdict.downgraded || verdict.legacy ||
            verdict.reason === "insufficient-evidence" || verdict.missingEvidence.length > 0 ||
            assessments.length !== 2 || !["dataflow", "validation"].every(stage => assessments.some(a => a.stage === stage)) ||
            assessments.some(a => !assessmentReusable(prior, previous, a, root))) continue;
        const anchors = [...candidate.anchors, ...assessments.flatMap(a => a.evidence)];
        const evidence = anchors.map(anchor => ({ anchor, hash: evidenceRangeHash(reader.read, anchor) }));
        if (evidence.some(item => item.hash === null || item.hash !== evidenceRangeHash(current, item.anchor))) continue;
        record.candidates.push({ candidateId: candidate.id, sourceScanId: source.id, sourceCandidateId: previous.id,
          status: verdict.status, stages: assessments.map(a => a.stage), candidateKey: candidateReviewKey(candidate),
          evidence: evidence as ReusedReview["evidence"], assessments: assessments.map(a => ({ ...a, candidateId: candidate.id })) });
        if (Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES - 256) { record.candidates.pop(); continue; }
        remaining.delete(candidate.id);
        record.totals.upperBound ||= cost.upperBound;
        record.totals.estimatedCostAvoidedUsd = record.totals.estimatedCostAvoidedUsd === null || cost.cost === null
          ? null : record.totals.estimatedCostAvoidedUsd + cost.cost;
        break;
      }
    }
  }
  record.totals.reusedCount = record.candidates.length;
  record.totals.reviewedCount = dossier.candidates.length - record.candidates.length;
  return record;
}

function assessmentReusable(dossier: PortableCodexSecurityDossier, candidate: PortableCandidate, assessment: PortableCandidateAssessment, snapshotRoot: string): boolean {
  if (assessment.reason === "insufficient-evidence" || assessment.missingEvidence !== undefined) return false;
  const verdict = gatePortableCodexSecurityVerdicts({ ...dossier, candidates: [candidate], assessments: [assessment] }, snapshotRoot).verdicts[0]!;
  return verdict.status !== "inconclusive" && !verdict.downgraded && !verdict.legacy;
}

export function writePortableReviewReuse(scanDir: string, record: PortableReviewReuse): void {
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("review_reuse_too_large");
  fs.writeFileSync(path.join(scanDir, REVIEW_REUSE_FILE), text, { mode: 0o600, flag: "wx" });
}

export function readPortableReviewReuse(scanDir: string): PortableReviewReuse | null {
  const file = path.join(scanDir, REVIEW_REUSE_FILE);
  if (!fs.existsSync(file)) return null;
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error("review_reuse_invalid");
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as PortableReviewReuse;
  const totals = record?.totals;
  if (record.version !== 1 || !Array.isArray(record.candidates) || record.candidates.length > 1024 ||
      !totals || !Number.isSafeInteger(totals.reusedCount) || totals.reusedCount !== record.candidates.length ||
      !Number.isSafeInteger(totals.reviewedCount) || totals.reviewedCount < 0 || typeof totals.upperBound !== "boolean" ||
      (totals.estimatedCostAvoidedUsd !== null && (!Number.isFinite(totals.estimatedCostAvoidedUsd) || totals.estimatedCostAvoidedUsd < 0)) ||
      new Set(record.candidates.map(c => c.candidateId)).size !== record.candidates.length ||
      record.candidates.some(c => ![c.candidateId, c.sourceScanId, c.sourceCandidateId, c.candidateKey].every(s => typeof s === "string" && s.length > 0) ||
        !["confirmed", "rejected"].includes(c.status) || !Array.isArray(c.assessments) || !Array.isArray(c.evidence) || !Array.isArray(c.stages))) {
    throw new Error("review_reuse_invalid");
  }
  return record;
}

export function restorePortableReviewReuse(dossier: PortableCodexSecurityDossier, snapshotRoot: string, record: PortableReviewReuse): PortableCodexSecurityDossier {
  const read = snapshotReader(snapshotRoot).read;
  let result = dossier;
  if (record.totals.reusedCount + record.totals.reviewedCount !== dossier.candidates.length) throw new Error("review_reuse_invalid");
  for (const entry of record.candidates) {
    const candidate = dossier.candidates.find(c => c.id === entry.candidateId);
    if (!candidate || candidateReviewKey(candidate) !== entry.candidateKey || entry.assessments.length !== 2 ||
        entry.evidence.length === 0 || entry.evidence.some(e => !e.anchor || e.hash !== evidenceRangeHash(read, e.anchor))) throw new Error("review_reuse_invalid");
    const expected = [...candidate.anchors, ...entry.assessments.flatMap(a => a.evidence)].map(anchorKey).sort();
    if (JSON.stringify(expected) !== JSON.stringify(entry.evidence.map(e => anchorKey(e.anchor)).sort()) ||
        JSON.stringify([...entry.stages].sort()) !== JSON.stringify(["dataflow", "validation"])) throw new Error("review_reuse_invalid");
    for (const stage of ["dataflow", "validation"] as const) {
      const assessments = entry.assessments.filter(a => a.stage === stage);
      if (assessments.length !== 1 || assessments[0]!.candidateId !== candidate.id ||
          !assessmentReusable(result, candidate, assessments[0]!, snapshotRoot)) throw new Error("review_reuse_invalid");
      const base = { ...result, candidates: [candidate], assessments: result.assessments.filter(a => a.candidateId === candidate.id), stageSummaries: [] };
      const validated = applyPortableCodexSecurityStageArtifact(base, { schemaVersion: 1, stage, summary: "Reused cited review", observations: [],
        assessments: assessments.map(({ stage: _, ...a }) => a) });
      result = { ...result, assessments: [...result.assessments.filter(a => a.candidateId !== candidate.id), ...validated.assessments] };
    }
    const verdict = gatePortableCodexSecurityVerdicts({ ...result, candidates: [candidate] }, snapshotRoot).verdicts[0]!;
    if (verdict.status !== entry.status || verdict.downgraded || verdict.legacy) throw new Error("review_reuse_invalid");
  }
  return result;
}
