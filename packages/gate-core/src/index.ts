export { defaultGuardrailPolicy } from "./default-policy.js";
export { findingIdentity, publicFindingIdentity, publicIdentity } from "./identity.js";
export {
  classifyGateFindings,
  evaluateGate,
  githubConclusion,
  type BaselineFindingSummary,
  type EvaluateGateInput,
  type EvaluateGateBaseline,
  type EvaluateGateResult,
} from "./evaluate.js";
export {
  buildScanLineage,
  type BuildScanLineageInput,
} from "./lineage.js";
export {
  coverageComplete,
  selectGateBaseline,
  type GateBaselineCandidate,
  type GateBaselineContext,
  type GateBaselineIncompatibility,
  type GateBaselineSelection,
} from "./baseline.js";
export { buildDecisionGraph } from "./decision-graph.js";
// The public-comment surfaces (the Check, the pull-request comment) redact and
// locate text under exactly the rules the artifact validator enforces, so one
// definition serves both instead of a second, divergent copy.
export {
  containsLocalHostPath,
  containsSecret,
  isRepositoryRelativePath,
  redactPublicText,
} from "./public-text.js";
export {
  buildGateArtifact,
  buildGateArtifactV2,
  buildOperationalErrorArtifact,
  buildOperationalErrorArtifactV2,
  gatePublicationEligibility,
  parseGateArtifact,
  type BuildGateArtifactInput,
  type BuildGateArtifactV2Input,
  type BuildOperationalErrorArtifactInput,
  type BuildOperationalErrorArtifactV2Input,
  type PublicRepositoryIdentity,
  type PublicRepositoryIdentityV2,
} from "./artifact.js";
