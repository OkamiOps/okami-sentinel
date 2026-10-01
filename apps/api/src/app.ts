import { scanFilesGraph } from "./scan-files-graph.js";
import { scanCandidatePreview } from "./scan-candidate-preview.js";
import { scanAnalysisMetrics } from "./scan-analysis-metrics.js";
import { automaticGitHubScanDispatcher } from "./github-monitor-dispatch.js";
import { createGitHubWebhookApp } from "./github-actions/webhook-api.js";
import type { GitHubWebhookIngestDependencies } from "./github-actions/webhook-ingest.js";
import { createWebhookSecretCache } from "./github-actions/webhook-secret-cache.js";
import type { GitHubWebhookSecret } from "./github-actions/webhook-signature.js";
import {
  dispatchGitHubActionEvent,
  reconcileOrphanedGitHubActionDispatches,
} from "./github-actions/dispatch.js";
import {
  listGitHubBranchNames,
  reconcileGitHubActions,
  singleFlightReconcile,
  type GitHubReconcileOutcome,
  type GitHubReconcilerDependencies,
} from "./github-actions/reconciler.js";
import { createGitHubBranchesApp } from "./github-actions/branches-api.js";
import { createGitHubActionsApi } from "./github-actions/api.js";
import {
  buildGitHubIntegrationStatus,
  type GitHubIntegrationInstallationState,
  type GitHubIntegrationStatus,
} from "./github-actions/integration-status.js";
import { rerunGitHubActionGate } from "./github-actions/rerun.js";
import { readGitHubInstallationScopes } from "./github-actions/installation-scope.js";
import {
  completeWebhookDelivery,
  countReconciledEventsSince,
  countWebhookDeliveriesSince,
  createGitHubAction,
  createGitHubActionEvent,
  deleteGitHubAction,
  disableGitHubActionsForInstallation,
  disableGitHubActionsForRepository,
  findGitHubActionEventByGateId,
  getGitHubAction,
  hasAnalysedCommit,
  hasGitHubActionEventForHeadSha,
  lastVerifiedWebhookDeliveryAt,
  listGitHubActionEvents,
  listGitHubActions,
  listWebhookDeliveries,
  newestObservedEventAt,
  patchGitHubAction,
  patchGitHubActionEvent,
  recordGitHubActionReconciliation,
  recordWebhookDelivery,
  recordWebhookSecretStored,
  supersedeQueuedEvents,
  webhookSecretStoredAt,
} from "./github-actions/store.js";
import { createGitHubCheckoutsApp } from "./github-checkouts.js";
import { githubIntegrationSecurity } from "./github-integration-security.js";
import { isDraining } from "./shutdown.js";
import { randomUUID } from "node:crypto";
import { loadServerSettings, runtimeMode, repositoryRoots } from "./deployment-settings.js";
import { createAuthApi } from "./auth/auth-api.js";
import { createUsersApi } from "./auth/users-api.js";
import { createEmailApi } from "./email/email-api.js";
import { createNotificationsApi } from "./email/notifications-api.js";
import { notifyGitHubPublishFailed } from "./email/ops-notifications.js";
import { csrfTokenOf, inScope, principalOf, scopeOf } from "./auth/principal.js";
import { createStreamGuard } from "./auth/stream-guard.js";
import { authorize } from "./auth/route-policy.js";
import { assertRepositoryAccess } from "./repository-access.js";
import path from "node:path";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  buildDecisionGraph,
  defaultGuardrailPolicy,
  evaluateGate,
} from "@csb/gate-core";
import {
  defaultGitRunner,
  parseGuardrailPolicy,
  readGuardrailExceptions,
  readGuardrailPolicy,
  writeGuardrailPolicy,
} from "@csb/gate-runtime";
import type {
  CodexInfo,
  CompareRequest,
  GateArtifact,
  GateDecision,
  GateExecutorKind,
  GateFindingDelta,
  GateRun,
  GuardrailPullRequestSummary,
  GuardrailEnrollmentSkip,
  GuardrailException,
  GuardrailPolicy,
  GuardrailPrCommentState,
  GuardrailRepository,
  GuardrailRepositoryListRow,
  GuardrailRepositoryPatch,
  HealthResponse,
  UpdateFindingTriageRequest,
} from "@csb/shared";
import { DEFAULT_GUARDRAIL_PR_COMMENT_LOCALE } from "@csb/shared";
import {
  purgeScanRunArtifacts,
  readCliLogSnapshot,
} from "./activity.js";
import { compareScans } from "./compare.js";
import { getCodexInfo } from "./codex-info.js";
import { CODEX_SECURITY_STATE_DIR } from "./config.js";
import { deleteRun, getDb, getRun, hideRun, listRuns } from "./db.js";
import { backfillRunRepositoryKeys, getRunRepositoryKey } from "./auth/repository-key.js";
import { listDirectory } from "./fs.js";
import {
  cancelGate,
  deleteTerminalGate,
  getGateArtifact,
  reconcileGateWithLinkedScan,
  startLocalGate,
  startRemoteActionsGate,
  startRemoteManagedGate,
  subscribeGate,
} from "./gate-orchestrator.js";
import {
  type GatePublicationAttempt,
  type GateRunUpdate,
  getGateRun,
  getGuardrailRepositoryPrComment,
  listGatePublicationAttempts,
  listGateRuns,
  deleteGuardrailRepository,
  listGitHubInstallationRepositories,
  listGuardrailRepositories,
  listGuardrailRepositoryRows,
  patchGuardrailRepository,
  recordGatePublicationAttempt,
  updateGateRun,
  upsertGuardrailRepository,
  type GateEvent,
} from "./gate-store.js";
import {
  publishManagedGateCheck,
  type ManagedGitHubCheckClient,
  type PublishManagedGateCheckInput,
} from "./github-check.js";
import {
  publishPrComment,
  type PublishPrCommentInput,
  type PublishPrCommentResult,
} from "./github/pr-comment-publisher.js";
import {
  clearPrCommentPermissionBlock,
  getPrComment,
  prCommentPermissionBlockedAt,
  listPrComments,
  recordPrCommentPermissionBlock,
  upsertPrComment,
} from "./github/pr-comment-store.js";
import { getGitHubStatus, getRemoteGitHubStatus } from "./github-status.js";
import {
  createGitHubAppApi,
  getSystemGitHubAppClient,
  getSystemGitHubAppCredentialStore,
  getSystemGitHubAppService,
} from "./github-app-api.js";
import { GitHubRepositoryService } from "./guardrails/github-repository-service.js";
import {
  GitHubRepositorySourceAdapter,
  parseEnrollGuardrailRepositoriesRequest,
  type EnrollGuardrailRepositoriesRequest,
  type EnrollGuardrailRepositoryRequest,
} from "./guardrails/repository-source-adapter.js";
import { GitHubRefResolver } from "./guardrails/github-ref-resolver.js";
import {
  ProtectedPolicyLoader,
  type ProtectedPolicyBundle,
} from "./guardrails/protected-policy-loader.js";
import {
  getRepositoryPolicy,
  putRepositoryPolicy,
  type StoredRepositoryPolicy,
} from "./guardrails/policy-store.js";
import {
  getRepositoryBaselineState,
  markRepositoryBaselineBuilding,
  markRepositoryBaselineStale,
  refreshRepositoryBaselineState,
  type RepositoryBaseline,
} from "./guardrails/baseline-state.js";
import { matchesAnyBranchPattern } from "./github-actions/branch-patterns.js";
import {
  presetForPolicy,
  type GuardrailPolicyPreset,
} from "./guardrails/policy-presets.js";
import {
  TargetPreviewError,
  TargetPreviewService,
  nativeScanCostCeilingSupported,
  parseStartGateRequest,
  resolvedScanSelection,
  parseTargetPreviewRequest,
  type AcceptedGateTargetPreview,
  type GateTargetPreview,
  type StartGateRequest,
  type TargetPreviewRequest,
} from "./guardrails/target-preview.js";
import {
  callerWorkflowDocument,
  DEFAULT_GUARDRAIL_AUTOMATION,
  type GuardrailAutomationTriggers,
  normalizeBranchFilters,
  type CallerWorkflowDocument,
} from "./github-workflow.js";
import {
  getGitHubActionsStatus,
  type GitHubActionsStatus,
} from "./guardrails/github-actions-status.js";
import {
  openCallerWorkflowPullRequest,
  type OpenCallerWorkflowPullRequestResult,
} from "./guardrails/caller-workflow-pull-request.js";
import {
  importExternalScans,
  readFindingsFile,
  refreshRunFromDisk,
  toFindingSummaries,
} from "./ingest.js";
import { buildMetricsSummary } from "./metrics.js";
import { refreshOpenRouterPricing } from "./openrouter-pricing.js";
import { withProgress, withProgressMany } from "./progress.js";
import { buildRegressionSummary, markScanAsRepositoryBaseline, updateFindingTriage } from "./regression.js";
import { isRemovableScanStatus } from "./lifecycle.js";
import { GITHUB_ACTIONS_WORKFLOW_SHA, MAX_CONCURRENT_SCANS } from "./config.js";
import { createConnectionsApp } from "./connections-api.js";
import { getProviderRuntime } from "./provider-runtime.js";
import { createScanStartApp } from "./scan-start-api.js";
import { getScannerCatalog } from "./scanners/catalog.js";
import { createEngineUpdatesApp } from "./engine-updates-api.js";
import { listActiveRuns, listRunPage, parseScanListOptions, scanCatalog } from "./scan-list.js";
import {
  cancelScan,
  getActiveScanIds,
  isScanActive,
  startScan,
  subscribe,
} from "./runner.js";

export const app = new Hono();

app.use(
  "*",
  cors({
    origin: runtimeMode() === "server" ? [] : ["http://127.0.0.1:5173", "http://localhost:5173"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-CSRF-Token", "Idempotency-Key"],
  }),
);

// Deny by default: every route below must appear in ROUTE_POLICY, and the
// caller's role is settled before any handler sees the request.
app.use("*", authorize());

app.get("/security-session", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ csrfToken: csrfTokenOf(c), runtimeMode: runtimeMode(), repositoryRoots: repositoryRoots() });
});

