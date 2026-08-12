import type {
  EffectiveScanLineage,
  GateArtifactV2,
  GateCoverageEnvelope,
} from "@csb/shared";
import { parseGateArtifact } from "./artifact.js";
import { buildScanLineage } from "./lineage.js";

export interface GateBaselineContext {
  repositoryId: string;
  protectedBranch: string | null;
  lineage: EffectiveScanLineage;
  policySchemaVersion: number;
  coverage: GateCoverageEnvelope;
}

export type GateBaselineCandidate =
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string }
  | { kind: "artifact"; artifact: unknown };

export type GateBaselineIncompatibility =
  | "artifact_schema"
  | "repository"
  | "protected_branch"
  | "scan_lineage"
  | "policy_schema"
  | "coverage"
  | "baseline_not_terminal"
  | "publication";

export type GateBaselineSelection =
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string }
  | { kind: "incompatible"; reason: GateBaselineIncompatibility }
  | { kind: "comparable"; artifact: GateArtifactV2 };

export function selectGateBaseline(
  current: GateBaselineContext,
  candidate: GateBaselineCandidate,
): GateBaselineSelection {
  if (candidate.kind === "absent") return { kind: "absent" };
  if (candidate.kind === "unavailable") {
    return { kind: "unavailable", reason: safeReason(candidate.reason) };
  }

  let parsed;
  try {
    parsed = parseGateArtifact(candidate.artifact);
  } catch {
    return { kind: "unavailable", reason: "artifact_invalid" };
  }
  if (parsed.schemaVersion !== 2) {
    return { kind: "incompatible", reason: "artifact_schema" };
  }
  const baseline = parsed;

  let currentLineage;
  try {
    currentLineage = buildScanLineage({
      engine: current.lineage.engine,
      engineVersion: current.lineage.engineVersion,
      route: current.lineage.route,
      protocol: current.lineage.protocol,
      provider: current.lineage.provider,
      model: current.lineage.model,
      reasoningEffort: current.lineage.reasoningEffort,
      methodology: current.lineage.methodology,
      profile: current.lineage.profile,
      recipeHash: current.lineage.recipeHash,
      sourceRevision: current.lineage.sourceRevision,
    });
  } catch {
    return { kind: "incompatible", reason: "scan_lineage" };
  }
  if (currentLineage.scanLineageHash !== current.lineage.scanLineageHash) {
    return { kind: "incompatible", reason: "scan_lineage" };
  }

  if (
    baseline.target.kind !== "protected_branch"
    || !baseline.publication.eligible
    || baseline.publication.protectedBranch === null
  ) {
    return { kind: "incompatible", reason: "publication" };
  }
  if (current.protectedBranch === null) {
    return { kind: "incompatible", reason: "publication" };
  }
  if (baseline.scan.status !== "completed" || baseline.decision.outcome === "error") {
    return { kind: "incompatible", reason: "baseline_not_terminal" };
  }
  if (baseline.repository.id !== current.repositoryId) {
    return { kind: "incompatible", reason: "repository" };
  }
  if (baseline.publication.protectedBranch !== current.protectedBranch) {
    return { kind: "incompatible", reason: "protected_branch" };
  }
  if (baseline.lineage.scanLineageHash !== current.lineage.scanLineageHash) {
    return { kind: "incompatible", reason: "scan_lineage" };
  }
  if (baseline.policy.schemaVersion !== current.policySchemaVersion) {
    return { kind: "incompatible", reason: "policy_schema" };
  }
  if (!coverageComplete(current.coverage) || !coverageComplete(baseline.coverage)) {
    return { kind: "incompatible", reason: "coverage" };
  }
  return { kind: "comparable", artifact: baseline };
}

export function coverageComplete(coverage: GateCoverageEnvelope): boolean {
  return coverage.status === "complete"
    && coverage.unexaminedFileCount === 0
    && coverage.inspectedFileCount === coverage.repositoryFileCount
    && coverage.submodules.length === 0
    && coverage.lfsPointers.length === 0;
}

function safeReason(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed
    || trimmed.length > 200
    || /[\u0000-\u001f\u007f]/.test(trimmed)
    || /file:\/\//i.test(trimmed)
    || /(?:^|\s)(?:\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:[\\/])/.test(trimmed)
  ) {
    return "artifact_unavailable";
  }
  return trimmed;
}
