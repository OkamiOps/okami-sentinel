export type Severity = "critical" | "high" | "medium" | "low" | "info" | "unknown";

export type ScanStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

export function isTerminalScanStatus(status: ScanStatus | string): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "incomplete";
}

export type EffortLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type ScanMode = "standard" | "deep";

export type ScannerEngine = "codex-security" | "mantis" | "vulnhunter";

/**
 * `existing-session` identifies a provider-owned local CLI session. It is not
 * interchangeable with a ChatGPT subscription or an API credential.
 */
export type ScannerAuthMode = "chatgpt" | "api-key" | "existing-session";

export type ScannerMaturity = "stable" | "preview" | "experimental";

export type ConnectionTransport =
  | "local-cli"
  | "codex-app-server"
  | "http-inference"
  | "remote-agent-api";

export type ConnectionAuthKind =
  | "existing-session"
  | "browser-oauth"
  | "device-code"
  | "api-key"
  | "custom-headers";

export type ProviderProtocol =
  | "codex-cli"
  | "codex-app-server"
  | "claude-code-cli"
  | "cursor-agent-cli"
  | "grok-build-cli"
  | "xai-oauth-responses"
  | "openai-responses"
  | "openai-chat"
  | "anthropic-messages"
  | "cursor-background-agents";

export type ModelSelectionMode = "catalog" | "runtime-default";

/** Credential treatment required by a visible connection preset. */
export type ConnectionPresetCredentialMode =
  | "none"
  | "api-key"
  | "token-plan"
  | "custom"
  | "managed-oauth";

/** Endpoint fields exposed by a visible connection preset. */
export type ConnectionPresetEndpointMode = "none" | "preset" | "custom" | "mimo-region";

/** Availability is explicit so a visible route cannot silently become create-invalid. */
export type ConnectionPresetAvailability = "available" | "unavailable" | "disabled";

export type ConnectionPresetLabelKey =
  | "connections.preset.openai-local-codex"
  | "connections.preset.openai-chatgpt-browser-oauth"
  | "connections.preset.openai-chatgpt-device-code"
  | "connections.preset.openai-api"
  | "connections.preset.xai-grok-local"
  | "connections.preset.xai-direct-device-oauth"
  | "connections.preset.xai-api"
  | "connections.preset.claude-code-local"
  | "connections.preset.anthropic-api"
  | "connections.preset.cursor-local"
  | "connections.preset.cursor-cloud-api"
  | "connections.preset.openrouter-api"
  | "connections.preset.gemini-api"
  | "connections.preset.deepseek-api"
  | "connections.preset.minimax-token-plan"
  | "connections.preset.mimo-token-plan"
  | "connections.preset.custom-openai-compatible"
  | "connections.preset.custom-anthropic-compatible";

/**
 * The create-time contract shared by the visible editor presets and the
 * service-boundary regression matrix. Routes marked unavailable or disabled
 * must be intentional; available routes are required to create locally.
 */
export interface ConnectionPreset {
  readonly id: string;
  readonly labelKey: ConnectionPresetLabelKey;
  readonly providerKind: string;
  readonly routeKind: string;
  readonly transport: ConnectionTransport;
  readonly authKind: ConnectionAuthKind;
  readonly protocol: ProviderProtocol;
  readonly modelSelectionMode: ModelSelectionMode;
  readonly credentialMode: ConnectionPresetCredentialMode;
  readonly endpointMode: ConnectionPresetEndpointMode;
  readonly availability: ConnectionPresetAvailability;
}

export const VISIBLE_CONNECTION_PRESET_IDS = [
  "openai-local-codex",
  "openai-chatgpt-browser-oauth",
  "openai-chatgpt-device-code",
  "openai-api",
  "xai-grok-local",
  "xai-direct-device-oauth",
  "xai-api",
  "claude-code-local",
  "anthropic-api",
  "cursor-local",
  "cursor-cloud-api",
  "openrouter-api",
  "gemini-api",
  "deepseek-api",
  "minimax-token-plan",
  "mimo-token-plan",
  "custom-openai-compatible",
  "custom-anthropic-compatible",
] as const;

export const VISIBLE_CONNECTION_PRESET_COUNT = VISIBLE_CONNECTION_PRESET_IDS.length;