export interface GuardrailsApiDependencies {
  listRepositories(): GuardrailRepository[];
  /** Everything the list screen shows, in one read and with no remote request. */
  listRepositoryRows(): GuardrailRepositoryListRow[];
  enrollRepository(request: EnrollGuardrailRepositoryRequest): Promise<GuardrailRepository>;
  patchRepository(repositoryKey: string, patch: GuardrailRepositoryPatch): GuardrailRepository | null;
  /** Removes the row, its gates and their artifacts. Refuses while a gate runs. */
  removeRepository(repositoryKey: string): void;
  upsertRepository(repository: GuardrailRepository): void;
  getRepository(repositoryKey: string): GuardrailRepository | null;
  /** Attributes existing runs to a freshly registered repository. */
  backfillRepositoryKeys?(): void;
  readPolicy(repositoryPath: string): GuardrailPolicy;
  readRemotePolicy(repository: GuardrailRepository): Promise<ProtectedPolicyBundle>;
  /** Level 2 of the precedence: the policy a maintainer saves in the interface. */
  getSentinelPolicy(repositoryKey: string): StoredRepositoryPolicy | null;
  putSentinelPolicy(
    repositoryKey: string,
    policy: GuardrailPolicy,
    preset: GuardrailPolicyPreset,
    updatedBy: string | null,
  ): StoredRepositoryPolicy;
  parsePolicy(value: unknown): GuardrailPolicy;
  writePolicy(repositoryPath: string, policy: GuardrailPolicy): void;
  readExceptions(repositoryPath: string): GuardrailException[];
  listGates(repositoryKey?: string | null): GateRun[];
  getGate(gateId: string): GateRun | null;
  getArtifact(gateId: string): GateArtifact | null;
  listPullRequests(repository: GuardrailRepository): Promise<GuardrailPullRequestSummary[]>;
  previewTarget(
    repository: GuardrailRepository,
    request: TargetPreviewRequest,
  ): Promise<GateTargetPreview>;
  acceptTargetPreview(
    repository: GuardrailRepository,
    request: {
      previewIdentity: string;
      target: StartGateRequest["target"];
      executor: GateExecutorKind;
    },
  ): Promise<AcceptedGateTargetPreview>;
  startGate(
    request: StartGateRequest,
    acceptedPreview: AcceptedGateTargetPreview | null,
  ): Promise<GateRun>;
  dispatchActionsGate(
    repository: GuardrailRepository,
    preview: AcceptedGateTargetPreview,
    idempotencyKey: string,
  ): Promise<GateRun>;
  cancelGate(gateId: string): boolean;
  deleteGate(gateId: string): boolean;
  subscribeGate(gateId: string, listener: (event: GateEvent) => void): () => void;
  getGitHubStatus(repository: GuardrailRepository): ReturnType<typeof getGitHubStatus>;
  getActionsStatus(repository: GuardrailRepository): Promise<GitHubActionsStatus>;
  getCallerWorkflow(repository: GuardrailRepository): Promise<CallerWorkflowDocument>;
  installCallerWorkflow?(repository: GuardrailRepository, triggers: GuardrailAutomationTriggers): Promise<GitHubActionsStatus>;
  /** "Abrir PR com o workflow": the branch, the file and the pull request. */
  openCallerWorkflowPullRequest(repository: GuardrailRepository): Promise<OpenCallerWorkflowPullRequestResult>;
  /** The baseline projection: one word the screen reads without N remote calls. */
  getBaseline(repositoryKey: string): RepositoryBaseline;
  markBaselineBuilding(repositoryKey: string, requestedAt: string): RepositoryBaseline;
  /** Whether an enabled `push` action covers the repository's protected branch. */
  hasProtectedBranchAction(repositoryKey: string): boolean;
  /** "Criar baseline agora": a protected-branch gate on the repository's branch. */
  startBaselineGate(repository: GuardrailRepository): Promise<GateRun>;
  publishCheck(input: PublishManagedGateCheckInput): Promise<"created" | "updated">;
  /** "Republicar comentário": the same publisher the gate uses, by hand. */
  publishComment(input: PublishPrCommentInput): Promise<PublishPrCommentResult>;
  getComment(repositoryKey: string, pullRequestNumber: number): GuardrailPrCommentState | null;
  listComments(repositoryKey: string): GuardrailPrCommentState[];
  updateGate(gateId: string, updates: GateRunUpdate): void;
  recordPublicationAttempt(attempt: GatePublicationAttempt): void;
  listPublicationAttempts(gateId: string): GatePublicationAttempt[];
}

const repositoryEnrollmentService = new GitHubRepositoryService({
  inspectLocal: inspectRepository,
  requireAuthorizedRepository: (connectionId, installationId, repositoryId) =>
    getSystemGitHubAppService().requireAuthorizedRepository(
      connectionId,
      installationId,
      repositoryId,
    ),
});
const githubRepositorySource = new GitHubRepositorySourceAdapter({
  readAuthorizedRepositoryJson: (connectionId, installationId, repositoryId, resourcePath, permissions) =>
    getSystemGitHubAppService().readAuthorizedRepositoryJson(
      connectionId,
      installationId,
      repositoryId,
      resourcePath,
      permissions,
    ),
});
const githubRefResolver = new GitHubRefResolver(githubRepositorySource);
const protectedPolicyLoader = new ProtectedPolicyLoader(githubRepositorySource);
const targetPreviewService = new TargetPreviewService({
  resolveTarget: (repository, target) => githubRefResolver.resolve(repository, target),
  loadPolicy: (repository, target, resolved) =>
    protectedPolicyLoader.load(repository, target, resolved),
  executorCapability: async (repository, executor) => {
    if (executor === "sentinel-managed") return { ready: true, code: "ready" };
    const status = await getGitHubActionsStatus(
      repository,
      getSystemGitHubAppService(),
      GITHUB_ACTIONS_WORKFLOW_SHA,
    );
    return status.ready
      ? { ready: true, code: "ready" }
      : { ready: false, code: "github_actions_unavailable" };
  },
  resolveScanSelection: resolveGuardrailScanSelection,
});

async function resolveGuardrailScanSelection(selection: import("@csb/shared").GuardrailScanSelection) {
  const scanner = (await getScannerCatalog()).scanners.find((candidate) => candidate.engine === selection.engine);
  if (!scanner?.enabled || !scanner.modes.includes(selection.mode)) {
    throw new TargetPreviewError("target_preview_invalid");
  }
  const compatibility = getProviderRuntime().compatibility.resolve({
    engine: selection.engine,
    selection: selection.connection,
    remoteRepositoryConfirmed: true,
    ...(selection.engine === "codex-security" ? { executionProfilePreference: "auto" as const } : {}),
  });
  if (!nativeScanCostCeilingSupported(
    selection,
    compatibility,
    scanner.models.map((model) => model.id),
  )) {
    throw new TargetPreviewError("target_preview_invalid");
  }
  return compatibility;
}

const guardrailsDependencies: GuardrailsApiDependencies = {
  listRepositories: listGuardrailRepositories,
  listRepositoryRows: listGuardrailRepositoryRows,
  enrollRepository: (request) => repositoryEnrollmentService.enroll(request),
  patchRepository: (repositoryKey, patch) => patchGuardrailRepository(repositoryKey, patch),
  removeRepository: removeGuardrailRepository,
  upsertRepository: upsertGuardrailRepository,
  getRepository: findRepository,
  backfillRepositoryKeys: backfillRunRepositoryKeys,
  readPolicy: readGuardrailPolicy,
  readRemotePolicy: async (repository) => {
    const target = { kind: "protected_branch" as const, ref: repository.defaultBranch };
    const resolved = await githubRefResolver.resolve(repository, target);
    return protectedPolicyLoader.load(repository, target, resolved);
  },
  getSentinelPolicy: (repositoryKey) => getRepositoryPolicy(repositoryKey),
  putSentinelPolicy: (repositoryKey, policy, preset, updatedBy) => {
    const previous = getRepositoryPolicy(repositoryKey)?.policy ?? defaultGuardrailPolicy();
    const stored = putRepositoryPolicy(repositoryKey, policy, preset, updatedBy);
    // The policy names the protected branches, so saving it can retire a baseline
    // that stands on a branch the policy no longer protects.
    refreshRepositoryBaselineState(repositoryKey);
    // And it names the model, the effort and the mode. A baseline built with the old
    // ones cannot be compared against a scan run with the new ones (spec: "troca de
    // modelo, esforço ou modo — na política ou numa ação — → stale/scan_lineage"),
    // and the executor would discover that while the screen still said "pronta".
    if (JSON.stringify(previous.scan) !== JSON.stringify(stored.policy.scan)) {
      markRepositoryBaselineStale(repositoryKey, "scan_lineage");
    }
    return stored;
  },
  parsePolicy: parseGuardrailPolicy,
  writePolicy: writeGuardrailPolicy,
  readExceptions: readGuardrailExceptions,
  listGates: (repositoryKey) => listGateRuns(repositoryKey).map((gate) =>
    reconcileGateWithLinkedScan(gate.id) ?? gate),
  getGate: (gateId) => reconcileGateWithLinkedScan(gateId),
  getArtifact: getGateArtifact,
  listPullRequests: (repository) => githubRepositorySource.listOpenPullRequests(repository),
  previewTarget: (repository, request) => targetPreviewService.create(repository, request),
  acceptTargetPreview: (repository, request) => targetPreviewService.accept(repository, request),
  startGate: startGuardrailGate,
  dispatchActionsGate: (_repository, preview, idempotencyKey) =>
    startRemoteActionsGate(preview, idempotencyKey),
  cancelGate,
  deleteGate: deleteTerminalGate,
  subscribeGate,
  getGitHubStatus: (repository) => repository.source === "github"
    ? getRemoteGitHubStatus(repository, getSystemGitHubAppService())
    : getGitHubStatus(localRepositoryPath(repository)),
  getActionsStatus: (repository) => getGitHubActionsStatus(
    repository,
    getSystemGitHubAppService(),
    GITHUB_ACTIONS_WORKFLOW_SHA,
  ),
  getCallerWorkflow: async (repository) => {
    if (GITHUB_ACTIONS_WORKFLOW_SHA === null) {
      throw new Error("actions_workflow_release_unavailable");
    }
    return callerWorkflowDocument({
      defaultBranch: repository.defaultBranch,
      secretName: "OPENAI_API_KEY",
      workflowSha: GITHUB_ACTIONS_WORKFLOW_SHA,
      triggers: DEFAULT_GUARDRAIL_AUTOMATION,
    });
  },
  installCallerWorkflow: async (repository, triggers) => {
    if (GITHUB_ACTIONS_WORKFLOW_SHA === null || !hasGitHubRemote(repository)) {
      throw new Error("actions_workflow_release_unavailable");
    }
    const owner = requiredRemoteAuthority(repository.remoteOwner);
    const name = requiredRemoteAuthority(repository.remoteName);
    const connectionId = requiredRemoteAuthority(repository.githubConnectionId);
    const installationId = requiredRemoteAuthority(repository.githubInstallationId);
    const repositoryId = requiredRemoteAuthority(repository.githubRepositoryId);
    const workflow = callerWorkflowDocument({
      defaultBranch: repository.defaultBranch,
      secretName: "OPENAI_API_KEY",
      workflowSha: GITHUB_ACTIONS_WORKFLOW_SHA,
      triggers,
    });
    let sha: string | undefined;
    try {
      const current = await getSystemGitHubAppService().readAuthorizedRepositoryJson(
        connectionId, installationId, repositoryId,
        `/repos/${owner}/${name}/contents/${workflow.path}?ref=${encodeURIComponent(repository.defaultBranch)}`,
        { contents: "read" },
      );
      if (typeof current === "object" && current !== null && "sha" in current && typeof current.sha === "string") sha = current.sha;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || String((error as Error & { code: unknown }).code) !== "github_not_found") throw error;
    }
    await getSystemGitHubAppService().writeAuthorizedRepositoryJson(
      connectionId, installationId, repositoryId,
      `/repos/${owner}/${name}/contents/${workflow.path}`,
      "PUT",
      {
        message: "chore(security): configure Okami Sentinel guardrail",
        content: Buffer.from(workflow.content).toString("base64"),
        branch: repository.defaultBranch,
        ...(sha ? { sha } : {}),
      },
      { contents: "write", workflows: "write" },
    );
    return getGitHubActionsStatus(repository, getSystemGitHubAppService(), GITHUB_ACTIONS_WORKFLOW_SHA);
  },
  openCallerWorkflowPullRequest: (repository) => openCallerWorkflowPullRequest(
    { repository, workflowSha: GITHUB_ACTIONS_WORKFLOW_SHA ?? "" },
    {
      readJson: (authority, resourcePath, permissions) =>
        getSystemGitHubAppService().readAuthorizedRepositoryJson(
          authority.connectionId, authority.installationId, authority.repositoryId,
          resourcePath, permissions,
        ),
      writeJson: (authority, resourcePath, method, body, permissions) =>
        getSystemGitHubAppService().writeAuthorizedRepositoryJson(
          authority.connectionId, authority.installationId, authority.repositoryId,
          resourcePath, method, body, permissions,
        ),
    },
  ),
  getBaseline: (repositoryKey) => getRepositoryBaselineState(repositoryKey),
  markBaselineBuilding: (repositoryKey, requestedAt) =>
    markRepositoryBaselineBuilding(repositoryKey, requestedAt),
  hasProtectedBranchAction: (repositoryKey) => repositoryHasProtectedBranchAction(repositoryKey),
  startBaselineGate: (repository) => startProtectedBranchBaselineGate(repository),
  publishCheck: (input) => publishManagedGateCheck(
    input,
    getSystemGitHubAppService() as ManagedGitHubCheckClient,
  ),
  publishComment: (input) => publishPrComment(input, {
    readAuthorizedRepositoryJson: (connectionId, installationId, repositoryId, resourcePath, permissions) =>
      getSystemGitHubAppService().readAuthorizedRepositoryJson(
        connectionId, installationId, repositoryId, resourcePath, permissions,
      ),
    writeAuthorizedRepositoryJson: (connectionId, installationId, repositoryId, resourcePath, method, body, permissions) =>
      getSystemGitHubAppService().writeAuthorizedRepositoryJson(
        connectionId, installationId, repositoryId, resourcePath, method, body, permissions,
      ),
    getComment: (repositoryKey, pullRequestNumber) => getPrComment(repositoryKey, pullRequestNumber),
    upsertComment: (record) => { upsertPrComment(record); },
    appIdentity: (connectionId) => {
      const connection = getSystemGitHubAppService().listConnections()
        .find((row) => row.id === connectionId);
      return { appId: connection?.appId ?? null, appSlug: connection?.appSlug ?? null };
    },
    permissionBlockedAt: (installationId) => prCommentPermissionBlockedAt(installationId),
    recordPermissionBlock: (installationId, reason) =>
      recordPrCommentPermissionBlock(installationId, reason, new Date().toISOString()),
    clearPermissionBlock: (installationId) => { clearPrCommentPermissionBlock(installationId); },
    // A manual republication is the operator saying "write it now". The
    // repository's switch still decides whether Sentinel may speak at all.
    commentsEnabled: (repositoryKey) =>
      getGuardrailRepositoryPrComment(repositoryKey)?.enabled ?? false,
    commentLocale: (repositoryKey) =>
      getGuardrailRepositoryPrComment(repositoryKey)?.locale ?? DEFAULT_GUARDRAIL_PR_COMMENT_LOCALE,
    publicOrigin: () => loadServerSettings().origin,
    now: () => new Date().toISOString(),
  }),
  getComment: (repositoryKey, pullRequestNumber) => getPrComment(repositoryKey, pullRequestNumber),
  listComments: (repositoryKey) => listPrComments(repositoryKey),
  updateGate: updateGateRun,
  recordPublicationAttempt: recordGatePublicationAttempt,
  listPublicationAttempts: listGatePublicationAttempts,
};

