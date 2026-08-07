export type Severity = "critical" | "high" | "medium" | "low" | "info" | "unknown";

export type ScanStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

export type EffortLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type ScanMode = "standard" | "deep";

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  unknown: number;
  total: number;
}

export interface ScanCost {
  estimatedUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  model?: string;
}

export type ScanPhase =
  | "preflight"
  | "threat_model"
  | "discovery"
  | "validation"
  | "attack_path"
  | "reporting";

/** Best-effort progress derived from Codex Security workbench phases. */
export interface ScanProgress {
  /** 0–100 estimate; never claims 100 while still running. */
  percent: number;
  phase: ScanPhase | string | null;
  phaseLabel: string;
  detail: string | null;
  unit: string | null;
  itemsCompleted: number;
  itemsTotal: number;
  deepPhase?: string | null;
  reportableFindings?: number;
}

export interface ScanRun {
  id: string;
  displayName: string;
  repositoryPath: string | null;
  revision: string | null;
  scanDir: string;
  status: ScanStatus;
  model: string | null;
  effort: string | null;
  mode: ScanMode | string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  cost: ScanCost | null;
  severity: SeverityCounts;
  source: "workbench" | "benchmark" | "filesystem";
  pid: number | null;
  progress?: ScanProgress | null;
}

export interface FindingSummary {
  findingId: string;
  occurrenceId: string | null;
  title: string;
  severity: Severity;
  confidence: string | null;
  ruleId: string | null;
  summary: string | null;
  primaryPath: string | null;
  fingerprints: string[];
  category: string | null;
  cwe: string[];
}

export type AttackPathEvidenceState = "proven" | "inferred" | "missing";

export type AttackPathNodeKind =
  | "attacker"
  | "source"
  | "entrypoint"
  | "implementation"
  | "control"
  | "sink"
  | "evidence"
  | "outcome";

export interface AttackPathLocation {
  path: string;
  startLine: number | null;
  endLine: number | null;
}

export interface AttackPathNode {
  id: string;
  kind: AttackPathNodeKind;
  label: string;
  summary: string | null;
  evidenceState: AttackPathEvidenceState;
  evidenceRef: string | null;
  location: AttackPathLocation | null;
  code: string | null;
  language: string | null;
  explanation: string | null;
}

export interface AttackPathLane {
  id: string;
  label: string;
  nodes: AttackPathNode[];
}

export interface AttackPathModel {
  status: "validated" | "partial" | "unstructured";
  summary: string | null;
  preconditions: string | null;
  limitations: string[];
  impact: { level: string | null; rationale: string | null };
  likelihood: { level: string | null; rationale: string | null };
  lanes: AttackPathLane[];
  warnings: string[];
}

export interface FindingDetail extends FindingSummary {
  attackPath: unknown;
  attackPathModel: AttackPathModel | null;
  codeEvidence: unknown[];
  remediation: unknown;
  locations: unknown;
  taxonomy: unknown;
  rootCause: unknown;
  validation: unknown;
  preventiveControls: unknown;
  remediationTests: unknown;
  severityRationale: string | null;
  confidenceRationale: string | null;
}

export type FindingLifecycle = "new" | "persisting" | "fixed" | "regressed";

export type FindingTriageStatus =
  | "unreviewed"
  | "confirmed"
  | "accepted"
  | "false_positive";

export interface FindingTriage {
  status: FindingTriageStatus;
  note: string | null;
  updatedAt: string | null;
}

export interface LifecycleFinding extends FindingSummary {
  identity: string;
  lifecycle: FindingLifecycle;
  triage: FindingTriage;
  /** Scan containing the evidence. Fixed findings point to the baseline scan. */
  sourceScanId: string;
}

export interface RegressionSummary {
  scanId: string;
  baseline: ScanRun | null;
  baselineSource: "explicit" | "automatic" | "none";
  isRepositoryBaseline: boolean;
  counts: Record<FindingLifecycle, number>;
  findings: LifecycleFinding[];
}

