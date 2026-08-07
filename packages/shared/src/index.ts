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