export const VISIBLE_CONNECTION_PRESETS: readonly ConnectionPreset[] = Object.freeze([
  connectionPreset("openai-local-codex", "connections.preset.openai-local-codex", "openai", "openai-codex-local", "codex-app-server", "existing-session", "codex-app-server", "catalog", "none", "none"),
  connectionPreset("openai-chatgpt-browser-oauth", "connections.preset.openai-chatgpt-browser-oauth", "openai", "openai-chatgpt-app-server", "codex-app-server", "browser-oauth", "codex-app-server", "catalog", "managed-oauth", "preset"),
  connectionPreset("openai-chatgpt-device-code", "connections.preset.openai-chatgpt-device-code", "openai", "openai-chatgpt-app-server", "codex-app-server", "device-code", "codex-app-server", "catalog", "managed-oauth", "preset"),
  connectionPreset("openai-api", "connections.preset.openai-api", "openai", "openai-api", "http-inference", "api-key", "openai-responses", "catalog", "api-key", "preset"),
  connectionPreset("xai-grok-local", "connections.preset.xai-grok-local", "xai", "xai-grok-build-local", "local-cli", "existing-session", "grok-build-cli", "catalog", "none", "none"),
  connectionPreset("xai-direct-device-oauth", "connections.preset.xai-direct-device-oauth", "xai", "xai-oauth", "http-inference", "device-code", "xai-oauth-responses", "catalog", "managed-oauth", "preset"),
  connectionPreset("xai-api", "connections.preset.xai-api", "xai", "xai-api", "http-inference", "api-key", "openai-responses", "catalog", "api-key", "preset"),
  connectionPreset("claude-code-local", "connections.preset.claude-code-local", "anthropic", "claude-code-local", "local-cli", "existing-session", "claude-code-cli", "runtime-default", "none", "none"),
  connectionPreset("anthropic-api", "connections.preset.anthropic-api", "anthropic", "anthropic-api", "http-inference", "api-key", "anthropic-messages", "catalog", "api-key", "preset"),
  connectionPreset("cursor-local", "connections.preset.cursor-local", "cursor", "cursor-agent-local", "local-cli", "existing-session", "cursor-agent-cli", "catalog", "none", "none"),
  connectionPreset("cursor-cloud-api", "connections.preset.cursor-cloud-api", "cursor", "cursor-background-agents", "remote-agent-api", "api-key", "cursor-background-agents", "catalog", "api-key", "preset"),
  connectionPreset("openrouter-api", "connections.preset.openrouter-api", "openrouter", "openrouter-api", "http-inference", "api-key", "openai-chat", "catalog", "api-key", "preset"),
  connectionPreset("gemini-api", "connections.preset.gemini-api", "google", "gemini-api", "http-inference", "api-key", "openai-chat", "catalog", "api-key", "preset"),
  connectionPreset("deepseek-api", "connections.preset.deepseek-api", "deepseek", "deepseek-api", "http-inference", "api-key", "openai-chat", "catalog", "api-key", "preset"),
  connectionPreset("minimax-token-plan", "connections.preset.minimax-token-plan", "minimax", "minimax-token-plan", "http-inference", "api-key", "anthropic-messages", "catalog", "token-plan", "preset"),
  connectionPreset("mimo-token-plan", "connections.preset.mimo-token-plan", "xiaomi", "mimo-token-plan", "http-inference", "api-key", "openai-chat", "catalog", "token-plan", "mimo-region"),
  connectionPreset("custom-openai-compatible", "connections.preset.custom-openai-compatible", "custom", "custom-openai-compatible", "http-inference", "api-key", "openai-chat", "catalog", "custom", "custom"),
  connectionPreset("custom-anthropic-compatible", "connections.preset.custom-anthropic-compatible", "custom", "custom-anthropic-compatible", "http-inference", "api-key", "anthropic-messages", "catalog", "custom", "custom"),
]);

function connectionPreset(
  id: string,
  labelKey: ConnectionPresetLabelKey,
  providerKind: string,
  routeKind: string,
  transport: ConnectionTransport,
  authKind: ConnectionAuthKind,
  protocol: ProviderProtocol,
  modelSelectionMode: ModelSelectionMode,
  credentialMode: ConnectionPresetCredentialMode,
  endpointMode: ConnectionPresetEndpointMode,
): ConnectionPreset {
  return Object.freeze({
    id,
    labelKey,
    providerKind,
    routeKind,
    transport,
    authKind,
    protocol,
    modelSelectionMode,
    credentialMode,
    endpointMode,
    availability: "available",
  });
}

export type CapabilityState = "supported" | "unsupported" | "unknown";

export interface ModelCapabilities {
  tools: CapabilityState;
  artifactOutput: CapabilityState;
  structuredOutput: CapabilityState;
  boundedExecution: CapabilityState;
  osIsolation: CapabilityState;
  streaming: CapabilityState;
  usage: CapabilityState;
  cancellation: CapabilityState;
}