export interface UpdateFindingTriageRequest {
  status: FindingTriageStatus;
  note?: string | null;
}

export interface MetricsSummary {
  totalScans: number;
  completedScans: number;
  runningScans: number;
  totalEstimatedUsd: number;
  avgUsdPerScan: number;
  avgDurationMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  highPerDollar: number | null;
  findingsPerDollar: number | null;
  severity: SeverityCounts;
  byModelEffort: Array<{
    model: string;
    effort: string;
    runs: number;
    totalUsd: number;
    avgUsd: number;
    findingsHigh: number;
    findingsTotal: number;
    highPerDollar: number | null;
    totalPerDollar: number | null;
  }>;
  costTrend: Array<{
    scanId: string;
    displayName: string;
    startedAt: string | null;
    estimatedUsd: number;
    findingsHigh: number;
    findingsTotal: number;
    model: string | null;
    effort: string | null;
  }>;
  topCategories: Array<{
    category: string;
    count: number;
    high: number;
  }>;
  recent: ScanRun[];
}

export interface StartScanRequest {
  repositoryPath: string;
  model?: string;
  effort?: EffortLevel | string;
  mode?: ScanMode;
  maxCostUsd?: number;
  paths?: string[];
  displayName?: string;
}

export interface CompareRequest {
  scanIds: string[];
}

export interface CompareFindingBucket {
  key: string;
  title: string;
  severity: Severity;
  presentIn: string[];
}

export interface CompareResult {
  scans: ScanRun[];
  ranking: Array<{
    scanId: string;
    model: string | null;
    effort: string | null;
    estimatedUsd: number;
    findingsHigh: number;
    findingsTotal: number;
    highPerDollar: number | null;
    totalPerDollar: number | null;
    durationMs: number | null;
  }>;
  shared: CompareFindingBucket[];
  uniqueByScan: Record<string, CompareFindingBucket[]>;
}

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FsListResponse {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface CodexInfo {
  cliVersion?: string;
  sdkVersion?: string;
  model?: string;
  reasoningEffort?: string;
  raw: unknown;
}

export interface HealthResponse {
  ok: boolean;
  api: string;
  codexStateDir: string;
  codexInfo: CodexInfo | null;
  /** First active scan id (compat). Prefer activeScanIds. */
  activeScanId: string | null;
  activeScanIds: string[];
  maxConcurrentScans: number;
}

export interface ScanEvent {
  type: "log" | "status" | "cost" | "done" | "error" | "progress";
  at: string;
  message?: string;
  status?: ScanStatus;
  cost?: Partial<ScanCost>;
  progress?: ScanProgress;
  scan?: ScanRun;
}

export function emptySeverityCounts(): SeverityCounts {
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    unknown: 0,
    total: 0,
  };
}

export function normalizeSeverity(value: unknown): Severity {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "level" in value
        ? String((value as { level: unknown }).level)
        : "unknown";
  const s = raw.toLowerCase();
  if (
    s === "critical" ||
    s === "high" ||
    s === "medium" ||
    s === "low" ||
    s === "info"
  ) {
    return s;
  }
  return "unknown";
}

export type GateSource = "local" | "github";
export type GateStatus = "queued" | "resolving" | "scanning" | "evaluating" | "publishing" | "completed" | "cancelled" | "error";
export type GateOutcome = "no_changes" | "bootstrap" | "pass" | "warning" | "blocked" | "error";
export type GatePublishStatus = "not_configured" | "waiting" | "publishing" | "published" | "failed";
export type GateFindingLifecycle = "new" | "reopened" | "persistent" | "fixed";
export type GateRuleDecision = "block" | "review";
export type GitHubConclusion = "success" | "neutral" | "failure" | "action_required";

export interface GuardrailRule {
  severity: Severity[];
  lifecycle: GateFindingLifecycle[];
  decision: GateRuleDecision;
}