/**
 * Whether a merge will build this repository's baseline on its own: an enabled
 * `push` action whose patterns cover the protected branch. Without one the screen
 * offers "Criar baseline agora" instead of promising something that never happens.
 */
function repositoryHasProtectedBranchAction(repositoryKey: string): boolean {
  const branch = protectedBranchForBaseline(repositoryKey);
  if (branch === null) return false;
  return listGitHubActions({ repositoryKey }).some((action) =>
    action.enabled
    && action.triggerKind === "push"
    && matchesAnyBranchPattern(action.branchPatterns, branch));
}

/**
 * The branch a baseline stands on, read the same way the projection reads it: from
 * the effective policy's protected branches, preferring the repository's default.
 */
function protectedBranchForBaseline(repositoryKey: string): string | null {
  const repository = findRepository(repositoryKey);
  if (repository === null) return null;
  const policy = getRepositoryPolicy(repositoryKey)?.policy ?? defaultGuardrailPolicy();
  if (policy.protectedBranches.includes(repository.defaultBranch)) return repository.defaultBranch;
  return policy.protectedBranches[0] ?? null;
}

/**
 * "Criar baseline agora". It goes through the same preflight as any other gate —
 * resolve the ref, read the policy, freeze a preview — so the run is priced and
 * authorized exactly like one an operator starts by hand. The button is an
 * administrator's because it spends.
 */
async function startProtectedBranchBaselineGate(repository: GuardrailRepository): Promise<GateRun> {
  const ref = protectedBranchForBaseline(repository.repositoryKey);
  // No protected branch means there is no commit a baseline could stand on, which
  // is a configuration answer rather than a failure of this request.
  if (ref === null) throw new TargetPreviewError("target_preview_invalid");
  // Pressing twice must not buy two full-repository scans. The check is a read of
  // the gate rows the button itself creates, and the window between it and the
  // insert is this process's own — the API runs as a single replica.
  if (hasRunningProtectedBranchGate(repository.repositoryKey)) throw new Error(BASELINE_BUILDING);
  const target = { kind: "protected_branch" as const, ref };
  // Always Sentinel-managed. The baseline is the Sentinel projection's own
  // reference, the GitHub Actions executor cannot be previewed from here, and a
  // button that answered `target_preview_executor_unavailable` would be a control
  // offered for a dead end it cannot get out of.
  const executor = "sentinel-managed" as const;
  const preview = await targetPreviewService.create(repository, { target, executor });
  const accepted = await targetPreviewService.accept(repository, {
    previewIdentity: preview.previewIdentity,
    target,
    executor,
  });
  return startGuardrailGate({ repositoryKey: repository.repositoryKey, target, executor }, accepted);
}

/** A protected-branch gate of this repository that has not reached a terminal state. */
function hasRunningProtectedBranchGate(repositoryKey: string): boolean {
  return listGateRuns(repositoryKey).some((gate) =>
    gate.pullRequestNumber === null
    && gate.baseRef === gate.headRef
    && !TERMINAL_GATE_STATUSES.has(gate.status));
}

/**
 * Removing a repository takes its gates with it, and their artifacts on disk: a
 * `data/gates/<gateId>/` directory whose row is gone is evidence nothing can open
 * and nothing will ever clean up.
 *
 * It refuses while a gate is still running. The cascade would delete the row of a
 * scan somebody is paying for right now, and the run would keep going with nothing
 * left to record its verdict on.
 *
 * Linked scans are **kept**. A scan is visible on its own screen and deletable
 * there; losing one because a repository was unregistered would be a deletion the
 * operator did not ask for.
 */
function removeGuardrailRepository(repositoryKey: string): void {
  const gates = listGateRuns(repositoryKey);
  if (gates.some((gate) => !TERMINAL_GATE_STATUSES.has(gate.status))) {
    throw new Error("repository_has_active_gate");
  }
  for (const gate of gates) deleteTerminalGate(gate.id, { preserveLinkedScan: true });
  deleteGuardrailRepository(repositoryKey);
}

const TERMINAL_GATE_STATUSES = new Set<GateRun["status"]>(["completed", "cancelled", "error"]);

/** A protected-branch gate for this repository is already running. */
const BASELINE_BUILDING = "repository_baseline_building";

function attributeExistingRuns(deps: GuardrailsApiDependencies, repositoryKey: string): void {
  // The registration is persisted by now. Attributing historical runs to it is a
  // follow-up the next registration or restart retries, so a failure here must not
  // answer 400 and send the operator to fix a request that was fine.
  try {
    (deps.backfillRepositoryKeys ?? backfillRunRepositoryKeys)();
  } catch (error) {
    console.warn(`[csb-api] Could not attribute existing runs to ${repositoryKey}: ${errorMessage(error)}`);
  }
}

/**
 * Why one repository of a batch produced no row. An archived repository is named
 * separately from an unauthorized one because the operator fixes them differently:
 * one is un-archived on GitHub, the other is added to the installation.
 */
function enrollmentSkipReason(error: unknown): GuardrailEnrollmentSkip["reason"] {
  const code = error instanceof Error ? error.message : String(error);
  return code === "github_repository_unavailable" ? "archived" : "not_authorized";
}

function parseGuardrailRepositoryPatch(value: unknown): GuardrailRepositoryPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("repository_patch_invalid");
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set(["enabled", "defaultExecutor", "prCommentEnabled"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error("repository_patch_invalid");
  const patch: GuardrailRepositoryPatch = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new Error("repository_patch_invalid");
    patch.enabled = body.enabled;
  }
  if (body.defaultExecutor !== undefined) {
    if (body.defaultExecutor !== "sentinel-managed" && body.defaultExecutor !== "github-actions") {
      throw new Error("repository_patch_invalid");
    }
    patch.defaultExecutor = body.defaultExecutor;
  }
  if (body.prCommentEnabled !== undefined) {
    if (typeof body.prCommentEnabled !== "boolean") throw new Error("repository_patch_invalid");
    patch.prCommentEnabled = body.prCommentEnabled;
  }
  return patch;
}