/** Normalized USD prices reported by a provider, per one million tokens. */
export interface ModelPricing {
  inputUsdPerMillionTokens: number | null;
  cachedInputUsdPerMillionTokens: number | null;
  cacheWriteInputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  /** Optional provider-declared billing semantics for compatible catalogs. */
  pricingBasis?: "metered" | "payg-equivalent";
  billingMode?: "metered" | "subscription" | "credits" | "unknown";
}

/**
 * Optional model metadata reported by a provider catalog. Its absence means
 * Sentinel must leave reasoning selection to the provider.
 */
export interface ModelReasoningEffort {
  options: string[];
  default: string | null;
}

export interface ProviderModel {
  connectionId: string;
  id: string;
  displayName: string;
  contextWindow: number | null;
  capabilities: ModelCapabilities;
  pricing: ModelPricing | null;
  reasoningEffort?: ModelReasoningEffort;
  discoveredAt: string;
  source: "provider-api" | "runtime";
}

/** The closed operational error vocabulary safe to persist or expose for providers. */
export const SAFE_PROVIDER_ERROR_CODES = [
  "credential_rejected",
  "credential_expired",
  "provider_unreachable",
  "model_discovery_unsupported",
  "model_access_denied",
  "endpoint_access_denied",
  "rate_limited",
  "secure_storage_unavailable",
  "runtime_missing",
  "runtime_version_unsupported",
  "oauth_flow_expired",
  "oauth_access_denied",
  "oauth_metadata_invalid",
  "protocol_unsupported",
] as const;

export type SafeProviderErrorCode = (typeof SAFE_PROVIDER_ERROR_CODES)[number];

export interface SafeProviderError {
  code: SafeProviderErrorCode;
}

export function isSafeProviderErrorCode(value: unknown): value is SafeProviderErrorCode {
  return typeof value === "string" &&
    (SAFE_PROVIDER_ERROR_CODES as readonly string[]).includes(value);
}

export interface CapabilityReport {
  id: string;
  connectionId: string;
  modelId: string | null;
  protocol: ProviderProtocol;
  /** Version of the bounded AgentSession wire contract exercised by this probe. */
  agentContractVersion?: number;
  status: "passed" | "failed";
  capabilities: ModelCapabilities;
  errorCode: SafeProviderErrorCode | null;
  checkedAt: string;
}

export interface ScanConnectionSelection {
  connectionId: string;
  modelSelectionMode: ModelSelectionMode;
  modelId: string | null;
}

export type CodexSecurityExecutionProfile = "native" | "portable";

export type CodexSecurityProfilePreference =
  | "auto"
  | CodexSecurityExecutionProfile;

export interface ScanExecutionProvenance {
  executionProfile: CodexSecurityExecutionProfile;
  profileVersion: string;
  methodologyRef: string;
  capabilityCheckId: string | null;
  connectionId: string | null;
  routeKind: string | null;
  protocol: ProviderProtocol | null;
  authKind: ConnectionAuthKind | null;
}

/** Exact connection tuple selected by the server for any connection-aware scan. */
export interface ScanConnectionProvenance {
  connectionId: string;
  routeKind: string;
  protocol: ProviderProtocol;
  authKind: ConnectionAuthKind | null;
  capabilityCheckId: string | null;
}

/** Legacy snapshots without a model choice are historical-only and cannot start a scan. */
export type SnapshotModelSelectionMode = ModelSelectionMode | "legacy-unknown";

export interface ScanConnectionSnapshot {
  scanId: string;
  connectionId: string;
  modelSelectionMode: SnapshotModelSelectionMode;
  modelId: string | null;
  routeKind: string;
  capabilityCheckId: string | null;
  executionProfile: CodexSecurityExecutionProfile | null;
  profileVersion: string | null;
  methodologyRef: string | null;
  protocol: ProviderProtocol | null;
  authKind: ConnectionAuthKind | null;
  capturedAt: string;
}

/**
 * Immutable retry input saved at launch time. It deliberately contains only
 * model selection and relative scope paths, never connection secrets or a
 * provider request body.
 */
export interface ScanLaunchSelection {
  modelSelectionMode: SnapshotModelSelectionMode;
  modelId: string | null;
  paths: string[];
}