export interface GuardrailPolicy {
  schemaVersion: 1;
  protectedBranches: string[];
  scope: { mode: "changed" | "repository"; maxChangedPaths: number; fallback: "repository" | "error" };
  scan: { model: string; effort: string; mode: "standard" | "deep"; maxCostUsd: number };
  rules: GuardrailRule[];
}

export interface ChangeSetFile {
  status: "added" | "modified" | "renamed" | "deleted";
  path: string;
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
}

export interface ChangeSet {
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  files: ChangeSetFile[];
  scanPaths: string[];
  scopeMode: "changed" | "repository";
  fallbackReason: string | null;
}

export interface GuardrailException {
  findingIdentity: string;
  reason: string;
  owner: string;
  createdAt: string;
  expiresAt: string;
  branches: string[];
  ruleIndexes: number[];
}

export interface GateFindingDelta extends FindingSummary {
  identity: string;
  lifecycle: GateFindingLifecycle;
  triage: FindingTriage;
  exception: GuardrailException | null;
  sourceScanId: string;
}

export interface DecisionGraphNode {
  id: string;
  kind: "changeset" | "surface" | "signal" | "rule" | "verdict";
  label: string;
  value: string;
  detail: string | null;
  tone: "neutral" | "good" | "warning" | "risk";
  findingIdentity: string | null;
}

export interface DecisionGraph { nodes: DecisionGraphNode[]; selectedNodeId: string; }

export interface GateViolation {
  findingIdentity: string;
  ruleIndex: number;
  decision: GateRuleDecision;
  reason: string;
}

export interface GateDecision {
  outcome: GateOutcome;
  summary: string;
  violations: GateViolation[];
  warnings: GateViolation[];
  exceptionsApplied: string[];
  githubConclusion: GitHubConclusion;
  decisionGraph: DecisionGraph;
}

export interface GateArtifact {
  schemaVersion: 1;
  gateId: string;
  repository: { key: string; owner: string | null; name: string; defaultBranch: string };
  source: GateSource;
  changeSet: ChangeSet;
  policy: GuardrailPolicy;
  scan: { id: string | null; cost: ScanCost | null; status: string };
  baselineCommit: string | null;
  findings: GateFindingDelta[];
  decision: GateDecision;
  versions: { gateCore: string; scanner: string | null };
  createdAt: string;
}

export interface GateRun {
  id: string;
  repositoryKey: string;
  repositoryPath: string;
  source: GateSource;
  baseRef: string;
  headRef: string;
  pullRequestNumber: number | null;
  scanId: string | null;
  status: GateStatus;
  outcome: GateOutcome | null;
  policyVersion: number;
  baselineCommit: string | null;
  artifactPath: string | null;
  publishStatus: GatePublishStatus;
  publishError: string | null;
  publishedAt: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  estimatedUsd: number;
}

export type RepositoryGitHubStatus = "not_configured" | "not_checked" | "ready" | "action_required";

export interface GuardrailRepository {
  repositoryKey: string;
  repositoryPath: string;
  displayName: string;
  defaultBranch: string;
  remoteOwner: string | null;
  remoteName: string | null;
  enabled: boolean;
  policyPath: string;
  lastGateId: string | null;
  githubStatus: RepositoryGitHubStatus;
}

export interface GitHubCapabilityStatus {
  ready: boolean;
  message: string;
  action: string | null;
}

export interface GuardrailGitHubStatus {
  subscription: GitHubCapabilityStatus;
  cli: GitHubCapabilityStatus & { available: boolean };
  remote: GitHubCapabilityStatus;
  auth: GitHubCapabilityStatus;
  permissions: GitHubCapabilityStatus;
  secret: GitHubCapabilityStatus;
  workflow: GitHubCapabilityStatus;
  baseline: GitHubCapabilityStatus;
  ready: boolean;
}