export function createGuardrailsApp(
  deps: GuardrailsApiDependencies = guardrailsDependencies,
): Hono {
  const guardrails = new Hono();

  guardrails.get("/guardrails/repositories", (c) => {
    const scope = scopeOf(principalOf(c));
    return c.json({
      repositories: deps.listRepositoryRows().filter((row) => inScope(scope, row.repositoryKey)),
    });
  });

  guardrails.post("/guardrails/repositories", async (c) => {
    let request: EnrollGuardrailRepositoriesRequest;
    try {
      request = parseEnrollGuardrailRepositoriesRequest(await c.req.json<unknown>());
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }

    if (request.source === "local") {
      let repository: GuardrailRepository;
      try {
        repository = await deps.enrollRepository(request);
        if (deps.getRepository(repository.repositoryKey)) {
          return c.json({ error: "repository_already_registered", repositoryKey: repository.repositoryKey }, 409);
        }
        deps.upsertRepository(repository);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
      attributeExistingRuns(deps, repository.repositoryKey);
      return c.json({ repository }, 201);
    }

    // A partial result is a normal answer, not an error: a repository already in
    // the register, one the installation no longer reaches, and one that was
    // archived are three different facts, and the operator reads all three
    // alongside the rows that were created.
    const enrolled: GuardrailRepository[] = [];
    const skipped: GuardrailEnrollmentSkip[] = [];
    for (const repositoryId of request.repositoryIds) {
      let repository: GuardrailRepository;
      try {
        repository = await deps.enrollRepository({
          source: "github",
          connectionId: request.connectionId,
          installationId: request.installationId,
          repositoryId,
          defaultExecutor: request.defaultExecutor,
        });
      } catch (error) {
        skipped.push({ repositoryId, reason: enrollmentSkipReason(error) });
        continue;
      }
      if (deps.getRepository(repository.repositoryKey)) {
        skipped.push({ repositoryId, reason: "already_enrolled" });
        continue;
      }
      deps.upsertRepository(repository);
      enrolled.push(repository);
    }
    for (const repository of enrolled) attributeExistingRuns(deps, repository.repositoryKey);
    return c.json({ enrolled, skipped });
  });

  guardrails.patch("/guardrails/repositories/:repositoryKey", async (c) => {
    const repositoryKey = c.req.param("repositoryKey");
    if (!deps.getRepository(repositoryKey)) return c.json({ error: "Repositório não encontrado" }, 404);
    let patch: GuardrailRepositoryPatch;
    try {
      patch = parseGuardrailRepositoryPatch(await c.req.json<unknown>());
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    const repository = deps.patchRepository(repositoryKey, patch);
    if (repository === null) return c.json({ error: "Repositório não encontrado" }, 404);
    return c.json({ repository });
  });

  guardrails.delete("/guardrails/repositories/:repositoryKey", (c) => {
    const repositoryKey = c.req.param("repositoryKey");
    if (!deps.getRepository(repositoryKey)) return c.json({ error: "Repositório não encontrado" }, 404);
    try {
      deps.removeRepository(repositoryKey);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 409);
    }
    return c.body(null, 204);
  });

  guardrails.post("/guardrails/repositories/:repositoryKey/target-preview", async (c) => {
    const repository = deps.getRepository(c.req.param("repositoryKey"));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    try {
      const request = parseTargetPreviewRequest(await c.req.json<unknown>());
      return c.json({ preview: await deps.previewTarget(repository, request) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, targetPreviewStatus(error));
    }
  });

  guardrails.get("/guardrails/repositories/:repositoryKey/pull-requests", async (c) => {
    const repository = deps.getRepository(c.req.param("repositoryKey"));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (!hasGitHubRemote(repository)) return c.json({ error: "Repositório não possui remoto GitHub" }, 400);
    try {
      return c.json({ pullRequests: await deps.listPullRequests(repository) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  });

  guardrails.get("/guardrails/repositories/:repositoryKey/policy", async (c) => {
    const repository = deps.getRepository(c.req.param("repositoryKey"));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    try {
      if (repository.source === "github") {
        // The remote read is what tells us whether `.csb/guardrails.json` exists at
        // the protected branch's SHA, which is the only way level 1 can be known. When
        // GitHub is unreachable this is the one block of the repository page that
        // cannot be answered — and 400 would blame the caller for an outage.
        let bundle: ProtectedPolicyBundle;
        try {
          bundle = await deps.readRemotePolicy(repository);
        } catch (error) {
          return c.json({ error: errorMessage(error) }, 502);
        }
        const stored = deps.getSentinelPolicy(repository.repositoryKey);
        return c.json({
          policy: bundle.policy,
          policySource: bundle.policySource,
          policySha: bundle.policySha,
          readOnly: bundle.readOnly,
          preset: presetForPolicy(bundle.policy),
          fileInvalidReason: bundle.fileInvalidReason,
          // What the editor would write back to, shown as "saved on <date> by <who>"
          // even while the repository's own file is the one in force.
          sentinel: stored === null ? null : {
            preset: stored.preset,
            updatedAt: stored.updatedAt,
            updatedBy: stored.updatedBy,
          },
        });
      }
      const policy = deps.readPolicy(localRepositoryPath(repository));
      return c.json({
        policy,
        policySource: "workspace",
        policySha: null,
        readOnly: false,
        preset: presetForPolicy(policy),
        fileInvalidReason: null,
        sentinel: null,
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  guardrails.put("/guardrails/repositories/:repositoryKey/policy", async (c) => {
    const repositoryKey = c.req.param("repositoryKey");
    const repository = deps.getRepository(repositoryKey);
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    let body: unknown;
    try {
      body = await c.req.json<unknown>();
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    // The body used to be the policy itself. It still may be, so a client that was
    // not redeployed with this release keeps working.
    const payload = body !== null && typeof body === "object" && "policy" in body
      ? (body as { policy: unknown }).policy
      : body;
    if (repository.source !== "github") {
      try {
        const policy = deps.parsePolicy(payload);
        deps.writePolicy(localRepositoryPath(repository), policy);
        return c.json({
          policy,
          policySource: "workspace",
          policySha: null,
          readOnly: false,
          preset: presetForPolicy(policy),
          fileInvalidReason: null,
          sentinel: null,
        });
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    }
    let policy: GuardrailPolicy;
    try {
      policy = deps.parsePolicy(payload);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    let bundle: ProtectedPolicyBundle;
    try {
      bundle = await deps.readRemotePolicy(repository);
    } catch (error) {
      // Without the remote read we cannot tell whether the repository's own file is
      // in force, and overwriting the Sentinel policy under a file that wins would
      // save a policy that decides nothing while the screen says it does.
      return c.json({ error: errorMessage(error) }, 502);
    }
    if (bundle.readOnly) {
      return c.json({
        error: "policy_controlled_by_repository",
        policyPath: ".csb/guardrails.json",
        policySha: bundle.policySha,
      }, 409);
    }
    // The preset is a derived fact, never the client's claim: a body that named
    // `warn-only` while carrying blocking rules would label the row a lie.
    const stored = deps.putSentinelPolicy(
      repository.repositoryKey,
      policy,
      presetForPolicy(policy),
      principalOf(c).userId,
    );
    return c.json({
      policy: stored.policy,
      policySource: "sentinel",
      policySha: bundle.policySha,
      readOnly: false,
      preset: stored.preset,
      fileInvalidReason: bundle.fileInvalidReason,
      sentinel: { preset: stored.preset, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy },
    });
  });

  guardrails.post("/guardrails/repositories/:repositoryKey/policy/simulate", async (c) => {
    const repository = deps.getRepository(c.req.param("repositoryKey"));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    try {
      const body = await c.req.json<{ gateId?: string; policy?: unknown; now?: string }>();
      // Without a named gate, simulate against the repository's last gate that has
      // an artifact — the question the screen is really asking.
      const gateId = typeof body.gateId === "string" && body.gateId !== ""
        ? body.gateId
        : deps.listGates(repository.repositoryKey)
          .filter((gate) => gate.artifactPath !== null)
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]?.id ?? null;
      if (gateId === null) return c.json({ error: "policy_simulation_no_gate" }, 404);
      const artifact = deps.getArtifact(gateId);
      if (!artifact || artifact.repository.key !== repository.repositoryKey) {
        return c.json({ error: "Artifact do gate não encontrado" }, 404);
      }
      const policy = deps.parsePolicy(body.policy);
      const now = body.now ?? new Date().toISOString();
      if (!Number.isFinite(Date.parse(now))) throw new Error("now deve ser uma data ISO válida");
      const exceptions = repository.source === "github"
        ? (await deps.readRemotePolicy(repository)).exceptions
        : deps.readExceptions(localRepositoryPath(repository));
      const configurationErrors = exceptions.flatMap((exception, index) =>
        Date.parse(exception.expiresAt) <= Date.parse(now)
          ? [{ field: `exceptions[${index}].expiresAt`, message: "Exceção expirada" }]
          : []);
      const decision = simulateDecision(
        artifact,
        policy,
        exceptions.filter((exception) => Date.parse(exception.expiresAt) > Date.parse(now)),
        now,
      );
      return c.json({ decision, configurationErrors, gateId });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  guardrails.get("/guardrails/repositories/:repositoryKey/github-status", async (c) => {
    const repository = deps.getRepository(c.req.param("repositoryKey"));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    const status = await deps.getGitHubStatus(repository);
    return c.json({ status });
  });

  guardrails.get("/guardrails/repositories/:repositoryKey/actions-status", async (c) => {
    const repository = deps.getRepository(c.req.param("repositoryKey"));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    return c.json({ status: await deps.getActionsStatus(repository) });
  });

  guardrails.get("/guardrails/repositories/:repositoryKey/caller-workflow", async (c) => {
    const repository = deps.getRepository(c.req.param("repositoryKey"));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (!hasGitHubRemote(repository)) {
      return c.json({ error: "Repositório não possui remoto GitHub" }, 400);
    }
    try {
      return c.json({ workflow: await deps.getCallerWorkflow(repository) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  });

  guardrails.put("/guardrails/repositories/:repositoryKey/caller-workflow", async (c) => {
    const repository = deps.getRepository(c.req.param("repositoryKey"));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (!hasGitHubRemote(repository)) return c.json({ error: "Repositório não possui remoto GitHub" }, 400);
    if (!deps.installCallerWorkflow) return c.json({ error: "github_workflow_install_unavailable" }, 501);
    let triggers: GuardrailAutomationTriggers;
    try {
      triggers = parseAutomationTriggers(await c.req.json<unknown>());
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    try {
      return c.json({ status: await deps.installCallerWorkflow(repository, triggers) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 409);
    }
  });

  // The button that writes the workflow it wants installed. Sentinel never touches
  // the default branch: it opens a pull request the repository reviews as usual.
  guardrails.post("/guardrails/repositories/:repositoryKey/caller-workflow/pull-request", async (c) => {
    const repository = deps.getRepository(c.req.param("repositoryKey"));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (!hasGitHubRemote(repository)) return c.json({ error: "Repositório não possui remoto GitHub" }, 400);
    try {
      return c.json({ pullRequest: await deps.openCallerWorkflowPullRequest(repository) }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 409);
    }
  });

  guardrails.post("/guardrails/repositories/:repositoryKey/actions-dispatch", async (c) => {
    const repository = deps.getRepository(c.req.param("repositoryKey"));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    try {
      const request = parseStartGateRequest(await c.req.json<unknown>());
      if (
        request.repositoryKey !== repository.repositoryKey
        || request.executor !== "github-actions"
        || request.scanSelection !== undefined
      ) throw new TargetPreviewError("target_preview_invalid");
      const preview = await deps.acceptTargetPreview(repository, {
        previewIdentity: requiredPreviewIdentity(request.previewIdentity),
        target: request.target,
        executor: "github-actions",
      });
      const idempotencyKey = requiredIdempotencyKey(c.req.header("Idempotency-Key"));
      const gate = await deps.dispatchActionsGate(repository, preview, idempotencyKey);
      return c.json({ gate }, 202);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, targetPreviewStatus(error));
    }
  });

  /** Every pull request of this repository Sentinel has written in. */
  guardrails.get("/guardrails/repositories/:repositoryKey/pr-comments", (c) => {
    const repositoryKey = c.req.param("repositoryKey");
    if (!deps.getRepository(repositoryKey)) return c.json({ error: "Repositório não encontrado" }, 404);
    return c.json({ comments: deps.listComments(repositoryKey) });
  });

  guardrails.get("/guardrails/repositories/:repositoryKey/baseline", (c) => {
    const repositoryKey = c.req.param("repositoryKey");
    const repository = deps.getRepository(repositoryKey);
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    return c.json({
      baseline: deps.getBaseline(repositoryKey),
      // Without a push action covering the protected branch, no merge will ever
      // build the baseline by itself, and the screen has to say so instead of
      // waiting forever.
      hasProtectedBranchAction: deps.hasProtectedBranchAction(repositoryKey),
    });
  });

  guardrails.post("/guardrails/repositories/:repositoryKey/baseline", async (c) => {
    const repositoryKey = c.req.param("repositoryKey");
    const repository = deps.getRepository(repositoryKey);
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (!hasGitHubRemote(repository)) {
      return c.json({ error: "Repositório não possui remoto GitHub" }, 400);
    }
    let gate: GateRun;
    try {
      gate = await deps.startBaselineGate(repository);
    } catch (error) {
      // A build already running is not a bad request: it is the answer "that is
      // already happening", and a second press must not buy a second scan.
      if (errorMessage(error) === BASELINE_BUILDING) {
        return c.json({ error: BASELINE_BUILDING, baseline: deps.getBaseline(repositoryKey) }, 409);
      }
      return c.json({ error: errorMessage(error) }, targetPreviewStatus(error));
    }
    // After the gate exists: a row saying `building` with no run behind it would
    // leave the screen waiting on nothing.
    const baseline = deps.markBaselineBuilding(repositoryKey, gate.startedAt);
    return c.json({ gateId: gate.id, baseline }, 202);
  });

  guardrails.get("/guardrails/gates", (c) => {
    const scope = scopeOf(principalOf(c));
    const requested = c.req.query("repositoryKey") ?? null;
    // The requested key arrives in the query string, where the route policy
    // cannot resolve it, so an out-of-scope repository simply has no gates.
    if (requested !== null && !inScope(scope, requested)) return c.json({ gates: [] });
    return c.json({ gates: deps.listGates(requested).filter((gate) => inScope(scope, gate.repositoryKey)) });
  });

  guardrails.post("/guardrails/gates", async (c) => {
    try {
      const request = parseStartGateRequest(await c.req.json<unknown>());
      const repository = deps.getRepository(request.repositoryKey);
      if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
      const executor = request.executor ?? repository.defaultExecutor;
      if (repository.source === "github" && request.scanSelection !== undefined) throw new TargetPreviewError("target_preview_invalid");
      const acceptedPreview = repository.source === "github"
        ? await deps.acceptTargetPreview(repository, {
            previewIdentity: requiredPreviewIdentity(request.previewIdentity),
            target: request.target,
            executor,
          })
        : null;
      const gate = await deps.startGate({ ...request, executor }, acceptedPreview);
      return c.json({ gate }, 202);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, targetPreviewStatus(error));
    }
  });

  guardrails.get("/guardrails/gates/:gateId", (c) => {
    const gate = deps.getGate(c.req.param("gateId"));
    if (!gate) return c.json({ error: "Gate não encontrado" }, 404);
    // The comment travels with the gate: the page that shows the Check's state
    // shows the comment's beside it, and a second round trip for one row would
    // make the two of them disagree while it was in flight.
    const comment = gate.pullRequestNumber === null
      ? null
      : deps.getComment(gate.repositoryKey, gate.pullRequestNumber);
    return c.json({ gate, artifact: deps.getArtifact(gate.id), comment });
  });

  guardrails.get("/guardrails/gates/:gateId/events", (c) => {
    const gateId = c.req.param("gateId");
    const gate = deps.getGate(gateId);
    if (!gate) return c.json({ error: "Gate não encontrado" }, 404);
    // An open stream outlives its single authorization, so it is re-checked
    // while it runs and closes once the caller may no longer see the gate.
    const allowed = createStreamGuard(c, () => gate.repositoryKey);
    return streamSSE(c, async (stream) => {
      let closed = false;
      let unsubscribe: () => void = () => undefined;
      let pending = Promise.resolve();
      const stop = deps.subscribeGate(gateId, (event) => {
        pending = pending.then(() => stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
          id: String(event.sequence),
        }));
        if (event.type === "done" || event.type === "error") closed = true;
      });
      unsubscribe = stop;
      if (closed) unsubscribe();
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      while (!closed) {
        await stream.sleep(100);
        if (!allowed()) closed = true;
      }
      await pending;
      unsubscribe();
    });
  });

  guardrails.post("/guardrails/gates/:gateId/cancel", (c) => {
    if (!deps.cancelGate(c.req.param("gateId"))) {
      return c.json({ error: "Gate não está ativo" }, 404);
    }
    return c.json({ ok: true });
  });

  guardrails.delete("/guardrails/gates/:gateId", (c) => {
    try {
      const deleted = deps.deleteGate(c.req.param("gateId"));
      return c.json({ ok: true, deleted });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 409);
    }
  });

  guardrails.post("/guardrails/gates/:gateId/publish", async (c) => {
    const gateId = c.req.param("gateId");
    const gate = deps.getGate(gateId);
    if (!gate) return c.json({ error: "Gate não encontrado" }, 404);
    if (gate.executor !== "sentinel-managed") {
      return c.json({ error: "O Check deste gate pertence ao GitHub Actions" }, 409);
    }
    const artifact = deps.getArtifact(gateId);
    if (!artifact) return c.json({ error: "Gate ainda não possui artifact" }, 409);
    if (artifact.schemaVersion !== 2) {
      return c.json({ error: "O Check gerenciado exige um artifact v2" }, 409);
    }
    const repository = deps.getRepository(gate.repositoryKey);
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (!hasGitHubRemote(repository)) {
      return c.json({ error: "Repositório não possui remoto GitHub" }, 400);
    }
    // The retry must use the credential the first attempt used. The App is the
    // only one the gate ever had: the `gh` CLI is the operator's own token, which
    // on a server is nobody's, and on a laptop is the wrong author.
    const authority = githubAuthority(repository);
    if (authority === null) {
      return c.json({ error: "Repositório não está ligado ao GitHub App" }, 400);
    }

    const attempt: GatePublicationAttempt = {
      id: randomUUID(),
      gateId,
      status: "publishing",
      error: null,
      createdAt: new Date().toISOString(),
    };
    deps.updateGate(gateId, {
      publishStatus: "publishing",
      publishError: null,
      publishedAt: null,
    });
    deps.recordPublicationAttempt(attempt);

    try {
      await deps.publishCheck({
        artifact,
        authority,
        detailsUrl: gateDetailsUrl(gateId),
      });
      const publishedAttempt = { ...attempt, status: "published" as const };
      deps.recordPublicationAttempt(publishedAttempt);
      deps.updateGate(gateId, {
        publishStatus: "published",
        publishError: null,
        publishedAt: new Date().toISOString(),
      });
      return c.json({ gate: deps.getGate(gateId), attempt: publishedAttempt });
    } catch (error) {
      const message = errorMessage(error);
      const failedAttempt = {
        ...attempt,
        status: "failed" as const,
        error: message,
      };
      deps.recordPublicationAttempt(failedAttempt);
      deps.updateGate(gateId, {
        publishStatus: "failed",
        publishError: message,
        publishedAt: null,
      });
      notifyGitHubPublishFailed(gateId);
      return c.json({ error: message }, 502);
    }
  });

  /**
   * "Republicar comentário". It writes the same body the gate would have, through
   * the same publisher, so a comment lost to a GitHub outage or a revoked
   * permission can be recovered without rerunning — and paying for — the scan.
   */
  guardrails.post("/guardrails/gates/:gateId/comment", async (c) => {
    const gateId = c.req.param("gateId");
    const gate = deps.getGate(gateId);
    if (!gate) return c.json({ error: "Gate não encontrado" }, 404);
    const artifact = deps.getArtifact(gateId);
    if (!artifact) return c.json({ error: "Gate ainda não possui artifact" }, 409);
    if (artifact.schemaVersion !== 2 || artifact.target.kind !== "pull_request") {
      return c.json({ error: "Este gate não pertence a um pull request" }, 409);
    }
    if (artifact.repository.locator.kind !== "github") {
      return c.json({ error: "Este gate não pertence a um pull request" }, 409);
    }
    const repository = deps.getRepository(gate.repositoryKey);
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    const authority = githubAuthority(repository);
    if (authority === null) {
      return c.json({ error: "Repositório não está ligado ao GitHub App" }, 400);
    }
    const result = await deps.publishComment({
      artifact,
      repositoryKey: gate.repositoryKey,
      authority,
      owner: artifact.repository.locator.owner,
      name: artifact.repository.locator.name,
      pullRequestNumber: artifact.resolvedTarget.pullRequestNumber,
      durationMs: gate.completedAt === null
        ? null
        : Date.parse(gate.completedAt) - Date.parse(gate.startedAt),
    });
    const comment = artifact.resolvedTarget.pullRequestNumber === null
      ? null
      : deps.getComment(gate.repositoryKey, artifact.resolvedTarget.pullRequestNumber);
    if (result.status === "failed") {
      if (result.alert) notifyGitHubPublishFailed(gateId);
      return c.json({ error: result.reason, result, comment }, 502);
    }
    return c.json({ result, comment });
  });

  return guardrails;
}

app.route("/", createAuthApi({ settings: loadServerSettings() }));
app.route("/", createUsersApi({ publicOrigin: loadServerSettings().origin }));
app.route("/", createEmailApi({ publicOrigin: loadServerSettings().origin }));
app.route("/", createNotificationsApi({ settings: loadServerSettings() }));
app.route("/", createGuardrailsApp());
app.route("/", createGitHubAppApi());
app.route("/", createEngineUpdatesApp());

const startAutomaticGitHubScan = automaticGitHubScanDispatcher({
  getRepository: findRepository,
  getAction: getGitHubAction,
  validateActions: async (repository) => {
    const status = await getGitHubActionsStatus(repository, getSystemGitHubAppService(), GITHUB_ACTIONS_WORKFLOW_SHA);
    if (!status.ready || !status.triggers) throw new Error("target_preview_executor_unavailable");
    if (status.triggers.push || status.triggers.pullRequest || status.triggers.merge) throw new Error("monitor_actions_duplicate_triggers");
  },
  preview: (repository, request) => targetPreviewService.create(repository, request),
  accept: (repository, preview) => targetPreviewService.accept(repository, {
    previewIdentity: preview.previewIdentity, target: preview.target, executor: preview.executor,
  }),
  startManaged: startRemoteManagedGate,
  startActions: startRemoteActionsGate,
});

/**
 * One event, dispatched. The webhook calls it outside the request cycle and the
 * reconciliation awaits it one at a time; both reach the same guarantees, because
 * the authority triple, the ceilings and the revision are re-read here.
 */
export function dispatchGitHubActionEventNow(eventId: string): Promise<void> {
  return dispatchGitHubActionEvent(eventId, {
    getRepository: findRepository,
    start: async (input) => {
      // A draining server must not start a paid scan it cannot finish. The code
      // is a pre-dispatch refusal, so the event is skipped and nothing is spent.
      if (isDraining()) throw new Error("server_draining");
      return startAutomaticGitHubScan(input);
    },
  });
}

/**
 * The App connections that have a webhook secret, snapshotted. `listSecrets` runs
 * on **every** delivery, before any rate limit can shed load, so an unsigned
 * flood must not become a flood of vault decryptions.
 *
 * Exported because the route that stores a secret has to call `invalidate()`:
 * without it a freshly pasted secret would be ignored for up to the window, and
 * the operator would read a signature failure as their own mistake (task 1.5).
 */
export const githubWebhookSecretCache = createWebhookSecretCache({
  load: async (): Promise<GitHubWebhookSecret[]> => {
    const credentials = getSystemGitHubAppCredentialStore();
    const secrets: GitHubWebhookSecret[] = [];
    for (const connection of getSystemGitHubAppService().listConnections()) {
      if (connection.status !== "ready") continue;
      let stored;
      try {
        stored = await credentials.get(connection.id);
      } catch {
        // A connection whose secret cannot be read is not a candidate; the
        // Integration screen is where that shows up, not a 500 to GitHub.
        continue;
      }
      const secret = stored?.webhookSecret;
      if (secret === undefined || secret === "") continue;
      secrets.push({ connectionId: connection.id, secret, appId: numericGitHubAppId(connection.appId) });
    }
    return secrets;
  },
});

/**
 * The App id GitHub echoes in `X-GitHub-Hook-Installation-Target-ID`, which is
 * what keeps a delivery at a single HMAC. Only a numeric id can be that header;
 * anything else recorded in the column (a client id, a slug) is `null`, which
 * leaves the connection a candidate for every delivery instead of silently
 * answering `401` to all of them.
 */
function numericGitHubAppId(value: string | null): string | null {
  return value !== null && /^[0-9]+$/.test(value) ? value : null;
}

function connectionAppId(connectionId: string): string | null {
  const connection = getSystemGitHubAppService().listConnections()
    .find((candidate) => candidate.id === connectionId);
  return connection ? numericGitHubAppId(connection.appId) : null;
}

function enrolledGitHubRepository(
  connectionId: string,
  githubRepositoryId: string,
): GuardrailRepository | null {
  return listGuardrailRepositories().find((repository) =>
    repository.source === "github"
    && repository.githubConnectionId === connectionId
    && repository.githubRepositoryId === githubRepositoryId) ?? null;
}

function repositoryResourcePath(repository: GuardrailRepository, resourcePath: string): string {
  const owner = encodeURIComponent(requiredRemoteAuthority(repository.remoteOwner));
  const name = encodeURIComponent(requiredRemoteAuthority(repository.remoteName));
  return `/repos/${owner}/${name}${resourcePath}`;
}

function readAuthorizedRepositoryJson(
  repository: GuardrailRepository,
  resourcePath: string,
  permissions: import("./github-app/github-app-client.js").GitHubInstallationPermissions,
): Promise<unknown> {
  return getSystemGitHubAppService().readAuthorizedRepositoryJson(
    requiredRemoteAuthority(repository.githubConnectionId),
    requiredRemoteAuthority(repository.githubInstallationId),
    requiredRemoteAuthority(repository.githubRepositoryId),
    repositoryResourcePath(repository, resourcePath),
    permissions,
  );
}

/**
 * Everything `POST /github/webhook` needs, resolved per request. The delivery row
 * and the events it produces are written in one `IMMEDIATE` transaction; the
 * dispatch and the installation refresh happen after it commits, so GitHub never
 * waits for a scan.
 */
const githubWebhookDependencies: GitHubWebhookIngestDependencies = {
  now: () => new Date().toISOString(),
  listSecrets: () => githubWebhookSecretCache.read(),
  findRepository: enrolledGitHubRepository,
  listActions: (repositoryKey) => listGitHubActions({ repositoryKey }),
  newestObservedAt: (input) => newestObservedEventAt(input),
  createEvent: (input) => createGitHubActionEvent(input),
  supersede: (input) => supersedeQueuedEvents(input),
  hasAnalysedCommit: (actionId, headSha) => hasAnalysedCommit(actionId, headSha),
  claimDelivery: (input) => recordWebhookDelivery(input),
  completeDelivery: (deliveryId, patch) => { completeWebhookDelivery(deliveryId, patch); },
  disableActionsForRepository: (repositoryKey, reason) => {
    disableGitHubActionsForRepository(repositoryKey, reason);
  },
  disableActionsForInstallation: (installationId, reason) => {
    disableGitHubActionsForInstallation(installationId, reason);
  },
  refreshInstallationRepositories: async (installationId) => {
    await getSystemGitHubAppService().refreshRepositories(installationId);
  },
  dispatch: (eventId) => {
    // Deliberately not awaited: the response is already on its way to GitHub.
    void dispatchGitHubActionEventNow(eventId).catch((error: unknown) => {
      console.warn(`[csb-api] github action dispatch failed event=${eventId}`
        + ` reason=${error instanceof Error ? error.message : "unknown_error"}`);
    });
  },
  connectionAppId,
  rerunGate: (input) => rerunGitHubActionGate(input, {
    now: () => new Date().toISOString(),
    findEventByGateId: (gateId) => findGitHubActionEventByGateId(gateId),
    getAction: (actionId) => getGitHubAction(actionId),
    createEvent: (event) => createGitHubActionEvent(event),
  }),
  runInTransaction: (work) => getDb().transaction(work)(),
};

/**
 * `POST /github/webhook` is mounted before the `githubIntegrationSecurity` loop
 * below, whose patterns must never match it. The dependencies are resolved per
 * request rather than at import: the store's first call runs the actions
 * migration, and boot decides when that happens (`index.ts`).
 */
app.route("/", createGitHubWebhookApp({ resolve: () => githubWebhookDependencies }));

/**
 * The 15-minute safety net. Read-only against GitHub: it creates events for
 * commits whose deliveries never arrived, and re-lists the installations, which
 * GitHub never redelivers either.
 */
const githubReconcilerDependencies: GitHubReconcilerDependencies = {
  now: () => new Date(),
  listActions: () => listGitHubActions({}),
  getRepository: findRepository,
  readRepositoryJson: readAuthorizedRepositoryJson,
  createEvent: (input) => createGitHubActionEvent(input),
  hasEventForHeadSha: (actionId, headSha) => hasGitHubActionEventForHeadSha(actionId, headSha),
  supersede: (input) => supersedeQueuedEvents(input),
  listQueuedEvents: (actionId) => listGitHubActionEvents({
    actionId, statuses: ["queued"], limit: 200, order: "oldest",
  }),
  patchEvent: (id, patch) => { patchGitHubActionEvent(id, patch); },
  recordReconciliation: (actionId, outcome) => { recordGitHubActionReconciliation(actionId, outcome); },
  dispatch: (eventId) => dispatchGitHubActionEventNow(eventId),
  reconcileOrphans: () => reconcileOrphanedGitHubActionDispatches(),
  disableActionsForRepository: (repositoryKey, reason) => {
    disableGitHubActionsForRepository(repositoryKey, reason);
  },
  listInstallationScopes: () => readGitHubInstallationScopes({
    listConnections: () => getSystemGitHubAppService().listConnections(),
    listInstallations: (connectionId) => getSystemGitHubAppService().refreshInstallations(connectionId),
    listRepositories: (installationId) => getSystemGitHubAppService().refreshRepositories(installationId),
    disableActionsForInstallation: (installationId, reason) => {
      disableGitHubActionsForInstallation(installationId, reason);
    },
  }),
  runInTransaction: (work) => getDb().transaction(work)(),
};

/**
 * Both callers — the 15-minute loop in `index.ts` and `POST /github/reconcile` —
 * go through the same guard, so a button press joins the cycle in flight instead of
 * running a second set of GitHub reads beside it.
 */
export const reconcileGitHubActionsNow: () => Promise<GitHubReconcileOutcome> =
  singleFlightReconcile(() => reconcileGitHubActions(githubReconcilerDependencies));

/**
 * The whole GitHub tab hangs off one tree, and the Origin/CSRF guard covers all of
 * it. `POST /github/webhook` is the one exception, named inside the guard itself
 * (GitHub carries no session, no `Origin` and no token; the HMAC is the
 * authentication), so the exemption does not depend on the order the routes above
 * happen to be registered in.
 */
for (const route of ["/github/*", "/github-checkouts", "/github-checkouts/*"]) {
  app.use(route, githubIntegrationSecurity());
}
app.route("/", createGitHubBranchesApp({
  getRepository: findRepository,
  listBranchNames: (repository) => listGitHubBranchNames(repository, readAuthorizedRepositoryJson),
}));

/**
 * What `GET /github/integration` reads. Every failure degrades to "unknown", which
 * the status renders as the operator step it is: an unreadable App reports every
 * permission and event missing, and an unreadable installation list is passed as
 * `null` so the checklist fails **closed** instead of reading as "installed
 * nowhere".
 */
async function githubIntegrationConnections() {
  const client = getSystemGitHubAppClient();
  const connections = [];
  for (const connection of getSystemGitHubAppService().listConnections()) {
    let metadata: Awaited<ReturnType<typeof client.readApp>> | null = null;
    if (connection.status === "ready") {
      try {
        metadata = await client.readApp(connection);
      } catch {
        // Whatever GitHub said stays here: the screen shows "unknown", not a 502.
        metadata = null;
      }
    }
    // The screen is where the mismatch is detected, so it is also where it is
    // repaired: the recorded id is replaced by the one GitHub just reported. The
    // row still names both, so the next read shows them agreeing.
    const recordedAppId = metadata?.appId !== undefined && metadata.appId !== null
      && getSystemGitHubAppService().repairRecordedAppId(connection.id, metadata.appId)
      ? metadata.appId
      : connection.appId;
    connections.push({
      connectionId: connection.id,
      appSlug: connection.appSlug,
      appName: metadata?.name ?? connection.appSlug,
      // GitHub's own numeric id next to the one we recorded: the header
      // `X-GitHub-Hook-Installation-Target-ID` carries the former, and a stored
      // value that is not it costs every delivery the capped loop.
      appId: metadata?.appId ?? null,
      recordedAppId,
      // An unfinished or revoked connection is never asked anything, so its empty
      // installation list must read as "finish the connection", not as "GitHub did
      // not answer".
      connectionReady: connection.status === "ready",
      requestedPermissions: metadata?.requestedPermissions ?? null,
      subscribedEvents: metadata?.subscribedEvents ?? null,
    });
  }
  return connections;
}

async function githubIntegrationInstallations(
  connectionId: string,
): Promise<GitHubIntegrationInstallationState[] | null> {
  const connection = getSystemGitHubAppService().listConnections()
    .find((candidate) => candidate.id === connectionId);
  if (connection === undefined || connection.status !== "ready") return null;
  try {
    return (await getSystemGitHubAppClient().readAppInstallations(connection))
      .map((installation) => ({
        installationId: installation.installationId,
        account: installation.account,
        accountType: installation.accountType,
        repositorySelection: installation.repositorySelection,
        // What this installation **approved**, which is what decides whether a
        // gate can publish — not what the App requests.
        grantedPermissions: installation.grantedPermissions,
        // Carried, not dropped: a suspended installation refuses every token, so a
        // status that loses this flag reports a healthy integration while GitHub
        // refuses everything.
        suspended: installation.suspended,
      }));
  } catch {
    // `null`, never `[]`: an unread list is not an App installed nowhere.
    return null;
  }
}

app.route("/", createGitHubActionsApi({
  getAction: (actionId) => getGitHubAction(actionId),
  listActions: (filter) => listGitHubActions(filter),
  createAction: (input) => createGitHubAction(input),
  patchAction: (actionId, patch) => patchGitHubAction(actionId, patch),
  deleteAction: (actionId) => deleteGitHubAction(actionId),
  getRepository: findRepository,
  listEvents: (filter) => listGitHubActionEvents(filter),
  listDeliveries: ({ limit, offset }) => listWebhookDeliveries(limit, getDb(), offset),
  readIntegrationStatus: async () => reconcileCommentPermissionBlocks(await buildGitHubIntegrationStatus({
    listConnections: githubIntegrationConnections,
    listInstallations: githubIntegrationInstallations,
    listRepositories: (installationId) =>
      listGitHubInstallationRepositories(installationId).map((repository) => ({
        repositoryId: repository.repositoryId,
        repositoryKey: listGuardrailRepositories().find((candidate) =>
          candidate.source === "github"
          && candidate.githubRepositoryId === repository.repositoryId)?.repositoryKey ?? null,
      })),
    listActions: () => listGitHubActions({}),
    // The projection, read locally: the checklist step says the word the
    // repository page says, so the two screens cannot disagree.
    readBaselineState: (repositoryKey) => getRepositoryBaselineState(repositoryKey).state,
    readWebhookSecretConfigured: async (connectionId) =>
      (await getSystemGitHubAppCredentialStore().get(connectionId).catch(() => null))
        ?.webhookSecret !== undefined,
    readLastVerifiedDeliveryAt: (connectionId) => lastVerifiedWebhookDeliveryAt(connectionId),
    readWebhookSecretStoredAt: (connectionId) => webhookSecretStoredAt(connectionId),
    countDeliveries: (since) => countWebhookDeliveriesSince(since),
    countRecoveredEvents: (since) => countReconciledEventsSince(since),
    lastDelivery: () => listWebhookDeliveries(1)[0] ?? null,
    publicOrigin: runtimeMode() === "server" ? loadServerSettings().origin : null,
  })),
  storeWebhookSecret: (connectionId, secret) =>
    getSystemGitHubAppCredentialStore().putWebhookSecret(connectionId, secret),
  recordWebhookSecretStored: (connectionId, storedAt) => {
    recordWebhookSecretStored(connectionId, storedAt === undefined ? new Date().toISOString() : storedAt);
  },
  readWebhookSecretStoredAt: (connectionId) => webhookSecretStoredAt(connectionId),
  // A pasted secret must take effect on the very next delivery, or the operator
  // reads the signature failure of a stale snapshot as their own mistake.
  invalidateWebhookSecrets: () => { githubWebhookSecretCache.invalidate(); },
  reconcile: () => reconcileGitHubActionsNow(),
}));
app.route("/", createGitHubCheckoutsApp({ getRepository: findRepository }));

const providerRuntime = getProviderRuntime();
app.route("/", createConnectionsApp({
  service: providerRuntime.connections,
  authFlows: providerRuntime.authFlows,
  compatibility: providerRuntime.compatibility,
}));

app.get("/health", async (c) => {
  const principal = principalOf(c);
  const scope = scopeOf(principal);
  const codexInfo = await getCodexInfo();
  // A member learns that its own repositories are busy, never that somebody
  // else's scan is running, and never where the server keeps its state. The
  // scanner's raw `info --json` document is dropped for the same reason: it
  // carries host paths such as the npm cache directory, and the frontend reads
  // only the typed version and model fields.
  const activeScanIds = getActiveScanIds().filter((id) => inScope(scope, getRunRepositoryKey(id)));
  const body: HealthResponse = {
    ok: true,
    api: "codex-security-benchmark",
    ...(principal.isAdmin ? { codexStateDir: CODEX_SECURITY_STATE_DIR } : {}),
    codexInfo: codexInfo === null || principal.isAdmin ? codexInfo : withoutRawCodexInfo(codexInfo),
    activeScanId: activeScanIds[0] ?? null,
    activeScanIds,
    maxConcurrentScans: MAX_CONCURRENT_SCANS,
  };
  return c.json(body);
});

/** Only the typed fields the frontend renders survive; `raw` is host-shaped. */
function withoutRawCodexInfo(info: CodexInfo): CodexInfo {
  const { raw: _raw, ...typed } = info;
  return typed;
}

app.get("/scanners", async (c) => c.json(await getScannerCatalog()));

app.post("/ingest", (c) => {
  const result = importExternalScans();
  return c.json(result);
});

app.get("/metrics/summary", async (c) => {
  const scope = scopeOf(principalOf(c));
  await refreshOpenRouterPricing();
  // Terminal history is indexed by ingestion; polling only reconciles live work.
  for (const run of listActiveRuns(scope)) readRunWithEngineRefresh(run.id);
  const daysValue = c.req.query("days");
  const days = daysValue === "7" || daysValue === "14" || daysValue === "21" || daysValue === "30"
    ? Number(daysValue) as 7 | 14 | 21 | 30
    : null;
  const statusValue = c.req.query("status");
  const status = statusValue === "active" || statusValue === "completed" || statusValue === "attention"
    ? statusValue
    : null;
  const engineValue = c.req.query("engine");
  const engine = engineValue === "codex-security" || engineValue === "mantis" || engineValue === "vulnhunter"
    ? engineValue
    : null;
  return c.json(buildMetricsSummary({
    days,
    status,
    engine,
    repository: c.req.query("repository") ?? null,
    query: c.req.query("query") ?? null,
    scope,
  }));
});

app.get("/scans", async (c) => {
  const scope = scopeOf(principalOf(c));
  let options;
  try { options = parseScanListOptions(c.req.query()); }
  catch { return c.json({ error: "Invalid scan pagination" }, 400); }
  await refreshOpenRouterPricing();
  if (options) {
    // Reconcile running work and the requested page. Ingestion remains the
    // authority for off-page artifacts; no per-directory history sweep here.
    for (const run of listActiveRuns(scope)) readRunWithEngineRefresh(run.id);
    for (const run of listRunPage(options, false, scope).scans) readRunWithEngineRefresh(run.id);
    const page = listRunPage(options, true, scope);
    return c.json({ ...page, scans: withProgressMany(page.scans) });
  }
  const scans = readRunsWithEngineRefresh().filter((run) => inScope(scope, run.repositoryKey));
  return c.json({ scans: withProgressMany(scans) });
});

app.get("/scans/active", (c) => {
  const scans = listActiveRuns(scopeOf(principalOf(c))).map((run) => readRunWithEngineRefresh(run.id) ?? run)
    .filter((run) => run.status === "queued" || run.status === "running");
  return c.json({ scans: withProgressMany(scans) });
});

app.get("/scans/catalog", (c) => c.json(scanCatalog(scopeOf(principalOf(c)))));

app.delete("/scans/:id", (c) => {
  const id = c.req.param("id");
  const run = getRun(id);
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  if (isScanActive(id) || !isRemovableScanStatus(run.status)) {
    return c.json(
      { error: "Somente scans concluídos, incompletos, falhos ou cancelados podem ser removidos." },
      409,
    );
  }
  try {
    const linkedGates = listGateRuns().filter((gate) => gate.scanId === id);
    if (linkedGates.some((gate) => !["completed", "cancelled", "error"].includes(gate.status))) {
      return c.json({ error: "O scan ainda pertence a um gate ativo; cancele o gate antes de excluir." }, 409);
    }
    const purge = purgeScanRunArtifacts(run.scanDir);
    hideRun(id);
    deleteRun(id);
    const linkedGatesDeleted = linkedGates.reduce(
      (count, gate) => count + (deleteTerminalGate(gate.id, { preserveLinkedScan: true }) ? 1 : 0),
      0,
    );
    return c.json({ ok: true, ...purge, linkedGatesDeleted });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 409);
  }
});

app.get("/scans/:id", async (c) => {
  await refreshOpenRouterPricing();
  const id = c.req.param("id");
  const run = readRunWithEngineRefresh(id);
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  const findings = toFindingSummaries(readFindingsFile(run.scanDir));
  return c.json({ scan: withProgress(run), findings });
});

app.get("/scans/:id/analysis-metrics", (c) => {
  const run = readRunWithEngineRefresh(c.req.param("id"));
  if (!run) return c.json({ error: "Scan not found" }, 404);
  return c.json(scanAnalysisMetrics(run));
});

app.get("/scans/:id/files-graph", (c) => {
  const run = readRunWithEngineRefresh(c.req.param("id"));
  if (!run) return c.json({ error: "Scan not found" }, 404);
  return c.json(scanFilesGraph(run));
});

app.get("/scans/:id/candidate-preview", (c) => {
  const run = readRunWithEngineRefresh(c.req.param("id"));
  if (!run) return c.json({ error: "Scan not found" }, 404);
  return c.json(scanCandidatePreview(run));
});

app.get("/scans/:id/telemetry", (c) => {
  const run = getRun(c.req.param("id"));
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  const requested = Number(c.req.query("limit") ?? 500);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(1_000, Math.trunc(requested)))
    : 500;
  return c.json(readCliLogSnapshot(run.scanDir, limit));
});

function readRunsWithEngineRefresh() {
  return listRuns().map((run) => readRunWithEngineRefresh(run.id) ?? run);
}

function readRunWithEngineRefresh(id: string) {
  const stored = getRun(id);
  const artifactManaged = stored?.engine === "mantis" || stored?.engine === "vulnhunter" ||
    (stored?.engine === "codex-security" && stored.execution?.executionProfile === "portable");
  return artifactManaged
    ? refreshRunFromDisk(id) ?? stored
    : stored;
}

app.get("/scans/:id/report", async (c) => {
  await refreshOpenRouterPricing();
  const run = readRunWithEngineRefresh(c.req.param("id"));
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  try {
    return c.json({
      scan: withProgress(run),
      findings: readFindingsFile(run.scanDir),
      regression: buildRegressionSummary(run.id),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Falha ao montar relatório" }, 500);
  }
});

app.get("/scans/:id/regression", (c) => {
  try {
    return c.json(buildRegressionSummary(c.req.param("id")));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Falha ao calcular regressões" }, 404);
  }
});

app.post("/scans/:id/baseline", (c) => {
  try {
    return c.json(markScanAsRepositoryBaseline(c.req.param("id")));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Falha ao fixar baseline" }, 400);
  }
});

app.get("/scans/:id/findings", (c) => {
  const run = getRun(c.req.param("id"));
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  const severity = c.req.query("severity");
  const q = (c.req.query("q") || "").toLowerCase();
  let findings = readFindingsFile(run.scanDir);
  if (severity) {
    findings = findings.filter((f) => f.severity === severity);
  }
  if (q) {
    findings = findings.filter(
      (f) =>
        f.title.toLowerCase().includes(q) ||
        (f.primaryPath ?? "").toLowerCase().includes(q) ||
        (f.summary ?? "").toLowerCase().includes(q),
    );
  }
  return c.json({ findings: toFindingSummaries(findings), total: findings.length });
});

app.get("/scans/:id/findings/:findingId", (c) => {
  const run = getRun(c.req.param("id"));
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  const findingId = c.req.param("findingId");
  const finding = readFindingsFile(run.scanDir).find(
    (f) => f.findingId === findingId || f.occurrenceId === findingId,
  );
  if (!finding) return c.json({ error: "Finding não encontrado" }, 404);
  return c.json({ finding });
});

app.post("/scans/:id/findings/:findingId/triage", async (c) => {
  const body = (await c.req.json()) as UpdateFindingTriageRequest;
  const allowed = new Set(["unreviewed", "confirmed", "accepted", "false_positive"]);
  if (!allowed.has(body.status)) return c.json({ error: "Estado de triagem inválido" }, 400);
  try {
    const triage = updateFindingTriage(
      c.req.param("id"),
      c.req.param("findingId"),
      body.status,
      typeof body.note === "string" ? body.note : null,
    );
    return c.json({ triage });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Falha ao salvar triagem" }, 400);
  }
});

app.route("/", createScanStartApp({ startScan }));

app.post("/scans/:id/cancel", (c) => {
  const ok = cancelScan(c.req.param("id"));
  if (!ok) return c.json({ error: "Scan não está ativo" }, 404);
  return c.json({ ok: true });
});

app.get("/scans/:id/events", (c) => {
  const id = c.req.param("id");
  const requestedCursor = Number(c.req.query("after"));
  const afterCursor = Number.isFinite(requestedCursor) && requestedCursor >= 0
    ? Math.trunc(requestedCursor)
    : undefined;
  // An open stream outlives its single authorization, so it is re-checked while
  // it runs and closes once the caller may no longer see the scan.
  const allowed = createStreamGuard(c, () => getRunRepositoryKey(id));
  return streamSSE(c, async (stream) => {
    let closed = false;
    const unsubscribe = subscribe(id, async (event) => {
      if (closed) return;
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      });
      if (event.type === "done" || event.type === "error") {
        closed = true;
        unsubscribe();
      }
    }, afterCursor);

    stream.onAbort(() => {
      closed = true;
      unsubscribe();
    });

    // Keep connection open while scan is active
    while (!closed) {
      await stream.sleep(1000);
      if (!allowed()) {
        closed = true;
        unsubscribe();
        break;
      }
      if (!isScanActive(id) && getRun(id)?.status !== "running") {
        // If not active anymore, end after a short grace
        await stream.sleep(500);
        closed = true;
        unsubscribe();
      }
    }
  });
});

app.post("/compare", async (c) => {
  const scope = scopeOf(principalOf(c));
  const body = (await c.req.json()) as CompareRequest;
  try {
    // A comparison reads every requested scan, so one invisible id hides the
    // whole answer: the caller must not learn that the scan exists at all. A
    // malformed request keeps failing as one, hence the shared try.
    for (const id of body.scanIds ?? []) {
      if (!inScope(scope, getRunRepositoryKey(id))) return c.json({ error: "not_found" }, 404);
    }
    for (const id of body.scanIds ?? []) readRunWithEngineRefresh(id);
    return c.json(compareScans(body.scanIds ?? []));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Falha na comparação" },
      400,
    );
  }
});

app.get("/fs/list", (c) => {
  try {
    return c.json(listDirectory(c.req.query("path") ?? undefined));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Falha ao listar" },
      400,
    );
  }
});

function findRepository(repositoryKey: string): GuardrailRepository | null {
  return listGuardrailRepositories().find(
    (repository) => repository.repositoryKey === repositoryKey,
  ) ?? null;
}

async function inspectRepository(
  repositoryPath: string,
  requestedDisplayName?: string,
): Promise<GuardrailRepository> {
  repositoryPath = assertRepositoryAccess(repositoryPath);
  const repositoryRoot = path.resolve(
    (await defaultGitRunner(["rev-parse", "--show-toplevel"], repositoryPath)).trim(),
  );
  assertRepositoryAccess(repositoryRoot);
  const remoteUrl = await optionalGit(["config", "--get", "remote.origin.url"], repositoryRoot);
  const remote = parseGitHubRemote(remoteUrl);
  const remoteHead = await optionalGit(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    repositoryRoot,
  );
  const currentBranch = await optionalGit(["branch", "--show-current"], repositoryRoot);
  const defaultBranch = remoteHead?.replace(/^origin\//, "") || currentBranch || "main";
  const displayName = requestedDisplayName?.trim() || path.basename(repositoryRoot);

  return {
    repositoryKey: remote
      ? `github.com/${remote.owner}/${remote.name}`
      : `local/${path.basename(repositoryRoot)}`,
    repositoryPath: repositoryRoot,
    source: "local",
    displayName,
    defaultBranch,
    defaultExecutor: "sentinel-managed",
    remoteOwner: remote?.owner ?? null,
    remoteName: remote?.name ?? null,
    githubConnectionId: null,
    githubInstallationId: null,
    githubRepositoryId: null,
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: remote ? "not_checked" : "not_configured",
  };
}

async function startGuardrailGate(
  request: StartGateRequest,
  acceptedPreview: AcceptedGateTargetPreview | null,
): Promise<GateRun> {
  const repository = findRepository(request.repositoryKey);
  if (!repository) throw new TargetPreviewError("target_preview_invalid");
  const executor = request.executor ?? repository.defaultExecutor;
  if (repository.source === "local") {
    if (
      executor !== "sentinel-managed"
      || request.target.kind !== "compare"
      || acceptedPreview !== null
    ) {
      throw new TargetPreviewError("target_preview_invalid");
    }
    return startLocalGate({
      repositoryKey: repository.repositoryKey,
      baseRef: request.target.baseRef,
      headRef: request.target.headRef,
      ...(request.scanSelection ? { scanSelection: await resolvedScanSelection(request.scanSelection, executor, resolveGuardrailScanSelection) } : {}),
    });
  }
  if (acceptedPreview === null) {
    throw new TargetPreviewError("target_preview_stale");
  }
  if (executor === "sentinel-managed") {
    return startRemoteManagedGate(acceptedPreview);
  }
  throw new TargetPreviewError("target_preview_executor_unavailable");
}

function localRepositoryPath(repository: GuardrailRepository): string {
  if (repository.source !== "local" || repository.repositoryPath === null) {
    throw new Error("A operação local exige uma pasta de repositório configurada");
  }
  return assertRepositoryAccess(repository.repositoryPath);
}

async function optionalGit(args: string[], cwd: string): Promise<string | null> {
  try {
    return (await defaultGitRunner(args, cwd)).trim() || null;
  } catch {
    return null;
  }
}

function parseGitHubRemote(
  remoteUrl: string | null,
): { owner: string; name: string } | null {
  if (!remoteUrl) return null;
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl);
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

function requiredPreviewIdentity(value: string | undefined): string {
  if (value === undefined) throw new TargetPreviewError("target_preview_stale");
  return value;
}

function requiredRemoteAuthority(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new Error("github_repository_authority_invalid");
  }
  return value;
}

function requiredIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/.test(key)) {
    throw new TargetPreviewError("target_preview_invalid");
  }
  return key;
}

function parseAutomationTriggers(value: unknown): GuardrailAutomationTriggers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("automation_triggers_invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["merge", "pullRequest", "push", "branches"].includes(key))) throw new Error("automation_triggers_invalid");
  if (typeof record.push !== "boolean" || typeof record.pullRequest !== "boolean" || typeof record.merge !== "boolean") {
    throw new Error("automation_triggers_invalid");
  }
  return { push: record.push, pullRequest: record.pullRequest, merge: record.merge, ...(record.branches === undefined ? {} : { branches: normalizeBranchFilters(record.branches) }) };
}

function targetPreviewStatus(error: unknown): 400 | 409 {
  return error instanceof TargetPreviewError
    && (
      error.code === "target_preview_stale"
      || error.code === "target_preview_executor_unavailable"
    )
    ? 409
    : 400;
}

/**
 * The authoritative answer about the permission, where it is already known. The
 * status lists, per permission, which installations have not approved it: those
 * are latched, and every other one is freed. It runs on the Integração screen's
 * own read, so neither direction costs a call of its own.
 *
 * It is not the only way out of a latch — the publisher re-probes hourly — because
 * this route is admin-only, and a transient 403 must not need an administrator.
 */
function reconcileCommentPermissionBlocks(
  status: GitHubIntegrationStatus,
): GitHubIntegrationStatus {
  const now = new Date().toISOString();
  for (const connection of status.connections) {
    const permission = connection.permissions.find((entry) => entry.name === "pull_requests");
    if (permission === undefined) continue;
    const pending = new Set(permission.pendingInstallationIds);
    for (const installation of connection.installations) {
      if (pending.has(installation.installationId)) {
        // The grants themselves say the scope is absent, which is the second of
        // the two things that may silence an installation. Nothing was attempted,
        // so nothing is announced — the screen is already saying it.
        recordPrCommentPermissionBlock(installation.installationId, "github_permission_missing", now);
      } else {
        clearPrCommentPermissionBlock(installation.installationId);
      }
    }
  }
  return status;
}

/**
 * The three identifiers an installation token is minted against. `null` for a
 * local repository, which has no App to speak through.
 */
function githubAuthority(
  repository: GuardrailRepository,
): { connectionId: string; installationId: string; repositoryId: string } | null {
  if (
    repository.githubConnectionId === null
    || repository.githubInstallationId === null
    || repository.githubRepositoryId === null
  ) {
    return null;
  }
  return {
    connectionId: repository.githubConnectionId,
    installationId: repository.githubInstallationId,
    repositoryId: repository.githubRepositoryId,
  };
}

/** Where "Details" on the Check sends a reviewer; `null` with no public origin. */
function gateDetailsUrl(gateId: string): string | null {
  const origin = loadServerSettings().origin;
  return origin === null ? null : `${origin}/guardrails/${encodeURIComponent(gateId)}`;
}

function hasGitHubRemote(
  repository: GuardrailRepository,
): repository is GuardrailRepository & { remoteOwner: string; remoteName: string } {
  return repository.remoteOwner !== null && repository.remoteName !== null;
}

function simulateDecision(
  artifact: GateArtifact,
  policy: GuardrailPolicy,
  exceptions: GuardrailException[],
  now: string,
): GateDecision {
  const currentFindings = artifact.findings.filter(
    (finding) => finding.lifecycle !== "fixed",
  );
  const hasBaseline = artifact.baselineCommit !== null;
  const baselineFindings = hasBaseline
    ? artifact.findings.filter((finding) =>
        finding.lifecycle === "persistent" || finding.lifecycle === "fixed")
    : null;
  const historicalFindings = artifact.findings.filter(
    (finding) => finding.lifecycle === "reopened",
  );
  const triageByIdentity = new Map(
    artifact.findings.map((finding) => [finding.identity, finding.triage]),
  );
  const evaluation = evaluateGate({
    policy,
    branch: artifact.changeSet.headRef,
    changeSet: artifact.changeSet,
    currentFindings,
    baselineFindings,
    historicalFindings,
    triageByIdentity,
    exceptions,
    sourceScanId: artifact.scan.id ?? "policy-simulation",
    baselineScanId: hasBaseline ? "policy-simulation-baseline" : null,
    now,
  });
  return {
    ...evaluation.decision,
    decisionGraph: buildDecisionGraph(
      artifact.changeSet,
      evaluation.deltas as GateFindingDelta[],
      evaluation.decision,
    ),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Falha na operação";
}