/** A stable server-resolved eligibility result for one connection/model pair. */
export interface ConnectionCompatibility extends ScanConnectionSelection {
  eligible: boolean;
  reasons: string[];
  /** Effective only when the selected eligible runner can encode it at launch. */
  reasoningEffort?: ModelReasoningEffort;
  selectedProfile?: CodexSecurityExecutionProfile | null;
  availableProfiles?: CodexSecurityExecutionProfile[];
  profileVersion?: string | null;
  methodologyRef?: string | null;
  capabilityCheckId?: string | null;
}

/** Server-owned eligibility request for a scanner engine and registered connection. */
export interface ResolveScanCompatibilityRequest {
  engine: ScannerEngine;
  selection: ScanConnectionSelection;
  executionProfilePreference?: CodexSecurityProfilePreference;
  remoteRepositoryConfirmed?: boolean;
}

export type ConnectionStatus =
  | "draft"
  | "authentication-required"
  | "testing"
  | "ready"
  | "degraded"
  | "expired"
  | "unavailable";

export interface ConnectionDisplay {
  providerLabel: string;
  routeLabel: string;
  secretConfigured: boolean;
  endpointConfigured: boolean;
  endpointKind: "preset" | "custom" | null;
}

export interface ProviderConnection {
  id: string;
  scopeId: "local";
  name: string;
  /** An extensible provider identifier, for example an adapter family. */
  providerKind: string;
  /** An extensible operational adapter identifier. */
  routeKind: string;
  transport: ConnectionTransport;
  authKind: ConnectionAuthKind;
  protocol: ProviderProtocol;
  status: ConnectionStatus;
  modelSelectionMode: ModelSelectionMode;
  defaultModelId: string | null;
  lastTestedAt: string | null;
  lastModelSyncAt: string | null;
  modelCatalogStale: boolean;
  display: ConnectionDisplay;
}

/** Write-only values accepted when a connection is created or updated. */
export interface ConnectionSecretInput {
  apiKey?: string;
  baseUrl?: string;
  discoveryUrl?: string;
  headers?: Record<string, string>;
  /** Explicit opt-in for plain HTTP on loopback hosts only. */
  allowInsecureLocalhost?: true;
}

export interface CreateProviderConnectionRequest {
  name: string;
  providerKind: string;
  routeKind: string;
  transport: ConnectionTransport;
  authKind: ConnectionAuthKind;
  protocol: ProviderProtocol;
  modelSelectionMode: ModelSelectionMode;
  secret?: ConnectionSecretInput;
}

export interface UpdateProviderConnectionRequest {
  name?: string;
  secret?: ConnectionSecretInput;
}

export interface ProviderConnectionResponse {
  connection: ProviderConnection;
}

export interface ProviderConnectionsResponse {
  connections: ProviderConnection[];
}

export interface ProviderModelsResponse {
  models: ProviderModel[];
}

export interface ProviderAuthFlow {
  flowId: string;
  status: "pending" | "completed" | "cancelled" | "expired" | "denied" | "failed";
  authUrl: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: string | null;
}

export interface ProviderAuthFlowResponse {
  flow: ProviderAuthFlow;
}

export interface ProviderDisconnectResponse {
  result: {
    status: "revoked" | "revoke_pending" | "local_removed" | "not_supported";
  };
}

export interface ScannerAuthCapability {
  id: ScannerAuthMode;
  available: boolean;
  reason: string | null;
}

export interface ScannerModelCapability {
  id: string;
  profile: "frontier" | "balanced" | "specialized";
}

export interface ScannerCapability {
  engine: ScannerEngine;
  name: string;
  enabled: boolean;
  available: boolean;
  maturity: ScannerMaturity;
  reason: string | null;
  sourceUrl: string;
  authModes: ScannerAuthCapability[];
  models: ScannerModelCapability[];
  efforts: EffortLevel[];
  modes: ScanMode[];
  stageCount: number;
  writesTarget: boolean;
  executesGeneratedCode: boolean;
}

export interface ScannerCatalogResponse {
  scanners: ScannerCapability[];
  refreshedAt: string;
}

export const MAX_COMPARE_SCANS = 6;

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
  /** Identifies response-side estimates that are not an invoiced scanner cost. */
  pricingSource?: "openrouter" | "provider-catalog" | "official-rate-card";
  /** Whether USD represents metered billing or only a comparable PAYG equivalent. */
  pricingBasis?: "metered" | "payg-equivalent";
  /** The billing contract of the selected connection, kept separate from token rates. */
  billingMode?: "metered" | "subscription" | "credits" | "unknown";
  /** Versioned exact rate-card identifier; never inferred from a fuzzy model match. */
  pricingRateCardId?: string;
  /** Launch quotes are immutable; post-hoc marks an explicitly audited historical repair. */
  pricingTiming?: "launch" | "post-hoc";
  /** A partial provider usage envelope can only support a conservative maximum. */
  estimateKind?: "upper-bound";
  /** Whether OpenRouter pricing used the reported model or a reviewed model alias. */
  pricingMatch?: "exact" | "catalog-unique" | "approved-alias";
  /** Present only when an approved OpenRouter model alias supplied the price. */
  pricingAliasId?: string;
  /** Immutable catalog rates used for a response-side estimate. */
  pricingSnapshot?: {
    currency: "USD";
    capturedAt: string;
    inputUsdPerMillionTokens: number | null;
    cachedInputUsdPerMillionTokens: number | null;
    /** Null until the provider catalog publishes a cache-write rate. */
    cacheWriteInputUsdPerMillionTokens: number | null;
    outputUsdPerMillionTokens: number | null;
  };
  pricingModel?: string;
  pricingUpdatedAt?: string;
  inputUsd?: number;
  cachedInputUsd?: number;
  cacheWriteInputUsd?: number;
  outputUsd?: number;
}

/** Provider usage is independent from whether an auditable USD rate exists. */
export interface ScanUsageSummary {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
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
  /** True when the scanner exposes stage/activity telemetry, not measurable completion. */
  indeterminate?: boolean;
  /** One-based stage position when a scanner runs a fixed pipeline. */
  currentItem?: number;
  /** Liveness derived from the scanner's most recent observable event. */
  activityState?: "active" | "quiet" | "stale";
  lastActivityAt?: string | null;
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
  engine: ScannerEngine;
  provider: string | null;
  authMode: ScannerAuthMode | null;
  scannerVersion: string | null;
  recipeHash: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  cost: ScanCost | null;
  /** Measured token buckets remain visible even when cost is unavailable. */
  usage?: ScanUsageSummary | null;
  severity: SeverityCounts;
  source: "workbench" | "benchmark" | "filesystem";
  pid: number | null;
  execution: ScanExecutionProvenance | null;
  /** Exact server-resolved route identity. Historical rows may not have one. */
  connection?: ScanConnectionProvenance | null;
  /** Absent only on historical rows created before retry-safe launch records. */
  launchSelection?: ScanLaunchSelection | null;
  progress?: ScanProgress | null;
}

/**
 * Returns a comparable USD estimate only when the adapter reports one or when
 * subscription-scanner usage has been explicitly priced from the OpenRouter catalog.
 */
export function scanEstimatedUsd(
  scan: Pick<ScanRun, "engine" | "authMode" | "cost">,
): number | null {
  if (scan.engine === "mantis" && scan.authMode === "existing-session") {
    return null;
  }
  if (
    (scan.engine === "mantis" || scan.engine === "vulnhunter") &&
    scan.authMode === "chatgpt" &&
    scan.cost?.pricingSource !== "openrouter"
  ) return null;
  const value = scan.cost?.estimatedUsd;
  if (value === 0 && scan.cost?.pricingSource === undefined) return null;
  return value != null && Number.isFinite(value) ? value : null;
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
  hasUpperBoundCost: boolean;
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
    estimateKind: "upper-bound" | null;
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
  engine?: ScannerEngine;
  executionProfilePreference?: CodexSecurityProfilePreference;
  /**
   * Server-resolved connection/model selection. When supplied, legacy model,
   * provider and auth fields are compatibility input only and cannot steer the
   * launched process.
   */
  connection?: ScanConnectionSelection;
  /** Explicit acknowledgement required before a provider can use a remote repo. */
  remoteRepositoryConfirmed?: boolean;
  authMode?: ScannerAuthMode;
  provider?: string;
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

export type CompareFindingChange =
  | "candidate_only"
  | "baseline_only"
  | "both"
  | "severity_changed";

export interface CompareFindingOccurrence extends FindingSummary {
  scanId: string;
}

export interface CompareFindingDelta {
  key: string;
  title: string;
  change: CompareFindingChange;
  baseline: CompareFindingOccurrence | null;
  candidate: CompareFindingOccurrence | null;
}

export interface ComparePairResult {
  candidateScanId: string;
  counts: Record<CompareFindingChange, number>;
  findings: CompareFindingDelta[];
}

export interface CompareResult {
  scans: ScanRun[];
  baselineScanId: string;
  candidateScanIds: string[];
  comparisons: ComparePairResult[];
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
  /** Byte position in the persisted scan log after this message was appended. */
  cursor?: number;
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
